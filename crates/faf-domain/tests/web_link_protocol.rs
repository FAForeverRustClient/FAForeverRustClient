//! `docs/web-link-protocol.json`: the web link's messages as this client
//! sends and reads them, written out from the types in
//! `faf_domain::protocol::web_link`.
//!
//! The other end of the link, the web client's server (FAForever/faf-webclient,
//! `lib/link.js`), is JavaScript in another repository, so neither side's
//! compiler or CI sees the other. The web client's tests read this file from a
//! pinned commit of this repository and check their server against it: that
//! it reads these messages, sends the ones this client reads, and passes on
//! exactly the requests this client accepts, in the same shape. A change on
//! either side then fails the other's tests instead of a player's link.
//!
//! `cargo test -p faf-domain --test web_link_protocol` fails while the file is
//! out of date; `cargo test -p faf-domain --test web_link_protocol --
//! --ignored` writes it.

use std::collections::BTreeMap;

use faf_domain::protocol::web_link::{
    attention, attention_event, decode, games, hello, match_found_event, plan, snapshot, Inbound,
    Outbound, RemoteCommand, MAX_PASSWORD_CHARS, MAX_PROBLEM_CHARS, MAX_QUEUES,
    MAX_QUEUE_NAME_BYTES, PROTOCOL_VERSION,
};
use faf_domain::state::{
    Game, JoinState, LobbyStatus, MatchmakerQueue, MatchmakingState, PartyMember, PartyState,
    Player, PlayerProfile,
};
use faf_domain::AppState;
use serde::Serialize;
use serde_json::{json, Value};

const PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../docs/web-link-protocol.json"
);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    about: &'static str,
    version: u32,
    limits: Limits,
    /// One of each message this client sends.
    outbound: BTreeMap<&'static str, Outbound>,
    /// One of each message this client reads from the server. Each decodes
    /// here as its name says; anything else from the server is ignored.
    inbound: BTreeMap<&'static str, Value>,
    /// Requests as a browser might send them, and what each becomes once this
    /// client has read it: the one shape the server passes on, or `null` for a
    /// request that must be refused.
    commands: Vec<CommandCase>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Limits {
    max_queues: usize,
    max_queue_name_bytes: usize,
    /// Characters (code points), not bytes or UTF-16 units.
    max_password_chars: usize,
    /// The longest `reason` an `attention` event or a game's `problem` has.
    max_problem_chars: usize,
    min_game_id: i32,
    max_game_id: i32,
}

#[derive(Serialize)]
struct CommandCase {
    name: &'static str,
    request: Value,
    accepted: Option<Value>,
}

fn queue(name: &str, team_size: i32, players: i32, pops_at: &str) -> MatchmakerQueue {
    MatchmakerQueue {
        queue_name: name.into(),
        team_size,
        num_players: players,
        queue_pop_time_seconds: 30,
        queue_pops_at: pops_at.into(),
        boundary_80s: Vec::new(),
        boundary_75s: Vec::new(),
    }
}

fn game(id: i32, title: &str, players: &[&str]) -> Game {
    let mut teams = BTreeMap::new();
    teams.insert(
        "1".to_string(),
        players.iter().map(|p| p.to_string()).collect(),
    );
    teams.insert("2".to_string(), Vec::new());
    Game {
        id,
        title: title.into(),
        host: players.first().map(|p| p.to_string()).unwrap_or_default(),
        players: players.len() as i32,
        max_players: 8,
        map: "setons_clutch".into(),
        mod_name: "faf".into(),
        average_rating: 1200,
        rating_type: "global".into(),
        password_protected: false,
        visibility: "public".into(),
        game_type: "custom".into(),
        launched_at: None,
        hosted_at: Some("2026-11-13T18:00:00Z".into()),
        rating_min: None,
        rating_max: None,
        enforce_rating_range: false,
        teams,
        sim_mods: BTreeMap::new(),
    }
}

