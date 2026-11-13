use chrono::{DateTime, Utc};
use serde_json::{json, Value};

use super::client::*;
use super::game::*;
use super::matchmaker::*;
use super::notice::*;
use super::player::*;
use super::server::*;
use super::*;
use crate::state::{HostGameConfig, PartyState, PlayerVeto, RatingRange, Relation};

/// An arrival time for the messages whose reading depends on one.
fn noon() -> DateTime<Utc> {
    DateTime::parse_from_rfc3339("2026-10-01T12:00:00Z")
        .unwrap()
        .with_timezone(&Utc)
}

fn decode(value: Value) -> ServerMessage {
    ServerMessage::decode(&value, noon())
}

fn open_game_json(uid: i32, state: &str, players: i32) -> Value {
    json!({
        "command": "game_info",
        "uid": uid,
        "state": state,
        "num_players": players,
        "max_players": 8,
        "title": format!("Game {uid}"),
        "host": "Stormlord",
        "mapname": "Theta Passage",
        "launched_at": 1_700_000_000.4,
    })
}

/// The frame that puts a running game back on a replacement socket.
///
/// The server ties a player's game connection to the socket the game was
/// launched on, so losing that socket -- a drop, or Disconnect followed by
/// Reconnect -- leaves the running game relayed for nobody and the players
/// unable to reconnect to each other. `server/lobbyconnection.py` reads
/// exactly these two keys.
#[test]
fn restoring_a_game_session_names_the_game_by_number() {
    let frame = restore_game_session_frame(12345);
    assert_eq!(
        frame["command"],
        Value::String("restore_game_session".into())
    );
    assert_eq!(frame["game_id"], Value::from(12345));
}

#[test]
fn hosting_without_a_password_sends_null_rather_than_an_empty_string() {
    let mut config = HostGameConfig {
        title: "Aeolus".into(),
        mod_name: "faf".into(),
        visibility: "public".into(),
        map: "scmp_007".into(),
        password: None,
        enforce_rating_range: false,
        rating_min: None,
        rating_max: None,
    };

    // The server stores whatever arrives and advertises the game as
    // protected when it is not null, so an empty string locks a game that
    // nobody, including the host, has a password for.
    let open = host_frame(config.clone());
    assert_eq!(open["password"], Value::Null);
    assert!(open["rating_min"].is_null());

    config.password = Some("hunter2".into());
    let locked = host_frame(config);
    assert_eq!(locked["password"], Value::String("hunter2".into()));
}

#[test]
fn server_notices_preserve_actions_and_bound_untrusted_text() {
    let (style, text) = parse_server_notice(&json!({
        "style": "kill",
        "text": "  maintenance  "
    }));
    assert_eq!(style, ServerNoticeStyle::Kill);
    assert_eq!(text, "maintenance");

    let oversized = "ü".repeat(MAX_SERVER_MESSAGE_CHARS + 10);
    let (_, text) = parse_server_notice(&json!({ "style": "warning", "text": oversized }));
    assert_eq!(text.chars().count(), MAX_SERVER_MESSAGE_CHARS);
    assert!(text.is_char_boundary(text.len()));
}

#[test]
fn only_the_unofficial_client_greeting_is_dropped() {
    let greeting = "You are using an unofficial client version! Some features might not             work as expected. If you experience any problems please download the latest             version of the official client from <a href=\"https://www.faforever.com\">";
    assert!(is_unofficial_client_notice(
        ServerNoticeStyle::Info,
        greeting
    ));
    // The same words as a warning are something the server chose to escalate.
    assert!(!is_unofficial_client_notice(
        ServerNoticeStyle::Warning,
        greeting
    ));
    assert!(!is_unofficial_client_notice(
        ServerNoticeStyle::Info,
        "The server restarts in 10 minutes."
    ));
}

/// `BanError.message()` in the lobby server, as it reaches the client.
const BAN_TEXT: &str = "You are banned from FAF forever. <br>Reason: <br>Asked for it<br><br>\
    <i>If you would like to appeal this ban, please send an email to: \
    moderation@faforever.com</i>";

#[test]
fn a_ban_is_told_apart_from_a_refused_request() {
    assert!(is_ban_notice(ServerNoticeStyle::Error, BAN_TEXT));
    assert!(is_ban_notice(
        ServerNoticeStyle::Error,
        "  You are banned from FAF for 3 days. <br>Reason: <br>smurfing"
    ));
    // The same server sends `error` notices it means as a refusal, with
    // the connection left open; those are not a ban.
    assert!(!is_ban_notice(
        ServerNoticeStyle::Error,
        "You are already in a game"
    ));
    assert!(!is_ban_notice(ServerNoticeStyle::Info, BAN_TEXT));
}

