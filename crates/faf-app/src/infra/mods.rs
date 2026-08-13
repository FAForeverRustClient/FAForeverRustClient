//! Real mods client — vault browsing, local install management, and
//! enabling/disabling installed mods.
//!
//! Mirrors the Python client's `vaults/modvault/` + `fa/mods.py` (primary
//! source; cross-checked against the Java client's `ModService.java`):
//!
//! ## Vault listing
//! `GET {api_base}/data/mod`, `include=latestVersion`,
//! `filter=latestVersion.hidden=='false'`, sorted newest-first — same
//! JSON:API shape as the map vault (see `infra/maps.rs`).
//!
//! ## Installed mods
//! A folder scan of the user's mods folder — `<Documents>/My Games/Gas
//! Powered Games/Supreme Commander Forged Alliance/mods` (mirrors
//! `util.VAULTS_BASE_DIR` + a `mods` subfolder, same base as `maps_dir()`).
//! Each subfolder's `mod_info.lua` is parsed for `name`/`uid`/`version`/
//! `author`/`ui_only` — a small line-based key/value extractor, **not** a
//! full Lua parser (the reference clients' own `luaparser.py` handles
//! arbitrary nested tables; these six fields are always flat `key = value`
//! assignments in practice, confirmed against
//! `D:\py-client\src\vaults\modvault\utils.py::getModInfo`). Folders
//! without a valid `mod_info.lua` are skipped, not an error (mirrors
//! Python's `getInstalledMods` try/except-continue).
//!
//! ## Enable/disable
//! Unlike maps, mods can be toggled without uninstalling. Both reference
//! clients do this by reading/rewriting FA's own `game.prefs` file's
//! `active_mods = { ['uid'] = true, ... }` table — confirmed path via
//! Python's `util.LOCALFOLDER`/`PREFSFILENAME`
//! (`%LOCALAPPDATA%\Gas Powered Games\Supreme Commander Forged
//! Alliance\game.prefs`). Only *enabled* uids are ever written into the
//! table (mirrors `vaults/modvault/utils.py::setActiveMods` writing only
//! `['uid'] = true` entries and omitting disabled mods entirely) — a plain
//! balanced-brace/string scan rather than a regex dependency, since the
//! shape being parsed is this simple, fixed pattern, not arbitrary Lua.
//!
//! ## Install / uninstall
//! Installing downloads the version's zip (unauthenticated CDN, like maps)
//! and extracts it directly into the mods folder — its own top-level zip
//! entry is the mod's folder name, same as maps. Uninstalling removes that
//! directory and also scrubs the mod's uid from `game.prefs`'s active set
//! if present (an uninstalled mod can't stay "enabled").

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use async_trait::async_trait;
use faf_domain::state::{InstalledMod, ModType, VaultMod};
use serde::Deserialize;
use serde_json::Value;

use crate::infra::env_or;
use crate::ports::ModsPort;

/// Mods per vault page fetched in [`ModsClient::list_vault`] — mirrors
/// `infra::maps`'s identical pagination constants.
const VAULT_PAGE_SIZE: usize = 100;
const MAX_VAULT_PAGES: u32 = 50;

#[derive(Debug, Clone)]
pub struct ModsConfig {
    /// FAF Data API base, which serves `/data/mod` — same host as the map
    /// and replay vaults.
    pub api_base: String,
}

impl ModsConfig {
    pub fn faf() -> Self {
        Self {
            api_base: env_or("FAF_API_BASE", "https://api.faforever.com"),
        }
    }
}

pub struct ModsClient {
    config: ModsConfig,
    tokens: crate::infra::session::TokenStore,
    http: reqwest::Client,
}

impl ModsClient {
    pub fn new(config: ModsConfig, tokens: crate::infra::session::TokenStore) -> Self {
        Self {
            config,
            tokens,
            http: reqwest::Client::new(),
        }
    }

    pub fn faf(tokens: crate::infra::session::TokenStore) -> Self {
        Self::new(ModsConfig::faf(), tokens)
    }
}

