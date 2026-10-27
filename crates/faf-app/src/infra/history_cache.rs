//! A player's scanned game history, kept between runs (issue 606).
//!
//! The full scan behind the profile's Maps, Results and Statistics tabs walks
//! the player's whole history, seventy-odd pages of the API for a long one,
//! and it used to do that again every time the profile was opened. The games
//! it read are kept here instead, per player, so the next scan only reads the
//! pages newer than what is already known and stops at the first game it has
//! seen before: `faftracker`'s `player-cache.js` does the same for the same
//! reason.
//!
//! Only settled games are kept. A game that ended in the last two days may
//! still change under the API: its rating journal is written after the game,
//! and a validity can be corrected. Those are read again on every scan, which
//! costs a page and keeps the record from freezing a game in a state it was
//! about to leave. Rows are stored after the outcome rules have run, so a
//! change to those rules bumps [`SCHEMA`] and every cache starts over.
//!
//! A cache is disposable: unreadable, from another API, or of another schema,
//! it is ignored and the scan reads everything, as it always did.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use faf_domain::protocol::game_outcome::Outcome;
use faf_domain::state::PlayedGame;
use serde::{Deserialize, Serialize};

/// Bumped whenever what a stored row means changes: the outcome rules in
/// `game_outcome`, or how `parse_history_games` folds a game.
const SCHEMA: u32 = 2;

/// How long after it was played a game is taken as settled.
const SETTLE_HOURS: i64 = 48;

/// Far above any real history (thirty thousand games is a few megabytes), and
/// a bound on what a damaged file can make the client read.
const MAX_JSON_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    schema: u32,
    api_base: String,
    player_id: i32,
    games: Vec<StoredGame>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredGame {
    id: i32,
    map: String,
    folder: String,
    outcome: Outcome,
    rating_moved: bool,
    ladder: bool,
    played_at: String,
    queue: String,
    rating_delta: Option<f64>,
    started_at: String,
    minutes: i32,
    faction: Option<i32>,
    teammates: Vec<String>,
    opponents: Vec<String>,
}

impl From<&PlayedGame> for StoredGame {
    fn from(game: &PlayedGame) -> Self {
        Self {
            id: game.game_id,
            map: game.map.clone(),
            folder: game.map_folder.clone(),
            outcome: game.outcome,
            rating_moved: game.rating_moved,
            ladder: game.ladder,
            played_at: game.played_at.clone(),
            queue: game.queue.clone(),
            rating_delta: game.rating_delta,
            started_at: game.started_at.clone(),
            minutes: game.duration_minutes,
            faction: game.faction,
            teammates: game.teammates.clone(),
            opponents: game.opponents.clone(),
        }
    }
}

impl From<StoredGame> for PlayedGame {
    fn from(game: StoredGame) -> Self {
        Self {
            game_id: game.id,
            map: game.map,
            map_folder: game.folder,
            outcome: game.outcome,
            rating_moved: game.rating_moved,
            ladder: game.ladder,
            played_at: game.played_at,
            queue: game.queue,
            rating_delta: game.rating_delta,
            started_at: game.started_at,
            duration_minutes: game.minutes,
            faction: game.faction,
            teammates: game.teammates,
            opponents: game.opponents,
        }
    }
}

fn path(player_id: i32) -> Result<PathBuf, String> {
    Ok(super::cache_dir()?
        .join("player-history")
        .join(format!("{player_id}.json")))
}

/// The settled games known for `player_id`, newest first; none when there is
/// no usable cache.
pub(crate) fn load(api_base: &str, player_id: i32) -> Vec<PlayedGame> {
    match path(player_id) {
        Ok(path) => load_at(&path, api_base, player_id),
        Err(_) => Vec::new(),
    }
}

fn load_at(path: &Path, api_base: &str, player_id: i32) -> Vec<PlayedGame> {
    let too_large = std::fs::metadata(path).is_ok_and(|metadata| metadata.len() > MAX_JSON_BYTES);
    if too_large {
        return Vec::new();
    }
    let Ok(bytes) = std::fs::read(path) else {
        return Vec::new();
    };
    match serde_json::from_slice::<Stored>(&bytes) {
        Ok(stored)
            if stored.schema == SCHEMA
                && stored.api_base == api_base
                && stored.player_id == player_id =>
        {
            stored.games.into_iter().map(PlayedGame::from).collect()
        }
        _ => Vec::new(),
    }
}

