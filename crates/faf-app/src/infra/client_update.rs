//! Client self-update against the GitHub releases API.
//!
//! Java's `CheckForBetaUpdateTask` reads the same endpoint; its stable channel
//! instead reads FAF's own remote client configuration, which points at the
//! *Java* client's builds and is therefore no use to us. So both channels come
//! from this repository's releases here, and the prerelease flag is what
//! separates them.
//!
//! ## What is trusted, and what is not
//!
//! This downloads a file and then executes it, so it is worth being precise
//! about the trust chain, which is exactly as long as the Java client's and no
//! longer:
//!
//! - **TLS to GitHub.** Enforced by refusing any download URL that is not
//!   `https://`.
//! - **The configured repository.** A download URL must start with this repo's
//!   release-download prefix, so a compromised or mistaken API response cannot
//!   redirect the installer to an arbitrary host.
//! - **Nothing else.** There is *no signature check*. Anyone who can publish a
//!   release to the configured repository can run code on every client that
//!   accepts the update: which is true of the Java client too, and is the
//!   reason `tauri-plugin-updater` exists. Adopting it needs a signing key that
//!   only a release maintainer can generate, so it is left as a follow-up
//!   rather than faked here.
//!
//! The downloaded file's *name* is never taken from the API. It is built from
//! the release version (already shape-checked by
//! [`faf_domain::state::is_release_version`]) plus one of this module's own
//! [`ASSET_SUFFIXES`], so a hostile asset name cannot influence where the
//! client writes or what it runs.

mod installer;

use async_trait::async_trait;
use faf_domain::protocol::changelog::{marks_required_update, parse_release_notes};
use faf_domain::state::{
    compare_versions, is_release_version, strip_version_prefix, ClientRelease, ClientReleaseNotes,
    ReleaseChannel,
};
use serde_json::Value;
use std::cmp::Ordering;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::infra::{cache_dir, env_or};
use crate::ports::{ClientUpdatePort, DownloadProgress};

/// Installer kinds this platform can run, best first.
///
/// Windows gets the NSIS installer ahead of the MSI because it can upgrade in
/// place; the MSI is kept as the fallback because `bundle.targets` is `all` and
/// a release may ship only one of them. macOS and Linux mirror what Tauri
/// bundles for each.
#[cfg(target_os = "windows")]
pub const ASSET_SUFFIXES: [&str; 2] = ["-setup.exe", ".msi"];
#[cfg(target_os = "macos")]
pub const ASSET_SUFFIXES: [&str; 2] = [".dmg", ".app.tar.gz"];
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub const ASSET_SUFFIXES: [&str; 3] = [".AppImage", ".deb", ".rpm"];

/// The default source of releases: this client's own repository.
///
/// It has to be the repository's real name, not a readable version of it. This
/// was `FAForeverRustClient/FAForever-Rust-Client`, which GitHub answers with a
/// 404, so every update check failed and no client would ever have been offered
/// a release however well one was published.
const DEFAULT_REPO: &str = "FAForeverRustClient/FAForeverRustClient";

/// GitHub rejects unidentified API clients, so this is required, not polite.
/// Thirty releases of GitHub JSON, with room to spare. The API's own page of
/// thirty is well under a megabyte.
const MAX_RELEASE_LIST_BYTES: u64 = 4 * 1024 * 1024;

const USER_AGENT: &str = concat!("faforever-rust-client/", env!("CARGO_PKG_VERSION"));
/// Hard disk/memory safety ceiling for a self-update asset. Current platform
/// bundles are far smaller; a response beyond this is never a legitimate
/// installer for this client.
const MAX_INSTALLER_BYTES: u64 = 1024 * 1024 * 1024;

/// Why a download stopped when the service called it off. Nobody reads it:
/// the receiver it would go to is the one that was closed.
const DOWNLOAD_CALLED_OFF: &str = "the download was called off";

#[derive(Debug, Clone)]
pub struct ClientUpdateConfig {
    /// GitHub API root.
    pub api_base: String,
    /// `owner/name` of the repository whose releases are offered.
    pub repo: String,
    /// A download URL must start with this, or it is refused. Derived from
    /// `repo` unless overridden, which is how a fork or a test points the
    /// download somewhere else *deliberately*.
    pub download_prefix: String,
}

impl ClientUpdateConfig {
    pub fn faf() -> Self {
        let repo = env_or("FAF_CLIENT_UPDATE_REPO", DEFAULT_REPO);
        // Where the client's own installer comes from is not an
        // environment variable in a shipped build: see `dev_env_or`.
        let download_prefix = crate::infra::dev_env_or(
            "FAF_CLIENT_UPDATE_DOWNLOAD_PREFIX",
            format!("https://github.com/{repo}/releases/download/"),
        );
        Self {
            api_base: env_or("FAF_CLIENT_UPDATE_API_BASE", "https://api.github.com"),
            repo,
            download_prefix,
        }
    }
}

pub struct GitHubUpdates {
    config: ClientUpdateConfig,
    http: reqwest::Client,
    /// The notes of the last release list that was read, newest first, or
    /// `None` until one has been. Every check refreshes it and nothing else
    /// has to: see [`ClientUpdatePort::release_notes`].
    notes: Arc<Mutex<Option<Vec<ClientReleaseNotes>>>>,
    /// Held for the length of one read of the release list. The startup check
    /// and the Changelog tab asking for the notes used to read it side by
    /// side: open Client updates before the check had its answer and the
    /// cache was still empty, so a second request went out, and whichever
    /// answer landed last was kept even when it was the older one. Now the
    /// notes wait for a read already on the way and take what it stored.
    reading: Arc<tokio::sync::Mutex<()>>,
}

