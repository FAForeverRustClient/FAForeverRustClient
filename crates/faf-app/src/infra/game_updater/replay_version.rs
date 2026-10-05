//! Which build a replay needs, and getting that build into the replay
//! install: from the cache when it is there, from the API when it is not.
//!
//! Separate from `update` because a replay names its build after the fact (an
//! engine number in its body, a revision or a commit in its header), and
//! matching that against what is cached is a set of rules of its own.

use std::path::Path;

use crate::ports::PreparationStep;

use super::cache::{load_cache_manifest, CacheManifest, CacheManifestEntry};
use super::content_store::{link_into, replace_with_copy, ContentStore};
use super::install::{finish_install, patch_exe_version};
use super::update::{ensure_game_version, ensure_latest_game_version, BASE_FEATURED_MODS};
use super::{off_runtime, safe_join_file};

/// Extract the engine version from a decompressed `.scfareplay` body's
/// leading NUL-terminated string, e.g. `"Supreme Commander v1.50.3684"` →
/// `3684`. Mirrors `ReplayDataParser._game_version` in the Python client's
/// `fa/replayparser.py`.
pub fn extract_game_version(scfa_body: &[u8]) -> Option<i32> {
    let nul = scfa_body.iter().position(|&b| b == 0)?;
    let version_str = std::str::from_utf8(&scfa_body[..nul]).ok()?;
    if !version_str.starts_with("Supreme Commander v1") {
        return None;
    }
    version_str.rsplit('.').next()?.parse().ok()
}

/// The `.scfareplay` header is a sequence of NUL-terminated strings: the
/// SupCom version, a blank "newline" string, then `"{replay_version}\r\n
/// {map_path}"` where `map_path` looks like `/maps/adaptive_gadostb.v0002/
/// adaptive_gadostb.scmap`. Extracts the map's versioned folder name (the
/// second path segment). Mirrors `ReplayDataParser._mapname` in the Python
/// client's `fa/replayparser.py`.
pub fn extract_map_folder(scfa_body: &[u8]) -> Option<String> {
    let mut pos = 0usize;
    read_nul_string(scfa_body, &mut pos)?; // SupCom version string
    read_nul_string(scfa_body, &mut pos)?; // blank "newline" string
    let replay_and_map = read_nul_string(scfa_body, &mut pos)?;
    let map_path = replay_and_map
        .split("\r\n")
        .nth(1)
        .unwrap_or(&replay_and_map);
    let normalized = map_path.replace('\\', "/");
    let parts: Vec<&str> = normalized.split('/').filter(|p| !p.is_empty()).collect();
    if let Some(maps_idx) = parts.iter().position(|p| p.eq_ignore_ascii_case("maps")) {
        if let Some(folder) = parts.get(maps_idx + 1) {
            return Some(folder.to_string());
        }
    }
    if let Some(folder) = parts
        .iter()
        .find(|p| p.to_ascii_lowercase().starts_with("neroxis_map_generator_"))
    {
        return Some(folder.to_string());
    }
    None
}

fn read_nul_string(body: &[u8], pos: &mut usize) -> Option<String> {
    let start = *pos;
    while *pos < body.len() && body[*pos] != 0 {
        *pos += 1;
    }
    if *pos >= body.len() {
        return None;
    }
    let s = String::from_utf8_lossy(&body[start..*pos]).into_owned();
    *pos += 1; // skip the NUL
    Some(s)
}

#[derive(Debug, Clone, Default)]
pub struct ReplayVersionInfo {
    pub mod_name: String,
    /// The engine build the replay was recorded on, from the replay body. For
    /// an overlay this is the `faf` build under it, not the overlay's own.
    pub game_version: Option<i32>,
    /// An overlay's own revision, from the `.fafreplay` header's
    /// `featured_mod_versions` (their highest, as in the Python client).
    /// `None` for a base mod or a bare `.scfareplay`.
    pub featured_mod_version: Option<i32>,
    pub git_sha: Option<String>,
    pub git_short_sha: Option<String>,
    pub build_signature: Option<String>,
    pub version_name: Option<String>,
    pub launched_at: Option<u64>,
}

