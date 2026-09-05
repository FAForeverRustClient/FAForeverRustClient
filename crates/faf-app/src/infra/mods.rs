//! Real mods client: vault browsing, local install management, and
//! enabling/disabling installed mods.
//!
//! Mirrors the Python client's `vaults/modvault/` + `fa/mods.py` (primary
//! source; cross-checked against the Java client's `ModService.java`):
//!
//! ## Vault listing
//! `GET {api_base}/data/mod`, including the latest version, uploader, and
//! review summary,
//! `filter=latestVersion.hidden=='false'`, sorted newest-first: same
//! JSON:API shape as the map vault (see `infra/maps.rs`).
//!
//! ## Installed mods
//! A folder scan of the user's mods folder: `<Documents>/My Games/Gas
//! Powered Games/Supreme Commander Forged Alliance/mods` (mirrors
//! `util.VAULTS_BASE_DIR` + a `mods` subfolder, same base as `maps_dir()`).
//! Each subfolder's `mod_info.lua` is parsed for `name`/`uid`/`version`/
//! `author`/`description`/`ui_only`: a small line-based key/value extractor,
//! **not** a full Lua parser (the reference clients' own `luaparser.py` handles
//! arbitrary nested tables; these seven fields are always flat `key = value`
//! assignments in practice, confirmed against
//! `context/python_client/src/vaults/modvault/utils.py::getModInfo`). Folders
//! without a valid `mod_info.lua` are skipped, not an error (mirrors
//! Python's `getInstalledMods` try/except-continue).
//!
//! ## Enable/disable
//! Unlike maps, mods can be toggled without uninstalling. Both reference
//! clients do this by reading/rewriting FA's own `game.prefs` file's
//! `active_mods = { ['uid'] = true, ... }` table: confirmed path via
//! Python's `util.LOCALFOLDER`/`PREFSFILENAME`
//! (`%LOCALAPPDATA%\Gas Powered Games\Supreme Commander Forged
//! Alliance\game.prefs`). Only *enabled* uids are ever written into the
//! table (mirrors `vaults/modvault/utils.py::setActiveMods` writing only
//! `['uid'] = true` entries and omitting disabled mods entirely): a plain
//! balanced-brace/string scan rather than a regex dependency, since the
//! shape being parsed is this simple, fixed pattern, not arbitrary Lua.
//!
//! ## Install / uninstall
//! Installing downloads the version's zip (unauthenticated CDN, like maps)
//! and extracts it directly into the mods folder: its own top-level zip
//! entry is the mod's folder name, same as maps. Uninstalling removes that
//! directory and also scrubs the mod's uid from `game.prefs`'s active set
//! if present (an uninstalled mod can't stay "enabled").

use std::collections::{BTreeMap, HashMap};
use std::path::{Component, Path, PathBuf};

use async_trait::async_trait;
use faf_domain::protocol::vault_query::ModVaultQuery;
use faf_domain::state::{InstalledMod, ModType, ModVersionConflict, VaultMod};
use serde_json::Value;

use crate::infra::env_or;
use crate::infra::jsonapi::{
    fetch_all_pages, fetch_document, find_rel_resource, meta_page_i32, rel_target, resource_index,
    total_pages, value_bool, value_f64, value_i32, JsonApiDoc, JsonApiResource,
};
use crate::infra::vault_install::{
    archive_root_name, bounded_body, install_archive, validate_url, MAX_DOWNLOAD_BYTES,
};
use crate::ports::{ModPrepFailure, ModSearchPage, ModsPort};

/// Mods per vault page fetched in [`ModsClient::list_vault`]: mirrors
/// `infra::maps`'s identical pagination constants.
const VAULT_PAGE_SIZE: usize = 100;
const MAX_VAULT_PAGES: u32 = 200;

#[derive(Debug, Clone)]
pub struct ModsConfig {
    /// FAF Data API base, which serves `/data/mod`: same host as the map
    /// and replay vaults.
    pub api_base: String,
    /// Trusted origin for mod archives returned by the Data API.
    pub content_base: String,
}

impl ModsConfig {
    pub fn faf() -> Self {
        Self {
            api_base: env_or("FAF_API_BASE", "https://api.faforever.com"),
            content_base: env_or("FAF_CONTENT_BASE", "https://content.faforever.com"),
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
            http: super::http::shared_http_client(),
        }
    }

