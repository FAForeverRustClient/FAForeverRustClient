//! Bringing an install up to one release of a featured mod: asking the API
//! which files make it up, checking what is already on disk, and fetching the
//! rest through the content store.
//!
//! Separate from `install`, which finishes an install once its files are in
//! place, and from `replay_version`, which decides which release to ask for.

use std::path::Path;

use serde::Deserialize;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::infra::vault_install::bounded_body_to_file;
use crate::ports::{PreparationPhase, PreparationStep};

use super::cache::{save_cache_manifest_entry, CacheManifestEntry, CachedFileInfo};
use super::content_store::{self, replace_with_copy, ContentStore};
use super::install::{finish_install, patch_exe_version};
use super::{
    lease_install, off_runtime, off_runtime_leased, safe_join_file, unless_called_off,
    InstallLease, CALLED_OFF,
};

/// One file from `GET /featuredMods/{mod_id}/files/{version}`. `group` is the
/// subdirectory under the target install root (`bin`, `gamedata`, …).
#[derive(Debug, Clone, Deserialize)]
struct FeaturedModFile {
    group: String,
    name: String,
    md5: String,
    /// The release this particular file belongs to. Only meaningful when the
    /// list was fetched as `latest`: see [`effective_version`].
    #[serde(default, deserialize_with = "lenient_i32")]
    version: Option<i32>,
    #[serde(rename = "cacheableUrl")]
    cacheable_url: String,
    #[serde(rename = "hmacToken")]
    hmac_token: String,
    #[serde(rename = "hmacParameter")]
    hmac_parameter: String,
}

/// The API sends `version` as a JSON string (`"3775"`), but has been observed
/// as a bare number too, and it is absent from some older records. Accept all
/// three rather than failing the whole update on a field that is only ever
/// advisory: [`effective_version`] falls back when it is missing.
fn lenient_i32<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<i32>, D::Error> {
    Ok(match Value::deserialize(d)? {
        Value::String(s) => s.parse().ok(),
        Value::Number(n) => n.as_i64().and_then(|value| i32::try_from(value).ok()),
        _ => None,
    })
}

/// The version a file list actually resolved to.
///
/// Needed because a live game asks for `latest` and never learns the number
/// from the request itself: but `fa_path.lua` and the executable's baked-in
/// version both need it. Both reference clients derive it the same way: prefer
/// the engine executable's own entry (Python's
/// `patch_fa_executable`/`_resolve_base_version`), because that is the version
/// FA will report; otherwise take the highest version in the list (Java's
/// `maxVersion` in `SimpleHttpFeaturedModUpdaterTask`), which is what the
/// release as a whole is called.
fn effective_version(files: &[FeaturedModFile], exe_name: &str) -> Option<i32> {
    files
        .iter()
        .find(|f| f.group == "bin" && f.name.eq_ignore_ascii_case(exe_name))
        .and_then(|f| f.version)
        .or_else(|| files.iter().filter_map(|f| f.version).max())
}

/// A JSON:API document shaped like `{ data: [...] }`: reused here rather
/// than the fuller `JsonApiDoc`/`JsonApiResource` in `infra/jsonapi.rs` since
/// these responses have no `included`/relationships to resolve, just flat
/// attributes per resource.
#[derive(Debug, Deserialize)]
struct JsonApiList {
    #[serde(default)]
    data: Vec<JsonApiEntry>,
}

#[derive(Debug, Deserialize)]
struct JsonApiEntry {
    id: String,
    #[serde(default)]
    attributes: Value,
}

/// Ensure `target_dir` has the exact file set the FAF API lists for
/// `(featured_mod, version)`, then stamp the engine executable's version and
/// write `fa_path.lua`. `version` is the engine build; for an overlay it is
/// the `faf` build installed under it, and `overlay_version` is the
/// overlay's own revision (`None`: the latest). Idempotent and cheap to call
/// before every replay, files already matching by MD5 are left untouched (mirrors Python calling
/// `check()` unconditionally before each replay rather than pre-checking
/// whether an update is needed).
// Every parameter is independently required and there's a single call site
// (`infra::replay::play_file`): a params struct wouldn't add clarity here.
#[allow(clippy::too_many_arguments)]
pub async fn ensure_game_version(
    http: &reqwest::Client,
    token: &str,
    api_base: &str,
    cache_dir: &Path,
    target_dir: &Path,
    featured_mod: &str,
    version: i32,
    overlay_version: Option<i32>,
    exe_name: &str,
    progress: &(dyn Fn(PreparationStep) + Sync),
) -> Result<(), String> {
    let lease = lease_install(target_dir).await;
    ensure_game_version_leased(
        http,
        token,
        api_base,
        cache_dir,
        target_dir,
        featured_mod,
        version,
        overlay_version,
        exe_name,
        progress,
        &lease,
    )
    .await
}

/// [`ensure_game_version`] into an install the caller already holds.
#[allow(clippy::too_many_arguments)]
pub(super) async fn ensure_game_version_leased(
    http: &reqwest::Client,
    token: &str,
    api_base: &str,
    cache_dir: &Path,
    target_dir: &Path,
    featured_mod: &str,
    version: i32,
    overlay_version: Option<i32>,
    exe_name: &str,
    progress: &(dyn Fn(PreparationStep) + Sync),
    lease: &InstallLease,
) -> Result<(), String> {
    // An overlay ships only its own changed files, so it needs `faf` under
    // it here as much as for a live game. The replay names both: its body
    // carries the engine build, which is the `faf` build, and its header the
    // overlay's revision. The Python client's `FilesObtainer` uses the same
    // pair. This used to ask for the overlay at the engine's number and put
    // the latest `faf` under it. The cache entry records the base, so
    // staging puts the same one back next time.
    //
    // No token: a replay's preparation is called off by dropping it (see
    // `infra::replay`), which every write here survives through its lease.
    let never = CancellationToken::new();
    let overlay = !BASE_FEATURED_MODS.contains(&featured_mod);
    let mut base = None;
    if overlay {
        base = Some(
            install_featured_mod(
                http,
                token,
                api_base,
                cache_dir,
                target_dir,
                "faf",
                Some(version),
                exe_name,
                false,
                progress,
                None,
                lease,
                &never,
            )
            .await?,
        );
    }

    install_featured_mod(
        http,
        token,
        api_base,
        cache_dir,
        target_dir,
        featured_mod,
        if overlay {
            overlay_version
        } else {
            Some(version)
        },
        exe_name,
        false,
        progress,
        base.map(|base| base.version),
        lease,
        &never,
    )
    .await?;

    // Stamped with the base build, the same number staging this entry from
    // the cache stamps (`stage_cached_version`), so the replay is prepared
    // the same way whether it was downloaded or cached.
    finish_install(
        target_dir,
        featured_mod,
        base.map_or(version, |base| base.version),
    )?;
    Ok(())
}

