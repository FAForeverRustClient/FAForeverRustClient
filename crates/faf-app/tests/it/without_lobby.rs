//! The lobby of a client that has none, held to its word on the desktop.
//!
//! `infra::NoLobby` is the Android client's lobby port. These tests put it
//! where the desktop's lobby would be, which hands every command to the same
//! answers the Android build is made of (`services::lobby::unavailable`): it
//! is never connected to and says why, nothing retries it, every request that
//! would need a lobby is refused with that reason before anything is prepared
//! or sent, whoever sends it, and the rest reach nothing at all.

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use faf_app::infra::{fake_ports, FakeAuth, NoLobby};
use faf_app::ports::{
    GameLaunchParams, InstallPresence, LobbyPort, LobbySendError, LobbyUpdate, ProcessPort,
};
use faf_app::Ports;
use faf_domain::state::{
    AuthCommand, AvatarListStatus, Contact, FailureCause, HostGameConfig, JoinState, LobbyCommand,
    LobbyEvent, LobbyStatus, LobbyUnavailable, MatchmakingState, PlayMode, Player, PlayerVeto,
    Relation, SocialCommand,
};
use faf_domain::AppEvent;
use serde_json::Value;
use tokio::sync::mpsc;

use crate::support;

/// [`NoLobby`], with every call that would open a socket or send a frame
/// counted, so a test can tell the service never got that far.
#[derive(Default)]
struct Watched {
    connects: AtomicUsize,
    sends: AtomicUsize,
}

impl Watched {
    fn sent(&self) {
        self.sends.fetch_add(1, Ordering::SeqCst);
    }

    fn reached(&self) -> (usize, usize) {
        (
            self.connects.load(Ordering::SeqCst),
            self.sends.load(Ordering::SeqCst),
        )
    }
}

#[async_trait]
impl LobbyPort for Watched {
    fn unavailable(&self) -> Option<LobbyUnavailable> {
        NoLobby.unavailable()
    }
    async fn connect(&self) -> mpsc::Receiver<LobbyUpdate> {
        self.connects.fetch_add(1, Ordering::SeqCst);
        NoLobby.connect().await
    }
    fn join(&self, id: i32, password: Option<String>) -> bool {
        self.sent();
        NoLobby.join(id, password)
    }
    fn host(&self, config: HostGameConfig) -> Result<(), LobbySendError> {
        self.sent();
        NoLobby.host(config)
    }
    fn matchmake(&self, queue_names: &[String], start: bool) -> Result<(), LobbySendError> {
        self.sent();
        NoLobby.matchmake(queue_names, start)
    }
    fn leave_party(&self) {
        self.sent();
    }
    fn kick_party_member(&self, _player_id: i32) {
        self.sent();
    }
    fn invite_to_party(&self, _player_id: i32) {
        self.sent();
    }
    fn accept_party_invite(&self, player_id: i32) -> Result<(), LobbySendError> {
        self.sent();
        NoLobby.accept_party_invite(player_id)
    }
    fn set_party_factions(&self, _factions: Vec<String>) {
        self.sent();
    }
    fn set_contact_relation(
        &self,
        contact: Contact,
        member: bool,
        remove: Option<Relation>,
    ) -> bool {
        self.sent();
        NoLobby.set_contact_relation(contact, member, remove)
    }
    fn set_player_vetoes(&self, _vetoes: Vec<PlayerVeto>) {
        self.sent();
    }
    fn request_avatars(&self) -> bool {
        self.sent();
        NoLobby.request_avatars()
    }
    fn select_avatar(&self, url: Option<String>) -> bool {
        self.sent();
        NoLobby.select_avatar(url)
    }
    fn restore_game_session(&self, game_id: i32) -> bool {
        self.sent();
        NoLobby.restore_game_session(game_id)
    }
    fn send_game_relay(&self, _command: String, _args: Vec<Value>) {
        self.sent();
    }
    fn disconnect(&self) {}
}

fn the_reason() -> String {
    LobbySendError::Unavailable(LobbyUnavailable::NotInAndroidClient)
        .reason()
        .to_owned()
}

/// Said from the start, whether or not anybody signs in: an offline or
/// signed-out session never tries a connection, and the page and the status
/// bar's FAF Reconnect read the reason from the state.
#[tokio::test]
async fn the_reason_is_in_the_state_before_anybody_signs_in() {
    let lobby = Arc::new(Watched::default());
    let app = support::start(Ports {
        lobby: lobby.clone(),
        ..fake_ports()
    });

    let unavailable = support::find(&app, Duration::from_secs(5), |state| {
        state.lobby.unavailable
    })
    .await;

    assert_eq!(unavailable, Some(LobbyUnavailable::NotInAndroidClient));
    assert_eq!(app.with_state(|state| state.auth.player.clone()), None);
    assert_eq!(lobby.reached(), (0, 0), "the port was asked to connect");
}

