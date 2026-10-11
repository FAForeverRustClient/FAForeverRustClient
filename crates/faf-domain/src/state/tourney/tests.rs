use super::*;

fn player(id: &str, name: &str, faf_id: Option<i32>) -> TourneyPlayer {
    TourneyPlayer {
        id: id.into(),
        name: name.into(),
        faf_id,
        rating: Some(1500),
        rating_actual: Some(1500),
        team_id: None,
        manual: false,
        late: false,
        pending: false,
        note: String::new(),
        signed_at: None,
        discord: String::new(),
        team_name: String::new(),
    }
}

fn team(id: &str, name: &str, players: &[&str]) -> TourneyTeam {
    TourneyTeam {
        id: id.into(),
        name: name.into(),
        seed: 1,
        captain_id: players.first().map(|id| (*id).to_string()),
        player_ids: players.iter().map(|id| (*id).to_string()).collect(),
        division: 0,
        checked_in: false,
        eliminated: false,
        out: None,
        final_rank: None,
        captain_renamed: false,
        join_requests: Vec::new(),
        invites: Vec::new(),
    }
}

fn playable_match() -> TourneyMatch {
    TourneyMatch {
        id: "m1".into(),
        bracket: BracketSide::Winners,
        round: 1,
        index: 0,
        best_of: 3,
        handicap: 0,
        division: 0,
        team1: Some("t1".into()),
        team2: Some("t2".into()),
        score1: None,
        score2: None,
        status: MatchStatus::Ready,
        winner: None,
        loser: None,
        winner_to: None,
        loser_to: None,
        pending_report: None,
        veto: None,
        faction_veto: None,
        entrants: Vec::new(),
        winners: Vec::new(),
        points: Vec::new(),
        is_final: false,
        replay_ids: Vec::new(),
        draw_replay_ids: Vec::new(),
        forfeit: None,
    }
}

/// The event as seen by whoever plays for `my_team`.
fn event_seen_by(my_team: &str) -> Tourney {
    Tourney {
        id: "e1".into(),
        status: TourneyStatus::Running,
        player_reporting: true,
        players: vec![
            player("p1", "Nuggets", Some(101)),
            player("p2", "Ada", Some(102)),
            player("p3", "Grace", None),
        ],
        teams: vec![team("t1", "", &["p1", "p3"]), team("t2", "Blue", &["p2"])],
        matches: vec![playable_match()],
        viewer: TourneyViewer {
            logged_in: true,
            member_team_id: Some(my_team.into()),
            signed_up_player_id: Some("p1".into()),
            ..TourneyViewer::default()
        },
        ..Tourney::default()
    }
}

fn event() -> Tourney {
    event_seen_by("t1")
}

#[test]
fn a_team_without_a_name_is_called_after_its_first_player() {
    // What an organiser expects for a team that never named itself, and
    // vastly better than showing `t1`.
    let event = event();
    assert_eq!(event.teams[0].display_name(&event.players), "Nuggets");
    assert_eq!(event.teams[1].display_name(&event.players), "Blue");
}

#[test]
fn a_team_with_neither_a_name_nor_players_reads_empty_rather_than_as_an_id() {
    let empty = team("t9", "", &[]);
    assert_eq!(empty.display_name(&[]), "");
}

#[test]
fn members_come_back_in_join_order() {
    let event = event();
    let names: Vec<&str> = event
        .members(&event.teams[0])
        .iter()
        .map(|player| player.name.as_str())
        .collect();
    assert_eq!(names, vec!["Nuggets", "Grace"]);
}

/// The same event as `event()`, seen by whoever runs it.
fn organised_event() -> Tourney {
    Tourney {
        viewer: TourneyViewer {
            logged_in: true,
            organiser: true,
            ..TourneyViewer::default()
        },
        ..event()
    }
}

#[test]
fn the_organiser_may_record_a_result() {
    assert!(organised_event().may_report(&playable_match()));
}

#[test]
fn a_player_in_the_match_may_not() {
    // This client keeps result-entry with the organiser. The service does
    // offer players their own path, but it insists on a FAF replay id per
    // game, and that is not the flow here.
    assert!(!event_seen_by("t1").may_report(&playable_match()));
    assert!(!event_seen_by("t2").may_report(&playable_match()));
    assert!(!event_seen_by("t9").may_report(&playable_match()));
}

#[test]
fn the_player_reporting_switch_does_not_gate_the_organiser() {
    // It decides whether *players* may report. An organiser records results
    // either way, which is the whole point of the flag existing.
    let event = Tourney {
        player_reporting: false,
        ..organised_event()
    };
    assert!(event.may_report(&event.matches[0]));
}

#[test]
fn a_series_in_progress_is_still_reportable() {
    // The bug this guards: `live` means 1-1 with a game still to play, and
    // reading it as "not ready" would take the control away mid-series.
    let event = organised_event();
    let live = TourneyMatch {
        status: MatchStatus::Live,
        score1: Some(1),
        score2: Some(1),
        ..event.matches[0].clone()
    };
    assert!(live.is_playable());
    assert!(event.may_report(&live));
}

#[test]
fn a_finished_match_stays_reportable_so_a_wrong_result_can_be_fixed() {
    // `report` is the correction path too: it undoes the old result and sets
    // the new one. Withdrawing the control once a match is done would leave a
    // mistake permanent.
    let event = organised_event();
    let done = TourneyMatch {
        status: MatchStatus::Done,
        score1: Some(2),
        score2: Some(0),
        winner: event.matches[0].team1.clone(),
        ..event.matches[0].clone()
    };
    assert!(event.may_report(&done));
}

#[test]
fn a_match_still_waiting_on_a_feeder_is_not_reportable() {
    let event = event();
    let waiting = TourneyMatch {
        team2: None,
        status: MatchStatus::Waiting,
        ..event.matches[0].clone()
    };
    assert!(!waiting.is_playable());
    assert!(!event.may_report(&waiting));
}

#[test]
fn a_decided_series_is_the_organisers_to_correct() {
    let event = event();
    let done = TourneyMatch {
        status: MatchStatus::Done,
        ..event.matches[0].clone()
    };
    assert!(!event.may_report(&done));
}

