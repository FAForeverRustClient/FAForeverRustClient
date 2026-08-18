//! The codec against a response the service actually produced.
//!
//! Every other tournament codec test builds its input with `json!`, which pins
//! the codec to *our reading* of `server.js` rather than to the service. That is
//! the reading that had already been wrong more than once: `viewer` was believed
//! not to exist, and a map pool's ban/pick order was read as a list of strings
//! when the service sends objects and the whole order was silently dropped.
//!
//! `recorded/tourney-detail.json` is a real `GET /api/t/{id}`, captured from
//! `faf-tournaments` run locally on a scratch data directory. The event was
//! built through the service's own endpoints, so the teams, the bracket and the
//! pool are the service's own output rather than hand-written shapes:
//!
//! - `POST /api/tournaments`, then `publish`
//! - `org_create_team` and `move_player` for four two-player teams
//! - `phase` `form_teams` then `start_bracket`, which drew the bracket below
//! - `map_save` four times, then `pool_save` with a Bo3 ban/pick order
//! - `news_post`
//!
//! `recorded/tourney-detail-organiser.json` is the same event fetched again with
//! `?token=<adminToken>`, which is what makes the service answer as an
//! organiser. It carries six fields the anonymous view does not: `tlog`,
//! `organizers`, `chatMutes`, `invites`, `createdByName` and `chatPingCount`.
//! Its `organizers`, `invites` and `chatMutes` were written into the scratch
//! database by hand, in the shapes the handlers that create them use, because
//! all three need a live FAF login the offline service cannot perform. The
//! service still rendered them, so the *served* shape is genuinely its own.
//!
//! To refresh either, run the service with `DATA_DIR` pointing somewhere scratch
//! and repeat those calls. Do not point it at a live instance.

use faf_domain::protocol::tourney::parse_tourney;
use faf_domain::state::{
    BracketSide, Competition, Formation, InviteStatus, MatchStatus, PoolAction, PoolSide,
    TourneyStatus,
};
use serde_json::Value;

fn recorded() -> Value {
    serde_json::from_str(include_str!("recorded/tourney-detail.json"))
        .expect("the recorded response is valid JSON")
}

fn recorded_as_organiser() -> Value {
    serde_json::from_str(include_str!("recorded/tourney-detail-organiser.json"))
        .expect("the recorded organiser response is valid JSON")
}

#[test]
fn the_recorded_response_parses_into_a_whole_tournament() {
    let event = parse_tourney(&recorded()).expect("a recorded detail is a tournament");

    assert_eq!(event.id, "177f518243");
    assert_eq!(event.name, "Conformance Sample");
    assert_eq!(event.status, TourneyStatus::Running);
    assert_eq!(event.competition, Competition::Team);
    assert_eq!(event.formation, Formation::Open);
    assert_eq!(event.team_size, 2);
    assert_eq!(event.players.len(), 8);
    assert_eq!(event.teams.len(), 4);
    assert_eq!(event.matches.len(), 6);
    assert_eq!(event.map_db.len(), 4);
    assert_eq!(event.map_pools.len(), 1);
    assert_eq!(event.news.len(), 1);
}

#[test]
fn the_viewer_block_is_present_and_read() {
    // The claim this settles: `publicView` does not build a `viewer`, so reading
    // that function alone suggests the field does not exist. `GET /api/t/{id}`
    // sets it on the finished document afterwards, and it is what every gate in
    // the tab hangs on.
    let document = recorded();
    assert!(document.get("viewer").is_some(), "the service sends it");

    let event = parse_tourney(&document).unwrap();
    // Captured without a session, which is the anonymous answer: signed out, no
    // organiser rights, no entry, no team.
    assert!(!event.viewer.logged_in);
    assert!(!event.viewer.organiser);
    assert_eq!(event.viewer.faf_id, None);
    assert_eq!(event.viewer.signed_up_player_id, None);
    assert_eq!(event.viewer.member_team_id, None);
}

#[test]
fn the_rating_gate_and_kind_survive_the_wire() {
    let event = parse_tourney(&recorded()).unwrap();
    assert_eq!(event.rating.min, Some(800));
    assert_eq!(event.rating.max, Some(2_200));
    assert_eq!(event.rating.max_team, Some(3_600));
    assert_eq!(event.rating.cap, Some(2_000));
}

#[test]
fn a_published_event_reads_as_published() {
    // Sent as `1`/`0` rather than a boolean, which is why it goes through the
    // same tolerant flag reader as the rest.
    let event = parse_tourney(&recorded()).unwrap();
    assert!(event.published);
    assert_eq!(event.publish_at, None);
    assert!(
        !event.may_publish(),
        "already out, so the control is withdrawn"
    );
}

