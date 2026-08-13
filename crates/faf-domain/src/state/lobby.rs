//! Lobby slice: the list of open games, updated as the server pushes changes.
//!
//! This slice is the first to be driven by a *stream* of server events rather than
//! request/response: the lobby service subscribes to a [`Game`] feed and emits a
//! `GamesUpdated` event each time it changes. The reducer just stores the snapshot.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use specta::Type;

/// An open game in the lobby.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Game {
    pub id: i32,
    pub title: String,
    pub host: String,
    pub players: i32,
    pub max_players: i32,
    pub map: String,
    /// The featured mod (e.g. `faf`). Needed to build a replay's `/init`
    /// argument when watching this game live. Wire key on `game_info` is
    /// `featured_mod`, unrelated to `GameLaunch`'s `mod`.
    pub mod_name: String,
    pub average_rating: i32,
    pub password_protected: bool,
    pub visibility: String,
    pub game_type: String,
    /// Unix timestamp (seconds) when the match entered the playing state.
    /// Live replays become available after the replay server's safety delay.
    pub launched_at: Option<u32>,
    pub hosted_at: Option<String>,
    pub rating_min: Option<i32>,
    pub rating_max: Option<i32>,
    /// Team number to player names. Observer teams use the server's `-1`/`null`
    /// keys, matching the reference client's game model.
    pub teams: BTreeMap<String, Vec<String>>,
    /// SIM mod UID to display name, as reported by the lobby server.
    pub sim_mods: BTreeMap<String, String>,
}

/// Configuration sent with `game_host`. This mirrors the reference client's host
/// dialog without leaking UI-specific form state into the service layer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HostGameConfig {
    pub title: String,
    pub mod_name: String,
    pub visibility: String,
    pub map: String,
    pub password: Option<String>,
    pub enforce_rating_range: bool,
    pub rating_min: Option<i32>,
    pub rating_max: Option<i32>,
}

impl HostGameConfig {
    pub const MAX_TITLE_CHARS: usize = 128;
    pub const MAX_PASSWORD_CHARS: usize = 25;
    pub const MIN_RATING: i32 = -9_999;
    pub const MAX_RATING: i32 = 9_999;

    /// Normalize harmless form differences and reject values the reference
    /// clients refuse before they can cross the lobby protocol boundary.
    pub fn validated(mut self) -> Result<Self, String> {
        self.title = self.title.trim().to_owned();
        self.mod_name = self.mod_name.trim().to_owned();
        self.visibility = self.visibility.trim().to_ascii_lowercase();
        self.map = self.map.trim().to_owned();
        self.password = self.password.filter(|password| !password.is_empty());

        validate_host_text("Game title", &self.title, Self::MAX_TITLE_CHARS, false)?;
        validate_host_text("Featured mod", &self.mod_name, 128, false)?;
        validate_host_text("Map", &self.map, 256, false)?;
        if let Some(password) = &self.password {
            validate_host_text("Password", password, Self::MAX_PASSWORD_CHARS, true)?;
        }
        if !matches!(self.visibility.as_str(), "public" | "friends") {
            return Err("Visibility must be public or friends only.".into());
        }

        if self.enforce_rating_range {
            let (Some(minimum), Some(maximum)) = (self.rating_min, self.rating_max) else {
                return Err(
                    "Both rating limits are required when rating enforcement is enabled.".into(),
                );
            };
            if !(Self::MIN_RATING..=Self::MAX_RATING).contains(&minimum)
                || !(Self::MIN_RATING..=Self::MAX_RATING).contains(&maximum)
            {
                return Err(format!(
                    "Rating limits must be between {} and {}.",
                    Self::MIN_RATING,
                    Self::MAX_RATING
                ));
            }
            if minimum > maximum {
                return Err("Minimum rating cannot be greater than maximum rating.".into());
            }
        } else {
            self.rating_min = None;
            self.rating_max = None;
        }

        Ok(self)
    }
}

