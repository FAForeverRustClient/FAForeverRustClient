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
    AccessKind, AccessRequest, AccessStatus, AdminArticle, ArchivedTourney, ConsoleRole,
    HallOfFame, HallPlayer, HallTeam, ListedAccount, PendingItem, PendingSummary, SiteAdminData,
    SiteDocument, SiteLogEntry, SiteRead, SiteWrite, TourneyAccount,
};
use crate::state::{
    Article, AuditEntry, BracketConfig, BracketKind, BracketSide, Caster, ChatMute, ChatPost,
    ChatQuote, ChatRoom, Competition, Currency, FactionChoices, FactionResult, FactionStep,
    FactionVetoConfig, FactionVetoGame, Formation, HostingStatus, InviteStatus, MapPool, MapSpec,
    MatchFactionVeto, MatchLink, MatchPlan, MatchReport, MatchStatus, NewsPost, Organiser,
    PendingReport, PoolAction, PoolAssignment, PoolSide, PoolStep, Prize, RatingGate, RatingKind,
    RoundMaps, Seeding, SignupMode, Stream, SwissCuts, SwissTiebreak, TeamExit, TeamRequest,
    Tourney, TourneyCategory, TourneyDraft, TourneyFaction, TourneyInvite, TourneyMap,
    TourneyMatch, TourneyPhase, TourneyPlayer, TourneyStatus, TourneyTeam, TourneyViewer,
};
use crate::state::{BanScope, EntrantBoardRating, EntrantRatings, OwnBan, RatingCheck};
use crate::state::{CaptainMode, Replacement};
use crate::state::{CopySource, ImportedGroup, ImportedPlacing, ImportedRow, PickMode};
use crate::state::{
    Draft, DraftPick, FfaConfig, FfaMode, MatchVeto, TeamPoints, VetoChoice, VetoConfig,
    VetoDecider, VetoMode, VetoTeamA,
};
use crate::state::{EarlyFinish, Rename, RenameCheck, Survivors, TourneyAdmin, TourneyBan};
use crate::state::{
    FeedsInto, FormatDraft, Qualifier, QualifierKind, QualifierRule, SeriesColour, SeriesDetail,
    SeriesDraft, SeriesEdition, TourneySeries,
};
use crate::state::{PickLogEntry, PickMade, PickPhase, Playoffs, StageTwoPlan, TeamRecord};
use crate::state::{PickSettings, PlanLists, SwissExtras, TourneyPreset};

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

/// The headline cash prize, or `None` where the pair is not a whole one.
///
/// `cleanPrize` stores `{currency: null, amount: null}` for anything it refuses,
/// and the list endpoint sends the key as `null` outright, so three spellings of
/// "no prize" arrive here and all three have to mean the same thing. The amount
/// is read through `f64` because that is what JSON gives, then rounded to cents
/// the same way the service rounds it before storing.
fn prize(value: &Value, name: &str) -> Option<Prize> {
    let held = value.get(name)?;
    let currency = Currency::from_wire(held.get("currency")?.as_str()?)?;
    let amount = match held.get("amount")? {
        Value::Number(number) => number.as_f64()?,
        Value::String(text) => text.trim().parse().ok()?,
        _ => return None,
    };
    if !amount.is_finite() || amount < 0.0 {
        return None;
    }
    Some(Prize {
        currency,
        amount_cents: (amount * 100.0).round().clamp(0.0, i32::MAX as f64) as i32,
    })
}

/// The stream links, in the order the organiser listed them.
///
/// The scheme is checked again here, though the service checks it on the way in:
/// these end up in `openUrl`, and a state that can only hold `http(s)` is one
/// fewer place for a `javascript:` url to be waiting.
fn streams(value: &Value, name: &str) -> Vec<Stream> {
    array(value, name)
        .iter()
        .filter_map(|held| {
            let url = text(held, "url");
            let url = url.trim();
            if !(url.starts_with("https://") || url.starts_with("http://")) {
                return None;
            }
            Some(Stream {
                url: url.to_string(),
                info: text(held, "info"),
            })
        })
        .collect()
}

/// The best-of template, where the event stores one.
///
/// Which shape to read is decided by the bracket type rather than by which keys
/// are present: an event that was switched from double to single keeps the old
/// object until something writes over it, so the keys alone would answer with a
/// plan the bracket does not use.
fn plan(document: &Value, kind: BracketKind, competition: Competition) -> Option<MatchPlan> {
    if competition == Competition::FreeForAll {
        return None;
    }
    let held = document.get("plan").filter(|value| value.is_object())?;
    let best_of = |name: &str, fallback: i32| int(held, name).unwrap_or(fallback);
    Some(match kind {
        BracketKind::Single => MatchPlan::Single {
            early: best_of("early", 3),
            semi: best_of("semi", 3),
            final_bo: best_of("final", 5),
            third_place: flag(held, "thirdPlace"),
        },
        BracketKind::Double => MatchPlan::Double {
            wb: best_of("wb", 3),
            wb_final: best_of("wbFinal", 3),
            lb: best_of("lb", 3),
            lb_final: best_of("lbFinal", 3),
            gf: best_of("gf", 5),
            lb_handicap: flag(held, "lbHandicap"),
        },
        // Swiss keeps its round count in `ffaCfg`-free territory: the number of
        // rounds is the organiser's, but it lives on the draw config rather
        // than in the plan, which holds only the lengths.
        BracketKind::Swiss => MatchPlan::Swiss {
            best_of: if best_of("bo", 3) == 1 { 1 } else { 3 },
            final_match: flag(held, "final"),
            final_best_of: best_of("finalBo", 5),
            fast: flag(held, "fast"),
        },
    })
}

/// The record cuts in the stored plan.
///
/// Read from `plan` rather than `cfg`, because the plan is what the next
/// `start_bracket` uses (`cleanSwissExtras(c, t.plan)`) when the start body
/// does not name them, and this client's never does. Out of the server's own
/// 0 to 15 range counts as off, as `cleanSwissExtras` treats it.
fn swiss_cuts(document: &Value) -> SwissCuts {
    let Some(held) = document.get("plan").filter(|value| value.is_object()) else {
        return SwissCuts::default();
    };
    let cut = |name: &str| {
        int(held, name)
            .filter(|value| (0..=15).contains(value))
            .unwrap_or(0)
    };
    SwissCuts {
        wins: cut("winCut"),
        losses: cut("lossCut"),
    }
}

/// A Swiss stage's planned playoffs (`plan.stage2` and `s2*`), where on.
fn stage_two_plan(document: &Value) -> Option<StageTwoPlan> {
    let held = document.get("plan").filter(|value| value.is_object())?;
    if !flag(held, "stage2") {
        return None;
    }
    Some(StageTwoPlan {
        double: text(held, "s2Type") == "double",
        cut_to: int(held, "s2CutTo").unwrap_or(8),
        best_of: int(held, "s2Bo").unwrap_or(3),
        final_best_of: int(held, "s2Final").unwrap_or(5),
        grand_final: int(held, "s2Gf").unwrap_or(5),
        handicap: flag(held, "s2Hcap"),
        third_place: flag(held, "s2Third"),
    })
}

/// The per-round best-of lists in the plan. `set_plan_round_bo` writes one
/// index at a time, so a list can have holes, which arrive as `null`.
fn plan_lists(document: &Value) -> PlanLists {
    let Some(held) = document.get("plan").filter(|value| value.is_object()) else {
        return PlanLists::default();
    };
    let list = |name: &str| -> Vec<Option<i32>> {
        array(held, name)
            .iter()
            .map(|item| {
                item.as_i64()
                    .and_then(|bo| i32::try_from(bo).ok())
                    .filter(|bo| [1, 3, 5, 7].contains(bo))
            })
            .collect()
    };
    PlanLists {
        rounds: list("roundsList"),
        winners: list("wbList"),
        losers: list("lbList"),
    }
}

/// A Swiss stage's deciding match length (`plan.decidingBo`); 0 is the
/// normal length, and anything the service would not keep counts as that.
fn deciding_best_of(document: &Value) -> i32 {
    document
        .get("plan")
        .and_then(|held| int(held, "decidingBo"))
        .filter(|bo| [1, 3, 5, 7].contains(bo))
        .unwrap_or(0)
}

/// Two team ids, from a `[a, b]` pair.
fn id_pair(value: &Value) -> Option<(String, String)> {
    let pair = value.as_array()?;
    let side = |at: usize| match pair.get(at)? {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    };
    Some((side(0)?, side(1)?))
}

/// A running Swiss stage's playoffs (`playoffs`, with `stage2`).
fn parse_playoffs(held: &Value, stage: Option<&Value>) -> Playoffs {
    let pick = text(held, "pick");
    Playoffs {
        pick: match pick.as_str() {
            "" | "off" => None,
            other => Some(PickMode::from_wire(other)),
        },
        made: flag(held, "made"),
        built: flag(held, "built"),
        locked: flag(held, "locked"),
        swiss_done: flag(held, "swissDone"),
        redraws: int(held, "redraws").unwrap_or(0),
        double: stage.is_some_and(|stage| text(stage, "type") == "double"),
        cut_to: stage.and_then(|stage| int(stage, "cutTo")).unwrap_or(0),
        field: stage.map_or_else(Vec::new, |stage| string_list(stage, "field")),
        third_place: stage.is_some_and(|stage| flag(stage, "thirdPlace")),
    }
}

