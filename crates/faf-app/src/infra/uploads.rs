//! Publishing a map or mod to the vault.
//!
//! Zip the installed folder, then send it: but by two different routes,
//! because the server offers two:
//!
//! **Maps**: one multipart request, mirroring Java's `MapUploadTask`. Both
//! parts are typed, because Spring binds them by their own content type and
//! reads an untyped part as `application/octet-stream`:
//!
//! ```text
//! POST {api}/maps/upload      multipart/form-data
//!   file     = <archive>            Content-Type: application/zip
//!   metadata = {"isRanked": <bool>} Content-Type: application/json
//! ```
//!
//! **Mods**: a three-step handshake with object storage, mirroring Java's
//! `ModUploadTask`. The middle step does not touch FAF at all, and must not
//! carry the FAF bearer token: the URL is already signed, and forwarding
//! credentials to a third-party host is not something to do by accident.
//!
//! ```text
//! GET  {api}/mods/upload/start      -> { uploadUrl, requestId }
//! PUT  <uploadUrl>                  Content-Type: application/zip
//! POST {api}/mods/upload/complete   {"requestId": "<uuid>"}
//! ```

use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};

use async_trait::async_trait;
use faf_domain::protocol::mod_info;
use faf_domain::state::{is_safe_folder_name, UploadKind, UploadRequest, UploadStatus};
use serde_json::Value;
use tokio::io::AsyncReadExt as _;
use tokio::sync::mpsc;

use crate::infra::http::{
    describe_transport_error, UploadWatch, REQUEST_DEADLINE, TRANSFER_STALL_TIMEOUT,
    UPLOAD_RESPONSE_DEADLINE,
};
use crate::infra::jsonapi::api_error_detail;
use crate::infra::session::TokenStore;
use crate::infra::{cache_dir, env_or};
use crate::ports::UploadsPort;
use tokio_util::sync::CancellationToken;

/// Refuse anything larger than this before contacting the server.
///
/// The vault rejects oversized archives anyway, but only after the whole thing
/// has been uploaded: which on a domestic connection is a long wait ending in
/// a rejection. Generous enough for any real map or mod.
const MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct UploadsConfig {
    pub api_base: String,
}

impl UploadsConfig {
    pub fn faf() -> Self {
        Self {
            api_base: env_or("FAF_API_BASE", "https://api.faforever.com"),
        }
    }
}

pub struct UploadsClient {
    config: UploadsConfig,
    tokens: TokenStore,
    http: reqwest::Client,
    /// The running publish's call-off, raised by `cancel_publish`. Replaced
    /// by every publish, so a cancel meant for an earlier one cannot stop the
    /// next.
    publishing: std::sync::Mutex<Option<CancellationToken>>,
}

impl UploadsClient {
    pub fn new(config: UploadsConfig, tokens: TokenStore) -> Self {
        Self {
            config,
            tokens,
            // Not the shared client: see `upload_http_client` for why an
            // upload cannot use its read timeout.
            http: super::http::upload_http_client(),
            publishing: std::sync::Mutex::new(None),
        }
    }

    pub fn faf(tokens: TokenStore) -> Self {
        Self::new(UploadsConfig::faf(), tokens)
    }
}

#[async_trait]
impl UploadsPort for UploadsClient {
    async fn map_preview(&self, request: UploadRequest) -> String {
        if request.kind != UploadKind::Map {
            return String::new();
        }
        // Off the runtime: opening a file, reading a quarter of a megabyte and
        // building a PNG out of it is not work for an async worker.
        tokio::task::spawn_blocking(move || read_map_preview(&request).unwrap_or_default())
            .await
            .unwrap_or_default()
    }

    async fn subject_name(&self, request: UploadRequest) -> Option<String> {
        tokio::task::spawn_blocking(move || read_subject_name(&request))
            .await
            .ok()
            .flatten()
    }

    async fn publish(&self, request: UploadRequest) -> mpsc::Receiver<UploadStatus> {
        let (tx, rx) = mpsc::channel(16);
        let config = self.config.clone();
        let tokens = self.tokens.clone();
        let http = self.http.clone();
        // Replaces the last publish's call-off, which is long finished: the
        // command policy runs one publish at a time.
        let called_off = CancellationToken::new();
        *self
            .publishing
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(called_off.clone());

        tokio::spawn(async move {
            let outcome = run(&config, &tokens, &http, &request, &tx, &called_off).await;
            let _ = tx
                .send(match outcome {
                    Ok(RunEnd::Published) => UploadStatus::Succeeded,
                    // Nothing was published, and nothing failed.
                    Ok(RunEnd::CalledOff) => UploadStatus::Idle,
                    Err(reason) => UploadStatus::Failed { reason },
                })
                .await;
        });

        rx
    }

    fn cancel_publish(&self) {
        if let Some(publishing) = self
            .publishing
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
        {
            publishing.cancel();
        }
    }
}

/// How a publish that did not fail ended.
#[derive(Debug, PartialEq, Eq)]
enum RunEnd {
    Published,
    /// `cancel_publish` landed while the vault could not have the archive
    /// yet. Nothing was published, and the temporary archive is gone.
    CalledOff,
}

/// Arbitrate the last cancellable step against a concurrent Stop. A body
/// polled by the HTTP task after cancellation must not complete the archive.
#[derive(Default)]
struct UploadCommitment(std::sync::atomic::AtomicU8);

impl UploadCommitment {
    const CANCELLABLE: u8 = 0;
    const COMMITTED: u8 = 1;
    const CANCELLED: u8 = 2;

    fn commit(&self) -> bool {
        self.0
            .compare_exchange(
                Self::CANCELLABLE,
                Self::COMMITTED,
                std::sync::atomic::Ordering::SeqCst,
                std::sync::atomic::Ordering::SeqCst,
            )
            .is_ok()
            || self.0.load(std::sync::atomic::Ordering::SeqCst) == Self::COMMITTED
    }

    /// True when stopping can still prevent publication.
    fn cancel(&self) -> bool {
        self.0
            .compare_exchange(
                Self::CANCELLABLE,
                Self::CANCELLED,
                std::sync::atomic::Ordering::SeqCst,
                std::sync::atomic::Ordering::SeqCst,
            )
            .is_ok()
            || self.is_cancelled()
    }

    fn is_cancelled(&self) -> bool {
        self.0.load(std::sync::atomic::Ordering::SeqCst) == Self::CANCELLED
    }
}

/// A temporary archive, deleted when this goes out of scope, which includes a
/// publish called off part-way through being sent.
///
/// Rust opens files with delete sharing on Windows too, so the deletion goes
/// through even while the request that was reading the file is still being
/// torn down.
struct TemporaryArchive(PathBuf);