fn validate_host_text(
    label: &str,
    value: &str,
    max_chars: usize,
    allow_empty: bool,
) -> Result<(), String> {
    if !allow_empty && value.is_empty() {
        return Err(format!("{label} is required."));
    }
    if value.chars().count() > max_chars {
        return Err(format!("{label} cannot exceed {max_chars} characters."));
    }
    if !value.is_ascii() || value.chars().any(char::is_control) {
        return Err(format!(
            "{label} must contain printable ASCII characters only."
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MatchmakerQueue {
    pub queue_name: String,
    pub team_size: i32,
    pub num_players: i32,
    pub queue_pop_time_seconds: i32,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum MatchmakingState {
    #[default]
    Idle,
    #[serde(rename_all = "camelCase")]
    Searching { queue_names: Vec<String> },
    #[serde(rename_all = "camelCase")]
    MatchFound { queue_name: String },
    #[serde(rename_all = "camelCase")]
    Launching { queue_name: String },
    #[serde(rename_all = "camelCase")]
    Cancelled { queue_name: Option<String> },
}

impl MatchmakingState {
    /// Apply one `search_info` update without losing the other queues the party
    /// is searching. The lobby protocol reports queue changes independently,
    /// while the Java client permits several compatible queues at once.
    pub fn update_search(&mut self, queue_name: String, searching: bool) {
        // A match-found/cancelled update can be followed by late `stop`
        // acknowledgements for each formerly active queue. Those must not erase
        // the more useful terminal status. A new `start` intentionally does.
        if !searching && !matches!(self, Self::Searching { .. }) {
            return;
        }
        let mut queue_names = match self {
            Self::Searching { queue_names } => queue_names.clone(),
            _ => Vec::new(),
        };

        if searching {
            if !queue_names.contains(&queue_name) {
                queue_names.push(queue_name);
                queue_names.sort();
            }
        } else {
            queue_names.retain(|name| name != &queue_name);
        }

        *self = if queue_names.is_empty() {
            Self::Idle
        } else {
            Self::Searching { queue_names }
        };
    }

    pub fn searching_queues(&self) -> &[String] {
        match self {
            Self::Searching { queue_names } => queue_names,
            _ => &[],
        }
    }

    pub fn matched_queue(&self) -> Option<&str> {
        match self {
            Self::MatchFound { queue_name }
            | Self::Launching { queue_name }
            | Self::Cancelled {
                queue_name: Some(queue_name),
            } => Some(queue_name),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PartyMember {
    pub player_id: i32,
    pub name: String,
    pub factions: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PartyState {
    pub owner_id: Option<i32>,
    pub members: Vec<PartyMember>,
}

/// One server-backed matchmaker veto-token allocation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlayerVeto {
    pub matchmaker_queue_map_pool_id: i32,
    pub map_pool_map_version_id: i32,
    pub veto_tokens_applied: i32,
}

/// The active surface inside Play. It lives in the domain state so the UI never
/// creates a second, local navigation source of truth.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PlayMode {
    #[default]
    Custom,
    Coop,
    Matchmaking,
}

/// The server's `game_launch` order: everything the connectivity + launch chain
/// (a later phase) needs to actually start the game. For now we only model and
/// surface it; nothing acts on it yet. Mirrors the relevant fields of the Python
/// client's `GameLaunchCommand` (`src/protocol/lobbyprotocol.py`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GameLaunch {
    pub uid: i32,
    /// The featured mod (e.g. `faf`). Wire key is `mod`, a Rust keyword.
    #[serde(rename = "mod")]
    pub mod_name: String,
    pub name: String,
    pub mapname: String,
    pub game_type: String,
    pub rating_type: String,
    /// Matchmaker-only automatic-lobby parameters. They remain optional because
    /// custom-game launch messages do not contain them.
    pub expected_players: Option<i32>,
    pub team: Option<i32>,
    pub faction: Option<i32>,
    pub map_position: Option<i32>,
    pub game_options: std::collections::BTreeMap<String, String>,
    /// Raw launch args from the server (the FA command line is built from these
    /// plus client-side player info in the launch phase).
    pub args: Vec<String>,
}

/// Where a join attempt stands. Distinct from [`LobbyStatus`] (the connection):
/// you can be `Connected` and `Idle`, or `Connected` and `Joining`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum JoinState {
    #[default]
    Idle,
    Joining {
        id: i32,
        /// The featured mod, map and required simulation mods were prepared
        /// before the join request was sent. The later launch order consumes
        /// this fact so the launcher does not repeat the same expensive work.
        prepared: bool,
    },
    /// The server sent `game_launch`; the launch order is modeled. If real launch
    /// is enabled, the connectivity chain (ICE adapter + relay + game process)
    /// starts next, moving to [`Self::InGame`].
    Launched { launch: GameLaunch },
    /// The install is being brought up to date for this game: patching the
    /// featured mod, downloading the map, generating terrain.
    ///
    /// Its own phase because it is the only *slow* step between accepting a
    /// launch order and the game window appearing: a balance patch is hundreds
    /// of files and a map is a fresh download. Both reference clients narrate
    /// it (Java's updater task title, the Python client's updater dialog)
    /// rather than leaving the client looking frozen.
    Preparing {
        detail: String,
        progress: Option<u8>,
    },
    /// The ICE adapter and game process were started; relay traffic is flowing.
    InGame,
    /// The server rejected the join (game not ready, host left, bad password).
    Failed { id: i32, reason: String },
    /// The local launch chain failed (adapter/relay/game couldn't start).
    LaunchFailed { reason: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum LobbyStatus {
    #[default]
    Disconnected,
    Connecting,
    Connected,
}

/// One avatar the lobby server allows the authenticated player to select.
/// The URL is also the protocol identifier used by `avatar/select`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AvailableAvatar {
    pub url: String,
    pub tooltip: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AvatarListStatus {
    #[default]
    Idle,
    Loading,
    Ready,
    Failed,
}

/// Fold one `matchmaker_info` payload into the known queues.
///
/// The lobby server does **not** resend the whole queue list every time: a
/// `matchmaker_info` push carries only the queues whose numbers changed. So
/// this upserts by name and leaves untouched queues alone. Replacing the list
/// wholesale made queues flicker in and out of the tab: one push mentioning
/// only `tmm2v2` erased `ladder1v1` until the next push happened to mention it.
///
/// The Java client reaches the same behaviour with an `ObservableMap` keyed by
/// queue name that is only cleared on logout
/// (`TeamMatchmakingService.nameToQueue`); ours is cleared on disconnect.
///
/// Order is by team size then name so the row does not reshuffle as updates
/// arrive: the server's push order is not stable.
fn merge_matchmaker_queues(known: &mut Vec<MatchmakerQueue>, incoming: &[MatchmakerQueue]) {
    for queue in incoming {
        match known
            .iter_mut()
            .find(|existing| existing.queue_name == queue.queue_name)
        {
            Some(existing) => *existing = queue.clone(),
            None => known.push(queue.clone()),
        }
    }
    known.sort_by(|left, right| {
        left.team_size
            .cmp(&right.team_size)
            .then_with(|| left.queue_name.cmp(&right.queue_name))
    });
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LobbyState {
    pub status: LobbyStatus,
    pub games: Vec<Game>,
    /// Games currently in progress: not joinable, but watchable via a live
    /// replay (see `faf-app`'s `ReplayPort::watch_live`).
    pub live_games: Vec<Game>,
    pub join: JoinState,
    pub matchmaker_queues: Vec<MatchmakerQueue>,
    pub matchmaking: MatchmakingState,
    pub party: PartyState,
    pub vetoes: Vec<PlayerVeto>,
    pub play_mode: PlayMode,
    pub available_avatars: Vec<AvailableAvatar>,
    pub avatar_list_status: AvatarListStatus,
    pub avatar_list_error: String,
    pub avatar_selection_status: AvatarListStatus,
    pub avatar_selection_error: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum LobbyEvent {
    Connecting,
    Connected,
    GamesUpdated {
        games: Vec<Game>,
    },
    LiveGamesUpdated {
        games: Vec<Game>,
    },
    MatchmakerQueuesUpdated {
        queues: Vec<MatchmakerQueue>,
    },
    MatchmakingUpdated {
        state: MatchmakingState,
    },
    PartyUpdated {
        party: PartyState,
    },
    VetoesUpdated {
        vetoes: Vec<PlayerVeto>,
    },
    PlayModeChanged {
        mode: PlayMode,
    },
    AvatarsLoading,
    AvatarsLoaded {
        avatars: Vec<AvailableAvatar>,
    },
    AvatarsLoadFailed {
        reason: String,
    },
    AvatarSelectionStarted,
    AvatarSelectionSucceeded,
    AvatarSelectionFailed {
        reason: String,
    },
    Joining {
        id: i32,
        prepared: bool,
    },
    Launching {
        launch: GameLaunch,
    },
    /// Progress on getting the install ready for the pending launch.
    Preparing {
        detail: String,
        progress: Option<u8>,
    },
    JoinFailed {
        id: i32,
        reason: String,
    },
    /// The user cancelled a pending join before the socket supervisor had
    /// finished disconnecting. This clears any prepared-install marker
    /// immediately, preventing a racing launch frame from starting the game.
    JoinCancelled,
    InGame,
    LaunchFailed {
        reason: String,
    },
    /// The local FA process was explicitly terminated by the user.
    GameTerminated,
    Disconnected,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum LobbyCommand {
    Connect,
    Join {
        id: i32,
        password: Option<String>,
    },
    Host {
        config: HostGameConfig,
    },
    #[serde(rename_all = "camelCase")]
    Matchmake {
        queue_name: String,
        start: bool,
    },
    LeaveParty,
    #[serde(rename_all = "camelCase")]
    KickPartyMember {
        player_id: i32,
    },
    /// Invite a player to our party. Fire-and-forget: the invitee's client
    /// decides, and their acceptance arrives as an `update_party`.
    #[serde(rename_all = "camelCase")]
    InviteToParty {
        player_id: i32,
    },
    /// Accept an incoming party invitation from its sender.
    #[serde(rename_all = "camelCase")]
    AcceptPartyInvite {
        player_id: i32,
    },
    /// Update the local party member's accepted factions. The server echoes the
    /// authoritative selection in its next `update_party` snapshot.
    SetPartyFactions {
        factions: Vec<String>,
    },
    SetPlayMode {
        mode: PlayMode,
    },
    SetPlayerVetoes {
        vetoes: Vec<PlayerVeto>,
    },
    /// Request the authenticated player's server-authorized avatar choices.
    LoadAvatars,
    /// Select an available avatar, or clear the current avatar with `None`.
    SelectAvatar {
        url: Option<String>,
    },
    /// Stop the local FA process and connectivity adapter, if running.
    TerminateGame,
    Disconnect,
}

pub fn reduce(state: &mut LobbyState, event: &LobbyEvent) {
    match event {
        LobbyEvent::Connecting => state.status = LobbyStatus::Connecting,
        LobbyEvent::Connected => state.status = LobbyStatus::Connected,
        LobbyEvent::GamesUpdated { games } => state.games = games.clone(),
        LobbyEvent::LiveGamesUpdated { games } => state.live_games = games.clone(),
        LobbyEvent::MatchmakerQueuesUpdated { queues } => {
            merge_matchmaker_queues(&mut state.matchmaker_queues, queues)
        }
        LobbyEvent::MatchmakingUpdated { state: matchmaking } => {
            state.matchmaking = matchmaking.clone()
        }
        LobbyEvent::PartyUpdated { party } => state.party = party.clone(),
        LobbyEvent::VetoesUpdated { vetoes } => state.vetoes = vetoes.clone(),
        LobbyEvent::PlayModeChanged { mode } => state.play_mode = *mode,
        LobbyEvent::AvatarsLoading => {
            state.avatar_list_status = AvatarListStatus::Loading;
            state.avatar_list_error.clear();
            state.avatar_selection_status = AvatarListStatus::Idle;
            state.avatar_selection_error.clear();
        }
        LobbyEvent::AvatarsLoaded { avatars } => {
            state.available_avatars = avatars.clone();
            state.avatar_list_status = AvatarListStatus::Ready;
            state.avatar_list_error.clear();
        }
        LobbyEvent::AvatarsLoadFailed { reason } => {
            state.avatar_list_status = AvatarListStatus::Failed;
            state.avatar_list_error = reason.clone();
        }
        LobbyEvent::AvatarSelectionStarted => {
            state.avatar_selection_status = AvatarListStatus::Loading;
            state.avatar_selection_error.clear();
        }
        LobbyEvent::AvatarSelectionSucceeded => {
            state.avatar_selection_status = AvatarListStatus::Ready;
            state.avatar_selection_error.clear();
        }
        LobbyEvent::AvatarSelectionFailed { reason } => {
            state.avatar_selection_status = AvatarListStatus::Failed;
            state.avatar_selection_error = reason.clone();
        }
        LobbyEvent::Joining { id, prepared } => {
            state.join = JoinState::Joining {
                id: *id,
                prepared: *prepared,
            }
        }
        LobbyEvent::Launching { launch } => {
            state.join = JoinState::Launched {
                launch: launch.clone(),
            }
        }
        LobbyEvent::Preparing { detail, progress } => {
            state.join = JoinState::Preparing {
                detail: detail.clone(),
                progress: *progress,
            }
        }
        LobbyEvent::JoinFailed { id, reason } => {
            state.join = JoinState::Failed {
                id: *id,
                reason: reason.clone(),
            }
        }
        LobbyEvent::JoinCancelled => {
            if matches!(
                state.join,
                JoinState::Joining { .. } | JoinState::Preparing { .. }
            ) {
                state.join = JoinState::Idle;
            }
        }
        LobbyEvent::InGame => state.join = JoinState::InGame,
        LobbyEvent::LaunchFailed { reason } => {
            state.join = JoinState::LaunchFailed {
                reason: reason.clone(),
            }
        }
        LobbyEvent::GameTerminated => state.join = JoinState::Idle,
        LobbyEvent::Disconnected => {
            state.status = LobbyStatus::Disconnected;
            state.games.clear();
            state.live_games.clear();
            state.join = JoinState::Idle;
            state.matchmaker_queues.clear();
            state.matchmaking = MatchmakingState::Idle;
            state.party = PartyState::default();
            state.vetoes.clear();
            state.available_avatars.clear();
            state.avatar_list_status = AvatarListStatus::Idle;
            state.avatar_list_error.clear();
            state.avatar_selection_status = AvatarListStatus::Idle;
            state.avatar_selection_error.clear();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn game(id: i32) -> Game {
        Game {
            id,
            title: format!("Game {id}"),
            host: "host".into(),
            players: 1,
            max_players: 8,
            map: "Seton's Clutch".into(),
            mod_name: "faf".into(),
            average_rating: 0,
            password_protected: false,
            visibility: "public".into(),
            game_type: "custom".into(),
            launched_at: None,
            hosted_at: None,
            rating_min: None,
            rating_max: None,
            teams: BTreeMap::new(),
            sim_mods: BTreeMap::new(),
        }
    }

    #[test]
    fn games_updated_replaces_the_snapshot() {
        let mut s = LobbyState::default();
        reduce(
            &mut s,
            &LobbyEvent::GamesUpdated {
                games: vec![game(1), game(2)],
            },
        );
        assert_eq!(s.games.len(), 2);
        reduce(
            &mut s,
            &LobbyEvent::GamesUpdated {
                games: vec![game(3)],
            },
        );
        assert_eq!(s.games, vec![game(3)]);
    }

    #[test]
    fn play_mode_is_reducer_owned() {
        let mut state = LobbyState::default();
        reduce(
            &mut state,
            &LobbyEvent::PlayModeChanged {
                mode: PlayMode::Matchmaking,
            },
        );
        assert_eq!(state.play_mode, PlayMode::Matchmaking);
    }

    #[test]
    fn avatar_catalog_has_an_explicit_load_lifecycle() {
        let mut state = LobbyState::default();
        reduce(&mut state, &LobbyEvent::AvatarsLoading);
        assert_eq!(state.avatar_list_status, AvatarListStatus::Loading);

        reduce(
            &mut state,
            &LobbyEvent::AvatarsLoaded {
                avatars: vec![AvailableAvatar {
                    url: "https://example.test/avatar.png".into(),
                    tooltip: "Tournament winner".into(),
                }],
            },
        );
        assert_eq!(state.avatar_list_status, AvatarListStatus::Ready);
        assert_eq!(state.available_avatars.len(), 1);

        reduce(&mut state, &LobbyEvent::Disconnected);
        assert_eq!(state.avatar_list_status, AvatarListStatus::Idle);
        assert!(state.available_avatars.is_empty());
    }

    fn queue(name: &str, team_size: i32, num_players: i32) -> MatchmakerQueue {
        MatchmakerQueue {
            queue_name: name.into(),
            team_size,
            num_players,
            queue_pop_time_seconds: 60,
        }
    }

    #[test]
    fn a_partial_matchmaker_push_does_not_erase_the_other_queues() {
        // The regression this exists for: the server pushes only the queues
        // whose numbers changed, so replacing the list made queues flicker in
        // and out of the tab between pushes.
        let mut s = LobbyState::default();
        reduce(
            &mut s,
            &LobbyEvent::MatchmakerQueuesUpdated {
                queues: vec![queue("ladder1v1", 1, 5), queue("tmm2v2", 2, 3)],
            },
        );
        assert_eq!(s.matchmaker_queues.len(), 2);

        reduce(
            &mut s,
            &LobbyEvent::MatchmakerQueuesUpdated {
                queues: vec![queue("tmm2v2", 2, 9)],
            },
        );

        let names: Vec<&str> = s
            .matchmaker_queues
            .iter()
            .map(|q| q.queue_name.as_str())
            .collect();
        assert_eq!(names, vec!["ladder1v1", "tmm2v2"], "both queues survive");
        assert_eq!(
            s.matchmaker_queues[1].num_players, 9,
            "the mentioned queue is updated in place"
        );
    }

    #[test]
    fn queue_order_is_stable_regardless_of_push_order() {
        // The server's push order is not stable; without an explicit sort the
        // cards would reshuffle under the cursor every few seconds.
        let mut s = LobbyState::default();
        reduce(
            &mut s,
            &LobbyEvent::MatchmakerQueuesUpdated {
                queues: vec![queue("tmm4v4", 4, 1), queue("ladder1v1", 1, 2)],
            },
        );
        reduce(
            &mut s,
            &LobbyEvent::MatchmakerQueuesUpdated {
                queues: vec![queue("tmm2v2", 2, 3)],
            },
        );

        let names: Vec<&str> = s
            .matchmaker_queues
            .iter()
            .map(|q| q.queue_name.as_str())
            .collect();
        assert_eq!(names, vec!["ladder1v1", "tmm2v2", "tmm4v4"]);
    }

    #[test]
    fn disconnecting_forgets_the_queues() {
        // Only a disconnect clears them: the Java client clears its queue map
        // on logout for the same reason.
        let mut s = LobbyState::default();
        reduce(
            &mut s,
            &LobbyEvent::MatchmakerQueuesUpdated {
                queues: vec![queue("tmm2v2", 2, 3)],
            },
        );
        reduce(&mut s, &LobbyEvent::Disconnected);
        assert!(s.matchmaker_queues.is_empty());
    }

    #[test]
    fn matchmaking_tracks_independent_queue_updates() {
        let mut state = MatchmakingState::Idle;
        state.update_search("tmm2v2".into(), true);
        state.update_search("ladder1v1".into(), true);
        assert_eq!(
            state,
            MatchmakingState::Searching {
                queue_names: vec!["ladder1v1".into(), "tmm2v2".into()],
            }
        );

        state.update_search("ladder1v1".into(), false);
        assert_eq!(state.searching_queues(), &["tmm2v2".to_string()]);
        state.update_search("tmm2v2".into(), false);
        assert_eq!(state, MatchmakingState::Idle);
    }

    #[test]
    fn a_new_search_clears_terminal_match_status() {
        let mut state = MatchmakingState::Cancelled {
            queue_name: Some("ladder1v1".into()),
        };
        state.update_search("tmm2v2".into(), true);
        assert_eq!(
            state,
            MatchmakingState::Searching {
                queue_names: vec!["tmm2v2".into()],
            }
        );
    }

    #[test]
    fn late_stop_does_not_erase_match_found_status() {
        let mut state = MatchmakingState::MatchFound {
            queue_name: "ladder1v1".into(),
        };
        state.update_search("tmm2v2".into(), false);
        assert_eq!(
            state,
            MatchmakingState::MatchFound {
                queue_name: "ladder1v1".into(),
            }
        );
    }

    #[test]
    fn disconnect_clears_games_and_join() {
        let mut s = LobbyState {
            status: LobbyStatus::Connected,
            games: vec![game(1)],
            live_games: vec![],
            join: JoinState::Joining {
                id: 1,
                prepared: true,
            },
            ..Default::default()
        };
        reduce(&mut s, &LobbyEvent::Disconnected);
        assert_eq!(s, LobbyState::default());
    }

    fn launch(uid: i32) -> GameLaunch {
        GameLaunch {
            uid,
            mod_name: "faf".into(),
            name: format!("Game {uid}"),
            mapname: "scmp_007".into(),
            game_type: "custom".into(),
            rating_type: "global".into(),
            expected_players: None,
            team: None,
            faction: None,
            map_position: None,
            game_options: Default::default(),
            args: vec!["/numgames".into(), "42".into()],
        }
    }

    #[test]
    fn join_flow_transitions_through_join_state() {
        let mut s = LobbyState::default();
        assert_eq!(s.join, JoinState::Idle);

        reduce(
            &mut s,
            &LobbyEvent::Joining {
                id: 7,
                prepared: false,
            },
        );
        assert_eq!(
            s.join,
            JoinState::Joining {
                id: 7,
                prepared: false,
            }
        );

        reduce(
            &mut s,
            &LobbyEvent::Joining {
                id: 7,
                prepared: true,
            },
        );
        assert_eq!(
            s.join,
            JoinState::Joining {
                id: 7,
                prepared: true,
            }
        );

        reduce(&mut s, &LobbyEvent::Launching { launch: launch(7) });
        assert_eq!(s.join, JoinState::Launched { launch: launch(7) });
    }

    #[test]
    fn launch_progresses_to_in_game() {
        let mut s = LobbyState::default();
        reduce(&mut s, &LobbyEvent::Launching { launch: launch(5) });
        reduce(&mut s, &LobbyEvent::InGame);
        assert_eq!(s.join, JoinState::InGame);
    }

    #[test]
    fn terminating_the_game_returns_the_join_state_to_idle() {
        let mut state = LobbyState {
            join: JoinState::InGame,
            ..LobbyState::default()
        };

        reduce(&mut state, &LobbyEvent::GameTerminated);

        assert_eq!(state.join, JoinState::Idle);
    }

    #[test]
    fn preparing_narrates_the_wait_between_the_launch_order_and_the_game() {
        let mut s = LobbyState::default();
        reduce(&mut s, &LobbyEvent::Launching { launch: launch(5) });

        reduce(
            &mut s,
            &LobbyEvent::Preparing {
                detail: "Updating faf".into(),
                progress: Some(40),
            },
        );
        assert_eq!(
            s.join,
            JoinState::Preparing {
                detail: "Updating faf".into(),
                progress: Some(40),
            }
        );

        // Each step replaces the last: this is a status line, not a log.
        reduce(
            &mut s,
            &LobbyEvent::Preparing {
                detail: "Downloading map".into(),
                progress: None,
            },
        );
        assert_eq!(
            s.join,
            JoinState::Preparing {
                detail: "Downloading map".into(),
                progress: None,
            }
        );

        reduce(&mut s, &LobbyEvent::InGame);
        assert_eq!(s.join, JoinState::InGame);
    }

    #[test]
    fn preparation_can_fail_the_launch_outright() {
        let mut s = LobbyState::default();
        reduce(&mut s, &LobbyEvent::Launching { launch: launch(5) });
        reduce(
            &mut s,
            &LobbyEvent::Preparing {
                detail: "Updating faf".into(),
                progress: None,
            },
        );
        reduce(
            &mut s,
            &LobbyEvent::LaunchFailed {
                reason: "could not update faf: 503".into(),
            },
        );
        assert_eq!(
            s.join,
            JoinState::LaunchFailed {
                reason: "could not update faf: 503".into()
            }
        );
    }

    #[test]
    fn launch_failure_records_reason() {
        let mut s = LobbyState::default();
        reduce(&mut s, &LobbyEvent::Launching { launch: launch(5) });
        reduce(
            &mut s,
            &LobbyEvent::LaunchFailed {
                reason: "FAF_GAME_PATH is not set".into(),
            },
        );
        assert_eq!(
            s.join,
            JoinState::LaunchFailed {
                reason: "FAF_GAME_PATH is not set".into()
            }
        );
    }

    #[test]
    fn join_failed_records_reason() {
        let mut s = LobbyState::default();
        reduce(
            &mut s,
            &LobbyEvent::Joining {
                id: 3,
                prepared: false,
            },
        );
        reduce(
            &mut s,
            &LobbyEvent::JoinFailed {
                id: 3,
                reason: "bad_password".into(),
            },
        );
        assert_eq!(
            s.join,
            JoinState::Failed {
                id: 3,
                reason: "bad_password".into()
            }
        );
    }

    #[test]
    fn cancelling_clears_a_pending_prepared_join_but_not_a_running_game() {
        let mut state = LobbyState {
            join: JoinState::Joining {
                id: 3,
                prepared: true,
            },
            ..LobbyState::default()
        };

        reduce(&mut state, &LobbyEvent::JoinCancelled);
        assert_eq!(state.join, JoinState::Idle);

        state.join = JoinState::InGame;
        reduce(&mut state, &LobbyEvent::JoinCancelled);
        assert_eq!(state.join, JoinState::InGame);
    }

    fn host_config() -> HostGameConfig {
        HostGameConfig {
            title: "  Friday game  ".into(),
            mod_name: " faf ".into(),
            visibility: "PUBLIC".into(),
            map: " scmp_009 ".into(),
            password: Some(" secret ".into()),
            enforce_rating_range: true,
            rating_min: Some(800),
            rating_max: Some(1_500),
        }
    }

    #[test]
    fn host_config_is_normalized_before_crossing_the_protocol_boundary() {
        let config = host_config().validated().unwrap();
        assert_eq!(config.title, "Friday game");
        assert_eq!(config.mod_name, "faf");
        assert_eq!(config.visibility, "public");
        assert_eq!(config.map, "scmp_009");
        assert_eq!(config.password.as_deref(), Some(" secret "));
    }

    #[test]
    fn host_config_rejects_reference_client_validation_failures() {
        let mut inverted = host_config();
        inverted.rating_min = Some(1_501);
        assert_eq!(
            inverted.validated().unwrap_err(),
            "Minimum rating cannot be greater than maximum rating."
        );

        let mut unicode_title = host_config();
        unicode_title.title = "Überraschung".into();
        assert!(unicode_title
            .validated()
            .unwrap_err()
            .contains("printable ASCII"));

        let mut unicode_password = host_config();
        unicode_password.password = Some("pässword".into());
        assert!(unicode_password
            .validated()
            .unwrap_err()
            .contains("printable ASCII"));
    }

    #[test]
    fn disabled_rating_enforcement_cannot_leak_stale_limits() {
        let mut config = host_config();
        config.enforce_rating_range = false;
        let config = config.validated().unwrap();
        assert_eq!(config.rating_min, None);
        assert_eq!(config.rating_max, None);
    }
}