    pub fn faf(tokens: crate::infra::session::TokenStore) -> Self {
        Self::new(ModsConfig::faf(), tokens)
    }

    /// Fetch a mod version's zip, with the vault's origin and size envelope.
    async fn download_mod_archive(&self, uid: &str, download_url: &str) -> Result<Vec<u8>, String> {
        validate_url(download_url, &self.config.content_base, "mods")?;
        let resp = self
            .http
            .get(download_url)
            .send()
            .await
            .map_err(|e| format!("could not download mod {uid}: {e}"))?;
        validate_url(resp.url().as_str(), &self.config.content_base, "mods")?;
        let status = resp.status();
        if !status.is_success() {
            return Err(format!("could not download mod {uid}: {status}"));
        }
        bounded_body(resp, &format!("mod {uid}"), MAX_DOWNLOAD_BYTES).await
    }

    /// Extract a fetched archive into the mods folder, refusing one whose
    /// `mod_info.lua` does not carry the uid that was asked for.
    async fn extract_mod_archive(&self, uid: &str, bytes: Vec<u8>) -> Result<(), String> {
        let dest = mods_dir();
        tokio::fs::create_dir_all(&dest)
            .await
            .map_err(|e| format!("could not create mods folder: {e}"))?;

        let expected_uid = uid.to_owned();
        tokio::task::spawn_blocking(move || {
            install_archive(&bytes, &dest, None, |staged_root| {
                let info_path = staged_root.join("mod_info.lua");
                let contents = std::fs::read_to_string(&info_path)
                    .map_err(|error| format!("could not read {}: {error}", info_path.display()))?;
                let info = parse_mod_info(&contents)
                    .ok_or_else(|| "downloaded mod has no valid mod_info.lua".to_string())?;
                if info.uid != expected_uid {
                    return Err(format!(
                        "downloaded mod uid {:?} does not match expected uid {:?}",
                        info.uid, expected_uid
                    ));
                }
                Ok(())
            })
        })
        .await
        .map_err(|e| format!("extraction task panicked: {e}"))??;
        Ok(())
    }