#[test]
fn a_ban_reads_as_plain_text() {
    assert_eq!(
        plain_notice_text(BAN_TEXT),
        "You are banned from FAF forever.\nReason:\nAsked for it\n\n\
         If you would like to appeal this ban, please send an email to: \
         moderation@faforever.com"
    );
    assert_eq!(plain_notice_text("a < b"), "a < b");
    assert_eq!(
        plain_notice_text("one<br/>two<BR >three"),
        "one\ntwo\nthree"
    );
}

#[test]
fn unknown_notice_styles_are_safe_info_and_missing_text_has_context() {
    assert_eq!(
        parse_server_notice(&json!({ "style": "future-style" })),
        (
            ServerNoticeStyle::Info,
            "The lobby server sent a notice.".into()
        )
    );
    assert_eq!(
        server_text(&json!({ "text": "  " }), "fallback"),
        "fallback"
    );
}

#[test]
fn relation_frames_match_the_server_protocol() {
    assert_eq!(
        relation_frame(7, Relation::Friend, true),
        json!({ "command": "social_add", "friend": 7 })
    );
    assert_eq!(
        relation_frame(7, Relation::Foe, true),
        json!({ "command": "social_add", "foe": 7 })
    );
    assert_eq!(
        relation_frame(7, Relation::Friend, false),
        json!({ "command": "social_remove", "friend": 7 })
    );
    assert_eq!(
        relation_frame(7, Relation::Foe, false),
        json!({ "command": "social_remove", "foe": 7 })
    );
}

#[test]
fn the_keepalive_is_the_same_command_the_reference_client_sends() {
    // The lobby answers this with `pong`, which the receive loop drops
    // through its catch-all arm: every frame resets the timer, so the
    // answer needs no handling of its own.
    assert_eq!(ping_frame(), json!({ "command": "ping" }));
}

#[test]
fn avatar_frames_match_the_reference_protocol() {
    assert_eq!(
        avatar_list_frame(),
        json!({ "command": "avatar", "action": "list_avatar" })
    );
    assert_eq!(
        avatar_select_frame(Some("https://content.test/a.png".into())),
        json!({
            "command": "avatar",
            "action": "select",
            "avatar": "https://content.test/a.png"
        })
    );
    assert_eq!(
        avatar_select_frame(None),
        json!({ "command": "avatar", "action": "select", "avatar": null })
    );
}

#[test]
fn available_avatars_are_sanitized_deduplicated_and_sorted() {
    let avatars = parse_available_avatars(&json!({
        "command": "avatar",
        "avatarlist": [
            { "url": "https://content.test/z.png", "tooltip": "Zulu" },
            { "url": "", "tooltip": "Invalid" },
            { "url": "https://content.test/a.png", "tooltip": "Alpha" },
            { "url": "https://content.test/a.png", "tooltip": "Duplicate" }
        ]
    }));
    assert_eq!(avatars.len(), 2);
    assert_eq!(avatars[0].tooltip, "Alpha");
    assert_eq!(avatars[1].tooltip, "Zulu");
}

#[test]
fn faction_frame_matches_the_server_protocol() {
    assert_eq!(
        party_factions_frame(vec!["UEF".into(), "Cybran".into()]),
        json!({
            "command": "set_party_factions",
            "factions": ["uef", "cybran"],
        })
    );
}

#[test]
fn parses_server_veto_allocations() {
    let vetoes = parse_vetoes(&json!({
        "vetoes": [{
            "matchmaker_queue_map_pool_id": 4,
            "map_pool_map_version_id": 91,
            "veto_tokens_applied": 2
        }]
    }));
    assert_eq!(vetoes.len(), 1);
    assert_eq!(vetoes[0].matchmaker_queue_map_pool_id, 4);
    assert_eq!(vetoes[0].map_pool_map_version_id, 91);
    assert_eq!(vetoes[0].veto_tokens_applied, 2);
}

#[test]
fn extracts_single_game() {
    let raws = games_in(&open_game_json(7, "open", 3));
    assert_eq!(raws.len(), 1);
    assert_eq!(raws[0].uid, Some(7));
    assert_eq!(raws[0].num_players, Some(3));
}