impl Drop for TemporaryArchive {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Zip the folder and send it, unless `called_off` is cancelled first.
///
/// A call-off stops the run while the archive is packed (see `zip_folder`)
/// and while its bytes are still going out: the request is dropped in the
/// middle of its body, which the server discards. `committed` is raised once
/// the server could have the whole archive, the last byte of a map taken by
/// the transport or a mod's storage upload about to be confirmed, and from
/// there a call-off is ignored: stopping could no longer keep the archive out
/// of the vault, only stop the client hearing whether it got in.
///
/// The final map chunk and cancellation share one atomic transition: a stop
/// that wins prevents that chunk being yielded, even if the HTTP task is
/// still polling the body while its request future is being dropped.
async fn run(
    config: &UploadsConfig,
    tokens: &TokenStore,
    http: &reqwest::Client,
    request: &UploadRequest,
    tx: &mpsc::Sender<UploadStatus>,
    called_off: &CancellationToken,
) -> Result<RunEnd, String> {
    let token = tokens.get().ok_or_else(|| "not logged in".to_string())?;

    let source = source_folder(request)?;
    let Some(archive) = zip_folder(&source, request.kind, rename(request), tx, called_off).await?
    else {
        return Ok(RunEnd::CalledOff);
    };

    let committed = std::sync::Arc::new(UploadCommitment::default());
    let sending = send(config, http, &token, request, &archive.0, tx, &committed);
    // `sending` is dropped inside, before `archive` goes at the end of this
    // scope: the request lets go of the file before the file is deleted.
    send_unless_called_off(sending, &committed, called_off).await
}

/// Drive `sending` to its end, unless `called_off` is cancelled while
/// `committed` is still down: then drop it there, which tears the request
/// down mid-body, and say so.
async fn send_unless_called_off(
    sending: impl std::future::Future<Output = Result<(), String>>,
    committed: &UploadCommitment,
    called_off: &CancellationToken,
) -> Result<RunEnd, String> {
    tokio::pin!(sending);
    tokio::select! {
        biased;
        () = called_off.cancelled() => {}
        result = &mut sending => return result.map(|()| RunEnd::Published),
    }
    if !committed.cancel() {
        // Too late to keep it out of the vault: see it through.
        return sending.await.map(|()| RunEnd::Published);
    }
    Ok(RunEnd::CalledOff)
}

/// The `.scmap` inside the folder being published, read into a data URL.
///
/// The folder goes through the same `source_folder` the publish does, so a name
/// that could not be published cannot be read from either. Exactly one `.scmap`
/// is expected at the top level, which is what a map folder is; anything else
/// yields no picture rather than a guess at which file was meant.
fn read_map_preview(request: &UploadRequest) -> Result<String, String> {
    let folder = source_folder(request)?;
    let mut found: Option<PathBuf> = None;
    for entry in std::fs::read_dir(&folder)
        .map_err(|error| format!("could not read the map folder: {error}"))?
        .flatten()
    {
        let path = entry.path();
        let is_scmap = path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("scmap"));
        if !is_scmap {
            continue;
        }
        if found.is_some() {
            return Err("the folder holds more than one map file".to_string());
        }
        found = Some(path);
    }
    let scmap = found.ok_or_else(|| "the folder holds no map file".to_string())?;
    crate::infra::scmap::preview_data_url(&scmap)
}

/// Resolve, and validate, the folder being published.
fn source_folder(request: &UploadRequest) -> Result<PathBuf, String> {
    let picked = request.source_path.is_some();
    // Checked here as well as in the service: this is the last point before a
    // directory is read and its contents published, and the name may have
    // arrived from anywhere.
    let folder = match request.source_path.as_deref() {
        // Picked from disk. The name guard exists to stop a *name* from
        // escaping our maps/mods directory; here nothing is joined to anything
        // and the native dialog is the user's own authorisation, which is what
        // Java's `MapUploadController.setMapPath` relies on too.
        Some(path) => {
            let path = PathBuf::from(path);
            if !path.is_absolute() {
                return Err("the chosen folder must be an absolute path".to_string());
            }
            path
        }
        None => match request.kind {
            UploadKind::Map => {
                if !is_safe_folder_name(&request.folder_name) {
                    return Err(format!(
                        "“{}” is not a folder name that can be published",
                        request.folder_name
                    ));
                }
                crate::infra::maps::maps_dir().join(&request.folder_name)
            }
            UploadKind::Mod => crate::infra::mods::safe_mod_target(
                &crate::infra::mods::mods_dir(),
                &request.folder_name,
            )?,
        },
    };
    let metadata = std::fs::symlink_metadata(&folder).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            format!("{} is not installed locally", request.display_name)
        } else {
            format!("could not inspect {}: {error}", folder.display())
        }
    })?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "{} is a symbolic link and cannot be published",
            request.display_name
        ));
    }
    if !metadata.is_dir() {
        return Err(format!("{} is not installed locally", request.display_name));
    }
    // Only for a picked folder: an installed one came from our own installer
    // and is known to be the right shape. Java gets this check for free by
    // parsing the map before it will offer the upload button; without it the
    // vault accepts the archive and is left holding a broken entry.
    if picked {
        looks_like(&folder, request.kind)?;
    }
    Ok(folder)
}

/// Refuse a folder that plainly is not a map or mod folder.
/// See [`UploadsPort::subject_name`].
///
/// Reads the same file the vault will: a mod's root `mod_info.lua`, or the
/// map's `_scenario.lua`. A folder that fails [`source_folder`]'s checks has no
/// name worth showing, since it will not be published either.
fn read_subject_name(request: &UploadRequest) -> Option<String> {
    let folder = source_folder(request).ok()?;
    let name = match request.kind {
        UploadKind::Mod => {
            let contents = std::fs::read_to_string(folder.join("mod_info.lua")).ok()?;
            crate::infra::mods::mod_info_name(&contents)?
        }
        UploadKind::Map => {
            let scenario = std::fs::read_dir(&folder).ok()?.flatten().find(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .to_ascii_lowercase()
                    .ends_with("_scenario.lua")
            })?;
            let contents = std::fs::read_to_string(scenario.path()).ok()?;
            crate::infra::maps::parse_scenario_lua(&contents).name?
        }
    };
    let name = name.trim();
    (!name.is_empty()).then(|| name.to_string())
}

fn looks_like(folder: &Path, kind: UploadKind) -> Result<(), String> {
    let entries = std::fs::read_dir(folder)
        .map_err(|error| format!("could not read {}: {error}", folder.display()))?;
    let found = entries.flatten().any(|entry| {
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        match kind {
            UploadKind::Map => name.ends_with(".scmap"),
            UploadKind::Mod => name == "mod_info.lua",
        }
    });
    if found {
        return Ok(());
    }
    Err(match kind {
        UploadKind::Map => {
            "that folder holds no .scmap file, so it is not a map folder".to_string()
        }
        UploadKind::Mod => {
            "that folder holds no mod_info.lua, so it is not a mod folder".to_string()
        }
    })
}

/// Whether this archive entry is the mod's own `mod_info.lua`.
///
/// Only the one at the archive root: a mod that ships an example folder with
/// its own `mod_info.lua` must not have that one renamed instead.
fn is_root_mod_info(archive_name: &str) -> bool {
    let mut parts = archive_name.split('/');
    let (Some(_root), Some(file), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    file.eq_ignore_ascii_case("mod_info.lua")
}

/// A name safe to put in a multipart header.
///
/// An installed folder's name has already passed `is_safe_folder_name`; a
/// picked one has not, and the vault only cares that the part is a `.zip`.
fn archive_file_name(folder_name: &str) -> String {
    let cleaned: String = folder_name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "upload".to_string()
    } else {
        cleaned
    }
}

/// Zip `source` into a temporary archive, with the folder itself as the single
/// top-level entry: the shape the vault expects, and the same shape our own
/// installer reads back (see `infra::maps::extract_zip`).
/// The rename to apply while archiving, with the fresh uid it needs.
///
/// Generated here rather than in the domain because randomness is a side
/// effect, and generated per publish because reusing one is the single thing
/// the vault will reject.
fn rename(request: &UploadRequest) -> Option<Rename> {
    let name = request.rename_to.trim();
    if name.is_empty() || request.kind != UploadKind::Mod {
        return None;
    }
    Some(Rename {
        name: name.to_string(),
        uid: fresh_uid(),
    })
}

/// A version 4 UUID, which is what the mods in the vault carry as their uid.
fn fresh_uid() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    // The version and variant nibbles, so this is a well-formed v4 rather than
    // 32 random hex characters that happen to be the right length.
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// What a publish-under-a-new-name substitutes into the archive.
#[derive(Debug, Clone)]
struct Rename {
    name: String,
    uid: String,
}