/// A signed-in account, which is what the reconnect watchdog looks after.
#[tokio::test(start_paused = true)]
async fn the_lobby_is_never_connected_to_and_says_why_without_being_retried() {
    let lobby = Arc::new(Watched::default());
    let app = support::start(Ports {
        auth: Arc::new(FakeAuth {
            player: Player::new(7, "Ada"),
            delay: Duration::ZERO,
            fail_with: None,
        }),
        lobby: lobby.clone(),
        ..fake_ports()
    });
    app.dispatch_and_wait(AuthCommand::Login { remember: false }.into())
        .await
        .unwrap();
    let mut events = app.subscribe();

    app.dispatch_and_wait(LobbyCommand::Connect.into())
        .await
        .unwrap();
    // The watchdog looks every five seconds and backs off to a minute, so
    // this is every retry it would have made after a drop. The clock is
    // paused: the wait costs nothing and runs each of its ticks in turn.
    tokio::time::sleep(Duration::from_secs(150)).await;

    let mut said = 0;
    while let Ok(event) = events.try_recv() {
        match event {
            AppEvent::Lobby(LobbyEvent::Unavailable { reason }) => {
                assert_eq!(reason, LobbyUnavailable::NotInAndroidClient);
                said += 1;
            }
            AppEvent::Lobby(LobbyEvent::Connecting) => panic!("a connection was tried"),
            _ => {}
        }
    }
    assert_eq!(said, 1, "said once, for the one Connect, and never retried");
    let (status, unavailable) =
        app.with_state(|state| (state.lobby.status, state.lobby.unavailable));
    assert_eq!(status, LobbyStatus::Disconnected);
    assert_eq!(unavailable, Some(LobbyUnavailable::NotInAndroidClient));
    assert_eq!(
        lobby.reached(),
        (0, 0),
        "the port was asked to connect or send"
    );
}

/// Each request is answered where the page waits for its answer: a join on
/// its own state, a host on the launch it would have started, and the rest
/// as a notification whose cause the page words in the reader's language.
#[tokio::test]
async fn a_request_that_needs_the_lobby_is_refused_with_the_reason() {
    let lobby = Arc::new(Watched::default());
    let app = support::start(Ports {
        lobby: lobby.clone(),
        ..fake_ports()
    });

    app.dispatch_and_wait(
        LobbyCommand::Join {
            id: 1,
            password: None,
            replace_mods: false,
        }
        .into(),
    )
    .await
    .unwrap();
    assert_eq!(
        app.with_state(|state| state.lobby.join.clone()),
        JoinState::Failed {
            id: 1,
            reason: the_reason()
        }
    );

    app.dispatch_and_wait(
        LobbyCommand::Host {
            config: HostGameConfig {
                title: "1v1".into(),
                mod_name: "faf".into(),
                visibility: "public".into(),
                map: "SCMP_009".into(),
                password: None,
                enforce_rating_range: false,
                rating_min: None,
                rating_max: None,
            },
        }
        .into(),
    )
    .await
    .unwrap();
    assert_eq!(
        app.with_state(|state| state.lobby.join.clone()),
        JoinState::LaunchFailed {
            reason: the_reason()
        }
    );

    for command in [
        LobbyCommand::StartSearch {
            queue_names: vec!["ladder1v1".into()],
        },
        LobbyCommand::Matchmake {
            queue_name: "tmm2v2".into(),
            start: true,
        },
        LobbyCommand::AcceptPartyInvite {
            player_id: 23,
            notification_id: None,
        },
        LobbyCommand::InviteToParty { player_id: 23 },
        LobbyCommand::LoadAvatars,
        // A tournament match's Host, which opens the host dialog.
        LobbyCommand::PrepareHost {
            title: "Cup round 1".into(),
        },
    ] {
        app.dispatch_and_wait(command.into()).await.unwrap();
    }

    let (matchmaking, prefill, avatars, notes) = app.with_state(|state| {
        (
            state.lobby.matchmaking.clone(),
            state.lobby.host_prefill.clone(),
            (
                state.lobby.avatar_list_status,
                state.lobby.avatar_list_error.clone(),
            ),
            state
                .notifications
                .items
                .iter()
                .filter_map(|item| item.text.clone())
                .collect::<Vec<_>>(),
        )
    });
    assert_eq!(matchmaking, MatchmakingState::Idle, "a search was prepared");
    assert_eq!(prefill, None, "the host dialog was opened");
    assert_eq!(avatars, (AvatarListStatus::Failed, the_reason()));
    let mut keys: Vec<&str> = notes.iter().map(|text| text.key.as_str()).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "notifications.msg.cannotJoinParty",
            "notifications.msg.hostFailed",
            "notifications.msg.hostFailed",
            "notifications.msg.inviteFailed",
            "notifications.msg.searchFailed",
            "notifications.msg.searchFailed",
        ]
    );
    for text in &notes {
        assert_eq!(
            text.cause,
            Some(FailureCause::LobbyNotInAndroidClient),
            "{}",
            text.key
        );
        assert_eq!(
            text.params.get("reason"),
            Some(&the_reason()),
            "{}",
            text.key
        );
    }
    assert_eq!(
        lobby.reached(),
        (0, 0),
        "a request reached the port: something was prepared or sent first"
    );
}

