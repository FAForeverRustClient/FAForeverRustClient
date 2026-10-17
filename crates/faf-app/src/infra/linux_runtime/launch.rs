//! How a Windows program is started through the runtime.
//!
//! faf-linux does this in three scripts, and each one is a part of the
//! command built here:
//!
//! * `launchwrapper` loads Steam's overlay when Steam is running;
//! * `launchwrapper-env` sets up Wine and DXVK and starts the Steam Linux
//!   Runtime container (`steamrt/run`) with the directories the game needs
//!   shared into it;
//! * `launchwrapper-srt` runs inside the container and puts Proton's Wine
//!   first on `PATH`. It stays a script (written by the setup), because it has
//!   to run on the far side of the container boundary.
//!
//! The command is built as data first, so what a launch would run can be
//! tested without a container to run it in.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use super::Layout;

/// The FA app id on Steam. Wine and the overlay read it from the environment.
const STEAM_GAME_ID: &str = "9420";

/// What a launch needs to know besides the runtime's own layout.
#[derive(Debug, Clone, Default)]
pub(crate) struct Surroundings {
    /// Steam's own directory, resolved through symlinks.
    pub steam_dir: Option<PathBuf>,
    /// Whether Steam is running now. Its overlay is loaded only then.
    pub steam_running: bool,
    /// Directories the program reads or writes, resolved. The runtime's own
    /// root is always shared and need not be listed.
    pub shared: Vec<PathBuf>,
    /// Whether this client runs from an AppImage, whose runtime may point
    /// `LD_LIBRARY_PATH` into its own mount.
    pub inside_appimage: bool,
}

/// A command ready to be handed to `std::process::Command` or tokio's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PlannedCommand {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub env: Vec<(&'static str, OsString)>,
    pub env_remove: Vec<&'static str>,
}

impl PlannedCommand {
    pub(crate) fn std_command(&self) -> std::process::Command {
        let mut command = std::process::Command::new(&self.program);
        command.args(&self.args);
        for name in &self.env_remove {
            command.env_remove(name);
        }
        for (name, value) in &self.env {
            command.env(name, value);
        }
        command
    }
}

/// `wine <wine_args>` inside the container, with faf-linux's environment.
pub(crate) fn wine_command(
    layout: &Layout,
    around: &Surroundings,
    wine_args: impl IntoIterator<Item = OsString>,
) -> PlannedCommand {
    let mut args: Vec<OsString> = vec![
        "--".into(),
        layout.srt_wrapper().into_os_string(),
        "wine".into(),
    ];
    args.extend(wine_args);

    let mut env: Vec<(&'static str, OsString)> = vec![
        ("WINEPREFIX", layout.prefix().into_os_string()),
        ("SteamGameId", STEAM_GAME_ID.into()),
        ("SteamAppId", STEAM_GAME_ID.into()),
        ("DXVK_HUD", "compiler".into()),
        ("DXVK_CONFIG_FILE", layout.dxvk_conf().into_os_string()),
        (
            "DXVK_STATE_CACHE_PATH",
            layout.dxvk_cache().into_os_string(),
        ),
        // Forged Alliance runs out of address space on big maps otherwise.
        ("WINE_LARGE_ADDRESS_AWARE", "1".into()),
        ("WINENTSYNC", "1".into()),
        // FA uses neither Wine's .NET nor its HTML engine, so the prefix is
        // made without them and without the dialogs offering to download
        // them; nor should Wine put shortcuts on the desktop.
        (
            "WINEDLLOVERRIDES",
            "mscoree=d;mshtml=d;winemenubuilder=d".into(),
        ),
        // Read by `launchwrapper-srt` inside the container.
        ("proton_path", layout.proton_dir().into_os_string()),
        (
            "PRESSURE_VESSEL_FILESYSTEMS_RW",
            shared_list(layout.root(), around),
        ),
    ];
    if let Some(steam) = &around.steam_dir {
        env.push((
            "STEAM_COMPAT_CLIENT_INSTALL_PATH",
            steam.clone().into_os_string(),
        ));
        if around.steam_running {
            // The 64-bit library, because the prefix runs in WoW64 mode, the
            // way faf-linux's `use_wine_wow64=1` does.
            env.push((
                "LD_PRELOAD",
                steam
                    .join("ubuntu12_64")
                    .join("gameoverlayrenderer.so")
                    .into_os_string(),
            ));
            env.push(("ENABLE_VK_LAYER_VALVE_steam_overlay_1", "1".into()));
        }
    }

    // esync and fsync have broken Forged Alliance before; faf-linux unsets
    // them, and so does this.
    let mut env_remove = vec!["WINEESYNC", "WINEFSYNC"];
    if around.inside_appimage {
        // Libraries from the client's own AppImage mount have no business in
        // the container, and would win over its own.
        env_remove.push("LD_LIBRARY_PATH");
    }

    PlannedCommand {
        program: layout.steam_runtime_dir().join("run"),
        args,
        env,
        env_remove,
    }
}

/// The colon-separated list pressure-vessel shares read-write: the runtime,
/// Steam, and whatever the caller named, each once. A path that itself holds a
/// colon cannot be written into the list and is left out.
fn shared_list(root: &Path, around: &Surroundings) -> OsString {
    let mut seen: Vec<&Path> = Vec::new();
    let candidates = std::iter::once(root)
        .chain(around.steam_dir.as_deref())
        .chain(around.shared.iter().map(PathBuf::as_path));
    for path in candidates {
        let holds_colon = path.as_os_str().to_string_lossy().contains(':');
        if !holds_colon && !seen.contains(&path) {
            seen.push(path);
        }
    }
    let mut list = OsString::new();
    for (index, path) in seen.iter().enumerate() {
        if index > 0 {
            list.push(":");
        }
        list.push(path.as_os_str());
    }
    list
}

