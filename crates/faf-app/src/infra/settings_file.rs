//! File-backed settings store: JSON in the OS config directory.
//!
//! The real [`SettingsPort`]. Resolves a per-app config directory via the
//! `directories` crate, so it needs no path injection from the shell and stays
//! free of any Tauri coupling. All IO is best-effort: a missing file yields
//! nothing (and the caller runs on defaults), a damaged one yields everything
//! in it that can still be read, and write failures are swallowed (logged to
//! the dev console).
//!
//! Each document carries a schema version, and the steps that bring an older
//! one up to date are [`MIGRATIONS`]. A save keeps whatever the document it
//! replaces holds that this build does not read, so a move to an older build
//! and back costs nothing the older build left alone.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use faf_domain::state::SettingsState;
use serde_json::Value;

use crate::ports::SettingsPort;

/// How often a settings file that exists but cannot be opened is tried again
/// before the load gives up on it. A virus scanner or a sync client holding
/// the file for a moment is the case this is for.
const READ_ATTEMPTS: u32 = 3;
const READ_RETRY_DELAY: Duration = Duration::from_millis(250);

/// Persists settings to `<config-dir>/settings.json`.
pub struct FileSettings {
    path: PathBuf,
    /// Whether the file on disk may be replaced.
    ///
    /// Cleared when the last load found the file but could not open it. The
    /// session then runs on defaults, and the first save would have written
    /// those defaults over settings that were perfectly good and merely
    /// locked for a moment, which is one way a player restarts the client and
    /// finds everything reset. The file is left alone instead until a load
    /// reads it again.
    writable: AtomicBool,
}

impl FileSettings {
    /// Use the standard per-app config directory (e.g.
    /// `%APPDATA%/FAForever/FAForever Client` on Windows,
    /// `~/.config/FAForever Client` on Linux). Falls back to the current
    /// directory if no config dir can be resolved.
    pub fn faf() -> Self {
        Self::at(resolve_path())
    }

    pub fn at(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            writable: AtomicBool::new(true),
        }
    }
}

/// Same resolution [`FileSettings::faf`] uses, exposed standalone so the
/// shell can pre-read settings synchronously at startup (see
/// [`load_sync`]) before the async runtime: and therefore the [`SettingsPort`]
///: exists yet.
pub fn resolve_path() -> PathBuf {
    crate::infra::project_dirs()
        .map(|dirs| dirs.config_dir().join("settings.json"))
        .unwrap_or_else(|| PathBuf::from("settings.json"))
}

/// Blocking read of persisted settings, for use before the async runtime
/// starts. [`crate::infra::ports_from_env`] builds `GameConfig`/`ReplayConfig`
/// synchronously from env vars at startup, before `SettingsCommand::Load`
/// ever runs on the loop: so a persisted `game_path`/`replay_game_path`
/// needs to reach those env vars *before* that call, not through the normal
/// async [`SettingsPort::load`] path. Same defaults-on-missing-or-corrupt
/// posture as the async version.
pub fn load_sync(path: &std::path::Path) -> SettingsState {
    match std::fs::read(path) {
        Ok(bytes) => read_document(path, &bytes).unwrap_or_default().normalized(),
        Err(_) => SettingsState::default(),
    }
}

/// The settings a file holds, as many of them as can still be read.
///
/// A document that parses is the whole answer. One that does not used to be
/// replaced by defaults for everything, and the load path saves soon after,
/// so a single value this client could not read (an option a newer build
/// wrote, a number that went out as `null`) cost the player every setting
/// they had, on disk as well as on screen. Now the file is copied aside first,
/// so nothing is lost for good, and every value that still fits is kept.
///
/// `None` only when nothing in it could be read at all ([`salvage`]): the
/// session runs on defaults then, exactly as if there had been no file.
fn read_document(path: &Path, bytes: &[u8]) -> Option<SettingsState> {
    match parse(bytes) {
        Ok(settings) => {
            keep_last_good_copy(path, bytes, &settings);
            Some(settings)
        }
        Err(error) => {
            let copy = keep_unreadable_copy(path, bytes);
            let (settings, dropped) = salvage(bytes);
            tracing::warn!(
                %error,
                ?dropped,
                copy = ?copy,
                "settings file partly unreadable; kept everything that could be read"
            );
            settings
        }
    }
}

/// Where the last settings document that read back cleanly is kept.
fn last_good_path(path: &Path) -> PathBuf {
    parent_directory(path).join("settings.last-good.json")
}