#[test]
fn only_the_other_side_confirms_a_submitted_score() {
    // Confirming your own submission would make the second signature
    // worthless, which is exactly what the server refuses.
    let submitted = TourneyMatch {
        pending_report: Some(PendingReport {
            score1: 2,
            score2: 1,
            by_team: "t1".into(),
            by_name: "Nuggets".into(),
            replay_ids: vec!["22334455".into()],
            at: None,
            draw_replay_ids: Vec::new(),
        }),
        ..playable_match()
    };
    assert!(event_seen_by("t2").may_confirm(&submitted));
    assert!(!event_seen_by("t1").may_confirm(&submitted));
    assert!(!event_seen_by("t9").may_confirm(&submitted));
    // Nothing submitted, nothing to confirm.
    assert!(!event_seen_by("t2").may_confirm(&playable_match()));
}

#[test]
fn entering_is_offered_while_signups_are_open_and_not_after() {
    let mut event = Tourney {
        status: TourneyStatus::Signup,
        viewer: TourneyViewer {
            logged_in: true,
            ..TourneyViewer::default()
        },
        ..Tourney::default()
    };
    assert!(event.may_sign_up());
    assert!(!event.may_withdraw());

    // Signed up: the pair flips.
    event.viewer.signed_up_player_id = Some("p1".into());
    assert!(!event.may_sign_up());
    assert!(event.may_withdraw());

    // Once the bracket is drawn, leaving is the organiser's to do.
    event.status = TourneyStatus::Running;
    assert!(!event.may_withdraw());

    // Signed out: neither, whatever the status.
    event.viewer = TourneyViewer::default();
    event.status = TourneyStatus::Signup;
    assert!(!event.may_sign_up());
}

#[test]
fn a_pool_is_found_through_its_round_assignment() {
    let event = Tourney {
        map_db: vec![
            TourneyMap {
                id: "m1".into(),
                name: "Setons".into(),
                image_url: String::new(),
                description: String::new(),
                published: true,
                spec: None,
                secret: false,
                masked: false,
            },
            TourneyMap {
                id: "m2".into(),
                name: "Astro".into(),
                image_url: String::new(),
                description: String::new(),
                published: true,
                spec: None,
                secret: false,
                masked: false,
            },
        ],
        map_pools: vec![MapPool {
            id: "pool1".into(),
            name: "Round 1".into(),
            map_ids: vec!["m2".into(), "m1".into()],
            sequence: vec![],
            best_of: Some(3),
            published: true,
            publish_at: None,
        }],
        pool_assign: vec![PoolAssignment {
            round: "1".into(),
            pool_id: "pool1".into(),
        }],
        ..Tourney::default()
    };

    let pool = event
        .pool_for_round("1")
        .expect("a pool is bound to round 1");
    assert_eq!(pool.name, "Round 1");
    // The pool's own order, not the map database's.
    let names: Vec<&str> = event
        .pool_maps(pool)
        .iter()
        .map(|map| map.name.as_str())
        .collect();
    assert_eq!(names, vec!["Astro", "Setons"]);
    assert!(event.pool_for_round("2").is_none());
}

/// Stand-in for `VaultMap`, so this test does not depend on the maps slice.
struct Vault {
    display: &'static str,
    folder: &'static str,
}

const VAULT: [Vault; 2] = [
    Vault {
        display: "Seton's Clutch",
        folder: "scmp_009.v0001",
    },
    Vault {
        display: "Astro Crater Battles",
        folder: "astro_crater.v0003",
    },
];

fn resolve(name: &str) -> Option<&'static str> {
    let map = TourneyMap {
        id: "m".into(),
        name: name.into(),
        image_url: String::new(),
        description: String::new(),
        published: true,
        spec: None,
        secret: false,
        masked: false,
    };
    match_vault_map(&map, &VAULT, |v| v.display, |v| v.folder).map(|v| v.display)
}

#[test]
fn a_hand_typed_map_name_still_finds_its_vault_entry() {
    // Organisers type these by hand, and every one of these spellings turns
    // up in a real tournament.
    for spelling in [
        "Seton's Clutch",
        "setons clutch",
        "SETONS CLUTCH",
        "Setons_Clutch",
        "seton''s  clutch",
    ] {
        assert_eq!(
            resolve(spelling),
            Some("Seton's Clutch"),
            "for {spelling:?}"
        );
    }
}

#[test]
fn the_folder_name_resolves_too_version_and_all() {
    // A TD who copied the folder out of their maps directory.
    assert_eq!(resolve("scmp_009"), Some("Seton's Clutch"));
    assert_eq!(resolve("SCMP_009.v0001"), Some("Seton's Clutch"));
}

#[test]
fn a_map_that_is_not_in_the_vault_resolves_to_nothing() {
    // A real case: tournaments do run maps that were never uploaded. The
    // caller falls back to the tournament server's own image.
    assert_eq!(resolve("Some Private Map"), None);
    assert_eq!(resolve(""), None);
    assert_eq!(resolve("   "), None);
}

#[test]
fn the_display_name_wins_over_a_coincidental_folder_match() {
    // Both lookups exist; the human-readable one is the one an organiser
    // meant, so it is tried first.
    assert_eq!(
        resolve("Astro Crater Battles"),
        Some("Astro Crater Battles")
    );
}

// --- the slice ---------------------------------------------------------

fn row(id: &str) -> Tourney {
    Tourney {
        id: id.into(),
        name: format!("Event {id}"),
        player_count: 8,
        ..Tourney::default()
    }
}

fn apply(state: &mut TourneyState, events: &[TourneyEvent]) {
    for event in events {
        reduce(state, event);
    }
}

#[test]
fn the_first_load_opens_the_first_event() {
    let mut state = TourneyState::default();
    apply(
        &mut state,
        &[
            TourneyEvent::Loading,
            TourneyEvent::Loaded {
                events: vec![row("e1"), row("e2")],
            },
        ],
    );
    assert_eq!(state.status, TourneyLoadStatus::Ready);
    assert_eq!(state.selected_id.as_deref(), Some("e1"));
}

