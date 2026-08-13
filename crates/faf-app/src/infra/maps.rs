//! Real maps client — vault browsing + local install management.
//!
//! Mirrors the Python client's `vaults/mapvault/` + `fa/maps.py`:
//!
//! ## Vault listing
//! `GET {api_base}/data/map`, `include=latestVersion,author`,
//! `filter=latestVersion.hidden=='false'`, sorted newest-first — the same
//! JSON:API shape (and the same bearer-token requirement, since the Python
//! client's `ApiAccessManager.get` defaults `authorize=True` for every Data
//! API call) as the replay vault's `/data/game` (see `infra/replay.rs`).
//!
//! ## Installed maps
//! A plain directory scan of the user's maps folder — `<Documents>/My
//! Games/Gas Powered Games/Supreme Commander Forged Alliance/maps`, mirroring
//! `util.VAULTS_BASE_DIR` + `fa.maps.getUserMapsFolder()`. Display names are
//! derived from the folder name the same way as the non-official-map fallback
//! branch of `fa.maps.getDisplayName` (strip a trailing `.vNNNN` version
//! suffix, `_` -> space, title-case) — not a full `scenario.lua` parse
//! (`InstalledMapsCache`), which is a later-phase nicety.
//!
//! ## Install / uninstall
//! Installing downloads the version's zip (unauthenticated — the vault CDN,
//! like the replay download host) and extracts it directly into the maps
//! folder, mirroring `fa.maps._doDownloadMap` -> `ZipDownloadExtract` (the
//! zip's own top-level entry is the map's folder name). Uninstalling just
//! removes that directory, mirroring `MapsManagerDialog::delete_map`.

use std::collections::HashMap;
use std::path::PathBuf;

use async_trait::async_trait;
use faf_domain::state::{InstalledMap, VaultMap};
use serde::Deserialize;
use serde_json::Value;

use crate::infra::env_or;
use crate::ports::MapsPort;

/// Maps per vault page fetched in [`MapsClient::list_vault`].
const VAULT_PAGE_SIZE: usize = 100;
/// Upper bound on pages fetched — bounds worst-case work if the vault ever
/// grows huge, without silently truncating the list under normal size.
const MAX_VAULT_PAGES: u32 = 50;

#[derive(Debug, Clone)]
pub struct MapsConfig {
    /// FAF Data API base, which serves `/data/map` (vault listing) — same
    /// host as the replay vault's `/data/game` (see `ReplayConfig::api_base`).
    pub api_base: String,
}

impl MapsConfig {
    pub fn faf() -> Self {
        Self {
            api_base: env_or("FAF_API_BASE", "https://api.faforever.com"),
        }
    }
}

pub struct MapsClient {
    config: MapsConfig,
    tokens: crate::infra::session::TokenStore,
    http: reqwest::Client,
}

impl MapsClient {
    pub fn new(config: MapsConfig, tokens: crate::infra::session::TokenStore) -> Self {
        Self {
            config,
            tokens,
            http: reqwest::Client::new(),
        }
    }

    pub fn faf(tokens: crate::infra::session::TokenStore) -> Self {
        Self::new(MapsConfig::faf(), tokens)
    }
}

#[async_trait]
impl MapsPort for MapsClient {
    async fn list_vault(&self) -> Result<Vec<VaultMap>, String> {
        let token = self
            .tokens
            .get()
            .ok_or_else(|| "not logged in".to_string())?;

        // The Python client's `MapVault` paginates lazily (one page per
        // "next page" click, no fixed cap). We don't have a paging UI yet, so
        // fetch every page up front instead of silently truncating to the
        // first one — a map search is useless if most of the vault is
        // missing. `MAX_VAULT_PAGES` just bounds worst-case work if the vault
        // ever grows huge; a single page is `VAULT_PAGE_SIZE` maps.
        let mut all_maps = Vec::new();
        for page in 1..=MAX_VAULT_PAGES {
            let mut url = url::Url::parse(&format!("{}/data/map", self.config.api_base))
                .map_err(|e| format!("invalid API base: {e}"))?;
            url.query_pairs_mut()
                .append_pair("filter", "latestVersion.hidden=='false'")
                .append_pair("sort", "-createTime")
                .append_pair("page[size]", &VAULT_PAGE_SIZE.to_string())
                .append_pair("page[number]", &page.to_string())
                .append_pair("include", "latestVersion,author");

            let resp = self
                .http
                .get(url)
                .bearer_auth(&token)
                .header(reqwest::header::ACCEPT, "application/vnd.api+json")
                .send()
                .await
                .map_err(|e| format!("request failed: {e}"))?;

            let status = resp.status();
            let body = resp.text().await.map_err(|e| format!("read failed: {e}"))?;
            if !status.is_success() {
                return Err(format!(
                    "/data/map returned {status}: {}",
                    body.chars().take(200).collect::<String>()
                ));
            }

            let doc: JsonApiDoc =
                serde_json::from_str(&body).map_err(|e| format!("invalid JSON: {e}"))?;
            let page_len = doc.data.len();
            all_maps.extend(parse_vault_maps(&doc));

            // Fewer results than requested means this was the last page.
            if page_len < VAULT_PAGE_SIZE {
                break;
            }
        }
        Ok(all_maps)
    }