/// The featured mods that *are* a complete game install. Everything else
/// (`nomads`, `coop`, total conversions) is an overlay that only ships its own
/// changed files and silently depends on `faf` for the rest.
///
/// Both reference clients hardcode the same idea with slightly different lists
///: Java's `NAMES_OF_FEATURED_BASE_MODS` omits `ladder1v1`, the Python
/// client's `FilesObtainer` includes it. The Python list is used here because
/// it is the superset: treating `ladder1v1` as a base mod is what actually
/// happens on the server (it is the `faf` files under another name), and
/// treating it as an overlay would install `faf` twice for every ladder game.
pub(super) const BASE_FEATURED_MODS: [&str; 4] = ["faf", "ladder1v1", "fafbeta", "fafdevelop"];

/// Bring the install up to whatever version the server is currently on, for a
/// live game rather than a replay.
///
/// Two differences from [`ensure_game_version`], both load-bearing:
///
/// - **The version is `latest`, not a number.** A live game has no embedded
///   version to read: the server expects every client to be current, and the
///   only way to learn which release that is, is to ask for `latest` and read
///   the version back out of the file list.
/// - **Non-base mods pull `faf` in first.** `nomads` and friends publish only
///   their own changed files; without the base install underneath, the game
///   launches into a missing-file crash. Java's `GameUpdaterImpl::update`
///   ("the featured-mod-mess") and the Python client's `FilesObtainer` both
///   chain the two updates in exactly this order.
///
/// `progress` is called with a user-facing line and measured file progress.
///
/// Stops once `called_off` is cancelled, wherever that leaves every file
/// whole: see [`update_outdated`]. A stopped run does not finish the install
/// (no executable stamp for this run, no `fa_path.lua`, no cache entry), so
/// nothing claims a release it did not complete; the files it did bring up to
/// date stay, and the next run's checksum pass starts from them.
#[allow(clippy::too_many_arguments)]
pub async fn ensure_latest_game_version(
    http: &reqwest::Client,
    token: &str,
    api_base: &str,
    cache_dir: &Path,
    target_dir: &Path,
    featured_mod: &str,
    exe_name: &str,
    cache_rolling_branches: bool,
    progress: &(dyn Fn(PreparationStep) + Sync),
    called_off: &CancellationToken,
) -> Result<i32, String> {
    // Waited for unless the run is called off first: the install can be held
    // by a run that is itself finishing its last file.
    let lease =
        unless_called_off(called_off, async { Ok(lease_install(target_dir).await) }).await?;
    ensure_latest_game_version_leased(
        http,
        token,
        api_base,
        cache_dir,
        target_dir,
        featured_mod,
        exe_name,
        cache_rolling_branches,
        progress,
        &lease,
        called_off,
    )
    .await
}

/// [`ensure_latest_game_version`] into an install the caller already holds.
#[allow(clippy::too_many_arguments)]
pub(super) async fn ensure_latest_game_version_leased(
    http: &reqwest::Client,
    token: &str,
    api_base: &str,
    cache_dir: &Path,
    target_dir: &Path,
    featured_mod: &str,
    exe_name: &str,
    cache_rolling_branches: bool,
    progress: &(dyn Fn(PreparationStep) + Sync),
    lease: &InstallLease,
    called_off: &CancellationToken,
) -> Result<i32, String> {
    let mut base = None;
    if !BASE_FEATURED_MODS.contains(&featured_mod) {
        base = Some(
            install_featured_mod(
                http,
                token,
                api_base,
                cache_dir,
                target_dir,
                "faf",
                None,
                exe_name,
                cache_rolling_branches,
                progress,
                None,
                lease,
                called_off,
            )
            .await?,
        );
    }

    let installed = install_featured_mod(
        http,
        token,
        api_base,
        cache_dir,
        target_dir,
        featured_mod,
        None,
        exe_name,
        cache_rolling_branches,
        progress,
        base.map(|base| base.version),
        lease,
        called_off,
    )
    .await?;

    // `GameVersion` in `fa_path.lua` is the *engine* version, so it comes from
    // whichever step shipped the executable: the overlay almost never does.
    // (The Java client writes the last step's mod version here instead, which
    // for an overlay is a mod revision like `5`; the Python client writes the
    // engine version, which is what the Lua bootstrap actually means by it.)
    let engine_version = installed
        .engine_version
        .or_else(|| base.as_ref().and_then(|b| b.engine_version))
        .unwrap_or(installed.version);

    finish_install(target_dir, featured_mod, engine_version)?;
    Ok(engine_version)
}

/// One release of a featured mod as the API lists it: the number it resolves
/// to and the files that make it up.
pub(super) struct Release {
    pub(super) version: i32,
    /// Each file as `(group, name, md5)`.
    pub(super) files: Vec<(String, String, String)>,
}

/// Which release `latest` is for `featured_mod` right now, asked of the API
/// without installing anything.
///
/// For a replay that names no overlay revision: only the API can say what the
/// latest one is, and knowing it is what lets the cache be used when it holds
/// that release already. The list is kept for a few minutes (see
/// [`fetch_file_list`]), so installing the same release straight after does
/// not ask for it again.
pub(super) async fn latest_release(
    http: &reqwest::Client,
    token: &str,
    api_base: &str,
    featured_mod: &str,
    exe_name: &str,
    progress: &(dyn Fn(PreparationStep) + Sync),
) -> Result<Release, String> {
    progress(PreparationStep::indeterminate(
        PreparationPhase::Asking,
        format!("Asking the API which release of {featured_mod} is the latest…"),
    ));
    let mod_id = fetch_mod_id(http, token, api_base, featured_mod).await?;
    let files = fetch_file_list(http, token, api_base, &mod_id, featured_mod, None).await?;
    let version = effective_version(&files, exe_name).ok_or_else(|| {
        format!("the API did not say which version '{featured_mod}' is currently on")
    })?;
    Ok(Release {
        version,
        files: files
            .into_iter()
            .map(|file| (file.group, file.name, file.md5))
            .collect(),
    })
}

/// What one [`install_featured_mod`] pass put on disk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct InstalledMod {
    /// The release the file list resolved to.
    version: i32,
    /// The engine version stamped into `ForgedAlliance.exe`, if this file list
    /// shipped one. Overlay mods (`nomads`, …) never do.
    engine_version: Option<i32>,
}

type CachedCommitSha = (String, String, std::time::Instant);
type CommitShaCache = std::collections::HashMap<String, CachedCommitSha>;

static GITHUB_SHA_CACHE: std::sync::Mutex<Option<CommitShaCache>> = std::sync::Mutex::new(None);