/// Keep a copy of a settings document that read back cleanly, for the day the
/// real one goes missing or is replaced by defaults.
///
/// Only a document somebody actually configured is worth keeping: a copy of
/// pure defaults would overwrite the one copy that still holds their settings.
fn keep_last_good_copy(path: &Path, bytes: &[u8], settings: &SettingsState) {
    if is_pristine(settings) {
        return;
    }
    let copy = last_good_path(path);
    if std::fs::read(&copy).is_ok_and(|kept| kept == bytes) {
        return;
    }
    if let Err(error) = write_atomically(&copy, bytes) {
        tracing::warn!(%error, path = %copy.display(), "could not keep a copy of the settings");
    }
}

/// Whether these are the settings of a client nobody has configured.
///
/// A fresh install always has a game path by the time anything is saved, since
/// the startup load fills it in, so a document this empty that is about to
/// replace a real one is the reset the reports describe, not a choice.
fn is_pristine(settings: &SettingsState) -> bool {
    let mut settings = settings.clone();
    settings.cache_info = Default::default();
    settings == SettingsState::default()
}

/// Copy an unreadable settings file aside, beside the original.
///
/// Named after its content, so the startup read and the async load, which
/// both see the same broken file, keep one copy of it between them, while a
/// second and different failure later still gets a copy of its own.
fn keep_unreadable_copy(path: &Path, bytes: &[u8]) -> Option<PathBuf> {
    use std::hash::{Hash as _, Hasher as _};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    let copy =
        parent_directory(path).join(format!("settings.unreadable-{:016x}.json", hasher.finish()));
    if copy.exists() {
        return Some(copy);
    }
    match std::fs::write(&copy, bytes) {
        Ok(()) => Some(copy),
        Err(error) => {
            tracing::warn!(%error, path = %copy.display(), "could not keep a copy of the unreadable settings");
            None
        }
    }
}

/// Everything in a stored document that this client can read, on top of
/// defaults, and the JSON pointers of what it had to leave out.
///
/// Value by value: each stored value is tried in place of its default, and
/// kept if the whole state still parses with it. A group that does not fit as
/// a whole is taken apart and tried member by member, so an unknown value
/// three levels down costs that one value and not its section.
///
/// `None` when there is nothing to take values from: a file that is not JSON
/// (cut off mid-write, say), or JSON that is not a settings object.
fn salvage(bytes: &[u8]) -> (Option<SettingsState>, Vec<String>) {
    let stored = match serde_json::from_slice::<Value>(bytes) {
        Ok(stored) if stored.is_object() => stored,
        _ => return (None, vec!["".into()]),
    };
    match salvaged(&migrated(stored)) {
        Some((accepted, dropped)) => (
            Some(serde_json::from_value(accepted).unwrap_or_default()),
            dropped,
        ),
        None => (None, vec!["".into()]),
    }
}

/// What [`salvage`] keeps of a migrated document, as a document: the defaults
/// with every stored value adopted that still parses, and the pointers of the
/// values that did not.
fn salvaged(stored: &Value) -> Option<(Value, Vec<String>)> {
    let mut accepted = serde_json::to_value(SettingsState::default()).ok()?;
    let mut dropped = Vec::new();
    adopt(&mut accepted, "", stored, &mut dropped);
    Some((accepted, dropped))
}

fn adopt(accepted: &mut Value, pointer: &str, stored: &Value, dropped: &mut Vec<String>) {
    let Some(members) = stored.as_object() else {
        dropped.push(pointer.to_string());
        return;
    };
    for (key, value) in members {
        let child = format!("{pointer}/{}", key.replace('~', "~0").replace('/', "~1"));
        let mut candidate = accepted.clone();
        if let Some(Value::Object(parent)) = candidate.pointer_mut(pointer) {
            parent.insert(key.clone(), value.clone());
        }
        if serde_json::from_value::<SettingsState>(candidate.clone()).is_ok() {
            *accepted = candidate;
        } else if value.is_object() && accepted.pointer(&child).is_some_and(Value::is_object) {
            adopt(accepted, &child, value, dropped);
        } else {
            dropped.push(child);
        }
    }
}

/// Read a settings document, migrating it on the way in.
///
/// The migration step is not a nicety. A value that fails to parse is only
/// salvaged around ([`read_document`]): the value itself is lost, and a
/// renamed start page is not a corrupt one, just an old one. Anything renamed
/// on the wire has to be translated here rather than left to fail.
fn parse(bytes: &[u8]) -> Result<SettingsState, serde_json::Error> {
    let document: serde_json::Value = serde_json::from_slice(bytes)?;
    serde_json::from_value(migrated(document))
}

/// The key a settings document keeps its schema version under.
///
/// Not a field of [`SettingsState`]: the version belongs to the file, not to
/// the state the UI mirrors, so it is taken off on the way in ([`migrated`])
/// and put back on the way out ([`document_to_write`]), and the IPC contract
/// never sees it.
const VERSION_KEY: &str = "schemaVersion";

