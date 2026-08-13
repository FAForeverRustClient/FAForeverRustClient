//! Game version updater — makes sure a specific engine build is on disk
//! before a replay is played back.
//!
//! Mirrors the Python client's `fa/check.py` + `fa/game_updater/*`: FA
//! refuses to load a replay whose embedded engine version doesn't match the
//! installed one (`"Ack! Unable to load game replay"`), so before *every*
//! replay launch the reference clients diff the local install against the
//! FAF API's file list for that exact `(featured_mod, version)` and update
//! whatever's stale. There is no binary diffing — just per-file MD5
//! comparison, a content-addressed cache, full-file downloads for anything
//! that doesn't match, a tiny 3-offset hex patch of the version number
//! baked into the executable, and a generated `fa_path.lua` FA's Lua
//! bootstrap reads to find everything. Scope: only the base featured-mod
//! types we ever see in replays (`faf`, `ladder1v1`, `fafbeta`,
//! `fafdevelop`) — real total-conversion mods needing the base `faf` files
//! *plus* their own overlay is a documented gap, as are map/sim-mod
//! auto-download and per-file progress reporting (all Qt-signal plumbing in
//! the Python client, no architectural equivalent needed here).

use std::io::{Seek as _, SeekFrom, Write as _};
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;

/// Byte offsets inside `ForgedAlliance.exe` where the 4-byte little-endian
/// engine version number is stored. Mirrors `FAPatcher.version_addresses` in
/// the Python client's `fa/game_updater/patcher.py` — these must match
/// exactly or FA reports/behaves as the wrong version.
const VERSION_ADDRESSES: [u64; 3] = [0xd3d40, 0x47612d, 0x476666];

/// One file from `GET /featuredMods/{mod_id}/files/{version}`. `group` is the
/// subdirectory under the target install root (`bin`, `gamedata`, …).
#[derive(Debug, Clone, Deserialize)]
struct FeaturedModFile {
    group: String,
    name: String,
    md5: String,
    #[serde(rename = "cacheableUrl")]
    cacheable_url: String,
    #[serde(rename = "hmacToken")]
    hmac_token: String,
    #[serde(rename = "hmacParameter")]
    hmac_parameter: String,
}

/// A JSON:API document shaped like `{ data: [...] }` — reused here rather
/// than the fuller `JsonApiDoc`/`JsonApiResource` in `infra/replay.rs` since
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
/// write `fa_path.lua`. Idempotent and cheap to call before every replay —
/// files already matching by MD5 are left untouched (mirrors Python calling
/// `check()` unconditionally before each replay rather than pre-checking
/// whether an update is needed).
// Every parameter is independently required and there's a single call site
// (`infra::replay::play_file`) — a params struct wouldn't add clarity here.
#[allow(clippy::too_many_arguments)]
pub async fn ensure_game_version(
    http: &reqwest::Client,
    token: &str,
    api_base: &str,
    cache_dir: &Path,
    target_dir: &Path,
    featured_mod: &str,
    version: i32,
    exe_name: &str,
) -> Result<(), String> {
    let mod_id = fetch_mod_id(http, token, api_base, featured_mod).await?;
    let files = fetch_file_list(http, token, api_base, &mod_id, version).await?;

    for file in &files {
        update_file(http, cache_dir, target_dir, file).await?;
    }

    let exe_path = files
        .iter()
        .find(|f| f.group == "bin" && f.name == exe_name)
        .map(|f| target_dir.join(&f.group).join(&f.name))
        .unwrap_or_else(|| target_dir.join("bin").join(exe_name));
    patch_exe_version(&exe_path, version)?;

    write_fa_path_lua(target_dir, &retail_install_dir(target_dir), featured_mod, version)?;
    Ok(())
}