#[test]
fn the_bracket_is_read_as_the_graph_the_service_drew() {
    // The service spells the sides `wb`, `lb` and `gf`, and names the match each
    // result feeds into. Both halves matter: the columns come from the side, the
    // connectors from the links.
    let event = parse_tourney(&recorded()).unwrap();

    let sides: Vec<BracketSide> = event.matches.iter().map(|entry| entry.bracket).collect();
    assert_eq!(
        sides,
        vec![
            BracketSide::Winners,
            BracketSide::Winners,
            BracketSide::Winners,
            BracketSide::Losers,
            BracketSide::Losers,
            BracketSide::GrandFinal,
        ]
    );

    let first = &event.matches[0];
    assert_eq!(first.status, MatchStatus::Ready);
    assert_eq!(first.best_of, 3, "sent as `bo`, not `bestOf`");
    assert_eq!(first.handicap, 0, "sent as `hcap`");
    assert!(first.team1.is_some() && first.team2.is_some());
    assert!(
        first.winner_to.is_some() && first.loser_to.is_some(),
        "a first-round match feeds both a winners and a losers slot"
    );

    // The grand final is the one match nothing feeds out of.
    let final_match = event.matches.last().unwrap();
    assert_eq!(final_match.bracket, BracketSide::GrandFinal);
    assert!(final_match.winner_to.is_none() && final_match.loser_to.is_none());
}

#[test]
fn a_pools_ban_and_pick_order_is_read_as_steps() {
    // The bug this pins: `sequence` is an array of `{action, team}` objects, and
    // reading it as a list of strings dropped every step without failing. The
    // pool below is a Bo3, so its order is one ban and two picks over four maps,
    // leaving the fourth as the decider.
    let event = parse_tourney(&recorded()).unwrap();
    let pool = &event.map_pools[0];

    assert_eq!(pool.name, "Round 1 Pool");
    assert_eq!(pool.best_of, Some(3));
    assert_eq!(pool.map_ids.len(), 4);
    assert_eq!(
        pool.sequence.len(),
        3,
        "one step short of the map count: the survivor is the decider"
    );

    let steps: Vec<(PoolAction, PoolSide)> = pool
        .sequence
        .iter()
        .map(|step| (step.action, step.team))
        .collect();
    assert_eq!(
        steps,
        vec![
            (PoolAction::Ban, PoolSide::A),
            (PoolAction::Pick, PoolSide::B),
            (PoolAction::Pick, PoolSide::A),
        ]
    );
}

#[test]
fn a_map_carries_the_image_field_the_service_actually_sends() {
    // `publicMapView` calls it `image`. The reader accepts several spellings,
    // and this is the one that has to keep working.
    let document = recorded();
    let raw = &document["mapDb"][0];
    assert!(raw.get("image").is_some(), "the field is called `image`");
    assert!(
        raw.get("imageUrl").is_none(),
        "and not `imageUrl`, which the reader also accepts"
    );

    let event = parse_tourney(&document).unwrap();
    assert_eq!(event.map_db.len(), 4);
    assert_eq!(event.map_db[0].name, "Setons Clutch");
}

#[test]
fn the_organiser_view_carries_the_audit_log() {
    // `tlog` is the only place a co-organiser can see what somebody else
    // changed, and the service sends it to nobody else: the anonymous capture
    // does not have the field at all.
    assert!(
        recorded().get("tlog").is_none(),
        "withheld from everyone but organisers"
    );

    let event = parse_tourney(&recorded_as_organiser()).unwrap();
    assert!(
        event.viewer.organiser,
        "the token makes the service answer so"
    );
    assert_eq!(event.audit_log.len(), 17);

    let newest = &event.audit_log[0];
    assert!(!newest.text.trim().is_empty());
    assert_eq!(newest.by, "Organizer link", "a token holder has no account");
    // Stored as milliseconds, read as seconds. A line that skipped the division
    // would date every entry to 1970 and sort the log into nonsense.
    let at = newest.at.expect("every line is stamped");
    assert!(
        at > 1_700_000_000 && at < 2_000_000_000,
        "seconds, not milliseconds: {at}"
    );

    // Newest first, which is the order the service reverses it into.
    let stamps: Vec<u32> = event.audit_log.iter().filter_map(|line| line.at).collect();
    assert!(
        stamps.windows(2).all(|pair| pair[0] >= pair[1]),
        "newest first"
    );
}

#[test]
fn the_organiser_view_names_every_organiser_including_the_hidden_one() {
    let event = parse_tourney(&recorded_as_organiser()).unwrap();

    // The public list carries names only, and drops anyone who hid themselves.
    assert_eq!(event.organisers, vec!["Organiser".to_string()]);
    // The organiser-only list carries accounts, and keeps them.
    assert_eq!(event.organiser_accounts.len(), 2);
    assert_eq!(event.organiser_accounts[0].faf_id, 9_001);
    assert!(!event.organiser_accounts[0].hidden);
    assert!(
        event.organiser_accounts[1].hidden,
        "hidden from the public list, still an organiser"
    );
}

#[test]
fn a_chat_mute_survives_its_faf_id_arriving_as_a_string() {
    // The service builds this list from `Object.keys`, so the id is a string
    // here and a number everywhere else. Reading it strictly drops every mute.
    let document = recorded_as_organiser();
    assert!(
        document["chatMutes"][0]["fafId"].is_string(),
        "a string, unlike every other fafId"
    );

    let event = parse_tourney(&document).unwrap();
    assert_eq!(event.chat_mutes.len(), 1);
    assert_eq!(event.chat_mutes[0].faf_id, 8_001);
    assert_eq!(event.chat_mutes[0].name, "Noisy");
}

