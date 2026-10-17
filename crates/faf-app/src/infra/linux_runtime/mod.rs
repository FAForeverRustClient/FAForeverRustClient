//! The Linux runtime: FAForever/faf-linux, inside the client.
//!
//! faf-linux (MIT, by iczero and the FAForever contributors) is the set of
//! scripts Linux players have used to run FAF for years. It runs Forged
//! Alliance with GE-Proton's Wine inside Valve's Steam Linux Runtime 4
//! container, with DXVK in place of Wine's Direct3D and Microsoft's June 2010
//! DirectX redistributable in a prefix of its own. This module does what its
//! `setup.sh` and `update-component.sh` do, and [`launch`] what its three
//! launch wrappers do, so that nobody has to run them by hand. The Java client
//! half of faf-linux (a JRE, the downloaded client, `set-client-paths.sh`) has
//! no counterpart here: this client is the thing it set up.
//!
//! What is downloaded, from whom, under which licence:
//!
//! | Component | Publisher | Licence |
//! |---|---|---|
//! | GE-Proton | GloriousEggroll, github.com/GloriousEggroll/proton-ge-custom | Proton's BSD-3-Clause scripts around Wine (LGPL-2.1+) and other free software |
//! | Steam Linux Runtime 4 | Valve, repo.steampowered.com | free software, pressure-vessel LGPL-2.1+ |
//! | DXVK | Philip Rebohle, github.com/doitsujin/dxvk | zlib |
//! | DirectX June 2010 redistributable | Microsoft, download.microsoft.com | Microsoft's redistributable licence |
//!
//! Every download is pinned to one version and its SHA-256, the way
//! `scripts/ensure-faf-pioneer.mjs` pins the bundled helpers: a changed file
//! upstream fails the install instead of being run. The Microsoft digest is
//! the one winetricks pins for the same file.
//!
//! Everything lives under the client's data directory in `linux-runtime/`,
//! about 1.5 GB once installed. `installed.json` there records what is in
//! place, so a run that was cancelled or failed resumes, and a client update
//! that pins a newer Proton or DXVK replaces only that part.

mod launch;
mod setup;
mod system;

pub(crate) use launch::{PlannedCommand, Surroundings};

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use async_trait::async_trait;
use faf_domain::state::LinuxRuntimeComponent;
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::ports::{LinuxRuntimePort, RuntimeCheck, RuntimeProgress};

/// One download the runtime is made of.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Pin {
    pub component: LinuxRuntimeComponent,
    /// What `installed.json` records, and what names the directory it is
    /// unpacked into.
    pub version: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
    pub size: u64,
    pub file_name: &'static str,
}

/// faf-linux's `versions` file, 2026-10: `proton_download_url_target`.
pub(crate) const PROTON: Pin = Pin {
    component: LinuxRuntimeComponent::Proton,
    version: "GE-Proton10-34",
    url: "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/GE-Proton10-34/GE-Proton10-34.tar.gz",
    sha256: "51c580b66a833c73998fe00f0717eeac57197654040a2f2ed5189e3ee68d773d",
    size: 516_611_656,
    file_name: "GE-Proton10-34.tar.gz",
};

/// `steamrt_download_url_target`. The digest is the one in Valve's
/// `SHA256SUMS` beside the image.
pub(crate) const STEAM_RUNTIME: Pin = Pin {
    component: LinuxRuntimeComponent::SteamRuntime,
    version: "4.0.20260415.225012",
    url: "https://repo.steampowered.com/steamrt4/images/4.0.20260415.225012/SteamLinuxRuntime_4.tar.xz",
    sha256: "d0f1c2458c4aa6eeb58a709a47e72897dc7c67635a0950ada8ded70e325baee4",
    size: 160_375_712,
    file_name: "SteamLinuxRuntime_4.tar.xz",
};