/// One step in how settings are stored: rewrites a document of one version
/// into the next.
type Migration = fn(&mut Value);

/// Every change to how settings are stored that an older document has to be
/// translated through, oldest first: `MIGRATIONS[n]` takes a version `n`
/// document to version `n + 1`. A document without a version was written
/// before there were versions, and is version 0.
///
/// Only a change that would otherwise lose a value needs a step here. A new
/// setting does not, nor does a new group: a missing value reads as its
/// default. A rename or a move does. Append, never reorder or remove, since a
/// document's version is how many of these it has already been through.
///
/// A step moves a value rather than copying it. Whatever it leaves under the
/// old name is a key this build does not read, and those are carried over on
/// every save ([`unread_keys`]).
const MIGRATIONS: &[Migration] = &[rename_start_pages];

/// The version of a document this build writes: every step in [`MIGRATIONS`]
/// applied.
const SCHEMA_VERSION: u64 = MIGRATIONS.len() as u64;

/// The version a stored document was written at.
///
/// Missing in a document written before there were versions, which makes it
/// version 0, the oldest. A version that is not a whole number, which only a
/// hand edit produces, is read the same way.
fn stored_version(document: &Value) -> u64 {
    document
        .get(VERSION_KEY)
        .and_then(Value::as_u64)
        .unwrap_or(0)
}

/// Bring a stored document up to this build's version, and take the version
/// off it, since [`SettingsState`] has none.
///
/// A document from a newer build than this one has no steps left to run and
/// is read as it is, as far as this build understands it. Saving it again
/// keeps its version ([`document_to_write`]): writing this build's lower one
/// would have the newer build run its own steps a second time, over values
/// they have already moved.
fn migrated(document: Value) -> Value {
    migrated_through(document, MIGRATIONS)
}

fn migrated_through(mut document: Value, migrations: &[Migration]) -> Value {
    let version = stored_version(&document);
    if let Some(members) = document.as_object_mut() {
        members.remove(VERSION_KEY);
    }
    let applied = usize::try_from(version).unwrap_or(usize::MAX);
    for migration in migrations.iter().skip(applied) {
        migration(&mut document);
    }
    document
}

/// Version 0 to 1: two tabs renamed.
fn rename_start_pages(document: &mut Value) {
    // `Tab::Tutorials` became `Tab::Training` when the tutorials tab grew into
    // the training hub, and `Tab::Contribution` became `Tab::Links` when the
    // repository list grew into the link directory. `general.startPage` is the
    // one place a `Tab` is persisted, so this is the whole of both renames'
    // migration.
    if let Some(start_page) = document.pointer_mut("/general/startPage") {
        let renamed = match start_page.as_str() {
            Some("tutorials") => Some("training"),
            Some("contribution") => Some("links"),
            _ => None,
        };
        if let Some(name) = renamed {
            *start_page = Value::String(name.into());
        }
    }
}

/// The document to write for `settings`, already serialized, in place of the
/// stored one, `replaced`.
///
/// A newer build may have stored settings this one has no field for, inside
/// a group or as a group of their own. Reading ignores them, so a document
/// written from the state alone would delete them, and a player who tries an
/// older build (the prerelease channel and the development builds make that
/// an ordinary move) would come back to find the newer build's settings
/// reset. So every key the stored document has and this build does not read
/// is written back where it was, and the version stays the stored one when
/// that is newer than this build's.
///
/// Builds older than the first to do this still drop both.
fn document_to_write(mut settings: Value, replaced: Option<&[u8]>) -> Value {
    let (version, unread) = replaced.map(unread_part).unwrap_or_default();
    for (path, value) in unread {
        let Some((key, parent)) = path.split_last() else {
            continue;
        };
        // A group, or a map entry, that is gone from the settings takes what
        // was unread in it along: carried over on its own, an entry the
        // player removed would come back.
        if let Some(Value::Object(parent)) = member_mut(&mut settings, parent) {
            parent.entry(key.clone()).or_insert(value);
        }
    }
    if let Value::Object(members) = &mut settings {
        members.insert(VERSION_KEY.into(), SCHEMA_VERSION.max(version).into());
    }
    settings
}