/// Put one cached build's files into `target_dir`, from the store.
///
/// Every entry is checked against its checksum before anything is placed, so
/// a missing or damaged entry fails the staging (the caller then downloads the
/// build instead) without leaving the install half switched to it. The check
/// is cheap after the first time per session: see [`ContentStore::verified`].
///
/// Blocking: call it off the async runtime.
pub(super) fn stage_entry_files(
    cache_dir: &Path,
    target_dir: &Path,
    entry: &CacheManifestEntry,
) -> Result<(), String> {
    let store = ContentStore::new(cache_dir);
    let mut placements = Vec::with_capacity(entry.files.len());
    for f in &entry.files {
        let file_name = f.name.as_deref().unwrap_or(&f.md5);
        let Some(src) = store.verified(&f.group, &f.md5)? else {
            return Err(format!(
                "cached file {}/{} is missing from the cache or damaged",
                f.group, file_name
            ));
        };
        let dst = safe_join_file(target_dir, &f.group, file_name)?;
        placements.push((src, f.md5.as_str(), dst, file_name));
    }
    for (src, md5, dst, file_name) in placements {
        // The executable gets its version patched right after, so it is a
        // private copy from the start. Everything else is only ever read and
        // can share the store's file.
        if file_name.eq_ignore_ascii_case("ForgedAlliance.exe") {
            replace_with_copy(&src, &dst)
        } else {
            link_into(&src, md5, &dst)
        }
        .map_err(|e| format!("could not copy cached file {file_name}: {e}"))?;
    }
    Ok(())
}

fn stage_cached_version(
    cache_dir: &Path,
    target_dir: &Path,
    entry: &CacheManifestEntry,
    manifest: &CacheManifest,
) -> Result<i32, String> {
    let mut base_entry = None;
    if !BASE_FEATURED_MODS.contains(&entry.featured_mod.as_str()) {
        let base = match entry.base_version {
            Some(version) => manifest
                .entries
                .iter()
                .find(|e| e.featured_mod == "faf" && e.resolved_version == version)
                .ok_or_else(|| {
                    format!(
                        "the base build {version} under {} is not cached",
                        entry.featured_mod
                    )
                })?,
            // Cached before the base was recorded: the newest, as before.
            // With no base cached at all this used to stage the overlay on
            // its own, which cannot run.
            None => manifest
                .entries
                .iter()
                .rfind(|e| e.featured_mod == "faf")
                .ok_or_else(|| format!("no base build is cached under {}", entry.featured_mod))?,
        };
        // An overlay is only as good as the base under it. This used to
        // ignore a base that failed to stage, and report the overlay as
        // staged over an incomplete one. Both callers take an error here
        // as "fetch it instead", which is the right answer.
        stage_entry_files(cache_dir, target_dir, base).map_err(|error| {
            format!(
                "the base build under {} could not be staged: {error}",
                entry.featured_mod
            )
        })?;
        base_entry = Some(base);
    }
    stage_entry_files(cache_dir, target_dir, entry)?;

    // The engine version comes from the base: an overlay's own version is a
    // mod revision like `5`, and stamping that into the executable and
    // `fa_path.lua` is the mistake `ensure_latest_game_version` describes.
    let engine_version = base_entry.map_or(entry.resolved_version, |base| base.resolved_version);
    let exe_path = target_dir.join("bin").join("ForgedAlliance.exe");
    if exe_path.is_file() {
        let _ = patch_exe_version(&exe_path, engine_version);
    }

    finish_install(target_dir, &entry.featured_mod, engine_version)?;

    let build_info = serde_json::json!({
        "featuredMod": entry.featured_mod,
        "version": entry.version,
        "resolvedVersion": entry.resolved_version,
        "signature": entry.signature,
        "gitShortSha": entry.git_short_sha,
        "commitUrl": entry.url,
    });
    let _ = std::fs::write(
        target_dir.join(".faf_build.json"),
        serde_json::to_string(&build_info).unwrap_or_default(),
    );

    Ok(entry.resolved_version)
}

/// [`stage_cached_version`] on the blocking pool: it now hashes the build's
/// store entries, which is too much disk work for an async worker thread.
async fn stage_cached_version_off_runtime(
    cache_dir: &Path,
    target_dir: &Path,
    entry: &CacheManifestEntry,
    manifest: &CacheManifest,
) -> Result<i32, String> {
    let (cache_dir, target_dir) = (cache_dir.to_path_buf(), target_dir.to_path_buf());
    let (entry, manifest) = (entry.clone(), manifest.clone());
    off_runtime(move || stage_cached_version(&cache_dir, &target_dir, &entry, &manifest)).await?
}

