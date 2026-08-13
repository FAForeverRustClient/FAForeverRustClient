//! Real maps client: vault browsing + local install management.
//!
//! Mirrors the Python client's `vaults/mapvault/` + `fa/maps.py`:
//!
//! ## Vault listing
//! `GET {api_base}/data/map`, `include=latestVersion,author`,
//! `filter=latestVersion.hidden=='false'`, sorted newest-first: the same
//! JSON:API shape (and the same bearer-token requirement, since the Python
//! client's `ApiAccessManager.get` defaults `authorize=True` for every Data
//! API call) as the replay vault's `/data/game` (see `infra/replay.rs`).
//!
//! ## Installed maps
//! A plain directory scan of the user's maps folder: `<Documents>/My
//! Games/Gas Powered Games/Supreme Commander Forged Alliance/maps`, mirroring
//! `util.VAULTS_BASE_DIR` + `fa.maps.getUserMapsFolder()`. Display names are
//! derived from the folder name the same way as the non-official-map fallback
//! branch of `fa.maps.getDisplayName` (strip a trailing `.vNNNN` version
//! suffix, `_` -> space, title-case): not a full `scenario.lua` parse
//! (`InstalledMapsCache`), which is a later-phase nicety.
//!
//! ## Install / uninstall
//! Installing downloads the version's zip (unauthenticated: the vault CDN,
//! like the replay download host) and extracts it directly into the maps
//! folder, mirroring `fa.maps._doDownloadMap` -> `ZipDownloadExtract` (the
//! zip's own top-level entry is the map's folder name). Uninstalling just
//! removes that directory, mirroring `MapsManagerDialog::delete_map`.

use std::path::PathBuf;

use async_trait::async_trait;
use faf_domain::state::{
    is_safe_folder_name, InstalledMap, MatchmakerMapPool, MatchmakerPoolMap, VaultMap,
};
use serde_json::Value;

use crate::infra::env_or;
use crate::infra::jsonapi::{
    fetch_document, rel_target, rel_targets, resource_index, value_bool, value_i32, value_string,
    JsonApiDoc,
};
use crate::infra::vault_install::{
    bounded_body, install_archive, validate_url, MAX_DOWNLOAD_BYTES,
};
use crate::ports::MapsPort;

/// Maps per vault page fetched in [`MapsClient::list_vault`].
const VAULT_PAGE_SIZE: usize = 100;
/// Upper bound on pages fetched: bounds worst-case work if the vault ever
/// grows huge, without silently truncating the list under normal size.
const MAX_VAULT_PAGES: u32 = 50;

#[derive(Debug, Clone)]
pub struct MapsConfig {
    /// FAF Data API base, which serves `/data/map` (vault listing): same
    /// host as the replay vault's `/data/game` (see `ReplayConfig::api_base`).
    pub api_base: String,
    /// Trusted origin for map archives returned by the Data API.
    pub content_base: String,
}

