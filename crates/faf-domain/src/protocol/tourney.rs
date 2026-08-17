//! Reading faf-tournaments' `publicView` document.
//!
//! `GET /api/t/{id}` returns the whole tournament in one object: players, teams,
//! matches, map pools and the map database together. That is deliberate on the
//! server's side and good for us: one request, and the parts can never
//! disagree with each other the way three separate Challonge calls could.
//!
//! Two conventions run through the whole document and are handled once here:
//!
//! - **Booleans are `0`/`1`**, being JSON from a codebase that stores flags as
//!   integers. Real booleans are accepted too, since some fields are written
//!   both ways.
//! - **Time comes in two shapes.** Machine stamps (`createdAt`, `signedAt`,
//!   `checkInDeadline`) are JavaScript milliseconds; the dates an organiser
//!   typed (`eventDate`, `signupOpensAt`, `signupClosesAt`) are ISO strings,
//!   sometimes only `YYYY-MM-DD`. Everything in `faf-domain` is Unix seconds,
//!   so both are converted here. Reading the milliseconds as seconds would put
//!   every tournament fifty thousand years in the future; ignoring the strings
//!   would leave every event without a date at all.
//!
//! Parsing is forgiving, for the same reason the Challonge codec was: a field
//! that moves should cost one row or one detail, never the whole tab.

use serde_json::{json, Value};

use crate::protocol::markup::to_plain_text;
use crate::state::{
    Article, BracketKind, BracketSide, ChatPost, ChatRoom, Competition, Formation, HostingStatus,
    MapPool, MatchLink, MatchStatus, PendingReport, PoolAssignment, RatingGate, RoomUnread,
    InviteStatus, NewsPost, TeamRequest, Tourney, TourneyCategory, TourneyDraft,
    TourneyInvite, TourneyMap, TourneyMatch, TourneyPlayer, TourneyStatus, TourneyTeam,
    TourneyViewer,
};