#[async_trait]
impl ModsPort for ModsClient {
    async fn list_vault(&self) -> Result<Vec<VaultMod>, String> {
        let token = self
            .tokens
            .get()
            .ok_or_else(|| "not logged in".to_string())?;

        // Same "fetch every page up front" reasoning as `MapsClient::list_vault`
        // — no paging UI yet, and a mod search is useless if most of the
        // vault is missing.
        let mut all_mods = Vec::new();
        for page in 1..=MAX_VAULT_PAGES {
            let mut url = url::Url::parse(&format!("{}/data/mod", self.config.api_base))
                .map_err(|e| format!("invalid API base: {e}"))?;
            url.query_pairs_mut()
                .append_pair("filter", "latestVersion.hidden=='false'")
                .append_pair("sort", "-latestVersion.createTime")
                .append_pair("page[size]", &VAULT_PAGE_SIZE.to_string())
                .append_pair("page[number]", &page.to_string())
                .append_pair("include", "latestVersion");

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
                    "/data/mod returned {status}: {}",
                    body.chars().take(200).collect::<String>()
                ));
            }

            let doc: JsonApiDoc =
                serde_json::from_str(&body).map_err(|e| format!("invalid JSON: {e}"))?;
            let page_len = doc.data.len();
            all_mods.extend(parse_vault_mods(&doc));

            if page_len < VAULT_PAGE_SIZE {
                break;
            }
        }
        Ok(all_mods)
    }

    async fn list_installed(&self) -> Result<Vec<InstalledMod>, String> {
        list_installed_dir(&mods_dir()).await
    }

    async fn install_mod(
        &self,
        uid: String,
        download_url: String,
    ) -> Result<Vec<InstalledMod>, String> {
        let resp = self
            .http
            .get(&download_url)
            .send()
            .await
            .map_err(|e| format!("could not download mod {uid}: {e}"))?;
        let status = resp.status();
        if !status.is_success() {
            return Err(format!("could not download mod {uid}: {status}"));
        }
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| format!("could not read mod {uid}: {e}"))?;

        let dest = mods_dir();
        tokio::fs::create_dir_all(&dest)
            .await
            .map_err(|e| format!("could not create mods folder: {e}"))?;

        let dest_clone = dest.clone();
        tokio::task::spawn_blocking(move || extract_zip(&bytes, &dest_clone))
            .await
            .map_err(|e| format!("extraction task panicked: {e}"))??;

        list_installed_dir(&dest).await
    }

    async fn uninstall_mod(&self, folder_name: String) -> Result<Vec<InstalledMod>, String> {
        let dir = mods_dir();
        let target = dir.join(&folder_name);

        // Read the uid before deleting so we can also scrub it from
        // game.prefs — an uninstalled mod can't stay "enabled".
        let uid = tokio::fs::read_to_string(target.join("mod_info.lua"))
            .await
            .ok()
            .and_then(|contents| parse_mod_info(&contents))
            .map(|info| info.uid);

        if target.exists() {
            tokio::fs::remove_dir_all(&target)
                .await
                .map_err(|e| format!("could not remove {}: {e}", target.display()))?;
        }

        if let Some(uid) = uid {
            let mut uids = read_active_mod_uids().await;
            uids.retain(|u| u != &uid);
            write_active_mod_uids_to_disk(&uids).await?;
        }

        list_installed_dir(&dir).await
    }

    async fn toggle_mod(&self, uid: String, enabled: bool) -> Result<Vec<InstalledMod>, String> {
        let mut uids = read_active_mod_uids().await;
        uids.retain(|u| u != &uid);
        if enabled {
            uids.push(uid);
        }
        write_active_mod_uids_to_disk(&uids).await?;
        list_installed_dir(&mods_dir()).await
    }

    async fn set_active_mods(&self, uids: Vec<String>) -> Result<(), String> {
        write_active_mod_uids_to_disk(&uids).await
    }
}

/// Extract a zip archive's bytes directly into `dest` (mirrors
/// `infra::maps::extract_zip` — its own top-level entry is the mod's
/// folder name). Runs on a blocking thread since the `zip` crate is
/// synchronous.
fn extract_zip(bytes: &[u8], dest: &Path) -> Result<(), String> {
    let reader = std::io::Cursor::new(bytes);
    let mut archive =
        zip::ZipArchive::new(reader).map_err(|e| format!("not a valid zip archive: {e}"))?;
    archive
        .extract(dest)
        .map_err(|e| format!("could not extract zip into {}: {e}", dest.display()))
}

