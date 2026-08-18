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
    Article, AuditEntry, BracketConfig, BracketKind, BracketSide, Caster, ChatMute, ChatPost,
    ChatRoom, Competition, Formation, HostingStatus, InviteStatus, MapPool, MatchLink, MatchStatus,
    NewsPost, Organiser, PendingReport, PoolAction, PoolAssignment, PoolSide, PoolStep, RatingGate,
    RatingKind, SignupMode, TeamExit, TeamRequest, Tourney, TourneyCategory, TourneyDraft,
    TourneyInvite, TourneyMap, TourneyMatch, TourneyPhase, TourneyPlayer, TourneyStatus,
    TourneyTeam, TourneyViewer,
};
use crate::state::{
    Draft, DraftPick, FfaConfig, FfaMode, MatchVeto, TeamPoints, VetoChoice, VetoConfig,
    VetoDecider, VetoMode,
};
use crate::state::{
    FeedsInto, FormatDraft, Qualifier, QualifierKind, QualifierRule, SeriesColour, SeriesDetail,
    SeriesDraft, SeriesEdition, TourneySeries,
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
        signup_mode: SignupMode::from_wire(&text(document, "signupMode")),
        max_teams: int(document, "maxTeams").unwrap_or(0).max(0),
        veto_enabled: document
            .get("veto")
            .is_some_and(|veto| flag(veto, "enabled")),
        rating: RatingGate {
            min: int(document, "minRating"),
            max: int(document, "maxRating"),
            max_team: int(document, "maxTeamRating"),
            cap: int(document, "ratingCap"),
        },
        // Both come with every answer. They were ignored for a while, and the
        // cost was a feature deleted as "impossible": an unrated event needs the
        // organiser to type a rating, and only `ratingType` says which events
        // those are.
        rating_kind: RatingKind::from_wire(&text(document, "ratingType")),
        rating_date: moment(document, "ratingDate"),
        created_at: moment(document, "createdAt"),
        // These four are typed by a person and stored as ISO text; the two
        // below them are machine stamps in milliseconds.
        event_date: calendar_moment(document, "eventDate"),
        signup_opens_at: calendar_moment(document, "signupOpensAt"),
        signup_closes_at: calendar_moment(document, "signupClosesAt"),
        check_in_opens_at: moment(document, "checkInOpensAt"),
        check_in_deadline: moment(document, "checkInDeadline"),
        chat_locked: flag(document, "chatLocked"),
        abandoned: flag(document, "abandoned"),
        chat_muted_me: flag(document, "chatMutedMe"),
        // Sent as `1`/`0`, and absent from a list row for anyone who cannot see
        // drafts, where a missing field must read as published rather than as
        // hidden: the row would not have been sent otherwise.
        imported: flag(document, "imported"),
        draft: document
            .get("draft")
            .filter(|held| held.is_object())
            .map(|held| Draft {
                order: string_list(held, "order"),
                current: int(held, "current").unwrap_or(0),
                last_pick: held
                    .get("lastPick")
                    .filter(|pick| pick.is_object())
                    .and_then(|pick| {
                        Some(DraftPick {
                            player_id: id(pick, "playerId")?,
                            team_id: id(pick, "teamId")?,
                            at_index: int(pick, "atIndex").unwrap_or(0),
                        })
                    }),
            }),
        pending_captains: string_list(document, "pendingCaptains"),
        draft_snakes: text(document, "draftOrder")
            .trim()
            .eq_ignore_ascii_case("snake"),
        ffa: document
            .get("ffaCfg")
            .filter(|cfg| cfg.is_object())
            .map(|cfg| FfaConfig {
                per_match: int(cfg, "perMatch").unwrap_or(0),
                advance: int(cfg, "advance").unwrap_or(1),
                mode: FfaMode::from_wire(&text(cfg, "mode")),
                rounds: int(cfg, "rounds").unwrap_or(0),
                cut_to: int(cfg, "cutTo").unwrap_or(0),
                final_size: int(cfg, "finalSize").unwrap_or(0),
            }),
        veto: VetoConfig {
            enabled: flag(document.get("veto").unwrap_or(&Value::Null), "enabled"),
            mode: VetoMode::from_wire(&text(document.get("veto").unwrap_or(&Value::Null), "mode")),
        },
        published: document
            .get("published")
            .is_none_or(|value| flag(document, "published") || value.is_null()),
        publish_at: moment(document, "publishAt"),
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
        audit_log: array(document, "tlog")
            .iter()
            .filter_map(parse_audit_entry)
            .collect(),
        organiser_accounts: array(document, "organizers")
            .iter()
            .filter_map(parse_organiser)
            .collect(),
        chat_mutes: array(document, "chatMutes")
            .iter()
            .filter_map(parse_chat_mute)
            .collect(),
        casters: array(document, "casters")
            .iter()
            .filter_map(|caster| {
                Some(Caster {
                    faf_id: int(caster, "fafId")?,
                    name: text(caster, "name"),
                })
            })
            .collect(),
        series_id: id(document, "seriesId"),
        series_name: text(document, "seriesName"),
        series_colour: SeriesColour::from_wire(&text(document, "seriesColor")),
        qualifiers: array(document, "qualifiers")
            .iter()
            .filter_map(parse_qualifier)
            .collect(),
        feeds_into: parse_feeds_into(document.get("feedsInto")),
        champion_team_id: id(document, "championTeamId"),
        viewer: parse_viewer(document),
    })
}