    async fn mod_download_url(&self, uid: &str) -> Result<String, String> {
        if uid.is_empty()
            || !uid
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        {
            return Err("the game supplied an invalid simulation-mod uid".into());
        }
        let token = self
            .tokens
            .get()
            .ok_or_else(|| "not logged in".to_string())?;
        let mut url = url::Url::parse(&format!("{}/data/modVersion", self.config.api_base))
            .map_err(|error| format!("invalid API base: {error}"))?;
        url.query_pairs_mut()
            .append_pair("filter", &format!(r#"uid=="{uid}""#))
            .append_pair("page[size]", "1");
        let document = fetch_document(&self.http, url, &token).await?;
        document
            .data
            .into_iter()
            .next()
            .and_then(|resource| {
                resource
                    .attributes
                    .get("downloadUrl")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .ok_or_else(|| format!("simulation mod {uid} was not found in the vault"))
    }
}

#[async_trait]
impl ModsPort for ModsClient {
    async fn list_vault(&self) -> Result<Vec<VaultMod>, String> {
        let token = self
            .tokens
            .get()
            .ok_or_else(|| "not logged in".to_string())?;

        // Same "fetch every page up front" reasoning as `MapsClient::list_vault`,
        // minus its lookup-index duty: a mod search is useless if most of the
        // vault is missing and there is no paging UI yet.
        let api_base = self.config.api_base.clone();
        let docs = fetch_all_pages(
            &self.http,
            &token,
            MAX_VAULT_PAGES,
            VAULT_PAGE_SIZE,
            |page| {
                let mut url = url::Url::parse(&format!("{api_base}/data/mod"))
                    .map_err(|e| format!("invalid API base: {e}"))?;
                url.query_pairs_mut()
                    .append_pair("filter", "latestVersion.hidden=='false'")
                    .append_pair("sort", "-latestVersion.createTime")
                    .append_pair("page[size]", &VAULT_PAGE_SIZE.to_string())
                    .append_pair("page[number]", &page.to_string())
                    .append_pair("include", "latestVersion,reviewsSummary,uploader");
                Ok(url)
            },
        )
        .await?;

        let mut all_mods = Vec::new();
        for doc in &docs {
            all_mods.extend(parse_vault_mods(doc));
        }
        Ok(all_mods)
    }

    async fn search_vault(&self, query: ModVaultQuery) -> Result<ModSearchPage, String> {
        let token = self
            .tokens
            .get()
            .ok_or_else(|| "not logged in".to_string())?;

        let mut url = url::Url::parse(&format!("{}/data/mod", self.config.api_base))
            .map_err(|e| format!("invalid API base: {e}"))?;
        {
            let mut pairs = url.query_pairs_mut();
            if let Some(filter) = query.build_filter() {
                pairs.append_pair("filter", &filter);
            }
            pairs
                .append_pair("sort", &query.sort_param())
                .append_pair("page[size]", &query.page_size.to_string())
                .append_pair("page[number]", &query.page.max(1).to_string())
                .append_key_only("page[totals]")
                .append_pair("include", "latestVersion,reviewsSummary,uploader");
        }

        let doc = fetch_document(&self.http, url, &token).await?;
        Ok(ModSearchPage {
            mods: parse_vault_mods(&doc),
            total_pages: total_pages(&doc.meta, query.page_size),
            total_records: meta_page_i32(&doc.meta, "totalRecords"),
        })
    }

    async fn list_installed(&self) -> Result<Vec<InstalledMod>, String> {
        list_installed_dir(&mods_dir()).await
    }

    async fn install_mod(
        &self,
        uid: String,
        download_url: String,
    ) -> Result<Vec<InstalledMod>, String> {
        let bytes = self.download_mod_archive(&uid, &download_url).await?;
        self.extract_mod_archive(&uid, bytes).await?;
        list_installed_dir(&mods_dir()).await
    }

    async fn uninstall_mod(&self, folder_name: String) -> Result<Vec<InstalledMod>, String> {
        let dir = mods_dir();
        let target = safe_mod_target(&dir, &folder_name)?;

        // Read the uid before deleting so we can also scrub it from
        // game.prefs: an uninstalled mod can't stay "enabled".
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

    async fn set_active_mods(&self, uids: Vec<String>) -> Result<Vec<InstalledMod>, String> {
        // Written verbatim rather than filtered against the installed list: the
        // caller decides what is active, and a uid whose folder is gone is inert
        // to the game anyway.
        write_active_mod_uids_to_disk(&uids).await?;
        list_installed_dir(&mods_dir()).await
    }

    async fn ensure_game_mods(
        &self,
        mods: &BTreeMap<String, String>,
        replace_conflicts: bool,
    ) -> Result<(), ModPrepFailure> {
        if mods.is_empty() {
            return Ok(());
        }
        let installed = self
            .list_installed()
            .await
            .map_err(ModPrepFailure::Failed)?;
        let dest = mods_dir();

        // A mod uid names one *version*, so a folder already holding a
        // different uid is a collision only the user can settle: the download
        // is discarded and the conflict collected, rather than failing at
        // extraction time with "<folder> is already installed", which is all
        // this used to say. The archive's own top-level folder is what decides
        // it, so the check is exact rather than a guess from the mod's name.
        //
        // One archive is held at a time: a game can want several large mods,
        // and reading them all into memory to decide afterwards would be a
        // gigabyte for no benefit. Installing the mods that *do not* collide
        // before asking is harmless, since they are the versions this game
        // needs and nothing of the user's is overwritten to get them; only the
        // destructive step waits for an answer.
        let mut conflicts: Vec<ModVersionConflict> = Vec::new();
        for (uid, name) in mods {
            if installed.iter().any(|candidate| candidate.uid == *uid) {
                continue;
            }
            let download_url = self
                .mod_download_url(uid)
                .await
                .map_err(ModPrepFailure::Failed)?;
            let bytes = self
                .download_mod_archive(uid, &download_url)
                .await
                .map_err(ModPrepFailure::Failed)?;
            let root = archive_root_name(&bytes).map_err(ModPrepFailure::Failed)?;

            let target = safe_mod_target(&dest, &root).map_err(ModPrepFailure::Failed)?;
            if target.exists() {
                // Matched case-insensitively against the scan: Windows will
                // happily hand back a differently cased spelling of the same
                // directory than the one the archive names.
                let occupant = installed
                    .iter()
                    .find(|candidate| candidate.folder_name.eq_ignore_ascii_case(&root));
                if !replace_conflicts {
                    conflicts.push(ModVersionConflict {
                        required_uid: uid.clone(),
                        required_name: name.clone(),
                        folder_name: root.clone(),
                        installed_uid: occupant.map(|m| m.uid.clone()).unwrap_or_default(),
                        // A folder with no readable `mod_info.lua` is not in
                        // the scan at all, and the prompt still has to name
                        // something the user can recognise.
                        installed_name: occupant
                            .map(|m| m.display_name.clone())
                            .unwrap_or_else(|| root.clone()),
                        installed_version: occupant.map(|m| m.version.clone()).unwrap_or_default(),
                    });
                    continue;
                }
                // Approved. Goes through `uninstall_mod` rather than a bare
                // delete so the replaced version's uid also leaves
                // `game.prefs`: an active mod whose folder is gone is exactly
                // the state that produces an unexplained launch failure later.
                self.uninstall_mod(root)
                    .await
                    .map_err(ModPrepFailure::Failed)?;
            }
            self.extract_mod_archive(uid, bytes)
                .await
                .map_err(ModPrepFailure::Failed)?;
        }

        if !conflicts.is_empty() {
            return Err(ModPrepFailure::Conflicts(conflicts));
        }

        let mut active = read_active_mod_uids().await;
        for uid in mods.keys() {
            if !active.contains(uid) {
                active.push(uid.clone());
            }
        }
        write_active_mod_uids_to_disk(&active)
            .await
            .map_err(ModPrepFailure::Failed)
    }
}

pub(crate) fn safe_mod_target(root: &Path, folder_name: &str) -> Result<PathBuf, String> {
    let components = Path::new(folder_name).components().collect::<Vec<_>>();
    if components.is_empty()
        || components.len() > 2
        || components
            .iter()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("refusing to use a path outside the mods folder".to_string());
    }
    Ok(root.join(folder_name))
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

    let mut mod_dirs = Vec::new();
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|e| format!("could not list {}: {e}", dir.display()))?
    {
        let is_dir = entry.file_type().await.map(|t| t.is_dir()).unwrap_or(false);
        if !is_dir {
            continue;
        }
        let path = entry.path();
        if path.join("mod_info.lua").is_file() {
            mod_dirs.push(path);
            continue;
        }

        // Match the Java client's `Files.walk(modsDirectory, 2)`: archives
        // occasionally contain one extra wrapper directory.
        let Ok(mut children) = tokio::fs::read_dir(&path).await else {
            continue;
        };
        while let Ok(Some(child)) = children.next_entry().await {
            if child.file_type().await.is_ok_and(|kind| kind.is_dir())
                && child.path().join("mod_info.lua").is_file()
            {
                mod_dirs.push(child.path());
            }
        }
    }

    let mut installed = Vec::new();
    for path in mod_dirs {
        let Ok(relative) = path.strip_prefix(dir) else {
            continue;
        };
        let folder_name = relative.to_string_lossy().replace('\\', "/");
        let Ok(contents) = tokio::fs::read_to_string(path.join("mod_info.lua")).await else {
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
            description: info.description,
            mod_type: if info.ui_only {
                ModType::Ui
            } else {
                ModType::Sim
            },
            enabled,
        });
    }
    installed.sort_by(|a, b| a.display_name.cmp(&b.display_name));
    Ok(installed)
}

/// The subset of `mod_info.lua` fields this client needs (mirrors the
/// Python client's `getModInfo`'s search dict: see the module docs).
struct ModInfoFields {
    name: String,
    uid: String,
    version: String,
    author: String,
    description: String,
    ui_only: bool,
}

/// Parses a `mod_info.lua` file's flat `key = value` assignments. Not a
/// full Lua parser: see the module docs for why that's fine for these six
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
    let version = fields
        .get("version")
        .cloned()
        .unwrap_or_else(|| "1".to_string());
    let author = fields.get("author").cloned().unwrap_or_default();
    let description = fields.get("description").cloned().unwrap_or_default();
    let ui_only = fields.get("ui_only").is_some_and(|v| v == "true");

    Some(ModInfoFields {
        name,
        uid,
        version,
        author,
        description,
        ui_only,
    })
}

/// The user's mods folder: `<Documents>/My Games/Gas Powered Games/Supreme
/// Commander Forged Alliance/mods` (mirrors `infra::maps::maps_dir`'s
/// identical base, `mods` instead of `maps`). `FAF_MODS_DIR` overrides it.
pub(crate) fn mods_dir() -> PathBuf {
    if let Some(dir) = crate::infra::paths::mods_dir() {
        return dir;
    }
    if let Ok(dir) = std::env::var("FAF_MODS_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    crate::infra::faf_content::vault_dir().join("mods")
}

/// FA's own `game.prefs` file: `%LOCALAPPDATA%\Gas Powered Games\Supreme
/// Commander Forged Alliance\game.prefs` (confirmed via the Python
/// client's `util.LOCALFOLDER`/`PREFSFILENAME`). `FAF_GAME_PREFS_PATH`
/// overrides it (tests, alternate installs).
pub(crate) fn game_prefs_path() -> PathBuf {
    if let Some(path) = crate::infra::paths::game_prefs_path() {
        return path;
    }
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
    // A read failure (missing file, locked, non-UTF-8 bytes, …) must abort,
    // never be treated as an empty file. `game.prefs` is FA's *entire*
    // config (hotkeys, video, audio, profiles); the previous
    // `.unwrap_or_default()` would have replaced all of it with a lone
    // `active_mods` block on any read hiccup. Mirrors Python's
    // `setActiveMods` returning `False` when it can't read the file, and
    // never creating one that doesn't exist.
    let contents = tokio::fs::read_to_string(&path).await.map_err(|e| {
        format!(
            "could not read {}: leaving it untouched: {e}",
            path.display()
        )
    })?;
    let updated = write_active_mod_uids(&contents, uids);
    tokio::fs::write(&path, updated)
        .await
        .map_err(|e| format!("could not write {}: {e}", path.display()))
}

/// Byte range `[start, end]` (inclusive) of the **whole**
/// `active_mods = { ... }` block: from the first byte of `active_mods` to
/// the closing brace: in `game.prefs`'s contents, if present. A balanced-
/// brace scan rather than the reference clients' regex
/// (`active_mods\s*=\s*{.*?}`), without adding a regex dependency for one
/// small parser.
///
/// Two hard-won properties, both mirroring what Python's regex gives for
/// free (and both confirmed live as corruption vectors when absent):
/// - The span *includes* the `active_mods = ` prefix. An earlier version
///   returned only the brace span while [`write_active_mod_uids`] spliced
///   in a replacement that itself starts with `active_mods = `: producing
///   `active_mods = active_mods = { … }`, which FA's Lua parser rejects,
///   whereupon FA discards the *entire* prefs file (renames it `.bad` and
///   regenerates defaults: every hotkey and setting gone).
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
                return None; // unbalanced braces: refuse to splice blindly
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
/// absent), leaving the rest of the file untouched: mirrors Python's
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
    let entries: Vec<String> = uids
        .iter()
        .map(|uid| format!("    ['{uid}'] = true"))
        .collect();
    format!("active_mods = {{\n{}\n}}", entries.join(",\n"))
}

fn parse_reviews_summary(summary: &JsonApiResource) -> (i32, i32) {
    let reviews = value_i32(&summary.attributes, "reviews")
        .or_else(|| value_i32(&summary.attributes, "numReviews"))
        .or_else(|| value_i32(&summary.attributes, "totalReviews"))
        .or_else(|| value_i32(&summary.attributes, "count"))
        .unwrap_or(0);

    let avg_score = value_f64(&summary.attributes, "averageScore")
        .or_else(|| {
            let score = value_f64(&summary.attributes, "score")?;
            if reviews > 0 {
                Some(score / f64::from(reviews))
            } else {
                Some(score)
            }
        })
        .or_else(|| value_f64(&summary.attributes, "rating"))
        .unwrap_or(0.0);

    let rating_tenths = (avg_score * 10.0).round() as i32;
    (rating_tenths, reviews)
}

fn parse_vault_mods(doc: &JsonApiDoc) -> Vec<VaultMod> {
    let index = resource_index(&doc.included);
    doc.data
        .iter()
        .filter_map(|mod_res| {
            let (_, version_id) = rel_target(&mod_res.relationships, "latestVersion")?;
            let version = index.get(&("modVersion".to_string(), version_id))?;
            let uploader_rel = rel_target(&mod_res.relationships, "uploader");
            // The relationship's own id, so ownership does not depend on the
            // `player` resource having been included: it is in the linkage
            // either way.
            let uploader_id = uploader_rel
                .as_ref()
                .and_then(|(_, id)| id.parse::<i32>().ok());
            let uploader = uploader_rel
                .and_then(|rel| find_rel_resource(doc, &index, Some(rel)))
                .and_then(|player| player.attributes.get("login"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let reviews_summary = rel_target(&mod_res.relationships, "reviewsSummary")
                .or_else(|| rel_target(&mod_res.relationships, "modReviewsSummary"))
                .or_else(|| rel_target(&version.relationships, "reviewsSummary"))
                .or_else(|| rel_target(&version.relationships, "modVersionReviewsSummary"))
                .and_then(|rel| find_rel_resource(doc, &index, Some(rel)));

            let (rating_tenths, reviews) = if let Some(summary) = reviews_summary {
                parse_reviews_summary(summary)
            } else if let Some(summary_attr) = mod_res
                .attributes
                .get("reviewsSummary")
                .or_else(|| version.attributes.get("reviewsSummary"))
            {
                let r = value_i32(summary_attr, "reviews")
                    .or_else(|| value_i32(summary_attr, "numReviews"))
                    .unwrap_or(0);
                let score = value_f64(summary_attr, "averageScore")
                    .or_else(|| {
                        let s = value_f64(summary_attr, "score")?;
                        if r > 0 {
                            Some(s / f64::from(r))
                        } else {
                            Some(s)
                        }
                    })
                    .unwrap_or(0.0);
                ((score * 10.0).round() as i32, r)
            } else {
                (0, 0)
            };

            // The exact wire value for `modType` (`"UI"`/`"SIM"` or
            // something else) couldn't be verified against a live
            // authenticated call this session: same caveat as the
            // leaderboard's `leagueLeaderboard` type name. Defaults to
            // `Sim`, matching the reference clients' own `ui_only`
            // default of `false`.
            let mod_type = version
                .attributes
                .get("type")
                .or_else(|| version.attributes.get("modType"))
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
                mod_id: mod_res.id.parse().unwrap_or_default(),
                version_id: version.id.parse().unwrap_or_default(),
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
                uploader,
                uploader_id,
                uid: version
                    .attributes
                    .get("uid")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                version: version_str,
                description: version
                    .attributes
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                filename: version
                    .attributes
                    .get("filename")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                mod_type,
                ranked: version
                    .attributes
                    .get("ranked")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                recommended: value_bool(&mod_res.attributes, "recommended"),
                rating_tenths,
                reviews,
                created_at: version
                    .attributes
                    .get("createTime")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                updated_at: version
                    .attributes
                    .get("updateTime")
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
                    .get("thumbnailUrl")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            })
        })
        .collect()
}

/// Inert mods client: used offline and in tests (mirrors
/// [`crate::infra::FakeMaps`]).
#[derive(Debug, Clone, Default)]
pub struct FakeMods;

#[async_trait]
impl ModsPort for FakeMods {
    async fn list_vault(&self) -> Result<Vec<VaultMod>, String> {
        Err("mod vault is unavailable in offline mode".to_string())
    }