/// The retail Supreme Commander: Forged Alliance install root — where the
/// base-game `movies`, `sounds`, `fonts`, and `gamedata/*.scd` live. This is
/// **not** the FAF patch dir (`target_dir`, e.g. `.../replaydata`), which
/// only holds FAF's `.nx2` gamedata overrides and the patched executable.
///
/// Mirrors the Python client's `ForgedAlliance/app/path` setting, which
/// `writeFAPathLua` writes verbatim as `fa_path`. Getting this wrong is
/// invisible-but-crippling: the FAF init script mounts `fa_path/movies`,
/// `fa_path/sounds`, `fa_path/fonts` — point `fa_path` at the FAF patch dir
/// (which has none of those) and the game still *runs* (base unit/effect
/// blueprints come from the `.nx2` files, mounted relative to the exe), but
/// with no loading-screen movie, no audio, and broken menu fonts.
/// Confirmed live as the cause of exactly that symptom.
///
/// Resolution order: explicit `FAF_GAME_INSTALL_DIR` override → auto-detect
/// among the usual retail/Steam locations (validated by `gamedata/lua.scd`,
/// same probe file Python's `validate_game_path` uses) → `target_dir` as a
/// last resort (preserves the old behaviour rather than writing a knowingly
/// bogus path when nothing is found).
fn retail_install_dir(target_dir: &Path) -> PathBuf {
    if let Ok(dir) = std::env::var("FAF_GAME_INSTALL_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    typical_retail_install_paths()
        .into_iter()
        .find(|p| p.join("gamedata").join("lua.scd").is_file())
        .unwrap_or_else(|| target_dir.to_path_buf())
}

/// Candidate retail install locations, mirroring the Python client's
/// `typicalForgedAlliancePaths` (THQ/GPG retail, bare retail, and the Steam
/// library — both `%ProgramFiles%` and `%ProgramFiles(x86)%`, since the
/// 32-bit game usually sits under the x86 tree).
fn typical_retail_install_paths() -> Vec<PathBuf> {
    let mut out = Vec::new();
    let program_files_vars = ["ProgramFiles(x86)", "ProgramFiles"];
    let suffixes = [
        r"THQ\Gas Powered Games\Supreme Commander - Forged Alliance",
        r"Supreme Commander - Forged Alliance",
        r"Steam\steamapps\common\Supreme Commander Forged Alliance",
    ];
    for var in program_files_vars {
        if let Ok(base) = std::env::var(var) {
            if base.is_empty() {
                continue;
            }
            for suffix in suffixes {
                out.push(PathBuf::from(&base).join(suffix));
            }
        }
    }
    out
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
        .map_err(|e| format!("request failed: {e}"))?;
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

async fn fetch_file_list(
    http: &reqwest::Client,
    token: &str,
    api_base: &str,
    mod_id: &str,
    version: i32,
) -> Result<Vec<FeaturedModFile>, String> {
    let url = format!("{api_base}/featuredMods/{mod_id}/files/{version}");
    let resp = http
        .get(&url)
        .bearer_auth(token)
        .header(reqwest::header::ACCEPT, "application/vnd.api+json")
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("read failed: {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "{url} returned {status}: {}",
            body.chars().take(200).collect::<String>()
        ));
    }

    let doc: JsonApiList = serde_json::from_str(&body).map_err(|e| format!("invalid JSON: {e}"))?;
    doc.data
        .into_iter()
        .map(|e| {
            serde_json::from_value(e.attributes)
                .map_err(|err| format!("invalid featuredModFile attributes: {err}"))
        })
        .collect()
}