/// A pick phase (`picks`), for the main bracket or the playoffs.
fn parse_picks(held: &Value) -> PickPhase {
    let seconds = |name: &str| {
        held.get(name)
            .and_then(Value::as_i64)
            .map(|millis| i32::try_from((millis.max(0) + 999) / 1000).unwrap_or(i32::MAX))
    };
    PickPhase {
        open: text(held, "status") == "open",
        half: int(held, "half").unwrap_or(0),
        field: string_list(held, "field"),
        order: string_list(held, "order"),
        picks: held
            .get("picks")
            .and_then(Value::as_object)
            .map(|made| {
                made.iter()
                    .filter_map(|(picker, target)| {
                        Some(PickMade {
                            picker: picker.clone(),
                            target: target.as_str()?.to_string(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default(),
        available: string_list(held, "available"),
        turn: id(held, "turn"),
        my_turn: flag(held, "myTurn"),
        seconds_left: seconds("msLeft"),
        seconds_per_pick: seconds("perPickMs"),
        log: array(held, "log")
            .iter()
            .map(|entry| PickLogEntry {
                by: text(entry, "by"),
                by_name: text(entry, "byName"),
                target: text(entry, "target"),
                at: moment(entry, "at"),
                auto: flag(entry, "auto"),
            })
            .collect(),
        stage_two: text(held, "forWhat") == "stage2",
        unbeaten: text(held, "mode") == "unbeaten",
        rest_seeded: text(held, "rest") == "seed",
        pool: string_list(held, "pool"),
        pool_bottom: text(held, "poolRule") == "bottom",
        records: held
            .get("records")
            .and_then(Value::as_object)
            .map(|records| {
                records
                    .iter()
                    .map(|(team_id, record)| TeamRecord {
                        team_id: team_id.clone(),
                        record: record.as_str().unwrap_or_default().to_string(),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        drawn: array(held, "drawn").iter().filter_map(id_pair).collect(),
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

/// A scheduled publish time (`publishAt`), as Unix seconds.
///
/// The service stores it through `cleanDate`, so it arrives as an ISO instant
/// or a bare date, never as the milliseconds the other moments are; read as
/// milliseconds, every schedule parsed as none. Both are accepted, so an older
/// document that did carry a number still reads.
fn publish_moment(value: &Value, name: &str) -> Option<u32> {
    moment(value, name).or_else(|| calendar_moment(value, name))
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
        // Markdown source, not plain text. See `Tourney::description` for why
        // that reversal is safe: the service deletes every angle bracket, and
        // the renderer emits elements rather than markup.
        description: text(document, "description"),
        rewards: text(document, "rewards"),
        sponsors: text(document, "sponsors"),
        prize: prize(document, "prize"),
        streams: streams(document, "streams"),
        lobby_options: text(document, "lobbyOptions"),
        mods: text(document, "mods"),
        desc_images: string_list(document, "descImages"),
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
        min_teams: int(document, "minTeams").unwrap_or(0).max(0),
        seeding: Seeding::from_wire(&text(document, "seeding")),
        plan: plan(
            document,
            BracketKind::from_wire(&text(document, "bracketType")),
            Competition::from_wire(&text(document, "competition")),
        ),
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
            team_a: VetoTeamA::from_wire(&text(
                document.get("veto").unwrap_or(&Value::Null),
                "abMode",
            )),
            reveal_bans: flag(document.get("veto").unwrap_or(&Value::Null), "revealBans"),
        },
        faction_veto: document
            .get("fveto")
            .filter(|held| held.is_object())
            .map(|held| FactionVetoConfig {
                enabled: flag(held, "enabled"),
                bans: int(held, "bans").unwrap_or(1),
                picks: int(held, "picks").unwrap_or(2),
            })
            .unwrap_or_default(),
        published: document
            .get("published")
            .is_none_or(|value| flag(document, "published") || value.is_null()),
        publish_at: publish_moment(document, "publishAt"),
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
        subs: string_list(document, "subs"),
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
        round_maps: parse_round_maps(document.get("maps")),
        organisers: array(document, "organizersPublic")
            .iter()
            .map(|entry| text(entry, "name"))
            .filter(|name| !name.is_empty())
            .collect(),
        organiser_discords: array(document, "organizersPublic")
            .iter()
            .map(|entry| text(entry, "discord").trim().to_string())
            .filter(|handle| !handle.is_empty())
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
        swiss_order: string_list(document, "swissOrder"),
        swiss_tiebreak: SwissTiebreak::from_wire(&text(document, "tiebreak")),
        swiss_cuts: swiss_cuts(document),
        swiss_rounds: ["cfg", "plan"]
            .iter()
            .filter_map(|key| document.get(*key).filter(|value| value.is_object()))
            .find_map(|held| int(held, "rounds").filter(|rounds| *rounds > 0))
            .unwrap_or(0),
        swiss_beaten: parse_beaten(document.get("swissSB")),
        bans: array(document, "bans")
            .iter()
            .filter_map(parse_ban)
            .collect(),
        stop_at_alive: int(document, "stopAtAlive").unwrap_or(0),
        survivors: document
            .get("survivors")
            .filter(|held| held.is_object())
            .map(|held| Survivors {
                winners: string_list(held, "wb"),
                losers: string_list(held, "lb"),
            }),
        event_days: string_list(document, "eventDays"),
        early_finish: document
            .get("earlyFinish")
            .filter(|held| held.is_object())
            .map(|held| EarlyFinish {
                at: moment(held, "at"),
                by: text(held, "by"),
                automatic: flag(held, "auto"),
                target: int(held, "target").unwrap_or(0),
                alive: int(held, "alive").unwrap_or(0),
                names: string_list(held, "names"),
                unplayed: held.get("unplayed").and_then(Value::as_array).map(|items| {
                    items
                        .iter()
                        .filter_map(|item| match item {
                            Value::String(text) => Some(text.clone()),
                            Value::Number(number) => Some(number.to_string()),
                            _ => None,
                        })
                        .collect()
                }),
            }),
        per_round_bo: flag(document, "perRoundBo"),
        // Read beside `formation`, which folds it into open teams: the one
        // thing premade changes is that players name their team at signup.
        premade_teams: text(document, "formation") == "premade",
        plan_lists: plan_lists(document),
        entry_order: entry_order(document),
        captain_mode: CaptainMode::from_wire(&text(document, "captainMode")),
        captain_count: int(document, "captainCount").unwrap_or(0),
        can_manage: flag_or_true(document, "canManage"),
        my_mention_count: int(document, "myMentionCount").unwrap_or(0).max(0),
        chat_ping_count: int(document, "chatPingCount").unwrap_or(0).max(0),
        my_unread_count: int(document, "myUnreadCount").unwrap_or(0).max(0),
        source_url: text(document, "sourceUrl"),
        imported_type: text(document, "importedType"),
        standings_only: flag(document, "standingsOnly"),
        pick_opponents: flag(document, "pickOpponents"),
        pick_minutes: int(document, "pickMinutes").unwrap_or(0).clamp(0, 1440),
        pick_mode: PickMode::from_wire(&text(document, "pickMode")),
        deciding_best_of: deciding_best_of(document),
        stage_two_plan: stage_two_plan(document),
        playoffs: document
            .get("playoffs")
            .filter(|held| held.is_object())
            .map(|held| {
                parse_playoffs(
                    held,
                    document.get("stage2").filter(|stage| stage.is_object()),
                )
            }),
        picks: document
            .get("picks")
            .filter(|held| held.is_object())
            .map(parse_picks),
        planned_round_one: array(document, "plannedR1")
            .iter()
            .filter_map(id_pair)
            .collect(),
        round_one_open: flag(document, "swissR1Open"),
        imported_groups: array(document, "importedGroups")
            .iter()
            .map(|group| ImportedGroup {
                name: text(group, "name"),
                played: int(group, "played").unwrap_or(0),
                rows: array(group, "rows")
                    .iter()
                    .map(|row| ImportedRow {
                        name: text(row, "name"),
                        wins: int(row, "w").unwrap_or(0),
                        losses: int(row, "l").unwrap_or(0),
                        games_won: int(row, "gw").unwrap_or(0),
                        games_lost: int(row, "gl").unwrap_or(0),
                    })
                    .collect(),
            })
            .collect(),
        imported_standings: array(document, "importedStandings")
            .iter()
            .filter_map(|row| {
                Some(ImportedPlacing {
                    rank: int(row, "rank")?,
                    name: text(row, "name"),
                })
            })
            .collect(),
        my_ban: document
            .get("myBan")
            .filter(|held| held.is_object())
            .map(|held| OwnBan {
                scope: BanScope::from_wire(&text(held, "scope")),
                reason: text(held, "reason"),
                expires: calendar_moment(held, "expires"),
            }),
        viewer: parse_viewer(document),
    })
}

/// Team ids in the order they entered, from each team's `entryKey`.
///
/// The key is a millisecond timestamp, or the one an organiser's swap handed
/// over, and it can tie: the service then keeps the list's own order, and so
/// does this. Read as an order rather than as numbers, because the numbers
/// mean nothing on their own.
fn entry_order(document: &Value) -> Vec<String> {
    let mut keyed: Vec<(f64, usize, String)> = array(document, "teams")
        .iter()
        .enumerate()
        .filter_map(|(index, team)| {
            let key = team
                .get("entryKey")
                .or_else(|| team.get("createdAt"))
                .and_then(Value::as_f64)
                .unwrap_or(f64::MAX);
            Some((key, index, id(team, "id")?))
        })
        .collect();
    keyed.sort_by(|left, right| left.0.total_cmp(&right.0).then(left.1.cmp(&right.1)));
    keyed.into_iter().map(|(_, _, team_id)| team_id).collect()
}

/// The answer to `POST /api/t/{id}/check_rating`.
pub fn parse_rating_check(document: &Value) -> RatingCheck {
    RatingCheck {
        rated: flag(document, "rated"),
        rating: int(document, "rating"),
        capped: int(document, "capped"),
        rating_kind: RatingKind::from_wire(&text(document, "ratingType")),
        // Milliseconds, like the event's own `ratingDate` it echoes.
        as_of: moment(document, "asOf"),
        min: int(document, "min"),
        max: int(document, "max"),
        exempt: flag(document, "exempt"),
        already_in: flag(document, "alreadyIn"),
        banned: document
            .get("banned")
            .and_then(Value::as_str)
            .filter(|text| !text.trim().is_empty())
            .map(str::to_string),
        eligible: document.get("eligible").and_then(Value::as_bool),
        message: text(document, "message"),
    }
}

/// The answer to `GET /api/t/{id}/player_ratings`.
///
/// The five boards come keyed by the service's own names under
/// `allRatings.boards`, and are listed here in the website's order.
pub fn parse_player_ratings(document: &Value) -> EntrantRatings {
    let boards = document
        .get("allRatings")
        .and_then(|all| all.get("boards"))
        .filter(|boards| boards.is_object());
    EntrantRatings {
        player_id: id(document, "playerId").unwrap_or_default(),
        name: text(document, "name"),
        counts: RatingKind::from_wire(&text(document, "counts")),
        counts_rating: int(document, "countsRating"),
        capped: int(document, "capped"),
        rating_date: moment(document, "ratingDate"),
        boards: boards.map_or_else(Vec::new, |boards| {
            ["global", "1v1", "2v2", "3v3", "4v4"]
                .iter()
                .map(|key| {
                    let row = boards.get(*key).unwrap_or(&Value::Null);
                    EntrantBoardRating {
                        board: RatingKind::from_wire(key),
                        rating: int(row, "rating"),
                        games: int(row, "games"),
                    }
                })
                .collect()
        }),
        reason: text(document, "reason"),
    }
}

/// The body for `POST /api/t/{id}/signup`.
///
/// Empty but for the rating an unrated event needs: with FAF login on, the
/// service takes the entrant's name and account from the session and refuses
/// anything the caller claims.
pub fn signup_body(rating: Option<i32>) -> Value {
    match rating {
        Some(rating) => json!({ "rating": rating }),
        None => json!({}),
    }
}

/// The path an uploaded event picture is served at (`add_desc_image`):
/// `url`, else built from `file`.
pub fn parse_uploaded_image(document: &Value) -> String {
    let url = text(document, "url");
    if !url.is_empty() {
        return url;
    }
    let file = text(document, "file");
    if file.is_empty() {
        String::new()
    } else {
        format!("/desc-images/{file}")
    }
}

/// The named formats, from `GET /api/presets`.
///
/// A preset's `apply` is shaped like a tournament document, so it is read as
/// one; its opponent picking is `pickPhase` there, which a document calls
/// `pickOpponents`.
pub fn parse_presets(document: &Value) -> Vec<TourneyPreset> {
    array(document, "presets")
        .iter()
        .filter_map(|value| {
            let id = id(value, "id")?;
            let apply = value
                .get("apply")
                .filter(|held| held.is_object())
                .and_then(|held| {
                    let mut shaped = held.clone();
                    shaped["id"] = json!(format!("preset:{id}"));
                    if shaped.get("pickOpponents").is_none() {
                        shaped["pickOpponents"] = json!(flag(held, "pickPhase"));
                    }
                    parse_tourney(&shaped).map(Box::new)
                });
            Some(TourneyPreset {
                name: text(value, "name"),
                blurb: text(value, "blurb"),
                notes: string_list(value, "notes"),
                allowed: flag(value, "allowed") && apply.is_some(),
                apply,
                id,
            })
        })
        .collect()
}

/// The events this account organises, from `GET /api/my_tournaments`.
pub fn parse_copy_sources(document: &Value) -> Vec<CopySource> {
    let items = match document {
        Value::Array(items) => items.as_slice(),
        _ => array(document, "tournaments"),
    };
    items
        .iter()
        .filter_map(|value| {
            Some(CopySource {
                id: id(value, "id")?,
                name: text(value, "name"),
                map_count: int(value, "mapCount").unwrap_or(0).max(0),
                pool_count: int(value, "poolCount").unwrap_or(0).max(0),
                may_copy: flag(value, "canCopyMaps"),
            })
        })
        .collect()
}

/// The answer to `POST /api/t/{id}/check_renames`.
pub fn parse_rename_check(document: &Value) -> RenameCheck {
    RenameCheck {
        checked: int(document, "checked").unwrap_or(0),
        changed: array(document, "changed")
            .iter()
            .filter_map(|held| {
                Some(Rename {
                    player_id: id(held, "playerId")?,
                    from: text(held, "from"),
                    to: text(held, "to"),
                    team: held
                        .get("team")
                        .and_then(Value::as_str)
                        .filter(|name| !name.trim().is_empty())
                        .map(str::to_string),
                })
            })
            .collect(),
        failed: int(document, "failed").unwrap_or(0),
        manual: int(document, "manual").unwrap_or(0),
    }
}

/// One of the event's own bans. The id arrives as a string key, as every FAF
/// id does in the service's stores.
fn parse_ban(value: &Value) -> Option<TourneyBan> {
    Some(TourneyBan {
        faf_id: int(value, "fafId")?,
        name: text(value, "name"),
        reason: text(value, "reason"),
        // An ISO instant, unlike `at`, which is milliseconds.
        expires: calendar_moment(value, "expires"),
        at: moment(value, "at"),
        by: text(value, "by"),
        expired: flag(value, "expired"),
    })
}

/// The `beaten` tiebreak's number per team, from `swissSB`: an object keyed by
/// team id, or `null` when the event breaks ties by game difference.
fn parse_beaten(value: Option<&Value>) -> std::collections::BTreeMap<String, i32> {
    value
        .and_then(Value::as_object)
        .map(|held| {
            held.iter()
                .filter_map(|(team_id, sum)| {
                    let sum = sum.as_i64().and_then(|n| i32::try_from(n).ok())?;
                    Some((team_id.clone(), sum))
                })
                .collect()
        })
        .unwrap_or_default()
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
        invited: flag(viewer, "invited"),
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
        discord: text(value, "discord").trim().to_string(),
        team_name: text(value, "teamName").trim().to_string(),
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

/// A match's faction veto, as the viewer's slice of it (`factionViewFor`).
///
/// `games` is an object keyed by the game number as text, read into a list in
/// game order. A faction the client does not know is dropped rather than
/// guessed at.
fn parse_faction_veto(value: Option<&Value>) -> Option<MatchFactionVeto> {
    let value = value.filter(|held| held.is_object())?;
    let factions = |held: &Value, name: &str| -> Vec<TourneyFaction> {
        string_list(held, name)
            .iter()
            .filter_map(|raw| TourneyFaction::from_wire(raw))
            .collect()
    };
    let mut games: Vec<FactionVetoGame> = value
        .get("games")
        .and_then(Value::as_object)
        .map(|games| {
            games
                .iter()
                .filter_map(|(number, game)| {
                    let game_number: i32 = number.trim().parse().ok()?;
                    let result =
                        game.get("result")
                            .filter(|held| held.is_object())
                            .and_then(|held| {
                                Some(FactionResult {
                                    team1: TourneyFaction::from_wire(&text(held, "t1"))?,
                                    team2: TourneyFaction::from_wire(&text(held, "t2"))?,
                                })
                            });
                    Some(FactionVetoGame {
                        game: game_number,
                        team1_done: flag(game, "t1Done"),
                        team2_done: flag(game, "t2Done"),
                        result,
                        mine: game
                            .get("mine")
                            .filter(|held| held.is_object())
                            .map(|mine| FactionChoices {
                                bans: factions(mine, "bans"),
                                picks: factions(mine, "picks"),
                                done: flag(mine, "done"),
                            }),
                        next: game
                            .get("next")
                            .filter(|held| held.is_object())
                            .map(|next| FactionStep {
                                action: PoolAction::from_wire(&text(next, "action")),
                                index: int(next, "index").unwrap_or(1),
                                of: int(next, "of").unwrap_or(1),
                            }),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    games.sort_by_key(|game| game.game);
    Some(MatchFactionVeto {
        bans: int(value, "bans").unwrap_or(1),
        picks: int(value, "picks").unwrap_or(2),
        games,
    })
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
        faction_veto: parse_faction_veto(value.get("fveto")),
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
        draw_replay_ids: string_list(value, "drawReplayIds"),
        forfeit: id(value, "forfeit"),
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
        draw_replay_ids: string_list(pending, "drawReplayIds"),
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
        spec: parse_map_spec(value.get("spec")),
        secret: flag(value, "secret"),
        masked: flag(value, "masked"),
    })
}

/// A map's spawn information, `None` when the service sent none.
///
/// The wire names are the website's (`t1`, `t2`, `closed`, `closedMex`). A
/// spec with nothing in it is `None` too, which is how the service stores it.
fn parse_map_spec(value: Option<&Value>) -> Option<MapSpec> {
    let value = value.filter(|held| held.is_object())?;
    let spawns = |name: &str| -> Vec<i32> {
        array(value, name)
            .iter()
            .filter_map(|entry| match entry {
                Value::Number(number) => number.as_i64().and_then(|n| i32::try_from(n).ok()),
                Value::String(text) => text.trim().parse().ok(),
                _ => None,
            })
            .collect()
    };
    let spec = MapSpec {
        team1_spawns: spawns("t1"),
        team2_spawns: spawns("t2"),
        closed_spawns: spawns("closed"),
        closed_mex_spawns: spawns("closedMex"),
        size: text(value, "size"),
    };
    (spec != MapSpec::default()).then_some(spec)
}

/// A map's spawn information as `map_save` takes it: the same shape it came
/// in, or `null` for none, which the service stores as none.
pub fn map_spec_body(spec: Option<&MapSpec>) -> Value {
    let Some(spec) = spec else {
        return Value::Null;
    };
    json!({
        "t1": spec.team1_spawns,
        "t2": spec.team2_spawns,
        "closed": spec.closed_spawns,
        "closedMex": spec.closed_mex_spawns,
        "size": spec.size,
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
        publish_at: publish_moment(value, "publishAt"),
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

/// `maps`, the rounds an organiser pinned maps to directly: an object keyed by
/// round, each a list of map ids. Flattened like `poolAssign`.
fn parse_round_maps(value: Option<&Value>) -> Vec<RoundMaps> {
    let Some(Value::Object(entries)) = value else {
        return Vec::new();
    };
    entries
        .iter()
        .filter_map(|(round, maps)| {
            let map_ids: Vec<String> = maps
                .as_array()?
                .iter()
                .filter_map(|held| match held {
                    Value::String(text) if !text.trim().is_empty() => Some(text.trim().to_string()),
                    Value::Number(number) => Some(number.to_string()),
                    _ => None,
                })
                .collect();
            (!map_ids.is_empty()).then(|| RoundMaps {
                round: round.clone(),
                map_ids,
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
                reply_to: post
                    .get("replyTo")
                    .filter(|held| held.is_object())
                    .and_then(|quote| {
                        Some(ChatQuote {
                            id: id(quote, "id")?,
                            author: text(quote, "who"),
                            body: to_plain_text(&text(quote, "text")),
                        })
                    }),
                everyone: flag(post, "everyone"),
            })
        })
        .collect()
}

/// The body for `POST /api/t/{id}/chat_post`.
///
/// `replyTo` only when answering: the service looks the id up in the same room
/// and stores a snapshot of it, so an absent key is an ordinary post.
pub fn chat_post_body(room_id: &str, body: &str, reply_to: Option<&str>) -> Value {
    let mut out = json!({ "room": room_id, "text": body });
    if let Some(reply_to) = reply_to.filter(|id| !id.trim().is_empty()) {
        out["replyTo"] = json!(reply_to.trim());
    }
    out
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

/// The Discord handle out of `GET /auth/faf/me`.
///
/// Nested under `user`, which is `null` for a caller with no session. Empty
/// means "not given", which is also what clearing it stores, so the two are the
/// same state and the UI does not need to tell them apart.
pub fn parse_profile(document: &Value) -> String {
    document
        .get("user")
        .filter(|held| held.is_object())
        .map(|held| text(held, "discord"))
        .unwrap_or_default()
}

/// The handle `POST /api/my/profile` says it stored.
pub fn parse_discord(document: &Value) -> String {
    text(document, "discord")
}

/// The body for `POST /api/tournaments`.
///
/// The whole of what the endpoint accepts for a team event now, minus the
/// free-for-all block. Everything here is read back off the event, which is the
/// rule this file lives by: a key the client cannot see is a key it overwrites
/// with a guess.
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
        "minTeams": draft.min_teams,
        "veto": veto_body(&draft.veto),
    });
    // Only for a captains draft. The service stores `draftOrder` whatever the
    // formation, and sending it from a form that never showed the choice would
    // write a guess into an event that has no draft to order.
    if draft.effective_formation() == Formation::Draft {
        body["draftOrder"] = json!(if draft.draft_snakes {
            "snake"
        } else {
            "linear"
        });
    }
    // Unknown ids are ignored server-side, but an absent key is cleaner than a
    // blank one: the field is optional and most events are not in a series.
    if let Some(series) = draft.series_id.as_ref().filter(|id| !id.trim().is_empty()) {
        body["seriesId"] = json!(series.trim());
    }
    if let Some(plan) = draft.plan {
        body["plan"] = plan_body(plan);
        if matches!(plan, MatchPlan::Swiss { .. }) {
            merge_swiss_extras(&mut body["plan"], &draft.swiss);
        }
    }
    if let Some(preset) = draft.preset_id.as_ref().filter(|id| !id.trim().is_empty()) {
        body["presetId"] = json!(preset.trim());
    }
    merge_picks(&mut body, &draft.picks, draft.tiebreak, draft.bracket_kind);
    body["stopAtAlive"] = json!(draft.stop_at_alive.clamp(0, 128));
    if draft.competition == Competition::FreeForAll {
        if let Some(ffa) = &draft.ffa {
            merge_ffa(&mut body, ffa);
        }
    }
    merge_shared(&mut body, draft);
    body
}

/// A Swiss stage's extras, into its `plan`: the cuts (0 when off, which the
/// service reads as off), the deciding length, and the playoffs with their
/// `s2*` keys only when they are on, as the website sends them.
fn merge_swiss_extras(plan: &mut Value, extras: &SwissExtras) {
    let cut = |value: i32| value.clamp(0, 15);
    plan["winCut"] = json!(cut(extras.cuts.wins));
    plan["lossCut"] = json!(cut(extras.cuts.losses));
    plan["decidingBo"] = json!(if [1, 3, 5, 7].contains(&extras.deciding_best_of) {
        extras.deciding_best_of
    } else {
        0
    });
    match &extras.stage_two {
        Some(stage) => {
            plan["stage2"] = json!(1);
            plan["s2CutTo"] = json!(stage.cut_to.clamp(2, 64));
            plan["s2Type"] = json!(if stage.double { "double" } else { "single" });
            plan["s2Bo"] = json!(stage.best_of);
            plan["s2Final"] = json!(stage.final_best_of);
            // The website sends the grand final as the final's length.
            plan["s2Gf"] = json!(stage.final_best_of);
            plan["s2Third"] = json!(u8::from(stage.third_place && !stage.double));
        }
        None => plan["stage2"] = json!(0),
    }
}

/// Who picks their opponent, and the tiebreak, which only a Swiss sends:
/// anything else gets `gd`, as on the website.
fn merge_picks(body: &mut Value, picks: &PickSettings, tiebreak: SwissTiebreak, kind: BracketKind) {
    body["pickOpponents"] = json!(u8::from(picks.on));
    body["pickMinutes"] = json!(if picks.on {
        picks.minutes.clamp(0, 1440)
    } else {
        0
    });
    body["pickMode"] = json!(picks.mode.as_wire());
    body["tiebreak"] = json!(if kind == BracketKind::Swiss {
        tiebreak.as_wire()
    } else {
        "gd"
    });
}

/// A free-for-all's configuration, as its six keys.
fn merge_ffa(body: &mut Value, ffa: &FfaConfig) {
    body["perMatch"] = json!(ffa.per_match);
    body["mode"] = json!(ffa.mode.as_wire());
    body["advance"] = json!(if ffa.mode == FfaMode::Elimination {
        ffa.advance
    } else {
        1
    });
    body["rounds"] = json!(ffa.rounds);
    body["cutTo"] = json!(ffa.cut_to);
    body["finalSize"] = json!(ffa.final_size);
}

/// The best-of template, in the shape the service stores for this bracket type.
fn plan_body(plan: MatchPlan) -> Value {
    match plan {
        MatchPlan::Single {
            early,
            semi,
            final_bo,
            third_place,
        } => json!({
            "early": early,
            "semi": semi,
            "final": final_bo,
            "thirdPlace": third_place,
        }),
        MatchPlan::Double {
            wb,
            wb_final,
            lb,
            lb_final,
            gf,
            lb_handicap,
        } => json!({
            "wb": wb,
            "wbFinal": wb_final,
            "lb": lb,
            "lbFinal": lb_final,
            "gf": gf,
            "lbHandicap": lb_handicap,
        }),
        MatchPlan::Swiss {
            best_of,
            final_match,
            final_best_of,
            fast,
        } => json!({
            "bo": best_of,
            "final": final_match,
            "finalBo": final_best_of,
            "fast": fast,
        }),
    }
}

/// The veto settings, all four keys: `cleanVeto` resets any it is not sent.
fn veto_body(veto: &VetoConfig) -> Value {
    json!({
        "enabled": veto.enabled,
        "mode": veto.mode.as_wire(),
        "abMode": veto.team_a.as_wire(),
        "revealBans": veto.reveal_bans,
    })
}

/// The body for `POST /api/t/{id}/edit_info`.
///
/// A narrower set than creation: the format, the team size and the category are
/// welded to a bracket that may already have been drawn, and the server keeps
/// separate endpoints for changing those.
///
/// The veto is not in it: see [`TourneyAdmin::SetVeto`].
pub fn edit_info_body(draft: &TourneyDraft) -> Value {
    let mut body = json!({
        "name": draft.name.trim(),
        "signupMode": draft.signup_mode.as_wire(),
        // Which board counts. The form always showed it and this body never
        // sent it, so changing it here did nothing at all. The service does
        // not re-pull anyone on a change; `repull_ratings` does that.
        "ratingType": draft.rating_kind.as_wire(),
    });
    merge_shared(&mut body, draft);
    body
}

/// The fields creation and editing spell the same way.
fn merge_shared(body: &mut Value, draft: &TourneyDraft) {
    body["description"] = json!(draft.description.trim());
    body["rewards"] = json!(draft.rewards.trim());
    body["sponsors"] = json!(draft.sponsors.trim());
    body["lobbyOptions"] = json!(draft.lobby_options.trim());
    body["mods"] = json!(draft.mods.trim());
    // Two keys for one value, and both are always sent: `cleanPrize` needs the
    // pair to agree, and sending only the amount would take the currency from
    // whatever is stored, which for a prize being cleared is the old one.
    body["prizeCurrency"] = draft
        .prize
        .map_or(Value::Null, |prize| json!(prize.currency.as_wire()));
    body["prizeAmount"] = draft.prize.map_or(Value::Null, |prize| {
        // Whole units on the wire, which is what the form collects and what
        // `cleanPrize` rounds back to cents anyway.
        if prize.amount_cents % 100 == 0 {
            json!(prize.amount_cents / 100)
        } else {
            json!(prize.amount_cents as f64 / 100.0)
        }
    });
    body["streams"] = json!(draft
        .streams
        .iter()
        .filter(|stream| !stream.url.trim().is_empty())
        .map(|stream| json!({ "url": stream.url.trim(), "info": stream.info.trim() }))
        .collect::<Vec<_>>());
    // Always sent, and always the draft's own value, which for an edit is the
    // event's. The service reads an absent key as on. This used to send `false`
    // from both paths, so saving the settings of an event created on the
    // website took player reporting away from it without a word.
    body["playerReporting"] = json!(draft.player_reporting);
    // `null` is meaningful rather than omitted: the server tells a cleared date
    // from an untouched one by whether the key is there at all.
    body["eventDate"] = iso(draft.event_date);
    body["signupOpensAt"] = iso(draft.signup_opens_at);
    body["signupClosesAt"] = iso(draft.signup_closes_at);
    // Milliseconds on the way out as well as in: the service stores this one as
    // `new Date(x).getTime()`, unlike the three above, which it keeps as text.
    // An ISO instant parses to the right number either way.
    body["ratingDate"] = iso(draft.rating_date);
    // `null` clears it, which is how an event goes back to no check-in.
    body["checkInDeadline"] = iso(draft.check_in_deadline);
    // An empty list clears the schedule back to the event date alone.
    body["eventDays"] = json!(draft
        .event_days
        .iter()
        .map(|day| day.trim())
        .filter(|day| !day.is_empty())
        .collect::<Vec<_>>());
    body["minRating"] = gate(draft.rating.min);
    body["maxRating"] = gate(draft.rating.max);
    body["maxTeamRating"] = gate(draft.rating.max_team);
    body["ratingCap"] = gate(draft.rating.cap);
}

/// A rating bound, or `null` to clear it.
fn gate(value: Option<i32>) -> Value {
    value.map_or(Value::Null, |bound| json!(bound))
}

/// A moment as the RFC 3339 string the service's `cleanDate` reads, or `null`.
pub fn iso_moment(seconds: Option<u32>) -> Value {
    iso(seconds)
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
        // Only to those who may edit it: the service leaves the key out for
        // everyone else.
        bans: array(document, "bans")
            .iter()
            .filter_map(parse_ban)
            .collect(),
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
        can_manage: flag_or_true(value, "canManage"),
        signup_opens_at: calendar_moment(value, "signupOpensAt"),
        event_days: string_list(value, "eventDays"),
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
        seed_from: int(value, "seedFrom").unwrap_or(0),
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
    // The stage's extras ride in `plan`, where every key left out keeps its
    // stored value, so the lengths the client does not edit here stay put.
    match format.competition {
        Competition::Team => {
            if format.bracket_kind == BracketKind::Swiss {
                let mut plan = json!({});
                merge_swiss_extras(&mut plan, &format.swiss);
                body["plan"] = plan;
            }
            merge_picks(
                &mut body,
                &format.picks,
                format.tiebreak,
                format.bracket_kind,
            );
            if format.bracket_kind != BracketKind::Swiss {
                // Not sent for anything but a Swiss: leaving it out keeps it.
                body.as_object_mut().map(|held| held.remove("tiebreak"));
            }
        }
        Competition::FreeForAll => {
            if let Some(ffa) = &format.ffa {
                merge_ffa(&mut body, ffa);
            }
        }
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
        BracketConfig::Single {
            rounds,
            third_place,
        } => json!({ "rounds": rounds, "thirdPlace": third_place }),
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

/// The body for `POST /api/t/{id}/fveto_action`: one faction ban or pick.
pub fn faction_veto_body(match_id: &str, game: i32, faction: TourneyFaction) -> Value {
    json!({ "matchId": match_id, "game": game, "faction": faction.as_wire() })
}

/// Where an organiser's single-call change goes, and what it sends.
///
/// The action is the last segment of `POST /api/t/{id}/{action}`. Two of them
/// are phase steps and go to `phase` with the step named in the body, as the
/// website sends them.
pub fn admin_request(change: &TourneyAdmin) -> (&'static str, Value) {
    match change {
        TourneyAdmin::ThirdPlace { on } => ("third_place", json!({ "on": u8::from(*on) })),
        TourneyAdmin::RoundBestOf {
            bracket,
            round,
            best_of,
            division,
        } => (
            "set_round_bo",
            // `division: null` is every division, as the website sends it
            // outside a division's own block.
            json!({
                "bracket": bracket.as_wire(),
                "round": round,
                "bo": best_of,
                "division": division,
            }),
        ),
        TourneyAdmin::PlanRoundBestOf {
            list,
            index,
            best_of,
        } => (
            "set_plan_round_bo",
            json!({ "list": list.as_wire(), "index": index, "bo": best_of }),
        ),
        TourneyAdmin::SetMaps {
            bracket,
            round,
            map_ids,
        } => (
            "set_maps",
            json!({ "bracket": bracket.as_wire(), "round": round, "maps": map_ids }),
        ),
        TourneyAdmin::SetMatchTeam {
            match_id,
            slot,
            team_id,
        } => (
            "set_match_team",
            json!({ "matchId": match_id, "slot": slot, "teamId": team_id }),
        ),
        TourneyAdmin::CopyPoolOrder { source_id, targets } => (
            "pool_copy_sequence",
            match targets {
                Some(ids) => json!({ "sourceId": source_id, "targetIds": ids }),
                None => json!({ "sourceId": source_id, "applyAll": 1 }),
            },
        ),
        TourneyAdmin::CopyMaps { source_id, picked } => (
            "copy_maps",
            // The service's three shapes: everything; whole pools with any
            // extra maps; or maps alone, which needs `pools: false` spelled
            // out, since no pool ids otherwise means every pool.
            match picked {
                None => json!({ "sourceId": source_id }),
                Some(pick) if pick.pool_ids.is_empty() => {
                    json!({ "sourceId": source_id, "pools": false, "mapIds": pick.map_ids })
                }
                Some(pick) => {
                    let mut body = json!({ "sourceId": source_id, "poolIds": pick.pool_ids });
                    if !pick.map_ids.is_empty() {
                        body["mapIds"] = json!(pick.map_ids);
                    }
                    body
                }
            },
        ),
        TourneyAdmin::FactionReset {
            match_id,
            game,
            slot,
        } => {
            let mut body = json!({ "matchId": match_id, "game": game });
            match slot {
                Some(1) => body["side"] = json!("t1"),
                Some(2) => body["side"] = json!("t2"),
                _ => {}
            }
            ("fveto_reset", body)
        }
        TourneyAdmin::PickOpponent { team_id } => ("pick_opponent", json!({ "teamId": team_id })),
        TourneyAdmin::UndoPickOpponent => ("undo_pick_opponent", json!({})),
        TourneyAdmin::PlayoffSetup {
            pick,
            minutes,
            tiebreak,
            redo,
        } => {
            let mut body = json!({
                "pick": pick.map_or("off", PickMode::as_wire),
                "minutes": (*minutes).clamp(0, 1440),
                "tiebreak": tiebreak.as_wire(),
            });
            if *redo {
                body["redo"] = json!(1);
            }
            ("playoff_setup", body)
        }
        TourneyAdmin::SwissRound1 { pairs } => (
            "swiss_round1",
            match pairs {
                Some(pairs) => json!({
                    "pairs": pairs.iter().map(|(one, two)| json!([one, two])).collect::<Vec<_>>()
                }),
                None => json!({ "shuffle": 1 }),
            },
        ),
        TourneyAdmin::MatchBestOf { match_id, best_of } => (
            "set_match_bo",
            json!({ "matchId": match_id, "bo": best_of }),
        ),
        TourneyAdmin::RemoveOrganiser { faf_id } => {
            ("remove_organizer", json!({ "fafId": faf_id.to_string() }))
        }
        TourneyAdmin::Ban {
            faf_id,
            name,
            reason,
            expires,
        } => (
            "ban_set",
            json!({
                "fafId": faf_id.to_string(),
                "name": name.trim(),
                "reason": reason.trim(),
                // `parseBanExpiry` takes anything `new Date` reads; empty is
                // no expiry.
                "expires": iso(*expires),
            }),
        ),
        TourneyAdmin::Unban { faf_id } => ("ban_remove", json!({ "fafId": faf_id.to_string() })),
        TourneyAdmin::RepullRatings => ("repull_ratings", json!({})),
        TourneyAdmin::ApplyRenames { player_ids } => {
            ("apply_renames", json!({ "playerIds": player_ids }))
        }
        TourneyAdmin::QualifierSeed { link_id, seed_from } => (
            "qualifier_seed",
            json!({ "id": link_id, "seedFrom": seed_from }),
        ),
        TourneyAdmin::StopAt { alive } => {
            ("set_stop_at", json!({ "stopAtAlive": alive, "confirm": 1 }))
        }
        TourneyAdmin::FinishEarly => ("phase", json!({ "action": "finish_early", "force": 1 })),
        TourneyAdmin::ReopenEarly => (
            "phase",
            json!({ "action": "undo_finish_early", "force": 1 }),
        ),
        TourneyAdmin::AddImage { data_url } => ("add_desc_image", json!({ "image": data_url })),
        TourneyAdmin::RemoveImage { file } => ("remove_desc_image", json!({ "file": file })),
        TourneyAdmin::SchedulePublish { at } => (
            "publish",
            match at {
                Some(_) => json!({ "publishAt": iso(*at) }),
                None => json!({ "cancelSchedule": 1 }),
            },
        ),
        TourneyAdmin::SetVeto { config } => ("edit_info", json!({ "veto": veto_body(config) })),
        TourneyAdmin::TeamCheckIn {
            team_id,
            checked_in,
        } => (
            "checkin_team",
            json!({ "teamId": team_id, "value": u8::from(*checked_in) }),
        ),
        TourneyAdmin::SwapTeam { in_id, out_id } => {
            ("swap_team", json!({ "inId": in_id, "outId": out_id }))
        }
        TourneyAdmin::CreateTeamFor { player_id, name } => (
            "org_create_team",
            json!({ "playerId": player_id, "name": name.trim() }),
        ),
        TourneyAdmin::ReplacePlayer { player_id, with } => (
            "replace_player",
            match with {
                Replacement::Standby { player_id: standby } => {
                    json!({ "playerId": player_id, "replacementId": standby })
                }
                // `lookup` takes a FAF name or id and is resolved against FAF
                // by the service; the id is what the picker chose.
                Replacement::Account { faf_id, rating } => {
                    let mut body = json!({ "playerId": player_id, "lookup": faf_id.to_string() });
                    if let Some(rating) = rating {
                        body["rating"] = json!(rating);
                    }
                    body
                }
            },
        ),
        TourneyAdmin::CancelTeamInvite { team_id, player_id } => (
            "cancel_invite",
            json!({ "teamId": team_id, "playerId": player_id }),
        ),
        // A count outside 2..=64 is refused outright, and the mode with it, so
        // one the organiser has not typed yet is left out rather than sent.
        TourneyAdmin::SetCaptainMode { mode, count } => {
            let mut body = json!({ "action": "set_captain_mode", "mode": mode.as_wire() });
            if (2..=64).contains(count) {
                body["count"] = json!(count);
            }
            ("phase", body)
        }
        TourneyAdmin::SetTeamName {
            player_id,
            team_name,
        } => {
            let mut body = json!({ "teamName": team_name.trim() });
            if let Some(player_id) = player_id {
                body["playerId"] = json!(player_id);
            }
            ("set_team_name", body)
        }
        TourneyAdmin::SetCategory { category } => (
            "set_category",
            json!({ "category": match category {
                TourneyCategory::Official => "official",
                TourneyCategory::Community => "community",
            } }),
        ),
        TourneyAdmin::MapSecret { map_id, secret } => {
            let secret = u8::from(*secret);
            (
                "map_secret",
                match map_id {
                    Some(id) => json!({ "id": id, "secret": secret }),
                    None => json!({ "all": 1, "secret": secret }),
                },
            )
        }
    }
}

/// The body for `POST /api/t/{id}/fveto_config`.
///
/// `enabled` as 0/1, the service's own convention, though it reads any truthy
/// value.
pub fn faction_veto_config_body(config: &FactionVetoConfig) -> Value {
    json!({
        "enabled": if config.enabled { 1 } else { 0 },
        "bans": config.bans,
        "picks": config.picks,
    })
}

/// The body for `POST /api/t/{id}/report_submit`, a player's score for the
/// other side to confirm.
///
/// Only what the handler reads: the running score, one replay id per new game
/// and the replays of drawn games. No winner and no forfeit, which are the
/// organiser's through `report`. `replayIds` is always sent, because the
/// handler counts it against the new games and an absent key counts as none.
pub fn submit_report_body(report: &MatchReport) -> Value {
    let mut body = json!({
        "matchId": report.match_id,
        "score1": report.score1,
        "score2": report.score2,
        "replayIds": report.replay_ids,
    });
    if !report.draw_replay_ids.is_empty() {
        body["drawReplayIds"] = json!(report.draw_replay_ids);
    }
    body
}

// ---------------------------------------------------------------------------
// The site around the tournaments: the account, the pending bar, the Hall of
// Fame, and the site administration and director console.
// ---------------------------------------------------------------------------

/// Where a site read goes, and whether it is a `POST` (the console's `data`
/// is one, with an empty body).
pub fn site_read_path(read: SiteRead) -> (&'static str, bool) {
    match read {
        SiteRead::Account => ("/auth/faf/me", false),
        SiteRead::Pending => ("my/pending", false),
        SiteRead::HallOfFame => ("halloffame", false),
        SiteRead::Console => ("siteadmin/data", true),
        SiteRead::Access {
            kind: AccessKind::Host,
        } => ("host_status", false),
        SiteRead::Access {
            kind: AccessKind::Editor,
        } => ("editor_status", false),
        SiteRead::Access {
            kind: AccessKind::Importer,
        } => ("importer_status", false),
    }
}

/// A site read's answer, parsed.
pub fn parse_site_document(read: SiteRead, document: &Value) -> SiteDocument {
    match read {
        SiteRead::Account => SiteDocument::Account(parse_account(document)),
        SiteRead::Pending => SiteDocument::Pending(parse_pending(document)),
        SiteRead::HallOfFame => SiteDocument::HallOfFame(parse_hall_of_fame(document)),
        SiteRead::Console => SiteDocument::Console(Box::new(parse_console(document))),
        SiteRead::Access { kind } => SiteDocument::Access {
            kind,
            status: AccessStatus {
                oauth: flag_or_true(document, "oauth"),
                logged_in: flag(document, "loggedIn"),
                allowed: flag(document, "allowed"),
                pending: flag(document, "pending"),
            },
        },
    }
}

/// This account's roles, from `GET /auth/faf/me`. `user` is `null` for a
/// caller the service holds no session for, and then every role is off.
pub fn parse_account(document: &Value) -> TourneyAccount {
    let Some(user) = document.get("user").filter(|held| held.is_object()) else {
        return TourneyAccount {
            oauth: flag(document, "enabled"),
            ..TourneyAccount::default()
        };
    };
    TourneyAccount {
        logged_in: true,
        oauth: flag(document, "enabled"),
        faf_id: int(user, "fafId"),
        faf_name: text(user, "fafName"),
        discord: text(user, "discord"),
        editor: flag(user, "editor"),
        importer: flag(user, "importer"),
        director: flag(user, "director"),
        site_admin: flag(user, "siteAdmin"),
        site_admin_account: flag(user, "siteAdminAccount"),
        admin_stand_down: flag(user, "adminStandDown"),
        allowed: flag(user, "allowed"),
    }
}

/// The first whole number in a sentence, where there is one.
fn first_number(text: &str) -> Option<i32> {
    let digits: String = text
        .chars()
        .skip_while(|held| !held.is_ascii_digit())
        .take_while(char::is_ascii_digit)
        .collect();
    digits.parse().ok()
}

/// `GET /api/my/pending`: what waits on this account, and the admin alert.
pub fn parse_pending(document: &Value) -> PendingSummary {
    let items = array(document, "pending")
        .iter()
        .filter_map(|item| {
            let sentence = text(item, "text");
            Some(PendingItem {
                tournament_id: id(item, "tId")?,
                tournament_name: text(item, "tName"),
                kind: text(item, "type"),
                tab: text(item, "tab"),
                count: first_number(&sentence),
                text: sentence,
            })
        })
        .collect();
    let alert = document.get("alert").filter(|held| held.is_object());
    let (requests, new_requests) = match alert {
        Some(held) => {
            let sentence = text(held, "text");
            // "N access request(s) waiting for review (M new)".
            let new = sentence
                .rfind('(')
                .map(|at| &sentence[at..])
                .filter(|tail| tail.contains("new"))
                .and_then(first_number);
            (first_number(&sentence).or(Some(1)), new)
        }
        None => (None, None),
    };
    PendingSummary {
        items,
        requests,
        new_requests,
    }
}

/// `GET /api/halloffame`.
pub fn parse_hall_of_fame(document: &Value) -> HallOfFame {
    HallOfFame {
        players: array(document, "players")
            .iter()
            .filter_map(|held| {
                Some(HallPlayer {
                    faf_id: int(held, "fafId")?,
                    name: text(held, "name"),
                    wins: int(held, "wins").unwrap_or(0),
                    entered: int(held, "entered").unwrap_or(0),
                })
            })
            .collect(),
        teams: array(document, "teams")
            .iter()
            .map(|held| HallTeam {
                name: text(held, "name"),
                wins: int(held, "wins").unwrap_or(0),
            })
            .collect(),
    }
}

fn parse_access_request(value: &Value) -> Option<AccessRequest> {
    Some(AccessRequest {
        id: id(value, "id")?,
        faf_id: int(value, "fafId").unwrap_or(0),
        faf_name: text(value, "fafName"),
        message: text(value, "message"),
        at: moment(value, "at"),
        status: text(value, "status"),
        decided_at: moment(value, "decidedAt"),
        decided_by: text(value, "decidedBy"),
    })
}

fn parse_listed(value: &Value) -> Option<ListedAccount> {
    Some(ListedAccount {
        faf_id: int(value, "fafId")?,
        name: text(value, "name"),
        at: moment(value, "at"),
        by: text(value, "by"),
        stand_down: flag(value, "standDown"),
    })
}

/// The console's `data` document.
pub fn parse_console(data: &Value) -> SiteAdminData {
    let list = |name: &str| -> Vec<ListedAccount> {
        array(data, name).iter().filter_map(parse_listed).collect()
    };
    let requests = |name: &str| -> Vec<AccessRequest> {
        array(data, name)
            .iter()
            .filter_map(parse_access_request)
            .collect()
    };
    SiteAdminData {
        role: match text(data, "role").as_str() {
            "editor" => ConsoleRole::Editor,
            "director" => ConsoleRole::Director,
            _ => ConsoleRole::Admin,
        },
        oauth: flag_or_true(data, "oauth"),
        logs: array(data, "logs")
            .iter()
            .map(|held| SiteLogEntry {
                id: text(held, "id"),
                at: moment(held, "at"),
                action: text(held, "action"),
                actor_kind: text(held, "actorKind"),
                actor_faf_id: int(held, "actorFafId"),
                actor_name: text(held, "actorName"),
                ip: text(held, "ip"),
                tournament_id: text(held, "tournamentId"),
                tournament_name: text(held, "tournamentName"),
                detail: text(held, "detail"),
            })
            .collect(),
        host_requests: requests("requests"),
        host_allowed: list("allowed"),
        editor_requests: requests("editorRequests"),
        editor_allowed: list("editorAllowed"),
        importer_requests: requests("importerRequests"),
        importer_allowed: list("importerAllowed"),
        archived: array(data, "archived")
            .iter()
            .filter_map(|held| {
                Some(ArchivedTourney {
                    id: id(held, "id")?,
                    name: text(held, "name"),
                    status: TourneyStatus::from_wire(&text(held, "status")),
                    at: moment(held, "at"),
                    players: count(held, "players"),
                })
            })
            .collect(),
        articles: array(data, "articles")
            .iter()
            .filter_map(|held| {
                Some(AdminArticle {
                    id: id(held, "id")?,
                    title: text(held, "title"),
                    // The source itself, markdown and all: this is what the
                    // editor edits, not a page to be read.
                    body: text(held, "body"),
                    parent_id: id(held, "parentId"),
                    archived: flag(held, "archived"),
                    updated_at: moment(held, "updatedAt"),
                })
            })
            .collect(),
        directors: list("directors"),
        site_admins: list("siteAdmins"),
        me: int(data, "me"),
        bans: array(data, "bans").iter().filter_map(parse_ban).collect(),
    }
}

/// Where a site write goes, and its body. Ids are strings on the service's
/// side, as for every other FAF id it stores.
pub fn site_request(write: &SiteWrite) -> (String, Value) {
    let path = |act: &str| format!("siteadmin/{act}");
    let access = |kind: AccessKind, host: &str, editor: &str, importer: &str| -> String {
        path(match kind {
            AccessKind::Host => host,
            AccessKind::Editor => editor,
            AccessKind::Importer => importer,
        })
    };
    match write {
        SiteWrite::StandDown { on } => (
            "/auth/faf/stand_down".into(),
            json!({ "on": u8::from(*on) }),
        ),
        SiteWrite::DismissRequests => ("my/dismiss_requests".into(), json!({})),
        SiteWrite::RequestAccess { kind, message } => (
            match kind {
                AccessKind::Host => "host_request",
                AccessKind::Editor => "editor_request",
                AccessKind::Importer => "importer_request",
            }
            .into(),
            json!({ "message": message.trim() }),
        ),
        SiteWrite::Decide { kind, id, approve } => (
            access(*kind, "decide", "editor_decide", "importer_decide"),
            json!({ "id": id, "approve": u8::from(*approve) }),
        ),
        SiteWrite::Revoke { kind, faf_id } => (
            access(*kind, "revoke", "editor_revoke", "importer_revoke"),
            json!({ "fafId": faf_id.to_string() }),
        ),
        SiteWrite::Grant { kind, faf_id, name } => (
            access(*kind, "grant", "editor_grant", "importer_grant"),
            json!({ "fafId": faf_id.to_string(), "name": name.trim() }),
        ),
        SiteWrite::SiteAdminGrant { faf_id, name } => (
            path("siteadmin_grant"),
            json!({ "fafId": faf_id.to_string(), "name": name.trim() }),
        ),
        SiteWrite::SiteAdminRevoke { faf_id } => (
            path("siteadmin_revoke"),
            json!({ "fafId": faf_id.to_string() }),
        ),
        SiteWrite::DirectorGrant { faf_id, name } => (
            path("director_grant"),
            json!({ "fafId": faf_id.to_string(), "name": name.trim() }),
        ),
        SiteWrite::DirectorRevoke { faf_id } => (
            path("director_revoke"),
            json!({ "fafId": faf_id.to_string() }),
        ),
        SiteWrite::GlobalBan {
            faf_id,
            name,
            reason,
            expires,
        } => (
            path("ban_set"),
            json!({
                "fafId": faf_id.to_string(),
                "name": name.trim(),
                "reason": reason.trim(),
                "expires": iso(*expires),
            }),
        ),
        SiteWrite::GlobalUnban { faf_id } => {
            (path("ban_remove"), json!({ "fafId": faf_id.to_string() }))
        }
        SiteWrite::SeriesBan {
            series_id,
            faf_id,
            name,
            reason,
            expires,
        } => (
            "series".into(),
            json!({
                "action": "ban_set",
                "id": series_id,
                "fafId": faf_id.to_string(),
                "name": name.trim(),
                "reason": reason.trim(),
                "expires": iso(*expires),
            }),
        ),
        SiteWrite::SeriesUnban { series_id, faf_id } => (
            "series".into(),
            json!({ "action": "ban_remove", "id": series_id, "fafId": faf_id.to_string() }),
        ),
        SiteWrite::ArticleSave {
            id,
            title,
            body,
            parent_id,
        } => {
            let mut sent = json!({
                "title": title.trim(),
                "body": body,
                "parentId": parent_id,
            });
            if let Some(id) = id.as_ref().filter(|held| !held.is_empty()) {
                sent["id"] = json!(id);
            }
            (path("article_save"), sent)
        }
        SiteWrite::ArticleArchive { id, restore } => {
            let mut sent = json!({ "id": id });
            if *restore {
                sent["restore"] = json!(1);
            }
            (path("article_delete"), sent)
        }
        SiteWrite::ArticleImage { data_url } => {
            (path("article_image"), json!({ "image": data_url }))
        }
        SiteWrite::Restore { tournament_id } => (format!("t/{tournament_id}/restore"), json!({})),
        SiteWrite::DeleteTournament { tournament_id } => {
            (format!("t/{tournament_id}/delete"), json!({}))
        }
        SiteWrite::ImportChallonge {
            tournament,
            api_key,
        } => (
            "import_challonge".into(),
            json!({ "tournament": tournament.trim(), "apiKey": api_key.trim() }),
        ),
    }
}

/// What a site write answered that the client keeps: the tournament an import
/// created, or the path of an uploaded article picture.
pub fn parse_site_answer(write: &SiteWrite, document: &Value) -> (Option<String>, Option<String>) {
    match write {
        SiteWrite::ImportChallonge { .. } => (id(document, "id"), None),
        SiteWrite::ArticleImage { .. } => (
            None,
            Some(text(document, "url")).filter(|url| !url.is_empty()),
        ),
        _ => (None, None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{MapPick, PlanList};

    /// A document shaped like `publicView`, with the conventions that matter:
    /// string ids, 0/1 flags, millisecond timestamps.
    /// A full detail response.
    ///
    /// Built in two halves rather than one literal: `json!` is a single
    /// recursive expansion and one object with every field of a tournament in
    /// it reaches the macro's recursion limit.
    fn document() -> Value {
        let mut document = core_document();
        for (key, value) in [
            (
                "description",
                json!(
                    "## Rules
- Best of three

See the [rules](https://x.invalid/r)."
                ),
            ),
            ("rewards", json!("**1st** an avatar")),
            (
                "sponsors",
                json!("Powered by [Nobody](https://x.invalid/s)"),
            ),
            ("prize", json!({ "currency": "usd", "amount": 150 })),
            (
                "streams",
                json!([
                    { "url": "https://twitch.tv/faflive", "info": "Main stream" },
                    { "url": "javascript:alert(1)", "info": "Refused" }
                ]),
            ),
            ("lobbyOptions", json!("- Full share")),
            ("mods", json!("No game mods")),
            ("descImages", json!(["a1b2.png", "c3d4.png"])),
            ("minTeams", json!(4)),
            ("seeding", json!("random")),
            (
                "plan",
                json!({ "wb": 3, "wbFinal": 5, "lb": 1, "lbFinal": 3, "gf": 7, "lbHandicap": 1 }),
            ),
            ("subs", json!(["p9", "p8"])),
        ] {
            document[key] = value;
        }
        document
    }

    fn core_document() -> Value {
        json!({
            "id": "e1a2b",
            "name": "Weekend Cup",
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
        assert!(
            event.description.starts_with("## Rules"),
            "markdown reaches the state as its source: {}",
            event.description
        );
        assert_eq!(event.status, TourneyStatus::Signup);
        assert_eq!(event.bracket_kind, BracketKind::Double);
        assert_eq!(event.team_size, 2);
        assert_eq!(event.rating.min, Some(800));
        assert_eq!(event.players.len(), 2);
        assert_eq!(event.teams.len(), 1);
        assert_eq!(event.organisers, vec!["TD".to_string()]);
        assert_eq!(event.organiser_discords, vec!["td#1".to_string()]);
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
    fn the_overview_fields_are_read() {
        // Every one of these was sent with every answer and read by nothing,
        // which is why the overview had a prize-money event with no prize on it.
        let event = parse_tourney(&document()).unwrap();
        assert_eq!(event.rewards, "**1st** an avatar");
        assert!(event.sponsors.starts_with("Powered by"));
        assert_eq!(event.lobby_options, "- Full share");
        assert_eq!(event.mods, "No game mods");
        assert_eq!(event.desc_images, vec!["a1b2.png", "c3d4.png"]);
        assert_eq!(event.min_teams, 4);
        assert_eq!(event.seeding, Seeding::Random);
        assert_eq!(event.subs, vec!["p9".to_string(), "p8".to_string()]);
    }

    #[test]
    fn a_prize_is_read_in_cents_and_case_folded() {
        let event = parse_tourney(&document()).unwrap();
        let prize = event.prize.expect("a prize");
        assert_eq!(prize.currency, Currency::Usd, "sent lowercase here");
        assert_eq!(prize.amount_cents, 15_000);

        // The three spellings of "no prize" the service actually sends, all of
        // which have to mean the same thing.
        for empty in [
            json!(null),
            json!({ "currency": null, "amount": null }),
            json!({ "currency": "USD", "amount": null }),
        ] {
            let mut without = document();
            without["prize"] = empty;
            assert_eq!(parse_tourney(&without).unwrap().prize, None);
        }
    }

    #[test]
    fn a_stream_that_is_not_http_never_reaches_the_state() {
        // The service filters these on the way in, and this filters them again:
        // the url ends up in `openUrl`, and the cheapest place to stop a
        // `javascript:` one is before it is ever stored.
        let event = parse_tourney(&document()).unwrap();
        assert_eq!(event.streams.len(), 1);
        assert_eq!(event.streams[0].url, "https://twitch.tv/faflive");
        assert_eq!(event.streams[0].info, "Main stream");
    }

    #[test]
    fn the_plan_is_read_in_the_shape_the_bracket_uses() {
        let event = parse_tourney(&document()).unwrap();
        assert_eq!(
            event.plan,
            Some(MatchPlan::Double {
                wb: 3,
                wb_final: 5,
                lb: 1,
                lb_final: 3,
                gf: 7,
                lb_handicap: true,
            })
        );

        // The trap this guards: the service keeps whatever plan object was
        // stored last, so an event switched to Swiss still carries the double
        // one. Reading by key would answer with a plan the bracket cannot use.
        let mut swiss = document();
        swiss["bracketType"] = json!("swiss");
        let event = parse_tourney(&swiss).unwrap();
        assert!(matches!(event.plan, Some(MatchPlan::Swiss { .. })));

        // A free-for-all has no bracket and therefore no plan, whatever is
        // sitting in the field.
        let mut ffa = document();
        ffa["competition"] = json!("ffa");
        assert_eq!(parse_tourney(&ffa).unwrap().plan, None);
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
    fn a_reply_carries_its_quote_and_an_everyone_post_its_mark() {
        let posts = parse_chat_posts(&json!({
            "messages": [
                { "id": "c3", "who": "Ada", "text": "yes", "everyone": 1,
                  "replyTo": { "id": "c1", "who": "Nuggets", "text": "gl <i>hf</i>" } },
                { "id": "c4", "who": "Ada", "text": "no", "replyTo": null }
            ]
        }));
        assert_eq!(
            posts[0].reply_to,
            Some(ChatQuote {
                id: "c1".into(),
                author: "Nuggets".into(),
                body: "gl hf".into(),
            })
        );
        assert!(posts[0].everyone);
        assert_eq!(posts[1].reply_to, None);
        assert!(!posts[1].everyone);

        assert_eq!(
            chat_post_body("global", "yes", Some("c1")),
            json!({ "room": "global", "text": "yes", "replyTo": "c1" })
        );
        assert_eq!(
            chat_post_body("global", "yes", None),
            json!({ "room": "global", "text": "yes" })
        );
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
        // Always sent. An absent key would be read as *on* whatever the draft
        // says; this one says on, as a new draft does.
        assert_eq!(body["playerReporting"], true);
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
    fn pinned_round_maps_and_secret_maps_are_read() {
        let event = parse_tourney(&json!({
            "id": "e1",
            "maps": { "sw:1": ["map1", "map2"], "sw:2": [] },
            "mapDb": [
                { "id": "map1", "name": "Setons", "secret": 1 },
                { "id": "map2", "name": "Hidden Map 1", "secret": 1, "masked": 1, "image": null },
            ],
        }))
        .expect("a tournament");
        assert_eq!(
            event.round_maps,
            vec![RoundMaps {
                round: "sw:1".into(),
                map_ids: vec!["map1".into(), "map2".into()],
            }],
            "an empty round is dropped"
        );
        assert!(event.map_db[0].secret && !event.map_db[0].masked);
        assert!(event.map_db[1].masked);
        assert_eq!(event.map_db[1].image_url, "");
    }

    #[test]
    fn a_faction_veto_is_read_as_the_viewers_slice() {
        let event = parse_tourney(&json!({
            "id": "e1",
            "teamSize": 1,
            "fveto": { "enabled": 1, "bans": 1, "picks": 2 },
            "matches": [{
                "id": "m1", "team1": "t1", "team2": "t2", "bo": 3,
                "fveto": { "bans": 1, "picks": 2, "games": {
                    "2": { "t1Done": true, "t2Done": false, "result": null,
                           "mine": { "bans": ["cybran"], "picks": [], "done": false },
                           "next": { "action": "pick", "index": 1, "of": 2 } },
                    "1": { "t1Done": true, "t2Done": true,
                           "result": { "t1": "aeon", "t2": "uef" } },
                    "3": { "t1Done": false, "t2Done": false, "result": null,
                           "mine": { "bans": ["klingon"], "picks": [], "done": false },
                           "next": null }
                } }
            }],
        }))
        .expect("a tournament");
        assert!(event.faction_veto.enabled);
        assert!(event.faction_veto_on());
        let veto = event.matches[0]
            .faction_veto
            .as_ref()
            .expect("a faction veto");
        assert_eq!(
            veto.games.iter().map(|game| game.game).collect::<Vec<_>>(),
            vec![1, 2, 3],
            "in game order, whatever order the object arrived in"
        );
        assert_eq!(
            veto.games[0].result,
            Some(FactionResult {
                team1: TourneyFaction::Aeon,
                team2: TourneyFaction::Uef
            })
        );
        assert_eq!(
            veto.games[0].mine, None,
            "a spectator's slice has no choices"
        );
        let second = &veto.games[1];
        assert_eq!(
            second.mine.as_ref().unwrap().bans,
            vec![TourneyFaction::Cybran]
        );
        assert_eq!(
            second.next,
            Some(FactionStep {
                action: PoolAction::Pick,
                index: 1,
                of: 2
            })
        );
        assert!(
            veto.games[2].mine.as_ref().unwrap().bans.is_empty(),
            "unknown faction dropped"
        );
        assert_eq!(veto.games_owed(), 1);
        assert!(!veto.is_settled());

        let off = parse_tourney(&json!({ "id": "e2", "fveto": null })).expect("a tournament");
        assert_eq!(off.faction_veto, FactionVetoConfig::default());
        assert!(!off.faction_veto_on());
    }

    #[test]
    fn faction_veto_bodies_use_the_services_names() {
        let body = faction_veto_body("m1", 2, TourneyFaction::Seraphim);
        assert_eq!(
            body,
            json!({ "matchId": "m1", "game": 2, "faction": "seraphim" })
        );
        let config = faction_veto_config_body(&FactionVetoConfig {
            enabled: true,
            bans: 2,
            picks: 3,
        });
        assert_eq!(config, json!({ "enabled": 1, "bans": 2, "picks": 3 }));
    }

    #[test]
    fn a_third_place_match_is_its_own_side_and_not_a_second_final() {
        // It carries the final's round number and index 0, so read as a
        // winners match it would sit on top of the final itself.
        let mut document = document();
        document["bracketType"] = json!("single");
        document["plan"] = json!({ "early": 3, "semi": 3, "final": 5, "thirdPlace": 1 });
        document["matches"] = json!([
            { "id": "f", "bracket": "wb", "round": 2, "index": 0, "bo": 5, "status": "ready" },
            { "id": "t", "bracket": "3p", "round": 2, "index": 0, "bo": 3, "status": "ready" },
        ]);
        document["teams"][0]["out"] = json!({ "bracket": "3p", "round": 2, "place": 3 });
        let event = parse_tourney(&document).unwrap();
        assert_eq!(event.matches[1].bracket, BracketSide::ThirdPlace);
        assert_eq!(event.matches[0].bracket, BracketSide::Winners);
        assert_eq!(
            event.teams[0].out.as_ref().unwrap().bracket,
            BracketSide::ThirdPlace
        );
        assert!(matches!(
            event.plan,
            Some(MatchPlan::Single {
                third_place: true,
                ..
            })
        ));
        assert_eq!(
            event.third_place_match().map(|entry| entry.id.as_str()),
            Some("t")
        );
        assert_eq!(BracketSide::ThirdPlace.as_wire(), "3p");
    }

    #[test]
    fn a_rating_check_carries_the_verdict_and_the_numbers_behind_it() {
        let check = parse_rating_check(&json!({
            "ok": true, "rated": 1, "rating": 1480, "capped": null, "ratingType": "1v1",
            "asOf": 1_790_000_000_000_i64, "min": 1500, "max": null, "exempt": false,
            "alreadyIn": false, "banned": null, "eligible": false,
            "message": "Your rating is below the minimum of 1500.",
        }));
        assert!(check.rated);
        assert_eq!(check.rating, Some(1480));
        assert_eq!(check.rating_kind, RatingKind::Ladder1v1);
        assert_eq!(check.min, Some(1500));
        assert_eq!(check.eligible, Some(false));
        assert_eq!(check.banned, None);
        // No rating found: the verdict is unknown, not a refusal.
        let unknown = parse_rating_check(&json!({ "rated": 1, "rating": null, "eligible": null }));
        assert_eq!(unknown.eligible, None);
    }

    #[test]
    fn every_board_of_a_player_is_listed_in_the_websites_order() {
        let ratings = parse_player_ratings(&json!({
            "playerId": "p1", "name": "Ada", "counts": "2v2", "countsRating": 2300, "capped": 2200,
            "ratingDate": 1_790_000_000_000_i64,
            "allRatings": { "boards": {
                "1v1": { "rating": 1800, "games": 120 },
                "global": { "rating": 2100, "games": 900 },
                "2v2": { "rating": 2300, "games": null },
            } },
        }));
        assert_eq!(ratings.counts, RatingKind::Team2v2);
        assert_eq!(ratings.capped, Some(2200));
        let boards: Vec<_> = ratings.boards.iter().map(|row| row.board).collect();
        assert_eq!(
            boards,
            vec![
                RatingKind::Global,
                RatingKind::Ladder1v1,
                RatingKind::Team2v2,
                RatingKind::Team3v3,
                RatingKind::Team4v4,
            ]
        );
        assert_eq!(ratings.boards[3].rating, None);
        // A hand-added entrant: no boards, and the service says why.
        let manual = parse_player_ratings(&json!({
            "playerId": "p2", "name": "Bob", "counts": "none", "allRatings": null,
            "reason": "This player has no FAF account linked (added manually).",
        }));
        assert!(manual.boards.is_empty());
        assert!(!manual.reason.is_empty());
    }

    #[test]
    fn the_teams_are_ordered_by_when_they_entered_not_as_listed() {
        let mut document = document();
        document["teams"] = json!([
            { "id": "late", "name": "Late", "entryKey": 3_000 },
            { "id": "first", "name": "First", "entryKey": 1_000 },
            { "id": "swapped", "name": "Swapped", "entryKey": 2_000 },
            { "id": "tied", "name": "Tied", "entryKey": 2_000 },
        ]);
        document["captainMode"] = json!("rating");
        document["captainCount"] = json!(4);
        let event = parse_tourney(&document).unwrap();
        assert_eq!(event.entry_order, vec!["first", "swapped", "tied", "late"]);
        assert_eq!(event.captain_mode, CaptainMode::Rating);
        assert_eq!(event.captain_count, 4);
    }

    #[test]
    fn the_team_changes_go_where_the_service_listens() {
        let request = |change: TourneyAdmin| admin_request(&change);
        assert_eq!(
            request(TourneyAdmin::TeamCheckIn {
                team_id: "t1".into(),
                checked_in: false,
            }),
            ("checkin_team", json!({ "teamId": "t1", "value": 0 }))
        );
        assert_eq!(
            request(TourneyAdmin::SwapTeam {
                in_id: "t9".into(),
                out_id: "t2".into(),
            }),
            ("swap_team", json!({ "inId": "t9", "outId": "t2" }))
        );
        assert_eq!(
            request(TourneyAdmin::CreateTeamFor {
                player_id: "p4".into(),
                name: " Blue ".into(),
            }),
            (
                "org_create_team",
                json!({ "playerId": "p4", "name": "Blue" })
            )
        );
        assert_eq!(
            request(TourneyAdmin::ReplacePlayer {
                player_id: "p1".into(),
                with: Replacement::Standby {
                    player_id: "p7".into(),
                },
            }),
            (
                "replace_player",
                json!({ "playerId": "p1", "replacementId": "p7" })
            )
        );
        assert_eq!(
            request(TourneyAdmin::ReplacePlayer {
                player_id: "p1".into(),
                with: Replacement::Account {
                    faf_id: 4711,
                    rating: Some(1500),
                },
            }),
            (
                "replace_player",
                json!({ "playerId": "p1", "lookup": "4711", "rating": 1500 })
            )
        );
        assert_eq!(
            request(TourneyAdmin::CancelTeamInvite {
                team_id: "t1".into(),
                player_id: "p5".into(),
            }),
            ("cancel_invite", json!({ "teamId": "t1", "playerId": "p5" }))
        );
        assert_eq!(
            request(TourneyAdmin::SetCaptainMode {
                mode: CaptainMode::Rating,
                count: 6,
            }),
            (
                "phase",
                json!({ "action": "set_captain_mode", "mode": "rating", "count": 6 })
            )
        );
        assert_eq!(
            request(TourneyAdmin::SetCaptainMode {
                mode: CaptainMode::Manual,
                count: 0,
            }),
            (
                "phase",
                json!({ "action": "set_captain_mode", "mode": "manual" })
            )
        );
    }

    #[test]
    fn a_signup_sends_a_rating_only_when_the_event_takes_one_by_hand() {
        assert_eq!(signup_body(None), json!({}));
        assert_eq!(signup_body(Some(1500)), json!({ "rating": 1500 }));
    }

    #[test]
    fn the_players_own_ban_and_invitation_are_read() {
        let mut document = document();
        document["myBan"] = json!({ "scope": "global", "reason": "Smurfing", "expires": null });
        document["viewer"]["invited"] = json!(1);
        document["players"][0]["discord"] = json!("ada#1");
        let event = parse_tourney(&document).unwrap();
        let ban = event.my_ban.as_ref().unwrap();
        assert_eq!(ban.scope, BanScope::Official);
        assert_eq!(ban.expires, None);
        assert!(event.viewer.invited);
        assert_eq!(event.players[0].discord, "ada#1");
        // A banned account is not offered Enter at all.
        assert!(!event.may_sign_up());
    }

    #[test]
    fn a_scheduled_publish_reads_as_the_date_the_service_stores() {
        // `cleanDate` output: an ISO instant, or a bare date meaning midnight UTC.
        let event =
            parse_tourney(&json!({ "id": "e1", "publishAt": "2026-10-01T18:00:00.000Z" })).unwrap();
        assert_eq!(event.publish_at, Some(1_790_877_600));
        let event = parse_tourney(&json!({ "id": "e1", "publishAt": "2026-10-01" })).unwrap();
        assert_eq!(event.publish_at, Some(1_790_812_800));
        let event = parse_tourney(&json!({ "id": "e1", "publishAt": null })).unwrap();
        assert_eq!(event.publish_at, None);
    }

    #[test]
    fn the_account_carries_every_role_and_none_without_a_session() {
        let account = parse_account(&json!({ "enabled": true, "user": {
            "fafId": 7, "fafName": "Nuggets", "discord": "n#1", "editor": 0, "importer": 1,
            "director": 1, "siteAdmin": 0, "siteAdminAccount": 1, "adminStandDown": 1, "allowed": 1 } }));
        assert!(account.logged_in && account.oauth && account.director && account.importer);
        assert!(!account.site_admin && account.site_admin_account && account.admin_stand_down);
        assert_eq!((account.faf_id, account.discord.as_str()), (Some(7), "n#1"));
        let anonymous = parse_account(&json!({ "enabled": true, "user": null }));
        assert!(!anonymous.logged_in && !anonymous.allowed);
    }

    #[test]
    fn the_pending_bar_keeps_the_numbers_out_of_the_sentences() {
        let pending = parse_pending(&json!({
            "pending": [
                { "tId": "e1", "tName": "Cup", "type": "requests", "tab": "players",
                  "text": "3 signup requests await your review" },
                { "tId": "e2", "tName": "Open", "type": "draft", "tab": "teams",
                  "text": "It's your pick in the captains draft" },
            ],
            "alert": { "type": "access", "dismissible": 1, "text": "5 access requests waiting for review (2 new)" },
        }));
        assert_eq!(pending.items[0].count, Some(3));
        assert_eq!(pending.items[1].count, None);
        assert_eq!((pending.requests, pending.new_requests), (Some(5), Some(2)));
        let quiet = parse_pending(&json!({ "pending": [], "alert": null }));
        assert_eq!(quiet.requests, None);
    }

    #[test]
    fn the_console_reads_each_list_and_the_role() {
        let console = parse_console(&json!({
            "role": "director", "oauth": 1,
            "requests": [{ "id": "r1", "fafId": 5, "fafName": "Asker", "message": "hi",
                           "at": 1_790_000_000_000_i64, "status": "pending" }],
            "allowed": [{ "fafId": 6, "name": "Host", "at": 1_790_000_000_000_i64, "by": "Admin" }],
            "directors": [{ "fafId": 7, "name": "Dir" }],
            "archived": [{ "id": "e9", "name": "Old", "status": "finished", "at": 1, "players": 12 }],
            "articles": [{ "id": "a1", "title": "Rules", "body": "# Head", "parentId": null, "archived": 1 }],
            "bans": [{ "fafId": "42", "name": "Troll", "reason": "", "expires": null, "at": 1, "by": "x" }],
            "me": 7,
        }));
        assert_eq!(console.role, ConsoleRole::Director);
        assert_eq!(console.host_requests[0].faf_name, "Asker");
        assert_eq!(console.host_allowed[0].faf_id, 6);
        assert_eq!(console.archived[0].players, 12);
        assert_eq!(console.articles[0].body, "# Head");
        assert!(console.articles[0].archived);
        assert_eq!(console.bans[0].faf_id, 42);
        assert_eq!(console.me, Some(7));
    }

    #[test]
    fn each_site_write_goes_where_the_service_listens() {
        let request = |write: SiteWrite| site_request(&write);
        assert_eq!(
            request(SiteWrite::StandDown { on: true }),
            ("/auth/faf/stand_down".to_string(), json!({ "on": 1 }))
        );
        assert_eq!(
            request(SiteWrite::RequestAccess {
                kind: AccessKind::Host,
                message: " weekly cup ".into(),
            }),
            (
                "host_request".to_string(),
                json!({ "message": "weekly cup" })
            )
        );
        assert_eq!(
            request(SiteWrite::Decide {
                kind: AccessKind::Editor,
                id: "r1".into(),
                approve: true,
            }),
            (
                "siteadmin/editor_decide".to_string(),
                json!({ "id": "r1", "approve": 1 })
            )
        );
        assert_eq!(
            request(SiteWrite::Revoke {
                kind: AccessKind::Host,
                faf_id: 5,
            }),
            ("siteadmin/revoke".to_string(), json!({ "fafId": "5" }))
        );
        assert_eq!(
            request(SiteWrite::Grant {
                kind: AccessKind::Importer,
                faf_id: 5,
                name: "Imp".into(),
            }),
            (
                "siteadmin/importer_grant".to_string(),
                json!({ "fafId": "5", "name": "Imp" })
            )
        );
        assert_eq!(
            request(SiteWrite::GlobalBan {
                faf_id: 9,
                name: "T".into(),
                reason: "smurf".into(),
                expires: None,
            }),
            (
                "siteadmin/ban_set".to_string(),
                json!({ "fafId": "9", "name": "T", "reason": "smurf", "expires": null })
            )
        );
        assert_eq!(
            request(SiteWrite::SeriesUnban {
                series_id: "s1".into(),
                faf_id: 9,
            }),
            (
                "series".to_string(),
                json!({ "action": "ban_remove", "id": "s1", "fafId": "9" })
            )
        );
        assert_eq!(
            request(SiteWrite::ArticleSave {
                id: None,
                title: " Rules ".into(),
                body: "text".into(),
                parent_id: Some("a1".into()),
            }),
            (
                "siteadmin/article_save".to_string(),
                json!({ "title": "Rules", "body": "text", "parentId": "a1" })
            )
        );
        assert_eq!(
            request(SiteWrite::ArticleArchive {
                id: "a2".into(),
                restore: true,
            }),
            (
                "siteadmin/article_delete".to_string(),
                json!({ "id": "a2", "restore": 1 })
            )
        );
        assert_eq!(
            request(SiteWrite::Restore {
                tournament_id: "e9".into(),
            }),
            ("t/e9/restore".to_string(), json!({}))
        );
        assert_eq!(
            request(SiteWrite::ImportChallonge {
                tournament: " challonge.com/abc ".into(),
                api_key: " key ".into(),
            }),
            (
                "import_challonge".to_string(),
                json!({ "tournament": "challonge.com/abc", "apiKey": "key" })
            )
        );
        assert_eq!(
            parse_site_answer(
                &SiteWrite::ImportChallonge {
                    tournament: String::new(),
                    api_key: String::new(),
                },
                &json!({ "ok": true, "id": "e77", "name": "Imported" }),
            ),
            (Some("e77".to_string()), None)
        );
        assert_eq!(
            admin_request(&TourneyAdmin::SetCategory {
                category: TourneyCategory::Official,
            }),
            ("set_category", json!({ "category": "official" }))
        );
        assert_eq!(
            admin_request(&TourneyAdmin::SetTeamName {
                player_id: None,
                team_name: " Blue Squad ".into(),
            }),
            ("set_team_name", json!({ "teamName": "Blue Squad" }))
        );
        assert_eq!(
            admin_request(&TourneyAdmin::SetTeamName {
                player_id: Some("p3".into()),
                team_name: String::new(),
            }),
            ("set_team_name", json!({ "teamName": "", "playerId": "p3" }))
        );
        let event = parse_tourney(&json!({ "id": "e1", "formation": "premade",
            "players": [{ "id": "p1", "name": "A", "teamName": " Blue " }] }))
        .unwrap();
        assert!(event.premade_teams);
        assert_eq!(event.players[0].team_name, "Blue");
    }

    #[test]
    fn a_preset_is_read_as_the_tournament_it_describes() {
        let presets = parse_presets(&json!({ "presets": [
            { "id": "lots", "name": "LotS", "blurb": "b", "notes": ["n1"], "allowed": true,
              "apply": { "competition": "team", "teamSize": 1, "bracketType": "swiss",
                         "maxTeams": 16, "signupMode": "invite", "pickPhase": 1,
                         "plan": { "bo": 1, "winCut": 3, "lossCut": 3, "decidingBo": 3,
                                   "stage2": 1, "s2CutTo": 8 } } },
            { "id": "invitational", "name": "Invitational", "allowed": false, "apply": null },
        ] }));
        assert_eq!(presets.len(), 2);
        let lots = presets[0].apply.as_deref().unwrap();
        assert_eq!(lots.bracket_kind, BracketKind::Swiss);
        assert_eq!(lots.swiss_cuts, SwissCuts { wins: 3, losses: 3 });
        assert_eq!(lots.deciding_best_of, 3);
        assert!(lots.pick_opponents);
        assert_eq!(lots.stage_two_plan.map(|stage| stage.cut_to), Some(8));
        assert_eq!(presets[0].notes, vec!["n1".to_string()]);
        assert!(!presets[1].allowed);
        assert!(presets[1].apply.is_none());
    }

    #[test]
    fn a_swiss_is_created_with_its_cuts_its_playoffs_and_who_picks() {
        let draft = TourneyDraft {
            name: "LotS".into(),
            bracket_kind: BracketKind::Swiss,
            plan: Some(MatchPlan::default_for(BracketKind::Swiss)),
            preset_id: Some("lots".into()),
            swiss: SwissExtras {
                cuts: SwissCuts { wins: 3, losses: 3 },
                deciding_best_of: 3,
                stage_two: Some(StageTwoPlan {
                    double: false,
                    cut_to: 8,
                    best_of: 3,
                    final_best_of: 5,
                    grand_final: 5,
                    handicap: false,
                    third_place: true,
                }),
            },
            picks: PickSettings {
                on: true,
                minutes: 5,
                mode: PickMode::Bottom,
            },
            tiebreak: SwissTiebreak::Beaten,
            ..TourneyDraft::new()
        };
        let body = create_body(&draft);
        assert_eq!(body["presetId"], "lots");
        assert_eq!(body["plan"]["winCut"], 3);
        assert_eq!(body["plan"]["decidingBo"], 3);
        assert_eq!(body["plan"]["stage2"], 1);
        assert_eq!(body["plan"]["s2CutTo"], 8);
        assert_eq!(body["plan"]["s2Gf"], 5);
        assert_eq!(body["plan"]["s2Third"], 1);
        assert_eq!(body["pickOpponents"], 1);
        assert_eq!(body["pickMinutes"], 5);
        assert_eq!(body["pickMode"], "bottom");
        assert_eq!(body["tiebreak"], "beaten");
        assert_eq!(body["stopAtAlive"], 0);
        // Picking off sends no clock; a bracket that is not Swiss sends `gd`.
        let single = create_body(&TourneyDraft {
            name: "Cup".into(),
            picks: PickSettings {
                on: false,
                minutes: 9,
                mode: PickMode::Half,
            },
            tiebreak: SwissTiebreak::Beaten,
            stop_at_alive: 4,
            ..TourneyDraft::new()
        });
        assert_eq!(single["pickMinutes"], 0);
        assert_eq!(single["tiebreak"], "gd");
        assert_eq!(single["stopAtAlive"], 4);
        assert!(single["plan"].get("winCut").is_none());
    }

    #[test]
    fn a_free_for_all_is_created_with_its_lobbies() {
        let body = create_body(&TourneyDraft {
            name: "FFA night".into(),
            competition: Competition::FreeForAll,
            team_size: 1,
            plan: None,
            ffa: Some(FfaConfig {
                per_match: 8,
                advance: 3,
                mode: FfaMode::Points,
                rounds: 4,
                cut_to: 8,
                final_size: 4,
            }),
            ..TourneyDraft::new()
        });
        assert_eq!(body["competition"], "ffa");
        assert_eq!(body["perMatch"], 8);
        assert_eq!(body["mode"], "points");
        // Only knockout lobbies advance anyone; points mode sends 1.
        assert_eq!(body["advance"], 1);
        assert_eq!(
            (
                body["rounds"].clone(),
                body["cutTo"].clone(),
                body["finalSize"].clone()
            ),
            (json!(4), json!(8), json!(4))
        );
    }

    #[test]
    fn a_format_change_sends_the_swiss_extras_in_plan_and_the_tiebreak_only_for_swiss() {
        let swiss = FormatDraft {
            swiss: SwissExtras {
                cuts: SwissCuts { wins: 3, losses: 2 },
                deciding_best_of: 0,
                stage_two: None,
            },
            picks: PickSettings {
                on: false,
                minutes: 0,
                mode: PickMode::Half,
            },
            tiebreak: SwissTiebreak::GameDiff,
            ffa: None,
            competition: Competition::Team,
            team_size: 1,
            formation: Formation::Solo,
            bracket_kind: BracketKind::Swiss,
            draft_snakes: false,
        };
        let body = edit_format_body(&swiss, false);
        assert_eq!(
            body["plan"],
            json!({ "winCut": 3, "lossCut": 2, "decidingBo": 0, "stage2": 0 })
        );
        assert_eq!(body["tiebreak"], "gd");
        let single = edit_format_body(
            &FormatDraft {
                bracket_kind: BracketKind::Single,
                ..swiss
            },
            false,
        );
        assert!(single.get("plan").is_none());
        assert!(single.get("tiebreak").is_none());
        assert_eq!(single["pickOpponents"], 0);
    }

    #[test]
    fn a_swiss_with_playoffs_reads_its_plan_its_playoffs_and_the_picks() {
        let event = parse_tourney(&json!({
            "id": "e1", "bracketType": "swiss", "competition": "team",
            "plan": { "bo": 1, "winCut": 3, "lossCut": 3, "decidingBo": 3, "stage2": 1,
                      "s2Type": "single", "s2CutTo": 8, "s2Bo": 3, "s2Final": 5, "s2Third": 1 },
            "pickOpponents": 1, "pickMinutes": 5, "pickMode": "bottom",
            "stage2": { "type": "single", "cutTo": 8, "built": 1790000000000_i64, "field": ["t1", "t2"], "thirdPlace": 1 },
            "playoffs": { "pick": "bottom", "made": 1, "built": 0, "locked": 0, "swissDone": 1, "redraws": 2 },
            "picks": {
                "status": "open", "half": 4, "field": ["t1", "t2", "t3"], "order": ["t1"],
                "picks": { "t1": "t8" }, "available": ["t6", "t7"], "turn": "t2", "myTurn": true,
                "msLeft": 90500, "perPickMs": 300000,
                "log": [{ "by": "t1", "byName": "Ada", "target": "t8", "at": 1790000000000_i64, "auto": 0 }],
                "forWhat": "stage2", "mode": "unbeaten", "rest": "seed", "pool": ["t6", "t7"],
                "poolRule": "bottom", "records": { "t1": "3-0" }, "drawn": [["t3", "t4"]],
            },
            "plannedR1": [["t1", "t2"], ["bad"]],
            "swissR1Open": 1,
        }))
        .unwrap();
        assert_eq!(event.deciding_best_of, 3);
        let plan = event.stage_two_plan.unwrap();
        assert!(!plan.double && plan.third_place);
        assert_eq!((plan.cut_to, plan.best_of, plan.final_best_of), (8, 3, 5));
        assert!(event.pick_opponents);
        assert_eq!((event.pick_minutes, event.pick_mode), (5, PickMode::Bottom));
        let playoffs = event.playoffs.unwrap();
        assert_eq!(playoffs.pick, Some(PickMode::Bottom));
        assert!(playoffs.made && !playoffs.built && playoffs.swiss_done);
        assert_eq!((playoffs.cut_to, playoffs.redraws), (8, 2));
        assert_eq!(playoffs.field, vec!["t1".to_string(), "t2".to_string()]);
        let picks = event.picks.unwrap();
        assert!(picks.open && picks.my_turn && picks.stage_two && picks.unbeaten);
        assert!(picks.rest_seeded && picks.pool_bottom);
        // Rounded up: 90.5 seconds is still 91 seconds to go.
        assert_eq!(
            (picks.seconds_left, picks.seconds_per_pick),
            (Some(91), Some(300))
        );
        assert_eq!(picks.picks[0].target, "t8");
        assert_eq!(picks.turn.as_deref(), Some("t2"));
        assert_eq!(picks.records[0].record, "3-0");
        assert_eq!(picks.drawn, vec![("t3".to_string(), "t4".to_string())]);
        assert_eq!(picks.log[0].by_name, "Ada");
        assert_eq!(
            event.planned_round_one,
            vec![("t1".to_string(), "t2".to_string())]
        );
        assert!(event.round_one_open);
    }

    #[test]
    fn an_import_brings_its_group_tables_and_placings() {
        let event = parse_tourney(&json!({
            "id": "e1", "imported": true, "standingsOnly": 1,
            "importedGroups": [{ "name": "Group A", "played": 3, "rows": [
                { "name": "Ada", "w": 2, "l": 1, "gw": 5, "gl": 3 },
            ] }],
            "importedStandings": [{ "rank": 1, "name": "Ada" }, { "rank": 1, "name": "Bo" }, { "name": "no rank" }],
        }))
        .unwrap();
        assert_eq!(event.imported_groups[0].name, "Group A");
        assert_eq!(event.imported_groups[0].played, 3);
        assert_eq!(
            event.imported_groups[0].rows[0],
            ImportedRow {
                name: "Ada".into(),
                wins: 2,
                losses: 1,
                games_won: 5,
                games_lost: 3,
            }
        );
        // A tie stays a tie; a line without a rank is not a placing.
        assert_eq!(event.imported_standings.len(), 2);
        assert_eq!(event.imported_standings[1].rank, 1);
    }

    #[test]
    fn the_import_sources_say_which_events_may_give_maps() {
        let sources = parse_copy_sources(&json!({ "tournaments": [
            { "id": "e1", "name": "Cup", "mapCount": 12, "poolCount": 3, "canCopyMaps": 1 },
            { "id": "e2", "name": "Official", "mapCount": 0, "poolCount": 0, "canCopyMaps": 0 },
            { "name": "no id" },
        ] }));
        assert_eq!(sources.len(), 2);
        assert_eq!(
            (
                sources[0].map_count,
                sources[0].pool_count,
                sources[0].may_copy
            ),
            (12, 3, true)
        );
        assert!(!sources[1].may_copy);
    }

    #[test]
    fn a_detail_carries_the_chat_counts_and_where_an_import_came_from() {
        let event = parse_tourney(&json!({
            "id": "e1", "myMentionCount": 2, "chatPingCount": 1, "myUnreadCount": 7,
            "imported": true, "importedType": "double elimination", "standingsOnly": 1,
            "sourceUrl": "https://challonge.com/abc",
        }))
        .unwrap();
        assert_eq!(
            (
                event.my_mention_count,
                event.chat_ping_count,
                event.my_unread_count
            ),
            (2, 1, 7)
        );
        assert_eq!(event.imported_type, "double elimination");
        assert!(event.standings_only);
        assert_eq!(event.source_url, "https://challonge.com/abc");
        // Only list rows carry `canManage`; everything else is manageable as far
        // as the list is concerned, and the viewer block decides the rest.
        assert!(event.can_manage);
        let row = parse_tourney(&json!({ "id": "e2", "published": 0, "canManage": 0 })).unwrap();
        assert!(!row.can_manage);
    }

    #[test]
    fn a_rename_check_names_who_changed_and_what_it_could_not_ask() {
        let check = parse_rename_check(&json!({
            "ok": true, "checked": 3, "failed": 1, "manual": 2,
            "changed": [
                { "playerId": "p1", "fafId": "11", "from": "Old", "to": "New", "team": "Team Old" },
                { "playerId": "p2", "fafId": "12", "from": "A", "to": "B", "team": null },
                { "from": "no id", "to": "dropped" },
            ],
        }));
        assert_eq!(check.checked, 3);
        assert_eq!(check.failed, 1);
        assert_eq!(check.manual, 2);
        assert_eq!(check.changed.len(), 2);
        assert_eq!(check.changed[0].team.as_deref(), Some("Team Old"));
        assert_eq!(check.changed[1].team, None);
    }

    #[test]
    fn the_organiser_view_carries_bans_and_how_far_the_event_got() {
        let mut document = document();
        document["bans"] = json!([
            { "fafId": "77", "name": "Troll", "reason": "smurf", "expires": "2026-12-01T00:00:00.000Z",
              "at": 1_790_000_000_000_i64, "by": "Nuggets", "expired": 0 },
        ]);
        document["stopAtAlive"] = json!(4);
        document["survivors"] = json!({ "wb": ["t1", "t2"], "lb": ["t3"] });
        document["earlyFinish"] = json!({ "at": 1_790_000_000_000_i64, "by": "Automatic", "auto": 1,
            "target": 4, "alive": 3, "names": ["A", "B", "C"], "wb": [], "lb": [], "unplayed": [] });
        document["qualifiers"] = json!([{ "id": "q1", "tournamentId": "c1", "seedFrom": 5 }]);
        let event = parse_tourney(&document).unwrap();
        assert_eq!(event.bans[0].faf_id, 77);
        assert_eq!(event.bans[0].expires, Some(1_796_083_200));
        assert!(!event.bans[0].expired);
        assert_eq!(event.stop_at_alive, 4);
        assert_eq!(event.survivors.as_ref().map(Survivors::alive), Some(3));
        let finish = event.early_finish.unwrap();
        assert!(finish.automatic);
        assert_eq!(finish.names.len(), 3);
        assert_eq!(event.qualifiers[0].seed_from, 5);
    }

    #[test]
    fn each_admin_change_goes_where_the_service_listens() {
        let request = |change: TourneyAdmin| admin_request(&change);
        assert_eq!(
            request(TourneyAdmin::ThirdPlace { on: false }),
            ("third_place", json!({ "on": 0 }))
        );
        assert_eq!(
            request(TourneyAdmin::RoundBestOf {
                bracket: BracketSide::ThirdPlace,
                round: 3,
                best_of: 5,
                division: None,
            }),
            (
                "set_round_bo",
                json!({ "bracket": "3p", "round": 3, "bo": 5, "division": null })
            )
        );
        assert_eq!(
            request(TourneyAdmin::RoundBestOf {
                bracket: BracketSide::Winners,
                round: 1,
                best_of: 3,
                division: Some(2),
            }),
            (
                "set_round_bo",
                json!({ "bracket": "wb", "round": 1, "bo": 3, "division": 2 })
            )
        );
        assert_eq!(
            request(TourneyAdmin::PlanRoundBestOf {
                list: PlanList::Losers,
                index: 2,
                best_of: 5,
            }),
            (
                "set_plan_round_bo",
                json!({ "list": "lb", "index": 2, "bo": 5 })
            )
        );
        assert_eq!(
            request(TourneyAdmin::SetMaps {
                bracket: BracketSide::Winners,
                round: 2,
                map_ids: vec!["mp1".into(), "mp2".into()],
            }),
            (
                "set_maps",
                json!({ "bracket": "wb", "round": 2, "maps": ["mp1", "mp2"] })
            )
        );
        assert_eq!(
            request(TourneyAdmin::SetMatchTeam {
                match_id: "m1".into(),
                slot: 2,
                team_id: None,
            }),
            (
                "set_match_team",
                json!({ "matchId": "m1", "slot": 2, "teamId": null })
            )
        );
        assert_eq!(
            request(TourneyAdmin::CopyPoolOrder {
                source_id: "pl1".into(),
                targets: None,
            }),
            (
                "pool_copy_sequence",
                json!({ "sourceId": "pl1", "applyAll": 1 })
            )
        );
        assert_eq!(
            request(TourneyAdmin::CopyPoolOrder {
                source_id: "pl1".into(),
                targets: Some(vec!["pl2".into()]),
            }),
            (
                "pool_copy_sequence",
                json!({ "sourceId": "pl1", "targetIds": ["pl2"] })
            )
        );
        // The three shapes `copy_maps` reads.
        assert_eq!(
            request(TourneyAdmin::CopyMaps {
                source_id: "e2".into(),
                picked: None,
            }),
            ("copy_maps", json!({ "sourceId": "e2" }))
        );
        assert_eq!(
            request(TourneyAdmin::CopyMaps {
                source_id: "e2".into(),
                picked: Some(MapPick {
                    pool_ids: vec!["pl1".into()],
                    map_ids: vec![],
                }),
            }),
            ("copy_maps", json!({ "sourceId": "e2", "poolIds": ["pl1"] }))
        );
        assert_eq!(
            request(TourneyAdmin::CopyMaps {
                source_id: "e2".into(),
                picked: Some(MapPick {
                    pool_ids: vec![],
                    map_ids: vec!["mp9".into()],
                }),
            }),
            (
                "copy_maps",
                json!({ "sourceId": "e2", "pools": false, "mapIds": ["mp9"] })
            )
        );
        assert_eq!(
            request(TourneyAdmin::FactionReset {
                match_id: "m1".into(),
                game: 2,
                slot: Some(2),
            }),
            (
                "fveto_reset",
                json!({ "matchId": "m1", "game": 2, "side": "t2" })
            )
        );
        assert_eq!(
            request(TourneyAdmin::FactionReset {
                match_id: "m1".into(),
                game: 1,
                slot: None,
            }),
            ("fveto_reset", json!({ "matchId": "m1", "game": 1 }))
        );
        assert_eq!(
            request(TourneyAdmin::PickOpponent {
                team_id: "t7".into(),
            }),
            ("pick_opponent", json!({ "teamId": "t7" }))
        );
        assert_eq!(
            request(TourneyAdmin::UndoPickOpponent),
            ("undo_pick_opponent", json!({}))
        );
        assert_eq!(
            request(TourneyAdmin::PlayoffSetup {
                pick: None,
                minutes: 5000,
                tiebreak: SwissTiebreak::GameDiff,
                redo: false,
            }),
            (
                "playoff_setup",
                json!({ "pick": "off", "minutes": 1440, "tiebreak": "gd" })
            )
        );
        assert_eq!(
            request(TourneyAdmin::PlayoffSetup {
                pick: Some(PickMode::Bottom),
                minutes: 10,
                tiebreak: SwissTiebreak::Beaten,
                redo: true,
            }),
            (
                "playoff_setup",
                json!({ "pick": "bottom", "minutes": 10, "tiebreak": "beaten", "redo": 1 })
            )
        );
        assert_eq!(
            request(TourneyAdmin::SwissRound1 {
                pairs: Some(vec![("t1".into(), "t2".into())]),
            }),
            ("swiss_round1", json!({ "pairs": [["t1", "t2"]] }))
        );
        assert_eq!(
            request(TourneyAdmin::SwissRound1 { pairs: None }),
            ("swiss_round1", json!({ "shuffle": 1 }))
        );
        assert_eq!(
            request(TourneyAdmin::MatchBestOf {
                match_id: "m1".into(),
                best_of: 7,
            }),
            ("set_match_bo", json!({ "matchId": "m1", "bo": 7 }))
        );
        // Ids are strings on the service's side: `organizerFafIds` and the
        // ban store are keyed by `String(fafId)`.
        assert_eq!(
            request(TourneyAdmin::RemoveOrganiser { faf_id: 42 }),
            ("remove_organizer", json!({ "fafId": "42" }))
        );
        assert_eq!(
            request(TourneyAdmin::Ban {
                faf_id: 42,
                name: " Troll ".into(),
                reason: "".into(),
                expires: Some(1_790_000_000),
            }),
            (
                "ban_set",
                json!({
                    "fafId": "42",
                    "name": "Troll",
                    "reason": "",
                    "expires": "2026-09-21T14:13:20Z",
                })
            )
        );
        assert_eq!(
            request(TourneyAdmin::Ban {
                faf_id: 42,
                name: "Troll".into(),
                reason: "smurf".into(),
                expires: None,
            })
            .1["expires"],
            Value::Null
        );
        assert_eq!(
            request(TourneyAdmin::Unban { faf_id: 42 }),
            ("ban_remove", json!({ "fafId": "42" }))
        );
        assert_eq!(
            request(TourneyAdmin::RepullRatings),
            ("repull_ratings", json!({}))
        );
        assert_eq!(
            request(TourneyAdmin::ApplyRenames {
                player_ids: vec!["p1".into(), "p2".into()],
            }),
            ("apply_renames", json!({ "playerIds": ["p1", "p2"] }))
        );
        assert_eq!(
            request(TourneyAdmin::QualifierSeed {
                link_id: "q1".into(),
                seed_from: 5,
            }),
            ("qualifier_seed", json!({ "id": "q1", "seedFrom": 5 }))
        );
        assert_eq!(
            request(TourneyAdmin::StopAt { alive: 4 }),
            ("set_stop_at", json!({ "stopAtAlive": 4, "confirm": 1 }))
        );
        // The two phase steps go to `phase`, named in the body.
        assert_eq!(
            request(TourneyAdmin::FinishEarly),
            ("phase", json!({ "action": "finish_early", "force": 1 }))
        );
        assert_eq!(
            request(TourneyAdmin::ReopenEarly),
            (
                "phase",
                json!({ "action": "undo_finish_early", "force": 1 })
            )
        );
        assert_eq!(
            request(TourneyAdmin::AddImage {
                data_url: "data:image/png;base64,AAAA".into(),
            }),
            (
                "add_desc_image",
                json!({ "image": "data:image/png;base64,AAAA" })
            )
        );
        assert_eq!(
            request(TourneyAdmin::RemoveImage {
                file: "desc_ab.png".into(),
            }),
            ("remove_desc_image", json!({ "file": "desc_ab.png" }))
        );
        assert_eq!(
            request(TourneyAdmin::SchedulePublish {
                at: Some(1_790_000_000),
            }),
            ("publish", json!({ "publishAt": "2026-09-21T14:13:20Z" }))
        );
        assert_eq!(
            request(TourneyAdmin::SchedulePublish { at: None }),
            ("publish", json!({ "cancelSchedule": 1 }))
        );
        assert_eq!(
            request(TourneyAdmin::MapSecret {
                map_id: Some("map1".into()),
                secret: true,
            }),
            ("map_secret", json!({ "id": "map1", "secret": 1 }))
        );
        assert_eq!(
            request(TourneyAdmin::MapSecret {
                map_id: None,
                secret: false,
            }),
            ("map_secret", json!({ "all": 1, "secret": 0 }))
        );
        // Every key, because `cleanVeto` resets whatever it is not sent.
        assert_eq!(
            request(TourneyAdmin::SetVeto {
                config: VetoConfig {
                    enabled: true,
                    mode: VetoMode::Continuous,
                    team_a: VetoTeamA::Manual,
                    reveal_bans: true,
                },
            }),
            (
                "edit_info",
                json!({ "veto": {
                    "enabled": true,
                    "mode": "continuous",
                    "abMode": "manual",
                    "revealBans": true,
                } })
            )
        );
    }

    #[test]
    fn saving_the_settings_sends_the_board_the_schedule_and_the_check_in() {
        let draft = TourneyDraft {
            name: "Cup".into(),
            rating_kind: RatingKind::Ladder1v1,
            check_in_deadline: Some(1_790_000_000),
            event_days: vec!["2026-10-03".into(), " ".into(), "2026-10-04".into()],
            veto: VetoConfig {
                enabled: true,
                ..VetoConfig::default()
            },
            ..TourneyDraft::new()
        };
        let body = edit_info_body(&draft);
        assert_eq!(body["ratingType"], "1v1");
        assert_eq!(body["checkInDeadline"], "2026-09-21T14:13:20Z");
        assert_eq!(body["eventDays"], json!(["2026-10-03", "2026-10-04"]));
        // Never the veto: it would rebuild every veto not yet started.
        assert!(body.get("veto").is_none());
        // Creation takes all of it, the veto included, with every key.
        let created = create_body(&draft);
        assert_eq!(created["veto"]["abMode"], "lowerA");
        assert_eq!(created["veto"]["revealBans"], false);
        assert_eq!(created["eventDays"], json!(["2026-10-03", "2026-10-04"]));
    }

    #[test]
    fn the_veto_rules_and_the_schedule_are_read_back() {
        let mut document = document();
        document["veto"] =
            json!({ "enabled": 1, "mode": "continuous", "abMode": "random", "revealBans": 1 });
        document["eventDays"] = json!(["2026-10-03", "2026-10-04"]);
        let event = parse_tourney(&document).unwrap();
        assert_eq!(event.veto.team_a, VetoTeamA::Random);
        assert!(event.veto.reveal_bans);
        assert_eq!(event.event_days.len(), 2);
    }

    #[test]
    fn a_players_submission_carries_the_score_and_the_replays_only() {
        let body = submit_report_body(&MatchReport {
            match_id: "m1".into(),
            score1: 2,
            score2: 1,
            replay_ids: vec!["21534001".into()],
            draw_replay_ids: Vec::new(),
            winner: Some("t1".into()),
            forfeit: Some("t2".into()),
        });
        assert_eq!(body["matchId"], "m1");
        assert_eq!(body["score1"], 2);
        assert_eq!(body["score2"], 1);
        assert_eq!(body["replayIds"], json!(["21534001"]));
        // `report_submit` reads neither, and sending them would suggest a
        // player could decide a series.
        assert!(body.get("winner").is_none());
        assert!(body.get("forfeit").is_none());
        assert!(body.get("drawReplayIds").is_none(), "nothing to keep");

        let drawn = submit_report_body(&MatchReport {
            match_id: "m1".into(),
            score1: 1,
            score2: 0,
            replay_ids: vec!["21534001".into()],
            draw_replay_ids: vec!["21534010".into()],
            ..MatchReport::default()
        });
        assert_eq!(drawn["drawReplayIds"], json!(["21534010"]));
    }

    #[test]
    fn both_paths_send_the_drafts_own_player_reporting() {
        // Always present, because the service reads an absent key as on, and
        // always the draft's: a fixed value turned it off on every event whose
        // settings were saved here.
        let draft = TourneyDraft {
            name: "Weekend Cup".into(),
            ..TourneyDraft::new()
        };
        assert!(draft.player_reporting, "on by default, as on the website");
        assert_eq!(create_body(&draft)["playerReporting"], true);
        assert_eq!(edit_info_body(&draft)["playerReporting"], true);

        let organiser_only = TourneyDraft {
            player_reporting: false,
            ..draft
        };
        assert_eq!(create_body(&organiser_only)["playerReporting"], false);
        assert_eq!(edit_info_body(&organiser_only)["playerReporting"], false);
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
            ..FormatDraft::default()
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
        for guessed in ["perRoundBo", "seeding", "maxTeams"] {
            assert!(
                whole.get(guessed).is_none() && bracket_only.get(guessed).is_none(),
                "{guessed} is not ours to send"
            );
        }
        // A Swiss plan carries its extras alone: the lengths are left out, and
        // a key left out keeps its stored value.
        for length in ["bo", "final", "finalBo", "fast"] {
            assert!(
                bracket_only["plan"].get(length).is_none(),
                "{length} is not ours to send"
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
            third_place: true,
        };
        let drawn = phase_body(TourneyPhase::StartBracket, Some(&plan));
        assert_eq!(drawn["action"], "start_bracket");
        assert_eq!(drawn["config"]["rounds"], json!([3, 3, 5]));
        // Always sent, because the service falls back to the stored plan's
        // choice when the key is absent, and "no" has to be sayable.
        assert_eq!(drawn["config"]["thirdPlace"], true);

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

    /// Spawn information survives a round trip, because `map_save` overwrites
    /// whatever is stored with whatever is sent: a save that dropped it
    /// deleted it.
    #[test]
    fn a_maps_spawn_information_goes_back_the_way_it_came() {
        let map = parse_map(&json!({
            "id": "map1",
            "name": "Setons",
            "spec": { "t1": [1, 3], "t2": ["2", 4], "closed": [], "closedMex": [7], "size": "10x10" },
        }))
        .expect("a map");
        let spec = map.spec.expect("the spec is read");
        assert_eq!(spec.team1_spawns, vec![1, 3]);
        assert_eq!(
            spec.team2_spawns,
            vec![2, 4],
            "a spawn number may arrive as a string"
        );
        assert_eq!(spec.closed_mex_spawns, vec![7]);
        assert_eq!(spec.size, "10x10");

        let body = map_spec_body(Some(&spec));
        assert_eq!(body["t1"], json!([1, 3]));
        assert_eq!(body["t2"], json!([2, 4]));
        assert_eq!(body["closed"], json!([]));
        assert_eq!(body["closedMex"], json!([7]));
        assert_eq!(body["size"], "10x10");
    }

    #[test]
    fn a_map_without_spawn_information_has_none_and_sends_none() {
        for spec in [json!(null), json!({}), json!({ "t1": [], "size": "" })] {
            let map = parse_map(&json!({ "id": "m", "name": "x", "spec": spec })).expect("a map");
            assert_eq!(
                map.spec, None,
                "an empty spec is no spec, as the service stores it"
            );
        }
        assert_eq!(map_spec_body(None), Value::Null);
    }

    #[test]
    fn the_record_cuts_come_from_the_plan() {
        let event = parse_tourney(&json!({
            "id": "e1",
            "bracketType": "swiss",
            "plan": { "bo": 3, "winCut": 3, "lossCut": "3" },
        }))
        .expect("a tournament");
        assert_eq!(event.swiss_cuts, SwissCuts { wins: 3, losses: 3 });
        assert_eq!(event.swiss_cuts.rounds(), Some(5), "3-2 is the longest run");

        let wins_only =
            parse_tourney(&json!({ "id": "e2", "plan": { "winCut": 4 } })).expect("a tournament");
        assert_eq!(wins_only.swiss_cuts.rounds(), Some(4));

        let out_of_range =
            parse_tourney(&json!({ "id": "e3", "plan": { "winCut": 99 } })).expect("a tournament");
        assert_eq!(out_of_range.swiss_cuts, SwissCuts::default());
        assert_eq!(out_of_range.swiss_cuts.rounds(), None);

        let no_plan = parse_tourney(&json!({ "id": "e4", "plan": null })).expect("a tournament");
        assert_eq!(no_plan.swiss_cuts.rounds(), None);
    }

    #[test]
    fn the_swiss_round_count_is_the_draws_then_the_plans() {
        let started = parse_tourney(&json!({
            "id": "e1",
            "cfg": { "rounds": 5, "bo": 3 },
            "plan": { "rounds": 4 },
        }))
        .expect("a tournament");
        assert_eq!(started.swiss_rounds, 5, "the draw's own count wins");

        let planned = parse_tourney(&json!({ "id": "e2", "cfg": null, "plan": { "rounds": 4 } }))
            .expect("a tournament");
        assert_eq!(planned.swiss_rounds, 4);

        let neither = parse_tourney(&json!({ "id": "e3" })).expect("a tournament");
        assert_eq!(neither.swiss_rounds, 0);
    }

    /// The Swiss table's order, tiebreak and numbers are the server's to give.
    #[test]
    fn the_swiss_order_and_its_tiebreak_are_read() {
        let event = parse_tourney(&json!({
            "id": "e1",
            "swissOrder": ["t2", "t1"],
            "tiebreak": "beaten",
            "swissSB": { "t1": 0, "t2": 3 },
        }))
        .expect("a tournament");
        assert_eq!(event.swiss_order, vec!["t2", "t1"]);
        assert_eq!(event.swiss_tiebreak, SwissTiebreak::Beaten);
        assert_eq!(event.swiss_beaten.get("t2"), Some(&3));

        let plain = parse_tourney(
            &json!({ "id": "e2", "swissOrder": null, "tiebreak": "gd", "swissSB": null }),
        )
        .expect("a tournament");
        assert!(plain.swiss_order.is_empty());
        assert_eq!(plain.swiss_tiebreak, SwissTiebreak::GameDiff);
        assert!(plain.swiss_beaten.is_empty());
    }

    /// A walkover names who forfeited, and drawn games keep their replays.
    #[test]
    fn a_match_carries_its_forfeit_and_its_drawn_replays() {
        let entry = parse_match(&json!({
            "id": "m1",
            "bracket": "wb",
            "round": 1,
            "team1": "t1",
            "team2": "t2",
            "score1": -1,
            "score2": 0,
            "status": "done",
            "forfeit": "t1",
            "replayIds": ["21534001"],
            "drawReplayIds": ["21534010"],
            "pendingReport": {
                "score1": 1, "score2": 0, "byTeam": "t2", "byName": "Ada",
                "replayIds": ["1"], "drawReplayIds": ["2"],
            },
        }))
        .expect("a match");
        assert_eq!(entry.forfeit.as_deref(), Some("t1"));
        assert_eq!(entry.draw_replay_ids, vec!["21534010"]);
        let pending = entry.pending_report.expect("a pending report");
        assert_eq!(pending.draw_replay_ids, vec!["2"]);
    }
}
