//! The local replay library: the shared FAF replay folder, what each file in
//! it says about its game, and the narrow ways the UI may touch those files.
//!
//! Separate from the codec because this part is about files and folders:
//! listing and ordering them, how a damaged file still shows in the archive,
//! and keeping a path the webview hands in inside the library. Reading the
//! bytes themselves is `codec` and `scfa_header`.

use std::path::{Path, PathBuf};

use async_trait::async_trait;
use faf_domain::state::{LocalReplay, LocalReplayPlayer, LocalReplayStatus, LocalReplayTeam};
use futures_util::StreamExt;
use serde_json::Value;
use tokio::io::AsyncReadExt;

use crate::ports::ReplayLibraryPort;

use super::names::{guess_mod_from_filename, is_replay_file_name};
use super::scfa_header::{local_body_player_stats, playable_body, LocalBodyArmy};

/// The local replay library: one folder of replay files.
///
/// Holds only where that folder is. By default it is the shared FAF replay
/// folder, resolved on every call rather than once, because the paths a user
/// configures in Settings can move it while the client runs. A test points it
/// at a directory of its own with [`ReplayLibrary::at`].
#[derive(Debug, Clone, Default)]
pub struct ReplayLibrary {
    directory: Option<PathBuf>,
}

impl ReplayLibrary {
    /// The shared FAF replay folder, wherever it currently is
    /// ([`local_replays_dir`]).
    pub fn shared() -> Self {
        Self::default()
    }

    /// A library in one fixed directory.
    pub fn at(directory: PathBuf) -> Self {
        Self {
            directory: Some(directory),
        }
    }

    /// The folder this library lists, deletes from and downloads into.
    pub(super) fn directory(&self) -> PathBuf {
        self.directory.clone().unwrap_or_else(local_replays_dir)
    }
}

#[async_trait]
impl ReplayLibraryPort for ReplayLibrary {
    async fn list_local(&self, limit: usize) -> Result<Vec<LocalReplay>, String> {
        list_local_dir(&self.directory(), limit).await
    }

    async fn delete_local(&self, path: PathBuf) -> Result<(), String> {
        delete_local_file(&self.directory(), &path).await
    }
}

/// Scans `dir` for `.fafreplay` and legacy `.scfareplay` files: the body of
/// [`ReplayLibrary::list_local`](ReplayLibraryPort::list_local), taking the
/// directory as an argument so tests don't have to mutate the process-global
/// `FAF_REPLAYS_DIR`/`ALLUSERSPROFILE` env vars.
pub(super) async fn list_local_dir(
    dir: &std::path::Path,
    limit: usize,
) -> Result<Vec<LocalReplay>, String> {
    let mut entries = match tokio::fs::read_dir(dir).await {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("could not read {}: {e}", dir.display())),
    };

    // Sort by mtime first, which is cheap: directory metadata only.
    let mut files: Vec<(PathBuf, std::time::SystemTime, u64)> = Vec::new();
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|e| format!("could not list {}: {e}", dir.display()))?
    {
        let path = entry.path();
        if !is_replay_file_name(&path) {
            continue;
        }
        if let Ok(meta) = entry.metadata().await {
            if let Ok(modified) = meta.modified() {
                files.push((path, modified, meta.len()));
            }
        }
    }
    files.sort_by_key(|f| std::cmp::Reverse(f.1));

    // Every replay is listed, but only the newest `limit` have their headers
    // read. That read is the whole cost: one `open` plus a bounded read per
    // file, and a real archive is thousands of files, so doing all of them made
    // opening the Local tab a visible wait. Reading only what the first pages
    // show, and letting the view ask for more, keeps the list complete without
    // paying for all of it up front.
    //
    // Order is preserved (`buffered`), because the sort above is the "newest
    // first" the list is presented in.
    let detailed = files.len().min(limit);
    let mut replays: Vec<LocalReplay> = futures_util::stream::iter(files[..detailed].to_vec())
        .map(|(path, modified, file_size)| async move {
            read_local_metadata(&path, modified, file_size).await
        })
        .buffered(LOCAL_REPLAY_READ_CONCURRENCY)
        .collect()
        .await;

    // The rest carry what the directory entry already gave: name, date and
    // size. `Unread` says the details were not fetched, which is not the same
    // claim as `Broken`.
    replays.extend(files[detailed..].iter().map(|(path, modified, file_size)| {
        empty_local_replay(path, *modified, *file_size, LocalReplayStatus::Unread, true)
    }));
    Ok(replays)
}

