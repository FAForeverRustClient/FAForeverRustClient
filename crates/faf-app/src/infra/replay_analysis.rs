//! The whole of a replay file, read the way the Python client reads it.
//!
//! `replay.rs` next door reads the cheap half: the game's options, its chat and
//! its version, plus a count of the orders each client gave. This reads the
//! rest, which is what the analysis panel draws: every order with the unit it
//! named, every point on the map an order was aimed at, what the in-game notify
//! mod announced, and the statistics the simulation itself sends when the game
//! ends.
//!
//! ## Where the format comes from
//!
//! Not from guesswork. The layout of a command record is only discoverable by
//! walking it, and a field read at the wrong width desynchronises the rest of
//! the stream silently. Every offset here matches
//! `src/replays/replaydetails/replayreader.py` in FAForever/client, which is
//! the reference implementation, and the numbers this produces were checked
//! against that client's own output on the replay folder of this machine: 76
//! of the 79 files there, the other three being two-kilobyte stubs of games
//! that never started.
//!
//! ## What counts as an action
//!
//! The same thing the Python client counts, which is why the rates here match
//! the ones it prints. Only `IssueCommand` and `IssueFactoryCommand`, and only
//! once per tick per command type: one click that queues the same order onto a
//! group of units writes a record per unit, and that is one action. The rate is
//! then over the time up to that client's *last* order rather than over the
//! whole game, so a player who was killed at minute ten is measured over ten
//! minutes.

use std::collections::HashMap;
use std::io::{Cursor, Read};

use faf_domain::state::{
    ReplayActivity, ReplayAnalysis, ReplayArmy, ReplayGameOption, ReplayNotice, ReplayOrder,
    ReplayPlayerStats, ReplayPoint, ReplayResourceStat, ReplayScenario, ReplayTotals,
    ReplayUnitStat,
};
use serde_json::Value;

use crate::infra::replay::{parse_replay_lua, replay_string, replay_u32, replay_u8};

/// `CMDST_*`, the command stream's own opcodes.
const ADVANCE: u8 = 0;
const SET_COMMAND_SOURCE: u8 = 1;
const COMMAND_SOURCE_TERMINATED: u8 = 2;
const ISSUE_COMMAND: u8 = 12;
const ISSUE_FACTORY_COMMAND: u8 = 13;
const SET_COMMAND_TARGET: u8 = 16;
const LUA_SIM_CALLBACK: u8 = 22;

/// `STITARGET`: what a command's target field points at.
const TARGET_NONE: u8 = 0;
const TARGET_ENTITY: u8 = 1;
const TARGET_POSITION: u8 = 2;

/// `EUnitCommandType` has forty entries; this is the one the Python client
/// appends to the end of them for a target that was moved after the fact.
const MOVE_PREVIOUS_COMMAND: i32 = 40;

/// A ceiling on what one replay is allowed to put in the client's state.
///
/// A long game with a lot of players is a few hundred thousand orders. Past
/// this the panel would be drawing more than anybody can read and the webview
/// would be holding tens of megabytes, so the walk stops recording and the
/// counts, which are what the rates come from, carry on.
const MAX_RECORDED_ORDERS: usize = 200_000;
const MAX_RECORDED_POINTS: usize = 200_000;

/// The sentence the simulation wraps its end-of-game statistics in.
///
/// The whole record reads
/// `GpgNetSend with command 'JsonStats' and data '{"stats":[...]},'`: the
/// engine's own log line, forwarded as a moderator event. The Python client
/// slices it at a fixed offset; this looks for the braces, because the wrapper
/// is logging and not a format anybody promised to keep.
const JSON_STATS_MARKER: &str = "JsonStats";