#[test]
fn a_refresh_leaves_the_open_event_open() {
    // A reload must not throw the reader back to the top of the list.
    let mut state = TourneyState::default();
    apply(
        &mut state,
        &[
            TourneyEvent::Loaded {
                events: vec![row("e1"), row("e2")],
            },
            TourneyEvent::Selected {
                tournament_id: "e2".into(),
            },
            TourneyEvent::DetailLoaded {
                event: Box::new(row("e2")),
            },
            TourneyEvent::Loaded {
                events: vec![row("e1"), row("e2")],
            },
        ],
    );
    assert_eq!(state.selected_id.as_deref(), Some("e2"));
    assert!(
        state.open_event().is_some(),
        "the detail survives a refresh"
    );
}

#[test]
fn an_event_that_disappears_takes_its_detail_with_it() {
    let mut state = TourneyState::default();
    apply(
        &mut state,
        &[
            TourneyEvent::Loaded {
                events: vec![row("e1"), row("e2")],
            },
            TourneyEvent::Selected {
                tournament_id: "e2".into(),
            },
            TourneyEvent::DetailLoaded {
                event: Box::new(row("e2")),
            },
            TourneyEvent::ChatRoomsLoaded {
                rooms: vec![ChatRoom {
                    id: "global".into(),
                    name: "Global".into(),
                    unread: 2,
                    ..ChatRoom::default()
                }],
            },
            // e2 was archived between refreshes.
            TourneyEvent::Loaded {
                events: vec![row("e1")],
            },
        ],
    );
    assert_eq!(state.selected_id.as_deref(), Some("e1"));
    assert!(state.detail.is_none());
    assert!(state.chat_rooms.is_empty(), "the chat went with it");
}

#[test]
fn a_detail_for_a_row_nobody_is_looking_at_is_dropped() {
    // The window between clicking a second row and the first one's detail
    // arriving. Letting it land would caption one bracket with another
    // tournament's name.
    let mut state = TourneyState::default();
    apply(
        &mut state,
        &[
            TourneyEvent::Loaded {
                events: vec![row("e1"), row("e2")],
            },
            TourneyEvent::Selected {
                tournament_id: "e2".into(),
            },
            TourneyEvent::DetailLoaded {
                event: Box::new(row("e1")),
            },
        ],
    );
    assert!(state.detail.is_none());
    assert!(state.open_event().is_none());
}

#[test]
fn switching_events_drops_the_previous_ones_conversation_at_once() {
    let mut state = TourneyState::default();
    apply(
        &mut state,
        &[
            TourneyEvent::Loaded {
                events: vec![row("e1"), row("e2")],
            },
            TourneyEvent::DetailLoaded {
                event: Box::new(row("e1")),
            },
            TourneyEvent::ChatRoomsLoaded {
                rooms: vec![ChatRoom {
                    id: "global".into(),
                    name: "Global".into(),
                    unread: 0,
                    ..ChatRoom::default()
                }],
            },
            TourneyEvent::RoomOpened {
                room_id: "global".into(),
            },
            TourneyEvent::ChatLoaded {
                room_id: "global".into(),
                posts: vec![ChatPost {
                    faf_id: Some(102),
                    id: "c1".into(),
                    author: "Ada".into(),
                    body: "gl hf".into(),
                    at: None,
                    system: false,
                    reply_to: None,
                    everyone: false,
                }],
            },
            TourneyEvent::Selected {
                tournament_id: "e2".into(),
            },
        ],
    );
    assert!(state.detail.is_none());
    assert!(state.chat_posts.is_empty());
    assert!(state.open_room_id.is_none());
}

#[test]
fn reading_a_room_clears_its_badge_without_a_second_request() {
    // The server clears the marker when the room is read, so waiting for
    // the next room list would leave a badge on a room already open.
    let mut state = TourneyState::default();
    apply(
        &mut state,
        &[
            TourneyEvent::ChatRoomsLoaded {
                rooms: vec![
                    ChatRoom {
                        id: "global".into(),
                        name: "Global".into(),
                        unread: 3,
                        ..ChatRoom::default()
                    },
                    ChatRoom {
                        id: "m1".into(),
                        name: "Nuggets vs Ada".into(),
                        unread: 1,
                        ..ChatRoom::default()
                    },
                ],
            },
            TourneyEvent::RoomOpened {
                room_id: "global".into(),
            },
            TourneyEvent::ChatLoaded {
                room_id: "global".into(),
                posts: vec![],
            },
        ],
    );
    assert_eq!(
        state.unread_total(),
        1,
        "only the room that was read clears"
    );
}

#[test]
fn posts_for_a_room_that_is_no_longer_open_are_ignored() {
    let mut state = TourneyState::default();
    apply(
        &mut state,
        &[
            TourneyEvent::RoomOpened {
                room_id: "m1".into(),
            },
            TourneyEvent::ChatLoaded {
                room_id: "global".into(),
                posts: vec![ChatPost {
                    faf_id: Some(102),
                    id: "c1".into(),
                    author: "Ada".into(),
                    body: "wrong room".into(),
                    at: None,
                    system: false,
                    reply_to: None,
                    everyone: false,
                }],
            },
        ],
    );
    assert!(state.chat_posts.is_empty());
}

#[test]
fn a_refused_write_survives_until_it_is_dismissed() {
    // A message that vanished on the next re-render would never be read.
    let mut state = TourneyState::default();
    let failure = TourneyActionFailure {
        action: TourneyAction::SigningUp,
        reason: "Your rating (1420) is below this tournament’s minimum of 1500.".into(),
        kind: RequestFailureKind::Rejected,
    };
    apply(
        &mut state,
        &[
            TourneyEvent::ActionStarted {
                action: TourneyAction::SigningUp,
            },
            TourneyEvent::ActionFailed {
                failure: failure.clone(),
            },
        ],
    );
    assert!(state.pending.is_none());
    assert_eq!(state.action_error, Some(failure));

    // Starting another action clears it, and so does dismissing it.
    reduce(
        &mut state,
        &TourneyEvent::ActionStarted {
            action: TourneyAction::CheckingIn,
        },
    );
    assert!(state.action_error.is_none());
    reduce(&mut state, &TourneyEvent::ActionErrorDismissed);
    assert!(state.action_error.is_none());
}

/// A team at a known seed, optionally knocked out at a known depth.
fn ranked_team(id: &str, seed: i32, out: Option<(BracketSide, i32)>) -> TourneyTeam {
    TourneyTeam {
        seed,
        out: out.map(|(bracket, round)| TeamExit { bracket, round }),
        ..team(id, id, &[])
    }
}