#[test]
fn extracts_batched_games() {
    let msg = json!({
        "command": "game_info",
        "games": [open_game_json(1, "open", 1), open_game_json(2, "open", 2)],
    });
    let raws = games_in(&msg);
    assert_eq!(raws.len(), 2);
    assert_eq!(raws[1].uid, Some(2));
}

#[test]
fn raw_game_maps_to_domain_game() {
    let raw = games_in(&open_game_json(42, "open", 5)).pop().unwrap();
    let game = raw.into_game(&PlayerRatings::new()).unwrap();
    assert_eq!(game.id, 42);
    assert_eq!(game.players, 5);
    assert_eq!(game.max_players, 8);
    assert_eq!(game.map, "Theta Passage");
    assert_eq!(game.host, "Stormlord");
    assert_eq!(game.launched_at, Some(1_700_000_000));
}

#[test]
fn a_rating_below_zero_is_kept_rather_than_flattened() {
    // The displayed rating of a new or long-idle account. The server's own
    // `displayed()` does not clamp it, the website prints it, and the
    // profile card in this client already showed it: only the lobby lists
    // clamped, so one player read -137 in one place and 0 in the other.
    let ratings = player_lobby_ratings(&json!({
        "ratings": {
            "global": { "rating": [1363.0, 500.0], "number_of_games": 3 },
        }
    }))
    .expect("a ratings table");

    assert_eq!(ratings[0].rating, -137);
}

#[test]
fn parses_the_rating_windows_a_queue_publishes() {
    let message = json!({
        "command": "matchmaker_info",
        "queues": [{
            "queue_name": "ladder1v1",
            "team_size": 1,
            "num_players": 3,
            "queue_pop_time_delta": 42.4,
            "boundary_80s": [[800, 1200], [1100.0, 1500.0]],
            // Malformed entries are dropped rather than defaulted: a
            // `0..0` window silently contains nobody, which would read as
            // a quiet queue instead of as bad data.
            "boundary_75s": [[700, 1300], [900], "nonsense", []],
        }],
    });

    let queues = parse_matchmaker_queues_at(&message, noon());
    assert_eq!(queues.len(), 1);
    assert_eq!(
        queues[0].boundary_80s,
        vec![
            RatingRange {
                min: 800,
                max: 1_200
            },
            RatingRange {
                min: 1_100,
                max: 1_500
            },
        ]
    );
    assert_eq!(
        queues[0].boundary_75s,
        vec![RatingRange {
            min: 700,
            max: 1_300
        }]
    );
}

#[test]
fn the_next_pop_is_counted_from_when_the_message_arrived() {
    let message = json!({
        "command": "matchmaker_info",
        "queues": [
            { "queue_name": "ladder1v1", "queue_pop_time_delta": 42.4 },
            { "queue_name": "tmm2v2", "queue_pop_time_delta": -3.0 },
            { "queue_name": "tmm4v4" },
        ],
    });
    let received = chrono::DateTime::parse_from_rfc3339("2026-10-01T12:00:00Z")
        .unwrap()
        .with_timezone(&chrono::Utc);

    let queues = parse_matchmaker_queues_at(&message, received);

    assert_eq!(queues[0].queue_pops_at, "2026-10-01T12:00:42.400Z");
    assert_eq!(queues[1].queue_pops_at, "2026-10-01T12:00:00.000Z");
    assert_eq!(queues[2].queue_pops_at, "");
}

#[test]
fn a_queue_without_rating_windows_still_parses() {
    // Older servers, and any queue the server has nothing queued for.
    let message = json!({
        "command": "matchmaker_info",
        "queues": [{ "queue_name": "tmm2v2", "team_size": 2, "num_players": 0 }],
    });
    let queues = parse_matchmaker_queues_at(&message, noon());
    assert_eq!(queues.len(), 1);
    assert!(queues[0].boundary_80s.is_empty());
    assert!(queues[0].boundary_75s.is_empty());
}