/// The folder's total size in bytes, for the compression bar to divide by.
///
/// Best effort: an entry that cannot be read contributes nothing rather than
/// failing the walk, since `write_archive` is about to visit the same tree and
/// is the right place to report a real problem. A folder that measures zero
/// simply leaves the bar indeterminate.
fn folder_bytes(source: &Path, called_off: &CancellationToken) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![source.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if called_off.is_cancelled() {
            break;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if called_off.is_cancelled() {
                break;
            }
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                stack.push(entry.path());
            } else if file_type.is_file() {
                total += entry.metadata().map(|meta| meta.len()).unwrap_or(0);
            }
        }
    }
    total
}

async fn zip_folder(
    source: &Path,
    kind: UploadKind,
    rename: Option<Rename>,
    tx: &mpsc::Sender<UploadStatus>,
    called_off: &CancellationToken,
) -> Result<Option<TemporaryArchive>, String> {
    let source = source.to_path_buf();
    let target = cache_dir()?.join(format!(
        "upload-{}-{}.zip",
        kind.label(),
        std::process::id()
    ));
    zip_to(source, target, rename, tx, called_off).await
}

async fn zip_to(
    source: PathBuf,
    target: PathBuf,
    rename: Option<Rename>,
    tx: &mpsc::Sender<UploadStatus>,
    called_off: &CancellationToken,
) -> Result<Option<TemporaryArchive>, String> {
    let guard = called_off.clone().drop_guard();
    tokio::fs::create_dir_all(target.parent().unwrap_or(Path::new(".")))
        .await
        .map_err(|error| format!("could not create the cache directory: {error}"))?;
    // Make the size walk cancellable too, with an indeterminate bar until measured.
    let _ = tx
        .send(UploadStatus::Compressing {
            done_bytes: 0,
            total_bytes: 0,
        })
        .await;
    let progress = tx.clone();
    let cancellation = called_off.clone();
    // Keep ownership until the blocking worker has stopped and cleaned up.
    // Returning Idle earlier would let its progress overwrite cancellation,
    // or let the next publish reuse an archive the old worker is still writing.
    let packed = tokio::task::spawn_blocking(move || {
        let total_bytes = clamp_bytes(folder_bytes(&source, &cancellation));
        if cancellation.is_cancelled() {
            return Ok(None);
        }
        let archive = TemporaryArchive(target);
        let _ = progress.try_send(UploadStatus::Compressing {
            done_bytes: 0,
            total_bytes,
        });
        let written = write_archive(
            &source,
            &archive.0,
            rename.as_ref(),
            &|done| {
                let _ = progress.try_send(UploadStatus::Compressing {
                    done_bytes: clamp_bytes(done),
                    total_bytes,
                });
            },
            &cancellation,
        );
        if cancellation.is_cancelled() {
            return Ok(None);
        }
        written.map(|()| Some(archive))
    })
    .await
    .map_err(|error| format!("compression task failed: {error}"))?;
    guard.disarm();
    let Some(archive) = packed? else {
        return Ok(None);
    };
    if called_off.is_cancelled() {
        return Ok(None);
    }
    let size = tokio::fs::metadata(&archive.0)
        .await
        .map_err(|error| format!("could not read the archive: {error}"))?
        .len();
    if size > MAX_ARCHIVE_BYTES {
        return Err(format!(
            "the archive is {} MB, over the {} MB limit",
            size / (1024 * 1024),
            MAX_ARCHIVE_BYTES / (1024 * 1024)
        ));
    }
    Ok(Some(archive))
}

/// Byte counts cross the IPC boundary as `u32`, and the archive limit is far
/// below that ceiling; saturating is still better than wrapping a folder that
/// somehow measures more.
fn clamp_bytes(value: u64) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

fn write_archive(
    source: &Path,
    target: &Path,
    rename: Option<&Rename>,
    on_progress: &dyn Fn(u64),
    called_off: &CancellationToken,
) -> Result<(), String> {
    let mut renamed = false;
    let mut packed = 0u64;
    let root_name = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "the folder has no usable name".to_string())?
        .to_string();

    let file = std::fs::File::create(target)
        .map_err(|error| format!("could not create the archive: {error}"))?;
    let mut writer = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    let mut stack = vec![source.to_path_buf()];
    let mut wrote_anything = false;
    let mut buffer = [0u8; 64 * 1024];
    while let Some(dir) = stack.pop() {
        if called_off.is_cancelled() {
            return Err("upload cancelled".into());
        }
        let entries = std::fs::read_dir(&dir)
            .map_err(|error| format!("could not read {}: {error}", dir.display()))?;
        for entry in entries {
            if called_off.is_cancelled() {
                return Err("upload cancelled".into());
            }
            let entry = entry.map_err(|error| format!("could not read an entry: {error}"))?;
            let path = entry.path();
            let file_type = entry
                .file_type()
                .map_err(|error| format!("could not inspect {}: {error}", path.display()))?;
            if file_type.is_symlink() {
                return Err(format!(
                    "symbolic links cannot be published: {}",
                    path.display()
                ));
            }
            let relative = path
                .strip_prefix(source)
                .map_err(|_| "an entry escaped the folder".to_string())?;
            // Zip paths are always forward-slashed, regardless of platform.
            let name = format!("{root_name}/{}", relative.display()).replace('\\', "/");

            if file_type.is_dir() {
                writer
                    .add_directory(format!("{name}/"), options)
                    .map_err(|error| format!("could not add {name}: {error}"))?;
                stack.push(path);
            } else if file_type.is_file() {
                writer
                    .start_file(&name, options)
                    .map_err(|error| format!("could not add {name}: {error}"))?;
                // Only the root mod metadata needs a rewrite; ordinary files
                // stream through a bounded buffer and check cancellation per chunk.
                if let Some(rename) = rename.filter(|_| !renamed && is_root_mod_info(&name)) {
                    let source_text = std::fs::read_to_string(&path)
                        .map_err(|error| format!("could not read mod_info.lua: {error}"))?;
                    if called_off.is_cancelled() {
                        return Err("upload cancelled".into());
                    }
                    let bytes = mod_info::rename_mod_info(&source_text, &rename.name, &rename.uid)
                        .into_bytes();
                    writer
                        .write_all(&bytes)
                        .map_err(|error| format!("could not write {name}: {error}"))?;
                    packed += bytes.len() as u64;
                    on_progress(packed);
                    renamed = true;
                } else {
                    let mut file = std::fs::File::open(&path)
                        .map_err(|error| format!("could not read {name}: {error}"))?;
                    loop {
                        if called_off.is_cancelled() {
                            return Err("upload cancelled".into());
                        }
                        let read = file
                            .read(&mut buffer)
                            .map_err(|error| format!("could not read {name}: {error}"))?;
                        if read == 0 {
                            break;
                        }
                        writer
                            .write_all(&buffer[..read])
                            .map_err(|error| format!("could not write {name}: {error}"))?;
                        packed += read as u64;
                        on_progress(packed);
                    }
                }
                wrote_anything = true;
            } else {
                return Err(format!(
                    "unsupported filesystem entry cannot be published: {}",
                    path.display()
                ));
            }
        }
    }

    if !wrote_anything {
        return Err("that folder is empty".to_string());
    }
    if rename.is_some() && !renamed {
        // Publishing the folder unchanged under a new title would put an entry
        // in the vault whose own file still calls it something else, and whose
        // uid is one the vault already holds.
        return Err("that folder holds no mod_info.lua, so it cannot be renamed".to_string());
    }
    if called_off.is_cancelled() {
        return Err("upload cancelled".into());
    }
    writer
        .finish()
        .map_err(|error| format!("could not finish the archive: {error}"))?;
    Ok(())
}