async fn fetch_github_commit_sha(http: &reqwest::Client, branch: &str) -> Option<(String, String)> {
    if let Ok(guard) = GITHUB_SHA_CACHE.lock() {
        if let Some(map) = guard.as_ref() {
            if let Some((sha, url, exp)) = map.get(branch) {
                if std::time::Instant::now() < *exp {
                    return Some((sha.clone(), url.clone()));
                }
            }
        }
    }

    let url = format!("https://api.github.com/repos/FAForever/fa/commits/{branch}");
    let resp = http
        .get(&url)
        .header(reqwest::header::USER_AGENT, "FAForever-Rust-Client")
        .header(reqwest::header::ACCEPT, "application/vnd.github.v3+json")
        .send()
        .await
        .ok()?;

    if !resp.status().is_success() {
        return None;
    }

    let val: serde_json::Value = resp.json().await.ok()?;
    let sha = val.get("sha")?.as_str()?.to_string();
    let html_url = val
        .get("html_url")
        .and_then(|u| u.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("https://github.com/FAForever/fa/commit/{sha}"));

    if let Ok(mut guard) = GITHUB_SHA_CACHE.lock() {
        let map = guard.get_or_insert_with(std::collections::HashMap::new);
        map.insert(
            branch.to_string(),
            (
                sha.clone(),
                html_url.clone(),
                std::time::Instant::now() + std::time::Duration::from_secs(600),
            ),
        );
    }

    Some((sha, html_url))
}

/// Sync one featured mod's file set into `target_dir` and stamp the engine
/// executable, returning the version that was actually installed.
///
/// Deliberately does *not* write `fa_path.lua`: the overlay chain above calls
/// this twice, and only the last call's featured mod and version belong in
/// that file (mirrors Java writing it once, after the whole chain, from the
/// final `PatchResult`).
#[allow(clippy::too_many_arguments)]
async fn install_featured_mod(
    http: &reqwest::Client,
    token: &str,
    api_base: &str,
    cache_dir: &Path,
    target_dir: &Path,
    featured_mod: &str,
    version: Option<i32>,
    exe_name: &str,
    cache_rolling_branches: bool,
    progress: &(dyn Fn(PreparationStep) + Sync),
    base_version: Option<i32>,
    lease: &InstallLease,
    called_off: &CancellationToken,
) -> Result<InstalledMod, String> {
    // Before anything is asked: an overlay's `faf` underneath may have just
    // finished when the run was called off, and the overlay is not started.
    if called_off.is_cancelled() {
        return Err(CALLED_OFF.to_string());
    }
    // `Updater.run` sets "Requesting files from API..." before anything else
    // happens, for the same reason it is here: two API round trips on a slow
    // connection is long enough for an unlabelled dialog to read as a hang.
    progress(PreparationStep::indeterminate(
        PreparationPhase::Asking,
        format!("Asking the API which files {featured_mod} is made of…"),
    ));
    let files = unless_called_off(called_off, async {
        let mod_id = fetch_mod_id(http, token, api_base, featured_mod).await?;
        fetch_file_list(http, token, api_base, &mod_id, featured_mod, version).await
    })
    .await?;

    // Requested version wins; `latest` resolves from the list itself. Falling
    // back to 0 would silently mis-stamp the executable, so an unresolvable
    // version is an error: it means the API gave us files we can't identify.
    let resolved = match version {
        Some(v) => v,
        None => effective_version(&files, exe_name).ok_or_else(|| {
            format!("the API did not say which version '{featured_mod}' is currently on")
        })?,
    };

    let total = files.len();

    // Two passes, as `UpdaterWorker.update_files` does in the Python client:
    // checksum everything first, then fetch only what the checksums rejected.
    //
    // One pass that hashes-and-fetches per file is fewer lines and was what
    // this did, but it cannot say either of the two things a player waiting on
    // it wants to know. It cannot narrate the checksum pass, because a file
    // that matches is simply skipped without a word -- so an install that is
    // already current, which is nearly every launch, reported *nothing* for
    // however long it took to read a few hundred files. And it cannot say what
    // is about to be downloaded, because it only discovers the next outdated
    // file after finishing the previous one.
    let outdated = checksum_pass(
        target_dir,
        &files,
        featured_mod,
        resolved,
        progress,
        called_off,
    )
    .await?;

    if outdated.is_empty() {
        // `on_mod_progress` in the Python dialog, for `ProgressInfo(0, 0, "")`.
        progress(PreparationStep::counted(
            PreparationPhase::Downloading,
            format!("{featured_mod} {resolved} is up to date ({total} files)"),
            1,
            1,
        ));
    } else {
        let pending = outdated.len();
        progress(PreparationStep::counted(
            PreparationPhase::Downloading,
            format!("{pending} of {total} files need updating for {featured_mod} {resolved}",),
            0,
            pending,
        ));
        update_outdated(
            http,
            api_base,
            cache_dir,
            target_dir,
            &outdated,
            featured_mod,
            resolved,
            progress,
            lease,
            called_off,
        )
        .await?;
    }

    let shipped_exe = files
        .iter()
        .find(|f| f.group == "bin" && f.name.eq_ignore_ascii_case(exe_name));

    // Stamp the executable when we know what to stamp it with. An explicit
    // version is always stamped, including onto an executable the file list
    // didn't mention: that is how replay playback has always worked, and the
    // version is exact by construction there. Resolving `latest`, though, only
    // stamps when the list actually shipped the executable: an overlay mod's
    // "version" is a mod revision (`5`), and writing that into the engine
    // header would tell FA it is a build from 2007. An overlay's explicit
    // version is that same revision, so only a base mod's is stamped; the
    // base installed under the overlay has already stamped the engine.
    let explicit = version.filter(|_| BASE_FEATURED_MODS.contains(&featured_mod));
    let engine_version = match (explicit, shipped_exe) {
        (Some(v), _) => {
            let path = shipped_exe
                .map(|f| target_dir.join(&f.group).join(&f.name))
                .unwrap_or_else(|| target_dir.join("bin").join(exe_name));
            patch_exe_version(&path, v)?;
            Some(v)
        }
        (None, Some(file)) => {
            let v = file.version.unwrap_or(resolved);
            patch_exe_version(&target_dir.join(&file.group).join(&file.name), v)?;
            Some(v)
        }
        (None, None) => None,
    };

    // Record build state info for rolling branches and mods
    let (git_sha, git_short_sha, commit_url) = if featured_mod == "fafdevelop" {
        if let Some((sha, url)) = fetch_github_commit_sha(http, "develop").await {
            let short = sha.chars().take(7).collect::<String>();
            (Some(sha), Some(short), Some(url))
        } else {
            (
                None,
                None,
                Some("https://github.com/FAForever/fa/commits/develop".to_string()),
            )
        }
    } else if featured_mod == "fafbeta" {
        if let Some((sha, url)) = fetch_github_commit_sha(http, "deploy/fafbeta").await {
            let short = sha.chars().take(7).collect::<String>();
            (Some(sha), Some(short), Some(url))
        } else {
            (
                None,
                None,
                Some("https://github.com/FAForever/fa/commits/deploy/fafbeta".to_string()),
            )
        }
    } else {
        (None, None, None)
    };

    let mut hasher = md5::Context::new();
    for f in &files {
        hasher.consume(f.name.as_bytes());
        hasher.consume(f.md5.as_bytes());
    }
    let composite_hash = format!("{:x}", hasher.compute());
    let short_hash = composite_hash.chars().take(7).collect::<String>();

    let build_info = serde_json::json!({
        "featuredMod": featured_mod,
        "version": version,
        "resolvedVersion": resolved,
        "signature": short_hash,
        "gitSha": git_sha,
        "gitShortSha": git_short_sha,
        "commitUrl": commit_url,
    });
    let _ = std::fs::write(
        target_dir.join(".faf_build.json"),
        serde_json::to_string(&build_info).unwrap_or_default(),
    );

    let entry_name = if featured_mod == "fafdevelop" {
        if let Some(short) = &git_short_sha {
            format!("FAF Develop ({short})")
        } else {
            format!("FAF Develop ({short_hash})")
        }
    } else if featured_mod == "fafbeta" {
        if let Some(short) = &git_short_sha {
            format!("FAF Beta ({short})")
        } else {
            format!("FAF Beta ({short_hash})")
        }
    } else if featured_mod == "faf" || featured_mod == "ladder1v1" {
        format!("FAF Build {resolved}")
    } else {
        format!("{featured_mod} v{resolved}")
    };

    let entry_url = if featured_mod == "fafdevelop" {
        commit_url
            .clone()
            .or_else(|| Some("https://github.com/FAForever/fa/commits/develop".to_string()))
    } else if featured_mod == "fafbeta" {
        commit_url
            .clone()
            .or_else(|| Some("https://github.com/FAForever/fa/commits/deploy/fafbeta".to_string()))
    } else if (featured_mod == "faf" || featured_mod == "ladder1v1") && resolved >= 3636 {
        Some(format!(
            "https://github.com/FAForever/fa/releases/tag/{resolved}"
        ))
    } else {
        None
    };

    let cached_files: Vec<CachedFileInfo> = files
        .iter()
        .map(|f| CachedFileInfo {
            group: f.group.clone(),
            md5: f.md5.clone(),
            name: Some(f.name.clone()),
        })
        .collect();

    let manifest_entry = CacheManifestEntry {
        featured_mod: featured_mod.to_string(),
        version,
        resolved_version: resolved,
        name: entry_name,
        url: entry_url,
        git_short_sha,
        signature: Some(short_hash),
        files: cached_files,
        updated_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        base_version,
    };

    let is_rolling = featured_mod == "fafdevelop" || featured_mod == "fafbeta";
    if !is_rolling || cache_rolling_branches {
        save_cache_manifest_entry(cache_dir, manifest_entry);
    }

    Ok(InstalledMod {
        version: resolved,
        engine_version,
    })
}