impl GitHubUpdates {
    pub fn new(config: ClientUpdateConfig) -> Self {
        Self {
            config,
            // The installer is executed, so the transport refuses a redirect
            // that leaves HTTPS. `is_trusted` pins the first URL to the
            // release prefix; this is what stops a later hop undoing that.
            http: super::http::https_only_download_client(),
            notes: Arc::default(),
            reading: Arc::default(),
        }
    }

    pub fn faf() -> Self {
        Self::new(ClientUpdateConfig::faf())
    }

    /// Reject a download URL that does not come from the configured repository
    /// over TLS. See the module doc: this is one of the two things standing
    /// between the API response and code execution.
    fn is_trusted(&self, url: &str) -> bool {
        url.starts_with("https://")
            && url.starts_with(&self.config.download_prefix)
            // `..` would be normalised away by the URL parser, escaping the
            // prefix this check just verified.
            && !url.contains("..")
    }

    /// Where an installer for `release` is written.
    ///
    /// Deliberately not derived from the asset name: see the module doc.
    fn installer_path(&self, release: &ClientRelease) -> Result<PathBuf, String> {
        let suffix = ASSET_SUFFIXES
            .iter()
            .find(|suffix| release.asset_name.ends_with(*suffix))
            .ok_or_else(|| {
                format!(
                    "release {} has no installer this platform can run",
                    release.version
                )
            })?;
        if !is_release_version(&release.version) {
            return Err(format!("{} is not a release version", release.version));
        }
        Ok(cache_dir()?
            .join("updates")
            .join(format!("faf-client-{}{suffix}", release.version)))
    }

    async fn fetch_releases(&self) -> Result<Vec<Value>, String> {
        let url = format!(
            "{}/repos/{}/releases?per_page=30",
            self.config.api_base, self.config.repo
        );
        let response = self
            .http
            .get(&url)
            .header(reqwest::header::USER_AGENT, USER_AGENT)
            .header(reqwest::header::ACCEPT, "application/vnd.github+json")
            .send()
            .await
            .map_err(|e| {
                format!(
                    "could not reach the release list: {}",
                    crate::infra::http::describe_transport_error(&e)
                )
            })?;

        let status = response.status();
        // Bounded like every other body in the client. This was the one that
        // was not, which is only a memory risk against a compromised GitHub
        // API, but an exception with no reason behind it is the kind that
        // gets copied.
        let body = crate::infra::vault_install::bounded_body(
            response,
            "the release list",
            MAX_RELEASE_LIST_BYTES,
        )
        .await
        .map_err(|e| format!("could not read the release list: {e}"))?;
        let body = String::from_utf8_lossy(&body).into_owned();
        if !status.is_success() {
            return Err(format!(
                "the release list returned {status}: {}",
                body.chars().take(200).collect::<String>()
            ));
        }

        match serde_json::from_str::<Value>(&body) {
            Ok(Value::Array(releases)) => Ok(releases),
            Ok(_) => Err("the release list was not a list".to_string()),
            Err(e) => Err(format!("the release list was not valid JSON: {e}")),
        }
    }

    /// Parse the notes out of a release list just read, and keep them for the
    /// next [`ClientUpdatePort::release_notes`].
    fn remember_notes(&self, releases: &[Value]) -> Vec<ClientReleaseNotes> {
        let issue_base = format!("https://github.com/{}/issues", self.config.repo);
        let notes = release_notes_from(releases, &issue_base);
        *self.notes.lock().unwrap_or_else(PoisonError::into_inner) = Some(notes.clone());
        notes
    }

    async fn run_download(
        &self,
        release: &ClientRelease,
        progress: &mpsc::Sender<DownloadProgress>,
        called_off: &CancellationToken,
    ) -> Result<String, String> {
        if !self.is_trusted(&release.download_url) {
            // Not a "download failed": this is the check refusing to run
            // something that did not come from the configured repository.
            return Err(format!(
                "refusing to download {}: it is not a release asset of {}",
                release.download_url, self.config.repo
            ));
        }

        let target = self.installer_path(release)?;
        self.run_download_to(release, progress, called_off, &target)
            .await
    }