/// A string field, empty when absent or not a string.
fn text(value: &Value, name: &str) -> String {
    value
        .get(name)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// An opaque id. Numbers are accepted because a few are written as such, but
/// nothing here may depend on an id being numeric.
fn id(value: &Value, name: &str) -> Option<String> {
    match value.get(name)? {
        Value::String(text) if !text.trim().is_empty() => Some(text.trim().to_string()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

fn int(value: &Value, name: &str) -> Option<i32> {
    match value.get(name)? {
        Value::Number(number) => number.as_i64().and_then(|v| i32::try_from(v).ok()),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
}

/// A `0`/`1` flag, or a real boolean.
fn flag(value: &Value, name: &str) -> bool {
    match value.get(name) {
        Some(Value::Bool(value)) => *value,
        Some(Value::Number(number)) => number.as_i64().is_some_and(|value| value != 0),
        Some(Value::String(text)) => matches!(text.trim(), "1" | "true"),
        _ => false,
    }
}

/// A flag that means true when the server said nothing.
///
/// `playerReporting` defaults to on server-side (`=== undefined ? 1 : ...`), and
/// reading an absent value as "off" would silently take the report button away
/// from every player.
fn flag_or_true(value: &Value, name: &str) -> bool {
    match value.get(name) {
        None | Some(Value::Null) => true,
        _ => flag(value, name),
    }
}

/// A JavaScript millisecond timestamp as Unix seconds.
fn moment(value: &Value, name: &str) -> Option<u32> {
    let millis = match value.get(name)? {
        Value::Number(number) => number.as_i64()?,
        Value::String(text) => text.trim().parse().ok()?,
        _ => return None,
    };
    u32::try_from(millis / 1_000).ok().filter(|secs| *secs > 0)
}

/// A date an organiser typed, as Unix seconds.
///
/// The server normalises these through `cleanDate`, which keeps a bare
/// `YYYY-MM-DD` as it stands and turns anything else into a full ISO instant.
/// Both spellings are live in the database, so both are read; a date without a
/// time is taken as midnight UTC, which is how the server compares it too.
fn calendar_moment(value: &Value, name: &str) -> Option<u32> {
    let raw = value.get(name)?.as_str()?.trim();
    if raw.is_empty() {
        return None;
    }
    let seconds = chrono::DateTime::parse_from_rfc3339(raw)
        .map(|moment| moment.timestamp())
        .or_else(|_| {
            raw.parse::<chrono::NaiveDate>()
                .map(|date| date.and_time(chrono::NaiveTime::MIN).and_utc().timestamp())
        })
        .ok()?;
    u32::try_from(seconds).ok().filter(|secs| *secs > 0)
}

/// A count that is sometimes a collection.
///
/// `GET /api/tournaments` sends `players` and `teams` as numbers, while
/// `GET /api/t/{id}` sends the people themselves. One row type serves both, so
/// the list can say "14 entrants" without a request per tournament.
fn count(value: &Value, name: &str) -> i32 {
    match value.get(name) {
        Some(Value::Array(items)) => i32::try_from(items.len()).unwrap_or(i32::MAX),
        Some(_) => int(value, name).unwrap_or(0),
        None => 0,
    }
}

fn array<'a>(value: &'a Value, name: &str) -> &'a [Value] {
    value
        .get(name)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

/// Read one tournament document.
///
/// `None` only when the object has no usable id: everything is keyed on it, and
/// a tournament that cannot be addressed is worse than none.
pub fn parse_tourney(document: &Value) -> Option<Tourney> {
    Some(Tourney {
        id: id(document, "id")?,
        name: text(document, "name"),
        // Reduced here rather than in the view. The organiser writes this and
        // it is third-party markup; keeping it out of the state means it can
        // never be rendered as markup by mistake later.
        description: to_plain_text(&text(document, "description")),
        status: TourneyStatus::from_wire(&text(document, "status")),
        category: TourneyCategory::from_wire(&text(document, "category")),
        competition: Competition::from_wire(&text(document, "competition")),
        formation: Formation::from_wire(&text(document, "formation")),
        bracket_kind: BracketKind::from_wire(&text(document, "bracketType")),
        team_size: int(document, "teamSize").unwrap_or(1),
        divisions: int(document, "divisions").unwrap_or(0),
        player_reporting: flag_or_true(document, "playerReporting"),
        veto_enabled: document
            .get("veto")
            .is_some_and(|veto| flag(veto, "enabled")),
        rating: RatingGate {
            min: int(document, "minRating"),
            max: int(document, "maxRating"),
            max_team: int(document, "maxTeamRating"),
            cap: int(document, "ratingCap"),
        },
        created_at: moment(document, "createdAt"),
        // These four are typed by a person and stored as ISO text; the two
        // below them are machine stamps in milliseconds.
        event_date: calendar_moment(document, "eventDate"),
        signup_opens_at: calendar_moment(document, "signupOpensAt"),
        signup_closes_at: calendar_moment(document, "signupClosesAt"),
        check_in_opens_at: moment(document, "checkInOpensAt"),
        check_in_deadline: moment(document, "checkInDeadline"),
        chat_locked: flag(document, "chatLocked"),
        player_count: count(document, "players"),
        team_count: count(document, "teams"),
        players: array(document, "players")
            .iter()
            .filter_map(parse_player)
            .collect(),
        teams: array(document, "teams")
            .iter()
            .filter_map(parse_team)
            .collect(),
        matches: array(document, "matches")
            .iter()
            .filter_map(parse_match)
            .collect(),
        map_db: array(document, "mapDb")
            .iter()
            .filter_map(parse_map)
            .collect(),
        map_pools: array(document, "mapPools")
            .iter()
            .filter_map(parse_pool)
            .collect(),
        pool_assign: parse_pool_assign(document.get("poolAssign")),
        organisers: array(document, "organizersPublic")
            .iter()
            .map(|entry| text(entry, "name"))
            .filter(|name| !name.is_empty())
            .collect(),
        news: array(document, "news")
            .iter()
            .filter_map(parse_news)
            .collect(),
        invites: array(document, "invites")
            .iter()
            .filter_map(parse_invite)
            .collect(),
        champion_team_id: id(document, "championTeamId"),
        viewer: parse_viewer(document),
    })
}

/// The `viewer` block: who the server thinks is asking, and what they are in
/// this tournament.
///
/// Absent on the list endpoint, which is why the whole thing defaults rather
/// than failing: a list row simply has no viewer-specific answer.
fn parse_viewer(document: &Value) -> TourneyViewer {
    let Some(viewer) = document.get("viewer") else {
        return TourneyViewer::default();
    };
    TourneyViewer {
        logged_in: flag(viewer, "loggedIn"),
        organiser: flag(viewer, "organizer"),
        faf_id: int(viewer, "fafId"),
        faf_name: text(viewer, "fafName"),
        signed_up_player_id: id(viewer, "signedUpPlayerId"),
        member_team_id: id(viewer, "memberTeamId"),
        unread_by_room: parse_unread(document.get("unreadByRoom")),
    }
}

/// `unreadByRoom` is `{ roomId: count }`, flattened for the same reason
/// `poolAssign` is.
fn parse_unread(value: Option<&Value>) -> Vec<RoomUnread> {
    let Some(Value::Object(entries)) = value else {
        return Vec::new();
    };
    entries
        .iter()
        .filter_map(|(room_id, unread)| {
            let unread = unread.as_i64().and_then(|count| i32::try_from(count).ok())?;
            (unread > 0).then(|| RoomUnread {
                room_id: room_id.clone(),
                unread,
            })
        })
        .collect()
}

/// The tournament list, from `GET /api/tournaments`.
///
/// Accepts a bare array and a wrapped one, since the endpoint's exact envelope
/// is not pinned down and either costs one line to support.
pub fn parse_tourney_list(document: &Value) -> Vec<Tourney> {
    let items = match document {
        Value::Array(items) => items.as_slice(),
        Value::Object(_) => array(document, "tournaments"),
        _ => &[],
    };
    items.iter().filter_map(parse_tourney).collect()
}

fn parse_player(value: &Value) -> Option<TourneyPlayer> {
    Some(TourneyPlayer {
        id: id(value, "id")?,
        name: text(value, "name"),
        // The FAF account, first-class here. Written as a string by the server
        // but an integer everywhere in this client.
        faf_id: int(value, "fafId"),
        rating: int(value, "rating"),
        rating_actual: int(value, "ratingActual"),
        team_id: id(value, "teamId"),
        manual: flag(value, "manual"),
        late: flag(value, "late"),
        pending: flag(value, "pending"),
        note: text(value, "note"),
        signed_at: moment(value, "signedAt"),
    })
}

fn parse_team(value: &Value) -> Option<TourneyTeam> {
    Some(TourneyTeam {
        id: id(value, "id")?,
        name: text(value, "name"),
        seed: int(value, "seed").unwrap_or(0),
        captain_id: id(value, "captainId"),
        player_ids: string_list(value, "playerIds"),
        division: int(value, "division").unwrap_or(0),
        checked_in: flag(value, "checkedIn"),
        eliminated: flag(value, "eliminated"),
        final_rank: int(value, "finalRank"),
        join_requests: parse_requests(value, "joinRequests"),
        invites: parse_requests(value, "invites"),
    })
}

/// Join requests or invites hanging off a team.
///
/// Both directions of the same conversation, and the server spells them
/// identically, so one reader serves both.
fn parse_requests(value: &Value, name: &str) -> Vec<TeamRequest> {
    array(value, name)
        .iter()
        .filter_map(|asking| {
            Some(TeamRequest {
                player_id: id(asking, "playerId")?,
                name: text(asking, "name"),
                at: moment(asking, "at"),
            })
        })
        .collect()
}

fn parse_match(value: &Value) -> Option<TourneyMatch> {
    Some(TourneyMatch {
        id: id(value, "id")?,
        bracket: BracketSide::from_wire(&text(value, "bracket")),
        round: int(value, "round").unwrap_or(0),
        index: int(value, "index").unwrap_or(0),
        best_of: int(value, "bo").unwrap_or(1),
        handicap: int(value, "hcap").unwrap_or(0),
        division: int(value, "division").unwrap_or(0),
        team1: id(value, "team1"),
        team2: id(value, "team2"),
        score1: int(value, "score1"),
        score2: int(value, "score2"),
        status: MatchStatus::from_wire(&text(value, "status")),
        winner: id(value, "winner"),
        loser: id(value, "loser"),
        winner_to: parse_link(value.get("winnerTo")),
        loser_to: parse_link(value.get("loserTo")),
        pending_report: parse_pending_report(value.get("pendingReport")),
        replay_ids: string_list(value, "replayIds"),
    })
}

/// A score awaiting the other side's agreement.
///
/// `None` unless both scores are readable: a half-parsed pending report would
/// show one team a confirmation prompt for a result nobody can see.
fn parse_pending_report(value: Option<&Value>) -> Option<PendingReport> {
    let pending = value?;
    Some(PendingReport {
        score1: int(pending, "score1")?,
        score2: int(pending, "score2")?,
        by_team: id(pending, "byTeam")?,
        by_name: text(pending, "byName"),
        replay_ids: string_list(pending, "replayIds"),
        at: moment(pending, "at"),
    })
}

/// The edge to the match a result feeds into.
fn parse_link(value: Option<&Value>) -> Option<MatchLink> {
    let link = value?;
    Some(MatchLink {
        match_id: id(link, "id")?,
        // A link without a slot is unusable for placing the entrant, but the
        // edge itself still says where the winner goes, so it is kept with a
        // slot of 0 rather than dropped.
        slot: int(link, "slot").unwrap_or(0),
    })
}

fn parse_news(value: &Value) -> Option<NewsPost> {
    Some(NewsPost {
        id: id(value, "id")?,
        // Written by an organiser, so reduced like every other such field.
        body: to_plain_text(&text(value, "body")),
        by: text(value, "by"),
        at: moment(value, "at"),
        important: flag(value, "important"),
    })
}

/// One invitation.
///
/// Organiser-only: the server leaves `invites` out entirely for anyone else,
/// so an empty list means "not yours to see" as often as it means "nobody
/// invited".
fn parse_invite(value: &Value) -> Option<TourneyInvite> {
    Some(TourneyInvite {
        faf_id: int(value, "fafId")?,
        name: text(value, "name"),
        status: InviteStatus::from_wire(&text(value, "status")),
    })
}

fn parse_map(value: &Value) -> Option<TourneyMap> {
    Some(TourneyMap {
        id: id(value, "id")?,
        name: text(value, "name"),
        image_url: first_text(value, &["imageUrl", "image", "url", "preview"]),
    })
}

fn parse_pool(value: &Value) -> Option<MapPool> {
    Some(MapPool {
        id: id(value, "id")?,
        name: text(value, "name"),
        map_ids: string_list(value, "mapIds"),
        sequence: string_list(value, "sequence"),
        best_of: int(value, "bo"),
    })
}

/// `poolAssign` is an object keyed by round, which is awkward to iterate once it
/// crosses into TypeScript. Flattened to a list here, once.
fn parse_pool_assign(value: Option<&Value>) -> Vec<PoolAssignment> {
    let Some(Value::Object(entries)) = value else {
        return Vec::new();
    };
    entries
        .iter()
        .filter_map(|(round, pool)| {
            let pool_id = match pool {
                Value::String(text) if !text.trim().is_empty() => text.trim().to_string(),
                Value::Number(number) => number.to_string(),
                _ => return None,
            };
            Some(PoolAssignment {
                round: round.clone(),
                pool_id,
            })
        })
        .collect()
}

/// The rooms from `GET /api/t/{id}/chat_rooms`.
///
/// The server has already decided what this account may see, so nothing is
/// filtered here: a room that does not arrive is one it is not entitled to.
pub fn parse_chat_rooms(document: &Value) -> Vec<ChatRoom> {
    array(document, "rooms")
        .iter()
        .filter_map(|room| {
            let room_id = id(room, "id")?;
            Some(ChatRoom {
                name: room_label(room, &room_id),
                id: room_id,
                unread: int(room, "unread").unwrap_or(0),
            })
        })
        .collect()
}

/// A room's name, falling back to its id.
///
/// Every room the server sends has a label; a room reduced to `m1a2b` on screen
/// would be worse than useless, but it is still better than dropping the room
/// and hiding a conversation.
fn room_label(room: &Value, room_id: &str) -> String {
    let label = text(room, "label");
    if label.trim().is_empty() {
        room_id.to_string()
    } else {
        label
    }
}

/// The posts from `GET /api/t/{id}/chat_read`.
pub fn parse_chat_posts(document: &Value) -> Vec<ChatPost> {
    array(document, "messages")
        .iter()
        .filter_map(|post| {
            Some(ChatPost {
                id: id(post, "id")?,
                author: text(post, "who"),
                // Somebody else's typing, reduced like every other such field.
                body: to_plain_text(&text(post, "text")),
                at: moment(post, "at"),
                system: flag(post, "sys"),
            })
        })
        .collect()
}

/// The pages from `GET /api/articles`, in the order the editors put them.
pub fn parse_articles(document: &Value) -> Vec<Article> {
    let items = match document {
        Value::Array(items) => items.as_slice(),
        _ => array(document, "articles"),
    };
    items
        .iter()
        .filter_map(|article| {
            Some(Article {
                id: id(article, "id")?,
                title: text(article, "title"),
                body: to_plain_text(&text(article, "body")),
                parent_id: id(article, "parentId"),
            })
        })
        .collect()
}

/// Whether this account may host, from `GET /api/host_status`.
///
/// A development instance with no FAF login configured answers `allowed: 1`
/// for everyone, which is read rather than special-cased: the server is the
/// one that decides, and it says so in the same field either way.
pub fn parse_hosting(document: &Value) -> HostingStatus {
    HostingStatus {
        logged_in: flag(document, "loggedIn"),
        allowed: flag(document, "allowed"),
        pending: flag(document, "pending"),
    }
}

/// The body for `POST /api/tournaments`.
///
/// Deliberately short of everything the endpoint accepts. The server defaults
/// the best-of plan, the veto configuration and the free-text fields, and those
/// defaults are the tournament team's own; an absent key takes them, while a
/// blank one would overwrite them.
pub fn create_body(draft: &TourneyDraft) -> Value {
    let mut body = json!({
        "name": draft.name.trim(),
        "category": match draft.category {
            TourneyCategory::Official => "official",
            TourneyCategory::Community => "community",
        },
        "competition": match draft.competition {
            Competition::FreeForAll => "ffa",
            Competition::Team => "team",
        },
        "teamSize": draft.team_size,
        "formation": match draft.effective_formation() {
            Formation::Draft => "draft",
            // Anything else is `open` to the server, and it turns a team of one
            // into `solo` itself.
            _ => "open",
        },
        "bracketType": match draft.bracket_kind {
            BracketKind::Double => "double",
            BracketKind::Swiss => "swiss",
            BracketKind::Single => "single",
        },
        "seeding": draft.seeding.as_wire(),
        "ratingType": draft.rating_kind.as_wire(),
        "signupMode": draft.signup_mode.as_wire(),
        "playerReporting": draft.player_reporting,
        "maxTeams": draft.max_teams,
    });
    merge_shared(&mut body, draft);
    body
}

/// The body for `POST /api/t/{id}/edit_info`.
///
/// A narrower set than creation: the format, the team size and the category are
/// welded to a bracket that may already have been drawn, and the server keeps
/// separate endpoints for changing those.
pub fn edit_info_body(draft: &TourneyDraft) -> Value {
    let mut body = json!({
        "name": draft.name.trim(),
        "signupMode": draft.signup_mode.as_wire(),
        "playerReporting": draft.player_reporting,
    });
    merge_shared(&mut body, draft);
    body
}

/// The fields creation and editing spell the same way.
fn merge_shared(body: &mut Value, draft: &TourneyDraft) {
    body["description"] = json!(draft.description.trim());
    // `null` is meaningful rather than omitted: the server tells a cleared date
    // from an untouched one by whether the key is there at all.
    body["eventDate"] = iso(draft.event_date);
    body["signupOpensAt"] = iso(draft.signup_opens_at);
    body["signupClosesAt"] = iso(draft.signup_closes_at);
    body["minRating"] = gate(draft.rating.min);
    body["maxRating"] = gate(draft.rating.max);
    body["maxTeamRating"] = gate(draft.rating.max_team);
    body["ratingCap"] = gate(draft.rating.cap);
}

/// A rating bound, or `null` to clear it.
fn gate(value: Option<i32>) -> Value {
    value.map_or(Value::Null, |bound| json!(bound))
}

/// Unix seconds as the ISO instant `cleanDate` normalises to.
///
/// Text rather than a number, because `cleanDate` accepts only strings: a
/// timestamp sent as a number is read as "no date" and silently dropped.
fn iso(seconds: Option<u32>) -> Value {
    let Some(seconds) = seconds else {
        return Value::Null;
    };
    chrono::DateTime::from_timestamp(i64::from(seconds), 0).map_or(Value::Null, |moment| {
        json!(moment.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
    })
}

fn string_list(value: &Value, name: &str) -> Vec<String> {
    array(value, name)
        .iter()
        .filter_map(|entry| match entry {
            Value::String(text) if !text.trim().is_empty() => Some(text.trim().to_string()),
            Value::Number(number) => Some(number.to_string()),
            _ => None,
        })
        .collect()
}

/// The first of several candidate field names that holds a non-empty string.
///
/// The map image field name is not confirmed against a live response; this
/// covers the plausible spellings rather than guessing one and shipping a
/// bracket with no previews.
fn first_text(value: &Value, names: &[&str]) -> String {
    names
        .iter()
        .map(|name| text(value, name))
        .find(|found| !found.trim().is_empty())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A document shaped like `publicView`, with the conventions that matter:
    /// string ids, 0/1 flags, millisecond timestamps.
    fn document() -> Value {
        json!({
            "id": "e1a2b",
            "name": "Weekend Cup",
            "description": "<p>Best of three</p>",
            "status": "signup",
            "competition": "team",
            "formation": "open",
            "bracketType": "double",
            "teamSize": 2,
            "divisions": 0,
            "playerReporting": 1,
            "veto": { "enabled": 1, "mode": "upfront" },
            "minRating": 800,
            "maxRating": 2200,
            "createdAt": 1_785_000_000_000i64,
            "eventDate": "2026-08-22T18:00:00.000Z",
            "signupClosesAt": "2026-08-21",
            "chatLocked": 0,
            "viewer": {
                "loggedIn": 1, "organizer": 0, "fafId": 101, "fafName": "Nuggets",
                "signedUpPlayerId": "p1", "memberTeamId": "t1"
            },
            "unreadByRoom": { "global": 3, "m1": 0 },
            "players": [
                { "id": "p1", "name": "Nuggets", "fafId": 101, "rating": 1750,
                  "ratingActual": 1900, "teamId": "t1", "late": 0, "signedAt": 1_785_100_000_000i64 },
                { "id": "p2", "name": "Ada", "fafId": 102, "rating": 2100, "teamId": "t1" }
            ],
            "teams": [
                { "id": "t1", "name": "", "seed": 1, "captainId": "p1",
                  "playerIds": ["p1", "p2"], "checkedIn": 1 }
            ],
            "matches": [
                { "id": "m1", "bracket": "wb", "round": 1, "index": 0, "bo": 3,
                  "team1": "t1", "team2": "t2", "status": "ready",
                  "replayIds": ["22334455"],
                  "pendingReport": { "score1": 2, "score2": 1, "byTeam": "t1",
                                     "byName": "Nuggets", "replayIds": ["22334456", "22334457"],
                                     "at": 1_785_200_000_000i64 },
                  "winnerTo": { "id": "m3", "slot": 1 },
                  "loserTo": { "id": "m2", "slot": 2 } }
            ],
            "mapDb": [{ "id": "map1", "name": "Setons", "imageUrl": "https://x.invalid/s.png" }],
            "mapPools": [{ "id": "pool1", "name": "Round 1", "mapIds": ["map1"], "bo": 3 }],
            "poolAssign": { "1": "pool1" },
            "organizersPublic": [{ "name": "TD", "discord": "td#1" }],
        })
    }

    #[test]
    fn a_full_document_is_read() {
        let event = parse_tourney(&document()).expect("a tournament");
        assert_eq!(event.id, "e1a2b");
        assert_eq!(event.name, "Weekend Cup");
        assert_eq!(event.description, "Best of three", "markup is stripped");
        assert_eq!(event.status, TourneyStatus::Signup);
        assert_eq!(event.bracket_kind, BracketKind::Double);
        assert_eq!(event.team_size, 2);
        assert_eq!(event.rating.min, Some(800));
        assert_eq!(event.players.len(), 2);
        assert_eq!(event.teams.len(), 1);
        assert_eq!(event.organisers, vec!["TD".to_string()]);
    }

    #[test]
    fn machine_stamps_are_converted_from_milliseconds() {
        // The bug this exists for: JavaScript milliseconds read as seconds put
        // every tournament roughly fifty thousand years into the future.
        let event = parse_tourney(&document()).unwrap();
        assert_eq!(event.created_at, Some(1_785_000_000));
        assert_eq!(event.players[0].signed_at, Some(1_785_100_000));
    }

    #[test]
    fn the_dates_an_organiser_typed_are_read_as_text() {
        // The other half of the same bug, and the worse half: these arrive as
        // ISO strings, so reading only numbers would leave every tournament
        // without the one date players look for.
        let event = parse_tourney(&document()).unwrap();
        assert_eq!(event.event_date, Some(1_787_421_600), "full ISO instant");
        // A bare YYYY-MM-DD is legacy but still in the database. Midnight UTC,
        // which is how the server compares it too.
        assert_eq!(event.signup_closes_at, Some(1_787_270_400));

        let mut document = document();
        document["eventDate"] = json!(null);
        document["signupClosesAt"] = json!("not a date");
        let event = parse_tourney(&document).unwrap();
        assert_eq!(event.event_date, None);
        assert_eq!(event.signup_closes_at, None);
    }

    #[test]
    fn the_viewer_block_says_who_is_asking() {
        // Taken as given rather than matched on FAF id here: the server
        // authorises every write against this same answer.
        let event = parse_tourney(&document()).unwrap();
        assert!(event.viewer.logged_in);
        assert!(!event.viewer.organiser);
        assert_eq!(event.viewer.signed_up_player_id.as_deref(), Some("p1"));
        assert_eq!(event.viewer.member_team_id.as_deref(), Some("t1"));
        assert!(event.viewer.is_signed_up());
        assert_eq!(event.viewer.unread_in("global"), 3);
        assert_eq!(event.viewer.unread_in("m1"), 0, "zero is not carried");
        assert_eq!(event.viewer.unread_in("nowhere"), 0);
    }

    #[test]
    fn a_submitted_score_is_read_as_its_own_thing() {
        // Not a match status: the bracket has not moved, and both sides need to
        // see the same pending figure.
        let event = parse_tourney(&document()).unwrap();
        let pending = event.matches[0]
            .pending_report
            .as_ref()
            .expect("a score awaiting confirmation");
        assert_eq!((pending.score1, pending.score2), (2, 1));
        assert_eq!(pending.by_team, "t1");
        assert_eq!(pending.by_name, "Nuggets");
        assert_eq!(pending.replay_ids.len(), 2);
        assert_eq!(pending.at, Some(1_785_200_000));
        assert_eq!(event.matches[0].replay_ids, vec!["22334455".to_string()]);

        // The submitting side does not confirm its own report; the other does.
        assert!(!event.may_confirm(&event.matches[0]));
    }

    #[test]
    fn a_pending_report_without_a_score_is_dropped_rather_than_half_read() {
        let mut document = document();
        document["matches"][0]["pendingReport"] = json!({ "byTeam": "t1" });
        let event = parse_tourney(&document).unwrap();
        assert!(event.matches[0].pending_report.is_none());
    }

    #[test]
    fn integer_flags_read_as_booleans() {
        let event = parse_tourney(&document()).unwrap();
        assert!(event.player_reporting);
        assert!(event.veto_enabled);
        assert!(event.teams[0].checked_in);
        assert!(!event.players[0].late, "0 is false");
    }

    #[test]
    fn an_absent_player_reporting_flag_means_players_may_report() {
        // The server defaults it to on. Reading an absent value as "off" would
        // silently remove the report button for everyone.
        let mut document = document();
        document.as_object_mut().unwrap().remove("playerReporting");
        assert!(parse_tourney(&document).unwrap().player_reporting);

        document["playerReporting"] = json!(0);
        assert!(!parse_tourney(&document).unwrap().player_reporting);
    }

    #[test]
    fn the_bracket_graph_is_read_from_its_edges() {
        // The reason connectors no longer have to be inferred from geometry:
        // a match says where its winner and loser go.
        let event = parse_tourney(&document()).unwrap();
        let entry = &event.matches[0];
        assert_eq!(entry.bracket, BracketSide::Winners);
        assert_eq!(
            entry.winner_to,
            Some(MatchLink { match_id: "m3".into(), slot: 1 })
        );
        assert_eq!(
            entry.loser_to,
            Some(MatchLink { match_id: "m2".into(), slot: 2 })
        );
        assert!(entry.is_playable());
    }

    #[test]
    fn ids_stay_opaque_strings() {
        let event = parse_tourney(&document()).unwrap();
        assert_eq!(event.players[0].id, "p1");
        assert_eq!(event.teams[0].player_ids, vec!["p1", "p2"]);
        assert_eq!(event.matches[0].team1.as_deref(), Some("t1"));
    }

    #[test]
    fn map_pools_and_their_round_assignment_survive() {
        let event = parse_tourney(&document()).unwrap();
        assert_eq!(event.map_db[0].image_url, "https://x.invalid/s.png");
        let pool = event.pool_for_round("1").expect("bound to round 1");
        assert_eq!(pool.name, "Round 1");
        assert_eq!(event.pool_maps(pool)[0].name, "Setons");
    }

    #[test]
    fn a_team_without_a_name_falls_back_to_its_first_player() {
        let event = parse_tourney(&document()).unwrap();
        assert_eq!(event.teams[0].display_name(&event.players), "Nuggets");
    }

    #[test]
    fn a_document_without_an_id_is_refused() {
        // Everything is keyed on it; a tournament that cannot be addressed is
        // worse than none.
        assert!(parse_tourney(&json!({ "name": "No id" })).is_none());
        assert!(parse_tourney(&json!({ "id": "" })).is_none());
    }

    #[test]
    fn a_sparse_document_still_parses() {
        // Fields come and go; losing the row over a missing detail would hide a
        // real tournament.
        let event = parse_tourney(&json!({ "id": "e1" })).unwrap();
        assert_eq!(event.name, "");
        assert_eq!(event.team_size, 1);
        assert_eq!(event.status, TourneyStatus::Unknown);
        assert!(event.players.is_empty());
        assert!(event.matches.is_empty());
        assert!(event.player_reporting, "absent means allowed");
    }

    #[test]
    fn a_malformed_row_costs_only_that_row() {
        let mut document = document();
        document["players"] = json!([
            { "name": "No id at all" },
            { "id": "p9", "name": "Fine" }
        ]);
        let event = parse_tourney(&document).unwrap();
        assert_eq!(event.players.len(), 1);
        assert_eq!(event.players[0].name, "Fine");
    }

    #[test]
    fn the_list_endpoint_reads_bare_and_wrapped_arrays() {
        let bare = json!([{ "id": "a" }, { "id": "b" }]);
        assert_eq!(parse_tourney_list(&bare).len(), 2);

        let wrapped = json!({ "tournaments": [{ "id": "a" }] });
        assert_eq!(parse_tourney_list(&wrapped).len(), 1);

        for junk in [json!(null), json!("nope"), json!({})] {
            assert!(parse_tourney_list(&junk).is_empty(), "{junk}");
        }
    }

    #[test]
    fn chat_rooms_keep_the_servers_labels_and_unread_counts() {
        let rooms = parse_chat_rooms(&json!({
            "rooms": [
                { "id": "global", "label": "Global: everyone", "unread": 3 },
                { "id": "m1a2b", "label": "Nuggets vs Ada", "unread": 0 },
                { "id": "m9z9z" },
                { "label": "no id at all" }
            ],
            "muted": 0
        }));
        assert_eq!(rooms.len(), 3, "only the row without an id is dropped");
        assert_eq!(rooms[0].name, "Global: everyone");
        assert_eq!(rooms[0].unread, 3);
        // A room the client cannot name is still a room somebody is talking in.
        assert_eq!(rooms[2].name, "m9z9z");
    }

    #[test]
    fn chat_posts_are_reduced_to_plain_text() {
        let posts = parse_chat_posts(&json!({
            "room": "global",
            "messages": [
                { "id": "c1", "at": 1_785_300_000_000i64, "who": "Nuggets",
                  "text": "gl hf <b>everyone</b>" },
                { "id": "c2", "at": 1_785_300_060_000i64, "who": "Ada", "sys": 1,
                  "text": "Ada rolled 42 (1–100)" }
            ]
        }));
        assert_eq!(posts.len(), 2);
        assert_eq!(posts[0].author, "Nuggets");
        assert_eq!(posts[0].body, "gl hf everyone", "markup never survives");
        assert_eq!(posts[0].at, Some(1_785_300_000));
        assert!(!posts[0].system);
        assert!(posts[1].system, "the server rolled that, not a person");
    }

    #[test]
    fn articles_arrive_as_a_bare_list_with_their_nesting() {
        let articles = parse_articles(&json!([
            { "id": "art33adc81d9f78", "title": "Rules", "body": "<p>Be nice</p>", "order": 0 },
            { "id": "art8f783c6882c5", "title": "Maps", "body": "Vault only",
              "parentId": "art33adc81d9f78", "order": 1 },
            { "title": "no id" }
        ]));
        assert_eq!(articles.len(), 2);
        assert_eq!(articles[0].title, "Rules");
        assert_eq!(articles[0].body, "Be nice");
        assert_eq!(articles[0].parent_id, None);
        assert_eq!(articles[1].parent_id.as_deref(), Some("art33adc81d9f78"));
    }

    #[test]
    fn a_new_tournament_is_described_the_way_the_server_reads_it() {
        let body = create_body(&TourneyDraft {
            name: "  Weekend Cup  ".into(),
            description: "Best of three".into(),
            category: TourneyCategory::Official,
            team_size: 2,
            formation: Formation::Draft,
            bracket_kind: BracketKind::Double,
            event_date: Some(1_787_421_600),
            rating: RatingGate {
                min: Some(800),
                max: None,
                max_team: None,
                cap: None,
            },
            ..TourneyDraft::new()
        });
        assert_eq!(body["name"], "Weekend Cup");
        assert_eq!(body["category"], "official");
        assert_eq!(body["competition"], "team");
        assert_eq!(body["formation"], "draft");
        assert_eq!(body["bracketType"], "double");
        assert_eq!(body["teamSize"], 2);
        assert_eq!(body["playerReporting"], true);
        // Dates go as ISO text: `cleanDate` accepts only strings, and a number
        // would be read as no date at all.
        assert_eq!(body["eventDate"], "2026-08-22T18:00:00Z");
        assert_eq!(body["signupClosesAt"], Value::Null);
        assert_eq!(body["minRating"], 800);
        assert_eq!(body["maxRating"], Value::Null, "an absent bound clears it");
    }

    #[test]
    fn a_solo_event_never_asks_for_a_draft() {
        // The server forces the formation for a team of one, so the body says
        // so rather than being quietly overridden.
        let body = create_body(&TourneyDraft {
            name: "Ladder Cup".into(),
            team_size: 1,
            formation: Formation::Draft,
            ..TourneyDraft::new()
        });
        assert_eq!(body["formation"], "open");
    }

    #[test]
    fn editing_leaves_the_format_alone() {
        // Team size, category and bracket type are welded to a bracket that may
        // already exist; sending them here would be sending them nowhere.
        let body = edit_info_body(&TourneyDraft {
            name: "Weekend Cup".into(),
            ..TourneyDraft::new()
        });
        for welded in ["teamSize", "category", "bracketType", "competition", "formation"] {
            assert!(body.get(welded).is_none(), "{welded} must not be sent");
        }
        assert_eq!(body["name"], "Weekend Cup");
    }

    #[test]
    fn the_hosting_answer_is_read_rather_than_assumed() {
        let allowed = parse_hosting(&json!({ "oauth": 1, "allowed": 1, "pending": 0, "loggedIn": 1 }));
        assert!(allowed.allowed && allowed.logged_in && !allowed.pending);

        let waiting = parse_hosting(&json!({ "oauth": 1, "allowed": 0, "pending": 1, "loggedIn": 1 }));
        assert!(!waiting.allowed && waiting.pending);

        // Nothing at all is "not allowed", which is the safe reading.
        assert_eq!(parse_hosting(&json!({})), HostingStatus::default());
    }

    #[test]
    fn a_list_row_counts_its_entrants_without_a_second_request() {
        // The list sends `players` and `teams` as numbers where the detail
        // sends the people. One row type reads both, so "14 entrants" costs
        // nothing.
        let rows = parse_tourney_list(&json!([
            { "id": "a", "name": "Weekend Cup", "status": "signup", "players": 14, "teams": 7 }
        ]));
        assert_eq!(rows[0].player_count, 14);
        assert_eq!(rows[0].team_count, 7);
        assert!(rows[0].players.is_empty(), "the list carries no people");

        let detailed = parse_tourney(&document()).unwrap();
        assert_eq!(detailed.player_count, 2);
        assert_eq!(detailed.team_count, 1);
    }
}
