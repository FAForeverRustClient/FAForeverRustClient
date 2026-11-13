//! The web link, driven through the real runtime with a scripted socket.
//!
//! The service has no command behind it: it follows the setting, the sign-in
//! and the lobby. So these tests sign in, connect a scripted lobby, flip the
//! setting, and play the web client's server on the other end of the port.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use faf_app::infra::{fake_ports, FakeAuth};
use faf_app::ports::{
    LobbyPort, LobbySendError, LobbyUpdate, WebLinkError, WebLinkPort, WebLinkSession,
};
use faf_app::{App, Ports};
use faf_domain::protocol::web_link::{Inbound, Outbound};
use faf_domain::state::settings::WebLinkPreferencesPatch;
use faf_domain::state::{
    AuthCommand, Game, HostGameConfig, LobbyCommand, MatchmakerQueue, MatchmakingState,
    NotificationKind, Player, PlayerVeto, Relation, SettingsCommand,
};
use serde_json::{json, Value};
use tokio::sync::mpsc;

/// The server's end of one connection.
struct ServerEnd {
    from_client: mpsc::Receiver<Outbound>,
    to_client: mpsc::Sender<Inbound>,
}

#[derive(Default)]
struct ScriptedLink {
    connects: Mutex<u32>,
    ends: Mutex<Vec<ServerEnd>>,
    browsers: u32,
}

#[async_trait]
impl WebLinkPort for ScriptedLink {
    async fn connect(&self) -> Result<WebLinkSession, WebLinkError> {
        *self.connects.lock().unwrap() += 1;
        let (outbound, from_client) = mpsc::channel(64);
        let (to_client, inbound) = mpsc::channel(64);
        self.ends.lock().unwrap().push(ServerEnd {
            from_client,
            to_client,
        });
        Ok(WebLinkSession {
            outbound,
            inbound,
            browsers: self.browsers,
        })
    }
}

/// A lobby the test feeds by hand, recording what the client asks of it.
#[derive(Default)]
struct ScriptedLobby {
    updates: Mutex<Option<mpsc::Sender<LobbyUpdate>>>,
    joins: Mutex<Vec<(i32, Option<String>)>>,
    stops: Mutex<Vec<String>>,
}

#[async_trait]
impl LobbyPort for ScriptedLobby {
    async fn connect(&self) -> mpsc::Receiver<LobbyUpdate> {
        let (tx, rx) = mpsc::channel(16);
        *self.updates.lock().unwrap() = Some(tx);
        rx
    }
    fn join(&self, id: i32, password: Option<String>) -> bool {
        self.joins.lock().unwrap().push((id, password));
        true
    }
    fn host(&self, _config: HostGameConfig) -> Result<(), LobbySendError> {
        Err(LobbySendError::Disconnected)
    }
    fn matchmake(&self, queue_names: &[String], start: bool) -> Result<(), LobbySendError> {
        if !start {
            self.stops
                .lock()
                .unwrap()
                .extend(queue_names.iter().cloned());
        }
        Ok(())
    }
    fn leave_party(&self) {}
    fn kick_party_member(&self, _player_id: i32) {}
    fn invite_to_party(&self, _player_id: i32) {}
    fn accept_party_invite(&self, _player_id: i32) -> Result<(), LobbySendError> {
        Err(LobbySendError::Disconnected)
    }
    fn set_party_factions(&self, _factions: Vec<String>) {}
    fn set_contact_relation(
        &self,
        _contact: faf_domain::state::Contact,
        _member: bool,
        _remove: Option<Relation>,
    ) -> bool {
        false
    }
    fn set_player_vetoes(&self, _vetoes: Vec<PlayerVeto>) {}
    fn request_avatars(&self) -> bool {
        false
    }
    fn select_avatar(&self, _url: Option<String>) -> bool {
        false
    }
    fn restore_game_session(&self, _game_id: i32) -> bool {
        true
    }
    fn send_game_relay(&self, _command: String, _args: Vec<Value>) {}
    fn disconnect(&self) {
        self.updates.lock().unwrap().take();
    }
}

fn queue(name: &str, team_size: i32) -> MatchmakerQueue {
    MatchmakerQueue {
        queue_name: name.into(),
        team_size,
        num_players: 4,
        queue_pop_time_seconds: 30,
        queue_pops_at: String::new(),
        boundary_80s: Vec::new(),
        boundary_75s: Vec::new(),
    }
}

fn lobby_game(id: i32, title: &str, password_protected: bool) -> Game {
    let mut teams = BTreeMap::new();
    teams.insert("1".to_string(), vec!["Bob".to_string()]);
    Game {
        id,
        title: title.into(),
        host: "Bob".into(),
        players: 1,
        max_players: 8,
        map: "scmp_009".into(),
        mod_name: "faf".into(),
        average_rating: 1200,
        rating_type: "global".into(),
        password_protected,
        visibility: "public".into(),
        game_type: "custom".into(),
        launched_at: None,
        hosted_at: None,
        rating_min: None,
        rating_max: None,
        enforce_rating_range: false,
        teams,
        sim_mods: BTreeMap::new(),
    }
}

