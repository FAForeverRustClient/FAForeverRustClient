//! Co-op: the campaign missions and their community leaderboards.
//!
//! Missions are a *first-class API resource* (`/data/coopMission`), grouped
//! into scenarios (`/data/coopScenario`), with a per-mission leaderboard of
//! fastest completions (`/data/coopResult`). None of that is derivable from
//! the map vault, which is why guessing at it by matching map names against
//! "coop"/"campaign"/"operation": what this client used to do: produced a
//! list that was both incomplete and full of maps that are not missions.
//!
//! Mirrors the Java client's `coop/CoopService` and `CoopController`.

use serde::{Deserialize, Serialize};
use specta::Type;

use super::RequestFailureKind;

/// Which faction's campaign a scenario belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum CoopFaction {
    Uef,
    Cybran,
    Aeon,
    Seraphim,
    #[default]
    Custom,
}

impl CoopFaction {
    /// Parse the API's spelling. Unknown values become [`Self::Custom`]: the
    /// same bucket the Java enum reserves for community campaigns, and the
    /// right home for a faction FAF adds after this ships.
    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "uef" => Self::Uef,
            "cybran" => Self::Cybran,
            "aeon" => Self::Aeon,
            "seraphim" => Self::Seraphim,
            _ => Self::Custom,
        }
    }
}

/// Which game a scenario's missions came from. Java's `CoopType`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum CoopCategory {
    /// Vanilla Supreme Commander.
    Sc,
    /// Forged Alliance.
    Scfa,
    #[default]
    Custom,
}

impl CoopCategory {
    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_uppercase().as_str() {
            "SC" | "0" => Self::Sc,
            "SCFA" | "1" => Self::Scfa,
            _ => Self::Custom,
        }
    }

    pub fn label(&self) -> &'static str {
        match self {
            Self::Sc => "Supreme Commander",
            Self::Scfa => "Forged Alliance",
            Self::Custom => "Custom",
        }
    }
}

/// One playable mission.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CoopMission {
    pub id: i32,
    pub name: String,
    /// Already reduced to plain text: the API stores it as HTML, and the same
    /// reasoning applies as for tournament descriptions (see
    /// `protocol::markup`): third-party markup never enters the state.
    pub description: String,
    pub version: i32,
    pub download_url: String,
    pub thumbnail_url_small: String,
    pub thumbnail_url_large: String,
    /// The map folder the game loads: what a host request must name.
    pub map_folder_name: String,
    /// The scenario this mission belongs to, when the API said so.
    pub scenario_id: Option<i32>,
}

/// A campaign: an ordered run of missions for one faction.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CoopScenario {
    pub id: i32,
    pub name: String,
    pub description: String,
    pub order: i32,
    pub faction: CoopFaction,
    pub category: CoopCategory,
}

/// One completion on the leaderboard.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CoopResult {
    pub id: i32,
    /// 1-based position after de-duplication. Assigned by
    /// [`rank_results`], not by the server.
    pub ranking: i32,
    pub secondary_objectives: bool,
    pub duration_seconds: u32,
    pub player_count: i32,
    /// The team, as logins. Also the de-duplication key.
    pub players: Vec<String>,
    /// The replay to watch, when one was kept.
    pub replay_id: Option<i32>,
    pub played_at: Option<u32>,
}

/// "Any number of players": the leaderboard's default, and the value that
/// omits the `playerCount` filter entirely (Java: `numberOfPlayers > 0`).
pub const ANY_PLAYER_COUNT: i32 = 0;

/// The player-count choices the Java client offers.
pub const PLAYER_COUNT_OPTIONS: [i32; 5] = [ANY_PLAYER_COUNT, 1, 2, 3, 4];

/// Collapse repeat runs by the same team, then number what survives.
///
/// The leaderboard is a *record* board: a team that has beaten a mission forty
/// times should occupy one row with their best time, not forty rows. The
/// server does not do this, so the Java client de-duplicates on the set of
/// player logins and keeps the first occurrence: which is the fastest,
/// because the query sorts by duration ascending.
///
/// This re-sorts rather than trusting the caller, so the rule holds even if the
/// server's ordering changes: ties break on fewer players (a duo beating a
/// four-stack on the same time is the better run), then on id for stability.
pub fn rank_results(mut results: Vec<CoopResult>) -> Vec<CoopResult> {
    results.sort_by(|left, right| {
        left.duration_seconds
            .cmp(&right.duration_seconds)
            .then_with(|| left.player_count.cmp(&right.player_count))
            .then_with(|| left.id.cmp(&right.id))
    });

    let mut seen: Vec<Vec<String>> = Vec::new();
    let mut ranked = Vec::new();
    for mut result in results {
        let mut team = result.players.clone();
        team.sort();
        team.dedup();
        if seen.contains(&team) {
            continue;
        }
        seen.push(team);
        result.ranking = ranked.len() as i32 + 1;
        ranked.push(result);
    }
    ranked
}