    async fn run_download_to(
        &self,
        release: &ClientRelease,
        progress: &mpsc::Sender<DownloadProgress>,
        called_off: &CancellationToken,
        target: &std::path::Path,
    ) -> Result<String, String> {
        let directory = target
            .parent()
            .ok_or_else(|| "could not resolve the download directory".to_string())?;
        tokio::fs::create_dir_all(directory)
            .await
            .map_err(|e| format!("could not create the download directory: {e}"))?;
        // A completed target only arrives through our atomic rename below.
        // Reuse its advertised, non-zero size instead of fetching it again.
        if release.size_bytes > 0
            && tokio::fs::symlink_metadata(target)
                .await
                .is_ok_and(|metadata| {
                    metadata.is_file() && metadata.len() == u64::from(release.size_bytes)
                })
        {
            prune_installers(directory, target).await;
            return Ok(target.to_string_lossy().into_owned());
        }
        let partial = target.with_extension("partial");
        // Clean up a file left by a process kill before starting another
        // attempt; completed installers use a different path.
        if tokio::fs::try_exists(&partial).await.unwrap_or(false) {
            tokio::fs::remove_file(&partial)
                .await
                .map_err(|e| format!("could not clear the partial installer: {e}"))?;
        }

        // The service waits for this worker to end before the next download
        // may start, so every wait on the network also listens for the
        // call-off (or for nobody listening any more), rather than only
        // noticing at the next chunk: a stalled connection would hold the
        // cancel, and with it the next attempt, for as long as it stalls.
        let sending = self
            .http
            .get(&release.download_url)
            .header(reqwest::header::USER_AGENT, USER_AGENT)
            .send();
        let response = tokio::select! {
            biased;
            () = called_off.cancelled() => return Err(DOWNLOAD_CALLED_OFF.into()),
            () = progress.closed() => return Err(DOWNLOAD_CALLED_OFF.into()),
            response = sending => response,
        }
        .map_err(|e| {
            format!(
                "could not reach the installer: {}",
                crate::infra::http::describe_transport_error(&e)
            )
        })?;
        if !response.status().is_success() {
            return Err(format!(
                "the installer download returned {}",
                response.status()
            ));
        }
        if response
            .content_length()
            .is_some_and(|size| size > MAX_INSTALLER_BYTES)
        {
            return Err("the installer is larger than the allowed download size".into());
        }
        // Clamped for the IPC boundary, which has no 64-bit integer.
        let total_bytes = response
            .content_length()
            .map(|n| u32::try_from(n).unwrap_or(u32::MAX))
            .unwrap_or(0);

        // Written aside and renamed, so an interrupted download can never be
        // mistaken for a complete installer and executed.
        let mut file = tokio::fs::File::create(&partial)
            .await
            .map_err(|e| format!("could not write the installer: {e}"))?;

        let mut received: u64 = 0;
        // What the last report said: a whole percent while the size is known,
        // a 512 KiB step while it is not. Every chunk used to be a report, and
        // every report is an event the whole state is reduced by.
        let mut reported: Option<u64> = None;
        let mut stream = response.bytes_stream();
        use futures_util::StreamExt as _;
        use tokio::io::AsyncWriteExt as _;
        let write_result: Result<(), String> = async {
            loop {
                // Stopping here goes through the error path below, which
                // removes the partial file, so the next attempt starts from
                // nothing rather than from half an installer.
                let chunk = tokio::select! {
                    biased;
                    () = called_off.cancelled() => return Err(DOWNLOAD_CALLED_OFF.into()),
                    () = progress.closed() => return Err(DOWNLOAD_CALLED_OFF.into()),
                    chunk = stream.next() => chunk,
                };
                let Some(chunk) = chunk else {
                    break;
                };
                let chunk = chunk.map_err(|e| {
                    format!(
                        "the installer download failed: {}",
                        crate::infra::http::describe_transport_error(&e)
                    )
                })?;
                received = received
                    .checked_add(chunk.len() as u64)
                    .ok_or_else(|| "the installer is too large".to_string())?;
                if received > MAX_INSTALLER_BYTES {
                    return Err("the installer is larger than the allowed download size".into());
                }
                file.write_all(&chunk)
                    .await
                    .map_err(|e| format!("could not write the installer: {e}"))?;
                let step = if total_bytes > 0 {
                    received.min(u64::from(total_bytes)) * 100 / u64::from(total_bytes)
                } else {
                    received / (512 * 1024)
                };
                if reported != Some(step) {
                    reported = Some(step);
                    progress
                        .send(DownloadProgress::Received {
                            received_bytes: u32::try_from(received).unwrap_or(u32::MAX),
                            total_bytes,
                        })
                        .await
                        .map_err(|_| DOWNLOAD_CALLED_OFF.to_string())?;
                }
            }
            file.flush()
                .await
                .map_err(|e| format!("could not finish writing the installer: {e}"))
        }
        .await;
        drop(file);
        if let Err(error) = write_result {
            let _ = tokio::fs::remove_file(&partial).await;
            return Err(error);
        }

        if let Err(error) = tokio::fs::rename(&partial, target).await {
            let _ = tokio::fs::remove_file(&partial).await;
            return Err(format!("could not store the installer: {error}"));
        }
        prune_installers(directory, target).await;
        Ok(target.to_string_lossy().into_owned())
    }
}

/// Only our installer files are pruned; unrelated cache entries stay intact.
async fn prune_installers(directory: &std::path::Path, keep: &std::path::Path) {
    let mut entries = match tokio::fs::read_dir(directory).await {
        Ok(entries) => entries,
        Err(error) => {
            tracing::warn!(kind = ?error.kind(), "could not read cached installers");
            return;
        }
    };
    loop {
        let entry = match entries.next_entry().await {
            Ok(Some(entry)) => entry,
            Ok(None) => break,
            Err(error) => {
                tracing::warn!(kind = ?error.kind(), "could not read a cached installer entry");
                break;
            }
        };
        if entry.path() == keep
            || !entry
                .file_name()
                .to_string_lossy()
                .starts_with("faf-client-")
        {
            continue;
        }
        if entry.file_type().await.is_ok_and(|kind| kind.is_file()) {
            if let Err(error) = tokio::fs::remove_file(entry.path()).await {
                tracing::warn!(file = ?entry.file_name(), kind = ?error.kind(), "could not remove an old installer");
            }
        }
    }
}

#[async_trait]
impl ClientUpdatePort for GitHubUpdates {
    async fn latest(&self, channel: ReleaseChannel) -> Result<Option<ClientRelease>, String> {
        // Always read fresh: a check is the moment a new release is found.
        // The notes come along for free, which is the point of keeping them.
        let _reading = self.reading.lock().await;
        let releases = self.fetch_releases().await?;
        self.remember_notes(&releases);
        Ok(pick_release(&releases, channel))
    }

    async fn release_notes(&self) -> Result<Vec<ClientReleaseNotes>, String> {
        if let Some(notes) = self.cached_release_notes() {
            return Ok(notes);
        }
        // A check may be reading the list right now. Wait for it, and use what
        // it stored; read only if it failed or nothing was reading.
        let _reading = self.reading.lock().await;
        if let Some(notes) = self.cached_release_notes() {
            return Ok(notes);
        }
        let releases = self.fetch_releases().await?;
        Ok(self.remember_notes(&releases))
    }