fn bracket_event(kind: BracketKind, teams: Vec<TourneyTeam>) -> Tourney {
    Tourney {
        id: "e1".into(),
        status: TourneyStatus::Running,
        bracket_kind: kind,
        teams,
        ..Tourney::default()
    }
}

#[test]
fn standings_are_empty_until_there_is_a_bracket() {
    let event = Tourney {
        status: TourneyStatus::Signup,
        teams: vec![ranked_team("t1", 1, None)],
        ..Tourney::default()
    };
    assert_eq!(event.standings_kind(), StandingsKind::None);
    assert!(event.standings().is_empty());
}

#[test]
fn an_elimination_table_ranks_by_how_far_each_run_got() {
    // A four-team double elimination, played out: t1 won it, t2 lost the
    // grand final, and t3 and t4 both went out in the first losers round.
    let mut event = bracket_event(
        BracketKind::Double,
        vec![
            ranked_team("t4", 4, Some((BracketSide::Losers, 1))),
            ranked_team("t2", 2, Some((BracketSide::GrandFinal, 1))),
            ranked_team("t3", 3, Some((BracketSide::Losers, 1))),
            ranked_team("t1", 1, None),
        ],
    );
    event.champion_team_id = Some("t1".into());

    let rows = event.standings();
    let order: Vec<&str> = rows.iter().map(|row| row.team_id.as_str()).collect();
    assert_eq!(order, vec!["t1", "t2", "t3", "t4"], "seed breaks the tie");
    assert_eq!(
        rows.iter().map(|row| row.place).collect::<Vec<_>>(),
        vec![Some(1), Some(2), Some(3), Some(3)],
        "two teams out at the same depth share third"
    );
    assert_eq!(rows[0].outcome, StandingOutcome::Champion);
    assert_eq!(rows[1].outcome, StandingOutcome::LostFinal);
    assert_eq!(
        rows[3].outcome,
        StandingOutcome::OutIn {
            bracket: BracketSide::Losers,
            round: 1
        }
    );
}

#[test]
fn a_team_still_in_it_outranks_everyone_out_and_has_no_place_yet() {
    // Mid-event: nobody has won, so calling the survivor first would be a
    // guess, and calling the knocked-out team second would imply one.
    let event = bracket_event(
        BracketKind::Single,
        vec![
            ranked_team("t2", 2, Some((BracketSide::Winners, 1))),
            ranked_team("t1", 1, None),
        ],
    );
    let rows = event.standings();
    assert_eq!(rows[0].team_id, "t1");
    assert_eq!(rows[0].outcome, StandingOutcome::StillIn);
    assert_eq!(rows[0].place, None, "no place while the run is unfinished");
    assert_eq!(rows[1].place, Some(2));
}

#[test]
fn a_later_losers_round_outranks_an_earlier_one() {
    let event = bracket_event(
        BracketKind::Double,
        vec![
            ranked_team("early", 1, Some((BracketSide::Losers, 1))),
            ranked_team("late", 2, Some((BracketSide::Losers, 3))),
        ],
    );
    let rows = event.standings();
    let order: Vec<&str> = rows.iter().map(|row| row.team_id.as_str()).collect();
    assert_eq!(order, vec!["late", "early"]);
}

#[test]
fn a_swiss_table_counts_wins_then_game_difference() {
    let mut event = bracket_event(
        BracketKind::Swiss,
        vec![
            ranked_team("t1", 1, None),
            ranked_team("t2", 2, None),
            ranked_team("t3", 3, None),
        ],
    );
    // t1 beat t2 two games to nil; t3 drew the bye.
    let mut decided = TourneyMatch {
        bracket: BracketSide::Swiss,
        status: MatchStatus::Done,
        team1: Some("t1".into()),
        team2: Some("t2".into()),
        score1: Some(2),
        score2: Some(0),
        winner: Some("t1".into()),
        loser: Some("t2".into()),
        ..playable_match()
    };
    decided.id = "m1".into();
    let bye = TourneyMatch {
        id: "m2".into(),
        bracket: BracketSide::Swiss,
        status: MatchStatus::Bye,
        team1: Some("t3".into()),
        team2: None,
        ..playable_match()
    };
    event.matches = vec![decided, bye];

    let rows = event.standings();
    assert_eq!(rows[0].team_id, "t1");
    assert_eq!((rows[0].wins, rows[0].losses, rows[0].game_diff), (1, 0, 2));
    assert_eq!(rows[1].team_id, "t3", "a bye is a win worth one game");
    assert_eq!((rows[1].wins, rows[1].losses, rows[1].game_diff), (1, 0, 1));
    assert_eq!(rows[2].team_id, "t2");
    assert_eq!(
        (rows[2].wins, rows[2].losses, rows[2].game_diff),
        (0, 1, -2)
    );
    assert_eq!(
        rows.iter().map(|row| row.place).collect::<Vec<_>>(),
        vec![Some(1), Some(2), Some(3)],
        "a Swiss table always ranks every row"
    );
}

/// A decided Swiss match, `winner` over `loser` by `high` games to `low`.
fn swiss_result(id: &str, winner: &str, loser: &str, high: i32, low: i32) -> TourneyMatch {
    TourneyMatch {
        id: id.into(),
        bracket: BracketSide::Swiss,
        status: MatchStatus::Done,
        team1: Some(winner.into()),
        team2: Some(loser.into()),
        score1: Some(high),
        score2: Some(low),
        winner: Some(winner.into()),
        loser: Some(loser.into()),
        ..playable_match()
    }
}

/// t1 went 2-0 winning both 1-0 (+2); t2 went 2-1 winning both 2-0 and
/// losing 0-1 (+3). The server ranks the unbeaten one first.
fn two_wins_apart_by_a_loss() -> Tourney {
    let mut event = bracket_event(
        BracketKind::Swiss,
        vec![
            ranked_team("t1", 1, None),
            ranked_team("t2", 2, None),
            ranked_team("t3", 3, None),
            ranked_team("t4", 4, None),
            ranked_team("t5", 5, None),
        ],
    );
    event.matches = vec![
        swiss_result("m1", "t1", "t3", 1, 0),
        swiss_result("m2", "t1", "t4", 1, 0),
        swiss_result("m3", "t2", "t3", 2, 0),
        swiss_result("m4", "t2", "t4", 2, 0),
        swiss_result("m5", "t5", "t2", 1, 0),
    ];
    event
}