/// Scans `dir` for installed mod folders, parsing each one's
/// `mod_info.lua` and cross-referencing `game.prefs` for `enabled`. The
/// testable body of [`ModsClient::list_installed`]/post-change rescans.
pub(crate) async fn list_installed_dir(dir: &Path) -> Result<Vec<InstalledMod>, String> {
    let mut entries = match tokio::fs::read_dir(dir).await {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("could not read {}: {e}", dir.display())),
    };

    let active_uids = read_active_mod_uids().await;

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
        let folder_name = entry.file_name().to_string_lossy().to_string();
        let Ok(contents) = tokio::fs::read_to_string(entry.path().join("mod_info.lua")).await
        else {
            continue;
        };
        let Some(info) = parse_mod_info(&contents) else {
            continue;
        };
        let enabled = active_uids.contains(&info.uid);
        installed.push(InstalledMod {
            folder_name,
            uid: info.uid,
            display_name: info.name,
            version: info.version,
            author: info.author,
            mod_type: if info.ui_only { ModType::Ui } else { ModType::Sim },
            enabled,
        });
    }
    installed.sort_by(|a, b| a.display_name.cmp(&b.display_name));
    Ok(installed)
}

/// The subset of `mod_info.lua` fields this client needs (mirrors the
/// Python client's `getModInfo`'s search dict — see the module docs).
struct ModInfoFields {
    name: String,
    uid: String,
    version: String,
    author: String,
    ui_only: bool,
}