    async fn search_vault(&self, _query: ModVaultQuery) -> Result<ModSearchPage, String> {
        Err("mod vault is unavailable in offline mode".to_string())
    }

    async fn list_installed(&self) -> Result<Vec<InstalledMod>, String> {
        Err("mod install listing is unavailable in offline mode".to_string())
    }

    async fn install_mod(
        &self,
        _uid: String,
        _download_url: String,
    ) -> Result<Vec<InstalledMod>, String> {
        Err("mod install is unavailable in offline mode".to_string())
    }

    async fn uninstall_mod(&self, _folder_name: String) -> Result<Vec<InstalledMod>, String> {
        Err("mod uninstall is unavailable in offline mode".to_string())
    }

    async fn toggle_mod(&self, _uid: String, _enabled: bool) -> Result<Vec<InstalledMod>, String> {
        Err("mod toggling is unavailable in offline mode".to_string())
    }

    async fn set_active_mods(&self, _uids: Vec<String>) -> Result<Vec<InstalledMod>, String> {
        Err("mod toggling is unavailable in offline mode".to_string())
    }

    async fn ensure_game_mods(
        &self,
        _mods: &BTreeMap<String, String>,
        _replace_conflicts: bool,
    ) -> Result<(), ModPrepFailure> {
        Ok(())
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
        assert_eq!(info.description, "Extended content");
        assert!(!info.ui_only);
    }