async fn fetch_mod_id(
    http: &reqwest::Client,
    token: &str,
    api_base: &str,
    featured_mod: &str,
) -> Result<String, String> {
    let mut url = url::Url::parse(&format!("{api_base}/data/featuredMod"))
        .map_err(|e| format!("invalid API base: {e}"))?;
    url.query_pairs_mut()
        .append_pair("filter", &format!(r#"technicalName=="{featured_mod}""#));

    let resp = http
        .get(url)
        .bearer_auth(token)
        .header(reqwest::header::ACCEPT, "application/vnd.api+json")
        .send()
        .await
        .map_err(|e| {
            format!(
                "request failed: {}",
                crate::infra::http::describe_transport_error(&e)
            )
        })?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("read failed: {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "/data/featuredMod returned {status}: {}",
            body.chars().take(200).collect::<String>()
        ));
    }

    let doc: JsonApiList = serde_json::from_str(&body).map_err(|e| format!("invalid JSON: {e}"))?;
    doc.data
        .into_iter()
        .next()
        .map(|e| e.id)
        .ok_or_else(|| format!("no featured mod named '{featured_mod}'"))
}

/// Fetch the file list for one release, or for `latest` when `version` is
/// `None`: the exact segment both reference clients use for "whatever the
/// server is on right now" (Java's `getFeaturedModFiles(mod, null)`, the
/// Python client's `_resolve_base_version` returning `"latest"`).
use std::sync::Mutex;
use std::time::{Duration, Instant};

struct CachedFileList {
    expires_at: Instant,
    files: Vec<FeaturedModFile>,
}

type FileListCache = std::collections::HashMap<(String, Option<i32>), CachedFileList>;

static FILE_LIST_CACHE: Mutex<Option<FileListCache>> = Mutex::new(None);

pub fn clear_file_list_cache() {
    if let Ok(mut lock) = FILE_LIST_CACHE.lock() {
        *lock = None;
    }
}

async fn fetch_file_list(
    http: &reqwest::Client,
    token: &str,
    api_base: &str,
    mod_id: &str,
    featured_mod: &str,
    version: Option<i32>,
) -> Result<Vec<FeaturedModFile>, String> {
    // Rolling branches (fafdevelop, fafbeta) change frequently with git commits, so skip file list cache
    let is_rolling = featured_mod == "fafdevelop" || featured_mod == "fafbeta";
    let cache_key = (mod_id.to_string(), version);
    if !is_rolling {
        if let Ok(guard) = FILE_LIST_CACHE.lock() {
            if let Some(cache) = guard.as_ref() {
                if let Some(entry) = cache.get(&cache_key) {
                    if Instant::now() < entry.expires_at {
                        return Ok(entry.files.clone());
                    }
                }
            }
        }
    }

    let version_str = version.map_or_else(|| "latest".to_string(), |v| v.to_string());
    let url = format!("{api_base}/featuredMods/{mod_id}/files/{version_str}");
    let resp = http
        .get(&url)
        .bearer_auth(token)
        .header(reqwest::header::ACCEPT, "application/vnd.api+json")
        .send()
        .await
        .map_err(|e| {
            format!(
                "request failed: {}",
                crate::infra::http::describe_transport_error(&e)
            )
        })?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("read failed: {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "{url} returned {status}: {}",
            body.chars().take(200).collect::<String>()
        ));
    }

    let doc: JsonApiList = serde_json::from_str(&body).map_err(|e| format!("invalid JSON: {e}"))?;
    let files: Vec<FeaturedModFile> = doc
        .data
        .into_iter()
        .map(|e| {
            serde_json::from_value(e.attributes)
                .map_err(|err| format!("invalid featuredModFile attributes: {err}"))
        })
        .collect::<Result<_, _>>()?;

    if !is_rolling {
        if let Ok(mut guard) = FILE_LIST_CACHE.lock() {
            let cache = guard.get_or_insert_with(std::collections::HashMap::new);
            cache.insert(
                cache_key,
                CachedFileList {
                    expires_at: Instant::now() + Duration::from_secs(600), // 10 minutes TTL
                    files: files.clone(),
                },
            );
        }
    }

    Ok(files)
}