#[test]
fn fewer_losses_rank_above_a_better_game_difference() {
    let rows = two_wins_apart_by_a_loss().standings();
    assert_eq!(rows[0].team_id, "t1", "2-0 on +2 is above 2-1 on +3");
    assert_eq!((rows[0].wins, rows[0].losses, rows[0].game_diff), (2, 0, 2));
    assert_eq!(rows[1].team_id, "t2");
    assert_eq!((rows[1].wins, rows[1].losses, rows[1].game_diff), (2, 1, 3));
    assert!(
        rows.iter().all(|row| row.beaten.is_none()),
        "no beaten column by default"
    );
}

#[test]
fn the_servers_own_swiss_order_is_the_order_shown() {
    // The server's order can differ from anything the client works out: the
    // beaten tiebreak ends in a coin flip seeded from a value it never sends.
    let mut event = two_wins_apart_by_a_loss();
    event.swiss_order = vec![
        "t2".into(),
        "t1".into(),
        "t5".into(),
        "t3".into(),
        "t4".into(),
    ];
    event.swiss_tiebreak = SwissTiebreak::Beaten;
    event.swiss_beaten = [("t1".to_string(), 0), ("t2".to_string(), 1)]
        .into_iter()
        .collect();

    let rows = event.standings();
    let order: Vec<&str> = rows.iter().map(|row| row.team_id.as_str()).collect();
    assert_eq!(order, vec!["t2", "t1", "t5", "t3", "t4"]);
    assert_eq!(rows[0].beaten, Some(1));
    assert_eq!(rows[1].beaten, Some(0));
    assert_eq!(
        rows[2].beaten,
        Some(0),
        "a team that beat nobody sums to nothing"
    );
    assert_eq!(rows[0].place, Some(1));
}

#[test]
fn an_imported_event_uses_the_placings_it_arrived_with() {
    // No matches at all, which is the case the elimination table cannot
    // serve: an import often carries nothing but its final table.
    let event = Tourney {
        imported: true,
        status: TourneyStatus::Finished,
        teams: vec![
            TourneyTeam {
                final_rank: Some(2),
                ..ranked_team("t2", 2, None)
            },
            TourneyTeam {
                final_rank: Some(1),
                ..ranked_team("t1", 1, None)
            },
            ranked_team("t9", 9, None),
        ],
        ..Tourney::default()
    };
    assert_eq!(event.standings_kind(), StandingsKind::Imported);

    let rows = event.standings();
    let order: Vec<&str> = rows.iter().map(|row| row.team_id.as_str()).collect();
    assert_eq!(order, vec!["t1", "t2", "t9"], "unplaced sorts last");
    assert_eq!(rows[0].place, Some(1));
    assert_eq!(rows[2].place, None);
    assert_eq!(rows[0].outcome, StandingOutcome::Placed);
}

#[test]
fn one_matchs_spinner_does_not_disable_the_rest_of_the_bracket() {
    let mut state = TourneyState::default();
    reduce(
        &mut state,
        &TourneyEvent::ActionStarted {
            action: TourneyAction::DecidingReport {
                match_id: "m1".into(),
            },
        },
    );
    assert!(state.is_busy_with("m1"));
    assert!(!state.is_busy_with("m2"));

    reduce(
        &mut state,
        &TourneyEvent::ActionSucceeded {
            action: TourneyAction::DecidingReport {
                match_id: "m1".into(),
            },
            select: None,
        },
    );
    assert!(!state.is_busy_with("m1"));
}

#[test]
fn an_entrant_without_a_faf_account_simply_has_no_profile() {
    // Organisers can add a player by hand; that entry is a name and nothing
    // else, and it still belongs in the bracket.
    let state = TourneyState {
        entrant_profiles: vec![PlayerSummary {
            id: 102,
            login: "Ada".into(),
            avatar_url: String::new(),
            country: "GB".into(),
            global_rating: Some(1_910),
            ladder_rating: None,
        }],
        ..TourneyState::default()
    };
    assert_eq!(
        state
            .profile_of(&player("p2", "Ada", Some(102)))
            .map(|profile| profile.login.as_str()),
        Some("Ada")
    );
    assert!(state.profile_of(&player("p9", "Walk-in", None)).is_none());
    assert!(state
        .profile_of(&player("p3", "Grace", Some(999)))
        .is_none());
}

#[test]
fn unknown_wire_values_fall_back_without_inventing_meaning() {
    // An unrecognised match state must not read as playable: that would
    // offer a report the server rejects.
    assert_eq!(MatchStatus::from_wire("who knows"), MatchStatus::Waiting);
    assert_eq!(MatchStatus::from_wire("live"), MatchStatus::Live);
    assert_eq!(MatchStatus::from_wire("bye"), MatchStatus::Bye);
    // An unrecognised tournament status is admitted as unknown rather than
    // guessed at, because real actions are gated on it.
    assert_eq!(
        TourneyStatus::from_wire("who knows"),
        TourneyStatus::Unknown
    );
    assert_eq!(TourneyStatus::from_wire("drafted"), TourneyStatus::Drafted);
    assert_eq!(BracketSide::from_wire(""), BracketSide::Winners);
    assert_eq!(BracketSide::from_wire("sw"), BracketSide::Swiss);
    assert_eq!(BracketSide::from_wire("ffa"), BracketSide::FreeForAll);
    assert_eq!(Formation::from_wire("premade"), Formation::Open);
    assert_eq!(BracketKind::from_wire("Double"), BracketKind::Double);
    assert_eq!(Competition::from_wire("FFA"), Competition::FreeForAll);
}

