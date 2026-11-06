//! Unit history: blueprints from FAForever/fa's release tags and from the
//! game files on this machine.
//!
//! Three reads, none of them through GitHub's rate-limited API:
//!
//! - **The tag list** comes from the repository's Git endpoint, as one
//!   protocol v2 `ls-refs` request limited to `refs/tags/` (about 12 KB). The
//!   classic ref advertisement would list every pull request too (400 KB).
//! - **A release's blueprint** is a plain file from `raw.githubusercontent.com`,
//!   the CDN the changelog reads its notes from. A tag never changes, so every
//!   answer is kept on disk for good, a missing file included. Blueprints are
//!   stored once by content: most releases repeat the previous one's file, so
//!   a unit's 170 releases come down to a handful of files.
//! - **The unit list, the base game's units and the projectiles** are read
//!   from the installed archives: FAF's `gamedata/units.nx2` and
//!   `projectiles.nx2`, and the original game's `units.scd` and
//!   `projectiles.scd`. All are zip files.
//!
//! The rules that turn these into a history are in
//! [`faf_domain::protocol::unit_history`].

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use async_trait::async_trait;
use faf_domain::protocol::blueprint::parse_blueprint;
use faf_domain::protocol::unit_history::{
    blueprint_paths, summarize, BaseGameBlueprint, ReleaseBlueprint, UnitSummary,
};
use sha2::{Digest, Sha256};

use super::metadata_file::read_bounded_to_string;
use super::release_metadata::{write_atomic, ReadMode, ReleaseMetadata};
use crate::ports::UnitHistoryPort;

mod git_pack;
mod index;

/// The largest blueprint in the repository is about 60 KB (a commander).
const MAX_BLUEPRINT_BYTES: u64 = 1024 * 1024;
/// The tag list is about 12 KB.
const MAX_TAG_LIST_BYTES: u64 = 1024 * 1024;
const MISSING: &str = "missing";

#[derive(Debug, Clone)]
pub struct UnitHistoryConfig {
    /// Raw files of the repository, `<raw_base>/<tag>/<path>`.
    pub raw_base: String,
    /// The repository's Git endpoint for `ls-refs`.
    pub git_upload_pack: String,
    /// Where tags and blueprints are kept. Disposable, like the rest of the
    /// cache, but never expired: a release's files do not change.
    pub cache_dir: Option<PathBuf>,
}

impl UnitHistoryConfig {
    pub fn faf() -> Self {
        Self {
            raw_base: "https://raw.githubusercontent.com/FAForever/fa".into(),
            git_upload_pack: "https://github.com/FAForever/fa.git/git-upload-pack".into(),
            cache_dir: super::cache_dir()
                .ok()
                .map(|root| root.join("unit-history")),
        }
    }
}

pub struct UnitHistoryClient {
    config: UnitHistoryConfig,
    http: reqwest::Client,
    tags: ReleaseMetadata<BTreeSet<String>>,
    units: Arc<Mutex<Option<ArchiveValue<Vec<UnitSummary>>>>>,
    projectiles: Arc<Mutex<Option<ArchiveValue<BTreeSet<String>>>>>,
}

type ArchiveStamp = Vec<(PathBuf, Option<(SystemTime, u64)>)>;

struct ArchiveValue<T> {
    stamp: ArchiveStamp,
    value: T,
}

fn archive_stamp(paths: &[PathBuf]) -> Option<ArchiveStamp> {
    paths
        .iter()
        .map(|path| match std::fs::metadata(path) {
            Ok(metadata) if metadata.is_file() => Some((
                path.clone(),
                Some((metadata.modified().ok()?, metadata.len())),
            )),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Some((path.clone(), None))
            }
            _ => None,
        })
        .collect()
}

impl UnitHistoryClient {
    pub fn new(config: UnitHistoryConfig) -> Self {
        Self {
            tags: ReleaseMetadata::new(
                config.cache_dir.as_ref().map(|dir| dir.join("tags.txt")),
                MAX_TAG_LIST_BYTES,
                parse_cached_tags,
            ),
            config,
            http: super::http::shared_http_client(),
            units: Arc::default(),
            projectiles: Arc::default(),
        }
    }

    pub fn faf() -> Self {
        Self::new(UnitHistoryConfig::faf())
    }