/// The commands that need nothing refused do nothing here: there is no search
/// to stop, no party, no queue to veto maps for, no join and no connection.
/// None reaches the port or tells anybody anything, and a veto is not kept
/// for a matchmaker this client does not have. The page's own two still do
/// what they do.
#[tokio::test]
async fn the_rest_reach_nothing_but_the_page_s_own() {
    let lobby = Arc::new(Watched::default());
    let app = support::start(Ports {
        lobby: lobby.clone(),
        ..fake_ports()
    });

    for command in [
        LobbyCommand::Matchmake {
            queue_name: "ladder1v1".into(),
            start: false,
        },
        LobbyCommand::LeaveParty,
        LobbyCommand::KickPartyMember { player_id: 23 },
        LobbyCommand::SetPartyFactions {
            factions: vec!["uef".into()],
        },
        LobbyCommand::SetPlayerVetoes {
            vetoes: vec![PlayerVeto {
                matchmaker_queue_map_pool_id: 1,
                map_pool_map_version_id: 2,
                veto_tokens_applied: 1,
            }],
        },
        LobbyCommand::DeclineModReplacement,
        LobbyCommand::CancelJoin,
        LobbyCommand::Disconnect,
        LobbyCommand::SetPlayMode {
            mode: PlayMode::Coop,
        },
        LobbyCommand::ClearHostPrefill,
    ] {
        app.dispatch_and_wait(command.into()).await.unwrap();
    }

    let (notes, vetoes, kept_vetoes, mode) = app.with_state(|state| {
        (
            state.notifications.items.len(),
            state.lobby.vetoes.len(),
            state.settings.matchmaker_vetoes.len(),
            state.lobby.play_mode,
        )
    });
    assert_eq!(notes, 0, "somebody was told something");
    assert_eq!((vetoes, kept_vetoes), (0, 0), "a veto was taken");
    assert_eq!(mode, PlayMode::Coop);
    assert_eq!(lobby.reached(), (0, 0), "a command reached the port");
}

/// A game process that counts what ends it.
#[derive(Default)]
struct Killed(AtomicUsize);

#[async_trait]
impl ProcessPort for Killed {
    fn supports_live_launch(&self) -> bool {
        false
    }
    async fn launch_game(&self, _params: GameLaunchParams) -> Result<(), String> {
        Err("not used in this test".into())
    }
    async fn launch_offline(&self, _featured_mod: String, _map: String) -> Result<(), String> {
        Err("not used in this test".into())
    }
    async fn launch_replay(&self, _args: Vec<String>) -> Result<(), String> {
        Err("not used in this test".into())
    }
    fn kill(&self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
    fn set_paths(&self, _game_path: String, _replay_game_path: String) {}
    fn set_additional_arguments(&self, _arguments: Vec<String>) {}
    fn game_install_dir(&self) -> Option<PathBuf> {
        None
    }
    fn replay_install_dir(&self) -> Option<PathBuf> {
        None
    }
    fn installs_present(&self) -> InstallPresence {
        InstallPresence::default()
    }
}

/// The tray's "Terminate game" still ends the game, which in a client
/// without a lobby is an offline one.
#[tokio::test]
async fn terminating_the_game_ends_it_without_a_lobby() {
    let process = Arc::new(Killed::default());
    let app = support::start(Ports {
        lobby: Arc::new(NoLobby),
        process: process.clone(),
        ..fake_ports()
    });

    app.dispatch_and_wait(LobbyCommand::TerminateGame.into())
        .await
        .unwrap();

    assert_eq!(process.0.load(Ordering::SeqCst), 1);
}

/// A friend or foe change goes over the lobby as well, and is answered with
/// the same reason, not told to check a connection the client never had.
#[tokio::test]
async fn a_contact_change_is_refused_with_the_reason() {
    let lobby = Arc::new(Watched::default());
    let app = support::start(Ports {
        lobby: lobby.clone(),
        ..fake_ports()
    });

    app.dispatch_and_wait(
        SocialCommand::SetRelation {
            player_id: 23,
            login: "Bert".into(),
            relation: Relation::Friend,
            member: true,
        }
        .into(),
    )
    .await
    .unwrap();

    let (texts, friends) = app.with_state(|state| {
        (
            state
                .notifications
                .items
                .iter()
                .filter_map(|item| item.text.clone())
                .collect::<Vec<_>>(),
            state.social.friends.clone(),
        )
    });
    let [text] = texts.as_slice() else {
        panic!("told {} things", texts.len());
    };
    assert_eq!(text.key, "notifications.msg.contactChangeRefused");
    assert_eq!(text.cause, Some(FailureCause::LobbyNotInAndroidClient));
    assert_eq!(text.params.get("reason"), Some(&the_reason()));
    assert!(friends.is_empty(), "the change was taken as made");
    assert_eq!(lobby.reached(), (0, 0), "the change reached the port");
}