    fn cached_release_notes(&self) -> Option<Vec<ClientReleaseNotes>> {
        self.notes
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    async fn download(
        &self,
        release: ClientRelease,
        called_off: CancellationToken,
    ) -> mpsc::Receiver<DownloadProgress> {
        let (tx, rx) = mpsc::channel(32);
        let config = self.config.clone();
        let http = self.http.clone();
        let notes = self.notes.clone();
        let reading = self.reading.clone();
        tokio::spawn(async move {
            let client = GitHubUpdates {
                config,
                http,
                notes,
                reading,
            };
            let outcome = client.run_download(&release, &tx, &called_off).await;
            // The sender goes only after the partial file did: see the port.
            let _ = tx.send(DownloadProgress::Finished(outcome)).await;
        });
        rx
    }

    async fn install(&self, path: String) -> Result<(), String> {
        start_installer(Path::new(&path)).await
    }
}

/// Choose the newest usable release from a GitHub `/releases` response.
///
/// Pure so the interesting decisions: draft handling, channel filtering,
/// version ordering, asset selection: are testable without a network.
fn pick_release(releases: &[Value], channel: ReleaseChannel) -> Option<ClientRelease> {
    let mut best: Option<ClientRelease> = None;
    for release in releases {
        // Offering a draft would hand out an unfinished build.
        if is_draft(release) {
            continue;
        }
        let pre_release = release
            .get("prerelease")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if pre_release && channel == ReleaseChannel::Stable {
            continue;
        }

        let tag = release.get("tag_name").and_then(Value::as_str)?;
        // A repository can carry tags that are not versions at all. Skipping
        // them is what keeps `latest` from becoming "whatever sorts last".
        if !is_release_version(tag) {
            continue;
        }
        let version = strip_version_prefix(tag).to_string();

        let asset = pick_asset(release.get("assets"));
        let candidate = ClientRelease {
            version,
            notes_url: release
                .get("html_url")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            download_url: asset
                .as_ref()
                .map(|asset| asset.url.clone())
                .unwrap_or_default(),
            asset_name: asset
                .as_ref()
                .map(|asset| asset.name.clone())
                .unwrap_or_default(),
            size_bytes: asset.as_ref().map(|asset| asset.size).unwrap_or(0),
            pre_release,
            published_at: release
                .get("published_at")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        };

        // Newest by version, not by list order: GitHub returns releases in
        // creation order, and a patch backported to an older line would
        // otherwise outrank the newest one.
        let better = match &best {
            None => true,
            Some(best) => compare_versions(&candidate.version, &best.version) == Ordering::Greater,
        };
        if better {
            best = Some(candidate);
        }
    }
    best
}

/// Drafts are visible to authenticated maintainers and are not published.
fn is_draft(release: &Value) -> bool {
    release
        .get("draft")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// Every published release's notes from a GitHub `/releases` response, newest
/// first.
///
/// The releases [`pick_release`] would consider, without the channel: a draft
/// is unpublished, and a tag that is not a version names nothing the client
/// could have run. Ordered by version as the update check orders them, not as
/// GitHub lists them, which is by creation. `issue_base` is where a `(#123)` in
/// a body links to; see [`parse_release_notes`].
fn release_notes_from(releases: &[Value], issue_base: &str) -> Vec<ClientReleaseNotes> {
    let mut notes: Vec<ClientReleaseNotes> = releases
        .iter()
        .filter(|release| !is_draft(release))
        .filter_map(|release| {
            let tag = release.get("tag_name").and_then(Value::as_str)?;
            if !is_release_version(tag) {
                return None;
            }
            let text = |key: &str| release.get(key).and_then(Value::as_str).unwrap_or_default();
            Some(ClientReleaseNotes {
                version: strip_version_prefix(tag).to_string(),
                published_at: Some(text("published_at"))
                    .filter(|at| !at.is_empty())
                    .map(str::to_string),
                pre_release: release
                    .get("prerelease")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                notes_url: text("html_url").to_string(),
                // `null` for a release published with no text at all.
                blocks: parse_release_notes(text("body"), issue_base),
                required: marks_required_update(text("body")),
            })
        })
        .collect();
    notes.sort_by(|left, right| compare_versions(&right.version, &left.version));
    notes
}

struct Asset {
    name: String,
    url: String,
    size: u32,
}

/// The installer for this platform, preferring earlier [`ASSET_SUFFIXES`].
fn pick_asset(assets: Option<&Value>) -> Option<Asset> {
    let assets = assets?.as_array()?;
    for suffix in ASSET_SUFFIXES {
        for asset in assets {
            let name = asset
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !name.ends_with(suffix) {
                continue;
            }
            let url = asset
                .get("browser_download_url")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if url.is_empty() {
                continue;
            }
            return Some(Asset {
                name: name.to_string(),
                url: url.to_string(),
                size: asset
                    .get("size")
                    .and_then(Value::as_u64)
                    .map(|n| u32::try_from(n).unwrap_or(u32::MAX))
                    .unwrap_or(0),
            });
        }
    }
    None
}

/// Install the update and return.
///
/// A Linux AppImage replaces the image this process was launched from, and the
/// shell then restarts into it. An `.msi` is data, not a program, so it goes
/// through `msiexec`. Everything else is executed directly, matching Java's
/// `ProcessBuilder(command)`.
async fn start_installer(path: &Path) -> Result<(), String> {
    if !path.is_file() {
        return Err(format!("{} is no longer there", path.display()));
    }

    // An AppImage is the installed application, not an installer. Starting the
    // downloaded copy from the update cache would run the new version once but
    // leave the AppImage the user normally launches unchanged. Put the new
    // image over that file instead; the running process keeps using the old
    // inode until it exits. Copying some hundred megabytes is blocking work,
    // so it stays off the async workers.
    #[cfg(target_os = "linux")]
    if path.extension().is_some_and(|ext| ext == "AppImage") {
        if let Some(installed) = running_appimage() {
            let downloaded = path.to_path_buf();
            return tokio::task::spawn_blocking(move || replace_appimage(&downloaded, &installed))
                .await
                .map_err(|e| format!("could not replace the AppImage: {e}"))?;
        }
    }

    #[cfg(unix)]
    {
        // Java does the same via `setUnixExecutableAndWritableBits`: an asset
        // downloaded over HTTP arrives without the executable bit.
        use std::os::unix::fs::PermissionsExt as _;
        let permissions = std::fs::Permissions::from_mode(0o755);
        std::fs::set_permissions(path, permissions)
            .map_err(|e| format!("could not make the installer executable: {e}"))?;
    }

    let mut command = tokio::process::Command::from(installer::command(path, cfg!(windows)));

    command
        .spawn()
        .map(|_child| ())
        .map_err(|e| format!("could not start the installer: {e}"))
}

/// The AppImage file this process runs from, if it runs from one.
///
/// `APPIMAGE` alone is no proof. The AppImage runtime sets it for the program
/// it starts and every child inherits it, so a client started from a terminal
/// inside some other AppImage (an editor, say) sees that one's path, and an
/// update would overwrite the editor with this client. The runtime mounts the
/// image at `APPDIR` and runs this binary from inside the mount, so the two
/// variables describe this process only when its executable is under `APPDIR`.
#[cfg(target_os = "linux")]
pub fn running_appimage() -> Option<PathBuf> {
    appimage_of(
        std::env::var_os("APPIMAGE").as_deref(),
        std::env::var_os("APPDIR").as_deref(),
        std::env::current_exe().ok().as_deref(),
    )
}

/// [`running_appimage`]'s decision, apart from the process it reads.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn appimage_of(
    appimage: Option<&OsStr>,
    appdir: Option<&OsStr>,
    executable: Option<&Path>,
) -> Option<PathBuf> {
    let appimage = PathBuf::from(appimage.filter(|value| !value.is_empty())?);
    let appdir = Path::new(appdir?);
    // `/` or an empty value would hold every executable on the machine.
    appdir.parent()?;
    executable?.starts_with(appdir).then_some(appimage)
}

/// Atomically replace a running AppImage without modifying the inode mounted
/// by its current process. The temporary file lives beside the installed one,
/// so the final rename cannot cross filesystems even when the download cache
/// does.
#[cfg(target_os = "linux")]
fn replace_appimage(downloaded: &Path, installed: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt as _;

    if !installed.is_file() {
        return Err(format!(
            "could not replace the AppImage: {} is no longer there",
            installed.display()
        ));
    }
    let directory = installed.parent().ok_or_else(|| {
        format!(
            "could not resolve the AppImage directory for {}",
            installed.display()
        )
    })?;
    let temporary = tempfile::NamedTempFile::new_in(directory)
        .map_err(|e| format!("could not create the replacement AppImage: {e}"))?;
    std::fs::copy(downloaded, temporary.path())
        .map_err(|e| format!("could not copy the replacement AppImage: {e}"))?;
    std::fs::set_permissions(temporary.path(), std::fs::Permissions::from_mode(0o755))
        .map_err(|e| format!("could not make the replacement AppImage executable: {e}"))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|e| format!("could not finish writing the replacement AppImage: {e}"))?;
    temporary
        .persist(installed)
        .map(|_| ())
        .map_err(|e| format!("could not replace the AppImage: {}", e.error))
}

