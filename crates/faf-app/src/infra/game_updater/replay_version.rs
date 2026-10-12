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
use super::update::{
    ensure_game_version_leased, ensure_latest_game_version_leased, latest_release,
    BASE_FEATURED_MODS,
};
use super::{lease_install, off_runtime_leased, safe_join_file, InstallLease};

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
    /// `None` for a base mod or a bare `.scfareplay`; an overlay replay
    /// without one is played on the overlay's latest release.
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

/// Put one cached build into `target_dir`: for an overlay, the `faf` build
/// `base_version` under it first.
///
/// The base is the one the caller names, the replay's own engine build, and
/// it has to be cached under its own entry. It is never guessed: an overlay
/// entry cached before bases were recorded used to get the newest cached
/// `faf`, which for an older overlay is a build it was never played on, and
/// with none cached at all the overlay was staged on its own, which cannot
/// run. `base_version` is ignored for a base mod.
fn stage_cached_version(
    cache_dir: &Path,
    target_dir: &Path,
    entry: &CacheManifestEntry,
    base_version: Option<i32>,
    manifest: &CacheManifest,
) -> Result<i32, String> {
    let mut base_entry = None;
    if !BASE_FEATURED_MODS.contains(&entry.featured_mod.as_str()) {
        let version = base_version
            .ok_or_else(|| format!("no base build is named for {}", entry.featured_mod))?;
        let base = manifest
            .entries
            .iter()
            .find(|e| e.featured_mod == "faf" && e.resolved_version == version)
            .ok_or_else(|| {
                format!(
                    "the base build {version} under {} is not cached",
                    entry.featured_mod
                )
            })?;
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
    // A failed stamp fails the staging, as it fails a fresh install: an
    // executable left on the previous build's number is the wrong engine for
    // this replay, and this used to report it staged anyway. Both callers take
    // the error as "fetch it instead", which rewrites and stamps the file.
    let exe_path = target_dir.join("bin").join("ForgedAlliance.exe");
    if exe_path.is_file() {
        patch_exe_version(&exe_path, engine_version)?;
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
///
/// The worker holds `lease` until it returns. Cancelling the launch drops
/// this future but not the staging under it, which goes on replacing files,
/// stamping the executable and writing `fa_path.lua`; the next preparation of
/// the same install has to wait for that rather than run beside it.
async fn stage_cached_version_off_runtime(
    cache_dir: &Path,
    target_dir: &Path,
    entry: &CacheManifestEntry,
    base_version: Option<i32>,
    manifest: &CacheManifest,
    lease: &InstallLease,
) -> Result<i32, String> {
    let (cache_dir, target_dir) = (cache_dir.to_path_buf(), target_dir.to_path_buf());
    let (entry, manifest) = (entry.clone(), manifest.clone());
    off_runtime_leased(lease, move || {
        stage_cached_version(&cache_dir, &target_dir, &entry, base_version, &manifest)
    })
    .await?
}

/// The overlay revision `entry` holds, when the entry itself establishes it.
///
/// An entry with a recorded base was written by one of the current install
/// paths, which either ask the API for the overlay's own revision or resolve
/// `latest` from the overlay's own file list, so its number is the revision.
/// An entry cached before bases were recorded was written by one of two older
/// paths, which its `version` tells apart:
///
/// - a live game's, which resolved `latest` from the overlay's own file list
///   and so recorded no requested version: its number is the revision too;
/// - a replay's, which asked the API for the overlay at the replay's *engine*
///   build and recorded that request. The API answers it with whichever
///   revision was newest that day, so the number is an engine build and says
///   nothing about which revision the files are. Such an entry is never
///   matched by its number (only by its files, see [`holds_files`]).
fn established_revision(entry: &CacheManifestEntry) -> Option<i32> {
    (entry.base_version.is_some() || entry.version.is_none()).then_some(entry.resolved_version)
}

/// Whether `entry` holds exactly the release `files` lists: the same files
/// under the same checksums, nothing more and nothing less.
///
/// Compares what is cached rather than the number it was cached under, so it
/// is as good for an entry whose number is not a revision as for any other.
fn holds_files(entry: &CacheManifestEntry, files: &[(String, String, String)]) -> bool {
    let Some(mut cached) = entry
        .files
        .iter()
        .map(|f| {
            Some((
                f.group.as_str(),
                f.name.as_deref()?,
                f.md5.to_ascii_lowercase(),
            ))
        })
        .collect::<Option<Vec<_>>>()
    else {
        return false;
    };
    let mut listed: Vec<(&str, &str, String)> = files
        .iter()
        .map(|(group, name, md5)| (group.as_str(), name.as_str(), md5.to_ascii_lowercase()))
        .collect();
    cached.sort();
    listed.sort();
    !listed.is_empty() && cached == listed
}

/// Of the cached overlay `candidates`, all holding the release a replay on
/// engine build `engine` needs, the one to stage it from.
///
/// The rule for an overlay replay: the overlay goes over the replay's own
/// engine build, from that build's own `faf` entry (see
/// [`stage_cached_version`]), so what a candidate has to establish is only
/// which release its own files are. Those files are the same whatever base
/// they were installed over, because the API lists an overlay's files by the
/// overlay's own revision, without reference to `faf`. The pair cached
/// together is preferred, being exactly what an earlier install of this
/// replay put on disk; the same release cached over another base, or before
/// bases were recorded, serves when that pair is not cached. A candidate's own
/// recorded base never decides what goes under it, and nothing stands in for
/// the replay's base when that is not cached: the replay is then installed
/// from the API instead.
fn prefer_cached_pair<'a>(
    candidates: impl Iterator<Item = &'a CacheManifestEntry>,
    engine: i32,
) -> Option<&'a CacheManifestEntry> {
    let candidates: Vec<&CacheManifestEntry> = candidates.collect();
    candidates
        .iter()
        .find(|entry| entry.base_version == Some(engine))
        .or_else(|| candidates.last())
        .copied()
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
    // Held for the whole pass, and by every blocking worker it starts: see
    // `InstallLease`. A launch called off part-way keeps the next one out of
    // this directory until its last write has landed.
    let lease = lease_install(target_dir).await;
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
            match stage_cached_version_off_runtime(
                cache_dir, target_dir, entry, None, &manifest, &lease,
            )
            .await
            {
                Ok(_) => {
                    tracing::info!(mod_name, name = %entry.name, "restored replay environment from local cache snapshot");
                    return Ok(None);
                }
                Err(err) => {
                    tracing::warn!(%err, "cached snapshot incomplete, falling back to server latest");
                }
            }
        }

        // Rolling mod has no working cache snapshot: update from server latest.
        // No token: a replay's preparation is called off by dropping it.
        ensure_latest_game_version_leased(
            http,
            token,
            api_base,
            cache_dir,
            target_dir,
            mod_name,
            exe_name,
            true,
            progress,
            &lease,
            &tokio_util::sync::CancellationToken::new(),
        )
        .await?;

        let warning = format!(
            "This replay was played on a rolling development build ({mod_name}) that was not in your local cache. Playback is running with the current development build and may desync if scripts changed."
        );
        return Ok(Some(warning));
    }

    // Fixed / numbered release (e.g. faf build 3839)
    if let Some(version) = replay_info.game_version {
        let overlay = !BASE_FEATURED_MODS.contains(&mod_name.as_str());
        let cached = if !overlay {
            manifest
                .entries
                .iter()
                .find(|e| e.featured_mod == *mod_name && e.resolved_version == version)
        } else if let Some(revision) = replay_info.featured_mod_version {
            // The replay names the overlay's revision in its header and its
            // engine build, the `faf` under it, in its body. Matching the
            // engine number against the overlay's revision, as this once
            // did, found an unrelated entry or none.
            prefer_cached_pair(
                manifest.entries.iter().filter(|e| {
                    e.featured_mod == *mod_name && established_revision(e) == Some(revision)
                }),
                version,
            )
        } else {
            // A replay that names no revision (a bare `.scfareplay`, or a
            // header without `featured_mod_versions`) is played on the
            // overlay's latest release, as the Python client's
            // `FilesObtainer` plays it: with no mod versions it asks for
            // `latest`. Only the API can say which release that is, so it is
            // asked for the list (no files), and the cache is used when it
            // holds exactly that release. This used to skip the cache and
            // install from the API every time, even when the newest release
            // was the one cached.
            //
            // Installing from the API stays the answer for exactly one case:
            // the latest release is not cached. Its files then come from the
            // content store wherever they already are. With the API out of
            // reach this fails, as it always has, rather than staging some
            // cached release: nothing says the newest one cached is still the
            // latest, and a replay played on another revision than the
            // reference clients would choose desyncs with nothing to say why.
            let latest =
                latest_release(http, token, api_base, mod_name, exe_name, progress).await?;
            tracing::info!(
                mod_name,
                version = latest.version,
                "a replay naming no overlay revision is played on the latest one"
            );
            prefer_cached_pair(
                manifest
                    .entries
                    .iter()
                    .filter(|e| e.featured_mod == *mod_name && holds_files(e, &latest.files)),
                version,
            )
        };
        if let Some(entry) = cached {
            let base = overlay.then_some(version);
            if stage_cached_version_off_runtime(
                cache_dir, target_dir, entry, base, &manifest, &lease,
            )
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
        ensure_game_version_leased(
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
            &lease,
        )
        .await?;
        return Ok(None);
    }

    // Fallback if version was unknown
    ensure_latest_game_version_leased(
        http,
        token,
        api_base,
        cache_dir,
        target_dir,
        mod_name,
        exe_name,
        false,
        progress,
        &lease,
        &tokio_util::sync::CancellationToken::new(),
    )
    .await?;
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infra::game_updater::cache::save_cache_manifest_entry;
    use crate::infra::game_updater::read_exe_version;
    use crate::infra::game_updater::test_support::{build_entry, put_in_store, EXE_BYTES};
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

        // A fake exe large enough for every version offset: staging stamps
        // it and fails when it cannot. Entries are stored under their real
        // checksums: staging verifies them.
        let exe_md5 = put_in_store(&temp_dir, "bin", &vec![0u8; EXE_BYTES]);
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
        stage_cached_version(&temp_dir, &target_dir, e_3837, None, &manifest).unwrap();

        assert_eq!(
            read_exe_version(&target_dir.join("bin").join("ForgedAlliance.exe")),
            Some(3837),
            "the staged executable is stamped with the staged build"
        );
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
    fn an_overlay_is_staged_over_the_base_named_for_it() {
        // Two cached base builds. The replay names the older one, so that is
        // the base it gets: not the newest, and not the one the overlay entry
        // happens to have been cached over.
        let temp = tempfile::tempdir().unwrap();
        let cache = temp.path().join("cache");
        let target = temp.path().join("replaydata");
        let old_base = put_in_store(&cache, "gamedata", b"base lua 3837");
        let new_base = put_in_store(&cache, "gamedata", b"base lua 3838");
        let overlay_file = put_in_store(&cache, "gamedata", b"nomads lua");

        let mut overlay = build_entry(52, &[("gamedata", "nomads.nx2", &overlay_file)]);
        overlay.featured_mod = "nomads".into();
        overlay.base_version = Some(3838);
        let manifest = CacheManifest {
            entries: vec![
                build_entry(3837, &[("gamedata", "lua.nx2", &old_base)]),
                build_entry(3838, &[("gamedata", "lua.nx2", &new_base)]),
                overlay.clone(),
            ],
        };

        stage_cached_version(&cache, &target, &overlay, Some(3837), &manifest).unwrap();
        assert_eq!(
            std::fs::read(target.join("gamedata").join("lua.nx2")).unwrap(),
            b"base lua 3837"
        );

        // A base that is not cached is fetched, not guessed.
        let error = stage_cached_version(&cache, &target, &overlay, Some(3000), &manifest)
            .expect_err("a missing base must not fall back to another one");
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

        let error = stage_cached_version(&cache, &target, &overlay, Some(3837), &manifest)
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
        overlay.version = None;
        let manifest = CacheManifest {
            entries: vec![overlay.clone()],
        };

        let error = stage_cached_version(&cache, &target, &overlay, Some(3837), &manifest)
            .expect_err("an overlay alone cannot run");
        assert!(error.contains("not cached"), "{error}");
        let error = stage_cached_version(&cache, &target, &overlay, None, &manifest)
            .expect_err("an overlay with no base named cannot run");
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

        stage_cached_version(&cache, &target, &overlay, Some(3837), &manifest).unwrap();
        let fa_path = std::fs::read_to_string(target.join("fa_path.lua")).unwrap();
        assert!(fa_path.contains("GameVersion = \"3837\""), "{fa_path}");
    }

    /// The cached path used to ignore the stamp's result, so an executable
    /// that could not be stamped was reported staged and the replay launched
    /// against whatever build number it still carried. A fresh install fails
    /// on the same error, and staging has to as well.
    #[tokio::test]
    async fn a_cached_build_whose_executable_cannot_be_stamped_is_not_staged() {
        let temp = tempfile::tempdir().unwrap();
        let cache = temp.path().join("cache");
        let target = temp.path().join("replaydata");
        // Far too small for the version offsets: the stamp refuses it.
        let exe = put_in_store(&cache, "bin", &[0u8; 10_000]);
        let lua = put_in_store(&cache, "gamedata", b"lua for build 3837");
        let entry = build_entry(
            3837,
            &[
                ("bin", "ForgedAlliance.exe", &exe),
                ("gamedata", "lua.nx2", &lua),
            ],
        );
        let manifest = CacheManifest {
            entries: vec![entry.clone()],
        };

        let error = stage_cached_version(&cache, &target, &entry, None, &manifest)
            .expect_err("an unstamped executable is not a staged build");
        assert!(error.contains("too small"), "{error}");

        // And through the preparation itself: the failed staging is not
        // reported as staged from the cache. It falls back to the API, which
        // is unreachable here, so the preparation fails rather than launching.
        std::fs::write(
            cache.join("cache_manifest.json"),
            serde_json::to_string(&manifest).unwrap(),
        )
        .unwrap();
        let replay = ReplayVersionInfo {
            mod_name: "faf".into(),
            game_version: Some(3837),
            ..Default::default()
        };
        let result = resolve_and_stage_replay_version(
            &reqwest::Client::new(),
            "token",
            "http://127.0.0.1:1",
            &cache,
            &target,
            &replay,
            "ForgedAlliance.exe",
            &|_| {},
        )
        .await;
        assert!(
            result.is_err(),
            "a cached build that could not be stamped must not prepare the replay: {result:?}"
        );
    }

    /// A launch called off while its cached staging runs on the blocking
    /// pool. Dropping the preparation does not stop that worker, and the next
    /// preparation of the same install used to start staging right beside it:
    /// the cancelled build's files, executable stamp and `fa_path.lua` then
    /// landed on top of the replacement's. The next one has to wait until the
    /// worker has finished, and its own build is what is left.
    #[tokio::test]
    async fn a_cancelled_staging_holds_the_install_until_its_worker_has_finished() {
        use crate::infra::game_updater::test_support::probe::{self, Event};

        let temp = tempfile::tempdir().unwrap();
        let cache = temp.path().join("cache");
        let target = temp.path().join("replaydata");
        let exe = put_in_store(&cache, "bin", &vec![0u8; EXE_BYTES]);
        let lua_3837 = put_in_store(&cache, "gamedata", b"lua for build 3837");
        let lua_3838 = put_in_store(&cache, "gamedata", b"lua for build 3838");
        let build = |version: i32, lua: &str| {
            build_entry(
                version,
                &[
                    ("bin", "ForgedAlliance.exe", &exe),
                    ("gamedata", "lua.nx2", lua),
                ],
            )
        };
        let manifest = CacheManifest {
            entries: vec![build(3837, &lua_3837), build(3838, &lua_3838)],
        };
        std::fs::write(
            cache.join("cache_manifest.json"),
            serde_json::to_string(&manifest).unwrap(),
        )
        .unwrap();

        let (mut events, release) = probe::watch(&target);
        let prepare = |version: i32| {
            let (cache, target) = (cache.clone(), target.clone());
            tokio::spawn(async move {
                let replay = ReplayVersionInfo {
                    mod_name: "faf".into(),
                    game_version: Some(version),
                    ..Default::default()
                };
                resolve_and_stage_replay_version(
                    &reqwest::Client::new(),
                    "token",
                    "http://127.0.0.1:1",
                    &cache,
                    &target,
                    &replay,
                    "ForgedAlliance.exe",
                    &|_| {},
                )
                .await
            })
        };

        // The first preparation reaches its blocking worker, which is held
        // there part-way, and is then called off.
        let cancelled = prepare(3837);
        assert_eq!(events.recv().await, Some(Event::Writing));
        cancelled.abort();
        assert!(cancelled.await.unwrap_err().is_cancelled());

        // The replacement waits for the install instead of staging into it.
        let replacement = prepare(3838);
        assert_eq!(
            events.recv().await,
            Some(Event::WaitingForInstall),
            "the next preparation started on the install while the cancelled \
             one's worker was still writing into it"
        );

        // Only once that worker has finished does the replacement stage.
        release.send(()).unwrap();
        assert_eq!(events.recv().await, Some(Event::Writing));
        assert_eq!(replacement.await.unwrap(), Ok(None));
        assert_eq!(
            std::fs::read(target.join("gamedata").join("lua.nx2")).unwrap(),
            b"lua for build 3838"
        );
        assert_eq!(
            read_exe_version(&target.join("bin").join("ForgedAlliance.exe")),
            Some(3838)
        );
        let fa_path = std::fs::read_to_string(target.join("fa_path.lua")).unwrap();
        assert!(fa_path.contains("GameVersion = \"3838\""), "{fa_path}");
    }

    /// An overlay replay names its engine build in the body and the overlay's
    /// revision in the header. The cached entry it gets is that revision
    /// cached together with that engine's base: in preference to the same
    /// revision cached over another base, and never an entry whose own
    /// revision happens to equal the engine number, which is what the lookup
    /// used to match.
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

    /// Stage `replay` from `manifest`, with an API nothing answers on: a
    /// preparation that tries to install from it fails.
    async fn stage_offline(
        cache: &Path,
        target: &Path,
        manifest: &CacheManifest,
        replay: &ReplayVersionInfo,
    ) -> Result<Option<String>, String> {
        std::fs::create_dir_all(cache).unwrap();
        std::fs::write(
            cache.join("cache_manifest.json"),
            serde_json::to_string(manifest).unwrap(),
        )
        .unwrap();
        resolve_and_stage_replay_version(
            &reqwest::Client::new(),
            "token",
            "http://127.0.0.1:1",
            cache,
            target,
            replay,
            "ForgedAlliance.exe",
            &|_| {},
        )
        .await
    }

    /// A cached `faf` build with a real-size executable, so staging it has
    /// something to stamp.
    fn cached_base(cache: &Path, version: i32) -> CacheManifestEntry {
        let exe = put_in_store(cache, "bin", &vec![0u8; EXE_BYTES]);
        let lua = put_in_store(cache, "gamedata", format!("base lua {version}").as_bytes());
        build_entry(
            version,
            &[
                ("bin", "ForgedAlliance.exe", &exe),
                ("gamedata", "lua.nx2", &lua),
            ],
        )
    }

    /// A `nomads` entry as one of the older paths wrote it, before bases were
    /// recorded: `requested` is the version it asked the API for.
    fn legacy_nomads(number: i32, requested: Option<i32>, md5: &str) -> CacheManifestEntry {
        let mut entry = build_entry(number, &[("gamedata", "nomads.nx2", md5)]);
        entry.featured_mod = "nomads".into();
        entry.version = requested;
        entry.base_version = None;
        entry
    }

    /// An overlay entry cached before bases were recorded, by a live game. It
    /// resolved `latest` from the overlay's own file list, so its number is
    /// the revision, while the base it went over is not known. It used to be
    /// matched for no replay at all. Its files are that revision whatever the
    /// base, so it serves a replay naming that revision, over the replay's own
    /// engine build rather than the newest one cached.
    #[tokio::test]
    async fn a_legacy_overlay_entry_is_staged_over_the_replays_own_base() {
        let temp = tempfile::tempdir().unwrap();
        let cache = temp.path().join("cache");
        let target = temp.path().join("replaydata");
        let overlay = put_in_store(&cache, "gamedata", b"nomads revision 52");
        let manifest = CacheManifest {
            entries: vec![
                cached_base(&cache, 3837),
                cached_base(&cache, 3838),
                legacy_nomads(52, None, &overlay),
            ],
        };
        let replay = ReplayVersionInfo {
            mod_name: "nomads".into(),
            game_version: Some(3837),
            featured_mod_version: Some(52),
            ..Default::default()
        };

        let warning = stage_offline(&cache, &target, &manifest, &replay)
            .await
            .expect("the cache holds the revision and the replay's base");

        assert_eq!(warning, None);
        let read = |group: &str, name: &str| std::fs::read(target.join(group).join(name)).unwrap();
        assert_eq!(read("gamedata", "nomads.nx2"), b"nomads revision 52");
        assert_eq!(read("gamedata", "lua.nx2"), b"base lua 3837");
        assert_eq!(
            read_exe_version(&target.join("bin").join("ForgedAlliance.exe")),
            Some(3837)
        );
        let fa_path = std::fs::read_to_string(target.join("fa_path.lua")).unwrap();
        assert!(fa_path.contains("GameType = \"nomads\""), "{fa_path}");
        assert!(fa_path.contains("GameVersion = \"3837\""), "{fa_path}");
    }

    /// The same revision cached over another base serves when the pair is not
    /// cached: the overlay's files do not depend on the base under them, and
    /// the base staged is the replay's own. This used to go to the API.
    #[tokio::test]
    async fn an_overlay_revision_cached_over_another_base_is_staged_over_the_replays_own() {
        let temp = tempfile::tempdir().unwrap();
        let cache = temp.path().join("cache");
        let target = temp.path().join("replaydata");
        let overlay = put_in_store(&cache, "gamedata", b"nomads revision 52");
        let mut over_3838 = build_entry(52, &[("gamedata", "nomads.nx2", &overlay)]);
        over_3838.featured_mod = "nomads".into();
        over_3838.base_version = Some(3838);
        let manifest = CacheManifest {
            entries: vec![
                cached_base(&cache, 3837),
                cached_base(&cache, 3838),
                over_3838,
            ],
        };
        let replay = ReplayVersionInfo {
            mod_name: "nomads".into(),
            game_version: Some(3837),
            featured_mod_version: Some(52),
            ..Default::default()
        };

        stage_offline(&cache, &target, &manifest, &replay)
            .await
            .expect("the cache holds the revision and the replay's base");

        let read = |group: &str, name: &str| std::fs::read(target.join(group).join(name)).unwrap();
        assert_eq!(read("gamedata", "nomads.nx2"), b"nomads revision 52");
        assert_eq!(read("gamedata", "lua.nx2"), b"base lua 3837");
        assert_eq!(
            read_exe_version(&target.join("bin").join("ForgedAlliance.exe")),
            Some(3837)
        );
    }

    /// Nothing stands in for the base a replay names. With only another `faf`
    /// build cached, the overlay is not staged over that one (the newest
    /// cached build is what an entry from before bases were recorded used to
    /// get), and the replay goes to the API instead, unreachable here.
    #[tokio::test]
    async fn an_overlay_is_not_staged_over_a_base_the_replay_did_not_name() {
        let temp = tempfile::tempdir().unwrap();
        let cache = temp.path().join("cache");
        let target = temp.path().join("replaydata");
        let overlay = put_in_store(&cache, "gamedata", b"nomads revision 52");
        let manifest = CacheManifest {
            entries: vec![cached_base(&cache, 3838), legacy_nomads(52, None, &overlay)],
        };
        let replay = ReplayVersionInfo {
            mod_name: "nomads".into(),
            game_version: Some(3837),
            featured_mod_version: Some(52),
            ..Default::default()
        };

        let result = stage_offline(&cache, &target, &manifest, &replay).await;

        assert!(result.is_err(), "{result:?}");
        assert!(!target.join("gamedata").join("lua.nx2").exists());
        assert!(!target.join("gamedata").join("nomads.nx2").exists());
    }

    /// Which entries say what revision their files are. The ones written by
    /// the current paths carry a base, and their number is the revision. Of
    /// those from before bases were recorded, a live game's resolved its
    /// number from the overlay's own file list, and a replay's asked the API
    /// for the overlay at the replay's engine build, which says nothing about
    /// the revision it got.
    #[test]
    fn a_cached_overlay_is_matched_by_number_only_when_the_number_is_its_revision() {
        let mut current = build_entry(52, &[]);
        current.base_version = Some(3837);
        assert_eq!(established_revision(&current), Some(52));
        current.version = None;
        assert_eq!(established_revision(&current), Some(52));

        assert_eq!(
            established_revision(&legacy_nomads(52, None, "x")),
            Some(52)
        );
        assert_eq!(
            established_revision(&legacy_nomads(3837, Some(3837), "x")),
            None,
            "an engine build the overlay was asked for is not its revision"
        );
    }

    /// A replay naming no overlay revision is played on the latest one. The
    /// API is asked which release that is, and a cached entry holding exactly
    /// its files is staged instead of installing the release again. Here that
    /// entry is one cached before bases were recorded and under an engine
    /// build for a number, so only its files can vouch for it.
    #[tokio::test]
    async fn a_replay_naming_no_overlay_revision_is_staged_from_the_cached_latest_release() {
        use crate::infra::game_updater::test_support::FakeServer;

        let temp = tempfile::tempdir().unwrap();
        let cache = temp.path().join("cache");
        let target = temp.path().join("replaydata");
        let latest = put_in_store(&cache, "gamedata", b"nomads revision 52");
        let older = put_in_store(&cache, "gamedata", b"nomads revision 51");
        let mut revision_51 = build_entry(51, &[("gamedata", "nomads.nx2", &older)]);
        revision_51.featured_mod = "nomads".into();
        revision_51.base_version = Some(3837);
        let manifest = CacheManifest {
            entries: vec![
                cached_base(&cache, 3837),
                legacy_nomads(3837, Some(3837), &latest),
                revision_51,
            ],
        };
        std::fs::write(
            cache.join("cache_manifest.json"),
            serde_json::to_string(&manifest).unwrap(),
        )
        .unwrap();

        // The API: the mod's id, and what `latest` is made of. An id no other
        // test uses, since listed releases are remembered process-wide.
        let list = serde_json::json!({ "data": [{
            "type": "featuredModFile",
            "id": "1",
            "attributes": {
                "group": "gamedata",
                "name": "nomads.nx2",
                "md5": latest,
                "version": "52",
                "cacheableUrl": "http://127.0.0.1:1/content/nomads.nx2",
                "hmacToken": "tok",
                "hmacParameter": "verify",
            },
        }]});
        let server = FakeServer::start(vec![
            (
                "/data/featuredMod".into(),
                br#"{"data":[{"type":"featuredMod","id":"95201","attributes":{}}]}"#.to_vec(),
            ),
            (
                "/featuredMods/95201/files/latest".into(),
                list.to_string().into_bytes(),
            ),
        ])
        .await;

        let replay = ReplayVersionInfo {
            mod_name: "nomads".into(),
            game_version: Some(3837),
            featured_mod_version: None,
            ..Default::default()
        };
        let warning = resolve_and_stage_replay_version(
            &reqwest::Client::builder().no_proxy().build().unwrap(),
            "token",
            &server.base,
            &cache,
            &target,
            &replay,
            "ForgedAlliance.exe",
            &|_| {},
        )
        .await
        .expect("the latest release is cached over the replay's base");

        assert_eq!(warning, None);
        let read = |group: &str, name: &str| std::fs::read(target.join(group).join(name)).unwrap();
        assert_eq!(read("gamedata", "nomads.nx2"), b"nomads revision 52");
        assert_eq!(read("gamedata", "lua.nx2"), b"base lua 3837");
        assert_eq!(
            server.requests(),
            ["/data/featuredMod", "/featuredMods/95201/files/latest"],
            "only which release is the latest is asked; nothing is installed"
        );
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