/// Keep the settled games of a finished scan for the next one. A failure only
/// costs the next scan its shortcut, so it is logged and nothing more.
pub(crate) fn store(api_base: &str, player_id: i32, games: &[PlayedGame], now: DateTime<Utc>) {
    let Ok(path) = path(player_id) else {
        return;
    };
    if let Err(error) = store_at(&path, api_base, player_id, games, now) {
        tracing::warn!(%error, player_id, "could not keep a player's game history for the next scan");
    }
}

fn store_at(
    path: &Path,
    api_base: &str,
    player_id: i32,
    games: &[PlayedGame],
    now: DateTime<Utc>,
) -> Result<(), String> {
    let stored = Stored {
        schema: SCHEMA,
        api_base: api_base.to_string(),
        player_id,
        games: games
            .iter()
            .filter(|game| settled(game, now))
            .map(StoredGame::from)
            .collect(),
    };
    let bytes = serde_json::to_vec(&stored).map_err(|error| error.to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    super::settings_file::write_atomically(path, &bytes).map_err(|error| error.to_string())
}

/// Whether a game is old enough that the API will not change it any more. A
/// game with no readable date is never settled, so it is always read again.
fn settled(game: &PlayedGame, now: DateTime<Utc>) -> bool {
    DateTime::parse_from_rfc3339(&game.played_at).is_ok_and(|played| {
        now.signed_duration_since(played.with_timezone(&Utc))
            >= chrono::Duration::hours(SETTLE_HOURS)
    })
}

/// The ids of the cached games, for the scan to stop at.
pub(crate) fn ids(games: &[PlayedGame]) -> HashSet<i32> {
    games.iter().map(|game| game.game_id).collect()
}

/// The pages just read, newest first, then every cached game they did not
/// read again. A game in both is the fresh read's.
pub(crate) fn merge(fresh: Vec<PlayedGame>, cached: Vec<PlayedGame>) -> Vec<PlayedGame> {
    let seen = ids(&fresh);
    let mut games = fresh;
    games.extend(
        cached
            .into_iter()
            .filter(|game| !seen.contains(&game.game_id)),
    );
    games
}

#[cfg(test)]
mod tests {
    use super::*;

    fn game(id: i32, played_at: &str) -> PlayedGame {
        PlayedGame {
            game_id: id,
            map: "Seton's Clutch".into(),
            map_folder: "scmp_009.v0003".into(),
            outcome: Outcome::Win,
            rating_moved: true,
            ladder: false,
            played_at: played_at.into(),
            queue: "global".into(),
            rating_delta: Some(12.5),
            started_at: played_at.into(),
            duration_minutes: 21,
            faction: Some(3),
            teammates: vec!["Ally".into()],
            opponents: vec!["Foe".into()],
        }
    }

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-10-27T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn keeps_only_the_settled_games_and_reads_them_back() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("player-history").join("7.json");
        let games = [
            // Yesterday: its rating journal may still be on its way.
            game(3, "2026-10-26T20:00:00Z"),
            game(2, "2026-10-20T20:00:00Z"),
            // No date at all: never taken as settled.
            game(1, ""),
        ];
        store_at(&path, "https://api", 7, &games, now()).unwrap();
        let read: Vec<i32> = load_at(&path, "https://api", 7)
            .iter()
            .map(|game| game.game_id)
            .collect();
        assert_eq!(read, [2]);
        assert_eq!(load_at(&path, "https://api", 7)[0], games[1]);
    }

    #[test]
    fn a_cache_for_another_api_or_player_is_not_used() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("7.json");
        store_at(
            &path,
            "https://api",
            7,
            &[game(2, "2026-10-01T00:00:00Z")],
            now(),
        )
        .unwrap();
        assert!(load_at(&path, "https://test-api", 7).is_empty());
        assert!(load_at(&path, "https://api", 8).is_empty());
        std::fs::write(&path, b"not json").unwrap();
        assert!(load_at(&path, "https://api", 7).is_empty());
    }

    #[test]
    fn a_fresh_read_wins_over_the_cached_copy() {
        let fresh = vec![
            game(5, "2026-10-27T10:00:00Z"),
            game(4, "2026-10-26T10:00:00Z"),
        ];
        let mut stale = game(4, "2026-10-26T10:00:00Z");
        stale.outcome = Outcome::Unknown;
        let cached = vec![stale, game(3, "2026-10-20T10:00:00Z")];
        let merged = merge(fresh, cached);
        let ids: Vec<i32> = merged.iter().map(|game| game.game_id).collect();
        assert_eq!(ids, [5, 4, 3]);
        assert_eq!(merged[1].outcome, Outcome::Win);
    }
}