/// A signed-in player in a party, searching, with friends in and out of games
/// and a join that stopped at a decision: every field of the snapshot set.
fn busy() -> AppState {
    let mut state = AppState::default();
    state.settings.web_link.enabled = true;
    state.auth.player = Some(Player {
        id: 7,
        name: "Nuggets".into(),
        roles: Vec::new(),
    });
    state.lobby.status = LobbyStatus::Connected;
    state.lobby.matchmaker_queues = vec![
        queue("ladder1v1", 1, 12, "2026-11-13T18:05:00Z"),
        queue("tmm2v2", 2, 4, ""),
    ];
    state.lobby.matchmaking = MatchmakingState::Searching {
        queue_names: vec!["tmm2v2".into()],
    };
    state.lobby.party = PartyState {
        owner_id: Some(7),
        members: vec![
            PartyMember {
                player_id: 7,
                name: "Nuggets".into(),
                factions: Vec::new(),
            },
            PartyMember {
                player_id: 8,
                name: "Deli".into(),
                factions: Vec::new(),
            },
        ],
    };
    let mut locked = game(12, "Private", &["Abe"]);
    locked.password_protected = true;
    locked.rating_min = Some(800);
    locked.rating_max = Some(1600);
    locked.enforce_rating_range = true;
    locked
        .sim_mods
        .insert("uid-1".into(), "Supreme Economy".into());
    state.lobby.games = vec![game(11, "Setons", &["Deli"]), locked];
    state.lobby.live_games = vec![game(20, "Ladder", &["Zed"])];
    state.lobby.join = JoinState::NeedsModReplacement {
        id: 12,
        conflicts: Vec::new(),
    };
    state.social.friends = vec!["Zed".into(), "Deli".into(), "Abe".into()];
    state.social.players = ["Zed", "Deli"]
        .iter()
        .map(|login| PlayerProfile {
            login: login.to_string(),
            ..PlayerProfile::default()
        })
        .collect();
    state
}

fn outbound() -> BTreeMap<&'static str, Outbound> {
    let state = busy();
    let joining = JoinState::Joining {
        id: 12,
        prepared: false,
    };
    let refused = plan(
        &RemoteCommand::JoinGame {
            game_id: 99,
            password: None,
        },
        &state,
    )
    .expect_err("a lobby that is not open");
    BTreeMap::from([
        (
            "hello",
            hello("<OIDC ID token>".into(), "FAF Rust client 1.2.3".into()),
        ),
        (
            "state",
            Outbound::State {
                state: snapshot(&state),
            },
        ),
        // Nobody signed in yet, the lobby down: every optional field empty.
        (
            "stateEmpty",
            Outbound::State {
                state: snapshot(&AppState::default()),
            },
        ),
        (
            "games",
            Outbound::Games {
                games: games(&state),
            },
        ),
        ("matchFound", match_found_event("tmm2v2".into(), &state)),
        // A queue this client was never told about has no title.
        (
            "matchFoundUnknownQueue",
            match_found_event("tmm4v4_share_until_death".into(), &state),
        ),
        (
            "attention",
            attention_event(attention(&joining, &state.lobby.join).expect("a decision")),
        ),
        (
            "attentionFailed",
            attention_event(
                attention(
                    &joining,
                    &JoinState::Failed {
                        id: 12,
                        reason: "Bad password".into(),
                    },
                )
                .expect("a failure"),
            ),
        ),
        (
            "resultOk",
            Outbound::Result {
                id: "c1".into(),
                ok: true,
                error: None,
            },
        ),
        (
            "resultRefused",
            Outbound::Result {
                id: "c2".into(),
                ok: false,
                error: Some(refused),
            },
        ),
    ])
}

/// What the server sends, each with what this client makes of it.
fn inbound() -> Vec<(&'static str, Value, Inbound)> {
    vec![
        (
            "welcome",
            json!({"type": "welcome", "version": 1, "browsers": 2}),
            Inbound::Welcome { browsers: 2 },
        ),
        (
            "browsers",
            json!({"type": "browsers", "count": 0}),
            Inbound::Browsers { count: 0 },
        ),
        (
            "command",
            json!({"type": "command", "id": "c1", "command": {"action": "refresh"}}),
            Inbound::Command {
                id: "c1".into(),
                command: json!({"action": "refresh"}),
            },
        ),
        ("replaced", json!({"type": "replaced"}), Inbound::Replaced),
        (
            "error",
            json!({"type": "error", "code": "token", "message": "Log in again."}),
            Inbound::Error {
                code: "token".into(),
                message: "Log in again.".into(),
            },
        ),
    ]
}