#[test]
fn parses_game_launch_with_mixed_args() {
    let msg = json!({
        "command": "game_launch",
        "uid": 12345,
        "mod": "faf",
        "name": "Big Team Game",
        "mapname": "scmp_009",
        "game_type": "matchmaker",
        "rating_type": "ladder_1v1",
        "expected_players": 2,
        "team": 1,
        "faction": 3,
        "map_position": 2,
        "game_options": { "Timeouts": 3, "Share": "FullShare" },
        "args": ["/numgames", 137, "/init", true],
    });
    let launch = parse_game_launch(&msg).expect("should parse");
    assert_eq!(launch.uid, 12345);
    assert_eq!(launch.mod_name, "faf"); // `mod` renamed
    assert_eq!(launch.name, "Big Team Game");
    assert_eq!(launch.mapname, "scmp_009");
    assert_eq!(launch.game_type, "matchmaker");
    assert_eq!(launch.rating_type, "ladder_1v1");
    assert_eq!(launch.expected_players, Some(2));
    assert_eq!(launch.team, Some(1));
    assert_eq!(launch.faction, Some(3));
    assert_eq!(launch.map_position, Some(2));
    assert_eq!(
        launch.game_options.get("Timeouts").map(String::as_str),
        Some("3")
    );
    assert_eq!(
        launch.game_options.get("Share").map(String::as_str),
        Some("FullShare")
    );
    // Mixed string/number/bool args all stringified.
    assert_eq!(launch.args, vec!["/numgames", "137", "/init", "true"]);
}

#[test]
fn game_launch_requires_uid_but_tolerates_missing_optionals() {
    // No uid → cannot parse.
    assert!(parse_game_launch(&json!({ "command": "game_launch" })).is_none());

    // uid only → everything else defaults gracefully.
    let launch = parse_game_launch(&json!({ "uid": 7 })).expect("uid is enough");
    assert_eq!(launch.uid, 7);
    assert_eq!(launch.mod_name, "");
    assert!(launch.args.is_empty());
}

#[test]
fn session_to_string_handles_number_and_string() {
    assert_eq!(session_to_string(&json!(123456)), "123456");
    assert_eq!(session_to_string(&json!("abc-789")), "abc-789");
    assert_eq!(session_to_string(&Value::Null), "");
}

#[test]
fn encodes_outgoing_lobby_messages_with_line_delimiter() {
    let encoded = encode_lobby_message(&json!({ "command": "ask_session" }));
    assert!(encoded.ends_with('\n'));
    let decoded: Value = serde_json::from_str(&encoded).expect("newline is valid JSON whitespace");
    assert_eq!(command_of(&decoded), "ask_session");
}

#[test]
fn missing_fields_default_gracefully() {
    let msg = json!({ "command": "game_info", "uid": 9, "state": "open" });
    let raws = games_in(&msg);
    assert_eq!(raws.len(), 1);
    let game = raws
        .into_iter()
        .next()
        .unwrap()
        .into_game(&PlayerRatings::new())
        .unwrap();
    assert_eq!(game.id, 9);
    assert_eq!(game.title, "");
    assert_eq!(game.max_players, 0);
}

#[test]
fn accepts_nullable_fields_from_reference_lobby_payload() {
    // The reference clients receive these fields as null for some open
    // games (notably sim_mods, visibility and game_type). A null optional
    // field must not make serde drop the entire game from the list.
    let msg = json!({
        "command": "game_info",
        "uid": 12,
        "state": "open",
        "num_players": 1,
        "max_players": 4,
        "title": "Open game",
        "host": "Commander",
        "mapname": "scmp_007",
        "featured_mod": "faf",
        "password_protected": false,
        "visibility": null,
        "game_type": null,
        "sim_mods": null,
        "teams": null,
        "rating_min": 0,
        "rating_max": 3000
    });

    let game = games_in(&msg)
        .into_iter()
        .next()
        .and_then(|raw| raw.into_game(&PlayerRatings::new()))
        .expect("nullable game payload should be retained");
    assert_eq!(game.id, 12);
    assert_eq!(game.visibility, "public");
    assert_eq!(game.game_type, "custom");
    assert!(game.sim_mods.is_empty());
    assert!(game.teams.is_empty());
}

/// A message addressed to the game is relayed whatever it is called, with its
/// arguments in the types they came in: the GPGNet codec tells `1` from `"1"`.
#[test]
fn a_message_for_the_game_is_a_relay_before_it_is_anything_else() {
    assert_eq!(
        decode(
            json!({ "command": "ConnectToPeer", "target": "game", "args": ["Aurora", 7, true] })
        ),
        ServerMessage::GameRelay {
            command: "ConnectToPeer".into(),
            args: vec![json!("Aurora"), json!(7), json!(true)],
        }
    );
    // Even under a name this client otherwise acts on.
    assert!(matches!(
        decode(json!({ "command": "notice", "target": "game" })),
        ServerMessage::GameRelay { args, .. } if args.is_empty()
    ));
}

