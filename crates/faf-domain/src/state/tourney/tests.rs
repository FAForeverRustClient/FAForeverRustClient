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
        entrants: Vec::new(),
        winners: Vec::new(),
        points: Vec::new(),
        is_final: false,
        replay_ids: Vec::new(),
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
            },
            TourneyMap {
                id: "m2".into(),
                name: "Astro".into(),
                image_url: String::new(),
                description: String::new(),
                published: true,
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