async fn send(
    config: &UploadsConfig,
    http: &reqwest::Client,
    token: &str,
    request: &UploadRequest,
    archive: &Path,
    tx: &mpsc::Sender<UploadStatus>,
    committed: &std::sync::Arc<UploadCommitment>,
) -> Result<(), String> {
    let total_bytes = tokio::fs::metadata(archive)
        .await
        .map_err(|error| format!("could not read the archive: {error}"))?
        .len();

    let _ = tx
        .send(UploadStatus::Uploading {
            sent_bytes: 0,
            total_bytes: clamp(total_bytes),
        })
        .await;

    match request.kind {
        UploadKind::Map => {
            upload_map(
                config,
                http,
                token,
                request,
                archive,
                total_bytes,
                tx,
                committed,
            )
            .await?
        }
        UploadKind::Mod => {
            upload_mod(config, http, token, archive, total_bytes, tx, committed).await?
        }
    }

    let _ = tx
        .send(UploadStatus::Uploading {
            sent_bytes: clamp(total_bytes),
            total_bytes: clamp(total_bytes),
        })
        .await;
    Ok(())
}

fn clamp(bytes: u64) -> u32 {
    u32::try_from(bytes).unwrap_or(u32::MAX)
}

/// The archive as a request body: read from disk as it is sent, counting what
/// has gone out.
///
/// This is Java's `CountingFileSystemResource`. The file is streamed rather
/// than loaded, so a 300 MB map is never held in memory, and every read moves
/// the progress bar. The stream yields exactly `total_bytes`, which is what
/// lets both callers declare a `Content-Length`.
///
/// Each chunk the transport takes is reported to `watch`, which is what lets
/// a stalled upload be told apart from a slow one.
///
/// `committed`, when given, is raised with the last byte: from there the
/// server can have the whole archive, and a publish is no longer called off
/// (see `run`).
fn counting_body(
    file: tokio::fs::File,
    total_bytes: u64,
    tx: mpsc::Sender<UploadStatus>,
    watch: UploadWatch,
    committed: std::sync::Arc<UploadCommitment>,
    commit_on_last_byte: bool,
) -> reqwest::Body {
    reqwest::Body::wrap_stream(upload_body_stream(
        file,
        total_bytes,
        tx,
        watch,
        committed,
        commit_on_last_byte,
    ))
}

fn upload_body_stream(
    file: tokio::fs::File,
    total_bytes: u64,
    tx: mpsc::Sender<UploadStatus>,
    watch: UploadWatch,
    committed: std::sync::Arc<UploadCommitment>,
    commit_on_last_byte: bool,
) -> impl futures_util::Stream<Item = std::io::Result<Vec<u8>>> {
    use futures_util::StreamExt as _;

    if total_bytes == 0 {
        if commit_on_last_byte {
            committed.commit();
        }
        watch.body_sent();
    }
    let mut sent = 0_u64;
    let progress = tx.clone();
    counting_stream(file, total_bytes, tx).map(move |chunk| {
        if committed.is_cancelled() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "upload cancelled",
            ));
        }
        if let Ok(chunk) = &chunk {
            sent += chunk.len() as u64;
        }
        if sent >= total_bytes {
            // Cancellation and the final chunk compete for one transition.
            // If Stop won, the transport receives an error instead of that chunk.
            if commit_on_last_byte && !committed.commit() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::Interrupted,
                    "upload cancelled",
                ));
            }
            if commit_on_last_byte {
                let _ = progress.try_send(UploadStatus::Uploading {
                    sent_bytes: clamp(total_bytes),
                    total_bytes: clamp(total_bytes),
                });
            }
            watch.body_sent();
        } else {
            watch.progressed();
        }
        chunk
    })
}

/// The chunks `counting_body` sends, separated out so a test can drain them
/// without a socket.
fn counting_stream(
    file: tokio::fs::File,
    total_bytes: u64,
    tx: mpsc::Sender<UploadStatus>,
) -> impl futures_util::Stream<Item = std::io::Result<Vec<u8>>> {
    /// Close enough to Java's copy buffer; the wire does the pacing.
    const CHUNK: usize = 64 * 1024;
    /// A progress event per chunk would be thousands of them for one map.
    const REPORT_EVERY: u64 = 512 * 1024;

    struct Progress {
        file: tokio::fs::File,
        sent: u64,
        reported: u64,
        total: u64,
        tx: mpsc::Sender<UploadStatus>,
    }

    futures_util::stream::try_unfold(
        Progress {
            file,
            sent: 0,
            reported: 0,
            total: total_bytes,
            tx,
        },
        |mut progress| async move {
            let mut buffer = vec![0u8; CHUNK];
            let read = progress.file.read(&mut buffer).await?;
            if read == 0 {
                return Ok::<_, std::io::Error>(None);
            }
            buffer.truncate(read);
            progress.sent += read as u64;
            if progress.sent - progress.reported >= REPORT_EVERY {
                progress.reported = progress.sent;
                // Dropped rather than awaited: a full channel means the UI is
                // behind, and a coarser bar beats a stalled upload.
                let _ = progress.tx.try_send(UploadStatus::Uploading {
                    sent_bytes: clamp(progress.sent.min(progress.total.saturating_sub(1))),
                    total_bytes: clamp(progress.total),
                });
            }
            Ok(Some((buffer, progress)))
        },
    )
}

/// One multipart request, part for part what `MapUploadTask` sends.
///
/// Both parts carry a content type, and the metadata one has to: the endpoint
/// binds it with `@RequestPart MapUploadMetadata`, which picks a converter by
/// the part's own content type. A part sent without one counts as
/// `application/octet-stream`, and the request is then refused before the
/// handler runs, with `Content-Type 'application/octet-stream' is not
/// supported`.
#[allow(clippy::too_many_arguments)]
async fn upload_map(
    config: &UploadsConfig,
    http: &reqwest::Client,
    token: &str,
    request: &UploadRequest,
    archive: &Path,
    total_bytes: u64,
    tx: &mpsc::Sender<UploadStatus>,
    committed: &std::sync::Arc<UploadCommitment>,
) -> Result<(), String> {
    let file = tokio::fs::File::open(archive)
        .await
        .map_err(|error| format!("could not read the archive: {error}"))?;

    // The length is declared so the whole multipart body gets a
    // `Content-Length`: the vault's gateway will not take a chunked upload.
    // The last byte of it commits the publish: the map is one request, and
    // the server takes it as soon as it has all of it.
    let watch = UploadWatch::new();
    let part = reqwest::multipart::Part::stream_with_length(
        counting_body(
            file,
            total_bytes,
            tx.clone(),
            watch.clone(),
            committed.clone(),
            true,
        ),
        total_bytes,
    )
    // The server reads the extension off this name and only accepts `.zip`.
    .file_name(format!("{}.zip", archive_file_name(&request.folder_name)))
    .mime_str("application/zip")
    .map_err(|error| format!("could not build the upload: {error}"))?;

    let metadata = reqwest::multipart::Part::text(
        serde_json::json!({ "isRanked": request.ranked }).to_string(),
    )
    .mime_str("application/json")
    .map_err(|error| format!("could not build the upload: {error}"))?;

    let form = reqwest::multipart::Form::new()
        .part("file", part)
        .part("metadata", metadata);

    let upload = async {
        let response = http
            .post(format!("{}/maps/upload", config.api_base))
            .bearer_auth(token)
            .header(reqwest::header::ACCEPT, "application/json")
            .multipart(form)
            .send()
            .await
            .map_err(|error| format!("upload failed: {}", describe_transport_error(&error)))?;
        check_upload(response, "the map upload", total_bytes).await
    };
    watch
        .guard(TRANSFER_STALL_TIMEOUT, UPLOAD_RESPONSE_DEADLINE, upload)
        .await
        .map_err(|stalled| stalled.to_string())?
}

