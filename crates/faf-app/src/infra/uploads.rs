//! Publishing a map or mod to the vault.
//!
//! Zip the installed folder, then send it: but by two different routes,
//! because the server offers two:
//!
//! **Maps**: one multipart request, mirroring Java's `MapUploadTask`:
//!
//! ```text
//! POST {api}/maps/upload      multipart/form-data
//!   file     = <archive>
//!   metadata = {"isRanked": <bool>}
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
    // Checked here as well as in the service: this is the last point before a
    // directory is read and its contents published, and the name may have
    // arrived from anywhere.
    let folder = match request.kind {
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
    Ok(folder)
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
    let bytes = tokio::fs::read(archive)
        .await
        .map_err(|error| format!("could not read the archive: {error}"))?;
    let total_bytes = u32::try_from(bytes.len()).unwrap_or(u32::MAX);

    // Reported once up front rather than streamed: `reqwest` gives no progress
    // callback for a buffered body, and inventing one would be a lie. The
    // stage still tells the user what is happening.
    let _ = tx
        .send(UploadStatus::Uploading {
            sent_bytes: 0,
            total_bytes,
        })
        .await;

    match request.kind {
        UploadKind::Map => upload_map(config, http, token, request, bytes).await?,
        UploadKind::Mod => upload_mod(config, http, token, bytes, tx).await?,
    }

    let _ = tx
        .send(UploadStatus::Uploading {
            sent_bytes: total_bytes,
            total_bytes,
        })
        .await;
    Ok(())
}

async fn upload_map(
    config: &UploadsConfig,
    http: &reqwest::Client,
    token: &str,
    request: &UploadRequest,
    bytes: Vec<u8>,
) -> Result<(), String> {
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(format!("{}.zip", request.folder_name))
        .mime_str("application/zip")
        .map_err(|error| format!("could not build the upload: {error}"))?;
    let form = reqwest::multipart::Form::new()
        .part("file", part)
        // The server reads this as JSON, not as a plain form field.
        .text(
            "metadata",
            serde_json::json!({ "isRanked": request.ranked }).to_string(),
        );

    let response = http
        .post(format!("{}/maps/upload", config.api_base))
        .bearer_auth(token)
        .multipart(form)
        .send()
        .await
        .map_err(|error| format!("upload failed: {error}"))?;
    check(response, "the map upload").await
}

async fn upload_mod(
    config: &UploadsConfig,
    http: &reqwest::Client,
    token: &str,
    bytes: Vec<u8>,
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
    let stored = http
        .put(upload_url)
        .header(reqwest::header::CONTENT_TYPE, "application/zip")
        .body(bytes)
        .send()
        .await
        .map_err(|error| format!("could not upload the archive: {error}"))?;
    check(stored, "the archive upload").await?;

    // 3. Tell FAF it landed. Until this, the upload does not exist as far as
    //    the vault is concerned.
    let _ = tx.send(UploadStatus::Finishing).await;
    let completed = http
        .post(format!("{}/mods/upload/complete", config.api_base))
        .bearer_auth(token)
        .json(&serde_json::json!({ "requestId": request_id }))
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
    Err(match api_error_detail(&body) {
        Some(detail) => detail,
        None if body.trim().is_empty() => format!("{what} failed: {status}"),
        None => format!(
            "{what} failed: {status}: {}",
            body.chars().take(240).collect::<String>()
        ),
    })
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

    #[tokio::test]
    async fn a_map_publish_skips_the_storage_handshake() {
        let mut rx = FakeUploads
            .publish(UploadRequest {
                kind: UploadKind::Map,
                folder_name: "my_map.v0001".into(),
                display_name: "My Map".into(),
                ranked: true,
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
}