pub const LOCAL_REPLAY_PAGE_LIMIT: usize = crate::ports::DEFAULT_LOCAL_REPLAY_LIMIT;

/// How many local replay headers to read at once.
///
/// Each is an `open` plus one bounded read, so the wall-clock cost of listing a
/// folder is dominated by how many of those can be in flight rather than by how
/// many files there are. Sixteen keeps a three-thousand-file archive responsive
/// without flooding the runtime.
const LOCAL_REPLAY_READ_CONCURRENCY: usize = 16;

/// The shared FAF replay folder every client writes to. Mirrors the Python
/// client's `APPDATA_DIR` (`%ALLUSERSPROFILE%\FAForever` on Windows, falling
/// back to `~/FAForever` elsewhere) plus `/replays`. `FAF_REPLAYS_DIR`
/// overrides it (tests, alternate installs).
pub(crate) fn local_replays_dir() -> PathBuf {
    if let Some(dir) = crate::infra::paths::replays_dir() {
        return dir;
    }
    if let Ok(dir) = std::env::var("FAF_REPLAYS_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    let base = if cfg!(windows) {
        std::env::var("ALLUSERSPROFILE").unwrap_or_else(|_| r"C:\ProgramData".to_string())
    } else {
        std::env::var("HOME").unwrap_or_default()
    };
    PathBuf::from(base).join("FAForever").join("replays")
}

fn unix_seconds(time: std::time::SystemTime) -> u32 {
    time.duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs().min(u32::MAX as u64) as u32)
        .unwrap_or_default()
}

fn replay_uid(header: &Value, file_name: &str) -> Option<i32> {
    header
        .get("uid")
        .and_then(Value::as_i64)
        .and_then(|value| i32::try_from(value).ok())
        .or_else(|| {
            let digits: String = file_name.chars().take_while(char::is_ascii_digit).collect();
            digits.parse().ok()
        })
}