/// `launchwrapper-srt`, with `use_wine_wow64=1` decided at write time.
pub(crate) const SRT_WRAPPER: &str = "#!/bin/sh\n\
# Written by the FAForever client. Runs inside the Steam Linux Runtime\n\
# container and puts Proton's Wine first on PATH, like launchwrapper-srt in\n\
# FAForever/faf-linux (MIT).\n\
export PATH=\"$proton_path/files/bin-wow64/:$PATH\"\n\
exec \"$@\"\n";

// Unix paths throughout: the runtime exists only on Linux.
#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn value<'a>(planned: &'a PlannedCommand, name: &str) -> Option<&'a OsString> {
        planned
            .env
            .iter()
            .find(|(key, _)| *key == name)
            .map(|(_, value)| value)
    }

    fn layout() -> Layout {
        Layout::at(PathBuf::from(
            "/home/p/.local/share/faforeverclient/linux-runtime",
        ))
    }

    #[test]
    fn the_game_runs_as_wine_inside_the_container() {
        let layout = layout();
        let planned = wine_command(
            &layout,
            &Surroundings::default(),
            [
                "/home/p/.faforever/bin/ForgedAlliance.exe".into(),
                "/init".into(),
            ],
        );
        assert_eq!(planned.program, layout.steam_runtime_dir().join("run"));
        assert_eq!(
            planned.args,
            vec![
                OsString::from("--"),
                layout.srt_wrapper().into_os_string(),
                "wine".into(),
                "/home/p/.faforever/bin/ForgedAlliance.exe".into(),
                "/init".into(),
            ]
        );
        assert_eq!(
            value(&planned, "WINEPREFIX"),
            Some(&layout.prefix().into_os_string())
        );
        assert_eq!(value(&planned, "SteamGameId"), Some(&"9420".into()));
        assert_eq!(
            value(&planned, "WINE_LARGE_ADDRESS_AWARE"),
            Some(&"1".into())
        );
        assert_eq!(
            value(&planned, "WINEDLLOVERRIDES"),
            Some(&"mscoree=d;mshtml=d;winemenubuilder=d".into())
        );
        assert!(planned.env_remove.contains(&"WINEESYNC"));
        assert!(planned.env_remove.contains(&"WINEFSYNC"));
        // No Steam found: nothing about Steam is set.
        assert_eq!(value(&planned, "STEAM_COMPAT_CLIENT_INSTALL_PATH"), None);
        assert_eq!(value(&planned, "LD_PRELOAD"), None);
    }

    #[test]
    fn steams_overlay_is_loaded_only_while_steam_runs() {
        let layout = layout();
        let mut around = Surroundings {
            steam_dir: Some(PathBuf::from("/home/p/.local/share/Steam")),
            ..Surroundings::default()
        };
        let idle = wine_command(&layout, &around, []);
        assert_eq!(
            value(&idle, "STEAM_COMPAT_CLIENT_INSTALL_PATH"),
            Some(&"/home/p/.local/share/Steam".into())
        );
        assert_eq!(value(&idle, "LD_PRELOAD"), None);

        around.steam_running = true;
        let running = wine_command(&layout, &around, []);
        assert_eq!(
            value(&running, "LD_PRELOAD"),
            Some(
                &PathBuf::from("/home/p/.local/share/Steam/ubuntu12_64/gameoverlayrenderer.so")
                    .into_os_string()
            )
        );
        assert_eq!(
            value(&running, "ENABLE_VK_LAYER_VALVE_steam_overlay_1"),
            Some(&"1".into())
        );
    }

    #[test]
    fn the_container_shares_each_directory_once_and_never_one_with_a_colon() {
        let layout = layout();
        let around = Surroundings {
            steam_dir: Some(PathBuf::from("/home/p/.local/share/Steam")),
            shared: vec![
                PathBuf::from(
                    "/mnt/games/SteamLibrary/steamapps/common/Supreme Commander Forged Alliance",
                ),
                PathBuf::from("/home/p/.local/share/Steam"),
                PathBuf::from("/media/odd:name"),
                PathBuf::from("/home/p/.faforever"),
            ],
            ..Surroundings::default()
        };
        let planned = wine_command(&layout, &around, []);
        assert_eq!(
            value(&planned, "PRESSURE_VESSEL_FILESYSTEMS_RW"),
            Some(&OsString::from(
                "/home/p/.local/share/faforeverclient/linux-runtime:\
                 /home/p/.local/share/Steam:\
                 /mnt/games/SteamLibrary/steamapps/common/Supreme Commander Forged Alliance:\
                 /home/p/.faforever"
            ))
        );
    }

    #[test]
    fn an_appimage_keeps_its_library_path_out_of_the_container() {
        let layout = layout();
        let around = Surroundings {
            inside_appimage: true,
            ..Surroundings::default()
        };
        let planned = wine_command(&layout, &around, []);
        assert!(planned.env_remove.contains(&"LD_LIBRARY_PATH"));
        let outside = wine_command(&layout, &Surroundings::default(), []);
        assert!(!outside.env_remove.contains(&"LD_LIBRARY_PATH"));
    }

    #[test]
    fn the_wrapper_script_puts_protons_wine_first() {
        assert!(SRT_WRAPPER.starts_with("#!/bin/sh\n"));
        assert!(SRT_WRAPPER.contains("export PATH=\"$proton_path/files/bin-wow64/:$PATH\"\n"));
        assert!(SRT_WRAPPER.ends_with("exec \"$@\"\n"));
    }
}