#[test]
fn an_invitation_carries_the_answer_it_has_had_so_far() {
    let event = parse_tourney(&recorded_as_organiser()).unwrap();
    assert_eq!(event.invites.len(), 2);
    assert_eq!(event.invites[0].status, InviteStatus::Pending);
    assert_eq!(event.invites[1].status, InviteStatus::Declined);
    assert_eq!(event.invites[0].faf_id, 7_001);
}

#[test]
fn the_anonymous_view_has_none_of_the_organiser_lists() {
    // The other half of the rule: a reader who is not an organiser gets the
    // event with those fields absent, and the codec has to answer empty rather
    // than fail. Nothing in the tab may take their presence for granted.
    let event = parse_tourney(&recorded()).unwrap();
    assert!(event.audit_log.is_empty());
    assert!(event.organiser_accounts.is_empty());
    assert!(event.chat_mutes.is_empty());
    assert!(event.invites.is_empty());
    assert!(!event.viewer.organiser);
}

#[test]
fn every_field_the_service_sends_is_either_read_or_knowingly_ignored() {
    // A tripwire, not a rule: when the service grows a field, this fails and the
    // decision to read or ignore it gets made on purpose rather than by silence.
    //
    // Everything listed here is a field the tab does not use yet. The list is
    // the honest measure of how much of the service the client covers.
    //
    // Checked over both captures merged, so the organiser-only fields count
    // too. `organizers`, `tlog`, `chatMutes` and `invites` are read; what is
    // left of that set is below.
    const IGNORED: &[&str] = &[
        "archived",
        "cfg",
        "challongeDate",
        "chatLockAt",
        "chatPingCount",
        "createdByName",
        "descImages",
        "hasOrganizer",
        "importedGroups",
        "importedStandings",
        "importedType",
        "lobbyOptions",
        "maps",
        "minTeams",
        "mods",
        "myMentionCount",
        "myUnreadCount",
        "perRoundBo",
        "plan",
        "prize",
        "rewards",
        "rounds",
        "seeding",
        "source",
        "sourceUrl",
        "sponsors",
        "standingsOnly",
        "streams",
        "subs",
        "unreadByRoom",
    ];

    // Both captures, because the organiser view carries six fields the
    // anonymous one does not and they need the same decision made about them.
    let anonymous = recorded();
    let organiser = recorded_as_organiser();
    let mut merged = anonymous.as_object().unwrap().clone();
    merged.extend(organiser.as_object().unwrap().clone());
    let object = &merged;
    // Only the codec itself. Its own test module names most of these fields in
    // its fixtures, and a field mentioned solely by a test is not read.
    let whole = include_str!("../src/protocol/tourney.rs");
    // Whitespace collapsed, because rustfmt breaks a long accessor across two
    // lines and the match below is a substring, not a parser.
    let source: String = whole
        .split_once("#[cfg(test)]")
        .map_or(whole, |(codec, _)| codec)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");

    // Matched against a *read*, not against the name appearing anywhere. A
    // plain substring counts `create_body`'s `"signupMode"` as coverage, and
    // that is exactly how `signupMode` went unread for months while the edit
    // form guessed at it: it resent "open" and reopened invite-only events.
    let is_read = |name: &str| {
        source.contains(&format!("document, \"{name}\""))
            || source.contains(&format!("document .get(\"{name}\")"))
            || source.contains(&format!("document.get(\"{name}\")"))
    };
    let mut unaccounted: Vec<&str> = object
        .keys()
        .map(String::as_str)
        .filter(|name| !IGNORED.contains(name))
        .filter(|name| !is_read(name))
        .collect();
    unaccounted.sort_unstable();
    assert!(
        unaccounted.is_empty(),
        "the service sends fields the codec neither reads nor lists as ignored: {unaccounted:?}"
    );

    // A field on the ignore list that the codec does in fact read. The check
    // above cannot catch it, because it filters the ignored names out first, so
    // the list quietly turns into a claim nobody tests. Two entries had already
    // gone that way when this was added: `ffaCfg` and `draftOrder` were being
    // read while still listed as gaps.
    // Read *from the tournament document*, specifically. A plain substring
    // would also match `ffaCfg.rounds`, which is a different field of the same
    // name one level down, and `create_body`'s `"seeding"`, which is written
    // rather than read.
    let mut read_after_all: Vec<&str> = IGNORED
        .iter()
        .copied()
        .filter(|name| is_read(name))
        .collect();
    read_after_all.sort_unstable();
    assert!(
        read_after_all.is_empty(),
        "these are listed as knowingly ignored but the codec reads them: {read_after_all:?}"
    );

    // And the other direction: a field that stops being sent should not stay on
    // the ignore list pretending to be a known gap.
    let mut stale: Vec<&str> = IGNORED
        .iter()
        .copied()
        .filter(|name| !object.contains_key(*name))
        .collect();
    stale.sort_unstable();
    assert!(
        stale.is_empty(),
        "these are listed as knowingly ignored but no longer arrive: {stale:?}"
    );
}
