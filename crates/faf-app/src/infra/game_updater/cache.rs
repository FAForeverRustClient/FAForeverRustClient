//! The game-file cache's manifest and its upkeep: which builds are cached,
//! the `versions` folder that mirrors them, and pruning, expiry, inspection
//! and clearing.
//!
//! Separate from the store itself (`content_store`), which knows files only by
//! checksum: this is the index that names them as builds, and the settings
//! page's view of it.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ports::InstalledBuild;

use super::content_store::{mirror_into, ContentStore};
use super::install::read_exe_version;
use super::safe_join_file;
use super::update::clear_file_list_cache;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub(super) struct CacheManifest {
    #[serde(default)]
    pub(super) entries: Vec<CacheManifestEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheManifestEntry {
    pub featured_mod: String,
    pub version: Option<i32>,
    pub resolved_version: i32,
    pub name: String,
    pub url: Option<String>,
    pub git_short_sha: Option<String>,
    pub signature: Option<String>,
    #[serde(default)]
    pub files: Vec<CachedFileInfo>,
    #[serde(default)]
    pub updated_at: u64,
    /// For an overlay (`nomads`, `coop`, ...): the `faf` build installed
    /// under it when it was cached. Staging puts exactly that base back; it
    /// used to take the newest cached `faf`, which for an older overlay is a
    /// base it was never released against. `None` for a base build, and for
    /// entries cached before this was recorded.
    #[serde(default)]
    pub base_version: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedFileInfo {
    pub group: String,
    pub md5: String,
    #[serde(default)]
    pub name: Option<String>,
}

/// Mirror one manifest entry into the `versions` folder the settings page
/// reveals, as links to the store.
///
/// A browsing view only: nothing launches from it, so its entries are not
/// hashed here (that would reread every cached build on each cache
/// inspection). Damage is caught where it matters, when a build is staged.
fn sync_version_folder(cache_dir: &Path, entry: &CacheManifestEntry) {
    let parent = match cache_dir.parent() {
        Some(p) => p,
        None => return,
    };
    let versions_dir = parent.join("versions");
    let folder_name = crate::infra::sanitize_folder_name(&entry.name);
    let version_dir = versions_dir.join(folder_name);
    let store = ContentStore::new(cache_dir);

    for f in &entry.files {
        let file_name = match &f.name {
            Some(n) => n.as_str(),
            None => continue,
        };
        let Ok(src) = store.entry_path(&f.group, &f.md5) else {
            continue;
        };
        if !src.is_file() {
            continue;
        }
        let Ok(dst) = safe_join_file(&version_dir, &f.group, file_name) else {
            continue;
        };
        let _ = mirror_into(&src, &dst);
    }
}

pub(super) fn load_cache_manifest(cache_dir: &Path) -> CacheManifest {
    let manifest_path = cache_dir.join("cache_manifest.json");
    if let Ok(content) = std::fs::read_to_string(manifest_path) {
        if let Ok(m) = serde_json::from_str::<CacheManifest>(&content) {
            return m;
        }
    }
    CacheManifest::default()
}

pub(super) fn save_cache_manifest_entry(cache_dir: &Path, entry: CacheManifestEntry) {
    if !cache_dir.is_dir() {
        let _ = std::fs::create_dir_all(cache_dir);
    }
    sync_version_folder(cache_dir, &entry);
    let mut manifest = load_cache_manifest(cache_dir);
    manifest.entries.retain(|e| {
        !(e.featured_mod == entry.featured_mod
            && e.resolved_version == entry.resolved_version
            && e.git_short_sha == entry.git_short_sha
            && e.name == entry.name)
    });
    manifest.entries.push(entry);
    let manifest_path = cache_dir.join("cache_manifest.json");
    if let Ok(json) = serde_json::to_string_pretty(&manifest) {
        let _ = std::fs::write(manifest_path, json);
    }
}

fn prune_cache_manifest(cache_dir: &Path) {
    let mut manifest = load_cache_manifest(cache_dir);
    if manifest.entries.is_empty() {
        return;
    }
    let parent = cache_dir.parent();
    let versions_dir = parent.map(|p| p.join("versions"));

    manifest.entries.retain_mut(|entry| {
        entry
            .files
            .retain(|f| cache_dir.join(&f.group).join(&f.md5).is_file());
        let keep = !entry.files.is_empty();
        if !keep {
            if let Some(v_dir) = &versions_dir {
                let folder_name = crate::infra::sanitize_folder_name(&entry.name);
                let _ = std::fs::remove_dir_all(v_dir.join(folder_name));
            }
        }
        keep
    });
    let manifest_path = cache_dir.join("cache_manifest.json");
    if let Ok(json) = serde_json::to_string_pretty(&manifest) {
        let _ = std::fs::write(manifest_path, json);
    }
}

/// Prune files in `cache_dir` older than `max_age_days`. If `max_age_days == 0`, no files are removed.
pub async fn clean_expired_cache_files(
    cache_dir: &Path,
    max_age_days: u32,
) -> Result<usize, String> {
    if max_age_days == 0 || !cache_dir.is_dir() {
        return Ok(0);
    }
    let max_age = std::time::Duration::from_secs(max_age_days as u64 * 86400);
    let now = std::time::SystemTime::now();
    let mut removed = 0;

    let mut stack = vec![cache_dir.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let mut entries = match tokio::fs::read_dir(&dir).await {
            Ok(e) => e,
            Err(_) => continue,
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            let metadata = match entry.metadata().await {
                Ok(m) => m,
                Err(_) => continue,
            };
            if metadata.is_dir() {
                stack.push(path);
            } else if metadata.is_file() {
                let mtime = metadata.modified().unwrap_or(now);
                if let Ok(age) = now.duration_since(mtime) {
                    if age > max_age && tokio::fs::remove_file(&path).await.is_ok() {
                        removed += 1;
                    }
                }
            }
        }
    }
    if removed > 0 {
        prune_cache_manifest(cache_dir);
    }
    Ok(removed)
}

/// Remove all files from the game files cache and clear in-memory caches.
pub async fn clear_game_cache(cache_dir: &Path) -> Result<(), String> {
    clear_file_list_cache();
    if let Some(parent) = cache_dir.parent() {
        let versions_dir = parent.join("versions");
        if versions_dir.is_dir() {
            let _ = tokio::fs::remove_dir_all(&versions_dir).await;
        }
    }
    if cache_dir.is_dir() {
        let mut entries = tokio::fs::read_dir(cache_dir)
            .await
            .map_err(|e| format!("could not read cache directory: {e}"))?;
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            if let Ok(file_type) = entry.file_type().await {
                if file_type.is_dir() {
                    let _ = tokio::fs::remove_dir_all(&path).await;
                } else {
                    let _ = tokio::fs::remove_file(&path).await;
                }
            }
        }
    }
    Ok(())
}

fn read_game_type_from_fa_path(dir: &Path) -> Option<String> {
    let content = std::fs::read_to_string(dir.join("fa_path.lua")).ok()?;
    for line in content.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("GameType = \"") {
            if let Some(game_type) = rest.strip_suffix('"') {
                return Some(game_type.to_string());
            }
        }
    }
    None
}