#[test]
fn pasted_pictures_take_their_paths_once_the_event_exists() {
    let draft = TourneyDraft {
        description: "Intro\n![image](pending-image-0)\nMore".into(),
        rewards: "![image](pending-image-1)".into(),
        pending_images: vec![
            PendingImage {
                token: "pending-image-0".into(),
                data_url: "data:image/png;base64,AA==".into(),
            },
            PendingImage {
                token: "pending-image-1".into(),
                data_url: "data:image/png;base64,AA==".into(),
            },
        ],
        ..TourneyDraft::default()
    };
    let placed = draft.with_images_placed(&[
        ("pending-image-0".into(), "/desc-images/a.png".into()),
        ("pending-image-1".into(), "/desc-images/b.png".into()),
    ]);
    assert_eq!(
        placed.description,
        "Intro\n![image](/desc-images/a.png)\nMore"
    );
    assert_eq!(placed.rewards, "![image](/desc-images/b.png)");
    assert!(placed.pending_images.is_empty());
}

/// #386: a map added without a picture gets the vault's, and only then.
#[test]
fn a_map_saved_without_a_picture_borrows_the_vault_preview() {
    let vault = [(
        "Seton's Clutch",
        "setons_clutch.v0002",
        "https://content.faforever.com/maps/previews/large/setons_clutch.v0002.png",
    )];
    let pick = |draft: &MapDraft, stored: &[TourneyMap]| {
        vault_preview_for_new_picture(draft, stored, &vault, |m| m.0, |m| m.1, |m| m.2)
            .map(str::to_owned)
    };
    let added = MapDraft {
        name: "setons clutch".into(),
        ..MapDraft::default()
    };
    assert_eq!(pick(&added, &[]).as_deref(), Some(vault[0].2));

    let chose_one = MapDraft {
        image: Some("data:image/png;base64,AA==".into()),
        ..added.clone()
    };
    assert_eq!(pick(&chose_one, &[]), None);

    let removing = MapDraft {
        remove_image: true,
        ..added.clone()
    };
    assert_eq!(pick(&removing, &[]), None);

    let stored = TourneyMap {
        id: "m1".into(),
        name: "Seton's Clutch".into(),
        image_url: "m1.png".into(),
        description: String::new(),
        published: true,
        spec: None,
        secret: false,
        masked: false,
    };
    let editing = MapDraft {
        id: "m1".into(),
        ..added.clone()
    };
    assert_eq!(pick(&editing, std::slice::from_ref(&stored)), None);

    let unknown = MapDraft {
        name: "Never Uploaded".into(),
        ..MapDraft::default()
    };
    assert_eq!(pick(&unknown, &[]), None);
}

/// Selecting another event while its eligibility check is in flight: the
/// answer for the event just left must not become the notice of the one now
/// open, whether it is a verdict or a refusal.
#[test]
fn an_eligibility_answer_for_an_event_no_longer_open_is_dropped() {
    let mut state = TourneyState::default();
    let select = |id: &str| TourneyEvent::Selected {
        tournament_id: id.into(),
    };
    reduce(&mut state, &select("a"));
    reduce(
        &mut state,
        &TourneyEvent::RatingChecking {
            tournament_id: "a".into(),
        },
    );
    assert_eq!(state.rating_check_status, TourneyLoadStatus::Loading);

    reduce(&mut state, &select("b"));
    reduce(
        &mut state,
        &TourneyEvent::RatingChecked {
            tournament_id: "a".into(),
            check: RatingCheck {
                eligible: Some(true),
                ..RatingCheck::default()
            },
        },
    );
    reduce(
        &mut state,
        &TourneyEvent::RatingCheckFailed {
            tournament_id: "a".into(),
            reason: "late".into(),
            kind: RequestFailureKind::Rejected,
        },
    );
    assert_eq!(state.rating_check, None);
    assert_eq!(state.rating_check_status, TourneyLoadStatus::Idle);

    reduce(
        &mut state,
        &TourneyEvent::RatingChecked {
            tournament_id: "b".into(),
            check: RatingCheck {
                eligible: Some(false),
                ..RatingCheck::default()
            },
        },
    );
    assert_eq!(
        state.rating_check.as_ref().and_then(|check| check.eligible),
        Some(false)
    );
    assert_eq!(state.rating_check_status, TourneyLoadStatus::Ready);
}

/// The two halves of [`TourneyCommand`] on the wire.
///
/// The webview builds `{ kind: "Tourney", command: { type, payload } }` with
/// no idea which half a command is in, so splitting the enum must not add a
/// layer, and every `type` must land in the half that declares it.
mod command_wire {
    use std::collections::BTreeSet;

    use super::*;
    use crate::AppCommand;

    fn t() -> String {
        "t1".into()
    }

    /// One of every read, so the test below fails when a read is added
    /// without one.
    fn every_read() -> Vec<TourneyRead> {
        vec![
            TourneyRead::Load,
            TourneyRead::Select { tournament_id: t() },
            TourneyRead::RefreshDetail { tournament_id: t() },
            TourneyRead::CheckRating { tournament_id: t() },
            TourneyRead::LoadPlayerRatings {
                tournament_id: t(),
                player_id: "p1".into(),
                refresh: true,
            },
            TourneyRead::LoadCopySources,
            TourneyRead::LoadPresets,
            TourneyRead::LoadSite {
                read: SiteRead::Access {
                    kind: AccessKind::Host,
                },
            },
            TourneyRead::LoadTemplate { tournament_id: t() },
            TourneyRead::LoadCopySource { tournament_id: t() },
            TourneyRead::LoadChat { tournament_id: t() },
            TourneyRead::OpenRoom {
                tournament_id: t(),
                room_id: "r1".into(),
            },
            TourneyRead::RefreshChat {
                tournament_id: t(),
                room_id: "r1".into(),
            },
            TourneyRead::PinRoom {
                tournament_id: t(),
                room_id: Some("r1".into()),
            },
            TourneyRead::LoadArticles,
            TourneyRead::LoadHosting,
            TourneyRead::LoadProfile,
            TourneyRead::SetDiscord {
                handle: "me#1".into(),
            },
            TourneyRead::SearchAccounts {
                query: "Zep".into(),
            },
            TourneyRead::ClearAccountSearch,
            TourneyRead::CheckRenames { tournament_id: t() },
            TourneyRead::LoadSeries,
            TourneyRead::OpenSeries {
                series_id: "s1".into(),
            },
            TourneyRead::CloseSeries,
            TourneyRead::MarkNewsRead { tournament_id: t() },
            TourneyRead::DismissActionError,
        ]
    }