/// `dxvk_version_target`.
pub(crate) const DXVK: Pin = Pin {
    component: LinuxRuntimeComponent::Dxvk,
    version: "2.7.1",
    url: "https://github.com/doitsujin/dxvk/releases/download/v2.7.1/dxvk-2.7.1.tar.gz",
    sha256: "d85ce7c79f57ecd765aaa1b9e7007cb875e6fde9f6d331df799bce73d513ce87",
    size: 10_310_666,
    file_name: "dxvk-2.7.1.tar.gz",
};

/// `setup.sh`'s `DIRECTX_REDIST`.
pub(crate) const DIRECTX: Pin = Pin {
    component: LinuxRuntimeComponent::DirectX,
    version: "June 2010",
    url: "https://download.microsoft.com/download/8/4/a/84a35bf1-dafe-4ae8-82af-ad2ae20b6b14/directx_Jun2010_redist.exe",
    sha256: "053f76dcbb28802e23341b6a787e3b0791c0fa5c8d4d011b1044172dbf89c73b",
    size: 100_275_120,
    file_name: "directx_Jun2010_redist.exe",
};

/// Where each part of the runtime lives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Layout {
    root: PathBuf,
}

impl Layout {
    pub(crate) fn at(root: PathBuf) -> Self {
        Self { root }
    }

    /// `linux-runtime/` in the client's data directory: not the cache, which
    /// a cleaner may empty, because this is an installation.
    pub(crate) fn standard() -> Result<Self, String> {
        Ok(Self::at(crate::infra::data_dir()?.join("linux-runtime")))
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    /// The archive's own top directory, `GE-Proton10-34`, as faf-linux keeps
    /// it.
    pub(crate) fn proton_dir(&self) -> PathBuf {
        self.proton_dir_for(PROTON.version)
    }

    fn proton_dir_for(&self, version: &str) -> PathBuf {
        self.root.join(version)
    }

    pub(crate) fn steam_runtime_dir(&self) -> PathBuf {
        self.steam_runtime_dir_for(STEAM_RUNTIME.version)
    }

    fn steam_runtime_dir_for(&self, version: &str) -> PathBuf {
        self.root.join(format!("steamrt-{version}"))
    }

    /// The archive's own top directory, `dxvk-2.7.1`.
    pub(crate) fn dxvk_dir(&self) -> PathBuf {
        self.dxvk_dir_for(DXVK.version)
    }

    fn dxvk_dir_for(&self, version: &str) -> PathBuf {
        self.root.join(format!("dxvk-{version}"))
    }

    pub(crate) fn prefix(&self) -> PathBuf {
        self.root.join("prefix")
    }

    pub(crate) fn dxvk_conf(&self) -> PathBuf {
        self.root.join("dxvk.conf")
    }

    pub(crate) fn dxvk_cache(&self) -> PathBuf {
        self.root.join("dxvk-cache")
    }

    pub(crate) fn srt_wrapper(&self) -> PathBuf {
        self.root.join("launchwrapper-srt")
    }

    fn downloads(&self) -> PathBuf {
        self.root.join("downloads")
    }

    fn staging(&self) -> PathBuf {
        self.root.join(".staging")
    }

    fn manifest_path(&self) -> PathBuf {
        self.root.join("installed.json")
    }
}

/// `installed.json`: which version of each part is in place. faf-linux keeps
/// the same record as `*_current` lines in its `common-env`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Manifest {
    proton: String,
    steam_runtime: String,
    dxvk: String,
    direct_x: String,
    /// `wineboot` has made the prefix.
    prefix: bool,
}