/// Read every listed file and compare it against the API's MD5, naming each
/// one as it goes; answer with the ones that need fetching.
///
/// `_calculate_md5s` in the Python client's `UpdaterWorker`, which emits
/// `hash_progress` per file and drives its own bar in the dialog. The point of
/// narrating a pass that usually changes nothing is that it is the pass that
/// takes the time: a few hundred files read off disk, every launch, whether or
/// not a single byte turns out to be stale.
///
/// A file whose checksum cannot be read at all -- missing, unreadable, the
/// wrong length -- counts as outdated and is left to [`update_file`], which is
/// where a bad checksum from the API becomes an error.
///
/// Stops before the next file once `called_off` is cancelled: the pass only
/// reads, so there is nothing to finish.
async fn checksum_pass<'a>(
    target_dir: &Path,
    files: &'a [FeaturedModFile],
    featured_mod: &str,
    resolved: i32,
    progress: &(dyn Fn(PreparationStep) + Sync),
    called_off: &CancellationToken,
) -> Result<Vec<&'a FeaturedModFile>, String> {
    let total = files.len();
    let mut outdated = Vec::new();
    for (index, file) in files.iter().enumerate() {
        if called_off.is_cancelled() {
            return Err(CALLED_OFF.to_string());
        }
        progress(PreparationStep::counted(
            PreparationPhase::Verifying,
            format!(
                "Checking {featured_mod} {resolved}: {} ({}/{total})",
                file.name,
                index + 1
            ),
            index + 1,
            total,
        ));
        if !file_matches_checksum(target_dir, file).await {
            outdated.push(file);
        }
    }
    Ok(outdated)
}

/// Fetch every file the checksum pass rejected, one at a time, and stop
/// between two of them once `called_off` is cancelled.
///
/// Between two files is where stopping costs nothing: every file before that
/// point is the new one and every file after it the old one, each of them
/// whole, because a file reaches the install in one step (see
/// [`update_file`]). The next run's checksum pass finds the ones still out of
/// date and fetches only those. A download still in flight is dropped as well,
/// by [`update_file`] itself, since nothing of it has been written yet.
#[allow(clippy::too_many_arguments)]
async fn update_outdated(
    http: &reqwest::Client,
    api_base: &str,
    cache_dir: &Path,
    target_dir: &Path,
    outdated: &[&FeaturedModFile],
    featured_mod: &str,
    resolved: i32,
    progress: &(dyn Fn(PreparationStep) + Sync),
    lease: &InstallLease,
    called_off: &CancellationToken,
) -> Result<(), String> {
    let pending = outdated.len();
    for (done, file) in outdated.iter().enumerate() {
        if called_off.is_cancelled() {
            return Err(CALLED_OFF.to_string());
        }
        update_file(
            http,
            api_base,
            cache_dir,
            target_dir,
            file,
            featured_mod,
            resolved,
            done,
            pending,
            progress,
            lease,
            called_off,
        )
        .await?;
    }
    Ok(())
}

/// Whether the file on disk already is the one the API listed.
async fn file_matches_checksum(target_dir: &Path, file: &FeaturedModFile) -> bool {
    let Ok(target_path) = safe_join_file(target_dir, &file.group, &file.name) else {
        return false;
    };
    file_md5(&target_path)
        .await
        .is_some_and(|md5| md5.eq_ignore_ascii_case(&file.md5))
}

/// The ceiling on one featured-mod file.
///
/// Not the vault's [`MAX_DOWNLOAD_BYTES`], which bounds a map or a mod a
/// player picked and was shared with this path by accident. The co-op mod's
/// `SCCA_FMV.nx2` is FAF's own content and larger than that, so every co-op
/// launch failed on it, and `env.nx2` was 34 MiB short of failing too (#282).
/// These files stream to disk rather than into memory and are checked against
/// the API's MD5, so the bound is only there to stop a broken or hostile
/// server from filling the disk.
const MAX_FEATURED_FILE_BYTES: u64 = 4 * 1024 * 1024 * 1024;

/// The MD5 of a file, read a block at a time, or `None` when it cannot be
/// read. Featured-mod files run to hundreds of megabytes, and hashing one
/// used to mean holding all of it in memory first.
///
/// Not leased: it only reads, so one left running after a cancel changes
/// nothing the next install pass could trip over.
async fn file_md5(path: &Path) -> Option<String> {
    let path = path.to_path_buf();
    off_runtime(move || content_store::md5_of_file(&path))
        .await
        .ok()
        .flatten()
}

