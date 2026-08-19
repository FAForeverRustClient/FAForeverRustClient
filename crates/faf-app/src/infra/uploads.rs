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

use std::io::Write as _;
use std::path::{Path, PathBuf};

use async_trait::async_trait;
use faf_domain::state::{is_safe_folder_name, UploadKind, UploadRequest, UploadStatus};
use serde_json::Value;
use tokio::io::AsyncReadExt as _;
use tokio::sync::mpsc;

use crate::infra::jsonapi::api_error_detail;
use crate::infra::session::TokenStore;
use crate::infra::{cache_dir, env_or};
use crate::ports::UploadsPort;

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
}

impl UploadsClient {
    pub fn new(config: UploadsConfig, tokens: TokenStore) -> Self {
        Self {
            config,
            tokens,
            http: super::http::shared_http_client(),
        }
    }

    pub fn faf(tokens: TokenStore) -> Self {
        Self::new(UploadsConfig::faf(), tokens)
    }
}

#[async_trait]
impl UploadsPort for UploadsClient {
    async fn publish(&self, request: UploadRequest) -> mpsc::Receiver<UploadStatus> {
        let (tx, rx) = mpsc::channel(16);
        let config = self.config.clone();
        let tokens = self.tokens.clone();
        let http = self.http.clone();

        tokio::spawn(async move {
            let outcome = run(&config, &tokens, &http, &request, &tx).await;
            let _ = tx
                .send(match outcome {
                    Ok(()) => UploadStatus::Succeeded,
                    Err(reason) => UploadStatus::Failed { reason },
                })
                .await;
        });

        rx
    }
}