/// A stored document's version, and every key in it this build does not
/// read, by its path, with its value.
///
/// A document that does not parse is looked at as far as it is salvaged
/// ([`salvaged`]): a value this build could not read is lost to the save, as
/// it is to the load, but an unknown key beside it is not.
fn unread_part(stored: &[u8]) -> (u64, Vec<(Vec<String>, Value)>) {
    let Ok(document) = serde_json::from_slice::<Value>(stored) else {
        return (0, Vec::new());
    };
    let version = stored_version(&document);
    let document = migrated(document);
    let readable = match serde_json::from_value::<SettingsState>(document.clone()) {
        Ok(settings) => Some((document, settings)),
        Err(_) => salvaged(&document).and_then(|(accepted, _)| {
            let settings = serde_json::from_value(accepted.clone()).ok()?;
            Some((accepted, settings))
        }),
    };
    match readable {
        Some((document, settings)) => (version, unread_keys(&document, &settings)),
        None => (version, Vec::new()),
    }
}

/// Every key in `document` that this build does not read, by its path, with
/// its value. `settings` is what this build reads from `document`.
///
/// A key is unread when what the settings serialize to has no key there, and
/// taking it out of the document changes nothing about the settings read
/// from it. The first half finds it. The second keeps out a key this build
/// reads without writing it back, such as a value it translates from an
/// older spelling, which carried over would be read again on every load, and
/// a map entry this build would spell differently.
///
/// Arrays are not looked into: once a list has changed, nothing says which
/// of its elements an unread key belonged to.
fn unread_keys(document: &Value, settings: &SettingsState) -> Vec<(Vec<String>, Value)> {
    let Ok(written) = serde_json::to_value(settings) else {
        return Vec::new();
    };
    let mut unread = Vec::new();
    let mut groups = vec![Vec::<String>::new()];
    while let Some(group) = groups.pop() {
        let (Some(Value::Object(stored_members)), Some(Value::Object(written_members))) =
            (member(document, &group), member(&written, &group))
        else {
            continue;
        };
        for (key, value) in stored_members {
            let mut path = group.clone();
            path.push(key.clone());
            match written_members.get(key) {
                Some(Value::Object(_)) if value.is_object() => groups.push(path),
                Some(_) => {}
                None if reads_the_same_without(document, &path, settings) => {
                    unread.push((path, value.clone()));
                }
                None => {}
            }
        }
    }
    unread
}

/// Whether `document` without the key at `path` still reads as `settings`.
fn reads_the_same_without(document: &Value, path: &[String], settings: &SettingsState) -> bool {
    let Some((key, parent)) = path.split_last() else {
        return false;
    };
    let mut without = document.clone();
    if let Some(Value::Object(members)) = member_mut(&mut without, parent) {
        members.remove(key);
    }
    serde_json::from_value::<SettingsState>(without).is_ok_and(|read| read == *settings)
}

fn member<'a>(value: &'a Value, path: &[String]) -> Option<&'a Value> {
    path.iter().try_fold(value, |value, key| value.get(key))
}

fn member_mut<'a>(value: &'a mut Value, path: &[String]) -> Option<&'a mut Value> {
    path.iter().try_fold(value, |value, key| value.get_mut(key))
}

#[async_trait]
impl SettingsPort for FileSettings {
    async fn load(&self) -> Option<SettingsState> {
        let mut attempt = 1;
        loop {
            match tokio::fs::read(&self.path).await {
                Ok(bytes) => {
                    self.writable.store(true, Ordering::SeqCst);
                    let path = self.path.clone();
                    return tokio::task::spawn_blocking(move || read_document(&path, &bytes))
                        .await
                        .ok()
                        .flatten();
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    self.writable.store(true, Ordering::SeqCst);
                    // First run, or a settings file that went missing. The
                    // last copy that read back cleanly answers the second.
                    let copy = last_good_path(&self.path);
                    return match tokio::fs::read(&copy).await {
                        Ok(bytes) => {
                            tracing::warn!(
                                path = %copy.display(),
                                "settings file missing; restored the last copy that read back cleanly"
                            );
                            parse(&bytes).ok().or_else(|| salvage(&bytes).0)
                        }
                        Err(_) => None,
                    };
                }
                Err(error) if attempt < READ_ATTEMPTS => {
                    tracing::debug!(%error, attempt, "settings file busy, trying again");
                    attempt += 1;
                    tokio::time::sleep(READ_RETRY_DELAY).await;
                }
                Err(error) => {
                    self.writable.store(false, Ordering::SeqCst);
                    tracing::warn!(
                        %error,
                        path = %self.path.display(),
                        "could not read settings; running on defaults and leaving the file alone"
                    );
                    return None;
                }
            }
        }
    }