    async fn fetch_tags(
        http: reqwest::Client,
        url: String,
    ) -> Result<(BTreeSet<String>, String), String> {
        // `command=ls-refs`, a delimiter, `ref-prefix refs/tags/`, a flush:
        // each line framed by its own length in four hex digits.
        let mut body = pkt_line("command=ls-refs\n");
        body.extend(b"0001");
        body.extend(pkt_line("ref-prefix refs/tags/\n"));
        body.extend(b"0000");
        let response = http
            .post(url)
            .header("Content-Type", "application/x-git-upload-pack-request")
            .header("Git-Protocol", "version=2")
            .body(body)
            .timeout(super::http::REQUEST_DEADLINE)
            .send()
            .await
            .map_err(|e| format!("could not reach the game repository: {e}"))?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!("the game repository responded with {status}"));
        }
        let bytes = super::vault_install::bounded_body(
            response,
            "the game repository's tag list",
            MAX_TAG_LIST_BYTES,
        )
        .await?;
        let tags = parse_ls_refs(&bytes)?;
        if tags.is_empty() {
            return Err("the game repository listed no release tags".into());
        }
        let source = tags.iter().cloned().collect::<Vec<_>>().join("\n");
        Ok((tags, source))
    }

    async fn fetch_indexed_blobs(
        &self,
        wanted: BTreeSet<String>,
    ) -> Option<HashMap<String, String>> {
        let mut body = pkt_line("command=fetch\n");
        body.extend(b"0001");
        body.extend(pkt_line("no-progress\n"));
        body.extend(pkt_line("ofs-delta\n"));
        for id in &wanted {
            body.extend(pkt_line(&format!("want {id}\n")));
        }
        body.extend(pkt_line("done\n"));
        body.extend(b"0000");
        let response = self
            .http
            .post(&self.config.git_upload_pack)
            .header("Content-Type", "application/x-git-upload-pack-request")
            .header("Git-Protocol", "version=2")
            .body(body)
            .timeout(std::time::Duration::from_secs(8))
            .send()
            .await
            .ok()?
            .error_for_status()
            .ok()?;
        let bytes = super::vault_install::bounded_body(
            response,
            "the indexed unit blueprints",
            git_pack::MAX_PACK_BYTES,
        )
        .await
        .ok()?;
        tokio::task::spawn_blocking(move || git_pack::unpack(&bytes, &wanted))
            .await
            .ok()?
    }

    async fn fetch_file(&self, tag: &str, path: &str) -> Result<Option<String>, String> {
        let url = format!("{}/{tag}/{path}", self.config.raw_base);
        let response = self
            .http
            .get(&url)
            .timeout(super::http::REQUEST_DEADLINE)
            .send()
            .await
            .map_err(|e| format!("could not reach the game repository: {e}"))?;
        let status = response.status();
        if status == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !status.is_success() {
            return Err(format!("the game repository responded with {status}"));
        }
        let bytes =
            super::vault_install::bounded_body(response, "a unit blueprint", MAX_BLUEPRINT_BYTES)
                .await?;
        // The game reads blueprints as bytes; a stray Latin-1 byte in a
        // comment must not cost the whole release.
        Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
    }
}

fn pkt_line(text: &str) -> Vec<u8> {
    let mut line = format!("{:04x}", text.len() + 4).into_bytes();
    line.extend(text.as_bytes());
    line
}

/// The tag names in an `ls-refs` answer: pkt-lines of `<oid> refs/tags/<name>`,
/// each optionally followed by attributes, ended by a flush packet.
fn parse_ls_refs(bytes: &[u8]) -> Result<BTreeSet<String>, String> {
    let mut tags = BTreeSet::new();
    let mut rest = bytes;
    while rest.len() >= 4 {
        let length = std::str::from_utf8(&rest[..4])
            .ok()
            .and_then(|hex| usize::from_str_radix(hex, 16).ok())
            .ok_or("the game repository's tag list was malformed")?;
        if length < 4 {
            // 0000 ends the list; 0001 and 0002 are separators.
            rest = &rest[4..];
            if length == 0 {
                break;
            }
            continue;
        }
        if length > rest.len() {
            return Err("the game repository's tag list was cut short".into());
        }
        let line = String::from_utf8_lossy(&rest[4..length]);
        if let Some(name) = line
            .trim_end()
            .split(' ')
            .nth(1)
            .and_then(|reference| reference.strip_prefix("refs/tags/"))
        {
            tags.insert(name.to_owned());
        }
        rest = &rest[length..];
    }
    Ok(tags)
}

/// Whether a tag is safe to use as a folder name and in a URL. The release
/// tags are numbers, some with a dot.
fn is_plain_tag(tag: &str) -> bool {
    !tag.is_empty()
        && tag.len() <= 32
        && tag
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'.' || c == b'-' || c == b'_')
        && !tag.starts_with('.')
}