    #[test]
    fn parse_mod_info_none_without_uid() {
        assert!(parse_mod_info("name = \"No UID Mod\"").is_none());
    }

    #[tokio::test]
    async fn required_mod_lookup_rejects_untrusted_uids_before_network_access() {
        let client = ModsClient::new(
            ModsConfig {
                api_base: "https://api.invalid".into(),
                content_base: "https://content.invalid".into(),
            },
            crate::infra::session::TokenStore::new(),
        );
        let error = client
            .mod_download_url("valid-looking' || hidden==false")
            .await
            .expect_err("a filter-injection uid must be rejected");
        assert!(error.contains("invalid simulation-mod uid"));
    }

    #[test]
    fn parse_mod_info_applies_defaults() {
        let info = parse_mod_info("uid = \"abc-123\"").expect("should parse");
        assert_eq!(info.name, "abc-123");
        assert_eq!(info.version, "1");
        assert_eq!(info.author, "");
        assert_eq!(info.description, "");
        assert!(!info.ui_only);
    }

    #[test]
    fn parse_mod_info_recognizes_ui_only() {
        let info = parse_mod_info("uid = \"abc-123\"\nui_only = true").expect("should parse");
        assert!(info.ui_only);
    }

    #[test]
    fn mod_folder_may_have_one_safe_wrapper_directory() {
        let root = Path::new("mods");
        assert_eq!(
            safe_mod_target(root, "total_mayhem"),
            Ok(root.join("total_mayhem"))
        );
        assert_eq!(
            safe_mod_target(root, "bundle/mod"),
            Ok(root.join("bundle/mod"))
        );
        assert!(safe_mod_target(root, "../outside").is_err());
        assert!(safe_mod_target(root, "nested/mod/deeper").is_err());
        assert!(safe_mod_target(root, ".").is_err());
    }