fn commands() -> Vec<CommandCase> {
    let accepted = |name, request: Value, wire: Value| CommandCase {
        name,
        request,
        accepted: Some(wire),
    };
    let same = |name, request: Value| CommandCase {
        name,
        accepted: Some(request.clone()),
        request,
    };
    let refused = |name, request: Value| CommandCase {
        name,
        request,
        accepted: None,
    };
    let nine: Vec<String> = (1..=9).map(|n| format!("queue{n}")).collect();
    vec![
        same(
            "startSearch",
            json!({"action": "startSearch", "queues": ["ladder1v1"]}),
        ),
        accepted(
            "startSearch drops repeats, keeping the first",
            json!({"action": "startSearch", "queues": ["tmm2v2", "ladder1v1", "tmm2v2"]}),
            json!({"action": "startSearch", "queues": ["tmm2v2", "ladder1v1"]}),
        ),
        accepted(
            "startSearch drops fields it does not know",
            json!({"action": "startSearch", "queues": ["ladder1v1"], "map": "x"}),
            json!({"action": "startSearch", "queues": ["ladder1v1"]}),
        ),
        same(
            "startSearch with the most queues",
            json!({"action": "startSearch", "queues": nine[..8]}),
        ),
        refused(
            "startSearch with too many queues",
            json!({"action": "startSearch", "queues": nine}),
        ),
        refused(
            "startSearch with no queues",
            json!({"action": "startSearch", "queues": []}),
        ),
        refused(
            "startSearch without queues",
            json!({"action": "startSearch"}),
        ),
        refused(
            "startSearch with queues not a list",
            json!({"action": "startSearch", "queues": "ladder1v1"}),
        ),
        refused(
            "startSearch with a queue name that is not plain",
            json!({"action": "startSearch", "queues": ["ladder 1v1"]}),
        ),
        refused(
            "startSearch with an empty queue name",
            json!({"action": "startSearch", "queues": [""]}),
        ),
        same(
            "startSearch with the longest queue name",
            json!({"action": "startSearch", "queues": ["q".repeat(MAX_QUEUE_NAME_BYTES)]}),
        ),
        refused(
            "startSearch with a queue name too long",
            json!({"action": "startSearch", "queues": ["q".repeat(MAX_QUEUE_NAME_BYTES + 1)]}),
        ),
        refused(
            "startSearch with a queue that is not a string",
            json!({"action": "startSearch", "queues": [1]}),
        ),
        same("stopSearch, every queue", json!({"action": "stopSearch"})),
        accepted(
            "stopSearch with queues null is every queue",
            json!({"action": "stopSearch", "queues": null}),
            json!({"action": "stopSearch"}),
        ),
        same(
            "stopSearch, one queue",
            json!({"action": "stopSearch", "queues": ["tmm2v2"]}),
        ),
        accepted(
            "stopSearch drops repeats",
            json!({"action": "stopSearch", "queues": ["tmm2v2", "tmm2v2"]}),
            json!({"action": "stopSearch", "queues": ["tmm2v2"]}),
        ),
        same(
            "stopSearch with an empty list stops nothing",
            json!({"action": "stopSearch", "queues": []}),
        ),
        refused(
            "stopSearch with queues not a list",
            json!({"action": "stopSearch", "queues": "tmm2v2"}),
        ),
        refused(
            "stopSearch with a queue name that is not plain",
            json!({"action": "stopSearch", "queues": ["tmm-2v2"]}),
        ),
        same("joinGame", json!({"action": "joinGame", "gameId": 42})),
        same(
            "joinGame with a password",
            json!({"action": "joinGame", "gameId": 42, "password": "pw"}),
        ),
        accepted(
            "joinGame with a whole number written as a decimal",
            json!({"action": "joinGame", "gameId": 42.0}),
            json!({"action": "joinGame", "gameId": 42}),
        ),
        accepted(
            "joinGame with an empty password has none",
            json!({"action": "joinGame", "gameId": 42, "password": ""}),
            json!({"action": "joinGame", "gameId": 42}),
        ),
        accepted(
            "joinGame with a null password has none",
            json!({"action": "joinGame", "gameId": 42, "password": null}),
            json!({"action": "joinGame", "gameId": 42}),
        ),
        same(
            "joinGame with the largest id",
            json!({"action": "joinGame", "gameId": i32::MAX}),
        ),
        refused(
            "joinGame with an id too large",
            json!({"action": "joinGame", "gameId": i64::from(i32::MAX) + 1}),
        ),
        refused(
            "joinGame with id 0",
            json!({"action": "joinGame", "gameId": 0}),
        ),
        refused(
            "joinGame with a negative id",
            json!({"action": "joinGame", "gameId": -1}),
        ),
        refused(
            "joinGame with a fractional id",
            json!({"action": "joinGame", "gameId": 1.5}),
        ),
        refused(
            "joinGame with the id as a string",
            json!({"action": "joinGame", "gameId": "42"}),
        ),
        refused("joinGame without an id", json!({"action": "joinGame"})),
        // Counted in characters: each of these is one character, two UTF-16
        // units and four bytes.
        same(
            "joinGame with the longest password, in characters",
            json!({"action": "joinGame", "gameId": 42, "password": "😀".repeat(MAX_PASSWORD_CHARS)}),
        ),
        refused(
            "joinGame with a password too long",
            json!({"action": "joinGame", "gameId": 42, "password": "a".repeat(MAX_PASSWORD_CHARS + 1)}),
        ),
        refused(
            "joinGame with a password that is not a string",
            json!({"action": "joinGame", "gameId": 42, "password": 1234}),
        ),
        same("refresh", json!({"action": "refresh"})),
        accepted(
            "refresh drops fields it does not know",
            json!({"action": "refresh", "everything": true}),
            json!({"action": "refresh"}),
        ),
        refused("anything else", json!({"action": "host", "title": "x"})),
        refused("no action", json!({"queues": ["ladder1v1"]})),
        refused("an action that is not a string", json!({"action": 1})),
        refused("not an object", json!("startSearch")),
        refused("a list", json!([{"action": "refresh"}])),
    ]
}