/// Bring one file up to date: skip if the local MD5 already matches, else
/// serve from the content-addressed cache or download fresh (populating the
/// cache either way, for reuse across versions/replays that share a file).
async fn update_file(
    http: &reqwest::Client,
    cache_dir: &Path,
    target_dir: &Path,
    file: &FeaturedModFile,
) -> Result<(), String> {
    let target_path = target_dir.join(&file.group).join(&file.name);

    if let Ok(bytes) = tokio::fs::read(&target_path).await {
        if format!("{:x}", md5::compute(&bytes)) == file.md5 {
            return Ok(()); // already up to date
        }
    }

    if let Some(parent) = target_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
    }

    let cache_path = cache_dir.join(&file.group).join(&file.md5);
    if tokio::fs::metadata(&cache_path).await.is_ok() {
        tokio::fs::copy(&cache_path, &target_path)
            .await
            .map_err(|e| format!("could not copy cached {}: {e}", file.name))?;
        return Ok(());
    }

    // The hmac fields are an HTTP header, not a query param, despite the
    // field name — mirrors `BaseDownload.prepare_request` in the Python
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
        return Err(format!("could not download {}: {}", file.name, resp.status()));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("could not read {}: {e}", file.name))?;

    if let Some(parent) = cache_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
    }
    tokio::fs::write(&cache_path, &bytes)
        .await
        .map_err(|e| format!("could not write cache for {}: {e}", file.name))?;
    tokio::fs::write(&target_path, &bytes)
        .await
        .map_err(|e| format!("could not write {}: {e}", target_path.display()))?;
    Ok(())
}

/// Stamp `version` (little-endian, 4 bytes) into the three fixed offsets in
/// the FA executable. A no-op error (not fatal to the caller) if the exe
/// isn't there — mirrors the Python client tolerating a missing exe path at
/// this stage, since `update_file` above should already have placed it.
fn patch_exe_version(exe_path: &Path, version: i32) -> Result<(), String> {
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(exe_path)
        .map_err(|e| format!("could not open {} for patching: {e}", exe_path.display()))?;
    let bytes = version.to_le_bytes();
    for &addr in &VERSION_ADDRESSES {
        file.seek(SeekFrom::Start(addr))
            .map_err(|e| format!("could not seek to {addr:#x}: {e}"))?;
        file.write_all(&bytes)
            .map_err(|e| format!("could not patch version at {addr:#x}: {e}"))?;
    }
    Ok(())
}

/// Mirrors `fa/path.py:writeFAPathLua`. Written into `target_dir` (the FAF
/// patch dir, e.g. `.../replaydata`); the FAF init script beside the exe
/// reads it to locate everything else.
///
/// `fa_path` is the **retail install root** ([`retail_install_dir`]), not
/// `target_dir` — the init script mounts `fa_path/{movies,sounds,fonts}` and
/// `fa_path/gamedata/*.scd` from it, none of which exist under the FAF patch
/// dir. This matches Python writing its `ForgedAlliance/app/path` setting
/// verbatim. (FAF's own `.nx2` gamedata overrides are mounted separately by
/// the init script, relative to the exe — `InitFileDir/../gamedata` — so
/// they keep coming from `target_dir` regardless of `fa_path`.)
///
/// `custom_vault_path` is the user's actual vault root
/// ([`documents_vault_dir`], mirroring Python's `util.VAULTS_BASE_DIR`) —
/// the same root [`default_map_search_dirs`]'s first entry stages maps into,
/// so the two never diverge.
fn write_fa_path_lua(
    target_dir: &Path,
    retail_dir: &Path,
    featured_mod: &str,
    version: i32,
) -> Result<(), String> {
    let vault_path = documents_vault_dir().unwrap_or_else(|| target_dir.join("vault"));
    let content = format!(
        "fa_path = \"{}\"\ncustom_vault_path = \"{}\"\nGameType = \"{featured_mod}\"\nGameVersion = \"{version}\"\nClientVersion = \"{}\"\nForceAffinity = false\n",
        slashed(retail_dir),
        slashed(&vault_path),
        env!("CARGO_PKG_VERSION"),
    );
    std::fs::write(target_dir.join("fa_path.lua"), content)
        .map_err(|e| format!("could not write fa_path.lua: {e}"))
}