    // Reports rather than logs: the caller decides whether a failure is a log
    // line or something the player has to be told, and logging here as well
    // would print every failure twice.
    async fn save(&self, settings: &SettingsState) -> Result<(), String> {
        if !self.writable.load(Ordering::SeqCst) {
            return Err(format!(
                "not saving settings over {}, which could not be read at startup",
                self.path.display()
            ));
        }
        // The signature of every reset reported so far (#320, #383, #396): a
        // document of nothing but defaults, written over one that held the
        // player's settings. Whatever path produced it, it is never what the
        // player asked for, so it is not written, and the caller hears that
        // nothing was saved.
        let on_disk = tokio::fs::read(&self.path).await;
        if is_pristine(settings)
            && on_disk
                .as_ref()
                .is_ok_and(|bytes| parse(bytes).is_ok_and(|stored| !is_pristine(&stored)))
        {
            return Err(format!(
                "not replacing the configured settings in {} with defaults",
                self.path.display()
            ));
        }
        let serialized = serde_json::to_value(settings)
            .map_err(|error| format!("could not serialize settings: {error}"))?;
        // What this save replaces, for what it holds that this build does not
        // read (`document_to_write`). A missing file was answered from the
        // last good copy at load, so that copy is what is being replaced then.
        let replaced = match on_disk {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                tokio::fs::read(last_good_path(&self.path)).await.ok()
            }
            Err(_) => None,
        };
        let parent = parent_directory(&self.path);
        tokio::fs::create_dir_all(parent).await.map_err(|error| {
            format!(
                "could not create the settings directory {}: {error}",
                parent.display()
            )
        })?;

        let path = self.path.clone();
        let write = tokio::task::spawn_blocking(move || {
            let document = document_to_write(serialized, replaced.as_deref());
            let bytes = serde_json::to_vec_pretty(&document)
                .map_err(|error| format!("could not serialize settings: {error}"))?;
            write_atomically(&path, &bytes)
                .map_err(|error| format!("could not write {}: {error}", path.display()))
        });
        match write.await {
            Ok(result) => result,
            Err(error) => Err(format!("the settings writer task failed: {error}")),
        }
    }
}

fn parent_directory(path: &Path) -> &Path {
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
}

