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

use std::collections::BTreeSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use async_trait::async_trait;
use faf_domain::protocol::blueprint::parse_blueprint;
use faf_domain::protocol::unit_history::{
    summarize, BaseGameBlueprint, ReleaseBlueprint, UnitSummary,
};
use sha2::{Digest, Sha256};

use crate::ports::UnitHistoryPort;

/// The largest blueprint in the repository is about 60 KB (a commander).
const MAX_BLUEPRINT_BYTES: u64 = 1024 * 1024;
/// The tag list is about 12 KB.
const MAX_TAG_LIST_BYTES: u64 = 1024 * 1024;
/// How long a tag list is trusted before it is asked for again. A release
/// published while the client is open appears within this.
const TAG_LIST_AGE: Duration = Duration::from_secs(60 * 60);
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
    tags: tokio::sync::Mutex<Option<(Instant, BTreeSet<String>)>>,
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
            config,
            http: super::http::shared_http_client(),
            tags: tokio::sync::Mutex::new(None),
            units: Arc::default(),
            projectiles: Arc::default(),
        }
    }

    pub fn faf() -> Self {
        Self::new(UnitHistoryConfig::faf())
    }

    async fn fetch_tags(&self) -> Result<BTreeSet<String>, String> {
        // `command=ls-refs`, a delimiter, `ref-prefix refs/tags/`, a flush:
        // each line framed by its own length in four hex digits.
        let mut body = pkt_line("command=ls-refs\n");
        body.extend(b"0001");
        body.extend(pkt_line("ref-prefix refs/tags/\n"));
        body.extend(b"0000");
        let response = self
            .http
            .post(&self.config.git_upload_pack)
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
        Ok(tags)
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

    fn read(&self, tag: &str, unit: &str) -> Option<ReleaseBlueprint> {
        let reference = std::fs::read_to_string(self.reference(tag, unit)).ok()?;
        let reference = reference.trim();
        if reference == MISSING {
            return Some(ReleaseBlueprint::Missing);
        }
        if reference.len() != 64 || !reference.bytes().all(|c| c.is_ascii_hexdigit()) {
            return None;
        }
        let mut text = String::new();
        std::fs::File::open(self.blob(reference))
            .ok()?
            .take(MAX_BLUEPRINT_BYTES + 1)
            .read_to_string(&mut text)
            .ok()?;
        // A blob that does not hash to its name was damaged on disk.
        (format!("{:x}", Sha256::digest(text.as_bytes())) == reference)
            .then_some(ReleaseBlueprint::Found(text))
    }

    fn store(&self, tag: &str, unit: &str, blueprint: &ReleaseBlueprint) -> std::io::Result<()> {
        let reference = match blueprint {
            ReleaseBlueprint::Found(text) => {
                let digest = format!("{:x}", Sha256::digest(text.as_bytes()));
                let blob = self.blob(&digest);
                if !blob.is_file() {
                    write_atomic(&blob, text.as_bytes())?;
                }
                digest
            }
            ReleaseBlueprint::Missing => MISSING.to_owned(),
            ReleaseBlueprint::Failed(_) => return Ok(()),
        };
        write_atomic(&self.reference(tag, unit), reference.as_bytes())
    }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let directory = path.parent().ok_or(std::io::ErrorKind::InvalidInput)?;
    std::fs::create_dir_all(directory)?;
    let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
    temporary.write_all(bytes)?;
    temporary.persist(path).map_err(|error| error.error)?;
    Ok(())
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
        let mut held = self.tags.lock().await;
        if let Some((read, tags)) = held.as_ref() {
            if read.elapsed() < TAG_LIST_AGE {
                return Ok(tags.clone());
            }
        }
        let cached = self
            .config
            .cache_dir
            .as_ref()
            .map(|dir| dir.join("tags.txt"));
        match self.fetch_tags().await {
            Ok(tags) => {
                if let Some(path) = cached {
                    let text = tags.iter().cloned().collect::<Vec<_>>().join("\n");
                    let _ =
                        tokio::task::spawn_blocking(move || write_atomic(&path, text.as_bytes()))
                            .await;
                }
                *held = Some((Instant::now(), tags.clone()));
                Ok(tags)
            }
            // Offline, the last list read still names every tag that existed
            // then, which is every release the cache can hold.
            Err(reason) => {
                let stale = match cached {
                    Some(path) => tokio::fs::read_to_string(path).await.ok(),
                    None => None,
                };
                let tags: BTreeSet<String> = stale
                    .iter()
                    .flat_map(|text| text.lines())
                    .filter(|tag| is_plain_tag(tag))
                    .map(str::to_owned)
                    .collect();
                if tags.is_empty() {
                    Err(reason)
                } else {
                    Ok(tags)
                }
            }
        }
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
    async fn a_release_is_read_once_and_kept_including_a_missing_file() {
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

        let restarted = UnitHistoryClient::new(config);
        assert_eq!(restarted.release_blueprint("3700", &paths).await, found);
        assert_eq!(
            restarted.release_blueprint("3701", &paths).await,
            ReleaseBlueprint::Missing
        );
        assert_eq!(
            requests.load(Ordering::Acquire),
            4,
            "both answers come from the disk"
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
