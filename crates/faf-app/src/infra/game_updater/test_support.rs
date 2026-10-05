//! Fixtures the game updater submodules' tests share: a content store filled
//! under real checksums, and cache entries naming what is in it.
//!
//! One place rather than a copy per submodule, because staging, updating and
//! patching are tested against the same store layout.

use std::path::Path;

use super::{CacheManifestEntry, CachedFileInfo};

/// Writes `bytes` into the content store under their own MD5, returning it.
pub(super) fn put_in_store(cache_dir: &Path, group: &str, bytes: &[u8]) -> String {
    let md5 = format!("{:x}", md5::compute(bytes));
    let dir = cache_dir.join(group);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(&md5), bytes).unwrap();
    md5
}

pub(super) fn build_entry(version: i32, files: &[(&str, &str, &str)]) -> CacheManifestEntry {
    CacheManifestEntry {
        featured_mod: "faf".to_string(),
        version: Some(version),
        resolved_version: version,
        name: format!("FAF Build {version}"),
        url: None,
        git_short_sha: None,
        signature: None,
        files: files
            .iter()
            .map(|(group, name, md5)| CachedFileInfo {
                group: (*group).to_string(),
                md5: (*md5).to_string(),
                name: Some((*name).to_string()),
            })
            .collect(),
        updated_at: 0,
        base_version: None,
    }
}