fn fixture() -> Fixture {
    let inbound = inbound();
    for (name, value, expected) in &inbound {
        assert_eq!(
            decode(&value.to_string()).as_ref(),
            Some(expected),
            "{name} decodes as written"
        );
    }
    let commands = commands();
    for case in &commands {
        let read = RemoteCommand::parse(&case.request).map(|command| command.to_wire());
        assert_eq!(read, case.accepted, "{}", case.name);
        // What the server passes on reads back as itself.
        if let Some(wire) = &case.accepted {
            assert_eq!(
                RemoteCommand::parse(wire)
                    .map(|command| command.to_wire())
                    .as_ref(),
                Some(wire),
                "{}",
                case.name
            );
        }
    }
    Fixture {
        about: "Generated by crates/faf-domain/tests/web_link_protocol.rs from faf_domain::protocol::web_link. Do not edit by hand. FAForever/faf-webclient checks its server (lib/link.js) against this file at a pinned commit.",
        version: PROTOCOL_VERSION,
        limits: Limits {
            max_queues: MAX_QUEUES,
            max_queue_name_bytes: MAX_QUEUE_NAME_BYTES,
            max_password_chars: MAX_PASSWORD_CHARS,
            max_problem_chars: MAX_PROBLEM_CHARS,
            min_game_id: 1,
            max_game_id: i32::MAX,
        },
        outbound: outbound(),
        inbound: inbound
            .into_iter()
            .map(|(name, value, _)| (name, value))
            .collect(),
        commands,
    }
}

fn render() -> String {
    let mut text = serde_json::to_string_pretty(&fixture()).expect("serialisable");
    text.push('\n');
    text
}

#[test]
fn the_protocol_fixture_is_up_to_date() {
    let written = std::fs::read_to_string(PATH).unwrap_or_default();
    // Git may hand the file over with Windows line ends.
    let written = written.replace("\r\n", "\n");
    assert!(
        written == render(),
        "docs/web-link-protocol.json is out of date with faf_domain::protocol::web_link. \
         Run `cargo test -p faf-domain --test web_link_protocol -- --ignored` and commit the \
         result, then tell FAForever/faf-webclient: its tests read this file."
    );
}

#[test]
#[ignore = "writes docs/web-link-protocol.json"]
fn regenerate_the_protocol_fixture() {
    std::fs::write(PATH, render()).expect("docs/ is writable");
}

#[test]
fn the_hello_carries_no_access_token_and_nothing_about_the_computer() {
    let fixture: Value = serde_json::from_str(&render()).unwrap();
    let hello = &fixture["outbound"]["hello"];
    let mut keys: Vec<&str> = hello
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(keys, ["client", "role", "token", "type", "version"]);
}
