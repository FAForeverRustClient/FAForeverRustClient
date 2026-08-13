//! Leaderboard slice — two parallel FAF ranking systems, mirrored from the
//! two reference clients:
//!
//! - **Ladder brackets** (1v1/2v2/3v3/4v4): the league/season/division
//!   system (mirrors the Java client's `theme/leaderboard/` views). Players
//!   are placed into a league, each league runs seasons, and within a
//!   season each player has a `score` and lands in a division/subdivision
//!   (Bronze III, Gold I, …). Also carries the player's underlying rating
//!   for that game mode (from the flat rating system below).
//! - **Global** (and, if ever surfaced, other non-divisional categories):
//!   a flat rating list with no divisions (mirrors the Python client's
//!   `LeaderboardWidget`/`LeaderboardRatingApiConnector`).
//!
//! Both funnel into the same [`LeaderboardEntry`] shape; fields that don't
//! apply to a given system (`score`/`division` for global, none missing for
//! ladder entries) are `None`.

use serde::{Deserialize, Serialize};
use specta::Type;

/// One ladder bracket, as listed from the FAF Data API (`GET /data/league`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct League {
    pub id: i32,
    /// e.g. `"ladder1v1"` — shown as-is; this client has no i18n table to
    /// resolve a display name from (same pragmatic choice already made for
    /// mod technical names in the replay vault).
    pub technical_name: String,
}

/// One row in a rankings table — either a ladder bracket's active-season
/// entry or a global-rating entry (see the module docs for which fields
/// apply to which).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LeaderboardEntry {
    /// Computed client-side from sort order — not an API field.
    pub rank: i32,
    pub player_name: String,
    /// League placement score. `None` for global-rating entries, which
    /// have no league/season concept.
    pub score: Option<i32>,
    /// The player's underlying TrueSkill-derived rating for this game
    /// mode — present for both ladder and global entries.
    pub rating: Option<i32>,
    pub games_played: i32,
    /// e.g. `"Bronze III"`. `None` for global-rating entries (no
    /// divisions there), or if a ladder player has none yet (still in
    /// placement games).
    pub division: Option<String>,
    /// `divisionIndex * 1000 + subdivisionIndex` — higher is a higher-tier
    /// division. A separate sortable field from `division` (the display
    /// string) so the frontend can put the highest division first without
    /// parsing/guessing an order out of `nameKey` text.
    pub division_order: Option<i32>,
}