struct Harness {
    app: App,
    link: Arc<ScriptedLink>,
    lobby: Arc<ScriptedLobby>,
}

impl Harness {
    async fn start(browsers: u32) -> Self {
        let link = Arc::new(ScriptedLink {
            browsers,
            ..ScriptedLink::default()
        });
        let lobby = Arc::new(ScriptedLobby::default());
        let ports = Ports {
            auth: Arc::new(FakeAuth {
                player: Player::new(7, "Ada"),
                delay: Duration::ZERO,
                fail_with: None,
            }),
            web_link: link.clone(),
            lobby: lobby.clone(),
            ..fake_ports()
        };
        let (app, app_loop) = App::new("test", ports);
        tokio::spawn(app_loop.run());
        let h = Self { app, link, lobby };
        h.app
            .dispatch_and_wait(AuthCommand::Login { remember: false }.into())
            .await
            .unwrap();
        h.app.dispatch(LobbyCommand::Connect.into()).await.unwrap();
        for _ in 0..200 {
            if h.lobby.updates.lock().unwrap().is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        h.push(LobbyUpdate::Authenticated).await;
        h.push(LobbyUpdate::MatchmakerQueues(vec![
            queue("ladder1v1", 1),
            queue("tmm2v2", 2),
        ]))
        .await;
        h.push(LobbyUpdate::Games(vec![
            lobby_game(11, "Setons", false),
            lobby_game(12, "Private", true),
        ]))
        .await;
        h
    }

    async fn push(&self, update: LobbyUpdate) {
        let sender = self.lobby.updates.lock().unwrap().clone();
        sender.expect("connected").send(update).await.unwrap();
    }

    async fn set_enabled(&self, enabled: bool) {
        self.app
            .dispatch_and_wait(
                SettingsCommand::PatchWebLink {
                    patch: WebLinkPreferencesPatch {
                        enabled: Some(enabled),
                    },
                }
                .into(),
            )
            .await
            .unwrap();
    }

    fn connects(&self) -> u32 {
        *self.link.connects.lock().unwrap()
    }

    async fn connection(&self) -> ServerEnd {
        for _ in 0..300 {
            if let Some(end) = self.link.ends.lock().unwrap().pop() {
                return end;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("the link never connected");
    }

    fn notified(&self) -> Vec<String> {
        self.app
            .snapshot()
            .notifications
            .items
            .iter()
            .filter(|item| item.kind == NotificationKind::WebLink)
            .map(|item| item.title.clone())
            .collect()
    }
}

/// The next message the client sends that `pick` accepts, within two seconds.
async fn expect<T>(end: &mut ServerEnd, mut pick: impl FnMut(Outbound) -> Option<T>) -> T {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    loop {
        let message = tokio::time::timeout_at(deadline, end.from_client.recv())
            .await
            .expect("the client sent nothing that was expected")
            .expect("the connection closed");
        if let Some(found) = pick(message) {
            return found;
        }
    }
}

async fn result(end: &mut ServerEnd, id: &str, command: Value) -> (bool, Option<String>) {
    end.to_client
        .send(Inbound::Command {
            id: id.into(),
            command,
        })
        .await
        .unwrap();
    let wanted = id.to_string();
    expect(end, |message| match message {
        Outbound::Result { id, ok, error } if id == wanted => Some((ok, error)),
        _ => None,
    })
    .await
}

#[tokio::test]
async fn nothing_connects_until_the_player_turns_it_on() {
    let h = Harness::start(1).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(h.connects(), 0, "off by default");

    h.set_enabled(true).await;
    let mut end = h.connection().await;
    let state = expect(&mut end, |message| match message {
        Outbound::State { state } => Some(state),
        _ => None,
    })
    .await;
    assert_eq!(state.player.as_ref().map(|p| p.name.as_str()), Some("Ada"));
    assert_eq!(state.lobby, "connected");
    assert_eq!(state.queues.len(), 2);
    let games = expect(&mut end, |message| match message {
        Outbound::Games { games } => Some(games),
        _ => None,
    })
    .await;
    assert_eq!(games.len(), 2);
    assert_eq!(h.notified(), ["Connected to the web client"]);

    // Turned off again: the connection is let go.
    h.set_enabled(false).await;
    let closed = tokio::time::timeout(Duration::from_secs(2), async {
        while end.from_client.recv().await.is_some() {}
    })
    .await;
    assert!(closed.is_ok(), "the link closes when it is turned off");
}

#[tokio::test]
async fn a_browsers_requests_are_checked_then_run_like_the_play_tabs() {
    let h = Harness::start(1).await;
    h.set_enabled(true).await;
    let mut end = h.connection().await;

    let (ok, error) = result(&mut end, "c1", json!({"action": "host", "title": "x"})).await;
    assert!(!ok && error.is_some(), "anything but the four is refused");

    let (ok, error) = result(&mut end, "c2", json!({"action": "joinGame", "gameId": 12})).await;
    assert!(!ok, "a locked lobby needs its password: {error:?}");

    let (ok, _) = result(
        &mut end,
        "c3",
        json!({"action": "joinGame", "gameId": 12, "password": "pw"}),
    )
    .await;
    assert!(ok);
    for _ in 0..200 {
        if !h.lobby.joins.lock().unwrap().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(
        h.lobby.joins.lock().unwrap().as_slice(),
        [(12, Some("pw".to_string()))],
        "the join reached the lobby with its password"
    );
    assert!(h
        .notified()
        .contains(&"Joining a game from the web client".to_string()));
}

#[tokio::test]
async fn stopping_a_search_leaves_its_queues() {
    let h = Harness::start(1).await;
    h.set_enabled(true).await;
    let mut end = h.connection().await;
    h.push(LobbyUpdate::Matchmaking(MatchmakingState::Searching {
        queue_names: vec!["ladder1v1".into()],
    }))
    .await;
    tokio::time::sleep(Duration::from_millis(100)).await;

    let (ok, error) = result(&mut end, "s1", json!({"action": "stopSearch"})).await;
    assert!(ok, "{error:?}");
    for _ in 0..200 {
        if !h.lobby.stops.lock().unwrap().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(
        h.lobby.stops.lock().unwrap().as_slice(),
        ["ladder1v1".to_string()]
    );
}

#[tokio::test]
async fn a_match_found_is_sent_even_with_no_browser_open() {
    // No browser: nothing is published, but the phone still has to hear it.
    let h = Harness::start(0).await;
    h.set_enabled(true).await;
    let mut end = h.connection().await;
    h.push(LobbyUpdate::Matchmaking(MatchmakingState::Searching {
        queue_names: vec!["ladder1v1".into()],
    }))
    .await;
    h.push(LobbyUpdate::Matchmaking(MatchmakingState::MatchFound {
        queue_name: "ladder1v1".into(),
    }))
    .await;
    let (queue, title) = expect(&mut end, |message| match message {
        Outbound::Event {
            event,
            queue,
            title,
            ..
        } if event == "matchFound" => Some((queue, title)),
        _ => None,
    })
    .await;
    assert_eq!(queue.as_deref(), Some("ladder1v1"));
    // Named the way the Play tab names it, so the phone does not have to know.
    assert_eq!(title.as_deref(), Some("1 vs 1"));
}

#[tokio::test]
async fn a_join_from_the_web_that_stops_short_tells_the_phone() {
    let h = Harness::start(1).await;
    h.set_enabled(true).await;
    let mut end = h.connection().await;

    // A join started at the PC that fails is the player's own business: they
    // are sitting in front of it.
    h.app
        .dispatch(
            LobbyCommand::Join {
                id: 11,
                password: None,
                replace_mods: false,
            }
            .into(),
        )
        .await
        .unwrap();
    for _ in 0..200 {
        if !h.lobby.joins.lock().unwrap().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    h.push(LobbyUpdate::JoinFailed {
        id: 11,
        reason: "Refused at the desk".into(),
    })
    .await;
    tokio::time::sleep(Duration::from_millis(100)).await;

    // The same from the web client: the phone hears why.
    let (ok, error) = result(
        &mut end,
        "j1",
        json!({"action": "joinGame", "gameId": 12, "password": "wrong"}),
    )
    .await;
    assert!(ok, "{error:?}");
    for _ in 0..200 {
        if h.lobby.joins.lock().unwrap().len() == 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    h.push(LobbyUpdate::JoinFailed {
        id: 12,
        reason: "Bad password".into(),
    })
    .await;
    // The state goes first, so a browser that is open shows the failure by
    // the time the notification arrives.
    let mut shown = None;
    let reason = expect(&mut end, |message| match message {
        Outbound::State { state } => {
            shown = state.game;
            None
        }
        Outbound::Event { event, reason, .. } if event == "attention" => Some(reason),
        _ => None,
    })
    .await
    .unwrap_or_default();
    assert!(
        reason.contains("Bad password"),
        "the first attention is the web join's, not the desk's: {reason}"
    );
    let game = shown.expect("the failed join is shown");
    assert_eq!(game.status, "failed");
    assert!(game.problem.unwrap_or_default().contains("Bad password"));
}

#[tokio::test]
async fn a_browser_arriving_gets_the_whole_state() {
    let h = Harness::start(0).await;
    h.set_enabled(true).await;
    let mut end = h.connection().await;
    // Nothing goes out while nobody is looking.
    let quiet = tokio::time::timeout(Duration::from_millis(1200), end.from_client.recv()).await;
    assert!(quiet.is_err(), "no browser, no state");

    end.to_client
        .send(Inbound::Browsers { count: 1 })
        .await
        .unwrap();
    expect(&mut end, |message| match message {
        Outbound::State { .. } => Some(()),
        _ => None,
    })
    .await;
}