/// Reports that the client is current, without asking anyone.
///
/// Used offline and in tests. Deliberately `Ok(None)` rather than an error:
/// a development build should show no update banner at all, and an error would
/// put a failure into Settings that nothing is wrong with.
#[derive(Debug, Clone, Default)]
pub struct FakeClientUpdates;

#[async_trait]
impl ClientUpdatePort for FakeClientUpdates {
    async fn latest(&self, _channel: ReleaseChannel) -> Result<Option<ClientRelease>, String> {
        Ok(None)
    }

    /// Reports rather than inventing notes, as the offline changelog does: a
    /// fabricated list of changes would be worse than an empty section.
    async fn release_notes(&self) -> Result<Vec<ClientReleaseNotes>, String> {
        Err("the client's release notes are unavailable in offline mode".into())
    }

    async fn download(
        &self,
        _release: ClientRelease,
        _called_off: CancellationToken,
    ) -> mpsc::Receiver<DownloadProgress> {
        let (tx, rx) = mpsc::channel(1);
        let _ = tx
            .send(DownloadProgress::Finished(Err(
                "this build does not download updates".into(),
            )))
            .await;
        rx
    }

    async fn install(&self, _path: String) -> Result<(), String> {
        Err("this build does not install updates".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A release whose asset name ends in whatever this platform accepts, so
    /// the tests below exercise the same path on every runner.
    fn asset_name(stem: &str) -> String {
        format!("{stem}{}", ASSET_SUFFIXES[0])
    }

    fn release_json(tag: &str, pre_release: bool, with_asset: bool) -> Value {
        let assets = if with_asset {
            serde_json::json!([{
                "name": asset_name("faf-client"),
                "browser_download_url":
                    format!("https://github.com/Org/Repo/releases/download/{tag}/{}", asset_name("faf-client")),
                "size": 4096,
            }])
        } else {
            serde_json::json!([])
        };
        serde_json::json!({
            "tag_name": tag,
            "prerelease": pre_release,
            "draft": false,
            "html_url": format!("https://github.com/Org/Repo/releases/tag/{tag}"),
            "published_at": "2026-02-01T00:00:00Z",
            "assets": assets,
        })
    }

    fn config() -> ClientUpdateConfig {
        ClientUpdateConfig {
            api_base: "https://api.github.invalid".into(),
            repo: "Org/Repo".into(),
            download_prefix: "https://github.com/Org/Repo/releases/download/".into(),
        }
    }

    #[test]
    fn the_newest_version_wins_regardless_of_list_order() {
        // GitHub returns releases newest-created first, which is not the same
        // as newest-version once a patch lands on an older line.
        let releases = vec![
            release_json("v1.9.1", false, true),
            release_json("v1.10.0", false, true),
            release_json("v1.2.0", false, true),
        ];
        let picked = pick_release(&releases, ReleaseChannel::Stable).expect("a release");
        assert_eq!(picked.version, "1.10.0");
    }

    #[test]
    fn the_stable_channel_never_sees_a_prerelease() {
        let releases = vec![
            release_json("v1.0.0", false, true),
            release_json("v2.0.0-rc1", true, true),
        ];
        assert_eq!(
            pick_release(&releases, ReleaseChannel::Stable)
                .expect("a release")
                .version,
            "1.0.0"
        );
        let beta = pick_release(&releases, ReleaseChannel::PreRelease).expect("a release");
        assert_eq!(beta.version, "2.0.0-rc1");
        assert!(beta.pre_release);
    }

    #[test]
    fn drafts_are_never_offered() {
        // Drafts are unpublished work visible to maintainers.
        let mut draft = release_json("v3.0.0", false, true);
        draft["draft"] = Value::Bool(true);
        let releases = vec![release_json("v1.0.0", false, true), draft];
        assert_eq!(
            pick_release(&releases, ReleaseChannel::PreRelease)
                .expect("a release")
                .version,
            "1.0.0"
        );
    }

    #[test]
    fn tags_that_are_not_versions_are_skipped_rather_than_sorted() {
        let releases = vec![
            release_json("nightly", false, true),
            release_json("latest", false, true),
            release_json("v0.3.0", false, true),
        ];
        assert_eq!(
            pick_release(&releases, ReleaseChannel::Stable)
                .expect("a release")
                .version,
            "0.3.0"
        );
    }

    #[test]
    fn a_release_without_an_asset_for_this_platform_is_still_announced() {
        // Java hides the install button and keeps the release-notes link; the
        // user is told a new version exists either way.
        let releases = vec![release_json("v0.4.0", false, false)];
        let picked = pick_release(&releases, ReleaseChannel::Stable).expect("a release");
        assert_eq!(picked.version, "0.4.0");
        assert!(!picked.is_installable());
        assert!(picked.notes_url.contains("0.4.0"));
    }

    #[test]
    fn an_empty_release_list_is_no_update_rather_than_an_error() {
        assert_eq!(pick_release(&[], ReleaseChannel::Stable), None);
    }

    #[test]
    fn the_notes_list_every_published_version_newest_first() {
        use faf_domain::protocol::changelog::{ChangelogBlock, ChangelogSpan};

        let mut draft = release_json("v9.0.0", false, true);
        draft["draft"] = Value::Bool(true);
        let mut newest = release_json("v0.10.0", true, true);
        newest["body"] = Value::String(
            "### Features\n\n- Replays can be filtered by map (#12).\n\n\
             Download the installer for your platform from the assets below.\n"
                .into(),
        );
        // A release published with nothing at all: GitHub sends `null`.
        let mut bare = release_json("v0.9.0", false, false);
        bare["published_at"] = Value::Null;
        bare["body"] = Value::Null;
        let releases = vec![bare, release_json("nightly", false, true), draft, newest];

        let notes = release_notes_from(&releases, "https://github.com/Org/Repo/issues");

        let versions: Vec<&str> = notes.iter().map(|n| n.version.as_str()).collect();
        assert_eq!(versions, ["0.10.0", "0.9.0"], "by version, not list order");
        assert!(notes[0].pre_release, "a prerelease is listed, and says so");
        assert_eq!(
            notes[0].notes_url,
            "https://github.com/Org/Repo/releases/tag/v0.10.0"
        );
        assert_eq!(
            notes[0].published_at.as_deref(),
            Some("2026-02-01T00:00:00Z")
        );
        assert_eq!(notes[0].blocks.len(), 2, "{:?}", notes[0].blocks);
        let ChangelogBlock::List { items } = &notes[0].blocks[1] else {
            panic!("expected the features list, got {:?}", notes[0].blocks[1]);
        };
        assert!(items[0].spans.contains(&ChangelogSpan::Issue {
            number: "12".into(),
            url: "https://github.com/Org/Repo/issues/12".into(),
        }));
        assert_eq!(notes[1].published_at, None);
        assert!(notes[1].blocks.is_empty());
    }

    #[test]
    fn a_release_published_as_required_says_so_in_its_notes() {
        use faf_domain::protocol::changelog::REQUIRED_UPDATE_LINE;
        let mut required = release_json("v0.10.0", false, true);
        required["body"] = Value::String(format!(
            "{REQUIRED_UPDATE_LINE}

### Bug fixes

- Fixed it.
"
        ));
        let notes = release_notes_from(
            &[required, release_json("v0.9.0", false, true)],
            "https://github.com/Org/Repo/issues",
        );
        assert!(notes[0].required);
        assert!(!notes[1].required);
    }

    /// A local release list that answers every request with `body` and counts
    /// how often it was asked.
    async fn serve_release_list(body: String) -> (String, Arc<std::sync::atomic::AtomicUsize>) {
        serve_release_list_after(body, std::time::Duration::ZERO).await
    }

    /// The same, answering each request only after `delay`, so a read can be
    /// caught while it is still on the way. A request is counted when it
    /// arrives, before the wait.
    async fn serve_release_list_after(
        body: String,
        delay: std::time::Duration,
    ) -> (String, Arc<std::sync::atomic::AtomicUsize>) {
        use std::sync::atomic::{AtomicUsize, Ordering as Atomic};
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test server");
        let base = format!("http://{}", listener.local_addr().expect("server address"));
        let requests = Arc::new(AtomicUsize::new(0));
        let counted = requests.clone();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let body = body.clone();
                let counted = counted.clone();
                tokio::spawn(async move {
                    let mut head = Vec::new();
                    let mut buffer = [0_u8; 1024];
                    while !head.windows(4).any(|window| window == b"\r\n\r\n") {
                        match socket.read(&mut buffer).await {
                            Ok(0) | Err(_) => return,
                            Ok(read) => head.extend_from_slice(&buffer[..read]),
                        }
                    }
                    counted.fetch_add(1, Atomic::SeqCst);
                    tokio::time::sleep(delay).await;
                    let reply = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\
                         Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = socket.write_all(reply.as_bytes()).await;
                });
            }
        });
        (base, requests)
    }

    #[tokio::test]
    async fn one_release_list_read_serves_the_check_and_the_notes() {
        use std::sync::atomic::Ordering as Atomic;

        let releases = serde_json::json!([
            release_json("v0.4.0", true, true),
            release_json("v0.3.0", true, true),
        ]);
        let (base, requests) = serve_release_list(releases.to_string()).await;
        let client = GitHubUpdates::new(ClientUpdateConfig {
            api_base: base.clone(),
            ..config()
        });

        // A check always reads the list fresh...
        let latest = client
            .latest(ReleaseChannel::PreRelease)
            .await
            .expect("a check");
        assert_eq!(
            latest.map(|release| release.version).as_deref(),
            Some("0.4.0")
        );
        assert_eq!(requests.load(Atomic::SeqCst), 1);
        // ...and the notes after it cost nothing: the same response answers.
        assert_eq!(
            client.cached_release_notes().map(|notes| notes.len()),
            Some(2)
        );
        let notes = client.release_notes().await.expect("notes");
        assert_eq!(notes.len(), 2);
        assert_eq!(requests.load(Atomic::SeqCst), 1, "no second request");

        client
            .latest(ReleaseChannel::PreRelease)
            .await
            .expect("a second check");
        assert_eq!(requests.load(Atomic::SeqCst), 2, "a check is never cached");

        // With nothing read yet, the notes ask for the list themselves, once.
        let cold = GitHubUpdates::new(ClientUpdateConfig {
            api_base: base,
            ..config()
        });
        assert_eq!(cold.cached_release_notes(), None);
        cold.release_notes().await.expect("notes");
        cold.release_notes().await.expect("notes again");
        assert_eq!(
            requests.load(Atomic::SeqCst),
            3,
            "the second answered from memory"
        );
    }

    #[tokio::test]
    async fn notes_asked_for_during_a_check_wait_for_its_read() {
        use std::sync::atomic::Ordering as Atomic;

        let releases = serde_json::json!([
            release_json("v0.4.0", true, true),
            release_json("v0.3.0", true, true),
        ]);
        let (base, requests) =
            serve_release_list_after(releases.to_string(), std::time::Duration::from_millis(200))
                .await;
        let client = Arc::new(GitHubUpdates::new(ClientUpdateConfig {
            api_base: base,
            ..config()
        }));

        // The startup check reads the list...
        let check = tokio::spawn({
            let client = client.clone();
            async move { client.latest(ReleaseChannel::PreRelease).await }
        });
        while requests.load(Atomic::SeqCst) == 0 {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        // ...and Client updates is opened while that read is on the way.
        let notes = client.release_notes().await.expect("notes");
        check.await.expect("the check ran").expect("a check");

        assert_eq!(notes.len(), 2);
        assert_eq!(
            requests.load(Atomic::SeqCst),
            1,
            "the notes waited for the check's read instead of reading again"
        );
    }

    #[test]
    fn only_release_assets_of_the_configured_repository_are_downloaded() {
        // The load-bearing check: whatever the API says, the installer has to
        // come from this repository over TLS.
        let client = GitHubUpdates::new(config());
        assert!(client
            .is_trusted("https://github.com/Org/Repo/releases/download/v1.0.0/faf-client.msi"));

        for hostile in [
            "http://github.com/Org/Repo/releases/download/v1.0.0/x.msi",
            "https://evil.invalid/Org/Repo/releases/download/v1.0.0/x.msi",
            "https://github.com/Other/Repo/releases/download/v1.0.0/x.msi",
            "https://github.com/Org/Repo/releases/download/../../../../Other/Repo/x.msi",
            "file:///C:/x.msi",
            "",
        ] {
            assert!(!client.is_trusted(hostile), "{hostile} must be refused");
        }
    }

    #[tokio::test]
    async fn update_notice_reuses_complete_installers_and_prunes_only_older_files() {
        let directory =
            std::env::temp_dir().join(format!("faf-update-reuse-{}", rand::random::<u64>()));
        tokio::fs::create_dir(&directory).await.unwrap();
        let target = directory.join("faf-client-1.0.0.exe");
        let old = directory.join("faf-client-0.9.0.exe");
        let unrelated = directory.join("keep.txt");
        let subdirectory = directory.join("faf-client-folder");
        tokio::fs::write(&target, b"whole").await.unwrap();
        tokio::fs::write(&old, b"older").await.unwrap();
        tokio::fs::write(&unrelated, b"keep").await.unwrap();
        tokio::fs::create_dir(&subdirectory).await.unwrap();
        let release = ClientRelease {
            version: "1.0.0".into(),
            size_bytes: 5,
            download_url: "https://github.invalid/installer".into(),
            ..Default::default()
        };
        let client = GitHubUpdates::new(config());
        let (tx, _rx) = mpsc::channel(4);
        let cancelled = CancellationToken::new();
        cancelled.cancel();
        // A cache hit succeeds even with the network path already cancelled.
        let path = client
            .run_download_to(&release, &tx, &cancelled, &target)
            .await
            .unwrap();
        assert_eq!(std::path::Path::new(&path), target);
        assert!(!old.exists());
        assert!(unrelated.exists());
        assert!(subdirectory.is_dir());
        for size_bytes in [4, 0] {
            let wrong_size = ClientRelease {
                size_bytes,
                ..release.clone()
            };
            assert_eq!(
                client
                    .run_download_to(&wrong_size, &tx, &cancelled, &target)
                    .await
                    .unwrap_err(),
                DOWNLOAD_CALLED_OFF
            );
        }
        tokio::fs::remove_dir_all(directory).await.unwrap();
    }

    #[tokio::test]
    async fn an_untrusted_download_url_never_reaches_the_network() {
        // If this reached `reqwest` it would resolve `evil.invalid` and fail
        // with a DNS error instead of the refusal.
        let client = GitHubUpdates::new(config());
        let (tx, _rx) = mpsc::channel(4);
        let release = ClientRelease {
            version: "1.0.0".into(),
            download_url: "https://evil.invalid/installer.exe".into(),
            asset_name: asset_name("faf-client"),
            ..ClientRelease::default()
        };
        let error = client
            .run_download(&release, &tx, &CancellationToken::new())
            .await
            .expect_err("must refuse");
        assert!(error.contains("refusing"), "got: {error}");
    }

    #[test]
    fn the_installer_path_comes_from_the_version_not_the_asset_name() {
        // A hostile asset name must not choose where the client writes the
        // file it is about to execute.
        let client = GitHubUpdates::new(config());
        let release = ClientRelease {
            version: "1.2.3".into(),
            asset_name: format!("../../../../evil{}", ASSET_SUFFIXES[0]),
            ..ClientRelease::default()
        };
        let path = client.installer_path(&release).expect("a path");
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        assert_eq!(name, format!("faf-client-1.2.3{}", ASSET_SUFFIXES[0]));
        assert!(!path.to_string_lossy().contains(".."));
    }

    #[test]
    fn an_asset_this_platform_cannot_run_has_no_installer_path() {
        let client = GitHubUpdates::new(config());
        let release = ClientRelease {
            version: "1.2.3".into(),
            asset_name: "faf-client.sources.zip".into(),
            ..ClientRelease::default()
        };
        assert!(client.installer_path(&release).is_err());
    }

    #[test]
    fn the_image_is_this_clients_when_it_runs_from_the_images_mount() {
        let image = OsStr::new("/home/p/Apps/FAForever.AppImage");
        let mount = OsStr::new("/tmp/.mount_FAForeY2");
        let executable = Path::new("/tmp/.mount_FAForeY2/usr/bin/faf-client");
        assert_eq!(
            appimage_of(Some(image), Some(mount), Some(executable)),
            Some(PathBuf::from("/home/p/Apps/FAForever.AppImage"))
        );
        assert_eq!(appimage_of(None, Some(mount), Some(executable)), None);
        assert_eq!(appimage_of(Some(image), None, Some(executable)), None);
        assert_eq!(
            appimage_of(Some(OsStr::new("")), Some(mount), Some(executable)),
            None
        );
        // A root or empty APPDIR would hold every executable there is.
        assert_eq!(
            appimage_of(Some(image), Some(OsStr::new("/")), Some(executable)),
            None
        );
        assert_eq!(
            appimage_of(Some(image), Some(OsStr::new("")), Some(executable)),
            None
        );
    }

    #[test]
    fn an_inherited_appimage_variable_never_names_another_programs_image() {
        // Started from a terminal inside an editor's AppImage: both variables
        // are the editor's.
        let editor = OsStr::new("/home/p/Apps/Editor.AppImage");
        let editor_mount = OsStr::new("/tmp/.mount_EditorX1");
        for executable in [
            // This client as its own AppImage would have had both variables
            // reset by its runtime, so this pairing means it is not one.
            "/tmp/.mount_FAForeY2/usr/bin/faf-client",
            // A .deb or .rpm install.
            "/usr/bin/faf-client",
        ] {
            assert_eq!(
                appimage_of(
                    Some(editor),
                    Some(editor_mount),
                    Some(Path::new(executable))
                ),
                None,
                "{executable}"
            );
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn an_appimage_update_replaces_the_installed_file_atomically() {
        use std::os::unix::fs::PermissionsExt as _;

        let download_dir = tempfile::tempdir().expect("download directory");
        let install_dir = tempfile::tempdir().expect("install directory");
        let downloaded = download_dir.path().join("faf-client-2.0.0.AppImage");
        let installed = install_dir.path().join("FAForever.AppImage");
        std::fs::write(&downloaded, b"new appimage").expect("downloaded image");
        std::fs::write(&installed, b"old appimage").expect("installed image");

        replace_appimage(&downloaded, &installed).expect("replace the image");

        assert_eq!(std::fs::read(&installed).unwrap(), b"new appimage");
        assert_eq!(
            std::fs::metadata(&installed).unwrap().permissions().mode() & 0o777,
            0o755
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_failed_appimage_copy_leaves_the_installed_file_untouched() {
        let directory = tempfile::tempdir().expect("install directory");
        let downloaded = directory.path().join("missing.AppImage");
        let installed = directory.path().join("FAForever.AppImage");
        std::fs::write(&installed, b"old appimage").expect("installed image");

        assert!(replace_appimage(&downloaded, &installed).is_err());
        assert_eq!(std::fs::read(&installed).unwrap(), b"old appimage");
    }

    #[tokio::test]
    async fn the_fake_reports_no_update_and_refuses_to_install() {
        let fake = FakeClientUpdates;
        assert_eq!(fake.latest(ReleaseChannel::Stable).await, Ok(None));
        assert!(fake.install("whatever".into()).await.is_err());
        assert!(fake.release_notes().await.is_err(), "no invented notes");
        assert_eq!(fake.cached_release_notes(), None);
    }
}
