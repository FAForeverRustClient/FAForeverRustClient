//! Player investigation: the combined Python player-card and Java user-info feature.

use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PlayerCardStatus {
    #[default]
    Idle,
    Loading,
    Ready,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum RatingHistoryPeriod {
    Day,
    Week,
    #[default]
    Month,
    Year,
    All,
}

/// A player as a picker row or a list entry needs them.
///
/// Deliberately much smaller than [`PlayerCardProfile`]: this is what comes
/// back when searching for someone to enter into a tournament, or when
/// resolving a list of names, and both routinely return dozens at a time. The
/// full profile is four requests; this is one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlayerSummary {
    pub id: i32,
    pub login: String,
    /// Empty when the player has no avatar selected.
    pub avatar_url: String,
    pub country: String,
    /// The number a signup post means by "rating". Absent for an account that
    /// has never been rated.
    pub global_rating: Option<i32>,
    pub ladder_rating: Option<i32>,
}

impl PlayerSummary {
    /// The rating to sort and display by, preferring the global one.
    pub fn headline_rating(&self) -> Option<i32> {
        self.global_rating.or(self.ladder_rating)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlayerAvatar {
    pub url: String,
    pub tooltip: String,
    pub selected: bool,
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlayerNameRecord {
    pub name: String,
    pub change_time: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClanMember {
    pub player_id: i32,
    pub login: String,
    pub joined_at: String,
    pub account_created_at: String,
    pub last_seen_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlayerClan {
    pub id: String,
    pub name: String,
    pub tag: String,
    pub description: String,
    pub website_url: String,
    pub requires_invitation: bool,
    pub created_at: String,
    pub joined_at: String,
    pub leader: String,
    pub founder: String,
    pub members: Vec<ClanMember>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlayerRatingSummary {
    pub leaderboard_id: i32,
    pub technical_name: String,
    pub name: String,
    pub rating: i32,
    pub mean: f64,
    pub deviation: f64,
    pub games_played: i32,
    pub won_games: i32,
    pub update_time: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlayerLeaguePlacement {
    pub leaderboard: String,
    pub season: String,
    pub division: String,
    pub score: i32,
    pub games_played: i32,
    pub image_url: String,
}

/// The small account projection used while preparing a matchmaker search.
///
/// Unlike [`PlayerCardProfile`], this deliberately omits name history,
/// achievements, event statistics and clan membership details. Opening the
/// Matchmaker tab should not download an entire investigation profile merely
/// to show the signed-in player's identity, ratings and active placement.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MatchmakerPlayerProfile {
    pub player_id: i32,
    pub login: String,
    pub country: String,
    pub clan_tag: String,
    pub avatar_url: String,
    pub avatar_tooltip: String,
    pub games_played: i32,
    pub ratings: Vec<PlayerRatingSummary>,
    pub league_placements: Vec<PlayerLeaguePlacement>,
    /// Non-fatal rating or league endpoint failures.
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlayerEventCount {
    pub event_id: String,
    pub count: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PlayerAchievementState {
    Locked,
    Unlocked,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlayerAchievement {
    pub id: String,
    pub name: String,
    pub description: String,
    pub experience_points: i32,
    pub incremental: bool,
    pub total_steps: Option<i32>,
    pub current_steps: i32,
    pub state: PlayerAchievementState,
    pub revealed_icon_url: String,
    pub unlocked_icon_url: String,
    pub unlockers_count: Option<i32>,
    pub unlockers_percent: Option<f64>,
    pub updated_at: String,
    pub order: i32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlayerCardProfile {
    pub player_id: i32,
    pub login: String,
    pub country: String,
    pub registered_at: String,
    pub last_seen_at: String,
    pub user_agent: String,
    pub avatars: Vec<PlayerAvatar>,
    pub names: Vec<PlayerNameRecord>,
    pub clan: Option<PlayerClan>,
    pub ratings: Vec<PlayerRatingSummary>,
    pub league_placements: Vec<PlayerLeaguePlacement>,
    pub events: Vec<PlayerEventCount>,
    pub achievements: Vec<PlayerAchievement>,
    /// Non-fatal API section failures. Identity still loads and the UI explains omissions.
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RatingHistoryQuery {
    pub player_id: i32,
    pub leaderboard_id: i32,
    pub leaderboard: String,
    pub period: RatingHistoryPeriod,
    pub page: i32,
    pub page_size: i32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RatingHistoryPoint {
    pub timestamp: String,
    pub rating: f64,
    pub mean: f64,
    pub deviation: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RatingHistoryPage {
    pub points: Vec<RatingHistoryPoint>,
    /// Python-client-compatible all-time maximum, resolved independently of paging.
    pub maximum: Option<RatingHistoryPoint>,
    pub page: i32,
    pub total_pages: i32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlayerCardState {
    pub open: bool,
    pub requested_login: String,
    pub profile: Option<PlayerCardProfile>,
    pub profile_status: PlayerCardStatus,
    pub profile_error: String,
    pub history_query: Option<RatingHistoryQuery>,
    pub history: Vec<RatingHistoryPoint>,
    pub history_maximum: Option<RatingHistoryPoint>,
    pub history_page: i32,
    pub history_total_pages: i32,
    pub history_status: PlayerCardStatus,
    pub history_error: String,
    pub matchmaker_profile: Option<MatchmakerPlayerProfile>,
    pub matchmaker_profile_status: PlayerCardStatus,
    pub matchmaker_profile_error: String,
}

impl Default for PlayerCardState {
    fn default() -> Self {
        Self {
            open: false,
            requested_login: String::new(),
            profile: None,
            profile_status: PlayerCardStatus::default(),
            profile_error: String::new(),
            history_query: None,
            history: Vec::new(),
            history_maximum: None,
            history_page: 0,
            // Not the derived `0`. Every reducer arm that writes this clamps
            // with `.max(1)`, so "zero pages" is a state the code never
            // produces and the pagination UI should not have to render. The
            // frontend's initial state already assumed 1; this makes the two
            // agree at the source rather than by coincidence.
            history_total_pages: 1,
            history_status: PlayerCardStatus::default(),
            history_error: String::new(),
            matchmaker_profile: None,
            matchmaker_profile_status: PlayerCardStatus::default(),
            matchmaker_profile_error: String::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum PlayerCardCommand {
    #[serde(rename_all = "camelCase")]
    Open {
        player_id: Option<i32>,
        login: String,
    },
    Close,
    #[serde(rename_all = "camelCase")]
    LoadHistory {
        query: RatingHistoryQuery,
        append: bool,
    },
    #[serde(rename_all = "camelCase")]
    LoadAllHistory {
        query: RatingHistoryQuery,
    },
    #[serde(rename_all = "camelCase")]
    LoadMatchmakerProfile {
        player_id: i32,
        login: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum PlayerCardEvent {
    #[serde(rename_all = "camelCase")]
    Loading {
        login: String,
    },
    #[serde(rename_all = "camelCase")]
    Loaded {
        profile: Box<PlayerCardProfile>,
    },
    #[serde(rename_all = "camelCase")]
    LoadFailed {
        reason: String,
    },
    Closed,
    #[serde(rename_all = "camelCase")]
    HistoryLoading {
        query: RatingHistoryQuery,
        append: bool,
    },
    #[serde(rename_all = "camelCase")]
    HistoryLoaded {
        query: RatingHistoryQuery,
        page: RatingHistoryPage,
        append: bool,
    },
    #[serde(rename_all = "camelCase")]
    HistoryLoadFailed {
        reason: String,
    },
    /// Optimistic confirmation of the authenticated player's lobby avatar
    /// selection. The lobby command has no acknowledgement, so both reference
    /// clients update their own profile immediately after the send succeeds.
    #[serde(rename_all = "camelCase")]
    AvatarSelected {
        player_id: i32,
        url: Option<String>,
        tooltip: String,
    },
    #[serde(rename_all = "camelCase")]
    MatchmakerProfileLoading {
        player_id: i32,
    },
    #[serde(rename_all = "camelCase")]
    MatchmakerProfileLoaded {
        profile: Box<MatchmakerPlayerProfile>,
    },
    #[serde(rename_all = "camelCase")]
    MatchmakerProfileLoadFailed {
        player_id: i32,
        reason: String,
    },
}

pub fn reduce(state: &mut PlayerCardState, event: &PlayerCardEvent) {
    match event {
        PlayerCardEvent::Loading { login } => {
            state.open = true;
            state.requested_login = login.clone();
            state.profile = None;
            state.profile_status = PlayerCardStatus::Loading;
            state.profile_error.clear();
            state.history_query = None;
            state.history.clear();
            state.history_status = PlayerCardStatus::Idle;
        }
        PlayerCardEvent::Loaded { profile } => {
            state.requested_login = profile.login.clone();
            state.profile = Some((**profile).clone());
            state.profile_status = PlayerCardStatus::Ready;
        }
        PlayerCardEvent::LoadFailed { reason } => {
            state.profile_status = PlayerCardStatus::Failed;
            state.profile_error = reason.clone();
        }
        PlayerCardEvent::Closed => {
            state.open = false;
            state.profile_status = PlayerCardStatus::Idle;
            state.history_status = PlayerCardStatus::Idle;
        }
        PlayerCardEvent::HistoryLoading { query, append } => {
            state.history_query = Some(query.clone());
            state.history_status = PlayerCardStatus::Loading;
            state.history_error.clear();
            if !append {
                state.history.clear();
                state.history_maximum = None;
                state.history_page = 0;
                state.history_total_pages = 1;
            }
        }
        PlayerCardEvent::HistoryLoaded {
            query,
            page,
            append,
        } => {
            state.history_query = Some(query.clone());
            if *append {
                state.history.extend(page.points.clone());
                if page.maximum.is_some() {
                    state.history_maximum = page.maximum.clone();
                }
            } else {
                state.history = page.points.clone();
                state.history_maximum = page.maximum.clone();
            }
            state
                .history
                .sort_by(|left, right| left.timestamp.cmp(&right.timestamp));
            state
                .history
                .dedup_by(|left, right| left.timestamp == right.timestamp);
            state.history_page = page.page;
            state.history_total_pages = page.total_pages.max(1);
            state.history_status = PlayerCardStatus::Ready;
        }
        PlayerCardEvent::HistoryLoadFailed { reason } => {
            state.history_status = PlayerCardStatus::Failed;
            state.history_error = reason.clone();
        }
        PlayerCardEvent::AvatarSelected {
            player_id,
            url,
            tooltip,
        } => {
            if let Some(profile) = state
                .profile
                .as_mut()
                .filter(|profile| profile.player_id == *player_id)
            {
                for avatar in &mut profile.avatars {
                    avatar.selected = url.as_deref() == Some(avatar.url.as_str());
                }
                if let Some(url) = url {
                    if !profile.avatars.iter().any(|avatar| avatar.url == *url) {
                        profile.avatars.push(PlayerAvatar {
                            url: url.clone(),
                            tooltip: tooltip.clone(),
                            selected: true,
                            expires_at: None,
                        });
                    }
                }
            }
            if let Some(profile) = state
                .matchmaker_profile
                .as_mut()
                .filter(|profile| profile.player_id == *player_id)
            {
                profile.avatar_url = url.clone().unwrap_or_default();
                profile.avatar_tooltip = tooltip.clone();
            }
        }
        PlayerCardEvent::MatchmakerProfileLoading { player_id } => {
            if state
                .matchmaker_profile
                .as_ref()
                .is_some_and(|profile| profile.player_id != *player_id)
            {
                state.matchmaker_profile = None;
            }
            state.matchmaker_profile_status = PlayerCardStatus::Loading;
            state.matchmaker_profile_error.clear();
        }
        PlayerCardEvent::MatchmakerProfileLoaded { profile } => {
            state.matchmaker_profile = Some((**profile).clone());
            state.matchmaker_profile_status = PlayerCardStatus::Ready;
            state.matchmaker_profile_error.clear();
        }
        PlayerCardEvent::MatchmakerProfileLoadFailed { player_id, reason } => {
            if state
                .matchmaker_profile
                .as_ref()
                .is_some_and(|profile| profile.player_id == *player_id)
            {
                // Keep a previously loaded projection visible if a refresh
                // failed. The error remains available for a compact warning.
            } else {
                state.matchmaker_profile = None;
            }
            state.matchmaker_profile_status = PlayerCardStatus::Failed;
            state.matchmaker_profile_error = reason.clone();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opening_a_different_player_clears_stale_profile_and_history() {
        let mut state = PlayerCardState {
            open: true,
            requested_login: "Old".into(),
            history: vec![RatingHistoryPoint {
                timestamp: "2020-01-01T00:00:00Z".into(),
                rating: 1000.0,
                mean: 1500.0,
                deviation: 166.0,
            }],
            ..PlayerCardState::default()
        };
        reduce(
            &mut state,
            &PlayerCardEvent::Loading {
                login: "New".into(),
            },
        );
        assert!(state.open);
        assert!(state.profile.is_none());
        assert!(state.history.is_empty());
    }

    #[test]
    fn appended_history_is_chronological_and_deduplicated() {
        let query = RatingHistoryQuery {
            player_id: 1,
            leaderboard_id: 2,
            leaderboard: "global".into(),
            period: RatingHistoryPeriod::All,
            page: 2,
            page_size: 1000,
        };
        let point = |timestamp: &str| RatingHistoryPoint {
            timestamp: timestamp.into(),
            rating: 1000.0,
            mean: 1500.0,
            deviation: 166.0,
        };
        let mut state = PlayerCardState {
            history: vec![point("2024-02-01T00:00:00Z")],
            ..PlayerCardState::default()
        };
        reduce(
            &mut state,
            &PlayerCardEvent::HistoryLoaded {
                query,
                page: RatingHistoryPage {
                    points: vec![point("2024-01-01T00:00:00Z"), point("2024-02-01T00:00:00Z")],
                    maximum: None,
                    page: 2,
                    total_pages: 3,
                },
                append: true,
            },
        );
        assert_eq!(state.history.len(), 2);
        assert_eq!(state.history[0].timestamp, "2024-01-01T00:00:00Z");
    }

    #[test]
    fn own_avatar_selection_updates_only_the_matching_open_profile() {
        let mut state = PlayerCardState {
            profile: Some(PlayerCardProfile {
                player_id: 7,
                login: "Ada".into(),
                country: String::new(),
                registered_at: String::new(),
                last_seen_at: String::new(),
                user_agent: String::new(),
                avatars: vec![PlayerAvatar {
                    url: "old".into(),
                    tooltip: "Old".into(),
                    selected: true,
                    expires_at: None,
                }],
                names: Vec::new(),
                clan: None,
                ratings: Vec::new(),
                league_placements: Vec::new(),
                events: Vec::new(),
                achievements: Vec::new(),
                warnings: Vec::new(),
            }),
            ..PlayerCardState::default()
        };

        reduce(
            &mut state,
            &PlayerCardEvent::AvatarSelected {
                player_id: 7,
                url: Some("new".into()),
                tooltip: "New".into(),
            },
        );
        let avatars = &state.profile.as_ref().unwrap().avatars;
        assert!(!avatars[0].selected);
        assert_eq!(avatars[1].url, "new");
        assert!(avatars[1].selected);

        reduce(
            &mut state,
            &PlayerCardEvent::AvatarSelected {
                player_id: 7,
                url: None,
                tooltip: String::new(),
            },
        );
        assert!(state
            .profile
            .as_ref()
            .unwrap()
            .avatars
            .iter()
            .all(|avatar| !avatar.selected));
    }

    #[test]
    fn matchmaker_profile_refresh_keeps_same_player_data_but_not_another_players() {
        let profile = |player_id| MatchmakerPlayerProfile {
            player_id,
            login: format!("Player{player_id}"),
            country: "de".into(),
            clan_tag: String::new(),
            avatar_url: String::new(),
            avatar_tooltip: String::new(),
            games_played: 10,
            ratings: Vec::new(),
            league_placements: Vec::new(),
            warnings: Vec::new(),
        };
        let mut state = PlayerCardState {
            matchmaker_profile: Some(profile(7)),
            matchmaker_profile_status: PlayerCardStatus::Ready,
            ..PlayerCardState::default()
        };

        reduce(
            &mut state,
            &PlayerCardEvent::MatchmakerProfileLoading { player_id: 7 },
        );
        assert_eq!(state.matchmaker_profile.as_ref().unwrap().player_id, 7);
        assert_eq!(state.matchmaker_profile_status, PlayerCardStatus::Loading);

        reduce(
            &mut state,
            &PlayerCardEvent::MatchmakerProfileLoading { player_id: 8 },
        );
        assert!(state.matchmaker_profile.is_none());
        reduce(
            &mut state,
            &PlayerCardEvent::MatchmakerProfileLoaded {
                profile: Box::new(profile(8)),
            },
        );
        assert_eq!(state.matchmaker_profile.as_ref().unwrap().player_id, 8);
        assert_eq!(state.matchmaker_profile_status, PlayerCardStatus::Ready);
    }

    #[test]
    fn avatar_selection_updates_the_cached_matchmaker_identity() {
        let mut state = PlayerCardState {
            matchmaker_profile: Some(MatchmakerPlayerProfile {
                player_id: 7,
                login: "Ada".into(),
                country: String::new(),
                clan_tag: String::new(),
                avatar_url: "old".into(),
                avatar_tooltip: "Old".into(),
                games_played: 0,
                ratings: Vec::new(),
                league_placements: Vec::new(),
                warnings: Vec::new(),
            }),
            ..PlayerCardState::default()
        };

        reduce(
            &mut state,
            &PlayerCardEvent::AvatarSelected {
                player_id: 7,
                url: Some("new".into()),
                tooltip: "New".into(),
            },
        );
        let profile = state.matchmaker_profile.unwrap();
        assert_eq!(profile.avatar_url, "new");
        assert_eq!(profile.avatar_tooltip, "New");
    }
}