struct BuildInfo {
    git_short_sha: Option<String>,
    signature: Option<String>,
    commit_url: Option<String>,
}

fn read_build_info(dir: &Path) -> Option<BuildInfo> {
    let content = std::fs::read_to_string(dir.join(".faf_build.json")).ok()?;
    let val: serde_json::Value = serde_json::from_str(&content).ok()?;
    let git_short_sha = val
        .get("gitShortSha")
        .and_then(|s| s.as_str())
        .map(|s| s.to_string());
    let signature = val
        .get("signature")
        .and_then(|s| s.as_str())
        .map(|s| s.to_string());
    let commit_url = val
        .get("commitUrl")
        .and_then(|s| s.as_str())
        .map(|s| s.to_string());
    Some(BuildInfo {
        git_short_sha,
        signature,
        commit_url,
    })
}

/// Read the build stamp the preparation run left in `dir`, for a recording's
/// header.
///
/// A missing or unreadable stamp is not an error: it only means the install
/// was never prepared by this client, and the recording goes without.
pub fn read_installed_build(dir: &Path) -> Option<InstalledBuild> {
    let content = std::fs::read_to_string(dir.join(".faf_build.json")).ok()?;
    let val: Value = serde_json::from_str(&content).ok()?;
    let text = |key: &str| val.get(key).and_then(|s| s.as_str()).map(String::from);
    Some(InstalledBuild {
        git_sha: text("gitSha"),
        git_short_sha: text("gitShortSha"),
        signature: text("signature"),
    })
}