/// The missions belonging to one scenario, in the order they are played.
pub fn missions_of(missions: &[CoopMission], scenario_id: i32) -> Vec<&CoopMission> {
    let mut found: Vec<&CoopMission> = missions
        .iter()
        .filter(|mission| mission.scenario_id == Some(scenario_id))
        .collect();
    // `name` carries the mission number in practice ("Operation Ivory Sun 3"),
    // so a plain name sort is the campaign order.
    found.sort_by(|left, right| left.name.cmp(&right.name));
    found
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum CoopStatus {
    #[default]
    Idle,
    Loading,
    Ready,
    Failed {
        reason: String,
        kind: RequestFailureKind,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CoopState {
    pub scenarios: Vec<CoopScenario>,
    pub missions: Vec<CoopMission>,
    pub catalog_status: CoopStatus,
    pub selected_mission_id: Option<i32>,
    /// `0` means any: see [`ANY_PLAYER_COUNT`].
    pub player_count: i32,
    pub leaderboard: Vec<CoopResult>,
    pub leaderboard_status: CoopStatus,
}

impl Default for CoopState {
    fn default() -> Self {
        Self {
            scenarios: Vec::new(),
            missions: Vec::new(),
            catalog_status: CoopStatus::default(),
            selected_mission_id: None,
            player_count: ANY_PLAYER_COUNT,
            leaderboard: Vec::new(),
            leaderboard_status: CoopStatus::default(),
        }
    }
}

impl CoopState {
    pub fn selected_mission(&self) -> Option<&CoopMission> {
        let id = self.selected_mission_id?;
        self.missions.iter().find(|mission| mission.id == id)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum CoopEvent {
    CatalogLoading,
    CatalogLoaded {
        scenarios: Vec<CoopScenario>,
        missions: Vec<CoopMission>,
    },
    CatalogLoadFailed {
        reason: String,
        kind: RequestFailureKind,
    },
    #[serde(rename_all = "camelCase")]
    MissionSelected {
        mission_id: i32,
    },
    #[serde(rename_all = "camelCase")]
    PlayerCountChanged {
        player_count: i32,
    },
    LeaderboardLoading,
    #[serde(rename_all = "camelCase")]
    LeaderboardLoaded {
        mission_id: i32,
        player_count: i32,
        results: Vec<CoopResult>,
    },
    LeaderboardLoadFailed {
        reason: String,
        kind: RequestFailureKind,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum CoopCommand {
    LoadCatalog,
    #[serde(rename_all = "camelCase")]
    SelectMission {
        mission_id: i32,
    },
    #[serde(rename_all = "camelCase")]
    SetPlayerCount {
        player_count: i32,
    },
}

pub fn reduce(state: &mut CoopState, event: &CoopEvent) {
    match event {
        CoopEvent::CatalogLoading => state.catalog_status = CoopStatus::Loading,
        CoopEvent::CatalogLoaded {
            scenarios,
            missions,
        } => {
            state.scenarios = scenarios.clone();
            state.missions = missions.clone();
            state.catalog_status = CoopStatus::Ready;
            // Keep the open mission across a refresh, but never point at one
            // that has gone.
            let still_present = state
                .selected_mission_id
                .is_some_and(|id| missions.iter().any(|mission| mission.id == id));
            if !still_present {
                state.selected_mission_id = missions.first().map(|mission| mission.id);
            }
        }
        CoopEvent::CatalogLoadFailed { reason, kind } => {
            state.catalog_status = CoopStatus::Failed {
                reason: reason.clone(),
                kind: *kind,
            }
        }
        CoopEvent::MissionSelected { mission_id } => {
            state.selected_mission_id = Some(*mission_id);
            // The old mission's times must not sit under the new mission's
            // name while the fresh ones load.
            state.leaderboard.clear();
        }
        CoopEvent::PlayerCountChanged { player_count } => {
            state.player_count = *player_count;
            state.leaderboard.clear();
        }
        CoopEvent::LeaderboardLoading => state.leaderboard_status = CoopStatus::Loading,
        CoopEvent::LeaderboardLoaded {
            mission_id,
            player_count,
            results,
        } => {
            // Drop a reply that no longer matches what is on screen: switching
            // missions quickly can land an older response after a newer one.
            if state.selected_mission_id != Some(*mission_id) || state.player_count != *player_count
            {
                return;
            }
            state.leaderboard = results.clone();
            state.leaderboard_status = CoopStatus::Ready;
        }
        CoopEvent::LeaderboardLoadFailed { reason, kind } => {
            state.leaderboard_status = CoopStatus::Failed {
                reason: reason.clone(),
                kind: *kind,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mission(id: i32, name: &str) -> CoopMission {
        CoopMission {
            id,
            name: name.into(),
            description: String::new(),
            version: 1,
            download_url: String::new(),
            thumbnail_url_small: String::new(),
            thumbnail_url_large: String::new(),
            map_folder_name: format!("scmp_coop_{id}"),
            scenario_id: Some(1),
        }
    }

    fn result(id: i32, seconds: u32, players: &[&str]) -> CoopResult {
        CoopResult {
            id,
            ranking: 0,
            secondary_objectives: false,
            duration_seconds: seconds,
            player_count: players.len() as i32,
            players: players.iter().map(|p| p.to_string()).collect(),
            replay_id: None,
            played_at: None,
        }
    }

    #[test]
    fn a_team_appears_once_with_their_best_time() {
        // The whole point of the board. Without this, one dedicated duo fills
        // every row and nobody else is visible.
        let ranked = rank_results(vec![
            result(1, 900, &["Ada", "Bob"]),
            result(2, 600, &["Ada", "Bob"]),
            result(3, 700, &["Cid", "Dee"]),
        ]);
        assert_eq!(ranked.len(), 2);
        assert_eq!(ranked[0].duration_seconds, 600);
        assert_eq!(ranked[0].players, vec!["Ada", "Bob"]);
        assert_eq!(ranked[1].duration_seconds, 700);
    }

    #[test]
    fn the_team_is_matched_regardless_of_listed_order() {
        // The server lists players per team; the same pair can arrive in
        // either order and must still be one team.
        let ranked = rank_results(vec![
            result(1, 600, &["Ada", "Bob"]),
            result(2, 900, &["Bob", "Ada"]),
        ]);
        assert_eq!(ranked.len(), 1);
    }

    #[test]
    fn rankings_are_dense_and_start_at_one() {
        let ranked = rank_results(vec![
            result(1, 800, &["Cid"]),
            result(2, 600, &["Ada"]),
            result(3, 700, &["Bob"]),
        ]);
        assert_eq!(
            ranked.iter().map(|r| r.ranking).collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        assert_eq!(ranked[0].players, vec!["Ada"], "fastest first");
    }

    #[test]
    fn a_tie_is_broken_by_the_smaller_team() {
        // Same time with fewer commanders is the better run.
        let ranked = rank_results(vec![
            result(1, 600, &["Ada", "Bob", "Cid", "Dee"]),
            result(2, 600, &["Eve", "Fay"]),
        ]);
        assert_eq!(ranked[0].player_count, 2);
    }

    #[test]
    fn an_unsorted_response_is_still_ranked_correctly() {
        // Does not trust the server's ordering: the dedup keeps whichever row
        // comes first, so sorting has to happen before it, not after.
        let ranked = rank_results(vec![
            result(1, 900, &["Ada"]),
            result(2, 300, &["Ada"]),
            result(3, 600, &["Ada"]),
        ]);
        assert_eq!(ranked.len(), 1);
        assert_eq!(ranked[0].duration_seconds, 300);
    }

    #[test]
    fn an_empty_board_ranks_to_nothing() {
        assert!(rank_results(Vec::new()).is_empty());
    }

    #[test]
    fn factions_and_categories_fall_back_to_custom() {
        assert_eq!(CoopFaction::parse("UEF"), CoopFaction::Uef);
        assert_eq!(CoopFaction::parse("  cybran "), CoopFaction::Cybran);
        assert_eq!(CoopFaction::parse("nomads"), CoopFaction::Custom);
        assert_eq!(CoopCategory::parse("scfa"), CoopCategory::Scfa);
        assert_eq!(CoopCategory::parse("SC"), CoopCategory::Sc);
        assert_eq!(CoopCategory::parse("anything"), CoopCategory::Custom);
    }

    #[test]
    fn missions_are_grouped_by_scenario_in_campaign_order() {
        let missions = vec![
            CoopMission {
                scenario_id: Some(2),
                ..mission(9, "Other campaign 1")
            },
            mission(3, "Ivory Sun 3"),
            mission(1, "Ivory Sun 1"),
            mission(2, "Ivory Sun 2"),
        ];
        let found = missions_of(&missions, 1);
        assert_eq!(
            found.iter().map(|m| m.name.as_str()).collect::<Vec<_>>(),
            vec!["Ivory Sun 1", "Ivory Sun 2", "Ivory Sun 3"]
        );
    }

    #[test]
    fn the_first_mission_opens_on_the_first_load() {
        let mut state = CoopState::default();
        assert_eq!(state.player_count, ANY_PLAYER_COUNT);

        reduce(
            &mut state,
            &CoopEvent::CatalogLoaded {
                scenarios: Vec::new(),
                missions: vec![mission(7, "A"), mission(8, "B")],
            },
        );
        assert_eq!(state.selected_mission_id, Some(7));
        assert_eq!(state.catalog_status, CoopStatus::Ready);
    }

    #[test]
    fn refreshing_keeps_the_open_mission() {
        let mut state = CoopState {
            selected_mission_id: Some(8),
            ..CoopState::default()
        };
        reduce(
            &mut state,
            &CoopEvent::CatalogLoaded {
                scenarios: Vec::new(),
                missions: vec![mission(7, "A"), mission(8, "B")],
            },
        );
        assert_eq!(state.selected_mission_id, Some(8));
    }

    #[test]
    fn changing_mission_or_player_count_clears_the_old_times() {
        // Otherwise the previous mission's record sits under the new mission's
        // name for as long as the request takes.
        let mut state = CoopState {
            missions: vec![mission(7, "A"), mission(8, "B")],
            selected_mission_id: Some(7),
            leaderboard: vec![result(1, 600, &["Ada"])],
            ..CoopState::default()
        };

        reduce(&mut state, &CoopEvent::MissionSelected { mission_id: 8 });
        assert!(state.leaderboard.is_empty());

        state.leaderboard = vec![result(1, 600, &["Ada"])];
        reduce(
            &mut state,
            &CoopEvent::PlayerCountChanged { player_count: 2 },
        );
        assert!(state.leaderboard.is_empty());
    }

    #[test]
    fn a_stale_leaderboard_reply_is_dropped() {
        // Clicking through missions faster than the API answers must not leave
        // another mission's times on screen.
        let mut state = CoopState {
            missions: vec![mission(7, "A"), mission(8, "B")],
            selected_mission_id: Some(8),
            player_count: ANY_PLAYER_COUNT,
            ..CoopState::default()
        };

        reduce(
            &mut state,
            &CoopEvent::LeaderboardLoaded {
                mission_id: 7,
                player_count: ANY_PLAYER_COUNT,
                results: vec![result(1, 600, &["Ada"])],
            },
        );
        assert!(state.leaderboard.is_empty(), "wrong mission");

        reduce(
            &mut state,
            &CoopEvent::LeaderboardLoaded {
                mission_id: 8,
                player_count: 4,
                results: vec![result(1, 600, &["Ada"])],
            },
        );
        assert!(state.leaderboard.is_empty(), "wrong player count");

        reduce(
            &mut state,
            &CoopEvent::LeaderboardLoaded {
                mission_id: 8,
                player_count: ANY_PLAYER_COUNT,
                results: vec![result(1, 600, &["Ada"])],
            },
        );
        assert_eq!(state.leaderboard.len(), 1);
        assert_eq!(state.leaderboard_status, CoopStatus::Ready);
    }

    #[test]
    fn the_selected_mission_is_resolvable() {
        let state = CoopState {
            missions: vec![mission(7, "A"), mission(8, "B")],
            selected_mission_id: Some(8),
            ..CoopState::default()
        };
        assert_eq!(state.selected_mission().map(|m| m.id), Some(8));

        let none = CoopState {
            selected_mission_id: Some(99),
            ..state
        };
        assert_eq!(none.selected_mission(), None);
    }

    #[test]
    fn a_load_failure_keeps_the_recovery_category() {
        let mut state = CoopState::default();
        reduce(
            &mut state,
            &CoopEvent::CatalogLoadFailed {
                reason: "sign in again".into(),
                kind: RequestFailureKind::Unauthorized,
            },
        );
        assert_eq!(
            state.catalog_status,
            CoopStatus::Failed {
                reason: "sign in again".into(),
                kind: RequestFailureKind::Unauthorized,
            }
        );
    }
}