/// Parses a `mod_info.lua` file's flat `key = value` assignments. Not a
/// full Lua parser — see the module docs for why that's fine for these six
/// scalar fields. Returns `None` if `uid` is missing (mirrors Python
/// logging a warning and skipping the mod).
fn parse_mod_info(contents: &str) -> Option<ModInfoFields> {
    let mut fields: HashMap<String, String> = HashMap::new();
    for raw_line in contents.lines() {
        // Strip a trailing `-- comment`.
        let line = match raw_line.find("--") {
            Some(idx) => &raw_line[..idx],
            None => raw_line,
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim().to_lowercase();
        let mut value = value.trim();
        if let Some(v) = value.strip_suffix(',') {
            value = v.trim();
        }
        let value = value.trim_matches(|c| c == '"' || c == '\'').to_string();
        fields.insert(key, value);
    }

    let uid = fields.get("uid")?.clone();
    let name = fields.get("name").cloned().unwrap_or_else(|| uid.clone());
    // Matches Python's `getModInfo` defaults exactly.
    let version = fields.get("version").cloned().unwrap_or_else(|| "1".to_string());
    let author = fields.get("author").cloned().unwrap_or_default();
    let ui_only = fields.get("ui_only").is_some_and(|v| v == "true");

    Some(ModInfoFields {
        name,
        uid,
        version,
        author,
        ui_only,
    })
}

/// The user's mods folder: `<Documents>/My Games/Gas Powered Games/Supreme
/// Commander Forged Alliance/mods` (mirrors `infra::maps::maps_dir`'s
/// identical base, `mods` instead of `maps`). `FAF_MODS_DIR` overrides it.
pub(crate) fn mods_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("FAF_MODS_DIR") {
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
        .join("mods")
}

/// FA's own `game.prefs` file: `%LOCALAPPDATA%\Gas Powered Games\Supreme
/// Commander Forged Alliance\game.prefs` (confirmed via the Python
/// client's `util.LOCALFOLDER`/`PREFSFILENAME`). `FAF_GAME_PREFS_PATH`
/// overrides it (tests, alternate installs).
fn game_prefs_path() -> PathBuf {
    if let Ok(path) = std::env::var("FAF_GAME_PREFS_PATH") {
        if !path.is_empty() {
            return PathBuf::from(path);
        }
    }
    let local = directories::BaseDirs::new()
        .map(|b| b.data_local_dir().to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    local
        .join("Gas Powered Games")
        .join("Supreme Commander Forged Alliance")
        .join("game.prefs")
}

async fn read_active_mod_uids() -> Vec<String> {
    match tokio::fs::read_to_string(game_prefs_path()).await {
        Ok(contents) => parse_active_mod_uids(&contents),
        Err(_) => Vec::new(),
    }
}

pub(crate) async fn write_active_mod_uids_to_disk(uids: &[String]) -> Result<(), String> {
    let path = game_prefs_path();
    // A read failure (missing file, locked, non-UTF-8 bytes, …) must abort —
    // never be treated as an empty file. `game.prefs` is FA's *entire*
    // config (hotkeys, video, audio, profiles); the previous
    // `.unwrap_or_default()` would have replaced all of it with a lone
    // `active_mods` block on any read hiccup. Mirrors Python's
    // `setActiveMods` returning `False` when it can't read the file, and
    // never creating one that doesn't exist.
    let contents = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("could not read {} — leaving it untouched: {e}", path.display()))?;
    let updated = write_active_mod_uids(&contents, uids);
    tokio::fs::write(&path, updated)
        .await
        .map_err(|e| format!("could not write {}: {e}", path.display()))
}

/// Byte range `[start, end]` (inclusive) of the **whole**
/// `active_mods = { ... }` block — from the first byte of `active_mods` to
/// the closing brace — in `game.prefs`'s contents, if present. A balanced-
/// brace scan rather than the reference clients' regex
/// (`active_mods\s*=\s*{.*?}`), without adding a regex dependency for one
/// small parser.
///
/// Two hard-won properties, both mirroring what Python's regex gives for
/// free (and both confirmed live as corruption vectors when absent):
/// - The span *includes* the `active_mods = ` prefix. An earlier version
///   returned only the brace span while [`write_active_mod_uids`] spliced
///   in a replacement that itself starts with `active_mods = ` — producing
///   `active_mods = active_mods = { … }`, which FA's Lua parser rejects,
///   whereupon FA discards the *entire* prefs file (renames it `.bad` and
///   regenerates defaults — every hotkey and setting gone).
/// - The key must be followed by `\s*=\s*{` to match, like the regex. A
///   bare `.find('{')` after any occurrence of the substring `active_mods`
///   could otherwise pair the key with some unrelated later table and
///   splice away everything in between.
fn find_active_mods_block(contents: &str) -> Option<(usize, usize)> {
    const KEY: &str = "active_mods";
    let mut from = 0;
    while let Some(rel) = contents[from..].find(KEY) {
        let start = from + rel;
        let after_key = contents[start + KEY.len()..].trim_start();
        if let Some(after_eq) = after_key.strip_prefix('=') {
            let after_eq = after_eq.trim_start();
            if after_eq.starts_with('{') {
                // All slices above borrow from `contents`, so the remaining
                // length gives the brace's byte offset directly.
                let brace_start = contents.len() - after_eq.len();
                let mut depth = 0i32;
                for (i, c) in contents[brace_start..].char_indices() {
                    match c {
                        '{' => depth += 1,
                        '}' => {
                            depth -= 1;
                            if depth == 0 {
                                return Some((start, brace_start + i));
                            }
                        }
                        _ => {}
                    }
                }
                return None; // unbalanced braces — refuse to splice blindly
            }
        }
        from = start + KEY.len();
    }
    None
}

/// Distinct uids with `['uid'] = true` in the `active_mods` table. Missing
/// file, missing section, or a malformed table all return an empty list
/// (mirrors the Python client's own graceful fallback), not an error.
fn parse_active_mod_uids(contents: &str) -> Vec<String> {
    let Some((start, end)) = find_active_mods_block(contents) else {
        return Vec::new();
    };
    let block = &contents[start..=end];

    let mut uids = Vec::new();
    let mut rest = block;
    while let Some(open) = rest.find("['") {
        rest = &rest[open + 2..];
        let Some(close) = rest.find("']") else {
            break;
        };
        let uid = rest[..close].to_string();
        rest = &rest[close + 2..];
        let Some(eq) = rest.find('=') else {
            break;
        };
        let after_eq = rest[eq + 1..].trim_start();
        if after_eq.starts_with("true") {
            uids.push(uid);
        }
        rest = after_eq;
    }
    uids
}

/// Rebuilds `game.prefs`'s `active_mods` block (or appends a fresh one if
/// absent), leaving the rest of the file untouched — mirrors Python's
/// `setActiveMods` regex-substitution approach exactly, since `game.prefs`
/// is a shared FA config file with many other unrelated keys we must not
/// clobber. Only enabled uids are ever written (disabled mods are simply
/// omitted, matching `setActiveMods` writing only `['uid'] = true` entries).
fn write_active_mod_uids(contents: &str, uids: &[String]) -> String {
    let block = build_active_mods_block(uids);
    match find_active_mods_block(contents) {
        Some((start, end)) => format!("{}{}{}", &contents[..start], block, &contents[end + 1..]),
        None => {
            let mut new_contents = contents.to_string();
            if !new_contents.is_empty() && !new_contents.ends_with('\n') {
                new_contents.push('\n');
            }
            new_contents.push_str(&block);
            new_contents.push('\n');
            new_contents
        }
    }
}

fn build_active_mods_block(uids: &[String]) -> String {
    let entries: Vec<String> = uids.iter().map(|uid| format!("    ['{uid}'] = true")).collect();
    format!("active_mods = {{\n{}\n}}", entries.join(",\n"))
}

/// A JSON:API document: the top-level resources plus everything the
/// `include` query param pulled in (mirrors `infra::replay::JsonApiDoc`).
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

fn parse_vault_mods(doc: &JsonApiDoc) -> Vec<VaultMod> {
    let index = resource_index(&doc.included);
    doc.data
        .iter()
        .filter_map(|mod_res| {
            let (_, version_id) = rel_target(&mod_res.relationships, "latestVersion")?;
            let version = index.get(&("modVersion".to_string(), version_id))?;

            // The exact wire value for `modType` (`"UI"`/`"SIM"` or
            // something else) couldn't be verified against a live
            // authenticated call this session — same caveat as the
            // leaderboard's `leagueLeaderboard` type name. Defaults to
            // `Sim`, matching the reference clients' own `ui_only`
            // default of `false`.
            let mod_type = version
                .attributes
                .get("modType")
                .and_then(Value::as_str)
                .map(|s| {
                    if s.eq_ignore_ascii_case("ui") {
                        ModType::Ui
                    } else {
                        ModType::Sim
                    }
                })
                .unwrap_or(ModType::Sim);

            let version_str = match version.attributes.get("version") {
                Some(Value::String(s)) => s.clone(),
                Some(Value::Number(n)) => n.to_string(),
                _ => "1".to_string(),
            };

            Some(VaultMod {
                display_name: mod_res
                    .attributes
                    .get("displayName")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown mod")
                    .to_string(),
                author: mod_res
                    .attributes
                    .get("author")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                uid: version
                    .attributes
                    .get("uid")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                version: version_str,
                mod_type,
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
                    .get("thumbnailUrl")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            })
        })
        .collect()
}

/// Inert mods client — used offline and in tests (mirrors
/// [`crate::infra::FakeMaps`]).
#[derive(Debug, Clone, Default)]
pub struct FakeMods;

#[async_trait]
impl ModsPort for FakeMods {
    async fn list_vault(&self) -> Result<Vec<VaultMod>, String> {
        Err("mod vault is disabled (FAF_REAL_LAUNCH not set)".to_string())
    }

    async fn list_installed(&self) -> Result<Vec<InstalledMod>, String> {
        Err("mod install listing is disabled (FAF_REAL_LAUNCH not set)".to_string())
    }

    async fn install_mod(&self, _uid: String, _download_url: String) -> Result<Vec<InstalledMod>, String> {
        Err("mod install is disabled (FAF_REAL_LAUNCH not set)".to_string())
    }

    async fn uninstall_mod(&self, _folder_name: String) -> Result<Vec<InstalledMod>, String> {
        Err("mod uninstall is disabled (FAF_REAL_LAUNCH not set)".to_string())
    }

    async fn toggle_mod(&self, _uid: String, _enabled: bool) -> Result<Vec<InstalledMod>, String> {
        Err("mod toggling is disabled (FAF_REAL_LAUNCH not set)".to_string())
    }

    async fn set_active_mods(&self, _uids: Vec<String>) -> Result<(), String> {
        Err("mod activation is disabled (FAF_REAL_LAUNCH not set)".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SAMPLE_MOD_INFO: &str = r#"
        -- FAF mod
        name = "Total Mayhem"
        uid = "dcd9a5e5-5444-4266-a016-ccbbff528268"
        version = 12
        author = "Some Author"
        ui_only = false
        description = "Extended content"
    "#;

    #[test]
    fn parses_mod_info_flat_fields() {
        let info = parse_mod_info(SAMPLE_MOD_INFO).expect("should parse");
        assert_eq!(info.name, "Total Mayhem");
        assert_eq!(info.uid, "dcd9a5e5-5444-4266-a016-ccbbff528268");
        assert_eq!(info.version, "12");
        assert_eq!(info.author, "Some Author");
        assert!(!info.ui_only);
    }

    #[test]
    fn parse_mod_info_none_without_uid() {
        assert!(parse_mod_info("name = \"No UID Mod\"").is_none());
    }

    #[test]
    fn parse_mod_info_applies_defaults() {
        let info = parse_mod_info("uid = \"abc-123\"").expect("should parse");
        assert_eq!(info.name, "abc-123");
        assert_eq!(info.version, "1");
        assert_eq!(info.author, "");
        assert!(!info.ui_only);
    }

    #[test]
    fn parse_mod_info_recognizes_ui_only() {
        let info = parse_mod_info("uid = \"abc-123\"\nui_only = true").expect("should parse");
        assert!(info.ui_only);
    }

    #[test]
    fn active_mods_round_trips_through_write_then_parse() {
        let original = "some_other_setting = 1\nactive_mods = {\n    ['old-uid'] = true,\n}\nmore_settings = 2\n";
        let updated = write_active_mod_uids(original, &["new-uid".to_string(), "other-uid".to_string()]);
        assert!(updated.contains("some_other_setting = 1"));
        assert!(updated.contains("more_settings = 2"));
        assert!(!updated.contains("old-uid"));

        let uids = parse_active_mod_uids(&updated);
        assert_eq!(uids, vec!["new-uid".to_string(), "other-uid".to_string()]);
    }

    #[test]
    fn active_mods_appends_block_when_missing() {
        let original = "some_setting = 1\n";
        let updated = write_active_mod_uids(original, &["abc-123".to_string()]);
        assert!(updated.contains("some_setting = 1"));
        assert_eq!(parse_active_mod_uids(&updated), vec!["abc-123".to_string()]);
    }

    /// Regression: replacing an existing block must never leave a doubled
    /// `active_mods = active_mods = { … }` behind. Semantic round-trip
    /// tests can't catch this ([`parse_active_mod_uids`] skips to the first
    /// brace, so it parses the doubled form happily) — but FA's Lua parser
    /// rejects it and then throws away the user's *entire* prefs file
    /// (renamed `.bad`, defaults regenerated: all hotkeys/settings lost).
    /// Confirmed live before this fix.
    #[test]
    fn active_mods_rewrite_emits_the_key_exactly_once() {
        let original =
            "keys = { ['F1'] = 'help' }\nactive_mods = {\n    ['old-uid'] = true\n}\ntail = 2\n";
        let updated = write_active_mod_uids(original, &["new-uid".to_string()]);
        assert_eq!(
            updated.matches("active_mods").count(),
            1,
            "doubled/leftover active_mods key in: {updated}"
        );
        assert!(updated.contains("keys = { ['F1'] = 'help' }"));
        assert!(updated.contains("tail = 2"));

        // Rewriting the rewrite must stay stable too (idempotence guards
        // against prefix duplication compounding across launches).
        let twice = write_active_mod_uids(&updated, &["new-uid".to_string()]);
        assert_eq!(twice, updated);
    }

    /// The key must be followed by `= {` to count as the block — a stray
    /// `active_mods` substring elsewhere (comment, other key) must not make
    /// the splice grab an unrelated table's braces.
    #[test]
    fn find_active_mods_block_requires_assignment_shape() {
        let contents = "my_active_mods_note = 1\nother = { ['x'] = true }\n";
        assert_eq!(find_active_mods_block(contents), None);

        let real = "note_about_active_mods = 1\nactive_mods = {\n    ['a'] = true\n}\n";
        let (start, end) = find_active_mods_block(real).expect("should find the real block");
        assert!(real[start..].starts_with("active_mods = {"));
        assert_eq!(&real[end..=end], "}");
    }

    #[test]
    fn parse_active_mod_uids_defaults_gracefully_without_section() {
        assert!(parse_active_mod_uids("no_active_mods_here = 1\n").is_empty());
    }

    #[tokio::test]
    async fn list_installed_dir_missing_folder_returns_empty() {
        let dir = std::env::temp_dir().join("forge-mods-does-not-exist");
        let installed = list_installed_dir(&dir).await.expect("missing dir is not an error");
        assert!(installed.is_empty());
    }

    #[tokio::test]
    async fn list_installed_dir_parses_mod_info_and_skips_invalid_folders() {
        let dir = std::env::temp_dir().join(format!("forge-mods-test-{}", std::process::id()));
        let good = dir.join("total_mayhem");
        tokio::fs::create_dir_all(&good).await.unwrap();
        tokio::fs::write(good.join("mod_info.lua"), SAMPLE_MOD_INFO).await.unwrap();

        let bad = dir.join("not_a_mod");
        tokio::fs::create_dir_all(&bad).await.unwrap();
        // No mod_info.lua at all — should be skipped.

        let installed = list_installed_dir(&dir).await.expect("should list");
        assert_eq!(installed.len(), 1);
        assert_eq!(installed[0].uid, "dcd9a5e5-5444-4266-a016-ccbbff528268");
        assert_eq!(installed[0].folder_name, "total_mayhem");
        assert!(!installed[0].enabled); // no game.prefs override in this test env

        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[test]
    fn parses_vault_mods_resolving_version_through_included() {
        let doc: JsonApiDoc = serde_json::from_value(json!({
            "data": [
                {
                    "type": "mod",
                    "id": "77",
                    "attributes": { "displayName": "Total Mayhem", "author": "Some Author" },
                    "relationships": {
                        "latestVersion": { "data": { "type": "modVersion", "id": "9" } },
                    },
                },
            ],
            "included": [
                {
                    "type": "modVersion",
                    "id": "9",
                    "attributes": {
                        "uid": "dcd9a5e5-5444-4266-a016-ccbbff528268",
                        "version": 12,
                        "modType": "SIM",
                        "ranked": false,
                        "downloadUrl": "https://content.faforever.com/mods/total_mayhem.zip",
                        "thumbnailUrl": "https://content.faforever.com/mods/total_mayhem.png",
                    },
                },
            ],
        }))
        .unwrap();

        let mods = parse_vault_mods(&doc);
        assert_eq!(mods.len(), 1);
        assert_eq!(mods[0].display_name, "Total Mayhem");
        assert_eq!(mods[0].author, "Some Author");
        assert_eq!(mods[0].uid, "dcd9a5e5-5444-4266-a016-ccbbff528268");
        assert_eq!(mods[0].version, "12");
        assert_eq!(mods[0].mod_type, ModType::Sim);
    }

    #[test]
    fn parse_vault_mods_skips_entries_missing_latest_version() {
        let doc: JsonApiDoc = serde_json::from_value(json!({
            "data": [{ "type": "mod", "id": "1", "attributes": {}, "relationships": {} }],
        }))
        .unwrap();
        assert!(parse_vault_mods(&doc).is_empty());
    }

    #[tokio::test]
    async fn fake_mods_fails_cleanly() {
        let fake = FakeMods;
        assert!(fake.list_vault().await.is_err());
        assert!(fake.list_installed().await.is_err());
        assert!(fake.install_mod("x".into(), "http://x".into()).await.is_err());
        assert!(fake.uninstall_mod("x".into()).await.is_err());
        assert!(fake.toggle_mod("x".into(), true).await.is_err());
    }
}