#[allow(clippy::too_many_arguments)]
pub async fn resolve_and_stage_replay_version(
    http: &reqwest::Client,
    token: &str,
    api_base: &str,
    cache_dir: &Path,
    target_dir: &Path,
    replay_info: &ReplayVersionInfo,
    exe_name: &str,
    progress: &(dyn Fn(PreparationStep) + Sync),
) -> Result<Option<String>, String> {
    let mod_name = &replay_info.mod_name;
    let is_rolling = mod_name == "fafdevelop" || mod_name == "fafbeta";
    let manifest = load_cache_manifest(cache_dir);

    if is_rolling {
        let candidates: Vec<&CacheManifestEntry> = manifest
            .entries
            .iter()
            .filter(|e| e.featured_mod == *mod_name)
            .collect();

        let chosen = if !candidates.is_empty() {
            // 1. Exact match by git_sha or git_short_sha or signature
            candidates
                .iter()
                .find(|e| {
                    (replay_info.git_sha.is_some()
                        && e.git_short_sha.is_some()
                        && replay_info
                            .git_sha
                            .as_ref()
                            .unwrap()
                            .starts_with(e.git_short_sha.as_ref().unwrap()))
                        || (replay_info.git_short_sha.is_some()
                            && e.git_short_sha == replay_info.git_short_sha)
                        || (replay_info.build_signature.is_some()
                            && e.signature == replay_info.build_signature)
                })
                .copied()
                // 2. Closest snapshot by timestamp proximity to launched_at
                .or_else(|| {
                    if let Some(launched) = replay_info.launched_at {
                        candidates
                            .iter()
                            .min_by_key(|e| e.updated_at.abs_diff(launched))
                            .copied()
                    } else {
                        None
                    }
                })
                // 3. Fallback to newest cached snapshot
                .or_else(|| candidates.last().copied())
        } else {
            None
        };

        if let Some(entry) = chosen {
            match stage_cached_version_off_runtime(cache_dir, target_dir, entry, &manifest).await {
                Ok(_) => {
                    tracing::info!(mod_name, name = %entry.name, "restored replay environment from local cache snapshot");
                    return Ok(None);
                }
                Err(err) => {
                    tracing::warn!(%err, "cached snapshot incomplete, falling back to server latest");
                }
            }
        }

        // Rolling mod has no working cache snapshot: update from server latest
        ensure_latest_game_version(
            http, token, api_base, cache_dir, target_dir, mod_name, exe_name, true, progress,
        )
        .await?;

        let warning = format!(
            "This replay was played on a rolling development build ({mod_name}) that was not in your local cache. Playback is running with the current development build and may desync if scripts changed."
        );
        return Ok(Some(warning));
    }

    // Fixed / numbered release (e.g. faf build 3839)
    if let Some(version) = replay_info.game_version {
        // An overlay's entry is the overlay's revision cached over this
        // engine's `faf` build. Matching the engine number against the
        // overlay's revision, as this did, found an unrelated entry or none.
        // With no revision in the replay the overlay is the latest, which
        // only the API can name, so the cache is not consulted.
        let overlay = !BASE_FEATURED_MODS.contains(&mod_name.as_str());
        if let Some(entry) = manifest.entries.iter().find(|e| {
            e.featured_mod == *mod_name
                && if overlay {
                    e.base_version == Some(version)
                        && replay_info.featured_mod_version == Some(e.resolved_version)
                } else {
                    e.resolved_version == version
                }
        }) {
            if stage_cached_version_off_runtime(cache_dir, target_dir, entry, &manifest)
                .await
                .is_ok()
            {
                tracing::info!(
                    mod_name,
                    version,
                    "staged replay environment instantly from local cache"
                );
                return Ok(None);
            }
        }

        // Cache miss: download from server API
        ensure_game_version(
            http,
            token,
            api_base,
            cache_dir,
            target_dir,
            mod_name,
            version,
            replay_info.featured_mod_version,
            exe_name,
            progress,
        )
        .await?;
        return Ok(None);
    }

    // Fallback if version was unknown
    ensure_latest_game_version(
        http, token, api_base, cache_dir, target_dir, mod_name, exe_name, false, progress,
    )
    .await?;
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infra::game_updater::cache::save_cache_manifest_entry;
    use crate::infra::game_updater::test_support::{build_entry, put_in_store};
    use crate::infra::game_updater::CachedFileInfo;

    #[test]
    fn extracts_game_version_from_supcom_header_string() {
        let mut body = b"Supreme Commander v1.50.3684".to_vec();
        body.push(0);
        body.extend_from_slice(b"rest of the replay");
        assert_eq!(extract_game_version(&body), Some(3684));
    }

    #[test]
    fn extract_game_version_rejects_non_supcom_strings() {
        let mut body = b"not a replay header".to_vec();
        body.push(0);
        assert_eq!(extract_game_version(&body), None);
    }

    #[test]
    fn extract_game_version_none_without_a_nul_terminator() {
        assert_eq!(extract_game_version(b"Supreme Commander v1.50.3684"), None);
    }

    fn scfa_header(version: &str, map_path: &str, trailing: &[u8]) -> Vec<u8> {
        let mut body = Vec::new();
        body.extend_from_slice(version.as_bytes());
        body.push(0);
        body.push(0); // blank "newline" string
        body.extend_from_slice(format!("Replay v1.9\r\n{map_path}").as_bytes());
        body.push(0);
        body.extend_from_slice(trailing);
        body
    }

    #[test]
    fn extracts_map_folder_from_scfa_header() {
        let body = scfa_header(
            "Supreme Commander v1.50.3684",
            "/maps/adaptive_gadostb.v0002/adaptive_gadostb.scmap",
            b"garbage\0rest",
        );
        assert_eq!(
            extract_map_folder(&body).as_deref(),
            Some("adaptive_gadostb.v0002")
        );
    }

    #[test]
    fn extract_map_folder_none_for_non_maps_path() {
        let body = scfa_header("Supreme Commander v1.50.3684", "/not-maps/foo/bar", b"\0");
        assert_eq!(extract_map_folder(&body), None);
    }

    #[tokio::test]
    async fn cache_manifest_stage_and_restore_replay_version_works() {
        // Its own root, for the shared `versions` folder described on the
        // manifest test above.
        let root = std::env::temp_dir().join(format!("forge-stage-test-{}", std::process::id()));
        let temp_dir = root.join("cache");
        let target_dir = root.join("target");
        let _ = tokio::fs::remove_dir_all(&root).await;
        tokio::fs::create_dir_all(temp_dir.join("bin"))
            .await
            .unwrap();
        tokio::fs::create_dir_all(temp_dir.join("gamedata"))
            .await
            .unwrap();
        tokio::fs::create_dir_all(&target_dir).await.unwrap();

        // 10000-byte fake exe (large enough for version offset). Entries are
        // stored under their real checksums: staging verifies them.
        let exe_md5 = put_in_store(&temp_dir, "bin", &[0u8; 10000]);
        let lua_md5 = put_in_store(&temp_dir, "gamedata", b"lua_content_3837");
        let dev_md5 = put_in_store(&temp_dir, "gamedata", b"lua_content_develop");

        let entry_3837 = CacheManifestEntry {
            featured_mod: "faf".to_string(),
            version: Some(3837),
            resolved_version: 3837,
            name: "FAF Build 3837".to_string(),
            url: Some("https://github.com/FAForever/fa/releases/tag/3837".to_string()),
            git_short_sha: None,
            signature: None,
            files: vec![
                CachedFileInfo {
                    group: "bin".to_string(),
                    md5: exe_md5,
                    name: Some("ForgedAlliance.exe".to_string()),
                },
                CachedFileInfo {
                    group: "gamedata".to_string(),
                    md5: lua_md5,
                    name: Some("lua.nx2".to_string()),
                },
            ],
            updated_at: 100,
            base_version: None,
        };
        save_cache_manifest_entry(&temp_dir, entry_3837);

        let entry_dev = CacheManifestEntry {
            featured_mod: "fafdevelop".to_string(),
            version: None,
            resolved_version: 0,
            name: "FAF Develop (abcdef1)".to_string(),
            url: Some("https://github.com/FAForever/fa/commits/abcdef1".to_string()),
            git_short_sha: Some("abcdef1".to_string()),
            signature: Some("abcdef1".to_string()),
            files: vec![CachedFileInfo {
                group: "gamedata".to_string(),
                md5: dev_md5,
                name: Some("lua.nx2".to_string()),
            }],
            updated_at: 500,
            base_version: None,
        };
        save_cache_manifest_entry(&temp_dir, entry_dev);

        // Test 1: Staging numbered version from cache
        let manifest = load_cache_manifest(&temp_dir);
        let e_3837 = manifest
            .entries
            .iter()
            .find(|e| e.resolved_version == 3837)
            .unwrap();
        stage_cached_version(&temp_dir, &target_dir, e_3837, &manifest).unwrap();

        assert!(target_dir.join("bin").join("ForgedAlliance.exe").is_file());
        assert!(target_dir.join("gamedata").join("lua.nx2").is_file());
        assert_eq!(
            tokio::fs::read(target_dir.join("gamedata").join("lua.nx2"))
                .await
                .unwrap(),
            b"lua_content_3837"
        );
        assert!(target_dir.join("fa_path.lua").is_file());
        assert!(target_dir.join(".faf_build.json").is_file());

        // Test 2: Resolve fafdevelop replay by exact commit SHA
        let http = reqwest::Client::new();
        let replay_info_sha = ReplayVersionInfo {
            mod_name: "fafdevelop".to_string(),
            game_version: None,
            git_sha: Some("abcdef1987654321".to_string()),
            git_short_sha: Some("abcdef1".to_string()),
            build_signature: Some("abcdef1".to_string()),
            version_name: Some("FAF Develop (abcdef1)".to_string()),
            launched_at: Some(510),
            featured_mod_version: None,
        };

        let warn = resolve_and_stage_replay_version(
            &http,
            "token",
            "http://127.0.0.1",
            &temp_dir,
            &target_dir,
            &replay_info_sha,
            "ForgedAlliance.exe",
            &|_| {},
        )
        .await
        .unwrap();

        assert_eq!(warn, None);
        assert_eq!(
            tokio::fs::read(target_dir.join("gamedata").join("lua.nx2"))
                .await
                .unwrap(),
            b"lua_content_develop"
        );

        // Test 3: Resolve fafdevelop replay by timestamp proximity (no git SHA in replay)
        let replay_info_time = ReplayVersionInfo {
            mod_name: "fafdevelop".to_string(),
            game_version: None,
            git_sha: None,
            git_short_sha: None,
            build_signature: None,
            version_name: None,
            launched_at: Some(505), // Close to updated_at = 500
            featured_mod_version: None,
        };

        let warn2 = resolve_and_stage_replay_version(
            &http,
            "token",
            "http://127.0.0.1",
            &temp_dir,
            &target_dir,
            &replay_info_time,
            "ForgedAlliance.exe",
            &|_| {},
        )
        .await
        .unwrap();

        assert_eq!(warn2, None);
        assert_eq!(
            tokio::fs::read(target_dir.join("gamedata").join("lua.nx2"))
                .await
                .unwrap(),
            b"lua_content_develop"
        );

        // The root, so the `versions` folder beside the cache goes with it.
        let _ = tokio::fs::remove_dir_all(&root).await;
    }

    #[test]
    fn an_overlay_is_staged_over_the_base_it_was_cached_with() {
        // Two cached base builds. The overlay was cached together with the
        // older one, so that is the base it gets, not the newest.
        let temp = tempfile::tempdir().unwrap();
        let cache = temp.path().join("cache");
        let target = temp.path().join("replaydata");
        let old_base = put_in_store(&cache, "gamedata", b"base lua 3837");
        let new_base = put_in_store(&cache, "gamedata", b"base lua 3838");
        let overlay_file = put_in_store(&cache, "gamedata", b"nomads lua");

        let mut overlay = build_entry(52, &[("gamedata", "nomads.nx2", &overlay_file)]);
        overlay.featured_mod = "nomads".into();
        overlay.base_version = Some(3837);
        let manifest = CacheManifest {
            entries: vec![
                build_entry(3837, &[("gamedata", "lua.nx2", &old_base)]),
                build_entry(3838, &[("gamedata", "lua.nx2", &new_base)]),
                overlay.clone(),
            ],
        };

        stage_cached_version(&cache, &target, &overlay, &manifest).unwrap();
        assert_eq!(
            std::fs::read(target.join("gamedata").join("lua.nx2")).unwrap(),
            b"base lua 3837"
        );

        // A recorded base that is no longer cached is fetched, not guessed.
        overlay.base_version = Some(3000);
        let error = stage_cached_version(&cache, &target, &overlay, &manifest)
            .expect_err("a missing recorded base must not fall back to another one");
        assert!(error.contains("not cached"), "{error}");
    }

    #[test]
    fn an_overlay_does_not_stage_over_a_base_that_failed_to() {
        // Staging the base used to be `let _ =`: a base whose files were gone
        // from the store left the overlay "staged" on top of nothing, and the
        // replay then ran against an incomplete install.
        let temp = tempfile::tempdir().unwrap();
        let cache = temp.path().join("cache");
        let target = temp.path().join("replaydata");
        let overlay_file = put_in_store(&cache, "gamedata", b"coop lua");

        // The base names a file the store does not have.
        let base = build_entry(
            3837,
            &[("gamedata", "lua.nx2", "0123456789abcdef0123456789abcdef")],
        );
        let mut overlay = build_entry(3837, &[("gamedata", "coop.nx2", &overlay_file)]);
        overlay.featured_mod = "coop".into();
        let manifest = CacheManifest {
            entries: vec![base, overlay.clone()],
        };

        let error = stage_cached_version(&cache, &target, &overlay, &manifest)
            .expect_err("an overlay over a broken base must not count as staged");
        assert!(error.contains("base build"), "{error}");
    }

    #[test]
    fn an_overlay_without_any_cached_base_is_fetched_instead() {
        // An entry from before the base was recorded, and no `faf` build in
        // the cache: this used to stage the overlay's files on their own.
        let temp = tempfile::tempdir().unwrap();
        let cache = temp.path().join("cache");
        let target = temp.path().join("replaydata");
        let overlay_file = put_in_store(&cache, "gamedata", b"nomads lua");
        let mut overlay = build_entry(52, &[("gamedata", "nomads.nx2", &overlay_file)]);
        overlay.featured_mod = "nomads".into();
        let manifest = CacheManifest {
            entries: vec![overlay.clone()],
        };

        let error = stage_cached_version(&cache, &target, &overlay, &manifest)
            .expect_err("an overlay alone cannot run");
        assert!(error.contains("no base build"), "{error}");
        assert!(!target.join("gamedata").join("nomads.nx2").exists());
    }

    #[test]
    fn a_staged_overlay_reports_the_base_engine_version() {
        // The overlay's own version is a mod revision. `fa_path.lua` used to
        // say the game was version 52.
        let temp = tempfile::tempdir().unwrap();
        let cache = temp.path().join("cache");
        let target = temp.path().join("replaydata");
        let base_file = put_in_store(&cache, "gamedata", b"base lua 3837");
        let overlay_file = put_in_store(&cache, "gamedata", b"nomads lua");
        let mut overlay = build_entry(52, &[("gamedata", "nomads.nx2", &overlay_file)]);
        overlay.featured_mod = "nomads".into();
        overlay.base_version = Some(3837);
        let manifest = CacheManifest {
            entries: vec![
                build_entry(3837, &[("gamedata", "lua.nx2", &base_file)]),
                overlay.clone(),
            ],
        };

        stage_cached_version(&cache, &target, &overlay, &manifest).unwrap();
        let fa_path = std::fs::read_to_string(target.join("fa_path.lua")).unwrap();
        assert!(fa_path.contains("GameVersion = \"3837\""), "{fa_path}");
    }

    /// An overlay replay names its engine build in the body and the overlay's
    /// revision in the header. The cached entry it gets is that revision over
    /// that engine's base: not the revision over another base, and not an
    /// entry whose own revision happens to equal the engine number, which is
    /// what the lookup used to match.
    #[tokio::test]
    async fn an_overlay_replay_is_staged_from_its_revision_over_its_engine_build() {
        let temp = tempfile::tempdir().unwrap();
        let cache = temp.path().join("cache");
        let target = temp.path().join("replaydata");
        let base_3837 = put_in_store(&cache, "gamedata", b"base lua 3837");
        let base_3838 = put_in_store(&cache, "gamedata", b"base lua 3838");
        let right = put_in_store(&cache, "gamedata", b"nomads 52 over 3837");
        let other_base = put_in_store(&cache, "gamedata", b"nomads 52 over 3838");
        let engine_numbered = put_in_store(&cache, "gamedata", b"nomads at the engine number");
        let nomads = |revision: i32, base: i32, md5: &str| {
            let mut entry = build_entry(revision, &[("gamedata", "nomads.nx2", md5)]);
            entry.featured_mod = "nomads".into();
            entry.base_version = Some(base);
            entry
        };
        let manifest = CacheManifest {
            entries: vec![
                build_entry(3837, &[("gamedata", "lua.nx2", &base_3837)]),
                build_entry(3838, &[("gamedata", "lua.nx2", &base_3838)]),
                nomads(3837, 3838, &engine_numbered),
                nomads(52, 3838, &other_base),
                nomads(52, 3837, &right),
            ],
        };
        std::fs::write(
            cache.join("cache_manifest.json"),
            serde_json::to_string(&manifest).unwrap(),
        )
        .unwrap();

        let replay = ReplayVersionInfo {
            mod_name: "nomads".into(),
            game_version: Some(3837),
            featured_mod_version: Some(52),
            ..Default::default()
        };
        let warning = resolve_and_stage_replay_version(
            &reqwest::Client::new(),
            "token",
            "http://127.0.0.1",
            &cache,
            &target,
            &replay,
            "ForgedAlliance.exe",
            &|_| {},
        )
        .await
        .unwrap();

        assert_eq!(warning, None);
        let read = |path: &[&str]| {
            std::fs::read(path.iter().fold(target.clone(), |dir, part| dir.join(part))).unwrap()
        };
        assert_eq!(read(&["gamedata", "nomads.nx2"]), b"nomads 52 over 3837");
        assert_eq!(read(&["gamedata", "lua.nx2"]), b"base lua 3837");
        let fa_path = std::fs::read_to_string(target.join("fa_path.lua")).unwrap();
        assert!(fa_path.contains("GameVersion = \"3837\""), "{fa_path}");
    }

    #[test]
    fn switching_between_builds_with_equal_length_files_stages_the_right_content() {
        // The reported failure: a destination whose length matched the cached
        // file was taken to *be* it, so switching to a build whose file was
        // the same size left the previous build's bytes installed while
        // staging reported success.
        let temp = tempfile::tempdir().unwrap();
        let cache = temp.path().join("cache");
        let target = temp.path().join("replaydata");
        let old = put_in_store(&cache, "gamedata", b"lua for build 3837");
        let new = put_in_store(&cache, "gamedata", b"lua for build 3838");

        stage_entry_files(
            &cache,
            &target,
            &build_entry(3837, &[("gamedata", "lua.nx2", &old)]),
        )
        .unwrap();
        stage_entry_files(
            &cache,
            &target,
            &build_entry(3838, &[("gamedata", "lua.nx2", &new)]),
        )
        .unwrap();

        let staged = target.join("gamedata").join("lua.nx2");
        assert_eq!(std::fs::read(&staged).unwrap(), b"lua for build 3838");
        assert_eq!(
            std::fs::read(cache.join("gamedata").join(&old)).unwrap(),
            b"lua for build 3837",
            "switching away must not touch the previous build's entry"
        );

        // And back again.
        stage_entry_files(
            &cache,
            &target,
            &build_entry(3837, &[("gamedata", "lua.nx2", &old)]),
        )
        .unwrap();
        assert_eq!(std::fs::read(&staged).unwrap(), b"lua for build 3837");
    }

    #[test]
    fn a_damaged_cached_entry_is_not_staged() {
        let temp = tempfile::tempdir().unwrap();
        let cache = temp.path().join("cache");
        let target = temp.path().join("replaydata");
        let good = put_in_store(&cache, "gamedata", b"lua for build 3837");
        // Named for one content, holding another of the same length: what a
        // killed write or an in-place edit through a hard link leaves behind.
        let damaged = format!("{:x}", md5::compute(b"units for build 3837"));
        std::fs::write(
            cache.join("gamedata").join(&damaged),
            b"units for build 9999",
        )
        .unwrap();

        let error = stage_entry_files(
            &cache,
            &target,
            &build_entry(
                3837,
                &[
                    ("gamedata", "lua.nx2", &good),
                    ("gamedata", "units.nx2", &damaged),
                ],
            ),
        )
        .unwrap_err();

        assert!(error.contains("units.nx2"), "{error}");
        assert!(
            !target.join("gamedata").exists(),
            "nothing is placed when any entry fails its check"
        );
        assert!(
            !cache.join("gamedata").join(&damaged).exists(),
            "the damaged entry is dropped so the build is fetched again"
        );
    }
}