fn dir_files_stats(dir: &Path) -> (usize, u64) {
    let mut files = 0;
    let mut size = 0;
    for sub in &["gamedata", "bin"] {
        let sub_dir = dir.join(sub);
        if let Ok(entries) = std::fs::read_dir(sub_dir) {
            for entry in entries.flatten() {
                if let Ok(m) = entry.metadata() {
                    if m.is_file() {
                        files += 1;
                        size += m.len();
                    }
                }
            }
        }
    }
    (files, size)
}

/// Calculate cache size, count, and discovered game versions.
pub async fn inspect_game_cache(
    cache_dir: &Path,
    install_dirs: &[PathBuf],
) -> faf_domain::state::GameCacheInfo {
    let mut total_size_bytes = 0u64;
    let mut total_files = 0usize;
    let mut existing_cache_files: std::collections::HashMap<(String, String), u64> =
        std::collections::HashMap::new();
    let mut legacy_exe_versions: std::collections::BTreeMap<i32, (usize, u64)> =
        std::collections::BTreeMap::new();

    if cache_dir.is_dir() {
        let mut stack = vec![cache_dir.to_path_buf()];
        while let Some(dir) = stack.pop() {
            let mut entries = match tokio::fs::read_dir(&dir).await {
                Ok(e) => e,
                Err(_) => continue,
            };
            while let Ok(Some(entry)) = entries.next_entry().await {
                let path = entry.path();
                let metadata = match entry.metadata().await {
                    Ok(m) => m,
                    Err(_) => continue,
                };
                if metadata.is_dir() {
                    stack.push(path);
                } else if metadata.is_file() {
                    if path.file_name().and_then(|n| n.to_str()) == Some("cache_manifest.json") {
                        continue;
                    }
                    let len = metadata.len();
                    total_size_bytes += len;
                    total_files += 1;

                    if let (Some(md5), Some(group_dir)) =
                        (path.file_name().and_then(|n| n.to_str()), path.parent())
                    {
                        if let Some(group) = group_dir.file_name().and_then(|n| n.to_str()) {
                            existing_cache_files.insert((group.to_string(), md5.to_string()), len);
                        }
                    }

                    if let Some(v) = read_exe_version(&path) {
                        if v >= 3636 {
                            let entry = legacy_exe_versions.entry(v).or_insert((0, 0));
                            entry.0 += 1;
                            entry.1 += len;
                        }
                    }
                }
            }
        }
    }

    let manifest = load_cache_manifest(cache_dir);
    let mut versions: Vec<faf_domain::state::CachedGameVersion> = Vec::new();
    let mut recorded_names: std::collections::HashSet<String> = std::collections::HashSet::new();

    for entry in manifest.entries {
        let mut count = 0usize;
        let mut size = 0u64;
        for f in &entry.files {
            if let Some(&file_len) = existing_cache_files.get(&(f.group.clone(), f.md5.clone())) {
                count += 1;
                size += file_len;
            }
        }
        if count > 0 {
            sync_version_folder(cache_dir, &entry);
            recorded_names.insert(entry.name.clone());
            versions.push(faf_domain::state::CachedGameVersion {
                name: entry.name,
                version: entry.resolved_version,
                file_count: count.min(u32::MAX as usize) as u32,
                size_bytes: size as f64,
                url: entry.url,
            });
        }
    }

    // Auto-discover and populate versions from active install_dirs
    for dir in install_dirs {
        let game_type = read_game_type_from_fa_path(dir);
        let build_info = read_build_info(dir);
        let (f_count, f_size) = dir_files_stats(dir);

        if let Some(gt) = game_type {
            let is_develop = gt == "fafdevelop";
            let is_beta = gt == "fafbeta";
            if is_develop || is_beta {
                let (name, url) = match &build_info {
                    Some(info) if info.git_short_sha.is_some() => (
                        format!(
                            "FAF {} ({})",
                            if is_develop { "Develop" } else { "Beta" },
                            info.git_short_sha.as_ref().unwrap()
                        ),
                        info.commit_url.clone().unwrap_or_else(|| {
                            format!(
                                "https://github.com/FAForever/fa/commits/{}",
                                if is_develop {
                                    "develop"
                                } else {
                                    "deploy/fafbeta"
                                }
                            )
                        }),
                    ),
                    Some(info) if info.signature.is_some() => (
                        format!(
                            "FAF {} ({})",
                            if is_develop { "Develop" } else { "Beta" },
                            info.signature.as_ref().unwrap()
                        ),
                        info.commit_url.clone().unwrap_or_else(|| {
                            format!(
                                "https://github.com/FAForever/fa/commits/{}",
                                if is_develop {
                                    "develop"
                                } else {
                                    "deploy/fafbeta"
                                }
                            )
                        }),
                    ),
                    _ => (
                        format!("FAF {}", if is_develop { "Develop" } else { "Beta" }),
                        format!(
                            "https://github.com/FAForever/fa/commits/{}",
                            if is_develop {
                                "develop"
                            } else {
                                "deploy/fafbeta"
                            }
                        ),
                    ),
                };
                if !recorded_names.contains(&name) {
                    recorded_names.insert(name.clone());
                    versions.push(faf_domain::state::CachedGameVersion {
                        name,
                        version: 0,
                        file_count: f_count.min(u32::MAX as usize) as u32,
                        size_bytes: f_size as f64,
                        url: Some(url),
                    });
                }
            } else if gt == "faf" || gt == "ladder1v1" {
                let exe_path = dir.join("bin").join("ForgedAlliance.exe");
                if let Some(v) = read_exe_version(&exe_path) {
                    if v >= 3636 {
                        let name = format!("FAF Build {v}");
                        if !recorded_names.contains(&name) {
                            recorded_names.insert(name.clone());
                            versions.push(faf_domain::state::CachedGameVersion {
                                name,
                                version: v,
                                file_count: f_count.min(u32::MAX as usize) as u32,
                                size_bytes: f_size as f64,
                                url: Some(format!(
                                    "https://github.com/FAForever/fa/releases/tag/{v}"
                                )),
                            });
                        }
                    }
                }
            }
        }
    }

    // Fallback: add standalone legacy PE binaries discovered in cache_dir
    for (version, (file_count, size_bytes)) in legacy_exe_versions {
        let name = format!("FAF Build {version}");
        if !recorded_names.contains(&name) {
            recorded_names.insert(name.clone());
            versions.push(faf_domain::state::CachedGameVersion {
                name,
                version,
                file_count: file_count.min(u32::MAX as usize) as u32,
                size_bytes: size_bytes as f64,
                url: Some(format!(
                    "https://github.com/FAForever/fa/releases/tag/{version}"
                )),
            });
        }
    }

    versions.sort_by(|a, b| b.version.cmp(&a.version).then_with(|| a.name.cmp(&b.name)));

    faf_domain::state::GameCacheInfo {
        total_size_bytes: total_size_bytes as f64,
        total_files: total_files.min(u32::MAX as usize) as u32,
        versions,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_installed_build_stamp_is_read_back_and_its_absence_is_not_an_error() {
        let temp = tempfile::tempdir().unwrap();
        assert_eq!(read_installed_build(temp.path()), None);

        // The shape `ensure_latest_game_version` writes: a stable install
        // has nulls for the git fields, which must read back as absent.
        std::fs::write(
            temp.path().join(".faf_build.json"),
            json!({
                "featuredMod": "fafdevelop",
                "signature": "1a2b3c4",
                "gitSha": "abcdef1987654321",
                "gitShortSha": "abcdef1",
                "commitUrl": null,
            })
            .to_string(),
        )
        .unwrap();
        assert_eq!(
            read_installed_build(temp.path()),
            Some(InstalledBuild {
                git_sha: Some("abcdef1987654321".into()),
                git_short_sha: Some("abcdef1".into()),
                signature: Some("1a2b3c4".into()),
            })
        );

        std::fs::write(
            temp.path().join(".faf_build.json"),
            json!({ "signature": "1a2b3c4", "gitSha": null }).to_string(),
        )
        .unwrap();
        assert_eq!(
            read_installed_build(temp.path()),
            Some(InstalledBuild {
                signature: Some("1a2b3c4".into()),
                ..InstalledBuild::default()
            })
        );

        std::fs::write(temp.path().join(".faf_build.json"), "not json").unwrap();
        assert_eq!(read_installed_build(temp.path()), None);
    }

    #[tokio::test]
    async fn cache_cleanup_and_inspection_works() {
        let temp_dir = std::env::temp_dir().join(format!("faf-test-cache-{}", std::process::id()));
        let _ = tokio::fs::remove_dir_all(&temp_dir).await;
        tokio::fs::create_dir_all(temp_dir.join("bin"))
            .await
            .unwrap();
        tokio::fs::write(temp_dir.join("bin").join("test.bin"), b"test data")
            .await
            .unwrap();

        let info = inspect_game_cache(&temp_dir, &[]).await;
        assert_eq!(info.total_files, 1);
        assert_eq!(info.total_size_bytes, 9.0);

        let removed = clean_expired_cache_files(&temp_dir, 0).await.unwrap();
        assert_eq!(removed, 0);

        clear_game_cache(&temp_dir).await.unwrap();
        let info_after = inspect_game_cache(&temp_dir, &[]).await;
        assert_eq!(info_after.total_files, 0);
        assert_eq!(info_after.total_size_bytes, 0.0);

        let _ = tokio::fs::remove_dir_all(&temp_dir).await;
    }

    #[tokio::test]
    async fn cache_manifest_indexing_and_multi_version_inspection_works() {
        // Nested under a directory of its own, because `sync_version_folder`
        // writes to `cache_dir.parent()/versions/<entry name>`: with the cache
        // directly in the temp directory, every test in this file shared one
        // `versions` folder. This test and the staging one below both index an
        // entry called "FAF Develop (abcdef1)" holding a `lua.nx2`, so they
        // wrote the same file with different contents, in parallel, and
        // whichever finished second decided what the other one read back.
        let root =
            std::env::temp_dir().join(format!("faf-test-cache-manifest-{}", std::process::id()));
        let temp_dir = root.join("cache");
        let _ = tokio::fs::remove_dir_all(&root).await;
        tokio::fs::create_dir_all(temp_dir.join("bin"))
            .await
            .unwrap();
        tokio::fs::create_dir_all(temp_dir.join("gamedata"))
            .await
            .unwrap();

        // Write files for build 3837 (exe + gamedata)
        tokio::fs::write(temp_dir.join("bin").join("md5_exe_3837"), b"12345678")
            .await
            .unwrap();
        tokio::fs::write(
            temp_dir.join("gamedata").join("md5_lua_3837"),
            b"1234567890",
        )
        .await
        .unwrap();

        // Write files for fafdevelop
        tokio::fs::write(
            temp_dir.join("gamedata").join("md5_dev_lua"),
            b"develop_lua_content",
        )
        .await
        .unwrap();

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
                    md5: "md5_exe_3837".to_string(),
                    name: Some("ForgedAlliance.exe".to_string()),
                },
                CachedFileInfo {
                    group: "gamedata".to_string(),
                    md5: "md5_lua_3837".to_string(),
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
                md5: "md5_dev_lua".to_string(),
                name: Some("lua.nx2".to_string()),
            }],
            updated_at: 101,
            base_version: None,
        };
        save_cache_manifest_entry(&temp_dir, entry_dev);

        let info = inspect_game_cache(&temp_dir, &[]).await;
        assert_eq!(info.total_files, 3);
        assert_eq!(info.total_size_bytes, 37.0); // 37 bytes total
        assert_eq!(info.versions.len(), 2);

        let v_3837 = info
            .versions
            .iter()
            .find(|v| v.name == "FAF Build 3837")
            .unwrap();
        assert_eq!(v_3837.version, 3837);
        assert_eq!(v_3837.file_count, 2);
        assert_eq!(v_3837.size_bytes, 18.0);
        assert_eq!(
            v_3837.url.as_deref(),
            Some("https://github.com/FAForever/fa/releases/tag/3837")
        );

        let v_dev = info
            .versions
            .iter()
            .find(|v| v.name == "FAF Develop (abcdef1)")
            .unwrap();
        assert_eq!(v_dev.version, 0);
        assert_eq!(v_dev.file_count, 1);
        assert_eq!(v_dev.size_bytes, 19.0);
        assert_eq!(
            v_dev.url.as_deref(),
            Some("https://github.com/FAForever/fa/commits/abcdef1")
        );

        let _ = tokio::fs::remove_dir_all(&root).await;
    }
}