impl Manifest {
    /// A missing or unreadable record is an empty one: everything is installed
    /// again, which is slow but never wrong.
    fn read(layout: &Layout) -> Self {
        std::fs::read(layout.manifest_path())
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    fn write(&self, layout: &Layout) -> Result<(), String> {
        let json = serde_json::to_vec_pretty(self)
            .map_err(|e| format!("could not record the Linux runtime: {e}"))?;
        let path = layout.manifest_path();
        let partial = path.with_extension("json.partial");
        std::fs::write(&partial, json)
            .and_then(|()| std::fs::rename(&partial, &path))
            .map_err(|e| format!("could not record the Linux runtime: {e}"))
    }

    /// Every part at the pinned version, and still on disk.
    fn is_complete(&self, layout: &Layout) -> bool {
        self.proton == PROTON.version
            && self.steam_runtime == STEAM_RUNTIME.version
            && self.dxvk == DXVK.version
            && self.direct_x == DIRECTX.version
            && self.prefix
            && layout.proton_dir().join("files").is_dir()
            && layout.steam_runtime_dir().join("run").is_file()
            && layout.prefix().join("drive_c").is_dir()
            && layout.srt_wrapper().is_file()
            && layout.dxvk_conf().is_file()
    }
}

/// The runtime games start through, once one is complete and switched on.
static ACTIVE: RwLock<Option<Layout>> = RwLock::new(None);

/// The active runtime, if games start through one.
pub(crate) fn active() -> Option<Layout> {
    ACTIVE
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
}

/// The active runtime's Wine prefix. `Game.prefs` and the mods it lists live
/// there while the runtime is in use.
pub(crate) fn active_prefix() -> Option<PathBuf> {
    active().map(|layout| layout.prefix())
}

fn set_active(layout: Option<Layout>) {
    *ACTIVE
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = layout;
}

/// How to start `exe` with `args` through the active runtime, or `None` when
/// none is active.
///
/// The container sees only what it is told to share, so everything the game
/// reads or writes is listed: the FAF install the executable is in, the
/// original game its `fa_path.lua` points at, the vault, the client's cache
/// (game logs) and the replay folder.
pub(crate) fn game_command(exe: &Path, args: Vec<OsString>) -> Option<PlannedCommand> {
    let layout = active()?;
    let mut shared: Vec<PathBuf> = Vec::new();
    // `<install>/bin/ForgedAlliance.exe`: the install root, so `gamedata`
    // beside `bin` is visible as well.
    if let Some(install) = exe.parent().and_then(Path::parent) {
        shared.push(install.to_path_buf());
    }
    shared.extend(crate::infra::game_updater::find_retail_install());
    shared.push(crate::infra::faf_content::vault_dir());
    shared.extend(crate::infra::cache_dir().ok());
    shared.extend(crate::infra::paths::replays_dir());
    let around = surroundings(shared);
    let wine_args = std::iter::once(exe.as_os_str().to_os_string()).chain(args);
    Some(launch::wine_command(&layout, &around, wine_args))
}

/// Steam, the overlay decision and the shared directories, read now.
fn surroundings(shared: Vec<PathBuf>) -> Surroundings {
    Surroundings {
        steam_dir: crate::infra::game_updater::steam_install_dir()
            .and_then(|dir| system::resolved(&dir)),
        steam_running: system::steam_is_running(),
        shared: shared
            .iter()
            .filter_map(|path| system::resolved(path))
            .collect(),
        inside_appimage: inside_appimage(),
    }
}

/// Whether this process runs from inside an AppImage's mount. `APPDIR` alone
/// is inherited by children of any AppImage, so the executable has to be
/// under it as well.
fn inside_appimage() -> bool {
    let Some(appdir) = std::env::var_os("APPDIR").filter(|dir| !dir.is_empty()) else {
        return false;
    };
    std::env::current_exe().is_ok_and(|exe| exe.starts_with(Path::new(&appdir)))
}

/// The real port: this machine's system and its `linux-runtime/` directory.
pub struct LinuxRuntimeGateway {
    /// `None` when no data directory can be resolved, which the install
    /// reports rather than the check.
    layout: Option<Layout>,
}

impl LinuxRuntimeGateway {
    pub fn new() -> Self {
        Self {
            layout: Layout::standard().ok(),
        }
    }
}

impl Default for LinuxRuntimeGateway {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl LinuxRuntimePort for LinuxRuntimeGateway {
    async fn check(&self) -> RuntimeCheck {
        if !cfg!(target_os = "linux") {
            return RuntimeCheck::NotNeeded;
        }
        // Reads Steam's library list and the settings; a few small files.
        let game_found = tokio::task::spawn_blocking(|| {
            crate::infra::game_updater::find_retail_install().is_some()
        })
        .await
        .unwrap_or(false);
        let prerequisites = system::missing_prerequisites(game_found).await;
        if !prerequisites.is_empty() {
            return RuntimeCheck::Missing {
                prerequisites,
                distribution: system::distribution(),
            };
        }
        match &self.layout {
            Some(layout) if Manifest::read(layout).is_complete(layout) => RuntimeCheck::Installed,
            _ => RuntimeCheck::Incomplete,
        }
    }