async fn upload_mod(
    config: &UploadsConfig,
    http: &reqwest::Client,
    token: &str,
    archive: &Path,
    total_bytes: u64,
    tx: &mpsc::Sender<UploadStatus>,
    committed: &std::sync::Arc<UploadCommitment>,
) -> Result<(), String> {
    // 1. Ask FAF where to put it.
    let response = http
        .get(format!("{}/mods/upload/start", config.api_base))
        .bearer_auth(token)
        .header(reqwest::header::ACCEPT, "application/json")
        .timeout(REQUEST_DEADLINE)
        .send()
        .await
        .map_err(|error| {
            format!(
                "could not start the upload: {}",
                describe_transport_error(&error)
            )
        })?;
    let body = check_body(response, "starting the mod upload").await?;
    let start: Value =
        serde_json::from_str(&body).map_err(|error| format!("invalid response: {error}"))?;
    let upload_url = start
        .get("uploadUrl")
        .and_then(Value::as_str)
        .ok_or_else(|| "the server did not return an upload URL".to_string())?;
    let request_id = start
        .get("requestId")
        .and_then(Value::as_str)
        .ok_or_else(|| "the server did not return a request id".to_string())?
        .to_string();

    // 2. PUT straight to storage. Deliberately *no* bearer auth: the URL
    //    carries its own signature, and this host is not FAF.
    let file = tokio::fs::File::open(archive)
        .await
        .map_err(|error| format!("could not read the archive: {error}"))?;
    let watch = UploadWatch::new();
    let store = async {
        let stored = http
            .put(upload_url)
            .header(reqwest::header::ACCEPT, "application/json")
            .header(reqwest::header::CONTENT_TYPE, "application/zip")
            // Set by hand because the body is a stream: object storage rejects
            // a chunked PUT, and the signature covers the declared length.
            .header(reqwest::header::CONTENT_LENGTH, total_bytes)
            // Not the commitment: an archive in storage that FAF was never
            // told about is not published, so the storage upload can still
            // be called off after its last byte.
            .body(counting_body(
                file,
                total_bytes,
                tx.clone(),
                watch.clone(),
                committed.clone(),
                false,
            ))
            .send()
            .await
            .map_err(|error| {
                format!(
                    "could not upload the archive: {}",
                    describe_transport_error(&error)
                )
            })?;
        check_upload(stored, "the archive upload", total_bytes).await
    };
    watch
        .guard(TRANSFER_STALL_TIMEOUT, UPLOAD_RESPONSE_DEADLINE, store)
        .await
        .map_err(|stalled| stalled.to_string())??;

    // 3. Tell FAF it landed. Until this, the upload does not exist as far as
    //    the vault is concerned, and from here a call-off is too late.
    if !committed.commit() {
        return Err("upload cancelled".into());
    }
    let _ = tx.send(UploadStatus::Finishing).await;
    let completed = http
        .post(format!("{}/mods/upload/complete", config.api_base))
        .bearer_auth(token)
        .header(reqwest::header::ACCEPT, "application/json")
        // The three fields `ModUploadMetadata` carries. The other two stay
        // null until the dialog can ask for them, as they do in Java.
        .json(&serde_json::json!({
            "requestId": request_id,
            "licenseId": Value::Null,
            "repositoryUrl": Value::Null,
        }))
        .timeout(REQUEST_DEADLINE)
        .send()
        .await
        .map_err(|error| {
            format!(
                "could not complete the upload: {}",
                describe_transport_error(&error)
            )
        })?;
    check(completed, "completing the mod upload").await
}

async fn check(response: reqwest::Response, what: &str) -> Result<(), String> {
    check_body(response, what).await.map(|_| ())
}

/// Fail with the server's own wording where there is any.
async fn check_body(response: reqwest::Response, what: &str) -> Result<String, String> {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if status.is_success() {
        return Ok(body);
    }
    Err(explain(status, &body, what, None))
}

/// As `check`, but able to say how big the archive was: of the rejections a
/// publish can draw, the one about its size is the one the user can act on.
async fn check_upload(
    response: reqwest::Response,
    what: &str,
    archive_bytes: u64,
) -> Result<(), String> {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if status.is_success() {
        return Ok(());
    }
    Err(explain(status, &body, what, Some(archive_bytes)))
}

fn explain(
    status: reqwest::StatusCode,
    body: &str,
    what: &str,
    archive_bytes: Option<u64>,
) -> String {
    if let Some(detail) = api_error_detail(body) {
        return detail;
    }
    // This one never reaches the vault: the gateway in front of it caps the
    // request and answers with its own HTML error page.
    if status == reqwest::StatusCode::PAYLOAD_TOO_LARGE {
        return match archive_bytes {
            Some(bytes) => format!(
                "{what} failed: at {} MB the archive is too large for the vault's upload \
                 gateway, which refuses anything much over 100 MB",
                bytes / (1024 * 1024)
            ),
            None => format!("{what} failed: the archive is too large for the vault"),
        };
    }
    let body = body.trim();
    // An HTML page is a gateway talking, not the vault, and pasting its markup
    // into the dialog tells the user nothing.
    if body.is_empty() || body.starts_with('<') {
        return format!("{what} failed: {status}");
    }
    format!(
        "{what} failed: {status}: {}",
        body.chars().take(240).collect::<String>()
    )
}

/// Inert uploads client: used offline and in tests. Walks the same stages so
/// the dialog can be exercised, but nothing leaves the machine.
#[derive(Debug, Clone, Default)]
pub struct FakeUploads;

#[async_trait]
impl UploadsPort for FakeUploads {
    async fn map_preview(&self, _request: UploadRequest) -> String {
        String::new()
    }