/// The user's vault root — mirrors Python's `util.VAULTS_BASE_DIR` default
/// (`PERSONAL_DIR/My Games/Gas Powered Games/Supreme Commander Forged
/// Alliance`, `PERSONAL_DIR` being the user's Documents folder). Shared by
/// [`write_fa_path_lua`] (as `custom_vault_path`) and
/// [`default_map_search_dirs`] (as its first, and primary, map search dir) —
/// they must never diverge, since that's exactly the bug this fixes.
fn documents_vault_dir() -> Option<PathBuf> {
    directories::UserDirs::new()?
        .document_dir()
        .map(|docs| docs.join("My Games/Gas Powered Games/Supreme Commander Forged Alliance"))
}

fn slashed(path: &Path) -> String {
    path.display().to_string().replace('\\', "/")
}

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
    let map_path = replay_and_map.split("\r\n").nth(1)?;
    if !map_path.starts_with("/maps/") {
        return None;
    }
    map_path.split('/').nth(2).map(str::to_string)
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

/// The two directories FA's replay-mode init scripts may search for maps:
/// the user's real vault ([`documents_vault_dir`], honored by
/// `custom_vault_path`-aware init scripts) plus a second, legacy hardcoded
/// fallback under the replay install itself — old replays' init scripts
/// predate the "custom vault path" feature and never consult
/// `fa_path.lua`'s `custom_vault_path` for map lookup at all. Mirrors the FAF
/// Discord-documented workaround of manually copying a map into both.
fn default_map_search_dirs(replay_target_dir: &Path) -> Vec<PathBuf> {
    const SUB: &str = "My Games/Gas Powered Games/Supreme Commander Forged Alliance/maps";
    let mut dirs = Vec::new();
    if let Some(vault_dir) = documents_vault_dir() {
        dirs.push(vault_dir.join("maps"));
    }
    dirs.push(replay_target_dir.join("user").join(SUB));
    dirs
}

/// Every FAF vault map folder is named `{slug}.v{NNNN}` (confirmed against
/// every real vault map this project has seen, e.g. `adaptive_gadostb.v0002`
/// — the version suffix is how the vault disambiguates map revisions).
/// Official/base-game maps never carry that suffix (`scmp_002`, `X1MP_002`,
/// …) — they ship inside the FA install itself, mounted by `init_<mod>.lua`
/// straight from `fa_path`, entirely independent of the vault/custom-vault
/// mechanism this module stages into. Used to skip the vault CDN lookup
/// entirely for base maps: confirmed live (`X1MP_002`) that hitting the CDN
/// for one is a guaranteed, harmless 404 that otherwise surfaces as a
/// misleading "could not stage map" warning for something that was never
/// broken in the first place.
fn is_vault_map_folder(map_folder: &str) -> bool {
    match map_folder.rsplit_once(".v") {
        Some((_, suffix)) => !suffix.is_empty() && suffix.bytes().all(|b| b.is_ascii_digit()),
        None => false,
    }
}