    fn install(&self, called_off: CancellationToken) -> mpsc::Receiver<RuntimeProgress> {
        let (tx, rx) = mpsc::channel(32);
        let layout = self.layout.clone();
        tokio::spawn(async move {
            let outcome = match layout {
                Some(layout) => setup::install(&layout, &tx, &called_off).await,
                None => Err("could not resolve the client's data directory".into()),
            };
            let _ = tx.send(RuntimeProgress::Finished(outcome)).await;
        });
        rx
    }

    fn activate(&self, active: bool) {
        let complete = self
            .layout
            .as_ref()
            .filter(|layout| Manifest::read(layout).is_complete(layout));
        set_active(if active { complete.cloned() } else { None });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn complete_runtime(root: &Path) -> Layout {
        let layout = Layout::at(root.to_path_buf());
        std::fs::create_dir_all(layout.proton_dir().join("files")).unwrap();
        std::fs::create_dir_all(layout.steam_runtime_dir()).unwrap();
        std::fs::write(layout.steam_runtime_dir().join("run"), b"").unwrap();
        std::fs::create_dir_all(layout.prefix().join("drive_c")).unwrap();
        std::fs::write(layout.srt_wrapper(), b"").unwrap();
        std::fs::write(layout.dxvk_conf(), b"").unwrap();
        Manifest {
            proton: PROTON.version.into(),
            steam_runtime: STEAM_RUNTIME.version.into(),
            dxvk: DXVK.version.into(),
            direct_x: DIRECTX.version.into(),
            prefix: true,
        }
        .write(&layout)
        .unwrap();
        layout
    }

    #[test]
    fn a_runtime_at_the_pinned_versions_is_complete() {
        let temp = tempfile::tempdir().unwrap();
        let layout = complete_runtime(temp.path());
        assert!(Manifest::read(&layout).is_complete(&layout));
    }

    #[test]
    fn an_older_proton_makes_the_runtime_incomplete() {
        let temp = tempfile::tempdir().unwrap();
        let layout = complete_runtime(temp.path());
        let mut manifest = Manifest::read(&layout);
        manifest.proton = "GE-Proton10-25".into();
        manifest.write(&layout).unwrap();
        assert!(!Manifest::read(&layout).is_complete(&layout));
    }

    #[test]
    fn a_runtime_whose_files_were_deleted_is_incomplete() {
        let temp = tempfile::tempdir().unwrap();
        let layout = complete_runtime(temp.path());
        std::fs::remove_dir_all(layout.prefix()).unwrap();
        assert!(!Manifest::read(&layout).is_complete(&layout));
    }

    #[test]
    fn no_record_reads_as_nothing_installed() {
        let temp = tempfile::tempdir().unwrap();
        let layout = Layout::at(temp.path().to_path_buf());
        assert_eq!(Manifest::read(&layout), Manifest::default());
        std::fs::write(temp.path().join("installed.json"), b"not json").unwrap();
        assert_eq!(Manifest::read(&layout), Manifest::default());
    }

    #[test]
    fn every_pin_is_https_and_a_full_sha256() {
        for pin in [PROTON, STEAM_RUNTIME, DXVK, DIRECTX] {
            assert!(pin.url.starts_with("https://"), "{}", pin.url);
            assert!(pin.url.ends_with(pin.file_name), "{}", pin.url);
            assert_eq!(pin.sha256.len(), 64, "{}", pin.file_name);
            assert!(pin.sha256.bytes().all(|b| b.is_ascii_hexdigit()));
            assert!(pin.size > 0);
        }
    }
}