impl MapsConfig {
    pub fn faf() -> Self {
        Self {
            api_base: env_or("FAF_API_BASE", "https://api.faforever.com"),
            content_base: env_or("FAF_CONTENT_BASE", "https://content.faforever.com"),
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
            http: super::http::shared_http_client(),
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
        // first one: a map search is useless if most of the vault is
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
                .append_pair("include", "latestVersion,author,reviewsSummary");

            let doc = fetch_document(&self.http, url, &token).await?;
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

    async fn list_matchmaker_pools(
        &self,
        queue_name: String,
    ) -> Result<Vec<MatchmakerMapPool>, String> {
        let token = self
            .tokens
            .get()
            .ok_or_else(|| "not logged in".to_string())?;
        let mut url = url::Url::parse(&format!(
            "{}/data/matchmakerQueueMapPool",
            self.config.api_base
        ))
        .map_err(|e| format!("invalid API base: {e}"))?;
        url.query_pairs_mut()
            .append_pair(
                "include",
                "mapPool.mapPoolAssignments,mapPool.mapVersions,mapPool.mapVersions.map,matchmakerQueue",
            )
            .append_pair(
                "filter",
                &format!("matchmakerQueue.technicalName=='{queue_name}'"),
            )
            .append_pair("page[size]", "100");

        let doc = fetch_document(&self.http, url, &token).await?;
        Ok(parse_matchmaker_pools(&doc))
    }

    async fn install_map(
        &self,
        folder_name: String,
        download_url: String,
    ) -> Result<Vec<InstalledMap>, String> {
        safe_map_target(&maps_dir(), &folder_name)?;
        validate_url(&download_url, &self.config.content_base, "maps")?;
        let resp = self
            .http
            .get(&download_url)
            .send()
            .await
            .map_err(|e| format!("could not download map {folder_name}: {e}"))?;
        validate_url(resp.url().as_str(), &self.config.content_base, "maps")?;
        let status = resp.status();
        if !status.is_success() {
            return Err(format!("could not download map {folder_name}: {status}"));
        }
        let bytes = bounded_body(resp, &format!("map {folder_name}"), MAX_DOWNLOAD_BYTES).await?;

        let dest = maps_dir();
        tokio::fs::create_dir_all(&dest)
            .await
            .map_err(|e| format!("could not create maps folder: {e}"))?;

        let dest_clone = dest.clone();
        let expected_folder = folder_name.clone();
        tokio::task::spawn_blocking(move || {
            install_archive(&bytes, &dest_clone, Some(&expected_folder), |_| Ok(()))
        })
        .await
        .map_err(|e| format!("extraction task panicked: {e}"))??;

        list_installed_dir(&dest).await
    }

    async fn uninstall_map(&self, folder_name: String) -> Result<Vec<InstalledMap>, String> {
        let dir = maps_dir();
        let target = safe_map_target(&dir, &folder_name)?;
        if target.exists() {
            tokio::fs::remove_dir_all(&target)
                .await
                .map_err(|e| format!("could not remove {}: {e}", target.display()))?;
        }
        list_installed_dir(&dir).await
    }
}

/// Resolve a user-controlled vault folder without allowing it to escape the
/// maps directory. IPC is a trust boundary even when the normal caller is our
/// own webview.
fn safe_map_target(root: &std::path::Path, folder_name: &str) -> Result<PathBuf, String> {
    if !is_safe_folder_name(folder_name) {
        return Err(format!("{folder_name:?} is not a valid map folder name"));
    }
    Ok(root.join(folder_name))
}

/// Scans `dir` for installed map folders: the testable body of
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
        let is_dir = entry.file_type().await.map(|t| t.is_dir()).unwrap_or(false);
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
pub(crate) fn maps_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("FAF_MAPS_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    crate::infra::faf_content::vault_dir().join("maps")
}

fn parse_matchmaker_pools(doc: &JsonApiDoc) -> Vec<MatchmakerMapPool> {
    let index = resource_index(&doc.included);
    let mut pools = doc
        .data
        .iter()
        .filter_map(|pool_link| {
            let pool_id = pool_link.id.parse().ok()?;
            let pool_key = rel_target(&pool_link.relationships, "mapPool")?;
            let pool = index.get(&pool_key)?;
            let maps = rel_targets(&pool.relationships, "mapPoolAssignments")
                .into_iter()
                .filter_map(|assignment_key| {
                    let assignment = index.get(&assignment_key)?;
                    let assignment_id = assignment.id.parse().ok()?;

                    if let Some(version_key) = rel_target(&assignment.relationships, "mapVersion") {
                        let version = index.get(&version_key)?;
                        let map_name = rel_target(&version.relationships, "map")
                            .and_then(|key| index.get(&key))
                            .and_then(|map| map.attributes.get("displayName"))
                            .and_then(Value::as_str)
                            .unwrap_or("Unknown map");
                        return Some(MatchmakerPoolMap {
                            assignment_id,
                            display_name: map_name.to_string(),
                            folder_name: version
                                .attributes
                                .get("folderName")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string(),
                            max_players: value_i32(&version.attributes, "maxPlayers").unwrap_or(0),
                            width: value_i32(&version.attributes, "width").unwrap_or(0),
                            height: value_i32(&version.attributes, "height").unwrap_or(0),
                            thumbnail_url: version
                                .attributes
                                .get("thumbnailUrlSmall")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string(),
                        });
                    }

                    let params_key = rel_target(&assignment.relationships, "mapParams")?;
                    let params = index.get(&params_key)?;
                    let generator_type = params
                        .attributes
                        .get("type")
                        .and_then(Value::as_str)
                        .unwrap_or("Generated map");
                    let version = params
                        .attributes
                        .get("version")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let spawns = value_i32(&params.attributes, "spawns").unwrap_or(0);
                    let size = value_i32(&params.attributes, "size").unwrap_or(0);
                    Some(MatchmakerPoolMap {
                        assignment_id,
                        display_name: generator_type.to_string(),
                        folder_name: format!(
                            "neroxis_map_generator_{version}_{generator_type}_{spawns}_{size}"
                        ),
                        max_players: spawns,
                        width: size,
                        height: size,
                        thumbnail_url: String::new(),
                    })
                })
                .collect();

            Some(MatchmakerMapPool {
                id: pool_id,
                name: pool
                    .attributes
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("Map pool")
                    .to_string(),
                min_rating: value_i32(&pool_link.attributes, "minRating"),
                max_rating: value_i32(&pool_link.attributes, "maxRating"),
                veto_tokens_per_player: value_i32(&pool_link.attributes, "vetoTokensPerPlayer")
                    .unwrap_or(0),
                max_tokens_per_map: value_i32(&pool_link.attributes, "maxTokensPerMap")
                    .unwrap_or(1),
                minimum_maps_after_veto: value_i32(&pool_link.attributes, "minimumMapsAfterVeto")
                    .unwrap_or(0),
                maps,
            })
        })
        .collect::<Vec<_>>();
    pools.sort_by_key(|pool| pool.min_rating.unwrap_or(i32::MIN));
    pools
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
            let reviews_summary = rel_target(&map_res.relationships, "reviewsSummary")
                .and_then(|key| index.get(&key));
            let rating_tenths = reviews_summary
                .and_then(|summary| summary.attributes.get("averageScore"))
                .and_then(Value::as_f64)
                .map(|rating| (rating * 10.0).round() as i32)
                .unwrap_or(0);
            let reviews = reviews_summary
                .and_then(|summary| value_i32(&summary.attributes, "reviews"))
                .unwrap_or(0);

            Some(VaultMap {
                map_id: map_res.id.parse().unwrap_or_default(),
                version_id: version.id.parse().unwrap_or_default(),
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
                version: value_string(&version.attributes, "version"),
                description: version
                    .attributes
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                map_type: map_res
                    .attributes
                    .get("mapType")
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
                version_games_played: version
                    .attributes
                    .get("gamesPlayed")
                    .and_then(Value::as_i64)
                    .unwrap_or(0) as i32,
                ranked: version
                    .attributes
                    .get("ranked")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                recommended: value_bool(&map_res.attributes, "recommended"),
                rating_tenths,
                reviews,
                created_at: version
                    .attributes
                    .get("createTime")
                    .or_else(|| map_res.attributes.get("createTime"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
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
                thumbnail_url_large: version
                    .attributes
                    .get("thumbnailUrlLarge")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            })
        })
        .collect()
}

/// Inert maps client: used offline and in tests (mirrors [`crate::infra::FakeReplay`]).
#[derive(Debug, Clone, Default)]
pub struct FakeMaps;

#[async_trait]
impl MapsPort for FakeMaps {
    async fn list_vault(&self) -> Result<Vec<VaultMap>, String> {
        Err("map vault is unavailable in offline mode".to_string())
    }

    async fn list_installed(&self) -> Result<Vec<InstalledMap>, String> {
        Err("map install listing is unavailable in offline mode".to_string())
    }

    async fn list_matchmaker_pools(
        &self,
        _queue_name: String,
    ) -> Result<Vec<MatchmakerMapPool>, String> {
        Ok(vec![MatchmakerMapPool {
            id: 1,
            name: "Offline sample pool".into(),
            min_rating: None,
            max_rating: None,
            veto_tokens_per_player: 2,
            max_tokens_per_map: 1,
            minimum_maps_after_veto: 1,
            maps: vec![MatchmakerPoolMap {
                assignment_id: 1,
                display_name: "Open Palms".into(),
                folder_name: "open_palms".into(),
                max_players: 4,
                width: 512,
                height: 512,
                thumbnail_url: String::new(),
            }],
        }])
    }

    async fn install_map(
        &self,
        _folder_name: String,
        _download_url: String,
    ) -> Result<Vec<InstalledMap>, String> {
        Err("map install is unavailable in offline mode".to_string())
    }

    async fn uninstall_map(&self, _folder_name: String) -> Result<Vec<InstalledMap>, String> {
        Err("map uninstall is unavailable in offline mode".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn derives_display_name_from_folder() {
        assert_eq!(display_name_from_folder("scmp_009.v0001"), "Scmp 009");
        assert_eq!(
            display_name_from_folder("setons_clutch.v0025"),
            "Setons Clutch"
        );
        assert_eq!(
            display_name_from_folder("no_version_suffix"),
            "No Version Suffix"
        );
    }

    #[tokio::test]
    async fn list_installed_dir_lists_subfolders_lowercased_and_sorted() {
        let dir = std::env::temp_dir().join(format!("forge-maps-test-{}", std::process::id()));
        tokio::fs::create_dir_all(dir.join("Scmp_009.v0001"))
            .await
            .unwrap();
        tokio::fs::create_dir_all(dir.join("adaptive_map.v0002"))
            .await
            .unwrap();
        tokio::fs::write(dir.join("not_a_dir.txt"), b"x")
            .await
            .unwrap();

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
        let installed = list_installed_dir(&dir)
            .await
            .expect("missing dir is not an error");
        assert!(installed.is_empty());
    }

    #[test]
    fn parses_vault_maps_resolving_version_and_author_through_included() {
        let doc: JsonApiDoc = serde_json::from_value(json!({
            "data": [
                {
                    "type": "map",
                    "id": "77",
                    "attributes": {
                        "displayName": "Seton's Clutch",
                        "gamesPlayed": 12345,
                        "mapType": "skirmish",
                        "recommended": true,
                        "createTime": "2020-01-02T03:04:05Z"
                    },
                    "relationships": {
                        "latestVersion": { "data": { "type": "mapVersion", "id": "9" } },
                        "author": { "data": { "type": "player", "id": "1" } },
                        "reviewsSummary": { "data": { "type": "reviewsSummary", "id": "15" } },
                    },
                },
            ],
            "included": [
                {
                    "type": "mapVersion",
                    "id": "9",
                    "attributes": {
                        "folderName": "scmp_009.v0001",
                        "version": 7,
                        "description": "A classic team map.",
                        "gamesPlayed": 12000,
                        "maxPlayers": 8,
                        "width": 1024,
                        "height": 1024,
                        "ranked": true,
                        "downloadUrl": "https://content.faforever.com/maps/scmp_009.zip",
                        "thumbnailUrlSmall": "https://content.faforever.com/maps/scmp_009.small.png",
                        "thumbnailUrlLarge": "https://content.faforever.com/maps/scmp_009.large.png",
                        "createTime": "2021-02-03T04:05:06Z"
                    },
                },
                {
                    "type": "player",
                    "id": "1",
                    "attributes": { "login": "Rackover" },
                },
                {
                    "type": "reviewsSummary",
                    "id": "15",
                    "attributes": { "averageScore": 4.34, "reviews": 27 },
                },
            ],
        }))
        .unwrap();

        let maps = parse_vault_maps(&doc);
        assert_eq!(maps.len(), 1);
        assert_eq!(maps[0].display_name, "Seton's Clutch");
        assert_eq!(maps[0].map_id, 77);
        assert_eq!(maps[0].version_id, 9);
        assert_eq!(maps[0].folder_name, "scmp_009.v0001");
        assert_eq!(maps[0].version, "7");
        assert_eq!(maps[0].description, "A classic team map.");
        assert_eq!(maps[0].map_type, "skirmish");
        assert_eq!(maps[0].author, Some("Rackover".to_string()));
        assert_eq!(maps[0].max_players, 8);
        assert_eq!(maps[0].games_played, 12345);
        assert_eq!(maps[0].version_games_played, 12000);
        assert!(maps[0].ranked);
        assert!(maps[0].recommended);
        assert_eq!(maps[0].rating_tenths, 43);
        assert_eq!(maps[0].reviews, 27);
        assert_eq!(maps[0].created_at, "2021-02-03T04:05:06Z");
        assert!(maps[0].thumbnail_url_large.ends_with("large.png"));
    }

    #[test]
    fn parse_vault_maps_skips_entries_missing_latest_version() {
        let doc: JsonApiDoc = serde_json::from_value(json!({
            "data": [{ "type": "map", "id": "1", "attributes": {}, "relationships": {} }],
        }))
        .unwrap();
        assert!(parse_vault_maps(&doc).is_empty());
    }

    #[test]
    fn uninstall_target_must_stay_inside_the_maps_directory() {
        let root = PathBuf::from("maps-root");
        assert_eq!(
            safe_map_target(&root, "open_palms.v0001").unwrap(),
            root.join("open_palms.v0001")
        );
        for name in ["..", "../outside", "nested/map", "C:\\Windows"] {
            assert!(safe_map_target(&root, name).is_err(), "accepted {name:?}");
        }
    }

    #[test]
    fn parses_matchmaker_pool_assignments_and_veto_limits() {
        let doc: JsonApiDoc = serde_json::from_value(json!({
            "data": [{
                "type": "matchmakerQueueMapPool",
                "id": "12",
                "attributes": {
                    "minRating": 800,
                    "maxRating": 1600,
                    "vetoTokensPerPlayer": 3,
                    "maxTokensPerMap": 2,
                    "minimumMapsAfterVeto": 5
                },
                "relationships": { "mapPool": { "data": { "type": "mapPool", "id": "4" } } }
            }],
            "included": [
                {
                    "type": "mapPool",
                    "id": "4",
                    "attributes": { "name": "Standard pool" },
                    "relationships": { "mapPoolAssignments": { "data": [{ "type": "mapPoolAssignment", "id": "91" }] } }
                },
                {
                    "type": "mapPoolAssignment",
                    "id": "91",
                    "relationships": { "mapVersion": { "data": { "type": "mapVersion", "id": "9" } } }
                },
                {
                    "type": "mapVersion",
                    "id": "9",
                    "attributes": { "folderName": "open_palms.v0001", "maxPlayers": 4, "width": 512, "height": 512, "thumbnailUrlSmall": "https://example.test/map.png" },
                    "relationships": { "map": { "data": { "type": "map", "id": "7" } } }
                },
                { "type": "map", "id": "7", "attributes": { "displayName": "Open Palms" } }
            ]
        }))
        .unwrap();

        let pools = parse_matchmaker_pools(&doc);
        assert_eq!(pools.len(), 1);
        assert_eq!(pools[0].id, 12);
        assert_eq!(pools[0].veto_tokens_per_player, 3);
        assert_eq!(pools[0].maps[0].assignment_id, 91);
        assert_eq!(pools[0].maps[0].display_name, "Open Palms");
    }

    #[tokio::test]
    async fn fake_maps_fails_cleanly() {
        let fake = FakeMaps;
        assert!(fake.list_vault().await.is_err());
        assert!(fake.list_installed().await.is_err());
        assert_eq!(
            fake.list_matchmaker_pools("ladder1v1".into())
                .await
                .unwrap()
                .len(),
            1
        );
        assert!(fake
            .install_map("x".into(), "http://x".into())
            .await
            .is_err());
        assert!(fake.uninstall_map("x".into()).await.is_err());
    }
}
