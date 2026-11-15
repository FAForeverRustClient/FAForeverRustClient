use super::*;
use faf_domain::state::TourneyStatus;
use serde_json::json;

#[test]
fn a_draft_alert_requires_a_live_turn_and_the_actual_captain() {
    let mut event = faf_domain::protocol::tourney::parse_tourney(&json!({
        "id": "cup", "status": "draft",
        "teams": [
            { "id": "t1", "captainId": "p1", "playerIds": ["p1", "p2"] },
            { "id": "t2", "captainId": "p3", "playerIds": ["p3"] }
        ],
        "draft": { "order": ["t1", "t2"], "current": 0 },
        "viewer": { "loggedIn": 1, "signedUpPlayerId": "p1", "memberTeamId": "t1" }
    }))
    .unwrap();
    assert!(is_my_draft_turn(&event));

    event.viewer.signed_up_player_id = Some("p2".into());
    assert!(
        !is_my_draft_turn(&event),
        "a team member is not its captain"
    );
    event.viewer.organiser = true;
    assert!(
        !is_my_draft_turn(&event),
        "organiser rights do not change whose turn it is"
    );
    event.viewer.signed_up_player_id = None;
    assert!(
        !is_my_draft_turn(&event),
        "an organiser need not be an entrant"
    );

    event.viewer.signed_up_player_id = Some("p1".into());
    event.viewer.logged_in = false;
    assert!(!is_my_draft_turn(&event));
    event.viewer.logged_in = true;
    for status in [
        TourneyStatus::Signup,
        TourneyStatus::Drafted,
        TourneyStatus::Finished,
    ] {
        event.status = status;
        assert!(!is_my_draft_turn(&event));
    }
    event.status = TourneyStatus::Draft;
    for current in [-1, 1, 2] {
        event.draft.as_mut().unwrap().current = current;
        assert!(!is_my_draft_turn(&event));
    }
    event.draft.as_mut().unwrap().current = 0;
    event.teams.clear();
    assert!(
        !is_my_draft_turn(&event),
        "an unknown team cannot have a captain"
    );
    event.draft = None;
    assert!(!is_my_draft_turn(&event));
}