    async fn list_installed(&self) -> Result<Vec<InstalledMap>, String> {
        list_installed_dir(&maps_dir()).await
    }

    async fn install_map(
        &self,
        folder_name: String,
        download_url: String,
    ) -> Result<Vec<InstalledMap>, String> {
        let resp = self
            .http
            .get(&download_url)
            .send()
            .await
            .map_err(|e| format!("could not download map {folder_name}: {e}"))?;
        let status = resp.status();
        if !status.is_success() {
            return Err(format!("could not download map {folder_name}: {status}"));
        }
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| format!("could not read map {folder_name}: {e}"))?;

        let dest = maps_dir();
        tokio::fs::create_dir_all(&dest)
            .await
            .map_err(|e| format!("could not create maps folder: {e}"))?;

        let dest_clone = dest.clone();
        tokio::task::spawn_blocking(move || extract_zip(&bytes, &dest_clone))
            .await
            .map_err(|e| format!("extraction task panicked: {e}"))??;

        list_installed_dir(&dest).await
    }

    async fn uninstall_map(&self, folder_name: String) -> Result<Vec<InstalledMap>, String> {
        let dir = maps_dir();
        let target = dir.join(&folder_name);
        if target.exists() {
            tokio::fs::remove_dir_all(&target)
                .await
                .map_err(|e| format!("could not remove {}: {e}", target.display()))?;
        }
        list_installed_dir(&dir).await
    }
}

/// Extract a zip archive's bytes directly into `dest` (its own top-level
/// entry is the map's folder name — mirrors `ZipDownloadExtract`). Runs on a
/// blocking thread since the `zip` crate is synchronous.
fn extract_zip(bytes: &[u8], dest: &std::path::Path) -> Result<(), String> {
    let reader = std::io::Cursor::new(bytes);
    let mut archive =
        zip::ZipArchive::new(reader).map_err(|e| format!("not a valid zip archive: {e}"))?;
    archive
        .extract(dest)
        .map_err(|e| format!("could not extract zip into {}: {e}", dest.display()))
}

/// Scans `dir` for installed map folders — the testable body of
/// [`MapsClient::list_installed`]/post-install rescans.
async fn list_installed_dir(dir: &std::path::Path) -> Result<Vec<InstalledMap>, String> {
    let mut entries = match tokio::fs::read_dir(dir).await {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("could not read {}: {e}", dir.display())),
    };

    let mut installed = Vec::new();
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|e| format!("could not list {}: {e}", dir.display()))?
    {
        let is_dir = entry
            .file_type()
            .await
            .map(|t| t.is_dir())
            .unwrap_or(false);
        if !is_dir {
            continue;
        }
        let folder_name = entry.file_name().to_string_lossy().to_lowercase();
        installed.push(InstalledMap {
            display_name: display_name_from_folder(&folder_name),
            folder_name,
        });
    }
    installed.sort_by(|a, b| a.display_name.cmp(&b.display_name));
    Ok(installed)
}

/// Mirrors the non-official-map fallback branch of the Python client's
/// `fa.maps.getDisplayName`: strip a trailing `.vNNNN` version suffix
/// (`rsplit(".v0", 1)[0]`), `_` -> space, title-case each word.
fn display_name_from_folder(folder_name: &str) -> String {
    let pretty = match folder_name.rsplit_once(".v0") {
        Some((before, _)) => before,
        None => folder_name,
    };
    let pretty = pretty.replace('_', " ");
    capwords(&pretty)
}