#[test]
fn the_handshake_reads_a_session_as_text_and_both_refusals_as_one() {
    assert_eq!(decode(json!({ "command": "ping" })), ServerMessage::Ping);
    assert_eq!(
        decode(json!({ "command": "session", "session": 123456 })),
        ServerMessage::Session {
            session: "123456".into()
        }
    );
    assert_eq!(
        decode(json!({ "command": "session" })),
        ServerMessage::Session {
            session: String::new()
        }
    );
    for refusal in ["authentication_failed", "authentication_failure"] {
        assert_eq!(
            decode(json!({ "command": refusal, "text": " Token expired " })),
            ServerMessage::AuthenticationFailed {
                reason: "Token expired".into()
            }
        );
    }
    assert_eq!(
        decode(json!({ "command": "authentication_failed" })),
        ServerMessage::AuthenticationFailed {
            reason: "The lobby server rejected authentication.".into()
        }
    );
    // The server's bare `invalid` has no words; the session supplies them
    // from when it arrived.
    assert_eq!(
        decode(json!({ "command": "invalid" })),
        ServerMessage::Invalid { text: None }
    );
    assert_eq!(
        decode(json!({ "command": "invalid", "text": "Cannot join game" })),
        ServerMessage::Invalid {
            text: Some("Cannot join game".into())
        }
    );
}

#[test]
fn welcome_carries_this_accounts_own_entry() {
    let ServerMessage::Welcome { me: Some(me) } = decode(json!({
        "command": "welcome",
        "me": { "id": 7, "login": "Aurora", "country": "DE" },
    })) else {
        panic!("a welcome with a `me`");
    };
    assert_eq!(me.id, Some(7));
    assert_eq!(me.login.as_deref(), Some("Aurora"));
    assert_eq!(
        decode(json!({ "command": "welcome" })),
        ServerMessage::Welcome { me: None }
    );
}

#[test]
fn a_player_entry_is_read_as_far_as_it_goes() {
    let entry = PlayerEntry::decode(&json!({
        "id": 7,
        "login": "Stormlord",
        "country": "DE",
        "clan": "BC",
        "avatar": { "url": "https://content.test/a.png", "tooltip": "Aeon" },
        "ratings": {
            "global": { "rating": [1800, 200], "number_of_games": 374 },
        },
    }));
    assert_eq!(entry.id, Some(7));
    assert_eq!(entry.login.as_deref(), Some("Stormlord"));
    assert!(!entry.offline);
    // As sent: lowering it for the flag files is the session's business.
    assert_eq!(entry.country, "DE");
    assert_eq!(entry.clan, "BC");
    assert_eq!(entry.avatar_url, "https://content.test/a.png");
    assert_eq!(entry.avatar_tooltip, "Aeon");
    assert_eq!(entry.rating_estimate, Some(1200));
    assert_eq!(entry.ratings.as_ref().map(Vec::len), Some(1));
    assert_eq!(entry.legacy_global_rating, None);

    // An older payload: `name` for the login, one number for the rating.
    let legacy =
        PlayerEntry::decode(&json!({ "id": 8, "name": "Legacy", "global_rating": "1234" }));
    assert_eq!(legacy.login.as_deref(), Some("Legacy"));
    assert_eq!(legacy.ratings, None, "no ratings table is not an empty one");
    assert_eq!(legacy.rating_estimate, Some(1234));
    assert_eq!(legacy.legacy_global_rating, Some(1234.0));

    // An offline notice, a null avatar, an empty name, and nothing at all.
    let gone =
        PlayerEntry::decode(&json!({ "id": 9, "login": "", "state": "offline", "avatar": null }));
    assert!(gone.offline);
    assert_eq!(gone.login, None);
    assert_eq!(gone.avatar_url, "");
    assert_eq!(PlayerEntry::decode(&Value::Null), PlayerEntry::default());
}

#[test]
fn player_info_without_a_list_of_players_says_nothing() {
    let ServerMessage::PlayerInfo { players } = decode(json!({
        "command": "player_info",
        "players": [{ "id": 1, "login": "Aurora" }, { "id": 2, "state": "offline" }],
    })) else {
        panic!("a player_info with players");
    };
    assert_eq!(players.len(), 2);
    assert!(players[1].offline);
    assert_eq!(
        decode(json!({ "command": "player_info", "id": 1, "login": "Aurora" })),
        ServerMessage::Other {
            command: "player_info".into()
        }
    );
}