/// Read one replay body into everything the analysis panel draws.
///
/// Never fails: a body that cannot be walked produces whatever was read before
/// the walk gave up, which for a truncated file is the header and nothing else.
/// The panel can say "no orders" on its own; it cannot do anything useful with
/// an error where a game's options would be.
pub fn analyse_replay_body(uid: i32, body: &[u8]) -> ReplayAnalysis {
    let mut cursor = Cursor::new(body);
    let game_version = replay_string(&mut cursor).unwrap_or_default();
    let mut analysis = ReplayAnalysis {
        uid,
        game_version,
        ..ReplayAnalysis::default()
    };

    let Some(header) = parse_header(&mut cursor) else {
        return analysis;
    };
    analysis.scenario = header.scenario;
    analysis.armies = header.armies;
    analysis.observers = header.observers;

    let walked = walk(&mut cursor, &analysis.armies);
    analysis.ticks = walked.ticks;
    analysis.orders = walked.orders;
    analysis.points = walked.points;
    analysis.notices = walked.notices;
    analysis.stats = walked.stats;
    analysis.activity = walked.activity;
    analysis
}

/// What the header carries, once the scenario and the army tables are read.
struct Header {
    scenario: ReplayScenario,
    armies: Vec<ReplayArmy>,
    observers: Vec<String>,
}

/// Walk the header, stopping at the first field that does not read.
///
/// The cursor is left at the start of the command stream on success. On
/// failure it is somewhere in the middle of the header and nothing else can be
/// read, which is why the caller returns what it has.
fn parse_header(cursor: &mut Cursor<&[u8]>) -> Option<Header> {
    // Three bytes of padding, then the version line, which carries the
    // scenario path after a CRLF.
    skip(cursor, 3)?;
    let version_line = replay_string(cursor)?;
    let scenario_path = version_line.split("\r\n").nth(1).unwrap_or("").to_string();
    skip(cursor, 4)?;

    let _mods_size = replay_u32(cursor)?;
    let _mods = parse_replay_lua(cursor, 0)?;
    let _scenario_size = replay_u32(cursor)?;
    let scenario_info = parse_replay_lua(cursor, 0)?;

    let source_count = replay_u8(cursor)?;
    // A client whose id is zero was watching rather than playing. The Python
    // client splits the table on exactly this.
    let mut sources: Vec<(String, bool)> = Vec::with_capacity(usize::from(source_count));
    for _ in 0..source_count {
        let name = replay_string(cursor)?;
        let id = replay_u32(cursor)?;
        sources.push((name, id == 0));
    }

    let _cheats_enabled = replay_u8(cursor)?;
    let army_count = replay_u8(cursor)?;
    let mut armies = Vec::with_capacity(usize::from(army_count));
    for _ in 0..army_count {
        let _army_size = replay_u32(cursor)?;
        let data = parse_replay_lua(cursor, 0)?;
        let source = replay_u8(cursor)?;
        if source != u8::MAX {
            skip(cursor, 1)?;
        }
        let Value::Object(fields) = data else {
            continue;
        };
        // The civilian armies every map carries are not players and have
        // nothing to show.
        if fields.get("Civilian").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        armies.push(army_from_lua(&fields, source));
    }
    let _random_seed = replay_u32(cursor);

    Some(Header {
        scenario: scenario_from_lua(scenario_info, &scenario_path),
        armies,
        observers: sources
            .into_iter()
            .filter_map(|(name, observing)| observing.then_some(name))
            .collect(),
    })
}