/// Mirrors Python's `string.capwords`: title-case each whitespace-separated word.
fn capwords(s: &str) -> String {
    s.split(' ')
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                None => String::new(),
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// The user's maps folder: `<Documents>/My Games/Gas Powered Games/Supreme
/// Commander Forged Alliance/maps` (mirrors `util.VAULTS_BASE_DIR` +
/// `fa.maps.getUserMapsFolder()`). `FAF_MAPS_DIR` overrides it (tests,
/// alternate installs, custom vault path).
fn maps_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("FAF_MAPS_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    let documents = directories::UserDirs::new()
        .and_then(|u| u.document_dir().map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("."));
    documents
        .join("My Games")
        .join("Gas Powered Games")
        .join("Supreme Commander Forged Alliance")
        .join("maps")
}

/// A JSON:API document: the top-level resources plus everything the `include`
/// query param pulled in (mirrors `infra::replay::JsonApiDoc`).
#[derive(Debug, Default, Deserialize)]
struct JsonApiDoc {
    #[serde(default)]
    data: Vec<JsonApiResource>,
    #[serde(default)]
    included: Vec<JsonApiResource>,
}

#[derive(Debug, Clone, Deserialize)]
struct JsonApiResource {
    #[serde(rename = "type")]
    kind: String,
    id: String,
    #[serde(default)]
    attributes: Value,
    #[serde(default)]
    relationships: Value,
}

fn resource_index(included: &[JsonApiResource]) -> HashMap<(String, String), &JsonApiResource> {
    included
        .iter()
        .map(|r| ((r.kind.clone(), r.id.clone()), r))
        .collect()
}

fn rel_target(relationships: &Value, name: &str) -> Option<(String, String)> {
    let data = relationships.get(name)?.get("data")?;
    Some((
        data.get("type")?.as_str()?.to_string(),
        data.get("id")?.as_str()?.to_string(),
    ))
}

fn parse_vault_maps(doc: &JsonApiDoc) -> Vec<VaultMap> {
    let index = resource_index(&doc.included);
    doc.data
        .iter()
        .filter_map(|map_res| {
            let (_, version_id) = rel_target(&map_res.relationships, "latestVersion")?;
            let version = index.get(&("mapVersion".to_string(), version_id))?;

            let author = rel_target(&map_res.relationships, "author")
                .and_then(|k| index.get(&k))
                .and_then(|a| a.attributes.get("login"))
                .and_then(Value::as_str)
                .map(str::to_string);

            Some(VaultMap {
                display_name: map_res
                    .attributes
                    .get("displayName")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown map")
                    .to_string(),
                author,
                folder_name: version
                    .attributes
                    .get("folderName")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                max_players: version
                    .attributes
                    .get("maxPlayers")
                    .and_then(Value::as_i64)
                    .unwrap_or(0) as i32,
                width: version
                    .attributes
                    .get("width")
                    .and_then(Value::as_i64)
                    .unwrap_or(0) as i32,
                height: version
                    .attributes
                    .get("height")
                    .and_then(Value::as_i64)
                    .unwrap_or(0) as i32,
                games_played: map_res
                    .attributes
                    .get("gamesPlayed")
                    .and_then(Value::as_i64)
                    .unwrap_or(0) as i32,
                ranked: version
                    .attributes
                    .get("ranked")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                download_url: version
                    .attributes
                    .get("downloadUrl")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                thumbnail_url: version
                    .attributes
                    .get("thumbnailUrlSmall")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            })
        })
        .collect()
}

/// Inert maps client — used offline and in tests (mirrors [`crate::infra::FakeReplay`]).
#[derive(Debug, Clone, Default)]
pub struct FakeMaps;

#[async_trait]
impl MapsPort for FakeMaps {
    async fn list_vault(&self) -> Result<Vec<VaultMap>, String> {
        Err("map vault is disabled (FAF_REAL_LAUNCH not set)".to_string())
    }

    async fn list_installed(&self) -> Result<Vec<InstalledMap>, String> {
        Err("map install listing is disabled (FAF_REAL_LAUNCH not set)".to_string())
    }

    async fn install_map(
        &self,
        _folder_name: String,
        _download_url: String,
    ) -> Result<Vec<InstalledMap>, String> {
        Err("map install is disabled (FAF_REAL_LAUNCH not set)".to_string())
    }

    async fn uninstall_map(&self, _folder_name: String) -> Result<Vec<InstalledMap>, String> {
        Err("map uninstall is disabled (FAF_REAL_LAUNCH not set)".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn derives_display_name_from_folder() {
        assert_eq!(display_name_from_folder("scmp_009.v0001"), "Scmp 009");
        assert_eq!(display_name_from_folder("setons_clutch.v0025"), "Setons Clutch");
        assert_eq!(display_name_from_folder("no_version_suffix"), "No Version Suffix");
    }

    #[tokio::test]
    async fn list_installed_dir_lists_subfolders_lowercased_and_sorted() {
        let dir = std::env::temp_dir().join(format!("forge-maps-test-{}", std::process::id()));
        tokio::fs::create_dir_all(dir.join("Scmp_009.v0001")).await.unwrap();
        tokio::fs::create_dir_all(dir.join("adaptive_map.v0002")).await.unwrap();
        tokio::fs::write(dir.join("not_a_dir.txt"), b"x").await.unwrap();

        let installed = list_installed_dir(&dir).await.expect("should list");
        assert_eq!(installed.len(), 2);
        let folders: Vec<_> = installed.iter().map(|m| m.folder_name.clone()).collect();
        assert!(folders.contains(&"scmp_009.v0001".to_string()));
        assert!(folders.contains(&"adaptive_map.v0002".to_string()));

        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn list_installed_dir_missing_folder_returns_empty() {
        let dir = std::env::temp_dir().join("forge-maps-does-not-exist");
        let installed = list_installed_dir(&dir).await.expect("missing dir is not an error");
        assert!(installed.is_empty());
    }

    #[test]
    fn parses_vault_maps_resolving_version_and_author_through_included() {
        let doc: JsonApiDoc = serde_json::from_value(json!({
            "data": [
                {
                    "type": "map",
                    "id": "77",
                    "attributes": { "displayName": "Seton's Clutch", "gamesPlayed": 12345 },
                    "relationships": {
                        "latestVersion": { "data": { "type": "mapVersion", "id": "9" } },
                        "author": { "data": { "type": "player", "id": "1" } },
                    },
                },
            ],
            "included": [
                {
                    "type": "mapVersion",
                    "id": "9",
                    "attributes": {
                        "folderName": "scmp_009.v0001",
                        "maxPlayers": 8,
                        "width": 1024,
                        "height": 1024,
                        "ranked": true,
                        "downloadUrl": "https://content.faforever.com/maps/scmp_009.zip",
                        "thumbnailUrlSmall": "https://content.faforever.com/maps/scmp_009.small.png",
                    },
                },
                {
                    "type": "player",
                    "id": "1",
                    "attributes": { "login": "Rackover" },
                },
            ],
        }))
        .unwrap();

        let maps = parse_vault_maps(&doc);
        assert_eq!(maps.len(), 1);
        assert_eq!(maps[0].display_name, "Seton's Clutch");
        assert_eq!(maps[0].folder_name, "scmp_009.v0001");
        assert_eq!(maps[0].author, Some("Rackover".to_string()));
        assert_eq!(maps[0].max_players, 8);
        assert_eq!(maps[0].games_played, 12345);
        assert!(maps[0].ranked);
    }

    #[test]
    fn parse_vault_maps_skips_entries_missing_latest_version() {
        let doc: JsonApiDoc = serde_json::from_value(json!({
            "data": [{ "type": "map", "id": "1", "attributes": {}, "relationships": {} }],
        }))
        .unwrap();
        assert!(parse_vault_maps(&doc).is_empty());
    }

    #[tokio::test]
    async fn fake_maps_fails_cleanly() {
        let fake = FakeMaps;
        assert!(fake.list_vault().await.is_err());
        assert!(fake.list_installed().await.is_err());
        assert!(fake.install_map("x".into(), "http://x".into()).await.is_err());
        assert!(fake.uninstall_map("x".into()).await.is_err());
    }
}