fn local_teams(header: &Value) -> Vec<LocalReplayTeam> {
    header
        .get("teams")
        .and_then(Value::as_object)
        .map(|teams| {
            teams
                .iter()
                .filter_map(|(team, players)| {
                    let players: Vec<LocalReplayPlayer> = players
                        .as_array()?
                        .iter()
                        .filter_map(Value::as_str)
                        .map(|name| LocalReplayPlayer {
                            name: name.to_string(),
                            faction: None,
                            rating: None,
                            ai: false,
                            country: None,
                        })
                        .collect();
                    (!players.is_empty()).then(|| LocalReplayTeam {
                        team: team.clone(),
                        players,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The teams as the replay body has them, which is the seating the game was
/// played with.
///
/// Civilian armies are dropped: every map has one or two of them, they are on
/// team 1 with nobody in particular, and they are not players. Everything else
/// is kept, AI included, because an army that was in the game belongs in the
/// list of who was in the game. Teams come out in the engine's own numbering,
/// and the players inside one keep their slot order.
/// The lineup of a replay, from the armies the engine loaded.
///
/// `mission` is a co-op game, where the armies with no client behind them are
/// the script's and not players. Everywhere else they are the AI somebody put
/// in the lobby, which is a participant: a 4v4 against four AI is a game of
/// eight, and the vault, which only knows accounts, is the one that has to
/// show it as a game of four.
fn body_teams(armies: &[LocalBodyArmy], mission: bool) -> Vec<LocalReplayTeam> {
    let mut teams: Vec<LocalReplayTeam> = Vec::new();
    // Spelled as one predicate rather than two negations: clippy rejects the
    // two, and the question this asks is a single one anyway.
    let is_player = |army: &LocalBodyArmy| !(army.civilian || (mission && army.computer));
    for army in armies.iter().filter(|army| is_player(army)) {
        let key = army
            .team
            .map(|team| team.to_string())
            .unwrap_or_else(|| "1".to_string());
        let player = LocalReplayPlayer {
            name: army.name.clone(),
            faction: army.faction,
            rating: army.rating,
            ai: army.computer,
            country: army.country.clone(),
        };
        match teams.iter_mut().find(|team| team.team == key) {
            Some(team) => team.players.push(player),
            None => teams.push(LocalReplayTeam {
                team: key,
                players: vec![player],
            }),
        }
    }
    teams.sort_by(|left, right| {
        let number = |team: &LocalReplayTeam| team.team.parse::<i32>().unwrap_or(i32::MAX);
        number(left).cmp(&number(right))
    });
    teams
}

pub(super) fn local_sim_mods(header: &Value) -> Vec<String> {
    header
        .get("sim_mods")
        .and_then(Value::as_object)
        .map(|mods| {
            mods.values()
                .filter_map(|value| {
                    value
                        .as_str()
                        .or_else(|| value.get("name").and_then(Value::as_str))
                })
                .map(String::from)
                .collect()
        })
        .unwrap_or_default()
}

const LOCAL_REPLAY_BODY_READ_BYTES: usize = 4 * 1024 * 1024;

fn empty_local_replay(
    path: &std::path::Path,
    modified: std::time::SystemTime,
    file_size: u64,
    status: LocalReplayStatus,
    watchable: bool,
) -> LocalReplay {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("replay")
        .to_string();
    let title = path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("Replay")
        .to_string();
    LocalReplay {
        path: path.display().to_string(),
        file_name,
        uid: None,
        map: String::new(),
        mod_name: guess_mod_from_filename(path),
        title,
        recorder: String::new(),
        start_time: None,
        duration_seconds: None,
        modified_time: unix_seconds(modified),
        file_size_bytes: file_size.min(u32::MAX as u64) as u32,
        num_players: 0,
        teams: Vec::new(),
        average_rating: None,
        sim_mods: Vec::new(),
        status,
        watchable,
        game_version: None,
    }
}

/// Read the `.fafreplay` JSON envelope and compact binary body header. Bad and
/// incomplete files remain represented so the UI can explain them rather than
/// silently making files disappear from the archive.
async fn read_local_metadata(
    path: &std::path::Path,
    modified: std::time::SystemTime,
    file_size: u64,
) -> LocalReplay {
    let is_legacy = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("scfareplay"));
    if is_legacy {
        return empty_local_replay(path, modified, file_size, LocalReplayStatus::Legacy, true);
    }

    let mut file = match tokio::fs::File::open(path).await {
        Ok(file) => file,
        Err(_) => {
            return empty_local_replay(path, modified, file_size, LocalReplayStatus::Broken, false)
        }
    };
    let mut buf = vec![0u8; 64 * 1024];
    let n: usize = file.read(&mut buf).await.unwrap_or_default();
    buf.truncate(n);
    let Some(nl) = buf.iter().position(|&byte| byte == b'\n') else {
        return empty_local_replay(path, modified, file_size, LocalReplayStatus::Broken, false);
    };
    let Ok(header) = serde_json::from_slice::<Value>(&buf[..nl]) else {
        return empty_local_replay(path, modified, file_size, LocalReplayStatus::Broken, false);
    };
    let mut body = buf[nl + 1..].to_vec();
    if body.len() < LOCAL_REPLAY_BODY_READ_BYTES {
        let mut remainder = Vec::new();
        let remaining = (LOCAL_REPLAY_BODY_READ_BYTES - body.len()) as u64;
        let _ = file.take(remaining).read_to_end(&mut remainder).await;
        body.extend_from_slice(&remainder);
    }
    let compression = header
        .get("compression")
        .and_then(Value::as_str)
        .unwrap_or("");
    let body_info = local_body_player_stats(&body, compression);
    let playable = playable_body(body_info.as_ref());
    let body_info = body_info.unwrap_or_default();
    // A co-op mission, where the armies with no client behind them belong to
    // the campaign rather than to anybody playing: see [`body_teams`].
    let mission = header
        .get("featured_mod")
        .and_then(Value::as_str)
        .is_some_and(|featured| featured.eq_ignore_ascii_case("coop"));
    // The body's own army table first, and the envelope only when there is no
    // body left to read: see `LocalBodyInfo::armies` for why the envelope
    // cannot be trusted with this.
    let mut teams = body_teams(&body_info.armies, mission);
    let teams_from_body = !teams.is_empty();
    if teams.is_empty() {
        teams = local_teams(&header);
        for team in &mut teams {
            for player in &mut team.players {
                if let Some(stats) = body_info.player_stats.get(&player.name) {
                    player.faction = stats.faction;
                    player.rating = stats.rating;
                    player.country = stats.country.clone();
                }
            }
        }
    }
    let ratings: Vec<i32> = teams
        .iter()
        .filter(|team| team.team != "-1" && team.team != "null")
        .flat_map(|team| &team.players)
        .filter_map(|player| player.rating)
        .collect();
    let average_rating =
        (!ratings.is_empty()).then(|| ratings.iter().sum::<i32>() / ratings.len() as i32);
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("replay.fafreplay")
        .to_string();
    let team_player_count = teams
        .iter()
        .filter(|team| team.team != "-1" && team.team != "null")
        .map(|team| team.players.len() as i32)
        .sum();
    let start_time = header
        .get("launched_at")
        .or_else(|| header.get("game_time"))
        .and_then(Value::as_f64)
        .filter(|value| *value > 0.0)
        .map(|value| value.min(u32::MAX as f64).round() as u32);

    // Both ends or nothing. A recording interrupted before the game ended has
    // no `game_end`, and one this client wrote before the recorder learned the
    // launch time has the two equal; neither is a duration, and a confident
    // "0m 00s" is worse than saying nothing.
    let duration_seconds = header
        .get("game_end")
        .and_then(Value::as_f64)
        .filter(|end| *end > 0.0)
        .zip(start_time.map(f64::from))
        .map(|(end, start)| end - start)
        .filter(|seconds| *seconds > 0.0)
        .map(|seconds| seconds.min(f64::from(i32::MAX)).round() as i32);

    let header_map = header
        .get("mapname")
        .and_then(Value::as_str)
        .filter(|m| !m.is_empty() && !m.eq_ignore_ascii_case("none"));
    let map = body_info
        .map_name
        .or_else(|| header_map.map(str::to_string))
        .unwrap_or_default();

    // The envelope's featured-mod version identifies a mod release, not the
    // SupCom patch. Prefer an explicitly named game version, then the binary
    // replay header used by the Java client.
    let game_version = header
        .get("game_version")
        .and_then(Value::as_i64)
        .and_then(|value| i32::try_from(value).ok())
        .or(body_info.game_version);

    LocalReplay {
        path: path.display().to_string(),
        file_name: file_name.clone(),
        uid: replay_uid(&header, &file_name),
        map,
        mod_name: header
            .get("featured_mod")
            .and_then(Value::as_str)
            .unwrap_or("faf")
            .to_string(),
        title: header
            .get("title")
            .and_then(Value::as_str)
            .filter(|title| !title.is_empty())
            .unwrap_or_else(|| {
                path.file_stem()
                    .and_then(|name| name.to_str())
                    .unwrap_or("Replay")
            })
            .to_string(),
        recorder: header
            .get("recorder")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        start_time,
        duration_seconds,
        modified_time: unix_seconds(modified),
        file_size_bytes: file_size.min(u32::MAX as u64) as u32,
        // The envelope's count is the lobby listing's count, and it is wrong
        // in exactly the games whose teams it also has wrong. When the body
        // named the armies, they are what was in the game.
        num_players: if teams_from_body {
            team_player_count
        } else {
            header
                .get("num_players")
                .and_then(Value::as_i64)
                .and_then(|value| i32::try_from(value).ok())
                .filter(|value| *value >= 0)
                .unwrap_or(team_player_count)
        },
        teams,
        average_rating,
        sim_mods: local_sim_mods(&header),
        // `complete` is the envelope's own claim about how the recording
        // ended, and it is only worth reading once the recording is known to
        // be there: a broken file is not an unfinished game, it is a game that
        // can no longer be watched at all.
        status: if !playable {
            LocalReplayStatus::Broken
        } else if header
            .get("complete")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            LocalReplayStatus::Complete
        } else {
            LocalReplayStatus::Incomplete
        },
        watchable: playable,
        game_version,
    }
}

pub(super) async fn local_metadata_for_path(path: &Path) -> Result<LocalReplay, String> {
    let metadata = tokio::fs::metadata(path)
        .await
        .map_err(|error| format!("could not inspect downloaded replay: {error}"))?;
    let modified = metadata.modified().unwrap_or(std::time::UNIX_EPOCH);
    Ok(read_local_metadata(path, modified, metadata.len()).await)
}

async fn resolve_local_replay_file(dir: &Path, path: &Path) -> Result<PathBuf, String> {
    let canonical_dir = tokio::fs::canonicalize(dir)
        .await
        .map_err(|error| format!("could not resolve replay folder: {error}"))?;
    let canonical_path = tokio::fs::canonicalize(path)
        .await
        .map_err(|error| format!("could not resolve replay file: {error}"))?;
    if canonical_path.parent() != Some(canonical_dir.as_path())
        || !is_replay_file_name(&canonical_path)
    {
        return Err("refusing to access a file outside the replay folder".to_string());
    }
    Ok(canonical_path)
}

/// Resolve a local-library replay for a narrowly scoped desktop-shell action.
/// The canonical parent and extension checks are shared with deletion so the
/// webview cannot use "Show in folder" as a generic filesystem browser.
pub async fn validated_local_replay_path(path: &Path) -> Result<PathBuf, String> {
    resolve_local_replay_file(&local_replays_dir(), path).await
}

pub(super) async fn delete_local_file(
    dir: &std::path::Path,
    path: &std::path::Path,
) -> Result<(), String> {
    let canonical_path = resolve_local_replay_file(dir, path).await?;
    tokio::fs::remove_file(&canonical_path)
        .await
        .map_err(|e| format!("could not delete replay: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infra::replay::test_support::qcompressed_body;

    #[tokio::test]
    async fn list_local_dir_reads_metadata_and_keeps_problem_files_visible() {
        let dir = std::env::temp_dir().join(format!("forge-local-replays-{}", std::process::id()));
        tokio::fs::create_dir_all(&dir).await.unwrap();

        let header = |uid: i32, complete: bool| {
            format!(
                r#"{{"uid":{uid},"complete":{complete},"mapname":"scmp_009","featured_mod":"faf","title":"t{uid}","recorder":"host","launched_at":1700000000,"num_players":2,"teams":{{"1":["host"],"2":["guest"]}},"sim_mods":{{"mod-1":"UI Party"}}}}"#
            )
        };
        let body = qcompressed_body();
        tokio::fs::write(
            dir.join("older.fafreplay"),
            format!("{}\n{body}", header(1, true)),
        )
        .await
        .unwrap();
        // Ensure a distinct, later mtime than the first file.
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        tokio::fs::write(
            dir.join("newer.fafreplay"),
            format!("{}\n{body}", header(2, false)),
        )
        .await
        .unwrap();
        tokio::fs::write(dir.join("corrupt.fafreplay"), b"not even json\nbody")
            .await
            .unwrap();
        // A full description of a game whose recording is gone: what a crash
        // during the write, or a copy that lost its tail, leaves behind.
        tokio::fs::write(
            dir.join("gutted.fafreplay"),
            format!("{}\n", header(3, true)),
        )
        .await
        .unwrap();
        tokio::fs::write(
            dir.join("garbled.fafreplay"),
            format!("{}\nnot a compressed replay body", header(4, false)),
        )
        .await
        .unwrap();
        tokio::fs::write(dir.join("legacy.faf.scfareplay"), b"legacy replay body")
            .await
            .unwrap();

        let replays = list_local_dir(&dir, LOCAL_REPLAY_PAGE_LIMIT)
            .await
            .expect("should list");
        assert_eq!(replays.len(), 6, "every replay-shaped file stays visible");
        let complete = replays.iter().find(|replay| replay.uid == Some(1)).unwrap();
        assert_eq!(complete.status, LocalReplayStatus::Complete);
        assert!(complete.watchable);
        // The body's own scenario, which is more specific than the envelope's
        // `mapname` and is what the archive shows when both are there.
        assert_eq!(complete.map, "SCMP_009");
        assert_eq!(complete.recorder, "host");
        // From the body's army table, not the envelope's listing: two players
        // on two teams, and the map's civilian army left out of both.
        assert_eq!(complete.num_players, 2);
        assert_eq!(complete.teams.len(), 2);
        assert_eq!(
            complete
                .teams
                .iter()
                .map(|team| (
                    team.team.as_str(),
                    team.players
                        .iter()
                        .map(|player| player.name.as_str())
                        .collect::<Vec<_>>()
                ))
                .collect::<Vec<_>>(),
            [("2", vec!["TestPlayer"]), ("3", vec!["Guest"])]
        );
        assert_eq!(complete.sim_mods, vec!["UI Party"]);
        assert_eq!(complete.start_time, Some(1_700_000_000));

        let incomplete = replays.iter().find(|replay| replay.uid == Some(2)).unwrap();
        assert_eq!(incomplete.status, LocalReplayStatus::Incomplete);
        assert!(incomplete.watchable);

        let broken = replays
            .iter()
            .find(|replay| replay.file_name == "corrupt.fafreplay")
            .unwrap();
        assert_eq!(broken.status, LocalReplayStatus::Broken);
        assert!(!broken.watchable);

        // The envelope of each of these parses and describes a played game.
        // Only the body says whether it can still be watched.
        for name in ["gutted.fafreplay", "garbled.fafreplay"] {
            let gutted = replays
                .iter()
                .find(|replay| replay.file_name == name)
                .unwrap_or_else(|| panic!("{name} should be listed"));
            assert_eq!(gutted.status, LocalReplayStatus::Broken, "{name}");
            assert!(!gutted.watchable, "{name}");
        }

        let legacy = replays
            .iter()
            .find(|replay| replay.file_name == "legacy.faf.scfareplay")
            .unwrap();
        assert_eq!(legacy.status, LocalReplayStatus::Legacy);
        assert!(legacy.watchable);
        assert_eq!(legacy.mod_name, "faf");

        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    /// A real archive is thousands of files. Listing only the newest hundred
    /// gave the Local tab three pages of a folder holding three thousand
    /// replays, with nothing saying the rest existed.
    #[tokio::test]
    async fn list_local_dir_returns_every_replay_not_just_the_newest_hundred() {
        let dir = std::env::temp_dir().join(format!("forge-local-all-{}", std::process::id()));
        let _ = tokio::fs::remove_dir_all(&dir).await;
        tokio::fs::create_dir_all(&dir).await.unwrap();
        for index in 0..250 {
            tokio::fs::write(dir.join(format!("{index}.scfareplay")), b"body")
                .await
                .unwrap();
        }

        let replays = list_local_dir(&dir, LOCAL_REPLAY_PAGE_LIMIT).await.unwrap();
        assert_eq!(replays.len(), 250);

        // The limit bounds how many headers are *read*, never how many replays
        // are listed: a smaller limit still returns the whole archive, with the
        // remainder marked as not yet read rather than dropped.
        let bounded = list_local_dir(&dir, 10).await.unwrap();
        assert_eq!(bounded.len(), 250);
        assert_eq!(
            bounded
                .iter()
                .filter(|replay| replay.status == LocalReplayStatus::Unread)
                .count(),
            240
        );

        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn list_local_dir_missing_folder_returns_empty() {
        let dir = std::env::temp_dir().join("forge-local-replays-does-not-exist");
        let replays = list_local_dir(&dir, LOCAL_REPLAY_PAGE_LIMIT)
            .await
            .expect("missing dir is not an error");
        assert!(replays.is_empty());
    }

    /// The contract between the two halves of "record a game locally": what
    /// [`crate::infra::replay_recorder`] writes has to be what this module's
    /// archive listing can read. They were written against the same format and
    /// were still incompatible, because the recorder emitted the bare stream and
    /// everything the list shows comes from the JSON header the stream has none
    /// of. Asserting the pair together is the only thing that catches that.
    #[tokio::test]
    async fn a_recorded_replay_lists_with_its_game_details() {
        let dir = std::env::temp_dir().join(format!("forge-recorded-{}", std::process::id()));
        tokio::fs::create_dir_all(&dir).await.unwrap();

        let metadata = crate::ports::ReplayMetadata {
            uid: 27_619_486,
            recorder: "Nory".into(),
            featured_mod: "faf".into(),
            title: "Turtle bowl".into(),
            map_name: "scmp_009".into(),
            game_type: "custom".into(),
            host: "Nory".into(),
            launched_at: Some(1_700_000_000),
            num_players: 2,
            teams: [
                ("1".to_string(), vec!["Nory".to_string()]),
                ("2".to_string(), vec!["Someone".to_string()]),
            ]
            .into_iter()
            .collect(),
            sim_mods: Default::default(),
            git_sha: None,
            git_short_sha: None,
            signature: None,
            version_name: None,
        };
        // The stream, not a stand-in for one: the listing now asks whether a
        // file still holds a game, and a body that names none is disowned as
        // damaged. Two strings with a fixed-width field after each is what
        // every real one opens with, and the map path belongs to the second
        // string rather than being one of its own.
        let mut body = Vec::new();
        body.extend_from_slice(b"Supreme Commander v1.5.3599\0");
        body.extend_from_slice(b"\r\n\0");
        body.extend_from_slice(b"Replay v1.9\r\n/maps/scmp_009/scmp_009_scenario.lua\0");
        body.extend_from_slice(b"\r\n\x1a\0");
        let file =
            crate::infra::replay_recorder::build_fafreplay(&metadata, body, true, 1_788_000_000.0)
                .unwrap();
        let path = dir.join("27619486-Nory.fafreplay");
        tokio::fs::write(&path, &file).await.unwrap();

        let replays = list_local_dir(&dir, LOCAL_REPLAY_PAGE_LIMIT).await.unwrap();
        let replay = replays.first().expect("the recording should be listed");
        assert_eq!(replay.uid, Some(27_619_486));
        assert_eq!(replay.title, "Turtle bowl");
        assert_eq!(replay.map, "scmp_009");
        assert_eq!(replay.mod_name, "faf");
        assert_eq!(replay.recorder, "Nory");
        assert_eq!(replay.start_time, Some(1_700_000_000));
        assert_eq!(replay.num_players, 2);
        assert_eq!(replay.teams.len(), 2);
        assert_eq!(replay.status, LocalReplayStatus::Complete);

        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    /// Through the port, on a library built for the test alone: it needs no
    /// vault, no install and no environment variable to point it somewhere.
    #[tokio::test]
    async fn delete_local_file_is_scoped_to_the_replay_folder() {
        let root = std::env::temp_dir().join(format!("forge-local-delete-{}", std::process::id()));
        let replay_dir = root.join("replays");
        tokio::fs::create_dir_all(&replay_dir).await.unwrap();
        let replay = replay_dir.join("42.fafreplay");
        let outside = root.join("keep.fafreplay");
        tokio::fs::write(&replay, b"replay").await.unwrap();
        tokio::fs::write(&outside, b"keep").await.unwrap();
        let library = ReplayLibrary::at(replay_dir.clone());

        assert!(library.delete_local(outside.clone()).await.is_err());
        assert!(outside.exists());
        library.delete_local(replay.clone()).await.unwrap();
        assert!(!replay.exists());

        let _ = tokio::fs::remove_dir_all(&root).await;
    }

    #[tokio::test]
    async fn local_replay_resolution_returns_only_direct_replay_children() {
        let directory = tempfile::tempdir().expect("temporary replay directory");
        let replay_dir = directory.path().join("replays");
        let nested_dir = replay_dir.join("nested");
        tokio::fs::create_dir_all(&nested_dir).await.unwrap();
        let replay = replay_dir.join("42.fafreplay");
        let nested = nested_dir.join("43.fafreplay");
        let text = replay_dir.join("notes.txt");
        tokio::fs::write(&replay, b"replay").await.unwrap();
        tokio::fs::write(&nested, b"nested").await.unwrap();
        tokio::fs::write(&text, b"notes").await.unwrap();

        assert_eq!(
            resolve_local_replay_file(&replay_dir, &replay)
                .await
                .unwrap(),
            tokio::fs::canonicalize(&replay).await.unwrap()
        );
        assert!(resolve_local_replay_file(&replay_dir, &nested)
            .await
            .is_err());
        assert!(resolve_local_replay_file(&replay_dir, &text).await.is_err());
    }

    fn army(name: &str, team: i32, civilian: bool) -> LocalBodyArmy {
        LocalBodyArmy {
            name: name.to_string(),
            team: Some(team),
            civilian,
            computer: false,
            faction: Some(2),
            rating: Some(1_500),
            country: None,
        }
    }

    /// An army with no client behind it: an AI in a skirmish, the mission's
    /// own script in a co-op game.
    fn computer(name: &str, team: i32) -> LocalBodyArmy {
        LocalBodyArmy {
            computer: true,
            ..army(name, team, false)
        }
    }

    #[test]
    fn the_replay_body_seats_the_players_the_envelope_gets_wrong() {
        // Taken from a real file: the envelope listed five of the eight who
        // played, split 3-2, because that is how the lobby stood when the
        // recorder sent its launch. The armies are the game.
        let teams = body_teams(
            &[
                army("SpeculariiNoob", 3, false),
                army("Seraphim-Noob", 2, false),
                army("hard_not_to_fart", 3, false),
                army("CumCitron", 2, false),
                army("civilian", 1, true),
            ],
            false,
        );

        assert_eq!(
            teams
                .iter()
                .map(|team| (
                    team.team.as_str(),
                    team.players
                        .iter()
                        .map(|player| player.name.as_str())
                        .collect::<Vec<_>>()
                ))
                .collect::<Vec<_>>(),
            [
                ("2", vec!["Seraphim-Noob", "CumCitron"]),
                ("3", vec!["SpeculariiNoob", "hard_not_to_fart"]),
            ]
        );
        assert_eq!(teams[0].players[0].rating, Some(1_500));
        assert_eq!(teams[0].players[0].faction, Some(2));
    }

    #[test]
    fn a_body_with_nothing_in_it_leaves_the_envelope_to_answer() {
        assert!(body_teams(&[], false).is_empty());
        assert!(body_teams(&[army("civilian", 1, true)], false).is_empty());
    }

    /// A co-op mission's armies are the campaign's, and the campaign is not a
    /// player. Taken from a real file: one player, and `Order`, `QAI`,
    /// `Loyalist` and `OrderNeutral` seated beside them, which listed a solo
    /// mission as a game of five.
    #[test]
    fn a_missions_own_armies_are_not_players() {
        let armies = [
            army("Seraphim-Noob", 1, false),
            computer("Order", 1),
            computer("QAI", 1),
            computer("Loyalist", 1),
            computer("OrderNeutral", 1),
        ];

        let mission = body_teams(&armies, true);
        assert_eq!(mission.len(), 1);
        assert_eq!(
            mission[0]
                .players
                .iter()
                .map(|player| player.name.as_str())
                .collect::<Vec<_>>(),
            ["Seraphim-Noob"]
        );

        // The same armies in a skirmish are the AI somebody added to the
        // lobby, and those are the other half of the game.
        let skirmish = body_teams(&armies, false);
        assert_eq!(skirmish[0].players.len(), 5);
        // And they say so, which is what lets the lineup add them without also
        // adding a renamed person under the name they played with.
        assert_eq!(
            skirmish[0]
                .players
                .iter()
                .map(|player| player.ai)
                .collect::<Vec<_>>(),
            [false, true, true, true, true]
        );
    }
}