/// Status of a leagues/entries/global fetch (mirrors
/// [`crate::state::MapListStatus`] — kept local since these load
/// independently).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum LeaderboardStatus {
    #[default]
    Idle,
    Loading,
    Ready,
    Failed { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LeaderboardState {
    pub leagues: Vec<League>,
    pub leagues_status: LeaderboardStatus,
    pub selected_league_id: Option<i32>,
    pub entries: Vec<LeaderboardEntry>,
    pub entries_status: LeaderboardStatus,
    pub global_entries: Vec<LeaderboardEntry>,
    pub global_status: LeaderboardStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum LeaderboardEvent {
    LeaguesLoading,
    LeaguesLoaded { leagues: Vec<League> },
    LeaguesLoadFailed { reason: String },
    #[serde(rename_all = "camelCase")]
    EntriesLoading { league_id: i32 },
    #[serde(rename_all = "camelCase")]
    EntriesLoaded { league_id: i32, entries: Vec<LeaderboardEntry> },
    EntriesLoadFailed { reason: String },
    GlobalLoading,
    GlobalLoaded { entries: Vec<LeaderboardEntry> },
    GlobalLoadFailed { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum LeaderboardCommand {
    LoadLeagues,
    #[serde(rename_all = "camelCase")]
    SelectLeague { league_id: i32 },
    LoadGlobal,
}

pub fn reduce(state: &mut LeaderboardState, event: &LeaderboardEvent) {
    match event {
        LeaderboardEvent::LeaguesLoading => state.leagues_status = LeaderboardStatus::Loading,
        LeaderboardEvent::LeaguesLoaded { leagues } => {
            state.leagues = leagues.clone();
            state.leagues_status = LeaderboardStatus::Ready;
        }
        LeaderboardEvent::LeaguesLoadFailed { reason } => {
            state.leagues_status = LeaderboardStatus::Failed {
                reason: reason.clone(),
            }
        }
        LeaderboardEvent::EntriesLoading { league_id } => {
            state.selected_league_id = Some(*league_id);
            state.entries_status = LeaderboardStatus::Loading;
        }
        LeaderboardEvent::EntriesLoaded { league_id, entries } => {
            state.selected_league_id = Some(*league_id);
            state.entries = entries.clone();
            state.entries_status = LeaderboardStatus::Ready;
        }
        LeaderboardEvent::EntriesLoadFailed { reason } => {
            state.entries_status = LeaderboardStatus::Failed {
                reason: reason.clone(),
            }
        }
        LeaderboardEvent::GlobalLoading => state.global_status = LeaderboardStatus::Loading,
        LeaderboardEvent::GlobalLoaded { entries } => {
            state.global_entries = entries.clone();
            state.global_status = LeaderboardStatus::Ready;
        }
        LeaderboardEvent::GlobalLoadFailed { reason } => {
            state.global_status = LeaderboardStatus::Failed {
                reason: reason.clone(),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn league(id: i32) -> League {
        League {
            id,
            technical_name: "ladder1v1".into(),
        }
    }

    fn entry(rank: i32, name: &str) -> LeaderboardEntry {
        LeaderboardEntry {
            rank,
            player_name: name.into(),
            score: Some(1500),
            rating: Some(1200),
            games_played: 42,
            division: Some("Gold I".into()),
            division_order: Some(5001),
        }
    }

    #[test]
    fn leagues_loading_then_loaded() {
        let mut s = LeaderboardState::default();
        assert_eq!(s.leagues_status, LeaderboardStatus::Idle);
        reduce(&mut s, &LeaderboardEvent::LeaguesLoading);
        assert_eq!(s.leagues_status, LeaderboardStatus::Loading);
        reduce(
            &mut s,
            &LeaderboardEvent::LeaguesLoaded {
                leagues: vec![league(1)],
            },
        );
        assert_eq!(s.leagues_status, LeaderboardStatus::Ready);
        assert_eq!(s.leagues.len(), 1);
    }

    #[test]
    fn leagues_load_failure_records_reason() {
        let mut s = LeaderboardState::default();
        reduce(
            &mut s,
            &LeaderboardEvent::LeaguesLoadFailed {
                reason: "offline".into(),
            },
        );
        assert_eq!(
            s.leagues_status,
            LeaderboardStatus::Failed {
                reason: "offline".into()
            }
        );
    }

    #[test]
    fn entries_loading_then_loaded_tracks_selected_league() {
        let mut s = LeaderboardState::default();
        reduce(&mut s, &LeaderboardEvent::EntriesLoading { league_id: 7 });
        assert_eq!(s.entries_status, LeaderboardStatus::Loading);
        assert_eq!(s.selected_league_id, Some(7));
        reduce(
            &mut s,
            &LeaderboardEvent::EntriesLoaded {
                league_id: 7,
                entries: vec![entry(1, "Seraphim-Noob")],
            },
        );
        assert_eq!(s.entries_status, LeaderboardStatus::Ready);
        assert_eq!(s.entries.len(), 1);
        assert_eq!(s.selected_league_id, Some(7));
    }

    #[test]
    fn entries_load_failure_records_reason() {
        let mut s = LeaderboardState::default();
        reduce(
            &mut s,
            &LeaderboardEvent::EntriesLoadFailed {
                reason: "no active season".into(),
            },
        );
        assert_eq!(
            s.entries_status,
            LeaderboardStatus::Failed {
                reason: "no active season".into()
            }
        );
    }

    #[test]
    fn global_loading_then_loaded() {
        let mut s = LeaderboardState::default();
        reduce(&mut s, &LeaderboardEvent::GlobalLoading);
        assert_eq!(s.global_status, LeaderboardStatus::Loading);
        reduce(
            &mut s,
            &LeaderboardEvent::GlobalLoaded {
                entries: vec![entry(1, "Seraphim-Noob")],
            },
        );
        assert_eq!(s.global_status, LeaderboardStatus::Ready);
        assert_eq!(s.global_entries.len(), 1);
    }

    #[test]
    fn global_load_failure_records_reason() {
        let mut s = LeaderboardState::default();
        reduce(
            &mut s,
            &LeaderboardEvent::GlobalLoadFailed {
                reason: "offline".into(),
            },
        );
        assert_eq!(
            s.global_status,
            LeaderboardStatus::Failed {
                reason: "offline".into()
            }
        );
    }
}
