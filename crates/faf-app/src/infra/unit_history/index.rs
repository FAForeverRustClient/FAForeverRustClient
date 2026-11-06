//! The bundled index contains paths, Git object IDs, and their release tags.

use std::collections::{BTreeMap, HashMap};
use std::io::Read;
use std::sync::OnceLock;

use faf_domain::protocol::unit_history::blueprint_paths;
use serde::Deserialize;

const DATA: &[u8] = include_bytes!("../../../assets/unit-history-index-v1.json.gz");

#[derive(Deserialize)]
struct Index {
    tags: Vec<u32>,
    paths: HashMap<String, Vec<(String, Vec<u32>)>>,
}

pub(super) enum IndexedRelease<'a> {
    Missing,
    Blob(&'a str),
}

pub(super) fn lookup(path: &str, releases: &[u32]) -> BTreeMap<u32, IndexedRelease<'static>> {
    static INDEX: OnceLock<Option<Index>> = OnceLock::new();
    let Some(index) = INDEX.get_or_init(|| {
        let mut reader = flate2::read::GzDecoder::new(DATA).take(8 * 1024 * 1024 + 1);
        let mut json = Vec::new();
        reader.read_to_end(&mut json).ok()?;
        if json.len() > 8 * 1024 * 1024 {
            return None;
        }
        serde_json::from_slice(&json).ok()
    }) else {
        return BTreeMap::new();
    };
    releases
        .iter()
        .filter_map(|&release| index.lookup(path, release).map(|entry| (release, entry)))
        .collect()
}

impl Index {
    fn lookup(&self, path: &str, release: u32) -> Option<IndexedRelease<'_>> {
        self.tags.binary_search(&release).ok()?;
        let paths = blueprint_paths(release, path);
        if paths.is_empty() || !paths.iter().all(|path| indexed_path(path)) {
            return None;
        }
        for path in paths {
            if let Some((id, _)) = self.paths.get(&path).and_then(|objects| {
                objects
                    .iter()
                    .find(|(_, tags)| tags.binary_search(&release).is_ok())
            }) {
                if id.len() == 40 && id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                    return Some(IndexedRelease::Blob(id));
                }
                return None;
            }
        }
        Some(IndexedRelease::Missing)
    }
}

fn indexed_path(path: &str) -> bool {
    let path = path.strip_prefix("schook/").unwrap_or(path);
    let Some((folder, file)) = path.strip_prefix("units/").and_then(|p| p.split_once('/')) else {
        return false;
    };
    let name = file
        .strip_suffix("_unit.bp")
        .or_else(|| file.strip_suffix("_unit.BP"));
    let identifier = |part: &str| {
        !part.is_empty()
            && part
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    };
    identifier(folder) && name.is_some_and(identifier)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unit_history_index_uses_the_paths_and_tags_in_the_game_repository() {
        let striker = "units/UEL0201/UEL0201_unit.bp";
        let indexed = lookup(striker, &[3603, 3840, 3999]);
        assert!(matches!(
            indexed.get(&3603),
            Some(IndexedRelease::Blob(
                "dc985fc19bdca518b5fd7d35e5bde4d47c775ac9"
            ))
        ));
        assert!(matches!(
            indexed.get(&3840),
            Some(IndexedRelease::Blob(
                "71f379b29724cb0a979b8cc56d3f11b0533169b0"
            ))
        ));
        assert!(!indexed.contains_key(&3999));
        assert!(matches!(
            lookup("units/ZZZ9999/ZZZ9999_unit.bp", &[3840]).get(&3840),
            Some(IndexedRelease::Missing)
        ));
        assert!(lookup("units/UEL0201/old name_unit.bp", &[3840]).is_empty());
    }
}