    /// One of every write, for the same reason.
    fn every_write() -> Vec<TourneyWrite> {
        let report = MatchReport {
            match_id: "m1".into(),
            score1: 2,
            score2: 1,
            replay_ids: vec!["1".into(), "2".into(), "3".into()],
            ..MatchReport::default()
        };
        vec![
            TourneyWrite::SignUp {
                tournament_id: t(),
                rating: Some(1500),
            },
            TourneyWrite::DeclineInvite { tournament_id: t() },
            TourneyWrite::UploadDescImage {
                tournament_id: t(),
                data_url: "data:image/png;base64,AA==".into(),
                request_id: 7,
            },
            TourneyWrite::SiteWrite {
                write: SiteWrite::RequestAccess {
                    kind: AccessKind::Editor,
                    message: "please".into(),
                },
            },
            TourneyWrite::BanPlayer {
                tournament_id: t(),
                player_id: "p1".into(),
                faf_id: 42,
                name: "Zep".into(),
                reason: "no show".into(),
                expires: Some(1_700_000_000),
                remove: true,
            },
            TourneyWrite::Withdraw { tournament_id: t() },
            TourneyWrite::CheckIn {
                tournament_id: t(),
                checked_in: true,
            },
            TourneyWrite::AnswerReport {
                tournament_id: t(),
                match_id: "m1".into(),
                accept: false,
            },
            TourneyWrite::DecideReport {
                tournament_id: t(),
                report: report.clone(),
            },
            TourneyWrite::SubmitReport {
                tournament_id: t(),
                report,
            },
            TourneyWrite::PostChat {
                tournament_id: t(),
                room_id: "r1".into(),
                body: "gl hf".into(),
                reply_to: Some("c1".into()),
            },
            TourneyWrite::CreateTeam {
                tournament_id: t(),
                name: "Team".into(),
            },
            TourneyWrite::RequestJoin {
                tournament_id: t(),
                team_id: "tm1".into(),
            },
            TourneyWrite::CancelJoin {
                tournament_id: t(),
                team_id: "tm1".into(),
            },
            TourneyWrite::RespondJoin {
                tournament_id: t(),
                team_id: "tm1".into(),
                player_id: "p1".into(),
                accept: true,
            },
            TourneyWrite::InviteToTeam {
                tournament_id: t(),
                team_id: "tm1".into(),
                player_id: "p1".into(),
            },
            TourneyWrite::RespondInvite {
                tournament_id: t(),
                team_id: "tm1".into(),
                accept: true,
            },
            TourneyWrite::LeaveTeam { tournament_id: t() },
            TourneyWrite::DisbandTeam {
                tournament_id: t(),
                team_id: "tm1".into(),
            },
            TourneyWrite::RenameTeam {
                tournament_id: t(),
                team_id: "tm1".into(),
                name: "New".into(),
            },
            TourneyWrite::AddPlayer {
                tournament_id: t(),
                name: "Zep".into(),
                rating: None,
            },
            TourneyWrite::RespondSignup {
                tournament_id: t(),
                player_id: "p1".into(),
                accept: false,
            },
            TourneyWrite::RemovePlayer {
                tournament_id: t(),
                player_id: "p1".into(),
            },
            TourneyWrite::SetCaptain {
                tournament_id: t(),
                team_id: "tm1".into(),
                player_id: "p1".into(),
            },
            TourneyWrite::MovePlayer {
                tournament_id: t(),
                player_id: "p1".into(),
                team_id: None,
            },
            TourneyWrite::EditPlayer {
                tournament_id: t(),
                player_id: "p1".into(),
                note: "sub".into(),
                rating: Some(1200),
            },
            TourneyWrite::InvitePlayer {
                tournament_id: t(),
                name: "Zep".into(),
            },
            TourneyWrite::Uninvite {
                tournament_id: t(),
                faf_id: 42,
            },
            TourneyWrite::Reseed {
                tournament_id: t(),
                order: SeedOrder::Explicit {
                    team_ids: vec!["tm2".into(), "tm1".into()],
                },
            },
            TourneyWrite::SplitDivisions {
                tournament_id: t(),
                divisions: 2,
            },
            TourneyWrite::SetDivision {
                tournament_id: t(),
                team_id: "tm1".into(),
                division: 1,
            },
            TourneyWrite::PostNews {
                tournament_id: t(),
                body: "Round 2".into(),
                important: true,
            },
            TourneyWrite::DeleteNews {
                tournament_id: t(),
                news_id: "n1".into(),
            },
            TourneyWrite::Create {
                draft: TourneyDraft::new(),
            },
            TourneyWrite::EditInfo {
                tournament_id: t(),
                draft: TourneyDraft::new(),
            },
            TourneyWrite::Publish { tournament_id: t() },
            TourneyWrite::Advance {
                tournament_id: t(),
                phase: TourneyPhase::FormTeams,
                config: None,
            },
            TourneyWrite::Archive { tournament_id: t() },
            TourneyWrite::AssignPool {
                tournament_id: t(),
                round_key: "wb:1".into(),
                pool_id: "pl1".into(),
            },
            TourneyWrite::DraftPickPlayer {
                tournament_id: t(),
                player_id: "p1".into(),
            },
            TourneyWrite::DraftUndo { tournament_id: t() },
            TourneyWrite::SetCaptains {
                tournament_id: t(),
                player_ids: vec!["p1".into(), "p2".into()],
            },
            TourneyWrite::ReportFfa {
                tournament_id: t(),
                report: FfaReport::default(),
            },
            TourneyWrite::VetoAct {
                tournament_id: t(),
                match_id: "m1".into(),
                map_id: "map1".into(),
            },
            TourneyWrite::VetoSetSides {
                tournament_id: t(),
                match_id: "m1".into(),
                team_a: "tm1".into(),
            },
            TourneyWrite::VetoUndo {
                tournament_id: t(),
                match_id: "m1".into(),
            },
            TourneyWrite::FactionVeto {
                tournament_id: t(),
                match_id: "m1".into(),
                game: 1,
                faction: TourneyFaction::Seraphim,
            },
            TourneyWrite::SetFactionVeto {
                tournament_id: t(),
                config: FactionVetoConfig::default(),
            },
            TourneyWrite::Administer {
                tournament_id: t(),
                change: TourneyAdmin::StopAt { alive: 4 },
            },
            TourneyWrite::SaveMap {
                tournament_id: t(),
                map: MapDraft::default(),
            },
            TourneyWrite::PublishMap {
                tournament_id: t(),
                map_id: "map1".into(),
                published: true,
            },
            TourneyWrite::DeleteMap {
                tournament_id: t(),
                map_id: "map1".into(),
            },
            TourneyWrite::PublishPool {
                tournament_id: t(),
                pool_id: "pl1".into(),
                published: false,
            },
            TourneyWrite::DeletePool {
                tournament_id: t(),
                pool_id: "pl1".into(),
            },
            TourneyWrite::SavePool {
                tournament_id: t(),
                pool: PoolDraft::default(),
            },
            TourneyWrite::SaveSeries {
                draft: SeriesDraft::default(),
            },
            TourneyWrite::DeleteSeries {
                series_id: "s1".into(),
            },
            TourneyWrite::SetSeries {
                tournament_id: t(),
                series_id: Some("s1".into()),
            },
            TourneyWrite::AddQualifier {
                tournament_id: t(),
                qualifier_id: "t2".into(),
                rule: QualifierRule::default(),
            },
            TourneyWrite::RemoveQualifier {
                tournament_id: t(),
                link_id: "q1".into(),
            },
            TourneyWrite::EditFormat {
                tournament_id: t(),
                format: FormatDraft::default(),
            },
            TourneyWrite::MuteChat {
                tournament_id: t(),
                faf_id: 42,
                name: "Zep".into(),
                muted: true,
            },
            TourneyWrite::DeleteChatPost {
                tournament_id: t(),
                room_id: "r1".into(),
                post_id: "c1".into(),
            },
            TourneyWrite::AddOrganiser {
                tournament_id: t(),
                faf_id: 42,
                name: "Zep".into(),
            },
            TourneyWrite::SetCaster {
                tournament_id: t(),
                faf_id: 42,
                name: "Zep".into(),
                casting: true,
            },
            TourneyWrite::SetOrganiserVisibility {
                tournament_id: t(),
                faf_id: 42,
                hidden: true,
            },
            TourneyWrite::Abandon {
                tournament_id: t(),
                abandoned: true,
            },
            TourneyWrite::EditNews {
                tournament_id: t(),
                news_id: "n1".into(),
                body: "Round 3".into(),
                important: false,
            },
        ]
    }