    async fn publish(&self, request: UploadRequest) -> mpsc::Receiver<UploadStatus> {
        let (tx, rx) = mpsc::channel(8);
        tokio::spawn(async move {
            let _ = tx
                .send(UploadStatus::Compressing {
                    done_bytes: 0,
                    total_bytes: 1024,
                })
                .await;
            let _ = tx
                .send(UploadStatus::Compressing {
                    done_bytes: 1024,
                    total_bytes: 1024,
                })
                .await;
            let _ = tx
                .send(UploadStatus::Uploading {
                    sent_bytes: 0,
                    total_bytes: 1024,
                })
                .await;
            if request.kind == UploadKind::Mod {
                let _ = tx.send(UploadStatus::Finishing).await;
            }
            let _ = tx.send(UploadStatus::Succeeded).await;
        });
        rx
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "faf-upload-{tag}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn publishing_under_a_new_name_rewrites_the_archive_and_not_the_folder() {
        // FAF has no rename: a mod is its uid, and the vault refuses one it
        // already holds. So the copy that goes up carries the new name and a
        // fresh uid, and the copy the author plays with is untouched.
        let root = temp_dir("rename");
        let source = root.join("MyMod");
        std::fs::create_dir_all(source.join("hook")).unwrap();
        let original = "name = \"Old\"\nuid = \"1111\"\nversion = 2\n";
        std::fs::write(source.join("mod_info.lua"), original).unwrap();
        std::fs::write(source.join("hook").join("x.lua"), b"-- x").unwrap();

        let archive = root.join("out.zip");
        write_archive(
            &source,
            &archive,
            Some(&Rename {
                name: "New".into(),
                uid: "2222".into(),
            }),
            &|_| {},
            &CancellationToken::new(),
        )
        .expect("the archive should be written");

        let file = std::fs::File::open(&archive).unwrap();
        let mut zip = zip::ZipArchive::new(file).unwrap();
        let mut published = String::new();
        {
            use std::io::Read as _;
            zip.by_name("MyMod/mod_info.lua")
                .expect("mod_info.lua is in the archive")
                .read_to_string(&mut published)
                .unwrap();
        }
        assert!(published.contains(r#"name = "New""#), "{published}");
        assert!(published.contains(r#"uid = "2222""#), "{published}");
        assert!(published.contains("version = 2"), "{published}");

        let on_disk = std::fs::read_to_string(source.join("mod_info.lua")).unwrap();
        assert_eq!(on_disk, original, "the author's own folder was edited");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_picked_folder_is_named_by_its_own_metadata_not_by_the_folder() {
        let root = temp_dir("subject-name");
        let mod_folder = root.join("my-working-copy");
        std::fs::create_dir_all(&mod_folder).unwrap();
        std::fs::write(
            mod_folder.join("mod_info.lua"),
            "name = \"Real Mod Name\"
uid = \"0a1b2c3d\"
version = 3
",
        )
        .unwrap();
        let map_folder = root.join("map-draft");
        std::fs::create_dir_all(&map_folder).unwrap();
        std::fs::write(map_folder.join("draft.scmap"), b"").unwrap();
        std::fs::write(
            map_folder.join("draft_scenario.lua"),
            "ScenarioInfo = {
    name = 'Real Map Name',
}
",
        )
        .unwrap();

        let picked = |kind, folder: &Path| UploadRequest {
            kind,
            folder_name: folder.file_name().unwrap().to_string_lossy().into_owned(),
            display_name: folder.file_name().unwrap().to_string_lossy().into_owned(),
            ranked: false,
            source_path: Some(folder.to_string_lossy().into_owned()),
            rename_to: String::new(),
        };
        assert_eq!(
            read_subject_name(&picked(UploadKind::Mod, &mod_folder)).as_deref(),
            Some("Real Mod Name")
        );
        assert_eq!(
            read_subject_name(&picked(UploadKind::Map, &map_folder)).as_deref(),
            Some("Real Map Name")
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_folder_with_no_mod_info_is_refused_rather_than_published_unrenamed() {
        // Publishing it anyway would put an entry in the vault whose own file
        // still calls it something else, under a uid the vault already holds.
        let root = temp_dir("rename-missing");
        let source = root.join("NotAMod");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("readme.txt"), b"hello").unwrap();

        let result = write_archive(
            &source,
            &root.join("out.zip"),
            Some(&Rename {
                name: "New".into(),
                uid: "2222".into(),
            }),
            &|_| {},
            &CancellationToken::new(),
        );
        assert!(result.is_err(), "{result:?}");
        assert!(result.unwrap_err().contains("cannot be renamed"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn only_the_mod_s_own_mod_info_is_the_one_renamed() {
        // A mod that ships an example folder carries a second mod_info.lua,
        // and renaming that one would leave the real one untouched.
        assert!(is_root_mod_info("MyMod/mod_info.lua"));
        assert!(is_root_mod_info("MyMod/MOD_INFO.LUA"));
        assert!(!is_root_mod_info("MyMod/example/mod_info.lua"));
        assert!(!is_root_mod_info("MyMod/mod_info.lua.bak"));
    }

    #[test]
    fn a_fresh_uid_is_a_uuid_and_never_the_same_one_twice() {
        let first = fresh_uid();
        let second = fresh_uid();
        assert_ne!(first, first.to_uppercase(), "lower case hex");
        assert_ne!(
            first, second,
            "a reused uid is the one thing the vault refuses"
        );
        let groups: Vec<usize> = first.split('-').map(str::len).collect();
        assert_eq!(groups, vec![8, 4, 4, 4, 12], "{first}");
        assert_eq!(&first[14..15], "4", "version nibble: {first}");
        assert!(
            matches!(&first[19..20], "8" | "9" | "a" | "b"),
            "variant nibble: {first}"
        );
    }

    #[test]
    fn a_rename_is_only_ever_applied_to_a_mod() {
        // Maps have no uid to regenerate and no mod_info.lua to rewrite, so a
        // stray value in the field must not reach the archive writer.
        let map = UploadRequest {
            kind: UploadKind::Map,
            folder_name: "x.v0001".into(),
            display_name: "x".into(),
            ranked: false,
            source_path: None,
            rename_to: "Something".into(),
        };
        assert!(rename(&map).is_none());

        let blank = UploadRequest {
            kind: UploadKind::Mod,
            rename_to: "   ".into(),
            ..map.clone()
        };
        assert!(rename(&blank).is_none(), "whitespace is not a new name");

        let renamed = UploadRequest {
            kind: UploadKind::Mod,
            rename_to: "  Total Mayhem  ".into(),
            ..map
        };
        assert_eq!(rename(&renamed).unwrap().name, "Total Mayhem");
    }

    #[test]
    fn an_archive_nests_everything_under_the_folder_name() {
        // The vault expects a single top-level directory, and it is the shape
        // our own installer reads back.
        let root = temp_dir("shape");
        let source = root.join("my_map.v0001");
        std::fs::create_dir_all(source.join("sub")).unwrap();
        std::fs::write(source.join("map.scmap"), b"terrain").unwrap();
        std::fs::write(source.join("sub").join("script.lua"), b"-- x").unwrap();

        let archive = root.join("out.zip");
        write_archive(&source, &archive, None, &|_| {}, &CancellationToken::new())
            .expect("the archive should be written");

        let file = std::fs::File::open(&archive).unwrap();
        let mut zip = zip::ZipArchive::new(file).unwrap();
        let names: Vec<String> = (0..zip.len())
            .map(|index| zip.by_index(index).unwrap().name().unwrap().to_string())
            .collect();

        assert!(names.iter().all(|name| name.starts_with("my_map.v0001/")));
        assert!(names.contains(&"my_map.v0001/map.scmap".to_string()));
        assert!(
            names.contains(&"my_map.v0001/sub/script.lua".to_string()),
            "nested files keep their path, forward-slashed: {names:?}"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_empty_folder_is_refused_rather_than_published() {
        // A zip with no files is accepted by the server and then sits in the
        // vault as a broken entry.
        let root = temp_dir("empty");
        let source = root.join("nothing.v0001");
        std::fs::create_dir_all(&source).unwrap();

        let result = write_archive(
            &source,
            &root.join("out.zip"),
            None,
            &|_| {},
            &CancellationToken::new(),
        );
        assert!(result.is_err(), "{result:?}");
        assert!(result.unwrap_err().contains("empty"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn an_archive_refuses_symlinks_that_could_escape_the_source() {
        use std::os::unix::fs::symlink;

        let root = temp_dir("symlink");
        let source = root.join("my_mod");
        std::fs::create_dir_all(&source).unwrap();
        let private = root.join("private.txt");
        std::fs::write(&private, b"must not be published").unwrap();
        symlink(&private, source.join("innocent.txt")).unwrap();

        let result = write_archive(
            &source,
            &root.join("out.zip"),
            None,
            &|_| {},
            &CancellationToken::new(),
        );
        assert!(result.is_err(), "a symlink must never be followed");
        assert!(result.unwrap_err().contains("symbolic links"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_traversing_folder_name_never_reaches_the_filesystem() {
        // The guard that matters: the folder is zipped and then published, so
        // this would upload someone's private files to the vault.
        for name in ["..", "../../.ssh", "sub/dir", "C:\\Windows"] {
            let request = UploadRequest {
                kind: UploadKind::Map,
                folder_name: name.into(),
                display_name: "x".into(),
                ranked: false,
                source_path: None,
                rename_to: String::new(),
            };
            let result = source_folder(&request);
            assert!(result.is_err(), "{name} must be refused");
            assert!(
                result.unwrap_err().contains("not a folder name"),
                "refused for the right reason"
            );
        }
    }

    #[test]
    fn a_folder_that_is_not_installed_is_reported_plainly() {
        let request = UploadRequest {
            kind: UploadKind::Map,
            folder_name: "definitely_not_here.v0001".into(),
            display_name: "Ghost Map".into(),
            ranked: false,
            source_path: None,
            rename_to: String::new(),
        };
        let error = source_folder(&request).unwrap_err();
        assert!(error.contains("Ghost Map"), "names what is missing");
        assert!(error.contains("not installed"));
    }

    #[tokio::test]
    async fn a_server_error_surfaces_its_own_wording() {
        // Better than "422": the vault says things like "a map with this name
        // already exists".
        let body = r#"{"errors":[{"detail":"A map with that name already exists."}]}"#;
        assert_eq!(
            api_error_detail(body).as_deref(),
            Some("A map with that name already exists.")
        );
    }

    #[tokio::test]
    async fn the_fake_walks_the_stages_and_finishes() {
        let mut rx = FakeUploads
            .publish(UploadRequest {
                kind: UploadKind::Mod,
                folder_name: "my_mod".into(),
                display_name: "My Mod".into(),
                ranked: false,
                source_path: None,
                rename_to: String::new(),
            })
            .await;

        let mut seen = Vec::new();
        while let Some(status) = rx.recv().await {
            seen.push(status);
        }
        assert!(
            matches!(seen.first(), Some(UploadStatus::Compressing { .. })),
            "{seen:?}"
        );
        assert!(seen.contains(&UploadStatus::Finishing), "mods only");
        assert_eq!(seen.last(), Some(&UploadStatus::Succeeded));
    }

    #[test]
    fn a_picked_folder_is_used_as_given_rather_than_joined_to_ours() {
        // The point of the feature: a map that was never installed by the
        // client can still be published, exactly as Java allows.
        let root = temp_dir("picked");
        let source = root.join("brand new map.v0001");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("map.scmap"), b"terrain").unwrap();

        let request = UploadRequest {
            kind: UploadKind::Map,
            folder_name: "brand new map.v0001".into(),
            display_name: "Brand New Map".into(),
            ranked: false,
            source_path: Some(source.to_string_lossy().into_owned()),
            rename_to: String::new(),
        };
        assert_eq!(source_folder(&request).unwrap(), source);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_picked_folder_that_is_not_a_map_is_refused_before_zipping() {
        // Someone picks their Documents folder. Refusing here costs nothing;
        // the vault would otherwise accept the archive and keep the entry.
        let root = temp_dir("wrong-kind");
        let source = root.join("holiday photos");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("beach.jpg"), b"not a map").unwrap();

        let request = UploadRequest {
            kind: UploadKind::Map,
            folder_name: "holiday photos".into(),
            display_name: "holiday photos".into(),
            ranked: false,
            source_path: Some(source.to_string_lossy().into_owned()),
            rename_to: String::new(),
        };
        let error = source_folder(&request).unwrap_err();
        assert!(error.contains(".scmap"), "{error}");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_picked_folders_name_cannot_break_the_multipart_header() {
        // A picked name never passed `is_safe_folder_name`, and it ends up in
        // a `filename=` parameter.
        assert_eq!(archive_file_name("my_map.v0001"), "my_map.v0001");
        assert_eq!(archive_file_name("a\"b; c/d"), "a_b__c_d");
        assert_eq!(archive_file_name(""), "upload");
    }

    #[tokio::test]
    async fn a_map_publish_skips_the_storage_handshake() {
        let mut rx = FakeUploads
            .publish(UploadRequest {
                kind: UploadKind::Map,
                folder_name: "my_map.v0001".into(),
                display_name: "My Map".into(),
                ranked: true,
                source_path: None,
                rename_to: String::new(),
            })
            .await;

        let mut seen = Vec::new();
        while let Some(status) = rx.recv().await {
            seen.push(status);
        }
        assert!(
            !seen.contains(&UploadStatus::Finishing),
            "maps are one request, not three"
        );
        assert_eq!(seen.last(), Some(&UploadStatus::Succeeded));
    }

    /// Answer one request with `200`, and hand back everything that was sent.
    ///
    /// The point of the next test is the wire, so nothing is stubbed above the
    /// socket: what it inspects is the request the vault would receive.
    async fn capture_one_request() -> (String, tokio::task::JoinHandle<Vec<u8>>) {
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

        const END_OF_HEADERS: &[u8] = b"\r\n\r\n";
        const OK_RESPONSE: &[u8] =
            b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut seen = Vec::new();
            let mut buffer = vec![0u8; 16 * 1024];
            // Read the headers, then exactly the body they declare: reading to
            // end-of-stream would wait for a keep-alive connection to close.
            let mut want = None;
            loop {
                if let Some(total) = want {
                    if seen.len() >= total {
                        break;
                    }
                } else if let Some(end) = find(&seen, END_OF_HEADERS) {
                    let headers = String::from_utf8_lossy(&seen[..end]).to_lowercase();
                    let declared = headers
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length:"))
                        .and_then(|value| value.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                    want = Some(end + END_OF_HEADERS.len() + declared);
                    continue;
                }
                match socket.read(&mut buffer).await {
                    Ok(0) | Err(_) => break,
                    Ok(read) => seen.extend_from_slice(&buffer[..read]),
                }
            }
            let _ = socket.write_all(OK_RESPONSE).await;
            let _ = socket.flush().await;
            seen
        });
        (format!("http://127.0.0.1:{port}"), server)
    }

    fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        haystack
            .windows(needle.len())
            .position(|window| window == needle)
    }

    fn scratch_archive(tag: &str, bytes: &[u8]) -> (PathBuf, PathBuf) {
        let root = temp_dir(tag);
        let archive = root.join("upload.zip");
        std::fs::write(&archive, bytes).unwrap();
        (root, archive)
    }

    /// Raised when the future holding it is dropped.
    struct DroppedFlag(std::sync::Arc<std::sync::atomic::AtomicBool>);

    impl Drop for DroppedFlag {
        fn drop(&mut self) {
            self.0.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }

    #[tokio::test]
    async fn upload_cancellation_stops_packing_and_cleans_before_retry() {
        let root = temp_dir("packing-cancel");
        let source = root.join("map");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("large.scmap"), vec![7u8; 2 * 1024 * 1024]).unwrap();
        let target = root.join("upload.zip");
        let called_off = CancellationToken::new();
        let packed = std::sync::atomic::AtomicU64::new(0);
        {
            let archive = TemporaryArchive(target.clone());
            let result = write_archive(
                &source,
                &archive.0,
                None,
                &|bytes| {
                    packed.store(bytes, std::sync::atomic::Ordering::SeqCst);
                    called_off.cancel();
                },
                &called_off,
            );
            assert!(result.is_err());
            assert_eq!(packed.load(std::sync::atomic::Ordering::SeqCst), 64 * 1024);
        }
        assert!(!target.exists(), "cancelled compression left its archive");
        let (tx, mut rx) = mpsc::channel(16);
        // A new token can reuse the destination, with no old worker left writing it.
        let archive = zip_to(source, target.clone(), None, &tx, &CancellationToken::new())
            .await
            .unwrap()
            .unwrap();
        assert!(target.exists());
        drop(archive);
        assert!(!target.exists());
        while rx.try_recv().is_ok() {}
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn upload_cancellation_prevents_the_transport_yielding_the_last_chunk() {
        use futures_util::StreamExt as _;
        let (root, archive) = scratch_archive("body-cancel", &vec![7u8; 128 * 1024]);
        let file = tokio::fs::File::open(&archive).await.unwrap();
        let (tx, _rx) = mpsc::channel(16);
        let committed = std::sync::Arc::new(UploadCommitment::default());
        let mut body = Box::pin(upload_body_stream(
            file,
            128 * 1024,
            tx,
            UploadWatch::new(),
            committed.clone(),
            true,
        ));
        assert_eq!(body.next().await.unwrap().unwrap().len(), 64 * 1024);
        assert!(committed.cancel());
        assert_eq!(
            body.next().await.unwrap().unwrap_err().kind(),
            std::io::ErrorKind::Interrupted
        );
        assert!(
            !committed.commit(),
            "a late HTTP poll committed a cancelled upload"
        );
        drop(body);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn upload_cancellation_distinguishes_map_completion_from_mod_registration() {
        use futures_util::StreamExt as _;
        let (root, archive) = scratch_archive("body-commit", b"archive");
        for is_map in [true, false] {
            let file = tokio::fs::File::open(&archive).await.unwrap();
            let (tx, mut rx) = mpsc::channel(16);
            let committed = std::sync::Arc::new(UploadCommitment::default());
            let mut body = Box::pin(upload_body_stream(
                file,
                7,
                tx,
                UploadWatch::new(),
                committed.clone(),
                is_map,
            ));
            assert!(body.next().await.unwrap().is_ok());
            if is_map {
                assert_eq!(
                    rx.try_recv().unwrap(),
                    UploadStatus::Uploading {
                        sent_bytes: 7,
                        total_bytes: 7
                    }
                );
            } else {
                assert!(
                    rx.try_recv().is_err(),
                    "storage completion must not disable mod cancellation"
                );
            }
            assert_eq!(committed.cancel(), !is_map);
            assert_eq!(committed.commit(), is_map);
            drop(body);
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    /// A publish called off while its bytes are still moving: the request is
    /// dropped where it is, and the run says it was called off rather than
    /// that it failed.
    #[tokio::test]
    async fn a_publish_called_off_before_its_last_byte_is_dropped() {
        let called_off = CancellationToken::new();
        let committed = UploadCommitment::default();
        let dropped = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = DroppedFlag(dropped.clone());
        let sending = async move {
            let _flag = flag;
            std::future::pending::<Result<(), String>>().await
        };

        called_off.cancel();
        // The timeout is a safety net, not an ordering: a call-off that is
        // not heeded leaves the request waiting forever.
        let end = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            send_unless_called_off(sending, &committed, &called_off),
        )
        .await
        .expect("the called-off publish never stopped");

        assert_eq!(end, Ok(RunEnd::CalledOff));
        assert!(
            dropped.load(std::sync::atomic::Ordering::SeqCst),
            "the request is torn down"
        );
    }

    /// Called off once the server could have the whole archive: stopping
    /// would only stop the client hearing whether it got in, so the run is
    /// seen through and reports what happened.
    #[tokio::test]
    async fn a_publish_called_off_after_its_commitment_is_seen_through() {
        let called_off = CancellationToken::new();
        let committed = UploadCommitment::default();
        assert!(committed.commit());
        let (answer, answered) = tokio::sync::oneshot::channel::<()>();
        let sending = async move {
            let _ = answered.await;
            Ok(())
        };

        called_off.cancel();
        // The answer arrives only after the call-off has been looked at.
        let (end, ()) = tokio::join!(
            send_unless_called_off(sending, &committed, &called_off),
            async move {
                tokio::task::yield_now().await;
                let _ = answer.send(());
            }
        );

        assert_eq!(end, Ok(RunEnd::Published));
    }

    #[tokio::test]
    async fn the_metadata_part_is_typed_as_json() {
        // Without this the vault answers "Content-Type 'application/octet-stream'
        // is not supported": the endpoint binds the part with
        // `@RequestPart MapUploadMetadata`, which chooses its converter by the
        // part's own content type, and an untyped part has none.
        let (root, archive) = scratch_archive("metadata", b"PK\x03\x04 pretend archive");
        let (base, server) = capture_one_request().await;

        let (tx, mut rx) = mpsc::channel(16);
        let request = UploadRequest {
            kind: UploadKind::Map,
            folder_name: "scmp_test.v0001".into(),
            display_name: "Test".into(),
            ranked: true,
            source_path: None,
            rename_to: String::new(),
        };
        let total = std::fs::metadata(&archive).unwrap().len();
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(20),
            upload_map(
                &UploadsConfig { api_base: base },
                &reqwest::Client::new(),
                "token",
                &request,
                &archive,
                total,
                &tx,
                &std::sync::Arc::new(UploadCommitment::default()),
            ),
        )
        .await
        .expect("the upload should not hang");
        assert!(result.is_ok(), "{result:?}");
        while rx.try_recv().is_ok() {}

        let sent = String::from_utf8_lossy(
            &tokio::time::timeout(std::time::Duration::from_secs(20), server)
                .await
                .expect("the server should have answered")
                .unwrap(),
        )
        .to_string();
        assert!(
            sent.contains("Content-Type: application/json"),
            "the metadata part must be typed: {sent}"
        );
        assert!(
            sent.contains("Content-Type: application/zip"),
            "the file part keeps its zip type: {sent}"
        );
        assert!(
            sent.contains(r#"name="metadata""#) && sent.contains(r#"{"isRanked":true}"#),
            "the metadata is the JSON the vault reads: {sent}"
        );
        assert!(
            sent.contains(r#"filename="scmp_test.v0001.zip""#),
            "the vault takes the extension off this name: {sent}"
        );
        // Streamed, but with a length: neither the vault's gateway nor object
        // storage will take a chunked upload.
        let head = sent
            .split("\r\n\r\n")
            .next()
            .unwrap_or_default()
            .to_lowercase();
        assert!(
            head.contains("content-length:"),
            "the request declares its own length: {head}"
        );
        assert!(
            !head.contains("transfer-encoding: chunked"),
            "and is not sent chunked: {head}"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn progress_is_reported_from_the_bytes_actually_written() {
        // Java's `CountingFileSystemResource` counts as it reads; the archive is
        // never held in memory, so the bar has to come from the stream.
        let (root, archive) = scratch_archive("progress", &vec![7u8; 3 * 1024 * 1024]);
        let file = tokio::fs::File::open(&archive).await.unwrap();
        let total = std::fs::metadata(&archive).unwrap().len();

        let (tx, mut rx) = mpsc::channel(64);
        // Drive the body to exhaustion the way the request writer would.
        let mut stream = Box::pin(counting_stream(file, total, tx));
        let mut written = 0u64;
        while let Some(chunk) = futures_util::StreamExt::next(&mut stream).await {
            written += chunk.unwrap().len() as u64;
        }
        assert_eq!(written, total, "every byte of the archive is sent once");

        let mut last = 0u32;
        while let Ok(status) = rx.try_recv() {
            if let UploadStatus::Uploading {
                sent_bytes,
                total_bytes,
            } = status
            {
                assert_eq!(total_bytes, total as u32);
                assert!(sent_bytes > last, "progress only moves forward");
                last = sent_bytes;
            }
        }
        assert!(last > 0, "the bar moved while the archive was streamed");
        assert!(last <= total as u32);

        let _ = std::fs::remove_dir_all(&root);
    }
}