    #[test]
    fn active_mods_round_trips_through_write_then_parse() {
        let original = "some_other_setting = 1\nactive_mods = {\n    ['old-uid'] = true,\n}\nmore_settings = 2\n";
        let updated =
            write_active_mod_uids(original, &["new-uid".to_string(), "other-uid".to_string()]);
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
    /// brace, so it parses the doubled form happily): but FA's Lua parser
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

    /// The key must be followed by `= {` to count as the block: a stray
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
        let installed = list_installed_dir(&dir)
            .await
            .expect("missing dir is not an error");
        assert!(installed.is_empty());
    }

    #[tokio::test]
    async fn list_installed_dir_parses_mod_info_and_skips_invalid_folders() {
        let dir = std::env::temp_dir().join(format!("forge-mods-test-{}", std::process::id()));
        let good = dir.join("total_mayhem");
        tokio::fs::create_dir_all(&good).await.unwrap();
        tokio::fs::write(good.join("mod_info.lua"), SAMPLE_MOD_INFO)
            .await
            .unwrap();

        let bad = dir.join("not_a_mod");
        tokio::fs::create_dir_all(&bad).await.unwrap();
        // No mod_info.lua at all: should be skipped.

        let installed = list_installed_dir(&dir).await.expect("should list");
        assert_eq!(installed.len(), 1);
        assert_eq!(installed[0].uid, "dcd9a5e5-5444-4266-a016-ccbbff528268");
        assert_eq!(installed[0].folder_name, "total_mayhem");
        assert!(!installed[0].enabled); // no game.prefs override in this test env

        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn list_installed_dir_finds_mod_below_one_wrapper_directory() {
        let dir = std::env::temp_dir().join(format!(
            "forge-nested-mods-test-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        let nested = dir.join("download_bundle").join("total_mayhem");
        tokio::fs::create_dir_all(&nested).await.unwrap();
        tokio::fs::write(nested.join("mod_info.lua"), SAMPLE_MOD_INFO)
            .await
            .unwrap();

        let installed = list_installed_dir(&dir)
            .await
            .expect("should list nested mod");
        assert_eq!(installed.len(), 1);
        assert_eq!(installed[0].folder_name, "download_bundle/total_mayhem");

        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[test]
    fn the_uploader_id_arrives_even_when_the_player_is_not_included() {
        // It is in the relationship linkage rather than the included document,
        // so "is this mine" does not depend on the include list.
        let doc: JsonApiDoc = serde_json::from_value(json!({
            "data": [{
                "type": "mod",
                "id": "3",
                "attributes": { "displayName": "Total Mayhem", "author": "Someone Else" },
                "relationships": {
                    "latestVersion": { "data": { "type": "modVersion", "id": "9" } },
                    "uploader": { "data": { "type": "player", "id": "4711" } },
                },
            }],
            "included": [{
                "type": "modVersion",
                "id": "9",
                "attributes": { "uid": "abc-123" },
            }],
        }))
        .unwrap();

        let mods = parse_vault_mods(&doc);
        assert_eq!(mods[0].uploader_id, Some(4711));
        assert_eq!(mods[0].uploader, "");
        // And it is not the declared author, which anyone can write into
        // `mod_info.lua`.
        assert_eq!(mods[0].author, "Someone Else");
    }

    #[test]
    fn parses_vault_mods_resolving_version_through_included() {
        let doc: JsonApiDoc = serde_json::from_value(json!({
            "data": [
                {
                    "type": "mod",
                    "id": "77",
                    "attributes": {
                        "displayName": "Total Mayhem",
                        "author": "Some Author",
                        "recommended": true
                    },
                    "relationships": {
                        "latestVersion": { "data": { "type": "modVersion", "id": "9" } },
                        "uploader": { "data": { "type": "player", "id": "5" } },
                        "reviewsSummary": { "data": { "type": "reviewsSummary", "id": "15" } },
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
                        "description": "Adds new units and experimentals.",
                        "filename": "total_mayhem.zip",
                        "type": "SIM",
                        "ranked": false,
                        "downloadUrl": "https://content.faforever.com/mods/total_mayhem.zip",
                        "thumbnailUrl": "https://content.faforever.com/mods/total_mayhem.png",
                        "createTime": "2025-01-02T03:04:05Z",
                        "updateTime": "2026-02-03T04:05:06Z"
                    },
                },
                {
                    "type": "player",
                    "id": "5",
                    "attributes": { "login": "VaultUploader" }
                },
                {
                    "type": "reviewsSummary",
                    "id": "15",
                    "attributes": { "averageScore": 4.46, "reviews": 31 }
                }
            ],
        }))
        .unwrap();

        let mods = parse_vault_mods(&doc);
        assert_eq!(mods.len(), 1);
        assert_eq!(mods[0].display_name, "Total Mayhem");
        assert_eq!(mods[0].mod_id, 77);
        assert_eq!(mods[0].version_id, 9);
        assert_eq!(mods[0].author, "Some Author");
        assert_eq!(mods[0].uploader, "VaultUploader");
        assert_eq!(
            mods[0].uploader_id,
            Some(5),
            "ownership is decided by the uploader's id, not their current login"
        );
        assert_eq!(mods[0].uid, "dcd9a5e5-5444-4266-a016-ccbbff528268");
        assert_eq!(mods[0].version, "12");
        assert_eq!(mods[0].description, "Adds new units and experimentals.");
        assert_eq!(mods[0].filename, "total_mayhem.zip");
        assert_eq!(mods[0].mod_type, ModType::Sim);
        assert!(mods[0].recommended);
        assert_eq!(mods[0].rating_tenths, 45);
        assert_eq!(mods[0].reviews, 31);
        assert_eq!(mods[0].created_at, "2025-01-02T03:04:05Z");
        assert_eq!(mods[0].updated_at, "2026-02-03T04:05:06Z");
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
        assert!(fake
            .install_mod("x".into(), "http://x".into())
            .await
            .is_err());
        assert!(fake.uninstall_mod("x".into()).await.is_err());
        assert!(fake.toggle_mod("x".into(), true).await.is_err());
    }
}