    /// Every `type` one half accepts, as serde lists them when refusing one
    /// it does not know.
    fn declared<T: serde::de::DeserializeOwned + std::fmt::Debug>() -> BTreeSet<String> {
        let refusal = serde_json::from_str::<T>(r#"{"type":"__none__"}"#)
            .expect_err("no half has this type")
            .to_string();
        let listed = refusal
            .split("expected one of ")
            .nth(1)
            .unwrap_or_else(|| panic!("serde named no variants: {refusal}"));
        listed
            .split(',')
            .filter_map(|name| name.split('`').nth(1))
            .map(str::to_owned)
            .collect()
    }

    fn tag(json: &serde_json::Value) -> String {
        json["type"].as_str().expect("tagged").to_owned()
    }

    #[test]
    fn every_command_keeps_its_wire_shape_and_lands_in_its_own_half() {
        let reads = every_read();
        let writes = every_write();

        let read_types = declared::<TourneyRead>();
        let write_types = declared::<TourneyWrite>();
        assert!(
            read_types.is_disjoint(&write_types),
            "a type in both halves would always deserialize as a read: {:?}",
            read_types.intersection(&write_types).collect::<Vec<_>>()
        );
        let sampled = |values: Vec<serde_json::Value>| -> BTreeSet<String> {
            values.iter().map(tag).collect()
        };
        assert_eq!(
            sampled(
                reads
                    .iter()
                    .map(|c| serde_json::to_value(c).unwrap())
                    .collect()
            ),
            read_types,
            "every read has a sample above"
        );
        assert_eq!(
            sampled(
                writes
                    .iter()
                    .map(|c| serde_json::to_value(c).unwrap())
                    .collect()
            ),
            write_types,
            "every write has a sample above"
        );

        let round_trip = |command: TourneyCommand, inner: serde_json::Value| {
            let wire = serde_json::to_value(AppCommand::from(command.clone())).unwrap();
            assert_eq!(wire["kind"], "Tourney");
            // No layer naming the half: the command is the inner enum's own
            // `{ type, payload }`, exactly what the webview sends.
            assert_eq!(wire["command"], inner);
            let back: AppCommand = serde_json::from_value(wire).unwrap();
            assert_eq!(back, AppCommand::Tourney(command));
        };
        for read in reads {
            let inner = serde_json::to_value(&read).unwrap();
            round_trip(TourneyCommand::Read(read), inner);
        }
        for write in writes {
            let inner = serde_json::to_value(&write).unwrap();
            round_trip(TourneyCommand::Write(write), inner);
        }
    }

    #[test]
    fn the_webviews_own_json_lands_in_the_right_half() {
        let parse = |json: &str| serde_json::from_str::<AppCommand>(json).unwrap();
        assert_eq!(
            parse(r#"{"kind":"Tourney","command":{"type":"load"}}"#),
            TourneyRead::Load.into()
        );
        assert_eq!(
            parse(
                r#"{"kind":"Tourney","command":{"type":"signUp","payload":{"tournamentId":"t1","rating":null}}}"#
            ),
            TourneyWrite::SignUp {
                tournament_id: "t1".into(),
                rating: None,
            }
            .into()
        );
        // `replyTo` may be left out, as it could before the split.
        assert_eq!(
            parse(
                r#"{"kind":"Tourney","command":{"type":"postChat","payload":{"tournamentId":"t1","roomId":"r1","body":"hi"}}}"#
            ),
            TourneyWrite::PostChat {
                tournament_id: "t1".into(),
                room_id: "r1".into(),
                body: "hi".into(),
                reply_to: None,
            }
            .into()
        );
        assert!(serde_json::from_str::<AppCommand>(
            r#"{"kind":"Tourney","command":{"type":"noSuchCommand"}}"#
        )
        .is_err());
    }
}