fn army_from_lua(fields: &serde_json::Map<String, Value>, source: u8) -> ReplayArmy {
    let number = |key: &str| fields.get(key).and_then(Value::as_f64);
    let text = |key: &str| {
        fields
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    // The displayed rating both reference clients compute, truncated rather
    // than rounded, so this client and they agree about the same player.
    let rating = match (number("MEAN"), number("DEV")) {
        (Some(mean), Some(deviation)) => {
            let value = mean - 3.0 * deviation;
            value.is_finite().then_some(value as i32)
        }
        _ => None,
    };
    ReplayArmy {
        source: if source == u8::MAX {
            -1
        } else {
            i32::from(source)
        },
        name: text("PlayerName"),
        army_name: text("ArmyName"),
        faction: number("Faction").unwrap_or_default() as i32,
        color: number("PlayerColor").unwrap_or_default() as i32,
        team: number("Team").unwrap_or_default() as i32,
        start_spot: number("StartSpot").unwrap_or_default() as i32,
        human: fields
            .get("Human")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        country: text("Country"),
        clan: text("PlayerClan"),
        rating,
    }
}

fn scenario_from_lua(info: Value, scenario_path: &str) -> ReplayScenario {
    let Value::Object(fields) = info else {
        return ReplayScenario {
            map_folder: map_folder_of(scenario_path),
            ..ReplayScenario::default()
        };
    };
    let text = |key: &str| {
        fields
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string()
    };
    // `size` is a Lua array, which arrives here as a table keyed by its own
    // indices: "1" and "2", or "1.0" and "2.0" depending on how the number was
    // written. Both spellings are tried rather than assumed.
    let size = |index: usize| -> i32 {
        let Some(Value::Object(size)) = fields.get("size") else {
            return 0;
        };
        size.get(&index.to_string())
            .or_else(|| size.get(&format!("{index}.0")))
            .and_then(Value::as_f64)
            .unwrap_or_default() as i32
    };
    let mut options = Vec::new();
    if let Some(Value::Object(map)) = fields.get("Options") {
        for (key, value) in map {
            if key == "ScenarioFile" || key == "Ratings" || key == "ReplayID" {
                continue;
            }
            options.push(ReplayGameOption {
                key: key.clone(),
                value: lua_scalar(value),
            });
        }
    }
    options.sort_by_key(|option| option.key.to_lowercase());
    ReplayScenario {
        name: text("name"),
        description: text("description"),
        map_folder: map_folder_of(scenario_path),
        width: size(1),
        height: size(2),
        options,
    }
}

/// `/maps/theta_passage_5/theta_passage_5_scenario.lua` -> `theta_passage_5`.
fn map_folder_of(scenario_path: &str) -> String {
    scenario_path
        .split('/')
        .nth(2)
        .unwrap_or_default()
        .to_lowercase()
}

fn lua_scalar(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.to_string(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// What one walk of the command stream produces.
struct Walked {
    ticks: u32,
    orders: Vec<ReplayOrder>,
    points: Vec<ReplayPoint>,
    notices: Vec<ReplayNotice>,
    stats: Vec<ReplayPlayerStats>,
    activity: Vec<ReplayActivity>,
}

fn walk(cursor: &mut Cursor<&[u8]>, armies: &[ReplayArmy]) -> Walked {
    let body = *cursor.get_ref();
    let len = body.len();
    let mut ticks: u32 = 0;
    let mut source: i32 = -1;
    let mut orders = Vec::new();
    let mut points = Vec::new();
    let mut notices = Vec::new();
    let mut stats: Vec<ReplayPlayerStats> = Vec::new();
    let mut command_ticks: HashMap<i32, Vec<u32>> = HashMap::new();
    let mut last_tick: HashMap<i32, u32> = HashMap::new();
    // The dedup key, per client: the same command type repeated back to back
    // on the same tick is one action, because the stream emits one record per
    // selected unit and a click onto forty engineers is one order. Kept per
    // source rather than for the stream as a whole -- a single `previous`
    // dropped a player's order whenever the client before them in the same
    // tick had just given the same kind, which took real orders off the count
    // and left the graph's axis below the read-out under it.
    let mut previous: HashMap<i32, (u32, i32)> = HashMap::new();

    while cursor.position() + 3 <= len as u64 {
        let Some(op) = replay_u8(cursor) else { break };
        let mut length = [0u8; 2];
        if Read::read_exact(cursor, &mut length).is_err() {
            break;
        }
        let record_len = u16::from_le_bytes(length) as usize;
        if record_len < 3 {
            break;
        }
        let start = cursor.position() as usize;
        let end = start + record_len - 3;
        if end > len {
            break;
        }
        let payload = &body[start..end];

        match op {
            ADVANCE => {
                if payload.len() >= 4 {
                    ticks = ticks.saturating_add(u32::from_le_bytes([
                        payload[0], payload[1], payload[2], payload[3],
                    ]));
                } else {
                    ticks = ticks.saturating_add(1);
                }
            }
            SET_COMMAND_SOURCE => {
                source = payload.first().map_or(-1, |index| i32::from(*index));
            }
            COMMAND_SOURCE_TERMINATED => {
                last_tick.insert(source, ticks);
            }
            SET_COMMAND_TARGET => {
                if let Some((x, y)) = retarget_position(payload) {
                    push_point(
                        &mut points,
                        ReplayPoint {
                            tick: ticks,
                            x,
                            y,
                            command: MOVE_PREVIOUS_COMMAND,
                            source,
                        },
                    );
                }
            }
            ISSUE_COMMAND | ISSUE_FACTORY_COMMAND => {
                if let Some(order) = parse_order(payload) {
                    if let Some((x, y)) = order.target {
                        push_point(
                            &mut points,
                            ReplayPoint {
                                tick: ticks,
                                x,
                                y,
                                command: order.command,
                                source,
                            },
                        );
                    }
                    if previous.insert(source, (ticks, order.command))
                        != Some((ticks, order.command))
                    {
                        command_ticks.entry(source).or_default().push(ticks);
                    }
                    if orders.len() < MAX_RECORDED_ORDERS {
                        orders.push(ReplayOrder {
                            source,
                            tick: ticks,
                            command: order.command,
                            blueprint: order.blueprint,
                            detail: order.detail,
                        });
                    }
                }
            }
            LUA_SIM_CALLBACK => {
                read_callback(payload, ticks, &mut notices, &mut stats);
            }
            _ => {}
        }
        cursor.set_position(end as u64);
    }

    // Observers give the handful of orders a camera makes; the Python client
    // drops them from the rates and so does this. An army with no client of
    // its own is an AI, which the stream never switches to.
    let playing: Vec<i32> = armies
        .iter()
        .map(|army| army.source)
        .filter(|source| *source >= 0)
        .collect();
    let mut activity: Vec<ReplayActivity> = playing
        .into_iter()
        .map(|source| {
            let ticks_for_source = command_ticks.remove(&source).unwrap_or_default();
            ReplayActivity {
                last_tick: ticks_for_source
                    .last()
                    .copied()
                    .or_else(|| last_tick.get(&source).copied())
                    .unwrap_or(ticks),
                source,
                command_ticks: ticks_for_source,
            }
        })
        .collect();
    activity.sort_by_key(|entry| entry.source);

    Walked {
        ticks,
        orders,
        points,
        notices,
        stats,
        activity,
    }
}

fn push_point(points: &mut Vec<ReplayPoint>, point: ReplayPoint) {
    if points.len() < MAX_RECORDED_POINTS {
        points.push(point);
    }
}

/// The position a `SetCommandTarget` record retargets to, where it has one.
fn retarget_position(payload: &[u8]) -> Option<(i32, i32)> {
    let mut cursor = Cursor::new(payload);
    let _command_id = replay_u32(&mut cursor)?;
    match replay_u8(&mut cursor)? {
        TARGET_POSITION => read_position(&mut cursor),
        _ => None,
    }
}

/// One order, as far as this client cares about it.
struct Order {
    command: i32,
    blueprint: String,
    detail: String,
    target: Option<(i32, i32)>,
}

/// Walk one `IssueCommand` record.
///
/// The field order is the engine's and every skip in it is load-bearing: the
/// unit list is counted in the first word and the two words after it are the
/// command id and its type tag, the formation is a sentinel followed by five
/// floats when it is not `-1`, and the blueprint is followed by twelve bytes
/// of zeroes before the enhancement table. Reading any of them at the wrong
/// width leaves the rest of this record as noise, which is why the caller
/// seeks to the record's own end rather than trusting where this finished.
fn parse_order(payload: &[u8]) -> Option<Order> {
    let mut cursor = Cursor::new(payload);
    let unit_count = replay_u32(&mut cursor)?;
    // The units the order was given to, then the command id and its tag.
    skip(&mut cursor, 4 * (u64::from(unit_count) + 2))?;
    let command = i32::from(replay_u8(&mut cursor)?);
    skip(&mut cursor, 4)?;
    let target = match replay_u8(&mut cursor)? {
        TARGET_POSITION => read_position(&mut cursor),
        TARGET_ENTITY => {
            replay_u32(&mut cursor)?;
            None
        }
        TARGET_NONE => None,
        // Anything else means this record is not laid out the way it should
        // be, and reading on would be reading noise.
        _ => return None,
    };
    skip(&mut cursor, 1)?;
    let formation = replay_u32(&mut cursor)?;
    if formation != u32::MAX {
        skip(&mut cursor, 4 * 5)?;
    }
    let blueprint = replay_string(&mut cursor)?;
    skip(&mut cursor, 12)?;
    let upgrades = parse_replay_lua(&mut cursor, 0);
    // A script order carries what it is doing in this table: an ACU
    // enhancement, or the name of the task for everything else.
    let detail = match &upgrades {
        Some(Value::Object(fields)) => fields
            .get("Enhancement")
            .or_else(|| fields.get("TaskName"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        _ => String::new(),
    };

    Some(Order {
        command,
        blueprint,
        detail,
        target,
    })
}

/// A world position: three floats, of which the middle one is the height.
fn read_position(cursor: &mut Cursor<&[u8]>) -> Option<(i32, i32)> {
    let x = read_f32(cursor)?;
    let _height = read_f32(cursor)?;
    let z = read_f32(cursor)?;
    (x.is_finite() && z.is_finite()).then_some((x.round() as i32, z.round() as i32))
}

fn read_f32(cursor: &mut Cursor<&[u8]>) -> Option<f32> {
    let mut bytes = [0u8; 4];
    Read::read_exact(cursor, &mut bytes).ok()?;
    Some(f32::from_le_bytes(bytes))
}

fn skip(cursor: &mut Cursor<&[u8]>, count: u64) -> Option<()> {
    let next = cursor.position().saturating_add(count);
    (next <= cursor.get_ref().len() as u64).then(|| cursor.set_position(next))
}

/// The two callbacks this client reads: the notify channel, and the statistics
/// the simulation sends once when the game ends.
fn read_callback(
    payload: &[u8],
    ticks: u32,
    notices: &mut Vec<ReplayNotice>,
    stats: &mut Vec<ReplayPlayerStats>,
) {
    let mut cursor = Cursor::new(payload);
    let Some(function) = replay_string(&mut cursor) else {
        return;
    };
    let Some(Value::Object(args)) = parse_replay_lua(&mut cursor, 0) else {
        return;
    };

    if function == "ModeratorEvent" {
        if !stats.is_empty() {
            return;
        }
        let Some(message) = args.get("Message").and_then(Value::as_str) else {
            return;
        };
        if !message.contains(JSON_STATS_MARKER) {
            return;
        }
        // Found by its braces rather than by counting characters off the
        // sentence: the wrapper is the simulation's own logging, and the
        // payload is the only thing in it with a brace in front of it.
        let (Some(opened), Some(closed)) = (message.find('{'), message.rfind('}')) else {
            return;
        };
        if opened >= closed {
            return;
        }
        if let Ok(parsed) = serde_json::from_str::<Value>(&message[opened..=closed]) {
            *stats = player_stats(&parsed);
        }
        return;
    }

    if function != "GiveResourcesToPlayer" {
        return;
    }
    let Some(Value::Object(message)) = args.get("Msg").or_else(|| args.get("msg")) else {
        return;
    };
    // Only the notify channel. Ordinary chat is read by `replay.rs`, which
    // folds the copies of one typed line together; these are announcements the
    // in-game mod makes and there is exactly one of each.
    if message.get("to").and_then(Value::as_str) != Some("notify") {
        return;
    }
    let Some(text) = message.get("text").and_then(Value::as_str) else {
        return;
    };
    // `From` is one-based, and an observer is zero.
    let source = args
        .get("From")
        .and_then(Value::as_f64)
        .map(|value| value as i32 - 1)
        .unwrap_or(-1);
    notices.push(ReplayNotice {
        tick: ticks,
        source,
        text: text.to_string(),
    });
}

/// The `JsonStats` payload, one entry per player.
fn player_stats(parsed: &Value) -> Vec<ReplayPlayerStats> {
    let Some(players) = parsed.get("stats").and_then(Value::as_array) else {
        return Vec::new();
    };
    players
        .iter()
        .filter_map(|player| {
            let general = player.get("general")?;
            Some(ReplayPlayerStats {
                name: string_at(player, "name"),
                faction: number_at(player, "faction") as i32,
                kind: string_at(player, "type"),
                // Absent for a player who was still alive, and a tick for one
                // who was not.
                defeated: !player
                    .get("Defeated")
                    .or_else(|| player.get("defeated"))
                    .unwrap_or(&Value::Null)
                    .is_null(),
                score: whole(number_at(general, "score")),
                built: totals_at(general, "built"),
                lost: totals_at(general, "lost"),
                kills: totals_at(general, "kills"),
                units: player
                    .get("units")
                    .and_then(Value::as_object)
                    .map(|units| {
                        let mut list: Vec<ReplayUnitStat> = units
                            .iter()
                            .map(|(category, stat)| ReplayUnitStat {
                                category: category.clone(),
                                built: whole(number_at(stat, "built")),
                                lost: whole(number_at(stat, "lost")),
                                kills: whole(number_at(stat, "kills")),
                            })
                            .collect();
                        list.sort_by(|left, right| left.category.cmp(&right.category));
                        list
                    })
                    .unwrap_or_default(),
                resources: player
                    .get("resources")
                    .and_then(Value::as_object)
                    .map(|resources| {
                        let mut list: Vec<ReplayResourceStat> = resources
                            .iter()
                            .map(|(resource, flow)| ReplayResourceStat {
                                resource: resource.clone(),
                                total: whole(number_at(flow, "total")),
                                reclaimed: whole(number_at(flow, "reclaimed")),
                                excess: whole(number_at(flow, "excess")),
                            })
                            .collect();
                        list.sort_by(|left, right| left.resource.cmp(&right.resource));
                        list
                    })
                    .unwrap_or_default(),
            })
        })
        .collect()
}

fn totals_at(value: &Value, key: &str) -> ReplayTotals {
    let Some(totals) = value.get(key) else {
        return ReplayTotals::default();
    };
    ReplayTotals {
        mass: whole(number_at(totals, "mass")),
        energy: whole(number_at(totals, "energy")),
        count: whole(number_at(totals, "count")),
    }
}

/// A statistic as a whole number.
///
/// `as` saturates rather than wrapping, so a value past what an `i32` holds
/// clamps to the end of the range instead of turning negative. Nothing the
/// simulation reports comes near it; a corrupted payload might.
fn whole(value: f64) -> i32 {
    if value.is_finite() {
        value.round() as i32
    } else {
        0
    }
}

fn number_at(value: &Value, key: &str) -> f64 {
    value.get(key).and_then(Value::as_f64).unwrap_or_default()
}

fn string_at(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}
#[cfg(test)]
mod tests {
    use super::*;

    /// One record: the opcode, a little-endian u16 covering the whole record,
    /// and the payload.
    fn record(op: u8, payload: Vec<u8>) -> Vec<u8> {
        let mut out = vec![op];
        out.extend_from_slice(&((payload.len() + 3) as u16).to_le_bytes());
        out.extend_from_slice(&payload);
        out
    }

    fn advance(ticks: u32) -> Vec<u8> {
        record(ADVANCE, ticks.to_le_bytes().to_vec())
    }

    fn source(index: u8) -> Vec<u8> {
        record(SET_COMMAND_SOURCE, vec![index])
    }

    fn lua_string(value: &str) -> Vec<u8> {
        let mut bytes = vec![1];
        bytes.extend_from_slice(value.as_bytes());
        bytes.push(0);
        bytes
    }

    fn lua_number(value: f32) -> Vec<u8> {
        let mut bytes = vec![0];
        bytes.extend_from_slice(&value.to_le_bytes());
        bytes
    }

    fn lua_table(entries: &[(&str, Vec<u8>)]) -> Vec<u8> {
        let mut out = vec![4u8];
        for (key, value) in entries {
            out.extend_from_slice(&lua_string(key));
            out.extend_from_slice(value);
        }
        out.push(5);
        out
    }

    /// An `IssueCommand` record, laid out the way the engine writes one.
    fn order(command: u8, blueprint: &str, target: Option<(f32, f32)>) -> Vec<u8> {
        let mut payload = 1u32.to_le_bytes().to_vec(); // one unit
        payload.extend_from_slice(&[0; 4 * 3]); // the unit, then two words
        payload.push(command);
        payload.extend_from_slice(&[0; 4]);
        match target {
            Some((x, y)) => {
                payload.push(TARGET_POSITION);
                payload.extend_from_slice(&x.to_le_bytes());
                payload.extend_from_slice(&0f32.to_le_bytes());
                payload.extend_from_slice(&y.to_le_bytes());
            }
            None => payload.push(TARGET_NONE),
        }
        payload.push(0);
        payload.extend_from_slice(&u32::MAX.to_le_bytes()); // no formation
        payload.extend_from_slice(blueprint.as_bytes());
        payload.push(0);
        payload.extend_from_slice(&[0; 12]);
        payload.extend_from_slice(&lua_table(&[]));
        record(ISSUE_COMMAND, payload)
    }

    fn callback(function: &str, args: Vec<u8>) -> Vec<u8> {
        let mut payload = lua_string(function);
        // The function name is written as a bare string here, not as a Lua
        // value: the record is a name followed by the argument table.
        payload.drain(0..1);
        payload.extend_from_slice(&args);
        record(LUA_SIM_CALLBACK, payload)
    }

    fn notify(text: &str, from: f32) -> Vec<u8> {
        callback(
            "GiveResourcesToPlayer",
            lua_table(&[
                ("From", lua_number(from)),
                (
                    "Msg",
                    lua_table(&[("to", lua_string("notify")), ("text", lua_string(text))]),
                ),
            ]),
        )
    }

    fn walked(stream: &[u8], sources: &[i32]) -> Walked {
        let armies: Vec<ReplayArmy> = sources
            .iter()
            .map(|source| ReplayArmy {
                source: *source,
                name: format!("player{source}"),
                army_name: String::new(),
                faction: 1,
                color: 1,
                team: 2,
                start_spot: 1,
                human: true,
                country: String::new(),
                clan: String::new(),
                rating: None,
            })
            .collect();
        let mut cursor = Cursor::new(stream);
        walk(&mut cursor, &armies)
    }

    #[test]
    fn an_order_records_what_it_was_and_where_it_was_aimed() {
        let mut stream = source(0);
        stream.extend_from_slice(&advance(30));
        stream.extend_from_slice(&order(8, "uel0201", Some((128.0, 64.5))));

        let out = walked(&stream, &[0]);
        assert_eq!(out.orders.len(), 1);
        assert_eq!(out.orders[0].command, 8);
        assert_eq!(out.orders[0].blueprint, "uel0201");
        assert_eq!(out.orders[0].tick, 30);
        // Rounded, because no heatmap bin is small enough for the fraction.
        assert_eq!(
            out.points,
            vec![ReplayPoint {
                tick: 30,
                x: 128,
                y: 65,
                command: 8,
                source: 0,
            }]
        );
    }

    #[test]
    fn the_same_order_on_the_same_tick_is_one_action() {
        // One click onto a group of units writes a record per unit. The
        // Python client counts that once and so does this, which is what
        // makes the two agree about a player's rate.
        let mut stream = source(0);
        stream.extend_from_slice(&order(2, "", None));
        stream.extend_from_slice(&order(2, "", None));
        stream.extend_from_slice(&order(2, "", None));
        stream.extend_from_slice(&advance(10));
        stream.extend_from_slice(&order(2, "", None));

        let out = walked(&stream, &[0]);
        assert_eq!(out.orders.len(), 4, "every order is still listed");
        assert_eq!(out.activity[0].command_ticks, vec![0, 10]);
    }

    #[test]
    fn a_different_order_on_the_same_tick_counts_again() {
        let mut stream = source(0);
        stream.extend_from_slice(&order(2, "", None));
        stream.extend_from_slice(&order(8, "uel0105", None));

        assert_eq!(walked(&stream, &[0]).activity[0].command_ticks, vec![0, 0]);
    }

    #[test]
    fn two_clients_giving_the_same_order_on_one_tick_both_count() {
        // The run is per client. Sharing one across the stream dropped the
        // second player's order whenever the first had just given the same
        // kind on the same tick, which is what left the activity numbers
        // under the graph above what the graph itself drew.
        let mut stream = source(0);
        stream.extend_from_slice(&order(2, "", None));
        stream.extend_from_slice(&source(1));
        stream.extend_from_slice(&order(2, "", None));

        let out = walked(&stream, &[0, 1]);
        assert_eq!(out.activity[0].command_ticks, vec![0]);
        assert_eq!(out.activity[1].command_ticks, vec![0]);
    }

    #[test]
    fn a_player_is_measured_up_to_their_own_last_order() {
        // Not over the whole game: somebody killed at minute ten did nothing
        // for the thirty minutes after it, and dividing by forty would say
        // they were four times slower than they were.
        let mut stream = source(0);
        stream.extend_from_slice(&advance(600));
        stream.extend_from_slice(&order(2, "", None));
        stream.extend_from_slice(&advance(6_000));

        let out = walked(&stream, &[0]);
        assert_eq!(out.ticks, 6_600);
        assert_eq!(out.activity[0].last_tick, 600);
    }

    #[test]
    fn a_client_that_gave_no_orders_falls_back_to_when_it_left() {
        let mut stream = source(0);
        stream.extend_from_slice(&advance(900));
        stream.extend_from_slice(&record(COMMAND_SOURCE_TERMINATED, Vec::new()));
        stream.extend_from_slice(&advance(100));

        let out = walked(&stream, &[0]);
        assert!(out.activity[0].command_ticks.is_empty());
        assert_eq!(out.activity[0].last_tick, 900);
    }

    #[test]
    fn the_notify_channel_is_kept_and_ordinary_chat_is_not() {
        // Chat is read next door, where the copies of one typed line are
        // folded together. What is wanted here is the other thing that comes
        // through this callback: the in-game mod announcing an upgrade.
        let mut stream = source(0);
        stream.extend_from_slice(&advance(120));
        stream.extend_from_slice(&notify("Tech 2 done!", 1.0));
        stream.extend_from_slice(&callback(
            "GiveResourcesToPlayer",
            lua_table(&[
                ("From", lua_number(1.0)),
                (
                    "Msg",
                    lua_table(&[("to", lua_string("all")), ("text", lua_string("gg"))]),
                ),
            ]),
        ));

        let out = walked(&stream, &[0]);
        assert_eq!(out.notices.len(), 1);
        assert_eq!(out.notices[0].text, "Tech 2 done!");
        assert_eq!(out.notices[0].tick, 120);
        // `From` is one-based, and this is the index the armies carry.
        assert_eq!(out.notices[0].source, 0);
    }

    #[test]
    fn the_simulations_own_statistics_are_read_out_of_the_moderator_event() {
        let message = "GpgNetSend with command 'JsonStats' and data '".to_string()
            + r#"{"stats":[{"name":"Vindex","faction":2,"type":"Human","Defeated":3120,"#
            + r#""general":{"score":2048,"built":{"mass":500,"energy":9000,"count":40},"#
            + r#""lost":{"mass":100,"energy":10,"count":4},"#
            + r#""kills":{"mass":7,"energy":8,"count":9}},"#
            + r#""units":{"land":{"built":12,"lost":3,"kills":4}},"#
            + r#""resources":{"massin":{"total":900,"reclaimed":30},"#
            + r#""massout":{"total":880,"excess":12}}}]},'"#;
        let stream = callback(
            "ModeratorEvent",
            lua_table(&[("Message", lua_string(&message))]),
        );

        let out = walked(&stream, &[]);
        assert_eq!(out.stats.len(), 1);
        let player = &out.stats[0];
        assert_eq!(player.name, "Vindex");
        assert_eq!(player.score, 2_048);
        assert!(player.defeated);
        assert_eq!(player.built.mass, 500);
        assert_eq!(player.units[0].category, "land");
        assert_eq!(player.units[0].built, 12);
        // Sorted by name, so "massin" comes before "massout" whatever order
        // the payload listed them in.
        assert_eq!(player.resources[0].resource, "massin");
        assert_eq!(player.resources[0].reclaimed, 30);
        assert_eq!(player.resources[1].excess, 12);
    }

    #[test]
    fn a_truncated_body_gives_back_what_was_read_before_it_ran_out() {
        // The three files in the sample folder that fail are two-kilobyte
        // stubs of games that never started. Nothing can be read out of them
        // and nothing should be thrown.
        let analysis = analyse_replay_body(7, &[0u8; 64]);
        assert_eq!(analysis.uid, 7);
        assert!(analysis.armies.is_empty());
        assert_eq!(analysis.ticks, 0);
    }
}