/// Makes sure `map_folder` (e.g. `adaptive_gadostb.v0002`) is present in
/// every directory FA's replay mode searches — downloading the map's zip
/// from the public vault CDN and extracting it into each if it's missing
/// everywhere. A no-op (not fatal) if the download fails: official/base-game
/// maps (`scmp_XXX`) never need this and simply won't be found remotely,
/// which shouldn't block playback of a replay that doesn't actually need a
/// custom map — recognized up front via [`is_vault_map_folder`] so those
/// never even attempt (and can't fail/warn about) a CDN lookup.
pub async fn ensure_map_available(
    http: &reqwest::Client,
    content_base: &str,
    replay_target_dir: &Path,
    map_folder: &str,
) -> Result<(), String> {
    if !is_vault_map_folder(map_folder) {
        return Ok(()); // base/official map — ships with FA, not the vault
    }

    let search_dirs = default_map_search_dirs(replay_target_dir);
    if search_dirs.iter().any(|dir| dir.join(map_folder).is_dir()) {
        return Ok(()); // already somewhere FA's replay mode will find it
    }

    let url = format!("{content_base}/maps/{map_folder}.zip");
    let resp = http
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("could not download map {map_folder}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("could not download map {map_folder}: {}", resp.status()));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("could not read map {map_folder}: {e}"))?;

    for dir in &search_dirs {
        tokio::fs::create_dir_all(dir)
            .await
            .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
        extract_zip(&bytes, dir)?;
    }
    Ok(())
}

/// Extracts a zip archive (already known to contain a single top-level
/// `{map_folder}/...` directory, confirmed against a real vault download)
/// into `dest_dir`.
fn extract_zip(bytes: &[u8], dest_dir: &Path) -> Result<(), String> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|e| format!("invalid map archive: {e}"))?;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("could not read archive entry: {e}"))?;
        let Some(relative) = entry.enclosed_name() else {
            continue; // reject path-traversal entries
        };
        let out_path = dest_dir.join(relative);
        if entry.is_dir() {
            std::fs::create_dir_all(&out_path)
                .map_err(|e| format!("could not create {}: {e}", out_path.display()))?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
        }
        let mut out_file = std::fs::File::create(&out_path)
            .map_err(|e| format!("could not create {}: {e}", out_path.display()))?;
        std::io::copy(&mut entry, &mut out_file)
            .map_err(|e| format!("could not write {}: {e}", out_path.display()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Read as _;

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

    #[test]
    fn default_map_search_dirs_includes_replay_target_user_dir() {
        let target_dir = Path::new(r"C:\ProgramData\FAForever\replaydata");
        let dirs = default_map_search_dirs(target_dir);
        let expected_suffix =
            "user/My Games/Gas Powered Games/Supreme Commander Forged Alliance/maps"
                .replace('/', std::path::MAIN_SEPARATOR_STR);
        assert!(
            dirs.iter().any(|d| d.ends_with(&expected_suffix)),
            "{dirs:?} should include the replay-target user dir"
        );
    }

    #[test]
    fn patches_all_three_version_offsets_little_endian() {
        let dir = std::env::temp_dir().join(format!("forge-patch-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("fake.exe");
        // Large enough to cover the highest offset (0x47612d) plus 4 bytes.
        std::fs::write(&path, vec![0u8; 0x476670]).unwrap();

        patch_exe_version(&path, 3828).expect("should patch");

        let mut file = std::fs::File::open(&path).unwrap();
        for &addr in &VERSION_ADDRESSES {
            let mut buf = [0u8; 4];
            file.seek(SeekFrom::Start(addr)).unwrap();
            file.read_exact(&mut buf).unwrap();
            assert_eq!(i32::from_le_bytes(buf), 3828, "offset {addr:#x}");
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn writes_fa_path_lua_with_expected_fields() {
        let dir = std::env::temp_dir().join(format!("forge-lua-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        let retail = dir.join("retail-install");
        write_fa_path_lua(&dir, &retail, "ladder1v1", 3684).expect("should write");
        let content = std::fs::read_to_string(dir.join("fa_path.lua")).unwrap();

        assert!(content.contains("GameType = \"ladder1v1\""));
        assert!(content.contains("GameVersion = \"3684\""));
        assert!(content.contains("ForceAffinity = false"));
        assert!(!content.contains('\\'), "paths must use forward slashes");
        // fa_path must be the retail install root, never the FAF patch dir —
        // the game mounts movies/sounds/fonts from it (the bug this guards).
        assert!(
            content.contains(&format!("fa_path = \"{}\"", slashed(&retail))),
            "fa_path should be the retail install dir: {content}",
        );
        assert!(
            !content.contains(&format!("fa_path = \"{}/bin\"", slashed(&dir))),
            "fa_path must not point at the FAF patch dir's bin: {content}",
        );
        // Only meaningful on a host that can resolve a Documents dir (not
        // every CI runner can) — where it does, `write_fa_path_lua` must use
        // it rather than falling back to the never-populated
        // `target_dir/vault` (the bug this test guards).
        if let Some(vault_dir) = documents_vault_dir() {
            assert!(
                content.contains(&format!("custom_vault_path = \"{}\"", slashed(&vault_dir))),
                "custom_vault_path should be the user's real vault root ({}): {content}",
                slashed(&vault_dir),
            );
            assert!(
                !content.contains(&format!("custom_vault_path = \"{}", slashed(&dir.join("vault")))),
                "custom_vault_path must not point at an unpopulated target_dir/vault: {content}",
            );
        }

        let _ = std::fs::remove_dir_all(&dir);
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

    /// Builds an in-memory zip shaped like a real vault map download —
    /// confirmed against `content.faforever.com/maps/adaptive_gadostb.v0002.zip`:
    /// a single top-level `{map_folder}/` directory containing the map's files.
    fn build_map_zip(map_folder: &str) -> Vec<u8> {
        let mut buf = std::io::Cursor::new(Vec::new());
        let mut writer = zip::ZipWriter::new(&mut buf);
        let options: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default();
        writer
            .start_file(format!("{map_folder}/{map_folder}.scmap"), options)
            .unwrap();
        writer.write_all(b"fake map bytes").unwrap();
        writer.finish().unwrap();
        buf.into_inner()
    }

    #[test]
    fn extract_zip_places_files_under_the_map_folder() {
        let dir = std::env::temp_dir().join(format!("forge-mapzip-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        let zip_bytes = build_map_zip("adaptive_gadostb.v0002");
        extract_zip(&zip_bytes, &dir).expect("should extract");

        let scmap = dir
            .join("adaptive_gadostb.v0002")
            .join("adaptive_gadostb.v0002.scmap");
        assert_eq!(std::fs::read(&scmap).unwrap(), b"fake map bytes");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn ensure_map_available_skips_download_when_already_staged() {
        let target_dir = std::env::temp_dir().join(format!("forge-maptarget-{}", std::process::id()));
        let user_maps = target_dir
            .join("user")
            .join("My Games")
            .join("Gas Powered Games")
            .join("Supreme Commander Forged Alliance")
            .join("maps")
            .join("adaptive_gadostb.v0002");
        tokio::fs::create_dir_all(&user_maps).await.unwrap();

        let http = reqwest::Client::new();
        // An unreachable content_base proves no network call was attempted —
        // this would error out immediately if the "already staged" short
        // circuit didn't fire.
        ensure_map_available(&http, "http://127.0.0.1:1", &target_dir, "adaptive_gadostb.v0002")
            .await
            .expect("should skip the download entirely");

        let _ = tokio::fs::remove_dir_all(&target_dir).await;
    }

    #[test]
    fn recognizes_vault_map_folders_vs_base_game_maps() {
        assert!(is_vault_map_folder("adaptive_gadostb.v0002"));
        assert!(is_vault_map_folder("FAF_Coop_Operation_Rescue.v0008"));
        assert!(!is_vault_map_folder("scmp_009"));
        assert!(!is_vault_map_folder("X1MP_002"));
        assert!(!is_vault_map_folder("no_version_suffix"));
        assert!(!is_vault_map_folder("trailing_dot_v"));
    }

    #[tokio::test]
    async fn ensure_map_available_skips_the_network_entirely_for_base_maps() {
        let target_dir = std::env::temp_dir().join(format!("forge-basemap-{}", std::process::id()));
        let http = reqwest::Client::new();
        // An unreachable content_base proves no network call was attempted —
        // confirmed live (X1MP_002 → guaranteed 404, wrongly surfaced as a
        // "could not stage map" warning before this fix.
        ensure_map_available(&http, "http://127.0.0.1:1", &target_dir, "X1MP_002")
            .await
            .expect("base maps should be skipped, not looked up");
    }
}