/// Who the service says is asking, and what they are in this tournament.
///
/// `GET /api/t/{id}` sets this on the response *after* `publicView` builds the
/// document, which is why reading `publicView` alone suggests it does not exist.
/// It does, and it is authoritative: the same session check decides it and
/// authorises every write, so a second opinion worked out client-side could only
/// ever disagree with the one that counts.
///
/// Absent from the list endpoint, where it defaults, correctly, because a list
/// row carries no viewer-specific answer and must offer no organiser control.
fn parse_viewer(document: &Value) -> TourneyViewer {
    let Some(viewer) = document.get("viewer") else {
        return TourneyViewer::default();
    };
    TourneyViewer {
        logged_in: flag(viewer, "loggedIn"),
        // Organiser rights *or* a held admin token: the service treats both as
        // authorised for every organiser write, so the tab has to as well.
        organiser: flag(viewer, "organizer") || flag(viewer, "admin"),
        faf_id: int(viewer, "fafId"),
        faf_name: text(viewer, "fafName"),
        signed_up_player_id: id(viewer, "signedUpPlayerId"),
        member_team_id: id(viewer, "memberTeamId"),
        caster: flag(viewer, "caster"),
        news_read_at: moment(viewer, "newsReadAt"),
    }
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

/// Where a team's run ended. Absent, null, or missing either half all mean the
/// same thing: still in it, or not decided yet.
fn parse_exit(value: Option<&Value>) -> Option<TeamExit> {
    let value = value?;
    Some(TeamExit {
        bracket: BracketSide::from_wire(&text(value, "bracket")),
        round: int(value, "round")?,
    })
}

/// One audit line. A line without text is dropped rather than shown blank:
/// the log is read as prose, and an empty row is noise in it.
fn parse_audit_entry(value: &Value) -> Option<AuditEntry> {
    let line = text(value, "text");
    if line.trim().is_empty() {
        return None;
    }
    let by = text(value, "by");
    Some(AuditEntry {
        at: moment(value, "at"),
        by: if by.trim().is_empty() {
            "Organizer".to_string()
        } else {
            by
        },
        text: line,
    })
}

fn parse_organiser(value: &Value) -> Option<Organiser> {
    Some(Organiser {
        faf_id: int(value, "fafId")?,
        name: text(value, "name"),
        hidden: flag(value, "hidden"),
    })
}

/// `fafId` arrives as a string here and as a number everywhere else: the
/// service builds this list from `Object.keys`, which stringifies. Read through
/// the tolerant integer reader rather than `as_i64`, or every mute is dropped.
fn parse_chat_mute(value: &Value) -> Option<ChatMute> {
    Some(ChatMute {
        faf_id: int(value, "fafId")?,
        name: text(value, "name"),
        at: moment(value, "at"),
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
        out: parse_exit(value.get("out")),
        final_rank: int(value, "finalRank"),
        captain_renamed: flag(value, "captainRenamed"),
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
        veto: parse_match_veto(value.get("veto")),
        entrants: string_list(value, "entrants"),
        winners: string_list(value, "winners"),
        // An object keyed by team id, read into an ordered list. `null` until
        // the lobby is reported, which is not the same as everybody on zero.
        points: value
            .get("points")
            .and_then(Value::as_object)
            .map(|scores| {
                scores
                    .iter()
                    .filter_map(|(team_id, points)| {
                        Some(TeamPoints {
                            team_id: team_id.clone(),
                            points: i32::try_from(points.as_i64()?).ok()?,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default(),
        is_final: flag(value, "isFinal"),
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
        edited_at: moment(value, "editedAt"),
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
        description: text(value, "description"),
        // Absent means visible: a list row that reached a player at all was one
        // the service was willing to show them.
        published: value
            .get("published")
            .is_none_or(|_| flag(value, "published")),
    })
}

/// One ban/pick step. A step missing either half is dropped rather than
/// defaulted: the service only ever stores complete pairs, so half a step is a
/// response we do not understand, and guessing the missing side would put a map
/// in front of the wrong team.
/// The ban/pick run of one match.
///
/// Absent for a match the service has not started one for, which is every match
/// in an event without vetoes and every match before its pool is assigned.
fn parse_match_veto(value: Option<&Value>) -> Option<MatchVeto> {
    let value = value?;
    if !value.is_object() {
        return None;
    }
    Some(MatchVeto {
        remaining: string_list(value, "remaining"),
        banned: array(value, "banned")
            .iter()
            .filter_map(parse_choice)
            .collect(),
        picks: array(value, "picks")
            .iter()
            .filter_map(parse_choice)
            .collect(),
        sequence: array(value, "sequence")
            .iter()
            .filter_map(parse_pool_step)
            .collect(),
        step_index: int(value, "stepIndex").unwrap_or(0),
        // Empty rather than absent until an organiser has chosen, and an empty
        // string is not a team id.
        team_a: id(value, "teamA"),
        team_b: id(value, "teamB"),
        done: flag(value, "done"),
        decider: parse_decider(value.get("decider")),
    })
}

fn parse_choice(value: &Value) -> Option<VetoChoice> {
    Some(VetoChoice {
        map: id(value, "map")?,
        by: text(value, "by"),
        game: int(value, "game"),
    })
}

fn parse_decider(value: Option<&Value>) -> Option<VetoDecider> {
    let value = value?;
    Some(VetoDecider {
        map: id(value, "map")?,
        game: int(value, "game").unwrap_or(0),
    })
}

fn parse_pool_step(value: &Value) -> Option<PoolStep> {
    let action = value.get("action")?.as_str()?;
    let team = value.get("team")?.as_str()?;
    Some(PoolStep {
        action: PoolAction::from_wire(action),
        team: PoolSide::from_wire(team),
    })
}

fn parse_pool(value: &Value) -> Option<MapPool> {
    Some(MapPool {
        id: id(value, "id")?,
        name: text(value, "name"),
        map_ids: string_list(value, "mapIds"),
        sequence: array(value, "sequence")
            .iter()
            .filter_map(parse_pool_step)
            .collect(),
        best_of: int(value, "bo"),
        published: flag(value, "published"),
        publish_at: moment(value, "publishAt"),
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
                // The three flags the list is built out of. They were dropped
                // for a while, and with them went the whole shape of the room
                // list: every finished match's room stayed in the live list,
                // an `@` went unannounced, and an organiser had no way to see
                // which room had asked for them.
                done: flag(room, "done"),
                mentioned: flag(room, "mention"),
                needs_organiser: flag(room, "ping"),
                count: int(room, "count").unwrap_or(0),
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
                // The account behind the name, which is what silencing them
                // needs: `chat_mute` is addressed by FAF id, and the name is
                // free text the service stores rather than resolves.
                faf_id: int(post, "fafId"),
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
    });
    merge_shared(&mut body, draft);
    body
}

/// The fields creation and editing spell the same way.
fn merge_shared(body: &mut Value, draft: &TourneyDraft) {
    body["description"] = json!(draft.description.trim());
    // Always off, and always sent. The client has no player reporting path at
    // all: `report_submit` was removed, and the organiser records every result.
    // The key has to be present to say so, because the service reads an absent
    // one as *on* (`playerReporting === undefined ? true`), which would leave
    // every event created here accepting scores the client cannot show.
    body["playerReporting"] = json!(false);
    // `null` is meaningful rather than omitted: the server tells a cleared date
    // from an untouched one by whether the key is there at all.
    body["eventDate"] = iso(draft.event_date);
    body["signupOpensAt"] = iso(draft.signup_opens_at);
    body["signupClosesAt"] = iso(draft.signup_closes_at);
    // Milliseconds on the way out as well as in: the service stores this one as
    // `new Date(x).getTime()`, unlike the three above, which it keeps as text.
    // An ISO instant parses to the right number either way.
    body["ratingDate"] = iso(draft.rating_date);
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

/// The series list, from `GET /api/series`.
///
/// Already sorted by the service: running series first, then by most recent
/// activity. Kept in that order rather than re-sorted here, because the key it
/// sorts on ("is any edition still being played") is worked out from every
/// tournament in the database, and the client holds only the ones it was sent.
pub fn parse_series_list(document: &Value) -> Vec<TourneySeries> {
    let items = match document {
        Value::Array(items) => items.as_slice(),
        Value::Object(_) => array(document, "series"),
        _ => &[],
    };
    items.iter().filter_map(parse_series).collect()
}

fn parse_series(value: &Value) -> Option<TourneySeries> {
    Some(TourneySeries {
        id: id(value, "id")?,
        name: text(value, "name"),
        description: to_plain_text(&text(value, "description")),
        colour: SeriesColour::from_wire(&text(value, "color")),
        category: parse_series_category(value),
        editions: int(value, "editions").unwrap_or(0),
        active: int(value, "activeCount").unwrap_or(0),
        // A millisecond stamp, unlike every other date on this endpoint: the
        // service builds it with `getTime()` rather than storing it.
        last_at: moment(value, "lastMs"),
        latest_id: id(value, "latestId"),
        latest_name: text(value, "latestName"),
        latest_date: calendar_moment(value, "latestDate"),
    })
}

/// One series with its editions, from `GET /api/series/{id}`.
///
/// `None` when the wrapper carries no series object, which is what a 404 looks
/// like once the status is past: the endpoint answers `{error}` and nothing to
/// build a series out of.
pub fn parse_series_detail(document: &Value) -> Option<SeriesDetail> {
    let series = document.get("series")?;
    Some(SeriesDetail {
        id: id(series, "id")?,
        name: text(series, "name"),
        description: to_plain_text(&text(series, "description")),
        colour: SeriesColour::from_wire(&text(series, "color")),
        category: parse_series_category(series),
        editions: array(document, "editions")
            .iter()
            .filter_map(parse_series_edition)
            .collect(),
        can_edit: flag(document, "canEdit"),
    })
}

/// A series' category, where it has one.
///
/// `null` unless a site admin tagged it, and distinct from a tournament's, which
/// defaults to `community`: an untagged *series* is untagged, not community, and
/// the two show differently.
fn parse_series_category(value: &Value) -> Option<TourneyCategory> {
    match text(value, "category").trim().to_ascii_lowercase().as_str() {
        "official" => Some(TourneyCategory::Official),
        "community" => Some(TourneyCategory::Community),
        _ => None,
    }
}

fn parse_series_edition(value: &Value) -> Option<SeriesEdition> {
    Some(SeriesEdition {
        id: id(value, "id")?,
        name: text(value, "name"),
        status: TourneyStatus::from_wire(&text(value, "status")),
        category: parse_series_category(value),
        published: flag(value, "published"),
        competition: Competition::from_wire(&text(value, "competition")),
        bracket_kind: BracketKind::from_wire(&text(value, "bracketType")),
        team_size: int(value, "teamSize").unwrap_or(1),
        player_count: count(value, "players"),
        team_count: count(value, "teams"),
        event_date: calendar_moment(value, "eventDate"),
        abandoned: flag(value, "abandoned"),
        champion_team_id: id(value, "championTeamId"),
        champion: text(value, "champion"),
    })
}

fn parse_qualifier(value: &Value) -> Option<Qualifier> {
    Some(Qualifier {
        id: id(value, "id")?,
        tournament_id: id(value, "tournamentId")?,
        name: text(value, "name"),
        // Absent where the child has been deleted, which is exactly when the
        // name is the service's own placeholder rather than a tournament's.
        status: value
            .get("status")
            .and_then(Value::as_str)
            .map(TourneyStatus::from_wire),
        rule: parse_qualifier_rule(value.get("rule")),
        applied: moment(value, "applied"),
        qualified: string_list(value, "qualified"),
        unreachable: string_list(value, "unreachable"),
    })
}

/// A qualifier's rule, defaulted the way the service defaults it.
///
/// `null` is live here: `qualifier_add` stores whatever `{type, n}` it built,
/// but a link written before the field existed has none, and the service reads
/// that as top-1 through the same clamping this mirrors.
fn parse_qualifier_rule(value: Option<&Value>) -> QualifierRule {
    let Some(rule) = value.filter(|rule| rule.is_object()) else {
        return QualifierRule::default();
    };
    QualifierRule {
        kind: QualifierKind::from_wire(&text(rule, "type")),
        n: int(rule, "n").unwrap_or(1).max(1),
    }
}

fn parse_feeds_into(value: Option<&Value>) -> Option<FeedsInto> {
    let value = value.filter(|found| found.is_object())?;
    Some(FeedsInto {
        parent_id: id(value, "parentId")?,
        parent_name: text(value, "parentName"),
        rule: parse_qualifier_rule(value.get("rule")),
        applied: moment(value, "applied"),
    })
}

/// The body for `POST /api/t/{id}/edit_format`.
///
/// Deliberately short of what the endpoint accepts. The best-of plan per round
/// (`plan`, `perRoundBo`), the seeding policy and the entrant cap are left out
/// entirely, so the service keeps whatever is there: an absent key takes the
/// existing value, while a present one is an instruction. None of the three is
/// read off the event, so anything this sent for them would be a guess that
/// overwrites.
///
/// The structural keys are sent only when they are actually being changed. The
/// service refuses all four outside signups *as a group*, on presence alone, so
/// resending an unchanged team size would turn an ordinary bracket-type change
/// during a draft into "Reopen signups to change the team setup".
pub fn edit_format_body(format: &FormatDraft, structural: bool) -> Value {
    // `seeding` and `maxTeams` are deliberately absent, for the same reason
    // `plan` is: the client does not read either field off the event, so any
    // value it sent would be a guess. The service treats a present key as an
    // instruction, so guessing would reset the seeding policy and clear the
    // entrant cap every time an organiser changed the bracket type.
    let mut body = json!({
        "bracketType": match format.bracket_kind {
            BracketKind::Double => "double",
            BracketKind::Swiss => "swiss",
            BracketKind::Single => "single",
        },
    });
    if structural {
        body["competition"] = json!(match format.competition {
            Competition::FreeForAll => "ffa",
            Competition::Team => "team",
        });
        body["teamSize"] = json!(format.team_size);
        body["formation"] = json!(match format.formation {
            Formation::Draft => "draft",
            _ => "open",
        });
        body["draftOrder"] = json!(if format.draft_snakes {
            "snake"
        } else {
            "linear"
        });
    }
    body
}

/// The body for `POST /api/t/{id}/phase`.
///
/// The config rides along only on `start_bracket`, and only when the organiser
/// changed something: an absent one lets the service default every value from
/// the event's stored plan, which is what drawing a bracket did before this
/// existed and what it still does if the dialog is accepted unchanged.
pub fn phase_body(phase: TourneyPhase, config: Option<&BracketConfig>) -> Value {
    let mut body = json!({ "action": phase.as_wire() });
    let Some(config) = config.filter(|_| phase == TourneyPhase::StartBracket) else {
        return body;
    };
    body["config"] = match config {
        // A free-for-all is drawn from `ffaCfg` and takes no config at all.
        BracketConfig::FreeForAll => json!({}),
        BracketConfig::Single { rounds } => json!({ "rounds": rounds }),
        BracketConfig::Double {
            wb,
            lb,
            gf,
            lb_handicap,
        } => json!({ "wb": wb, "lb": lb, "gf": gf, "lbHandicap": lb_handicap }),
        BracketConfig::Swiss {
            rounds,
            best_of,
            final_match,
            final_best_of,
            fast,
        } => json!({
            "rounds": rounds,
            "bo": best_of,
            "final": final_match,
            "finalBo": final_best_of,
            "fast": fast,
        }),
    };
    body
}

/// The body for `POST /api/t/{id}/add_caster`.
///
/// The id goes as a number here, unlike the organiser and mute lists: this
/// endpoint is new and reads `b.fafId` directly rather than through the string
/// keys those two are stored under.
pub fn add_caster_body(faf_id: i32, name: &str) -> Value {
    json!({ "fafId": faf_id, "name": name })
}

/// The body for `POST /api/t/{id}/remove_caster`.
pub fn remove_caster_body(faf_id: i32) -> Value {
    json!({ "fafId": faf_id })
}

/// The body for `POST /api/t/{id}/chat_mute`.
///
/// Unmuting is the same call with `unmute` set, not a separate action, and the
/// name rides along because the service stores it beside the id: the muted list
/// is built from object keys and has nothing else to resolve a name from.
pub fn chat_mute_body(faf_id: i32, name: &str, muted: bool) -> Value {
    json!({ "fafId": faf_id.to_string(), "name": name, "unmute": !muted })
}

/// The body for `POST /api/t/{id}/chat_delete`.
///
/// `room` rather than `roomId`, matching the rest of the chat surface.
pub fn chat_delete_body(room_id: &str, post_id: &str) -> Value {
    json!({ "room": room_id, "id": post_id })
}

/// The body for `POST /api/t/{id}/add_organizer`.
///
/// The id is sent as text: the service keeps its organiser list as strings and
/// compares with `indexOf`, so a number would be added and then never found
/// again by any of the checks that read it.
pub fn add_organiser_body(faf_id: i32, name: &str) -> Value {
    json!({ "fafId": faf_id.to_string(), "name": name })
}

/// The body for `POST /api/t/{id}/organizer_visibility`.
pub fn organiser_visibility_body(faf_id: i32, hidden: bool) -> Value {
    json!({ "fafId": faf_id.to_string(), "hidden": hidden })
}

/// The body for `POST /api/t/{id}/abandon`.
///
/// Taking it back is the same call with `undo`, so there is one action rather
/// than a pair that could disagree about what the flag means.
pub fn abandon_body(abandoned: bool) -> Value {
    json!({ "undo": !abandoned })
}

/// The body for `POST /api/t/{id}/news_edit`.
pub fn edit_news_body(news_id: &str, body: &str, important: bool) -> Value {
    json!({ "id": news_id, "body": body.trim(), "important": important })
}

/// The body for `POST /api/series` with `action: create` or `update`.
///
/// One body for both, because the service takes one: the presence of an id is
/// what tells them apart, and every other key means the same thing either way.
/// `category` is sent as `null` to clear the tag, which the service accepts and
/// an absent key would not.
pub fn series_body(draft: &SeriesDraft) -> Value {
    let mut body = json!({
        "action": if draft.id.trim().is_empty() { "create" } else { "update" },
        "name": draft.name.trim(),
        "description": draft.description.trim(),
        "color": draft.colour.as_wire(),
        "category": match draft.category {
            Some(TourneyCategory::Official) => json!("official"),
            Some(TourneyCategory::Community) => json!("community"),
            None => Value::Null,
        },
    });
    if !draft.id.trim().is_empty() {
        body["id"] = json!(draft.id.trim());
    }
    body
}

/// The body for `POST /api/series` with `action: delete`.
///
/// Deleting a series does not delete its editions: the service unfiles each of
/// them and leaves the tournaments alone.
pub fn delete_series_body(series_id: &str) -> Value {
    json!({ "action": "delete", "id": series_id })
}

/// The body for `POST /api/t/{id}/set_series`.
///
/// An empty id is how a tournament leaves its series, and is the reason this
/// takes an `Option` rather than a `&str`: the service reads a blank string as
/// "unfile me" and an unknown one as an error, so the two must not collapse.
pub fn set_series_body(series_id: Option<&str>) -> Value {
    json!({ "seriesId": series_id.unwrap_or_default() })
}

/// The body for `POST /api/t/{id}/qualifier_add`.
pub fn qualifier_add_body(tournament_id: &str, rule: QualifierRule) -> Value {
    json!({
        "tournamentId": tournament_id,
        "ruleType": rule.kind.as_wire(),
        "n": rule.n.max(1),
    })
}

/// The body for `POST /api/t/{id}/qualifier_remove`.
///
/// Addressed by the link's own id, not the child's: a link removed here keeps
/// any invites it already sent, which is the service's choice and the reason
/// removing one is not an undo.
pub fn qualifier_remove_body(link_id: &str) -> Value {
    json!({ "id": link_id })
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

    /// The viewer block, which the detail endpoint adds on top of `publicView`.
    ///
    /// Worth a test of its own because every gate in the tab hangs on it: the
    /// entry button, the organiser controls, every team action. Read the document
    /// wrongly and the whole tab is inert while nothing fails.
    #[test]
    fn the_viewer_block_says_who_is_asking() {
        let event = parse_tourney(&document()).unwrap();
        assert!(event.viewer.logged_in);
        assert!(!event.viewer.organiser);
        assert_eq!(event.viewer.signed_up_player_id.as_deref(), Some("p1"));
        assert_eq!(event.viewer.member_team_id.as_deref(), Some("t1"));
        assert!(event.viewer.is_signed_up());
    }

    /// A held organiser token counts as organising.
    ///
    /// The service authorises every organiser write on `isAdmin(t, token) ||
    /// isOrganizer(t, req)`, so reading only `organizer` would hide the controls
    /// from somebody the service would obey.
    #[test]
    fn an_admin_token_counts_as_organising() {
        let mut document = document();
        document["viewer"] = json!({ "loggedIn": 1, "organizer": 0, "admin": 1 });
        assert!(parse_tourney(&document).unwrap().viewer.organiser);
    }

    /// The list endpoint sends no viewer block, and must not gain one by accident:
    /// a list row that claimed organiser rights would draw controls for every
    /// tournament on screen.
    #[test]
    fn a_list_row_has_no_viewer() {
        let mut document = document();
        document
            .as_object_mut()
            .expect("the fixture is an object")
            .remove("viewer");
        assert_eq!(
            parse_tourney(&document).unwrap().viewer,
            TourneyViewer::default()
        );
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
            Some(MatchLink {
                match_id: "m3".into(),
                slot: 1
            })
        );
        assert_eq!(
            entry.loser_to,
            Some(MatchLink {
                match_id: "m2".into(),
                slot: 2
            })
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
        // Always sent, always off. An absent key would be read as *on*, and the
        // client has no player reporting path to show for it.
        assert_eq!(body["playerReporting"], false);
        // Dates go as ISO text: `cleanDate` accepts only strings, and a number
        // would be read as no date at all.
        assert_eq!(body["eventDate"], "2026-08-22T18:00:00Z");
        assert_eq!(body["signupClosesAt"], Value::Null);
        assert_eq!(body["minRating"], 800);
        assert_eq!(body["maxRating"], Value::Null, "an absent bound clears it");
    }

    #[test]
    fn the_rating_date_goes_out_as_an_instant_on_both_paths() {
        // The one date the service stores as a number rather than as text: it
        // writes `new Date(x).getTime()`. An ISO instant parses to the right
        // millisecond either way, and `null` is what clears it.
        let draft = TourneyDraft {
            name: "Weekend Cup".into(),
            rating_date: Some(1_787_421_600),
            ..TourneyDraft::new()
        };
        assert_eq!(create_body(&draft)["ratingDate"], "2026-08-22T18:00:00Z");
        assert_eq!(edit_info_body(&draft)["ratingDate"], "2026-08-22T18:00:00Z");

        let cleared = TourneyDraft {
            rating_date: None,
            ..draft
        };
        assert_eq!(create_body(&cleared)["ratingDate"], Value::Null);
        assert_eq!(edit_info_body(&cleared)["ratingDate"], Value::Null);
    }

    #[test]
    fn neither_path_ever_turns_player_reporting_on() {
        // The service reads an absent key as on, so both bodies have to say no
        // rather than stay quiet. Nothing in the client can show a player's
        // report, and `report_submit` is gone.
        let draft = TourneyDraft {
            name: "Weekend Cup".into(),
            ..TourneyDraft::new()
        };
        assert_eq!(create_body(&draft)["playerReporting"], false);
        assert_eq!(edit_info_body(&draft)["playerReporting"], false);
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
        for welded in [
            "teamSize",
            "category",
            "bracketType",
            "competition",
            "formation",
        ] {
            assert!(body.get(welded).is_none(), "{welded} must not be sent");
        }
        assert_eq!(body["name"], "Weekend Cup");
    }

    #[test]
    fn the_hosting_answer_is_read_rather_than_assumed() {
        let allowed =
            parse_hosting(&json!({ "oauth": 1, "allowed": 1, "pending": 0, "loggedIn": 1 }));
        assert!(allowed.allowed && allowed.logged_in && !allowed.pending);

        let waiting =
            parse_hosting(&json!({ "oauth": 1, "allowed": 0, "pending": 1, "loggedIn": 1 }));
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

    #[test]
    fn a_format_change_sends_the_team_setup_only_when_it_changes() {
        // The service refuses those four keys outside signups on *presence*
        // alone, not on whether they differ. Resending an unchanged team size
        // alongside a bracket change would be refused for touching neither.
        let format = FormatDraft {
            competition: Competition::Team,
            team_size: 2,
            formation: Formation::Draft,
            bracket_kind: BracketKind::Swiss,
            draft_snakes: true,
        };

        let bracket_only = edit_format_body(&format, false);
        assert_eq!(bracket_only["bracketType"], "swiss");
        for structural in ["competition", "teamSize", "formation", "draftOrder"] {
            assert!(
                bracket_only.get(structural).is_none(),
                "{structural} must not ride along"
            );
        }

        let whole = edit_format_body(&format, true);
        assert_eq!(whole["competition"], "team");
        assert_eq!(whole["teamSize"], 2);
        assert_eq!(whole["formation"], "draft");
        assert_eq!(whole["draftOrder"], "snake");

        // Never sent, in either shape: the client reads none of these off the
        // event, so any value here would overwrite with a guess.
        for guessed in ["plan", "perRoundBo", "seeding", "maxTeams"] {
            assert!(
                whole.get(guessed).is_none() && bracket_only.get(guessed).is_none(),
                "{guessed} is not ours to send"
            );
        }
    }

    #[test]
    fn the_small_organiser_writes_spell_their_ids_the_way_the_service_stores_them() {
        // Every one of these is keyed by FAF id, and the service keeps those as
        // *strings*: it builds the lists with `Object.keys` and compares with
        // `indexOf`. A number would be written and then never found again.
        assert_eq!(chat_mute_body(101, "Nuggets", true)["fafId"], "101");
        assert_eq!(add_organiser_body(101, "Nuggets")["fafId"], "101");
        assert_eq!(organiser_visibility_body(101, true)["fafId"], "101");

        // Muting and unmuting are one action with a flag, so the two can never
        // disagree about what the flag means.
        assert_eq!(chat_mute_body(101, "Nuggets", true)["unmute"], false);
        assert_eq!(chat_mute_body(101, "Nuggets", false)["unmute"], true);
        assert_eq!(abandon_body(true)["undo"], false);
        assert_eq!(abandon_body(false)["undo"], true);

        // `room`, not `roomId`, matching the rest of the chat surface.
        let deleted = chat_delete_body("global", "c1");
        assert_eq!(deleted["room"], "global");
        assert_eq!(deleted["id"], "c1");

        assert_eq!(edit_news_body("n1", "  moved  ", true)["body"], "moved");
    }

    #[test]
    fn the_best_of_plan_rides_along_with_the_draw_and_nothing_else() {
        // The step the client was missing: it sent `phase` with the action
        // alone, so the service used its own defaults and the organiser never
        // got a say. The config is read on `start_bracket` and there only.
        let plan = BracketConfig::Single {
            rounds: vec![3, 3, 5],
        };
        let drawn = phase_body(TourneyPhase::StartBracket, Some(&plan));
        assert_eq!(drawn["action"], "start_bracket");
        assert_eq!(drawn["config"]["rounds"], json!([3, 3, 5]));

        // Every other step ignores it rather than sending it somewhere it
        // would not be read.
        let formed = phase_body(TourneyPhase::FormTeams, Some(&plan));
        assert!(formed.get("config").is_none());

        // And a draw with nothing to say sends nothing, which is what lets the
        // service default the whole plan from the event.
        assert!(phase_body(TourneyPhase::StartBracket, None)
            .get("config")
            .is_none());
    }

    #[test]
    fn each_format_spells_its_plan_the_way_the_service_reads_it() {
        // Field names taken from the handler, not guessed: `bo` and `finalBo`
        // for swiss, `lbHandicap` for the grand final's head start.
        let double = phase_body(
            TourneyPhase::StartBracket,
            Some(&BracketConfig::Double {
                wb: vec![3, 3],
                lb: vec![3, 3],
                gf: 7,
                lb_handicap: false,
            }),
        );
        assert_eq!(double["config"]["wb"], json!([3, 3]));
        assert_eq!(double["config"]["lb"], json!([3, 3]));
        assert_eq!(double["config"]["gf"], 7);
        assert_eq!(double["config"]["lbHandicap"], false);

        let swiss = phase_body(
            TourneyPhase::StartBracket,
            Some(&BracketConfig::Swiss {
                rounds: 5,
                best_of: 1,
                final_match: false,
                final_best_of: 5,
                fast: true,
            }),
        );
        assert_eq!(swiss["config"]["rounds"], 5);
        assert_eq!(swiss["config"]["bo"], 1);
        assert_eq!(swiss["config"]["final"], false);
        assert_eq!(swiss["config"]["fast"], true);

        // A free-for-all is drawn from `ffaCfg` and takes an empty config.
        let ffa = phase_body(TourneyPhase::StartBracket, Some(&BracketConfig::FreeForAll));
        assert_eq!(ffa["config"], json!({}));
    }

    #[test]
    fn the_caster_role_is_read_and_written() {
        let event = parse_tourney(&json!({
            "id": "e1a2b",
            "casters": [{ "fafId": 102, "name": "Ada" }],
            "viewer": { "loggedIn": 1, "caster": 1 }
        }))
        .expect("an event");
        assert_eq!(event.casters.len(), 1);
        assert_eq!(event.casters[0].faf_id, 102);
        assert!(event.viewer.caster, "and this account is one of them");

        // A number here, unlike the organiser and mute lists: this endpoint is
        // newer and reads `fafId` directly rather than through a string key.
        assert_eq!(add_caster_body(102, "Ada")["fafId"], 102);
        assert_eq!(remove_caster_body(102)["fafId"], 102);
    }

    #[test]
    fn a_series_list_keeps_the_order_the_service_sorted_it_into() {
        // The sort key is "is any edition still being played", worked out from
        // every tournament in the database. The client holds only what it was
        // sent, so re-sorting here could only ever produce a different answer.
        let list = parse_series_list(&json!({
            "series": [
                {
                    "id": "s1", "name": "Weekend Ladder", "description": "<p>Monthly</p>",
                    "color": "amber", "category": "official",
                    "editions": 4, "activeCount": 1, "lastMs": 1_786_212_000_000i64,
                    "latestId": "e9", "latestName": "Autumn", "latestDate": "2026-08-01"
                },
                {
                    "id": "s2", "name": "Midweek Blitz", "description": "",
                    "color": null, "category": null,
                    "editions": 0, "activeCount": 0, "lastMs": 0
                }
            ]
        }));
        assert_eq!(
            list.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
            ["s1", "s2"]
        );

        let ladder = &list[0];
        assert_eq!(ladder.colour, SeriesColour::Amber);
        assert_eq!(ladder.category, Some(TourneyCategory::Official));
        assert_eq!(
            ladder.description, "Monthly",
            "markup is reduced on the way in"
        );
        // Milliseconds, unlike every other date on this endpoint: the service
        // builds this one with `getTime()`.
        assert_eq!(ladder.last_at, Some(1_786_212_000));
        assert_eq!(ladder.latest_date, Some(1_785_542_400));

        // An untagged series is untagged, not community: a tournament's
        // category defaults, a series' does not, and the two show differently.
        assert_eq!(list[1].category, None);
        assert_eq!(list[1].colour, SeriesColour::Plain);
        assert_eq!(list[1].last_at, None, "no activity is no date, not 1970");
    }

    #[test]
    fn a_series_detail_carries_its_editions_and_the_right_to_edit_it() {
        let detail = parse_series_detail(&json!({
            "series": {
                "id": "s1", "name": "Weekend Ladder", "description": "Monthly",
                "color": "blue", "category": "community"
            },
            "editions": [{
                "id": "e9", "name": "Autumn", "status": "finished", "category": "official",
                "published": 1, "competition": "team", "bracketType": "single", "teamSize": 2,
                "players": 8, "teams": 4, "eventDate": "2026-08-01T18:00:00Z",
                "abandoned": 0, "championTeamId": "t1", "champion": "Ada and Grace"
            }],
            "canEdit": 1
        }))
        .expect("a series");

        assert_eq!(detail.colour, SeriesColour::Blue);
        assert!(detail.can_edit);
        let edition = &detail.editions[0];
        assert_eq!(edition.status, TourneyStatus::Finished);
        assert_eq!(edition.player_count, 8);
        assert_eq!(edition.team_count, 4);
        assert_eq!(edition.champion, "Ada and Grace");
        // The edition's own category, which need not be the series'.
        assert_eq!(edition.category, Some(TourneyCategory::Official));

        // A 404 answers `{error}` and nothing to build a series out of.
        assert!(parse_series_detail(&json!({ "error": "Series not found" })).is_none());
    }

    #[test]
    fn a_qualifier_link_reads_its_rule_and_who_could_not_be_invited() {
        let event = parse_tourney(&json!({
            "id": "e1a2b",
            "seriesId": "s1",
            "seriesName": "Weekend Ladder",
            "seriesColor": "green",
            "qualifiers": [
                {
                    "id": "q1", "tournamentId": "child", "name": "Qualifier One",
                    "status": "finished",
                    "rule": { "type": "points", "n": 3 },
                    "applied": 1_786_300_000_000i64,
                    "qualified": ["Ada", "Grace"],
                    "unreachable": ["Guest"]
                },
                {
                    // Written before the rule field existed, and read the way
                    // the service reads it: top 1.
                    "id": "q2", "tournamentId": "gone", "name": "(deleted tournament)",
                    "status": null, "rule": null
                }
            ],
            "feedsInto": {
                "parentId": "final", "parentName": "Grand Final",
                "rule": { "type": "top", "n": 4 }, "applied": null
            }
        }))
        .expect("an event");

        assert_eq!(event.series_id.as_deref(), Some("s1"));
        assert_eq!(event.series_colour, SeriesColour::Green);

        let applied = &event.qualifiers[0];
        assert_eq!(applied.rule.kind, QualifierKind::Points);
        assert_eq!(applied.rule.n, 3);
        assert_eq!(applied.applied, Some(1_786_300_000));
        assert_eq!(applied.unreachable, ["Guest"]);

        let orphan = &event.qualifiers[1];
        assert_eq!(orphan.rule, QualifierRule::default());
        assert!(
            orphan.status.is_none(),
            "no status is a child that has been deleted, not a child at status zero"
        );

        let parent = event.feeds_into.expect("the parent");
        assert_eq!(parent.parent_name, "Grand Final");
        assert_eq!(parent.rule.n, 4);
        assert!(parent.applied.is_none(), "still being played");
    }

    #[test]
    fn filing_and_unfiling_are_told_apart_by_an_empty_id() {
        // The service reads a blank string as "unfile me" and an unknown one as
        // an error, so the two must not collapse into each other.
        assert_eq!(set_series_body(Some("s1"))["seriesId"], "s1");
        assert_eq!(set_series_body(None)["seriesId"], "");
    }

    #[test]
    fn saving_a_series_says_which_of_the_three_actions_it_is() {
        // One endpoint, three verbs, told apart by `action` alone.
        let created = series_body(&SeriesDraft {
            name: "  Weekend Ladder  ".into(),
            colour: SeriesColour::Red,
            ..SeriesDraft::default()
        });
        assert_eq!(created["action"], "create");
        assert_eq!(created["name"], "Weekend Ladder");
        assert_eq!(created["color"], "red");
        assert!(
            created.get("id").is_none(),
            "an id is what makes it an update"
        );
        assert_eq!(
            created["category"],
            Value::Null,
            "an untagged series sends null rather than leaving the key out, or the tag cannot be cleared"
        );

        let updated = series_body(&SeriesDraft {
            id: "s1".into(),
            name: "Weekend Ladder".into(),
            category: Some(TourneyCategory::Official),
            ..SeriesDraft::default()
        });
        assert_eq!(updated["action"], "update");
        assert_eq!(updated["id"], "s1");
        assert_eq!(updated["category"], "official");

        assert_eq!(delete_series_body("s1")["action"], "delete");
    }

    #[test]
    fn a_qualifier_body_clamps_the_cutoff_the_way_the_service_does() {
        let body = qualifier_add_body(
            "child",
            QualifierRule {
                kind: QualifierKind::Points,
                n: 0,
            },
        );
        assert_eq!(body["tournamentId"], "child");
        assert_eq!(body["ruleType"], "points");
        assert_eq!(body["n"], 1, "the service clamps to 1 and so does this");
        // Removal is addressed by the link, not by the child it points at.
        assert_eq!(qualifier_remove_body("q1")["id"], "q1");
    }
}