/// The cache entry's name for a blueprint: the unit id its file names.
fn unit_key(paths: &[String]) -> Option<String> {
    let file = paths.first()?.rsplit('/').next()?;
    let id = file
        .strip_suffix("_unit.bp")
        .or_else(|| file.strip_suffix("_unit.BP"))?;
    let id = id.to_ascii_uppercase();
    (!id.is_empty() && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')).then_some(id)
}

struct DiskCache {
    root: PathBuf,
}

impl DiskCache {
    fn reference(&self, tag: &str, unit: &str) -> PathBuf {
        self.root
            .join("releases")
            .join(tag)
            .join(format!("{unit}.ref"))
    }

    fn blob(&self, digest: &str) -> PathBuf {
        self.root.join("blobs").join(format!("{digest}.bp"))
    }

    fn indexed_reference(&self, id: &str) -> PathBuf {
        self.root.join("git-blobs").join(format!("{id}.ref"))
    }

    fn read(&self, tag: &str, unit: &str) -> Option<ReleaseBlueprint> {
        self.read_reference(&self.reference(tag, unit))
    }

    fn read_reference(&self, path: &Path) -> Option<ReleaseBlueprint> {
        let reference = read_bounded_to_string(path, 128).ok()?;
        let reference = reference.trim();
        if reference == MISSING {
            return Some(ReleaseBlueprint::Missing);
        }
        if reference.len() != 64 || !reference.bytes().all(|c| c.is_ascii_hexdigit()) {
            return None;
        }
        self.read_blob(reference).map(ReleaseBlueprint::Found)
    }

    fn read_blob(&self, digest: &str) -> Option<String> {
        let text = read_bounded_to_string(&self.blob(digest), MAX_BLUEPRINT_BYTES).ok()?;
        // A blob that does not hash to its name was damaged on disk.
        (format!("{:x}", Sha256::digest(text.as_bytes())) == digest).then_some(text)
    }

    fn store(&self, tag: &str, unit: &str, blueprint: &ReleaseBlueprint) -> std::io::Result<()> {
        self.store_reference(&self.reference(tag, unit), blueprint)
    }

    fn store_reference(&self, path: &Path, blueprint: &ReleaseBlueprint) -> std::io::Result<()> {
        let reference = match blueprint {
            ReleaseBlueprint::Found(text) => {
                let digest = format!("{:x}", Sha256::digest(text.as_bytes()));
                let blob = self.blob(&digest);
                if !read_bounded_to_string(&blob, MAX_BLUEPRINT_BYTES)
                    .is_ok_and(|stored| stored == *text)
                {
                    write_atomic(&blob, text.as_bytes())?;
                }
                digest
            }
            ReleaseBlueprint::Missing => MISSING.to_owned(),
            ReleaseBlueprint::Failed(_) => return Ok(()),
        };
        write_atomic(path, reference.as_bytes())
    }
}

fn plan_indexed(
    path: &str,
    releases: &[u32],
    cache: Option<&DiskCache>,
) -> (BTreeMap<u32, ReleaseBlueprint>, BTreeMap<String, Vec<u32>>) {
    let mut resolved = BTreeMap::new();
    let mut by_blob: BTreeMap<&str, Vec<u32>> = BTreeMap::new();
    for (release, source) in index::lookup(path, releases) {
        match source {
            index::IndexedRelease::Missing => {
                resolved.insert(release, ReleaseBlueprint::Missing);
            }
            index::IndexedRelease::Blob(id) => by_blob.entry(id).or_default().push(release),
        }
    }
    let mut pending = BTreeMap::new();
    for (id, releases) in by_blob {
        let cached = cache.and_then(|disk| {
            disk.read_reference(&disk.indexed_reference(id))
                .filter(|source| {
                    matches!(source, ReleaseBlueprint::Found(text)
                    if git_pack::blob_id(text.as_bytes()) == id)
                })
                .or_else(|| {
                    // Reuse the cache written by older clients. Its contents
                    // must match this Git object before sharing across tags.
                    releases.iter().find_map(|release| {
                        let paths = blueprint_paths(*release, path);
                        let unit = unit_key(&paths)?;
                        let source = disk.read(&release.to_string(), &unit)?;
                        matches!(&source, ReleaseBlueprint::Found(text)
                            if git_pack::blob_id(text.as_bytes()) == id)
                        .then_some(source)
                    })
                })
        });
        if let Some(cached) = cached {
            resolved.extend(
                releases
                    .into_iter()
                    .map(|release| (release, cached.clone())),
            );
        } else {
            pending.insert(id.to_owned(), releases);
        }
    }
    (resolved, pending)
}

fn parse_cached_tags(text: &str) -> Result<BTreeSet<String>, String> {
    let tags: BTreeSet<_> = text
        .lines()
        .filter(|tag| is_plain_tag(tag))
        .map(str::to_owned)
        .collect();
    if tags.is_empty() {
        return Err("the saved tag list is empty".into());
    }
    Ok(tags)
}

/// Every `*_unit.bp` (or `*_proj.bp`) entry of a game archive, with its path
/// and text. Entries larger than a blueprint can be are skipped.
fn archive_blueprints(archive: &Path, suffix: &str) -> Result<Vec<(String, String)>, String> {
    let file = std::fs::File::open(archive)
        .map_err(|e| format!("could not open {}: {e}", archive.display()))?;
    let mut zip = zip::ZipArchive::new(std::io::BufReader::new(file))
        .map_err(|e| format!("could not read {}: {e}", archive.display()))?;
    let mut blueprints = Vec::new();
    for index in 0..zip.len() {
        let Ok(mut entry) = zip.by_index(index) else {
            continue;
        };
        let Ok(name) = entry.name() else {
            continue;
        };
        let name = name.replace('\\', "/");
        if !name.to_ascii_lowercase().ends_with(suffix) || entry.size() > MAX_BLUEPRINT_BYTES {
            continue;
        }
        let mut bytes = Vec::new();
        if entry.read_to_end(&mut bytes).is_ok() {
            blueprints.push((name, String::from_utf8_lossy(&bytes).into_owned()));
        }
    }
    Ok(blueprints)
}

/// One blueprint of a game archive by its path, compared without case.
fn archive_entry(archive: &Path, wanted: &str) -> Result<Option<String>, String> {
    let file = std::fs::File::open(archive)
        .map_err(|e| format!("could not open {}: {e}", archive.display()))?;
    let mut zip = zip::ZipArchive::new(std::io::BufReader::new(file))
        .map_err(|e| format!("could not read {}: {e}", archive.display()))?;
    let wanted = wanted.to_ascii_lowercase();
    let Some(index) = (0..zip.len()).find(|index| {
        zip.name_for_index(*index)
            .and_then(|name| name.ok())
            .is_some_and(|name| name.replace('\\', "/").to_ascii_lowercase() == wanted)
    }) else {
        return Ok(None);
    };
    let mut entry = zip
        .by_index(index)
        .map_err(|e| format!("could not read {}: {e}", archive.display()))?;
    if entry.size() > MAX_BLUEPRINT_BYTES {
        return Err(format!("{wanted} in {} is too large", archive.display()));
    }
    let mut bytes = Vec::new();
    entry
        .read_to_end(&mut bytes)
        .map_err(|e| format!("could not read {}: {e}", archive.display()))?;
    Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
}

/// Whether a projectile blueprint's shell splits into fragments.
fn fragments(source: &str) -> bool {
    // Nearly every projectile has no such field; skip parsing those.
    source.contains("Fragments")
        && parse_blueprint(source)
            .ok()
            .and_then(|blueprint| blueprint.number(&["Physics", "Fragments"]))
            .is_some_and(|count| count > 0.0)
}

#[async_trait]
impl UnitHistoryPort for UnitHistoryClient {
    async fn list_units(&self, install_dir: Option<PathBuf>) -> Result<Vec<UnitSummary>, String> {
        let archive = install_dir
            .map(|dir| dir.join("gamedata").join("units.nx2"))
            .filter(|archive| archive.is_file())
            .ok_or("the game files are not installed yet")?;
        let cached = self.units.clone();
        tokio::task::spawn_blocking(move || {
            let paths = [archive.clone()];
            let stamp = archive_stamp(&paths);
            // The lock covers the first parse, coalescing simultaneous readers.
            let mut cached = cached
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(value) = cached
                .as_ref()
                .filter(|value| Some(&value.stamp) == stamp.as_ref())
            {
                return Ok(value.value.clone());
            }
            let mut units: Vec<UnitSummary> = archive_blueprints(&archive, "_unit.bp")?
                .into_iter()
                .filter_map(|(path, source)| {
                    let blueprint = parse_blueprint(&source).ok()?;
                    summarize(&path, &blueprint)
                })
                .collect();
            units.sort_by(|left, right| left.id.cmp(&right.id));
            units.dedup_by(|left, right| left.id == right.id);
            if let Some(stamp) = stamp.filter(|stamp| Some(stamp) == archive_stamp(&paths).as_ref())
            {
                *cached = Some(ArchiveValue {
                    stamp,
                    value: units.clone(),
                });
            }
            Ok(units)
        })
        .await
        .map_err(|_| "the unit list could not be read".to_owned())?
    }

    async fn release_tags(&self) -> Result<BTreeSet<String>, String> {
        self.tags
            .get(
                ReadMode::PreferCached,
                Self::fetch_tags(self.http.clone(), self.config.git_upload_pack.clone()),
            )
            .await
    }

    async fn indexed_blueprints(
        &self,
        installed_path: &str,
        releases: &[u32],
    ) -> BTreeMap<u32, ReleaseBlueprint> {
        let path = installed_path.to_owned();
        let releases = releases.to_vec();
        let cache = self.config.cache_dir.clone().map(|root| DiskCache { root });
        let Ok((mut resolved, pending, cache)) = tokio::task::spawn_blocking(move || {
            let (resolved, pending) = plan_indexed(&path, &releases, cache.as_ref());
            (resolved, pending, cache)
        })
        .await
        else {
            return BTreeMap::new();
        };
        if pending.is_empty() {
            return resolved;
        }
        let Some(mut blobs) = self
            .fetch_indexed_blobs(pending.keys().cloned().collect())
            .await
        else {
            return resolved;
        };
        tokio::task::spawn_blocking(move || {
            for (id, releases) in pending {
                let Some(text) = blobs.remove(&id) else {
                    continue;
                };
                let reusable = git_pack::blob_id(text.as_bytes()) == id;
                let blueprint = ReleaseBlueprint::Found(text);
                if let Some(cache) = cache.as_ref().filter(|_| reusable) {
                    let _ = cache.store_reference(&cache.indexed_reference(&id), &blueprint);
                }
                resolved.extend(
                    releases
                        .into_iter()
                        .map(|release| (release, blueprint.clone())),
                );
            }
            resolved
        })
        .await
        .unwrap_or_default()
    }

    async fn release_blueprint(&self, tag: &str, paths: &[String]) -> ReleaseBlueprint {
        let (true, Some(unit)) = (is_plain_tag(tag), unit_key(paths)) else {
            return ReleaseBlueprint::Failed(format!("no blueprint path for release {tag}"));
        };
        let cache = self.config.cache_dir.clone().map(|root| DiskCache { root });
        if let Some(cache) = &cache {
            let (cache_root, tag_owned, unit_owned) =
                (cache.root.clone(), tag.to_owned(), unit.clone());
            let cached = tokio::task::spawn_blocking(move || {
                DiskCache { root: cache_root }.read(&tag_owned, &unit_owned)
            })
            .await
            .ok()
            .flatten();
            if let Some(cached) = cached {
                return cached;
            }
        }
        let mut found = ReleaseBlueprint::Missing;
        for path in paths {
            match self.fetch_file(tag, path).await {
                Ok(Some(text)) => {
                    found = ReleaseBlueprint::Found(text);
                    break;
                }
                Ok(None) => {}
                Err(reason) => return ReleaseBlueprint::Failed(reason),
            }
        }
        if let Some(cache) = cache {
            let (tag, stored) = (tag.to_owned(), found.clone());
            let _ = tokio::task::spawn_blocking(move || cache.store(&tag, &unit, &stored)).await;
        }
        found
    }

    async fn base_game(&self, unit: &UnitSummary) -> BaseGameBlueprint {
        let Some(install) = super::game_updater::find_retail_install() else {
            return BaseGameBlueprint::Unknown(
                "the original Forged Alliance was not found, so the units FAF had not changed yet are unknown"
                    .into(),
            );
        };
        let archive = install.join("gamedata").join("units.scd");
        let id = unit.id.to_ascii_lowercase();
        let wanted = format!("units/{id}/{id}_unit.bp");
        tokio::task::spawn_blocking(move || match archive_entry(&archive, &wanted) {
            Err(reason) => BaseGameBlueprint::Unknown(reason),
            Ok(None) => BaseGameBlueprint::Missing,
            Ok(Some(source)) => match parse_blueprint(&source) {
                Ok(blueprint) => BaseGameBlueprint::Found(blueprint),
                Err(error) => BaseGameBlueprint::Unknown(format!(
                    "the base game's blueprint could not be read: {error}"
                )),
            },
        })
        .await
        .unwrap_or_else(|_| BaseGameBlueprint::Unknown("the base game could not be read".into()))
    }

    async fn fragmenting_projectiles(&self, install_dir: Option<PathBuf>) -> BTreeSet<String> {
        let base = super::game_updater::find_retail_install()
            .map(|dir| dir.join("gamedata").join("projectiles.scd"));
        let faf = install_dir.map(|dir| dir.join("gamedata").join("projectiles.nx2"));
        let cached = self.projectiles.clone();
        tokio::task::spawn_blocking(move || {
            let paths: Vec<_> = [base, faf].into_iter().flatten().collect();
            let stamp = archive_stamp(&paths);
            let mut cached = cached
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(value) = cached
                .as_ref()
                .filter(|value| Some(&value.stamp) == stamp.as_ref())
            {
                return value.value.clone();
            }
            let mut fragmenting = BTreeSet::new();
            let mut complete = true;
            // The base game first, then FAF's copies over it.
            for archive in &paths {
                let Ok(blueprints) = archive_blueprints(archive, "_proj.bp") else {
                    complete = false;
                    continue;
                };
                for (path, source) in blueprints {
                    let key = format!("/{}", path.trim_start_matches('/').to_ascii_lowercase());
                    if fragments(&source) {
                        fragmenting.insert(key);
                    } else {
                        fragmenting.remove(&key);
                    }
                }
            }
            if complete {
                if let Some(stamp) =
                    stamp.filter(|stamp| Some(stamp) == archive_stamp(&paths).as_ref())
                {
                    *cached = Some(ArchiveValue {
                        stamp,
                        value: fragmenting.clone(),
                    });
                }
            }
            fragmenting
        })
        .await
        .unwrap_or_default()
    }
}

/// Offline stand-in. Reports rather than inventing values, like the
/// changelog's.
pub struct FakeUnitHistory;

#[async_trait]
impl UnitHistoryPort for FakeUnitHistory {
    async fn list_units(&self, _install_dir: Option<PathBuf>) -> Result<Vec<UnitSummary>, String> {
        Err("the unit history is unavailable in offline mode".into())
    }

    async fn release_tags(&self) -> Result<BTreeSet<String>, String> {
        Err("the unit history is unavailable in offline mode".into())
    }

    async fn release_blueprint(&self, _tag: &str, _paths: &[String]) -> ReleaseBlueprint {
        ReleaseBlueprint::Failed("the unit history is unavailable in offline mode".into())
    }

    async fn base_game(&self, _unit: &UnitSummary) -> BaseGameBlueprint {
        BaseGameBlueprint::Unknown("the unit history is unavailable in offline mode".into())
    }

    async fn fragmenting_projectiles(&self, _install_dir: Option<PathBuf>) -> BTreeSet<String> {
        BTreeSet::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicU32, Ordering},
        Arc,
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn search_efficiency_unit_archive_cache_reuses_and_invalidates_metadata() {
        use std::io::Write;
        fn write_units(path: &Path, name: &str) {
            let mut zip = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
            zip.start_file(
                "units/uel0101/uel0101_unit.bp",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
            write!(
                zip,
                "UnitBlueprint {{ General = {{ FactionName = 'UEF', UnitName = '{name}' }} }}"
            )
            .unwrap();
            zip.finish().unwrap();
        }
        let folder = tempfile::tempdir().unwrap();
        let gamedata = folder.path().join("gamedata");
        std::fs::create_dir(&gamedata).unwrap();
        let archive = gamedata.join("units.nx2");
        write_units(&archive, "First");
        let client = UnitHistoryClient::new(UnitHistoryConfig {
            raw_base: "https://example.invalid".into(),
            git_upload_pack: "https://example.invalid".into(),
            cache_dir: None,
        });
        let units = client
            .list_units(Some(folder.path().to_path_buf()))
            .await
            .unwrap();
        assert_eq!(units[0].name.as_deref(), Some("First"));
        let parsed = client
            .units
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .value
            .as_ptr() as usize;
        assert_eq!(
            client
                .list_units(Some(folder.path().to_path_buf()))
                .await
                .unwrap(),
            units
        );
        assert_eq!(
            client
                .units
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .value
                .as_ptr() as usize,
            parsed
        );
        write_units(&archive, "Changed unit name");
        let changed = client
            .list_units(Some(folder.path().to_path_buf()))
            .await
            .unwrap();
        assert_eq!(changed[0].name.as_deref(), Some("Changed unit name"));
        std::fs::remove_file(&archive).unwrap();
        assert!(client
            .list_units(Some(folder.path().to_path_buf()))
            .await
            .is_err());
    }

    #[test]
    fn the_tag_list_reads_from_pkt_lines() {
        let mut answer = Vec::new();
        answer.extend(pkt_line(
            "777a3644d807ab84891da047d630eae7337ba10a refs/tags/3603\n",
        ));
        answer.extend(pkt_line(
            "04d3760ac66358a70639835508dc4b58561fcbd9 refs/tags/3837 peeled:5f85d725a6c27a92ad4cfcdc679f2e0467c75cef\n",
        ));
        answer.extend(b"0000");
        let tags = parse_ls_refs(&answer).unwrap();
        assert_eq!(tags.into_iter().collect::<Vec<_>>(), ["3603", "3837"]);
        assert!(parse_ls_refs(b"zzzz").is_err());
        assert!(parse_ls_refs(b"00ffshort").is_err());
        assert_eq!(pkt_line("command=ls-refs\n"), b"0014command=ls-refs\n");
    }

    #[tokio::test]
    async fn cached_history_opens_while_release_metadata_refreshes() {
        use crate::infra::{ChangelogClient, ChangelogConfig};
        use crate::ports::ChangelogPort;
        use std::time::Duration;
        use tokio::sync::{watch, Semaphore};
        use tokio::time::timeout;

        let cache = tempfile::tempdir().unwrap();
        let tag_file = cache.path().join("tags.txt");
        std::fs::write(&tag_file, "3837").unwrap();
        let blueprint = ReleaseBlueprint::Found("UnitBlueprint { }".into());
        let disk = DiskCache {
            root: cache.path().to_path_buf(),
        };
        disk.store("3837", "UEL0201", &blueprint).unwrap();
        let paths = ["units/UEL0201/UEL0201_unit.bp".to_owned()];

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let game_config = UnitHistoryConfig {
            raw_base: base.clone(),
            git_upload_pack: format!("{base}/tags"),
            cache_dir: Some(cache.path().to_path_buf()),
        };
        let changelog_config = ChangelogConfig {
            index_url: format!("{base}/index"),
            cache_dir: Some(cache.path().to_path_buf()),
        };
        let requests = Arc::new(AtomicU32::new(0));
        let observed = requests.clone();
        let (respond, response_allowed) = watch::channel(false);
        let waiting = Arc::new(Semaphore::new(0));
        let started = waiting.clone();
        let server = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let observed = observed.clone();
                let mut response_allowed = response_allowed.clone();
                let started = started.clone();
                tokio::spawn(async move {
                    let mut request = [0_u8; 4096];
                    let length = socket.read(&mut request).await.unwrap();
                    let line = String::from_utf8_lossy(&request[..length]);
                    let count = observed.fetch_add(1, Ordering::AcqRel);
                    let tag = if count == 0 {
                        "3837"
                    } else {
                        started.add_permits(1);
                        response_allowed.wait_for(|allowed| *allowed).await.unwrap();
                        "3838"
                    };
                    let body = if line.starts_with("POST /tags ") {
                        let mut body = pkt_line(&format!(
                            "04d3760ac66358a70639835508dc4b58561fcbd9 refs/tags/{tag}\n"
                        ));
                        body.extend(b"0000");
                        body
                    } else {
                        assert!(line.starts_with("GET /index "), "{line}");
                        format!(
                            r#"<h2 id="2026">Year 2026</h2>
                            <li><a class="preview-title" href="/fa/changelog/{tag}">{tag} - Game Patch</a> <span>(Aug 14)</span></li>"#
                        )
                        .into_bytes()
                    };
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    socket.write_all(response.as_bytes()).await.unwrap();
                    socket.write_all(&body).await.unwrap();
                });
            }
        });

        let changelog = ChangelogClient::new(changelog_config.clone());
        let old = changelog.list_releases().await.unwrap();
        assert!(old.iter().any(|release| release.id == "3837"));
        let index_file = std::fs::read_dir(cache.path().join("release-index"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        let changelog = ChangelogClient::new(changelog_config.clone());
        let game = UnitHistoryClient::new(game_config.clone());
        assert_eq!(changelog.releases_for_unit_history().await.unwrap(), old);
        assert_eq!(
            game.release_tags().await.unwrap(),
            BTreeSet::from(["3837".into()])
        );
        assert_eq!(requests.load(Ordering::Acquire), 1);

        let expired = SystemTime::now() - Duration::from_secs(2 * 60 * 60);
        for file in [&tag_file, &index_file] {
            std::fs::OpenOptions::new()
                .write(true)
                .open(file)
                .unwrap()
                .set_modified(expired)
                .unwrap();
        }
        let changelog = ChangelogClient::new(changelog_config.clone());
        let game = UnitHistoryClient::new(game_config.clone());
        let limit = Duration::from_secs(5);
        for _ in 0..2 {
            let (tags, releases, saved_blueprint) = timeout(limit, async {
                tokio::join!(
                    game.release_tags(),
                    changelog.releases_for_unit_history(),
                    game.release_blueprint("3837", &paths),
                )
            })
            .await
            .expect("cached history must not wait for either server response");
            assert_eq!(tags.unwrap(), BTreeSet::from(["3837".into()]));
            assert_eq!(releases.unwrap(), old);
            assert_eq!(saved_blueprint, blueprint);
        }
        let (latest, ()) = timeout(limit, async {
            tokio::join!(changelog.list_releases(), async {
                waiting.acquire_many(2).await.unwrap().forget();
                respond.send(true).unwrap();
            })
        })
        .await
        .unwrap();
        let latest = latest.unwrap();
        assert!(latest.iter().any(|release| release.id == "3838"));
        assert_eq!(changelog.releases_for_unit_history().await.unwrap(), latest);

        let new_tags = BTreeSet::from(["3838".into()]);
        timeout(limit, async {
            while game.release_tags().await.unwrap() != new_tags {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let changelog = ChangelogClient::new(changelog_config);
        let game = UnitHistoryClient::new(game_config);
        assert_eq!(changelog.releases_for_unit_history().await.unwrap(), latest);
        assert_eq!(game.release_tags().await.unwrap(), new_tags);
        assert_eq!(
            requests.load(Ordering::Acquire),
            3,
            "one request per refresh"
        );
        server.abort();
    }

    #[test]
    fn only_plain_tags_and_unit_files_become_cache_paths() {
        assert!(is_plain_tag("3837"));
        assert!(is_plain_tag("3611.4"));
        assert!(!is_plain_tag("../3837"));
        assert!(!is_plain_tag(""));
        assert_eq!(
            unit_key(&["units/uel0201/UEL0201_unit.bp".into()]).as_deref(),
            Some("UEL0201")
        );
        assert_eq!(unit_key(&["units/x/../../evil".into()]), None);
    }

    #[tokio::test]
    async fn cached_blueprints_reuse_missing_files_and_repair_damaged_blobs() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(AtomicU32::new(0));
        let observed = requests.clone();
        let server = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0_u8; 4096];
                let length = socket.read(&mut request).await.unwrap();
                let line = String::from_utf8_lossy(&request[..length]).to_string();
                observed.fetch_add(1, Ordering::AcqRel);
                // Only the lower-case folder exists at 3700; nothing at 3701.
                let response = if line.starts_with("GET /3700/units/uel0201/UEL0201_unit.bp") {
                    let body = "UnitBlueprint { Defense = { MaxHealth = 300 } }";
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                } else {
                    "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        .into()
                };
                socket.write_all(response.as_bytes()).await.unwrap();
            }
        });
        let cache = tempfile::tempdir().unwrap();
        let config = UnitHistoryConfig {
            raw_base: base,
            git_upload_pack: String::new(),
            cache_dir: Some(cache.path().to_path_buf()),
        };
        let paths = vec![
            "units/UEL0201/UEL0201_unit.bp".to_owned(),
            "units/uel0201/UEL0201_unit.bp".to_owned(),
        ];
        let client = UnitHistoryClient::new(config.clone());
        let found = client.release_blueprint("3700", &paths).await;
        assert!(matches!(&found, ReleaseBlueprint::Found(text) if text.contains("MaxHealth")));
        assert_eq!(
            requests.load(Ordering::Acquire),
            2,
            "the second spelling found it"
        );
        assert_eq!(
            client.release_blueprint("3701", &paths).await,
            ReleaseBlueprint::Missing
        );
        assert_eq!(requests.load(Ordering::Acquire), 4);

        let restarted = UnitHistoryClient::new(config.clone());
        assert_eq!(restarted.release_blueprint("3700", &paths).await, found);
        assert_eq!(
            restarted.release_blueprint("3701", &paths).await,
            ReleaseBlueprint::Missing
        );
        assert_eq!(
            requests.load(Ordering::Acquire),
            4,
            "both answers come from disk"
        );

        let ReleaseBlueprint::Found(source) = &found else {
            panic!("expected the cached blueprint");
        };
        let disk = DiskCache {
            root: cache.path().to_path_buf(),
        };
        let digest = format!("{:x}", Sha256::digest(source.as_bytes()));
        std::fs::write(disk.blob(&digest), "damaged").unwrap();
        assert_eq!(restarted.release_blueprint("3700", &paths).await, found);
        assert_eq!(
            requests.load(Ordering::Acquire),
            6,
            "downloaded the valid copy"
        );
        let restarted = UnitHistoryClient::new(config);
        assert_eq!(restarted.release_blueprint("3700", &paths).await, found);
        assert_eq!(
            requests.load(Ordering::Acquire),
            6,
            "the repaired copy came from disk"
        );
        server.abort();
    }

    #[test]
    fn a_damaged_blob_is_read_again() {
        let root = tempfile::tempdir().unwrap();
        let cache = DiskCache {
            root: root.path().to_path_buf(),
        };
        let blueprint = ReleaseBlueprint::Found("UnitBlueprint { }".into());
        cache.store("3800", "UEL0201", &blueprint).unwrap();
        assert_eq!(cache.read("3800", "UEL0201"), Some(blueprint));
        let digest = format!("{:x}", Sha256::digest(b"UnitBlueprint { }"));
        std::fs::write(cache.blob(&digest), "UnitBlueprint { A = 1 }").unwrap();
        assert_eq!(cache.read("3800", "UEL0201"), None);
        cache
            .store(
                "3800",
                "UEL0202",
                &ReleaseBlueprint::Failed("offline".into()),
            )
            .unwrap();
        assert_eq!(cache.read("3800", "UEL0202"), None, "a failure is not kept");
    }

    #[test]
    fn a_projectile_fragments_only_with_a_positive_count() {
        assert!(fragments(
            "ProjectileBlueprint { Physics = { Fragments = 5, FragmentId = '/projectiles/x/x_proj.bp' } }"
        ));
        assert!(!fragments(
            "ProjectileBlueprint { Physics = { Fragments = 0 } }"
        ));
        assert!(!fragments(
            "ProjectileBlueprint { Physics = { MaxSpeed = 30 } }"
        ));
    }
}