async fn run(
    config: &UploadsConfig,
    tokens: &TokenStore,
    http: &reqwest::Client,
    request: &UploadRequest,
    tx: &mpsc::Sender<UploadStatus>,
) -> Result<(), String> {
    let token = tokens.get().ok_or_else(|| "not logged in".to_string())?;

    let source = source_folder(request)?;
    let _ = tx.send(UploadStatus::Compressing).await;
    let archive = zip_folder(&source, request.kind).await?;

    // Always remove the temporary archive, however this ends: both reference
    // clients delete it in a `finally`.
    let result = send(config, http, &token, request, &archive, tx).await;
    let _ = tokio::fs::remove_file(&archive).await;
    result
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
async fn zip_folder(source: &Path, kind: UploadKind) -> Result<PathBuf, String> {
    let source = source.to_path_buf();
    let target = cache_dir()?.join(format!(
        "upload-{}-{}.zip",
        kind.label(),
        std::process::id()
    ));
    tokio::fs::create_dir_all(target.parent().unwrap_or(Path::new(".")))
        .await
        .map_err(|error| format!("could not create the cache directory: {error}"))?;

    let output = target.clone();
    // `zip` is synchronous and this walks a whole directory.
    tokio::task::spawn_blocking(move || write_archive(&source, &output))
        .await
        .map_err(|error| format!("compression task failed: {error}"))??;

    let size = tokio::fs::metadata(&target)
        .await
        .map_err(|error| format!("could not read the archive: {error}"))?
        .len();
    if size > MAX_ARCHIVE_BYTES {
        let _ = tokio::fs::remove_file(&target).await;
        return Err(format!(
            "the archive is {} MB, over the {} MB limit",
            size / (1024 * 1024),
            MAX_ARCHIVE_BYTES / (1024 * 1024)
        ));
    }
    Ok(target)
}

fn write_archive(source: &Path, target: &Path) -> Result<(), String> {
    let root_name = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "the folder has no usable name".to_string())?
        .to_string();

    let file = std::fs::File::create(target)
        .map_err(|error| format!("could not create the archive: {error}"))?;
    let mut writer = zip::ZipWriter::new(file);
    let options: zip::write::FileOptions<'_, ()> =
        zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    let mut stack = vec![source.to_path_buf()];
    let mut wrote_anything = false;
    while let Some(dir) = stack.pop() {
        let entries = std::fs::read_dir(&dir)
            .map_err(|error| format!("could not read {}: {error}", dir.display()))?;
        for entry in entries {
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
                let bytes = std::fs::read(&path)
                    .map_err(|error| format!("could not read {}: {error}", path.display()))?;
                writer
                    .start_file(&name, options)
                    .map_err(|error| format!("could not add {name}: {error}"))?;
                writer
                    .write_all(&bytes)
                    .map_err(|error| format!("could not write {name}: {error}"))?;
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
            upload_map(config, http, token, request, archive, total_bytes, tx).await?
        }
        UploadKind::Mod => upload_mod(config, http, token, archive, total_bytes, tx).await?,
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
fn counting_body(
    file: tokio::fs::File,
    total_bytes: u64,
    tx: mpsc::Sender<UploadStatus>,
) -> reqwest::Body {
    reqwest::Body::wrap_stream(counting_stream(file, total_bytes, tx))
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
                    sent_bytes: clamp(progress.sent),
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
async fn upload_map(
    config: &UploadsConfig,
    http: &reqwest::Client,
    token: &str,
    request: &UploadRequest,
    archive: &Path,
    total_bytes: u64,
    tx: &mpsc::Sender<UploadStatus>,
) -> Result<(), String> {
    let file = tokio::fs::File::open(archive)
        .await
        .map_err(|error| format!("could not read the archive: {error}"))?;

    // The length is declared so the whole multipart body gets a
    // `Content-Length`: the vault's gateway will not take a chunked upload.
    let part = reqwest::multipart::Part::stream_with_length(
        counting_body(file, total_bytes, tx.clone()),
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

    let response = http
        .post(format!("{}/maps/upload", config.api_base))
        .bearer_auth(token)
        .header(reqwest::header::ACCEPT, "application/json")
        .multipart(form)
        .send()
        .await
        .map_err(|error| format!("upload failed: {error}"))?;
    check_upload(response, "the map upload", total_bytes).await
}

async fn upload_mod(
    config: &UploadsConfig,
    http: &reqwest::Client,
    token: &str,
    archive: &Path,
    total_bytes: u64,
    tx: &mpsc::Sender<UploadStatus>,
) -> Result<(), String> {
    // 1. Ask FAF where to put it.
    let response = http
        .get(format!("{}/mods/upload/start", config.api_base))
        .bearer_auth(token)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|error| format!("could not start the upload: {error}"))?;
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
    let stored = http
        .put(upload_url)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::CONTENT_TYPE, "application/zip")
        // Set by hand because the body is a stream: object storage rejects a
        // chunked PUT, and the signature covers the declared length.
        .header(reqwest::header::CONTENT_LENGTH, total_bytes)
        .body(counting_body(file, total_bytes, tx.clone()))
        .send()
        .await
        .map_err(|error| format!("could not upload the archive: {error}"))?;
    check_upload(stored, "the archive upload", total_bytes).await?;

    // 3. Tell FAF it landed. Until this, the upload does not exist as far as
    //    the vault is concerned.
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
        .send()
        .await
        .map_err(|error| format!("could not complete the upload: {error}"))?;
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
    async fn publish(&self, request: UploadRequest) -> mpsc::Receiver<UploadStatus> {
        let (tx, rx) = mpsc::channel(8);
        tokio::spawn(async move {
            let _ = tx.send(UploadStatus::Compressing).await;
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
    fn an_archive_nests_everything_under_the_folder_name() {
        // The vault expects a single top-level directory, and it is the shape
        // our own installer reads back.
        let root = temp_dir("shape");
        let source = root.join("my_map.v0001");
        std::fs::create_dir_all(source.join("sub")).unwrap();
        std::fs::write(source.join("map.scmap"), b"terrain").unwrap();
        std::fs::write(source.join("sub").join("script.lua"), b"-- x").unwrap();

        let archive = root.join("out.zip");
        write_archive(&source, &archive).expect("the archive should be written");

        let file = std::fs::File::open(&archive).unwrap();
        let mut zip = zip::ZipArchive::new(file).unwrap();
        let names: Vec<String> = (0..zip.len())
            .map(|index| zip.by_index(index).unwrap().name().to_string())
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

        let result = write_archive(&source, &root.join("out.zip"));
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

        let result = write_archive(&source, &root.join("out.zip"));
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
            })
            .await;

        let mut seen = Vec::new();
        while let Some(status) = rx.recv().await {
            seen.push(status);
        }
        assert_eq!(seen.first(), Some(&UploadStatus::Compressing));
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