#[test]
fn social_lists_take_ids_as_numbers_or_text_and_channels_under_either_name() {
    assert_eq!(
        decode(json!({
            "command": "social",
            "friends": [2, "3", "not-a-number"],
            "foes": [4],
            "autojoin": ["aeolus", 7, "german"],
        })),
        ServerMessage::Social(SocialLists {
            friends: vec![2, 3],
            foes: vec![4],
            channels: vec!["aeolus".into(), "german".into()],
        })
    );
    // The Java client's name for the same list.
    assert_eq!(
        decode(json!({ "command": "social", "channels": ["aeolus"] })),
        ServerMessage::Social(SocialLists {
            friends: vec![],
            foes: vec![],
            channels: vec!["aeolus".into()],
        })
    );
}

#[test]
fn game_messages_decode_to_games_a_launch_or_a_refusal() {
    let ServerMessage::GameInfo { games } = decode(json!({
        "command": "game_info",
        "games": [open_game_json(1, "open", 1), open_game_json(2, "playing", 2)],
    })) else {
        panic!("a batch of games");
    };
    assert_eq!(games.len(), 2);
    assert!(games[0].is_open() && games[1].is_playing());

    let ServerMessage::GameLaunch(Some(launch)) =
        decode(json!({ "command": "game_launch", "uid": 7, "mod": "faf" }))
    else {
        panic!("a launch order");
    };
    assert_eq!((launch.uid, launch.mod_name.as_str()), (7, "faf"));
    assert_eq!(
        decode(json!({ "command": "game_launch" })),
        ServerMessage::GameLaunch(None)
    );

    assert_eq!(
        decode(json!({ "command": "game_join_failed", "uid": 7, "reason": "full" })),
        ServerMessage::GameJoinFailed {
            id: 7,
            reason: "full".into()
        }
    );
    assert_eq!(
        decode(json!({ "command": "game_join_failed" })),
        ServerMessage::GameJoinFailed {
            id: 0,
            reason: "unknown".into()
        }
    );
}

#[test]
fn matchmaker_messages_decode_with_the_reference_clients_defaults() {
    let ServerMessage::MatchmakerInfo { queues } = decode(json!({
        "command": "matchmaker_info",
        "queues": [{ "queue_name": "ladder1v1", "queue_pop_time_delta": 42.4 }],
    })) else {
        panic!("the queues");
    };
    assert_eq!(queues[0].queue_pops_at, "2026-10-01T12:00:42.400Z");

    assert_eq!(
        decode(json!({ "command": "search_info", "queue_name": "ladder1v1", "state": "start" })),
        ServerMessage::SearchInfo {
            queue_name: "ladder1v1".into(),
            searching: true
        }
    );
    // Anything but `start` is not searching, a missing state included.
    assert_eq!(
        decode(json!({ "command": "search_info", "queue_name": "ladder1v1" })),
        ServerMessage::SearchInfo {
            queue_name: "ladder1v1".into(),
            searching: false
        }
    );
    assert_eq!(
        decode(json!({ "command": "match_found", "queue_name": "tmm2v2" })),
        ServerMessage::MatchFound {
            queue_name: "tmm2v2".into()
        }
    );
    assert_eq!(
        decode(json!({ "command": "match_cancelled" })),
        ServerMessage::MatchCancelled
    );
}

#[test]
fn party_and_veto_messages_decode() {
    let ServerMessage::UpdateParty(party) = decode(json!({
        "command": "update_party",
        "owner": 7,
        "members": [{ "player": 7, "factions": ["uef"] }, { "factions": ["aeon"] }],
    })) else {
        panic!("the party");
    };
    assert_eq!(party.owner_id, Some(7));
    // A member without a player id is nobody.
    assert_eq!(party.members.len(), 1);
    assert_eq!(party.members[0].name, "Player 7");
    assert_eq!(
        decode(json!({ "command": "update_party" })),
        ServerMessage::UpdateParty(PartyState::default())
    );

    // The sender under either key, as a number or as text.
    for invite in [
        json!({ "command": "party_invite", "sender": 7 }),
        json!({ "command": "party_invite", "sender_id": "7" }),
    ] {
        assert_eq!(decode(invite), ServerMessage::PartyInvite { sender_id: 7 });
    }
    assert_eq!(
        decode(json!({ "command": "party_invite" })),
        ServerMessage::PartyInvite { sender_id: 0 }
    );
    assert_eq!(
        decode(json!({ "command": "kicked_from_party" })),
        ServerMessage::KickedFromParty
    );

    assert_eq!(
        decode(json!({
            "command": "vetoes_info",
            "forced": true,
            "vetoes": [{
                "matchmaker_queue_map_pool_id": 4,
                "map_pool_map_version_id": 91,
                "veto_tokens_applied": 2,
            }],
        })),
        ServerMessage::VetoesInfo {
            vetoes: vec![PlayerVeto {
                matchmaker_queue_map_pool_id: 4,
                map_pool_map_version_id: 91,
                veto_tokens_applied: 2,
            }],
            forced: true,
        }
    );
    assert_eq!(
        decode(json!({ "command": "vetoes_info" })),
        ServerMessage::VetoesInfo {
            vetoes: vec![],
            forced: false
        }
    );
}