/// Whether a download URL the API handed us may be requested, and handed the
/// HMAC token that authorises it.
///
/// The file list arrives from the API with a `cacheable_url` per file, and it
/// was fetched as given: the only integrity anchor was the MD5 in the same
/// document, and MD5 collides. A compromised or mis-served API could point the
/// download anywhere and be sent the token with it.
///
/// The rule is the one `vault_install::validate_url` uses, loosened only where
/// FAF really does spread files across hosts: same site as the API base, which
/// covers `content.faforever.com` and any `*.faforever.com` cache, and nothing
/// else. A host with no dot in it (a local test server) has to match exactly.
fn is_allowed_download_host(raw: &str, api_base: &str) -> bool {
    let Ok(url) = url::Url::parse(raw) else {
        return false;
    };
    let Ok(base) = url::Url::parse(api_base) else {
        return false;
    };
    // Never plaintext unless the configured base itself is, which is only ever
    // a deliberate local setup.
    if url.scheme() != "https" && url.scheme() != base.scheme() {
        return false;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    let (Some(host), Some(base_host)) = (url.host_str(), base.host_str()) else {
        return false;
    };
    if host.eq_ignore_ascii_case(base_host) {
        return true;
    }
    // The API base's registrable site: the last two labels of its host.
    let mut labels = base_host.rsplitn(3, '.');
    let (Some(tld), Some(domain)) = (labels.next(), labels.next()) else {
        return false;
    };
    let site = format!("{domain}.{tld}");
    host.eq_ignore_ascii_case(&site)
        || host
            .to_ascii_lowercase()
            .ends_with(&format!(".{}", site.to_ascii_lowercase()))
}

/// Bring one outdated file up to date: serve from the content-addressed cache
/// or download fresh (populating the cache either way, for reuse across
/// versions/replays that share a file).
///
/// The caller has already established that this file does not match, so there
/// is no checksum shortcut here: `done`/`total` count the files being
/// *fetched*, not the whole mod.
#[allow(clippy::too_many_arguments)]
async fn update_file(
    http: &reqwest::Client,
    api_base: &str,
    cache_dir: &Path,
    target_dir: &Path,
    file: &FeaturedModFile,
    featured_mod: &str,
    resolved: i32,
    done: usize,
    total: usize,
    progress: &(dyn Fn(PreparationStep) + Sync),
    lease: &InstallLease,
    called_off: &CancellationToken,
) -> Result<(), String> {
    let target_path = safe_join_file(target_dir, &file.group, &file.name)?;
    if !is_allowed_download_host(&file.cacheable_url, api_base) {
        return Err(format!(
            "the API pointed {} at a download outside FAF",
            file.name
        ));
    }
    if file.md5.len() != 32 || !file.md5.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!(
            "the API returned an invalid checksum for {}",
            file.name
        ));
    }

    let detail = format!(
        "Updating {featured_mod} {resolved}: {} ({}/{total})",
        file.name,
        done + 1
    );
    progress(PreparationStep::counted(
        PreparationPhase::Downloading,
        detail.clone(),
        done,
        total,
    ));

    if let Some(parent) = target_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
    }

    // `verified` hashes the entry and discards it when it no longer matches:
    // a killed prior write or external cache edit must not be promoted into
    // the live game merely because its filename looks like an MD5.
    //
    // The target is replaced, never copied over in place: it may be a hard
    // link to some other store entry, left there by replay staging, and an
    // in-place copy would rewrite that entry under its old checksum.
    let cached = {
        let (root, group, md5) = (
            cache_dir.to_path_buf(),
            file.group.clone(),
            file.md5.clone(),
        );
        off_runtime(move || ContentStore::new(&root).verified(&group, &md5)).await??
    };
    // The writes into the install hold its lease until they return, so one
    // left running by a cancelled launch still keeps the next one out. The
    // store calls around them only touch the cache, which no install lease
    // covers.
    if let Some(entry) = cached {
        let target = target_path.clone();
        off_runtime_leased(lease, move || replace_with_copy(&entry, &target))
            .await?
            .map_err(|e| format!("could not copy cached {}: {e}", file.name))?;
        progress(PreparationStep::counted(
            PreparationPhase::Downloading,
            detail,
            done + 1,
            total,
        ));
        return Ok(());
    }

    // Byte progress while the file is in flight, which is the Python dialog's
    // `on_download_progress`: without it a single large file is one unmoving
    // line for however long the CDN takes.
    //
    // Throttled to whole percent. `on_bytes` fires per chunk, and an event per
    // chunk would put thousands of snapshots through the bus to redraw the
    // same bar.
    let last_percent = std::sync::atomic::AtomicU8::new(u8::MAX);
    // The download and its checksum write nothing but a temporary file, which
    // goes with its handle, so a call-off stops them where they are: a file of
    // hundreds of megabytes is not waited out for a run nobody wants. Past
    // this point the file goes into the store and the install whole.
    let downloaded = unless_called_off(called_off, async {
        // The hmac fields are an HTTP header, not a query param, despite the
        // field name: mirrors `BaseDownload.prepare_request` in the Python
        // client's `downloadManager/__init__.py`: `setRawHeader(hmac_parameter,
        // hmac_token)`. A custom User-Agent is set there too; some CDN configs
        // gate on it, so we send the same one.
        let resp = http
            .get(&file.cacheable_url)
            .header(&file.hmac_parameter, &file.hmac_token)
            .header(reqwest::header::USER_AGENT, "FAF Client")
            .send()
            .await
            .map_err(|e| format!("could not download {}: {e}", file.name))?;
        if !resp.status().is_success() {
            return Err(format!(
                "could not download {}: {}",
                file.name,
                resp.status()
            ));
        }
        // To a file, not into memory: see `MAX_FEATURED_FILE_BYTES`.
        let downloaded = bounded_body_to_file(
            resp,
            &file.name,
            MAX_FEATURED_FILE_BYTES,
            &|received, declared| {
                let Some(size) = declared.filter(|size| *size > 0) else {
                    return;
                };
                let percent = ((received.min(size) * 100) / size) as u8;
                if last_percent.swap(percent, std::sync::atomic::Ordering::Relaxed) == percent {
                    return;
                }
                progress(PreparationStep::counted(
                    PreparationPhase::Downloading,
                    format!(
                        "{detail}: {:.1} MB of {:.1} MB",
                        received as f64 / (1024.0 * 1024.0),
                        size as f64 / (1024.0 * 1024.0)
                    ),
                    done * 100 + percent as usize,
                    total * 100,
                ));
            },
        )
        .await?;
        if !file_md5(downloaded.path())
            .await
            .is_some_and(|md5| md5.eq_ignore_ascii_case(&file.md5))
        {
            return Err(format!("downloaded {} failed its checksum", file.name));
        }
        Ok(downloaded)
    })
    .await?;

    // Into the store first (whole, under its checksum), then from the store
    // into the install, replacing the target for the reason given above.
    let entry = {
        let (root, group, md5) = (
            cache_dir.to_path_buf(),
            file.group.clone(),
            file.md5.clone(),
        );
        let source = downloaded.path().to_path_buf();
        off_runtime(move || ContentStore::new(&root).insert(&group, &md5, &source)).await??
    };
    {
        let target = target_path.clone();
        off_runtime_leased(lease, move || replace_with_copy(&entry, &target))
            .await?
            .map_err(|e| format!("could not write {}: {e}", target_path.display()))?;
    }
    progress(PreparationStep::counted(
        PreparationPhase::Downloading,
        detail,
        done + 1,
        total,
    ));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    use crate::infra::game_updater::replay_version::stage_entry_files;
    use crate::infra::game_updater::test_support::{build_entry, put_in_store};

    #[test]
    fn a_download_url_has_to_stay_on_faf() {
        use super::is_allowed_download_host as allowed;
        let base = "https://api.faforever.com";

        // The hosts FAF really serves files from.
        assert!(allowed(
            "https://content.faforever.com/faf/updaterNew/x.nx2",
            base
        ));
        assert!(allowed("https://api.faforever.com/x", base));
        assert!(allowed("https://faforever.com/x", base));

        // The URL arrives in the same document as the MD5 that is supposed to
        // vouch for it, and it is sent the HMAC token that authorises the
        // download, so neither is evidence about the other.
        assert!(!allowed("https://faforever.com.evil.example/x", base));
        assert!(!allowed("https://evil.example/faforever.com/x", base));
        assert!(
            !allowed("http://content.faforever.com/x", base),
            "no plaintext"
        );
        assert!(
            !allowed("https://user:pw@content.faforever.com/x", base),
            "no credentials in the URL"
        );
        assert!(!allowed("file:///C:/Windows/System32/cmd.exe", base));
        assert!(!allowed("not a url", base));
    }

    #[test]
    fn a_local_test_api_still_works() {
        use super::is_allowed_download_host as allowed;
        // A deliberate local setup has no registrable domain to match on, so
        // the host has to be the same one, and its scheme is allowed to be the
        // base's own.
        let base = "http://localhost:8080";
        assert!(allowed("http://localhost:8080/files/x", base));
        assert!(!allowed("http://elsewhere:8080/files/x", base));
    }

    #[test]
    fn parses_featured_mod_file_list_response() {
        let doc: JsonApiList = serde_json::from_value(json!({
            "data": [{
                "type": "featuredModFile",
                "id": "1",
                "attributes": {
                    "group": "bin",
                    "name": "ForgedAlliance.exe",
                    "md5": "abc123",
                    "cacheableUrl": "https://content.example.com/bin/ForgedAlliance.exe",
                    "hmacToken": "tok",
                    "hmacParameter": "verify",
                },
            }],
        }))
        .unwrap();

        let files: Vec<FeaturedModFile> = doc
            .data
            .into_iter()
            .map(|e| serde_json::from_value(e.attributes).unwrap())
            .collect();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].group, "bin");
        assert_eq!(files[0].name, "ForgedAlliance.exe");
        assert_eq!(files[0].md5, "abc123");
        assert_eq!(files[0].hmac_parameter, "verify");
    }

    fn file(group: &str, name: &str, version: Option<i32>) -> FeaturedModFile {
        FeaturedModFile {
            group: group.into(),
            name: name.into(),
            md5: "abc".into(),
            version,
            cacheable_url: "https://example.invalid/f".into(),
            hmac_token: "tok".into(),
            hmac_parameter: "verify".into(),
        }
    }

    /// A file list whose checksums are the real MD5s of what is written to
    /// `dir`, so a `checksum_pass` over it finds everything current.
    fn staged(dir: &std::path::Path, names: &[(&str, &str)]) -> Vec<FeaturedModFile> {
        names
            .iter()
            .map(|(group, name)| {
                let body = format!("contents of {name}");
                let group_dir = dir.join(group);
                std::fs::create_dir_all(&group_dir).unwrap();
                std::fs::write(group_dir.join(name), &body).unwrap();
                FeaturedModFile {
                    group: (*group).into(),
                    name: (*name).into(),
                    md5: format!("{:x}", md5::compute(body.as_bytes())),
                    version: None,
                    cacheable_url: "https://example.invalid/f".into(),
                    hmac_token: "tok".into(),
                    hmac_parameter: "verify".into(),
                }
            })
            .collect()
    }

    #[tokio::test]
    async fn the_checksum_pass_names_every_file_it_reads() {
        // The report: an install that needs nothing says nothing, for as long
        // as it takes to read a few hundred files. The pass that finds nothing
        // to do is exactly the pass that has to narrate itself, because it is
        // the one that takes the time.
        let dir = tempfile::tempdir().unwrap();
        let files = staged(
            dir.path(),
            &[
                ("bin", "ForgedAlliance.exe"),
                ("gamedata", "units.nx2"),
                ("gamedata", "lua.nx2"),
            ],
        );

        let seen = std::sync::Mutex::new(Vec::new());
        let outdated = checksum_pass(
            dir.path(),
            &files,
            "faf",
            3836,
            &|step| seen.lock().unwrap().push(step),
            &CancellationToken::new(),
        )
        .await
        .unwrap();

        assert!(outdated.is_empty(), "everything on disk is current");
        let seen = seen.into_inner().unwrap();
        assert_eq!(seen.len(), 3, "one line per file, not one per download");
        assert!(seen
            .iter()
            .all(|step| step.phase == PreparationPhase::Verifying));
        assert!(seen[0].detail.contains("ForgedAlliance.exe"));
        assert_eq!(
            seen[0].detail,
            "Checking faf 3836: ForgedAlliance.exe (1/3)"
        );
        assert_eq!(
            (seen[0].progress, seen[2].progress),
            (Some(33), Some(100)),
            "the bar tracks files read, so it moves while nothing downloads"
        );
    }

    #[tokio::test]
    async fn a_file_that_does_not_match_is_handed_on_to_be_fetched() {
        let dir = tempfile::tempdir().unwrap();
        let mut files = staged(dir.path(), &[("bin", "current.dat"), ("bin", "stale.dat")]);
        // The API moved on: the local copy is now the wrong one.
        files[1].md5 = format!("{:x}", md5::compute(b"a newer build"));
        // And one the install has never had at all.
        files.push(FeaturedModFile {
            group: "bin".into(),
            name: "added.dat".into(),
            md5: format!("{:x}", md5::compute(b"brand new")),
            version: None,
            cacheable_url: "https://example.invalid/f".into(),
            hmac_token: "tok".into(),
            hmac_parameter: "verify".into(),
        });

        let outdated = checksum_pass(
            dir.path(),
            &files,
            "faf",
            3836,
            &|_| {},
            &CancellationToken::new(),
        )
        .await
        .unwrap();

        let names: Vec<&str> = outdated.iter().map(|file| file.name.as_str()).collect();
        assert_eq!(
            names,
            ["stale.dat", "added.dat"],
            "a missing file is outdated, not an error: update_file fetches it"
        );
    }

    #[test]
    fn a_file_lists_version_is_accepted_as_a_string_a_number_or_not_at_all() {
        let parse =
            |attributes: Value| -> FeaturedModFile { serde_json::from_value(attributes).unwrap() };
        let base = |extra: Value| {
            let mut v = json!({
                "group": "bin",
                "name": "ForgedAlliance.exe",
                "md5": "abc123",
                "cacheableUrl": "https://example.invalid/f",
                "hmacToken": "tok",
                "hmacParameter": "verify",
            });
            if let (Some(map), Some(more)) = (v.as_object_mut(), extra.as_object()) {
                map.extend(more.clone());
            }
            v
        };

        // The API sends it as a string today; a bare number and an absent
        // field both have to stay non-fatal, since the field only feeds
        // version *inference* and every other path supplies the number.
        assert_eq!(parse(base(json!({"version": "3775"}))).version, Some(3775));
        assert_eq!(parse(base(json!({"version": 3775}))).version, Some(3775));
        assert_eq!(parse(base(json!({}))).version, None);
        assert_eq!(parse(base(json!({"version": null}))).version, None);
        assert_eq!(
            parse(base(json!({"version": 4_294_967_296_u64}))).version,
            None
        );
    }

    #[test]
    fn latest_resolves_to_the_engine_executables_own_version() {
        // Not the highest in the list: a release can ship a newer data file
        // than executable, and FA reports the version baked into the exe.
        let files = [
            file("gamedata", "units.nx2", Some(3777)),
            file("bin", "ForgedAlliance.exe", Some(3775)),
        ];
        assert_eq!(
            effective_version(&files, "ForgedAlliance.exe"),
            Some(3775),
            "the executable's entry wins over the list maximum"
        );
    }

    #[test]
    fn latest_falls_back_to_the_highest_version_without_an_executable() {
        // An overlay mod (`nomads`) ships no executable at all.
        let files = [
            file("gamedata", "nomads.nx2", Some(4)),
            file("gamedata", "nomadsinit.nx2", Some(7)),
        ];
        assert_eq!(effective_version(&files, "ForgedAlliance.exe"), Some(7));
    }

    #[test]
    fn an_unversioned_file_list_resolves_to_nothing() {
        // Better than defaulting to 0, which would stamp the executable as a
        // build that never existed.
        let files = [file("bin", "ForgedAlliance.exe", None)];
        assert_eq!(effective_version(&files, "ForgedAlliance.exe"), None);
    }

    #[test]
    fn the_executable_is_matched_case_insensitively() {
        let files = [file("bin", "forgedalliance.exe", Some(3775))];
        assert_eq!(effective_version(&files, "ForgedAlliance.exe"), Some(3775));
    }

    #[test]
    fn overlay_mods_are_distinguished_from_complete_installs() {
        // Only the four base mods are a whole game; everything else needs
        // `faf` underneath it first.
        for base in ["faf", "ladder1v1", "fafbeta", "fafdevelop"] {
            assert!(BASE_FEATURED_MODS.contains(&base), "{base} is a base mod");
        }
        for overlay in ["nomads", "coop", "murderparty"] {
            assert!(
                !BASE_FEATURED_MODS.contains(&overlay),
                "{overlay} must pull faf in first"
            );
        }
    }

    #[tokio::test]
    async fn an_update_write_to_a_staged_file_leaves_the_cached_entry_alone() {
        // Replay staging hard-links store entries into the install. The
        // updater used to copy over such a file in place, which rewrote the
        // store entry it was linked to: the cache then served the new bytes
        // under the old checksum.
        let temp = tempfile::tempdir().unwrap();
        let cache = temp.path().join("cache");
        let target = temp.path().join("replaydata");
        let old = put_in_store(&cache, "gamedata", b"units for build 3837");
        let new = put_in_store(&cache, "gamedata", b"units for build 3838");
        stage_entry_files(
            &cache,
            &target,
            &build_entry(3837, &[("gamedata", "units.nx2", &old)]),
        )
        .unwrap();

        // The live update path, served from the store (so no network).
        let file = FeaturedModFile {
            group: "gamedata".into(),
            name: "units.nx2".into(),
            md5: new.clone(),
            version: Some(3838),
            cacheable_url: "https://content.faforever.com/faf/updaterNew/units.nx2".into(),
            hmac_token: "tok".into(),
            hmac_parameter: "verify".into(),
        };
        update_file(
            &reqwest::Client::new(),
            "https://api.faforever.com",
            &cache,
            &target,
            &file,
            "faf",
            3838,
            0,
            1,
            &|_| {},
            &crate::infra::game_updater::lease_install(&target).await,
            &CancellationToken::new(),
        )
        .await
        .unwrap();

        assert_eq!(
            std::fs::read(target.join("gamedata").join("units.nx2")).unwrap(),
            b"units for build 3838"
        );
        assert_eq!(
            std::fs::read(cache.join("gamedata").join(&old)).unwrap(),
            b"units for build 3837",
            "the store entry must keep the bytes its checksum names"
        );
    }

    /// A join called off while its update is part-way through the files. The
    /// file loop used to run to the end of the list, holding the install, so
    /// the next join's update waited behind it unnarrated. It stops between
    /// two files now: the file it was on is finished, whole, and the next one
    /// is never started.
    #[tokio::test]
    async fn the_file_loop_stops_between_two_files_once_called_off() {
        let temp = tempfile::tempdir().unwrap();
        let cache = temp.path().join("cache");
        let target = temp.path().join("game");
        // Served from the store, so no network: the file loop alone is tested.
        let names = ["units.nx2", "lua.nx2", "env.nx2"];
        let files: Vec<FeaturedModFile> = names
            .iter()
            .map(|name| FeaturedModFile {
                group: "gamedata".into(),
                name: (*name).into(),
                md5: put_in_store(&cache, "gamedata", format!("{name} for 3838").as_bytes()),
                version: Some(3838),
                cacheable_url: format!("https://content.faforever.com/faf/updaterNew/{name}"),
                hmac_token: "tok".into(),
                hmac_parameter: "verify".into(),
            })
            .collect();
        let outdated: Vec<&FeaturedModFile> = files.iter().collect();

        // Called off the moment the first file has been written, which is
        // while the loop is still on it.
        let called_off = CancellationToken::new();
        let stopped = update_outdated(
            &reqwest::Client::new(),
            "https://api.faforever.com",
            &cache,
            &target,
            &outdated,
            "faf",
            3838,
            &|step| {
                if step.progress == Some(33) {
                    called_off.cancel();
                }
            },
            &crate::infra::game_updater::lease_install(&target).await,
            &called_off,
        )
        .await;

        assert_eq!(stopped, Err(CALLED_OFF.to_string()));
        assert_eq!(
            std::fs::read(target.join("gamedata").join("units.nx2")).unwrap(),
            b"units.nx2 for 3838",
            "the file the loop was on is finished, and stays updated"
        );
        for name in ["lua.nx2", "env.nx2"] {
            assert!(
                !target.join("gamedata").join(name).exists(),
                "{name} was written after the update was called off"
            );
        }
    }

    /// The download path's half of a cancelled launch: its write into the
    /// install runs on the blocking pool and outlives the dropped update. The
    /// next update of the same install used to write the same file beside it,
    /// and whichever finished last won. It has to wait for that write instead.
    #[tokio::test]
    async fn a_cancelled_update_holds_the_install_until_its_write_has_finished() {
        use crate::infra::game_updater::lease_install;
        use crate::infra::game_updater::test_support::probe::{self, Event};

        let temp = tempfile::tempdir().unwrap();
        let cache = temp.path().join("cache");
        let target = temp.path().join("replaydata");
        let old = put_in_store(&cache, "gamedata", b"units for build 3837");
        let new = put_in_store(&cache, "gamedata", b"units for build 3838");

        let (mut events, release) = probe::watch(&target);
        // One update pass writing `units.nx2` at `md5`, served from the store
        // (so no network), holding the install the way a whole pass does.
        let update = |md5: String, version: i32| {
            let (cache, target) = (cache.clone(), target.clone());
            tokio::spawn(async move {
                let file = FeaturedModFile {
                    group: "gamedata".into(),
                    name: "units.nx2".into(),
                    md5,
                    version: Some(version),
                    cacheable_url: "https://content.faforever.com/faf/updaterNew/units.nx2".into(),
                    hmac_token: "tok".into(),
                    hmac_parameter: "verify".into(),
                };
                let lease = lease_install(&target).await;
                update_file(
                    &reqwest::Client::new(),
                    "https://api.faforever.com",
                    &cache,
                    &target,
                    &file,
                    "faf",
                    version,
                    0,
                    1,
                    &|_| {},
                    &lease,
                    &CancellationToken::new(),
                )
                .await
            })
        };

        // The first update's write is held part-way, and the update is
        // called off around it.
        let cancelled = update(old, 3837);
        assert_eq!(events.recv().await, Some(Event::Writing));
        cancelled.abort();
        assert!(cancelled.await.unwrap_err().is_cancelled());

        let replacement = update(new, 3838);
        assert_eq!(
            events.recv().await,
            Some(Event::WaitingForInstall),
            "the next update wrote into the install while the cancelled one's \
             write was still running"
        );

        release.send(()).unwrap();
        assert_eq!(events.recv().await, Some(Event::Writing));
        replacement.await.unwrap().unwrap();
        assert_eq!(
            std::fs::read(target.join("gamedata").join("units.nx2")).unwrap(),
            b"units for build 3838",
            "the replacement's write is the one that lands last"
        );
    }
}