/// Write beside the destination, flush the complete JSON, then replace it in
/// one filesystem operation. `NamedTempFile::persist` provides the platform-
/// specific replacement semantics (including Windows) and removes the
/// temporary file if any earlier step fails.
pub(crate) fn write_atomically(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut temporary = tempfile::NamedTempFile::new_in(parent_directory(path))?;
    temporary.write_all(bytes)?;
    temporary.as_file().sync_all()?;
    temporary
        .persist(path)
        .map(|_| ())
        .map_err(|error| error.error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use faf_domain::state::Theme;

    #[tokio::test]
    async fn round_trips_through_a_file() {
        let dir = tempfile::tempdir().expect("temporary settings directory");
        let path = dir.path().join("settings.json");
        let store = FileSettings::at(&path);

        // Missing file → nothing, and the caller runs on defaults.
        assert_eq!(store.load().await, None);

        store
            .save(&SettingsState {
                theme: Theme::PythonClient,
                game_path: "C:/FA/bin/ForgedAlliance.exe".into(),
                replay_game_path: String::new(),
                ..SettingsState::default()
            })
            .await
            .expect("a writable temporary directory");
        let loaded = store.load().await.expect("the file just written");
        assert_eq!(loaded.theme, Theme::PythonClient);
        assert_eq!(loaded.game_path, "C:/FA/bin/ForgedAlliance.exe");
    }

    #[tokio::test]
    async fn a_start_page_saved_under_its_old_name_still_loads() {
        // The tutorials tab became the training hub. Without the migration the
        // whole document fails to parse and the player silently loses every
        // other setting in it, not just this one.
        let dir = tempfile::tempdir().expect("temporary settings directory");
        let path = dir.path().join("settings.json");
        std::fs::write(
            &path,
            br#"{"theme":"pythonClient","general":{"startPage":"tutorials","autoLogin":false}}"#,
        )
        .expect("seed an older settings file");

        let loaded = FileSettings::at(&path)
            .load()
            .await
            .expect("an older file is still found");
        assert_eq!(loaded.general.start_page, faf_domain::state::Tab::Training);
        assert_eq!(
            loaded.theme,
            Theme::PythonClient,
            "and nothing else was lost"
        );
        assert!(!loaded.general.auto_login);

        assert_eq!(
            load_sync(&path).general.start_page,
            faf_domain::state::Tab::Training,
            "the startup path reads the same file"
        );
    }

    #[test]
    fn the_contribution_tab_is_read_as_the_link_directory() {
        // The second of the two renames, and the reason this is a `match` now:
        // somebody whose start page was the Contribution tab would otherwise
        // lose their theme, their game path and everything else in the file.
        let document =
            migrated(serde_json::from_str(r#"{"general":{"startPage":"contribution"}}"#).unwrap());
        let settings: SettingsState =
            serde_json::from_value(document).expect("an older document still parses");
        assert_eq!(settings.general.start_page, faf_domain::state::Tab::Links);
    }

    #[test]
    fn a_start_page_this_client_does_not_know_is_still_a_parse_failure() {
        // The migration translates what was renamed; it does not paper over
        // anything else, because a value nobody has ever written is a corrupt
        // file rather than an old one.
        let document =
            migrated(serde_json::from_str(r#"{"general":{"startPage":"somethingElse"}}"#).unwrap());
        assert!(serde_json::from_value::<SettingsState>(document).is_err());
    }

    /// Each step runs once, in order, starting from the version the document
    /// was written at; a document from a newer build has none left to run.
    #[test]
    fn migrations_run_in_order_from_the_stored_version() {
        fn record(document: &mut Value, step: u64) {
            document
                .as_object_mut()
                .expect("a settings object")
                .entry("applied")
                .or_insert_with(|| Value::Array(Vec::new()))
                .as_array_mut()
                .expect("the steps applied so far")
                .push(step.into());
        }
        let steps: [Migration; 3] = [
            |document| record(document, 0),
            |document| record(document, 1),
            |document| record(document, 2),
        ];
        let applied = |stored: &str| {
            let document = migrated_through(serde_json::from_str(stored).unwrap(), &steps);
            assert!(
                document.get(VERSION_KEY).is_none(),
                "the version is the file's, not the state's"
            );
            document["applied"].clone()
        };

        assert_eq!(applied("{}"), serde_json::json!([0, 1, 2]));
        assert_eq!(
            applied(r#"{"schemaVersion":0}"#),
            serde_json::json!([0, 1, 2])
        );
        assert_eq!(applied(r#"{"schemaVersion":1}"#), serde_json::json!([1, 2]));
        assert_eq!(applied(r#"{"schemaVersion":3}"#), Value::Null);
        assert_eq!(applied(r#"{"schemaVersion":9}"#), Value::Null);
        assert_eq!(
            applied(r#"{"schemaVersion":"1"}"#),
            serde_json::json!([0, 1, 2]),
            "a version that is not a number is no version"
        );
    }

    fn stored_document(path: &Path) -> Value {
        serde_json::from_slice(&std::fs::read(path).expect("read the settings file"))
            .expect("the settings file is JSON")
    }

    #[tokio::test]
    async fn a_file_without_a_version_is_saved_migrated_and_at_this_version() {
        let dir = tempfile::tempdir().expect("temporary settings directory");
        let path = dir.path().join("settings.json");
        std::fs::write(
            &path,
            br#"{"theme":"pythonClient","general":{"startPage":"tutorials"}}"#,
        )
        .expect("seed a settings file from before there were versions");
        let store = FileSettings::at(&path);

        let loaded = store.load().await.expect("an older file is still found");
        store.save(&loaded).await.expect("save it again");

        let stored = stored_document(&path);
        assert_eq!(stored[VERSION_KEY], SCHEMA_VERSION);
        assert_eq!(stored["general"]["startPage"], "training");
        assert_eq!(stored["theme"], "pythonClient");
    }

    /// The reset a player moving between builds would see: settings a newer
    /// build added, deleted by the first save of an older one.
    #[tokio::test]
    async fn keys_a_newer_build_added_survive_a_read_and_a_save() {
        let dir = tempfile::tempdir().expect("temporary settings directory");
        let path = dir.path().join("settings.json");
        std::fs::write(
            &path,
            br##"{
                "schemaVersion": 1,
                "theme": "pythonClient",
                "aNewerGroup": { "list": [1, 2], "on": true },
                "general": { "autoLogin": false, "aNewerSwitch": true },
                "chat": { "nameColors": { "aNewerColour": "#123456" } }
            }"##,
        )
        .expect("seed a file a newer build wrote");
        let store = FileSettings::at(&path);

        let mut settings = store.load().await.expect("the file is read");
        settings.theme = Theme::JavaClient;
        store.save(&settings).await.expect("save a change");
        // And again, from what that save wrote.
        let settings = store.load().await.expect("the saved file is read");
        store.save(&settings).await.expect("save once more");

        let stored = stored_document(&path);
        assert_eq!(stored["theme"], "javaClient", "the change is saved");
        assert_eq!(stored["general"]["autoLogin"], false);
        assert_eq!(
            stored["aNewerGroup"],
            serde_json::json!({ "list": [1, 2], "on": true })
        );
        assert_eq!(stored["general"]["aNewerSwitch"], true);
        assert_eq!(stored["chat"]["nameColors"]["aNewerColour"], "#123456");
    }

    #[tokio::test]
    async fn a_file_from_a_newer_build_keeps_its_version() {
        let dir = tempfile::tempdir().expect("temporary settings directory");
        let path = dir.path().join("settings.json");
        let newer = SCHEMA_VERSION + 3;
        std::fs::write(
            &path,
            format!(r#"{{"schemaVersion":{newer},"theme":"pythonClient"}}"#),
        )
        .expect("seed a file a newer build wrote");
        let store = FileSettings::at(&path);

        let loaded = store.load().await.expect("the file is read");
        assert_eq!(
            loaded.theme,
            Theme::PythonClient,
            "as far as it is understood"
        );
        store.save(&loaded).await.expect("save it again");

        assert_eq!(stored_document(&path)[VERSION_KEY], newer);
    }

    /// A map's entries are the player's, not a newer build's: one they
    /// removed is not carried over as if this build had not read it.
    #[tokio::test]
    async fn a_removed_map_entry_stays_removed() {
        let dir = tempfile::tempdir().expect("temporary settings directory");
        let path = dir.path().join("settings.json");
        std::fs::write(
            &path,
            br##"{
                "schemaVersion": 1,
                "theme": "pythonClient",
                "chat": {
                    "nameColors": { "players": { "Aurora": "#ff0000" } },
                    "readMarkers": { "#aeolus": "2026-01-01T00:00:00Z" }
                }
            }"##,
        )
        .expect("seed a file with map entries");
        let store = FileSettings::at(&path);

        let mut settings = store.load().await.expect("the file is read");
        assert_eq!(settings.chat.name_colors.players.len(), 1);
        settings.chat.name_colors.players.clear();
        settings.chat.read_markers.clear();
        store.save(&settings).await.expect("save the removal");

        let stored = stored_document(&path);
        assert_eq!(
            stored["chat"]["nameColors"]["players"],
            serde_json::json!({})
        );
        assert_eq!(stored["chat"]["readMarkers"], serde_json::json!({}));
    }

    /// No setting is read today without being written back under the same
    /// name, so this is the check alone: a key that changes what is read is
    /// never counted as unread, whatever the settings serialize to.
    #[test]
    fn a_key_that_changes_what_is_read_is_not_unread() {
        let document = serde_json::json!({ "theme": "pythonClient", "aNewerKey": 1 });
        let settings: SettingsState =
            serde_json::from_value(document.clone()).expect("the document parses");
        assert!(!reads_the_same_without(
            &document,
            &["theme".into()],
            &settings
        ));
        assert!(reads_the_same_without(
            &document,
            &["aNewerKey".into()],
            &settings
        ));
    }

    #[tokio::test]
    async fn unread_keys_survive_beside_a_value_that_could_not_be_read() {
        let dir = tempfile::tempdir().expect("temporary settings directory");
        let path = dir.path().join("settings.json");
        std::fs::write(
            &path,
            br#"{
                "theme": "pythonClient",
                "aNewerGroup": 1,
                "general": { "startPage": "somethingElse", "aNewerSwitch": true }
            }"#,
        )
        .expect("seed a partly unreadable file");
        let store = FileSettings::at(&path);

        let loaded = store.load().await.expect("a partly readable file is read");
        store.save(&loaded).await.expect("save it again");

        let stored = stored_document(&path);
        assert_eq!(stored["theme"], "pythonClient");
        assert_eq!(stored["aNewerGroup"], 1);
        assert_eq!(stored["general"]["aNewerSwitch"], true);
        assert_eq!(
            stored["general"]["startPage"], "news",
            "the value that could not be read is not"
        );
    }

    #[tokio::test]
    async fn a_file_restored_from_the_last_good_copy_keeps_its_unread_keys() {
        let dir = tempfile::tempdir().expect("temporary settings directory");
        let path = dir.path().join("settings.json");
        std::fs::write(
            &path,
            br#"{"schemaVersion":1,"theme":"pythonClient","aNewerGroup":{"on":true}}"#,
        )
        .expect("seed a file a newer build wrote");
        let store = FileSettings::at(&path);
        store.load().await.expect("a clean read keeps the copy");
        std::fs::remove_file(&path).expect("lose the settings file");

        let restored = store.load().await.expect("restored from the copy");
        store
            .save(&restored)
            .await
            .expect("save the restored settings");

        assert_eq!(
            stored_document(&path)["aNewerGroup"],
            serde_json::json!({ "on": true })
        );
    }

    fn unreadable_copies(dir: &Path) -> Vec<Vec<u8>> {
        std::fs::read_dir(dir)
            .expect("list the settings directory")
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("settings.unreadable-")
            })
            .map(|entry| std::fs::read(entry.path()).expect("read the copy"))
            .collect()
    }

    /// The reported reset: a restart, and every setting back to its default.
    /// One value this client cannot read used to cost the whole file, and the
    /// load path saves soon after, so the loss reached the disk as well. Now
    /// it costs that value, even three levels down, and the file as it was
    /// is kept aside.
    #[tokio::test]
    async fn an_unreadable_value_costs_that_value_and_nothing_else() {
        let dir = tempfile::tempdir().expect("temporary settings directory");
        let path = dir.path().join("settings.json");
        let stored = br#"{
            "theme": "pythonClient",
            "general": { "startPage": "somethingElse", "autoLogin": false },
            "mapGenerator": { "seed": "kept-seed", "generationType": "fromTheFuture" }
        }"#;
        std::fs::write(&path, stored).expect("seed a partly unreadable file");

        let loaded = FileSettings::at(&path)
            .load()
            .await
            .expect("a partly readable file is still found");

        assert_eq!(loaded.theme, Theme::PythonClient);
        assert!(
            !loaded.general.auto_login,
            "the start page's neighbour survives"
        );
        assert_eq!(
            loaded.general.start_page,
            SettingsState::default().general.start_page
        );
        assert_eq!(loaded.map_generator.seed, "kept-seed");
        assert_eq!(unreadable_copies(dir.path()), vec![stored.to_vec()]);

        // The startup read sees the same file and keeps no second copy.
        assert_eq!(load_sync(&path).theme, Theme::PythonClient);
        assert_eq!(unreadable_copies(dir.path()).len(), 1);
    }

    #[tokio::test]
    async fn a_file_that_is_not_json_at_all_is_kept_aside() {
        let dir = tempfile::tempdir().expect("temporary settings directory");
        let path = dir.path().join("settings.json");
        std::fs::write(&path, b"{\"theme\": \"pythonCl").expect("seed a truncated file");

        // Nothing in it could be read, so it counts as no settings at all:
        // the session runs on defaults, as on a first start.
        assert_eq!(FileSettings::at(&path).load().await, None);
        assert_eq!(
            unreadable_copies(dir.path()),
            vec![b"{\"theme\": \"pythonCl".to_vec()]
        );
    }

    /// The reset as it was found on disk: a document of nothing but defaults,
    /// written over a configured one shortly after a start.
    #[tokio::test]
    async fn defaults_are_never_written_over_configured_settings() {
        let dir = tempfile::tempdir().expect("temporary settings directory");
        let path = dir.path().join("settings.json");
        let store = FileSettings::at(&path);
        let configured = SettingsState {
            theme: Theme::PythonClient,
            game_path: "C:/ProgramData/FAForever/bin/ForgedAlliance.exe".into(),
            ..SettingsState::default()
        };
        store
            .save(&configured)
            .await
            .expect("save the configured settings");

        store
            .save(&SettingsState::default())
            .await
            .expect_err("defaults over configured settings are refused, and say so");

        assert_eq!(
            store.load().await.map(|settings| settings.theme),
            Some(Theme::PythonClient)
        );
    }

    #[tokio::test]
    async fn a_missing_file_comes_back_from_the_last_good_copy() {
        let dir = tempfile::tempdir().expect("temporary settings directory");
        let path = dir.path().join("settings.json");
        let store = FileSettings::at(&path);
        store
            .save(&SettingsState {
                theme: Theme::PythonClient,
                ..SettingsState::default()
            })
            .await
            .expect("save the settings");
        // A load that reads it back cleanly is what keeps the copy.
        assert_eq!(
            store.load().await.map(|settings| settings.theme),
            Some(Theme::PythonClient)
        );

        std::fs::remove_file(&path).expect("lose the settings file");

        // Found rather than missing: these are a returning player's settings,
        // not a first start's.
        assert_eq!(
            store.load().await.map(|settings| settings.theme),
            Some(Theme::PythonClient)
        );
    }

    #[tokio::test]
    async fn an_unconfigured_client_keeps_no_copy() {
        let dir = tempfile::tempdir().expect("temporary settings directory");
        let path = dir.path().join("settings.json");
        let store = FileSettings::at(&path);
        store
            .save(&SettingsState::default())
            .await
            .expect("defaults are written where nothing was configured");
        store.load().await;
        assert!(!last_good_path(&path).exists());
    }

    #[test]
    fn atomic_write_replaces_an_existing_file() {
        let dir = tempfile::tempdir().expect("temporary settings directory");
        let path = dir.path().join("settings.json");
        std::fs::write(&path, b"old").expect("seed old settings");

        write_atomically(&path, b"new").expect("replace settings");

        assert_eq!(std::fs::read(path).expect("read settings"), b"new");
    }
}