#[test]
fn notices_avatars_and_broker_refusals_decode() {
    let ServerMessage::Notice(notice) =
        decode(json!({ "command": "notice", "style": "error", "text": BAN_TEXT }))
    else {
        panic!("a notice");
    };
    assert!(notice.is_ban());
    assert!(!notice.is_unofficial_client_greeting());
    assert!(notice
        .plain_text()
        .starts_with("You are banned from FAF forever.\nReason:"));

    let ServerMessage::Avatars(avatars) = decode(json!({
        "command": "avatar",
        "avatarlist": [{ "url": "https://content.test/a.png", "tooltip": "Alpha" }],
    })) else {
        panic!("the avatars");
    };
    assert_eq!(avatars.len(), 1);

    assert_eq!(
        decode(json!({
            "command": "failed_message",
            "message": "no schema",
            "message_key": "request.game_join",
            "request_id": "abc",
        })),
        ServerMessage::FailedMessage {
            reason: "no schema".into(),
            key: "request.game_join".into(),
            request: "abc".into(),
        }
    );
}

/// `pong` answers the keepalive and needs no handling of its own; a command
/// from a newer server is not an error either.
#[test]
fn what_this_client_does_not_act_on_is_named_and_nothing_more() {
    for command in ["pong", "something_new"] {
        assert_eq!(
            decode(json!({ "command": command, "anything": 1 })),
            ServerMessage::Other {
                command: command.into()
            }
        );
    }
    assert_eq!(
        decode(json!({ "no": "command" })),
        ServerMessage::Other {
            command: String::new()
        }
    );
}

#[test]
fn a_frame_of_several_messages_is_split_and_what_is_not_json_is_skipped() {
    let messages = split_messages("{\"command\":\"ping\"}\n{\"command\":\"pong\"}\n");
    assert_eq!(messages.len(), 2);
    assert_eq!(command_of(&messages[1]), "pong");
    assert!(split_messages("").is_empty());
    assert!(split_messages("not json").is_empty());
}

#[test]
fn every_client_message_is_one_line_under_its_command() {
    let messages = [
        ClientMessage::AskSession {
            version: "0.9.5".into(),
            user_agent: "faf-rust-client".into(),
        },
        ClientMessage::Auth {
            token: "t".into(),
            unique_id: "u".into(),
            session: "s".into(),
        },
        ClientMessage::Ping,
        ClientMessage::Pong,
        ClientMessage::MatchmakerInfo,
        ClientMessage::MatchReady,
        ClientMessage::GameJoin {
            uid: 7,
            password: None,
        },
        ClientMessage::GameMatchmaking {
            queue_name: "ladder1v1".into(),
            searching: true,
        },
        ClientMessage::LeaveParty,
        ClientMessage::KickPlayerFromParty { player_id: 7 },
        ClientMessage::InviteToParty { player_id: 7 },
        ClientMessage::AcceptPartyInvite { player_id: 7 },
        ClientMessage::SetPartyFactions { factions: vec![] },
        ClientMessage::Relation {
            player_id: 7,
            relation: Relation::Friend,
            member: true,
        },
        ClientMessage::Relation {
            player_id: 7,
            relation: Relation::Foe,
            member: false,
        },
        ClientMessage::SetPlayerVetoes { vetoes: vec![] },
        ClientMessage::ListAvatars,
        ClientMessage::SelectAvatar { url: None },
        ClientMessage::RestoreGameSession { game_id: 7 },
        ClientMessage::GameRelay {
            command: "GameState".into(),
            args: vec![json!("Lobby")],
        },
    ];
    for message in messages {
        let encoded = message.encode();
        assert!(encoded.ends_with('\n'), "{encoded:?}");
        assert_eq!(encoded.matches('\n').count(), 1, "{encoded:?}");
        let decoded: Value = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded, message.to_value());
        // The name a log line gives a message is the one the server reads.
        assert_eq!(command_of(&decoded), message.command());
    }
}

#[test]
fn the_handshake_and_the_small_commands_are_spelled_as_the_server_reads_them() {
    assert_eq!(
        ClientMessage::AskSession {
            version: "0.9.5".into(),
            user_agent: "faf-rust-client".into(),
        }
        .to_value(),
        json!({ "command": "ask_session", "version": "0.9.5", "user_agent": "faf-rust-client" })
    );
    assert_eq!(
        ClientMessage::Auth {
            token: "t".into(),
            unique_id: "u".into(),
            session: "s".into(),
        }
        .to_value(),
        json!({ "command": "auth", "token": "t", "unique_id": "u", "session": "s" })
    );
    assert_eq!(ClientMessage::Pong.to_value(), json!({ "command": "pong" }));
    assert_eq!(
        ClientMessage::MatchReady.to_value(),
        json!({ "command": "match_ready" })
    );
    assert_eq!(
        ClientMessage::MatchmakerInfo.to_value(),
        json!({ "command": "matchmaker_info" })
    );
    for (searching, state) in [(true, "start"), (false, "stop")] {
        assert_eq!(
            ClientMessage::GameMatchmaking {
                queue_name: "tmm2v2".into(),
                searching,
            }
            .to_value(),
            json!({ "command": "game_matchmaking", "queue_name": "tmm2v2", "state": state })
        );
    }
}

/// An empty password is no password: the server would compare it against the
/// lobby's and refuse a join to an open game.
#[test]
fn a_join_sends_a_password_only_when_there_is_one() {
    let join = |password: Option<&str>| {
        ClientMessage::GameJoin {
            uid: 7,
            password: password.map(str::to_owned),
        }
        .to_value()
    };
    let bare = json!({ "command": "game_join", "uid": 7, "gameport": 0 });
    assert_eq!(join(None), bare);
    assert_eq!(join(Some("")), bare);
    assert_eq!(
        join(Some("hunter2")),
        json!({ "command": "game_join", "uid": 7, "gameport": 0, "password": "hunter2" })
    );
}

#[test]
fn party_commands_name_the_other_player_under_the_servers_three_keys() {
    assert_eq!(
        ClientMessage::LeaveParty.to_value(),
        json!({ "command": "leave_party" })
    );
    assert_eq!(
        ClientMessage::KickPlayerFromParty { player_id: 7 }.to_value(),
        json!({ "command": "kick_player_from_party", "kicked_player_id": 7 })
    );
    assert_eq!(
        ClientMessage::InviteToParty { player_id: 7 }.to_value(),
        json!({ "command": "invite_to_party", "recipient_id": 7 })
    );
    assert_eq!(
        ClientMessage::AcceptPartyInvite { player_id: 7 }.to_value(),
        json!({ "command": "accept_party_invite", "sender_id": 7 })
    );
    assert_eq!(
        ClientMessage::SetPlayerVetoes {
            vetoes: vec![PlayerVeto {
                matchmaker_queue_map_pool_id: 4,
                map_pool_map_version_id: 91,
                veto_tokens_applied: 2,
            }],
        }
        .to_value(),
        json!({
            "command": "set_player_vetoes",
            "vetoes": [{
                "matchmaker_queue_map_pool_id": 4,
                "map_pool_map_version_id": 91,
                "veto_tokens_applied": 2,
            }],
        })
    );
}

#[test]
fn a_relay_keeps_its_argument_types_and_only_game_state_ended_ends_a_game() {
    let relay = |command: &str, args: Vec<Value>| ClientMessage::GameRelay {
        command: command.into(),
        args,
    };
    assert_eq!(
        relay("GameOption", vec![json!("Slots"), json!(8)]).to_value(),
        json!({ "command": "GameOption", "target": "game", "args": ["Slots", 8] })
    );
    assert!(relay("GameState", vec![json!("Ended")]).reports_game_ended());
    assert!(relay("GameState", vec![json!("ended")]).reports_game_ended());
    assert!(!relay("GameState", vec![json!("Launching")]).reports_game_ended());
    assert!(!relay("GameState", vec![]).reports_game_ended());
    assert!(!relay("GameResult", vec![json!("Ended")]).reports_game_ended());
    assert!(!ClientMessage::Ping.reports_game_ended());
}
