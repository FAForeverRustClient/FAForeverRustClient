//! Replay details: the game options, in-game chat and per-player command counts
//! a whole `.scfareplay` body yields once the user asks for them.
//!
//! Separate from the header reader because this walks past the header into
//! the command stream, the largest thing in a replay, and the chat in that
//! stream is a subject of its own with its own rules for what one line is.

use std::io::{Cursor, Read};
use std::path::Path;

use faf_domain::state::{ReplayChatMessage, ReplayCommandStats, ReplayDetails, ReplayGameOption};
use serde_json::Value;

use super::codec::read_replay_header_and_body;
use super::library::local_sim_mods;
use super::scfa_header::{
    game_version_from_string, parse_replay_lua, replay_string, replay_u32, replay_u8,
    skip_replay_bytes,
};

pub(super) async fn read_detailed_info(path: &Path) -> Result<ReplayDetails, String> {
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || {
        let (header, body_bytes) = read_replay_header_and_body(&path)?;
        let mut details = parse_detailed_info_from_body(&body_bytes);
        details.sim_mods = header.as_ref().map(local_sim_mods).unwrap_or_default();
        Ok(details)
    })
    .await
    .map_err(|error| format!("could not parse replay details: {error}"))?
}

pub fn parse_detailed_info_from_body(body: &[u8]) -> ReplayDetails {
    let mut cursor = Cursor::new(body);
    let game_version = game_version_from_string(replay_string(&mut cursor).as_deref());
    if !skip_replay_bytes(&mut cursor, 3) {
        return replay_details_with_version(game_version);
    }
    let _raw_map = replay_string(&mut cursor);
    if !skip_replay_bytes(&mut cursor, 4) {
        return replay_details_with_version(game_version);
    }
    let Some(_) = replay_u32(&mut cursor) else {
        return replay_details_with_version(game_version);
    };
    if parse_replay_lua(&mut cursor, 0).is_none() {
        return replay_details_with_version(game_version);
    }
    let Some(_) = replay_u32(&mut cursor) else {
        return replay_details_with_version(game_version);
    };
    let game_options_lua = parse_replay_lua(&mut cursor, 0);

    let Some(source_count) = replay_u8(&mut cursor) else {
        return ReplayDetails {
            game_options: extract_game_options(game_options_lua.as_ref(), game_version),
            chat_messages: Vec::new(),
            command_stats: Vec::new(),
            sim_seconds: 0,
            sim_mods: Vec::new(),
            game_version,
        };
    };

    // The army table below is walked only to reach the command stream behind
    // it. The source table is read: the stream names nobody, it switches
    // between numbered command sources, and this is the table those numbers
    // index into.
    //
    // Chat is a separate question and is not answered here. It used to be
    // attributed from this roster, by way of the army index in the callback;
    // that index is the recipient, not the sender, so the roster has nothing
    // to say about who typed what.
    let mut sources: Vec<String> = Vec::with_capacity(usize::from(source_count));
    for _ in 0..source_count {
        let Some(name) = replay_string(&mut cursor) else {
            break;
        };
        if replay_u32(&mut cursor).is_none() {
            break;
        }
        sources.push(name);
    }
    let _ = replay_u8(&mut cursor);
    let army_count = replay_u8(&mut cursor).unwrap_or(0);

    for _ in 0..army_count {
        if replay_u32(&mut cursor).is_none() {
            break;
        }
        if !matches!(parse_replay_lua(&mut cursor, 0), Some(Value::Object(_))) {
            break;
        }
        let Some(source) = replay_u8(&mut cursor) else {
            break;
        };
        if source != u8::MAX {
            let _ = replay_u8(&mut cursor);
        }
    }

    skip_replay_bytes(&mut cursor, 4);

    let game_options = extract_game_options(game_options_lua.as_ref(), game_version);
    let stream = walk_command_stream(&mut cursor, &sources);

    ReplayDetails {
        game_options,
        chat_messages: stream.chat_messages,
        command_stats: stream.command_stats,
        sim_seconds: stream.ticks / TICKS_PER_SECOND,
        // Filled in by the caller, which is the only place that has seen the
        // `.fafreplay` header this body was unwrapped from.
        sim_mods: Vec::new(),
        game_version,
    }
}

fn replay_details_with_version(game_version: Option<i32>) -> ReplayDetails {
    ReplayDetails {
        game_options: extract_game_options(None, game_version),
        chat_messages: Vec::new(),
        command_stats: Vec::new(),
        sim_seconds: 0,
        sim_mods: Vec::new(),
        game_version,
    }
}

fn extract_game_options(
    game_options_lua: Option<&Value>,
    game_version: Option<i32>,
) -> Vec<ReplayGameOption> {
    let mut options = Vec::new();
    if let Some(v) = game_version {
        options.push(ReplayGameOption {
            key: "FAF Version".to_string(),
            value: v.to_string(),
        });
    }

    let mut collect_options = |map: &serde_json::Map<String, Value>| {
        for (k, v) in map {
            if k == "ScenarioFile" || k == "Options" {
                continue;
            }
            let val_str = match v {
                Value::String(s) => s.clone(),
                Value::Bool(b) => {
                    if *b {
                        "true".to_string()
                    } else {
                        "false".to_string()
                    }
                }
                Value::Number(n) => n.to_string(),
                Value::Null => "null".to_string(),
                Value::Array(_) | Value::Object(_) => format!("{v}"),
            };
            options.push(ReplayGameOption {
                key: k.clone(),
                value: val_str,
            });
        }
    };

    if let Some(Value::Object(top_map)) = game_options_lua {
        if let Some(Value::Object(nested)) = top_map.get("Options") {
            collect_options(nested);
        } else {
            collect_options(top_map);
        }
    }

    options.sort_by_key(|a| a.key.to_lowercase());
    options
}

/// One chat record as the command stream carries it, before the copies of a
/// single typed line are folded together.
struct ChatRecord {
    time_seconds: u32,
    /// The channel: `all`, `allies`, or an army number for a whisper.
    to: String,
    /// `None` where the record carries no name at all. That is the case the
    /// report was about: it reached the UI as the literal "Unknown", sitting
    /// under the named copy of the same line.
    sender: Option<String>,
    /// `Msg.Id`, where the build sends one. Two records carrying the same one
    /// are the same typed line; two carrying different ones may still be.
    id: Option<String>,
    message: String,
}

/// The simulation's own clock: ten ticks to the second, which is what turns a
/// tick count into game time and a command count into a rate.
const TICKS_PER_SECOND: u32 = 10;

/// One command source's turn at the stream. `CMDST_SET_COMMAND_SOURCE`, which
/// carries the index of the client whose orders follow it.
const CMDST_SET_COMMAND_SOURCE: u8 = 1;
/// `CMDST_ADVANCE`, which carries how many ticks the simulation moved on.
const CMDST_ADVANCE: u8 = 0;
/// The span of command types that are a player giving an order: issue, issue
/// to a factory, raise or lower a repeat count, retarget, retype, set the
/// cells of an area order, and take one back off the queue.
///
/// Everything outside it is the engine talking to itself: the clock, the
/// checksums it compares, the info pairs it records, and the Lua callbacks a
/// UI mod can fire on every tick of every game. Counting those would rank the
/// mods people run rather than the players running them: one game in the
/// sample folder had twelve thousand callbacks per client against fifteen
/// hundred orders.
const PLAYER_ORDER_COMMANDS: std::ops::RangeInclusive<u8> = 12..=19;

/// What one pass over the command stream produces.
struct CommandStream {
    chat_messages: Vec<ReplayChatMessage>,
    command_stats: Vec<ReplayCommandStats>,
    /// Simulation ticks the stream covers.
    ticks: u32,
}

/// Walk the command stream once, for the chat in it and the orders in it.
///
/// One pass rather than two, because the stream is the largest thing in a
/// replay file (a twenty-minute eight-player game is a quarter of a million
/// records) and both answers fall out of the same walk.
///
/// The chat half is the subtle one; it is documented at `fold_chat_record`
/// below, and the shape of a record at `try_parse_chat_payload`.
///
/// The orders half is simple arithmetic: the stream is a sequence of records
/// prefixed by whose they are, so counting them per source and dividing by the
/// game time gives the commands-per-minute the thread asked for. Its one
/// judgement call is which records count, which is `PLAYER_ORDER_COMMANDS`.
fn walk_command_stream(cursor: &mut Cursor<&[u8]>, sources: &[String]) -> CommandStream {
    let mut current_ticks: u32 = 0;
    let mut records: Vec<ChatRecord> = Vec::new();
    let mut counts: Vec<u32> = vec![0; sources.len()];
    let mut current_source: Option<usize> = None;
    let body = *cursor.get_ref();
    let len = body.len();

    while (cursor.position() + 3) <= len as u64 {
        let Some(cmd_type) = replay_u8(cursor) else {
            break;
        };
        let mut len_bytes = [0u8; 2];
        if Read::read_exact(cursor, &mut len_bytes).is_err() {
            break;
        }
        let cmd_len = u16::from_le_bytes(len_bytes) as usize;
        if cmd_len < 3 {
            break;
        }
        let payload_len = cmd_len - 3;
        let pos = cursor.position() as usize;
        if pos + payload_len > len {
            break;
        }
        let payload = &body[pos..pos + payload_len];
        cursor.set_position((pos + payload_len) as u64);

        if cmd_type == CMDST_ADVANCE {
            if payload.len() >= 4 {
                let ticks = u32::from_le_bytes([payload[0], payload[1], payload[2], payload[3]]);
                current_ticks = current_ticks.saturating_add(ticks);
            } else {
                current_ticks = current_ticks.saturating_add(1);
            }
        } else if cmd_type == CMDST_SET_COMMAND_SOURCE {
            current_source = payload.first().map(|index| usize::from(*index));
        } else if PLAYER_ORDER_COMMANDS.contains(&cmd_type) {
            if let Some(count) = current_source.and_then(|index| counts.get_mut(index)) {
                *count = count.saturating_add(1);
            }
        } else if cmd_type == 22 || cmd_type == 0x20 || cmd_type == 0x22 {
            // 22 (0x16) is CMDST_LuaSimCallback in Forged Alliance
            if let Some(record) = try_parse_chat_payload(payload, current_ticks / TICKS_PER_SECOND)
            {
                fold_chat_record(&mut records, record);
            }
        }
    }

    CommandStream {
        chat_messages: records
            .into_iter()
            .map(|record| ReplayChatMessage {
                time_seconds: record.time_seconds,
                sender: record.sender.unwrap_or_else(|| "Unknown".to_string()),
                message: record.message,
                to: record.to,
            })
            .collect(),
        command_stats: sources
            .iter()
            .zip(counts)
            .map(|(player, commands)| ReplayCommandStats {
                player: player.clone(),
                commands,
            })
            .collect(),
        ticks: current_ticks,
    }
}

/// In-game chat, from the command stream.
///
/// The game does not send chat as chat. It smuggles it through a
/// `GiveResourcesToPlayer` sim callback carrying no resources and a `Msg`
/// table, and it sends that callback more than once for a single typed line:
///
/// * once per recipient army, each carrying `Sender`, the name of whoever
///   typed it, and `To`/`From` set to the army it is being delivered *to*;
/// * once more, on some builds, as the origination record: `Msg` alone, with
///   no `Sender`, no `To` and no `From`;
/// * once more again, for a whisper, as an echo back to its author, where
///   `Msg.echo` is set, `Msg.from` is the author and the top-level `Sender` is
///   the player the whisper went to.
///
/// Both halves of the reported bug follow from that. Every line appeared twice
/// because the copies disagree about the sender, and one of the two said
/// "Unknown" because the origination record has nobody to name.
/// Add one record, or recognise it as another copy of one already held.
///
/// Two seconds of slack, because the copies of a line are not always recorded
/// on the same tick. Only that window is searched: `time_seconds` never
/// decreases, so the first record outside it ends the search.
///
/// What counts as the same line:
///
/// * the same `Msg.Id`, where the build sends one;
/// * the same text from the same named sender, which is the copy-per-recipient
///   case;
/// * the same text where one of the two has no sender, which is the
///   origination record meeting its delivery. The named one wins: whichever
///   order the two arrive in, the name is kept and the copy is dropped.
///
/// Matching ids settle it, but differing ids settle nothing and the text is
/// still asked. An id reads `"<tick> table: <address>"`, and a line sent to
/// several recipients is a fresh table each time, so the copies of one line
/// agree on the tick and disagree on the address.
///
/// The sender stays part of the key for two *named* records. Eight people
/// typing "gg" at the end of a game are eight messages within the same two
/// seconds, and collapsing those would be a worse bug than the one being fixed.
fn fold_chat_record(records: &mut Vec<ChatRecord>, record: ChatRecord) {
    let mut duplicate_of: Option<usize> = None;
    for index in (0..records.len()).rev() {
        let seen = &records[index];
        if record.time_seconds > seen.time_seconds.saturating_add(2) {
            break;
        }
        let same_id = match (&seen.id, &record.id) {
            (Some(seen_id), Some(new_id)) => seen_id == new_id,
            _ => false,
        };
        let same_line = same_id
            || (seen.message == record.message
                && match (&seen.sender, &record.sender) {
                    (Some(held), Some(incoming)) => held == incoming,
                    // One of the two is the origination record.
                    _ => true,
                });
        if same_line {
            duplicate_of = Some(index);
            break;
        }
    }

    match duplicate_of {
        Some(index) => {
            if records[index].sender.is_none() {
                records[index].sender = record.sender;
            }
        }
        None => records.push(record),
    }
}

fn try_parse_chat_payload(payload: &[u8], time_seconds: u32) -> Option<ChatRecord> {
    let mut p_cursor = Cursor::new(payload);
    let _func = replay_string(&mut p_cursor)?;

    let lua_val = parse_replay_lua(&mut p_cursor, 0)?;
    let Value::Object(args) = lua_val else {
        return None;
    };

    let nested = args
        .get("Msg")
        .or_else(|| args.get("msg"))
        .and_then(|value| match value {
            Value::Object(map) => Some(map),
            _ => None,
        });

    let message_text = match nested {
        Some(msg_map) => msg_map
            .get("text")
            .or_else(|| msg_map.get("Text"))
            .or_else(|| msg_map.get("msg")),
        None => args
            .get("Msg")
            .or_else(|| args.get("msg"))
            .or_else(|| args.get("text"))
            .or_else(|| args.get("Text")),
    };
    let Some(Value::String(text)) = message_text else {
        return None;
    };
    if text.trim().is_empty() {
        return None;
    }

    // `to` is the channel: "all", "allies", or the army index a whisper went
    // to. "notify" is not a channel anybody types into. It is the Notify UI
    // mod announcing its own upgrades ("Starting Tech 2 Land HQ upgrade")
    // through the same callback, and until now the announcements were listed
    // as though a player had said them.
    if nested
        .and_then(|msg_map| msg_map.get("to"))
        .and_then(Value::as_str)
        .is_some_and(|channel| channel.eq_ignore_ascii_case("notify"))
    {
        return None;
    }

    Some(ChatRecord {
        time_seconds,
        to: nested
            .and_then(|msg_map| msg_map.get("to"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        sender: chat_sender(&args, nested),
        id: nested
            .and_then(|msg_map| msg_map.get("Id"))
            .and_then(Value::as_str)
            .map(str::to_string),
        message: text.clone(),
    })
}

/// Who typed it, or `None` where the record does not say.
///
/// `Msg.from` is asked first and the top-level `Sender` second, which is the
/// one ordering that survives every shape the game sends. Where both are
/// present on an ordinary message they agree. Where they disagree the record
/// is a whisper echoed back to its author: there `Sender` is the player the
/// whisper was aimed at, and `Msg.from` is the author.
///
/// There is deliberately no fall-back to an army index. `From`, `To` and
/// `Army` all name the army a copy is being *delivered to*, so reading any of
/// them as the sender does not rescue a nameless record, it misattributes a
/// named one.
fn chat_sender(
    args: &serde_json::Map<String, Value>,
    nested: Option<&serde_json::Map<String, Value>>,
) -> Option<String> {
    let nested_value = |key: &str| nested.and_then(|map| map.get(key));
    [
        nested_value("from"),
        nested_value("Sender"),
        nested_value("sender"),
        args.get("Sender"),
        args.get("sender"),
        args.get("PlayerName"),
        args.get("playerName"),
    ]
    .into_iter()
    .flatten()
    .find_map(|value| match value {
        Value::String(name) if !name.trim().is_empty() => Some(name.clone()),
        _ => None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infra::replay::test_support::{lua_number, lua_string};

    #[tokio::test]
    async fn test_parse_detailed_replay_from_test_file() {
        let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let workspace_root = manifest_dir.parent().unwrap().parent().unwrap();
        let test_file =
            workspace_root.join("context/java_client/src/test/resources/replay/test.fafreplay");
        if !test_file.exists() {
            return;
        }

        let details = read_detailed_info(&test_file)
            .await
            .expect("should parse details");
        assert!(
            !details.game_options.is_empty(),
            "game options should not be empty"
        );
        let version_opt = details.game_options.iter().find(|o| o.key == "FAF Version");
        assert!(version_opt.is_some(), "FAF Version should be present");
        assert_eq!(version_opt.unwrap().value, "3675");
        assert_eq!(details.game_version, Some(3675));

        println!(
            "Chat messages count in test.fafreplay: {}",
            details.chat_messages.len()
        );
        for msg in &details.chat_messages {
            println!(
                "Chat: [{}] {}: {}",
                msg.time_seconds, msg.sender, msg.message
            );
        }

        // Verify common options are present
        let allow_observers = details
            .game_options
            .iter()
            .find(|o| o.key == "AllowObservers");
        assert!(allow_observers.is_some());

        assert!(
            !details.chat_messages.is_empty(),
            "the detail parser should retain recorded in-game chat"
        );
    }
    // ── In-game chat out of a replay's command stream ───────────────────────
    //
    // Built rather than fixtured. The encoding is small enough to write out
    // (type tag, then the value; a table is key/value pairs until a 5 byte),
    // and a test that builds its own input says what shape of callback it is
    // claiming the game sends, which a captured blob does not.
    //
    // `lua_string` and `lua_number` are the ones the header tests already use.
    // The shapes below are the ones real `.fafreplay` files carry: a delivery
    // per recipient army, the nameless origination record beside it, and the
    // echo a whisper leaves in its author's own stream.

    /// A Lua table: tag 4, key/value pairs, then tag 5. Keys are strings here,
    /// which is what a callback's argument table always has.
    fn lua_table(entries: &[(&str, Vec<u8>)]) -> Vec<u8> {
        let mut out = vec![4u8];
        for (key, value) in entries {
            out.extend_from_slice(&lua_string(key));
            out.extend_from_slice(value);
        }
        out.push(5);
        out
    }

    /// One command: a type byte, a little-endian u16 length covering the whole
    /// command, and the payload.
    fn command(kind: u8, payload: Vec<u8>) -> Vec<u8> {
        let mut out = vec![kind];
        out.extend_from_slice(&((payload.len() + 3) as u16).to_le_bytes());
        out.extend_from_slice(&payload);
        out
    }

    /// CMDST_ADVANCE: ticks forward. Ten ticks make a second here.
    fn advance(ticks: u32) -> Vec<u8> {
        command(0, ticks.to_le_bytes().to_vec())
    }

    /// A chat callback as the game delivers one: the function name, then the
    /// argument table, with `Msg` holding the line and `Sender` naming whoever
    /// typed it. `msg_extra` and `extra` carry whichever fields the case is
    /// about.
    fn delivered(
        text: &str,
        sender: &str,
        to_army: f32,
        msg_extra: &[(&str, Vec<u8>)],
        extra: &[(&str, Vec<u8>)],
    ) -> Vec<u8> {
        let mut msg: Vec<(&str, Vec<u8>)> = vec![
            ("text", lua_string(text)),
            ("to", lua_string("all")),
            ("Chat", lua_bool(true)),
        ];
        msg.extend(msg_extra.iter().map(|(k, v)| (*k, v.clone())));

        let mut args: Vec<(&str, Vec<u8>)> = vec![
            ("Mass", lua_number(0.0)),
            ("To", lua_number(to_army)),
            ("From", lua_number(to_army)),
            ("Msg", lua_table(&msg)),
            ("Energy", lua_number(0.0)),
            ("Sender", lua_string(sender)),
        ];
        args.extend(extra.iter().map(|(k, v)| (*k, v.clone())));

        callback(&args)
    }

    /// The origination record: `Msg` on its own, no `Sender`, no `To`, no
    /// `From`. Nobody in it is named, which is where "Unknown" came from.
    fn originated(text: &str, msg_extra: &[(&str, Vec<u8>)]) -> Vec<u8> {
        let mut msg: Vec<(&str, Vec<u8>)> = vec![
            ("text", lua_string(text)),
            ("to", lua_string("all")),
            ("Chat", lua_bool(true)),
        ];
        msg.extend(msg_extra.iter().map(|(k, v)| (*k, v.clone())));
        callback(&[("Msg", lua_table(&msg))])
    }

    fn callback(args: &[(&str, Vec<u8>)]) -> Vec<u8> {
        let mut payload = lua_string("GiveResourcesToPlayer");
        payload.extend_from_slice(&lua_table(args));
        command(22, payload)
    }

    fn lua_bool(value: bool) -> Vec<u8> {
        vec![3, u8::from(value)]
    }

    fn extract(stream: &[u8]) -> Vec<ReplayChatMessage> {
        let mut cursor = Cursor::new(stream);
        walk_command_stream(&mut cursor, &[]).chat_messages
    }

    /// CMDST_SET_COMMAND_SOURCE: whose orders the records after it are.
    fn source(index: u8) -> Vec<u8> {
        command(1, vec![index])
    }

    /// CMDST_ISSUE_COMMAND, with a payload this walker never looks inside.
    fn order() -> Vec<u8> {
        command(12, vec![0; 8])
    }

    fn counts(stream: &[u8], players: &[&str]) -> Vec<ReplayCommandStats> {
        let names: Vec<String> = players.iter().map(|name| (*name).to_string()).collect();
        let mut cursor = Cursor::new(stream);
        walk_command_stream(&mut cursor, &names).command_stats
    }

    #[test]
    fn orders_are_counted_against_the_source_that_was_last_announced() {
        let mut stream = Vec::new();
        stream.extend_from_slice(&source(0));
        stream.extend_from_slice(&order());
        stream.extend_from_slice(&order());
        stream.extend_from_slice(&source(1));
        stream.extend_from_slice(&order());
        stream.extend_from_slice(&advance(10));

        let stats = counts(&stream, &["Vindex", "Nuggets"]);
        assert_eq!(stats[0].player, "Vindex");
        assert_eq!(stats[0].commands, 2);
        assert_eq!(stats[1].player, "Nuggets");
        assert_eq!(stats[1].commands, 1);
    }

    #[test]
    fn the_engines_own_records_are_not_orders() {
        // A UI mod firing a sim callback every tick would otherwise outrank
        // every player in the game: one replay in the sample folder had twelve
        // thousand of these per client against fifteen hundred real orders.
        let mut stream = Vec::new();
        stream.extend_from_slice(&source(0));
        stream.extend_from_slice(&command(3, vec![0; 16])); // VerifyChecksum
        stream.extend_from_slice(&command(11, vec![0; 4])); // ProcessInfoPair
        stream.extend_from_slice(&delivered("gl", "Vindex", 1.0, &[], &[]));
        stream.extend_from_slice(&order());

        let stats = counts(&stream, &["Vindex"]);
        assert_eq!(stats[0].commands, 1);
    }

    #[test]
    fn the_ticks_the_stream_covers_become_game_seconds() {
        let mut stream = Vec::new();
        stream.extend_from_slice(&advance(600));
        stream.extend_from_slice(&advance(600));

        let mut cursor = Cursor::new(stream.as_slice());
        let walked = walk_command_stream(&mut cursor, &[]);
        assert_eq!(walked.ticks / TICKS_PER_SECOND, 120);
    }

    #[test]
    fn an_order_before_any_source_is_announced_belongs_to_nobody() {
        // Rather than to the first client in the table, which is what an index
        // defaulting to zero would have quietly done.
        let mut stream = Vec::new();
        stream.extend_from_slice(&order());
        stream.extend_from_slice(&source(0));
        stream.extend_from_slice(&order());

        assert_eq!(counts(&stream, &["Vindex"])[0].commands, 1);
    }

    #[test]
    fn a_source_the_client_table_does_not_reach_is_dropped_rather_than_counted() {
        // A truncated or unreadable table leaves fewer names than the stream
        // switches between; the extra source is nobody this client can name.
        let mut stream = Vec::new();
        stream.extend_from_slice(&source(7));
        stream.extend_from_slice(&order());

        let stats = counts(&stream, &["Vindex"]);
        assert_eq!(stats.len(), 1);
        assert_eq!(stats[0].commands, 0);
    }

    #[test]
    fn the_name_comes_from_the_record_that_has_one() {
        let stream = delivered("gl", "Vindex", 1.0, &[], &[]);
        let messages = extract(&stream);

        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].sender, "Vindex");
        assert_eq!(messages[0].message, "gl");
    }

    #[test]
    fn one_line_delivered_to_every_army_appears_once() {
        // A line typed to "all" is sent again for each recipient, and the
        // recipient is what `To` and `From` count up: same sender, same text.
        let mut stream = Vec::new();
        for army in 1..=4 {
            stream.extend_from_slice(&delivered("hello", "Vindex", army as f32, &[], &[]));
        }

        assert_eq!(extract(&stream).len(), 1, "four copies of one line");
    }

    #[test]
    fn the_nameless_origination_record_does_not_become_a_second_line() {
        // The reported bug, in the order the replays record it: the delivery
        // first, then the origination record, which names nobody and used to
        // be listed underneath it as "Unknown".
        let mut stream = delivered("its done", "Ske", 1.0, &[], &[]);
        stream.extend_from_slice(&originated("its done", &[]));
        let messages = extract(&stream);

        assert_eq!(messages.len(), 1, "one typed line");
        assert_eq!(messages[0].sender, "Ske");
    }

    #[test]
    fn a_name_arriving_after_the_nameless_record_still_lands_on_the_line() {
        // The same pair the other way round, which the fold has to survive
        // too: the held record is the nameless one and the name comes second.
        let mut stream = originated("xd", &[]);
        stream.extend_from_slice(&delivered("xd", "Seraphim-Noob", 2.0, &[], &[]));
        let messages = extract(&stream);

        assert_eq!(messages.len(), 1);
        assert_eq!(
            messages[0].sender, "Seraphim-Noob",
            "the name fills in the record already held"
        );
    }

    #[test]
    fn the_pair_is_recognised_by_its_shared_id() {
        // Builds that send `Msg.Id` put the same value on both copies. It is
        // the exact key, and it holds even where the text alone would not.
        let id = || ("Id", lua_string("2390 table: 134489D8"));
        let mut stream = delivered("waste of time", "Ske", 1.0, &[id()], &[]);
        stream.extend_from_slice(&originated("waste of time", &[id()]));

        assert_eq!(extract(&stream).len(), 1);
    }

    #[test]
    fn ids_that_differ_do_not_make_it_a_second_line() {
        // An id is `"<tick> table: <address>"`, and a line going to several
        // recipients is a fresh table each time. Treating a differing id as
        // proof of a different line is what let the copies through.
        let mut stream = delivered(
            "tell me after the game",
            "Nuggets",
            1.0,
            &[("Id", lua_string("3979 table: 1CFA7FA0"))],
            &[],
        );
        stream.extend_from_slice(&delivered(
            "tell me after the game",
            "Nuggets",
            2.0,
            &[("Id", lua_string("3979 table: 1C9A5C08"))],
            &[],
        ));

        assert_eq!(extract(&stream).len(), 1);
    }

    #[test]
    fn a_whisper_is_credited_to_who_typed_it_not_who_it_went_to() {
        // The echo back to the author. `Sender` is the player the whisper was
        // aimed at and `Msg.from` is the author, so reading `Sender` first
        // produced a second copy under the wrong name.
        let mut stream = delivered("wtf", "Nuggets", 4.0, &[], &[]);
        stream.extend_from_slice(&delivered(
            "wtf",
            "Terarii",
            10.0,
            &[("echo", lua_bool(true)), ("from", lua_string("Nuggets"))],
            &[],
        ));
        let messages = extract(&stream);

        assert_eq!(messages.len(), 1, "one whisper, recorded twice");
        assert_eq!(messages[0].sender, "Nuggets");
    }

    #[test]
    fn an_army_index_is_never_read_as_the_sender() {
        // `From` is the army a copy is being delivered to. Reading it as the
        // sender named the wrong player with complete confidence.
        let stream = callback(&[
            ("To", lua_number(3.0)),
            ("From", lua_number(3.0)),
            (
                "Msg",
                lua_table(&[("text", lua_string("hm")), ("to", lua_string("all"))]),
            ),
        ]);
        let messages = extract(&stream);

        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].sender, "Unknown", "nobody in it is named");
    }

    #[test]
    fn two_people_typing_the_same_word_are_two_messages() {
        // Why the sender stays in the key for two named records. Everybody
        // types "gg" at the end of a game, within the same two seconds, and
        // none of it is a duplicate.
        let mut stream = delivered("gg", "Vindex", 1.0, &[], &[]);
        stream.extend_from_slice(&delivered("gg", "wlsn", 1.0, &[], &[]));
        stream.extend_from_slice(&delivered("gg", "Nuggets", 1.0, &[], &[]));

        assert_eq!(extract(&stream).len(), 3);
    }

    #[test]
    fn copies_separated_by_somebody_else_talking_still_appear_once() {
        // The window is searched, not just the entry before this one: two
        // people talking on the same tick interleave their copies.
        let mut stream = delivered("hello", "Vindex", 1.0, &[], &[]);
        stream.extend_from_slice(&delivered("hi", "wlsn", 1.0, &[], &[]));
        stream.extend_from_slice(&delivered("hello", "Vindex", 2.0, &[], &[]));
        let messages = extract(&stream);

        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].sender, "Vindex");
        assert_eq!(messages[1].sender, "wlsn");
    }

    #[test]
    fn the_same_line_typed_again_later_is_not_a_duplicate() {
        // The window is two seconds, so repeating yourself a minute later is
        // something you did twice.
        let mut stream = delivered("gg", "Vindex", 1.0, &[], &[]);
        stream.extend_from_slice(&advance(600));
        stream.extend_from_slice(&delivered("gg", "Vindex", 1.0, &[], &[]));
        let messages = extract(&stream);

        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].time_seconds, 0);
        assert_eq!(messages[1].time_seconds, 60);
    }

    #[test]
    fn the_notify_mod_announcing_an_upgrade_is_not_chat() {
        // Addressed to the "notify" channel, which nobody types into. These
        // were being listed as though the player had said "Starting Tech 2
        // Land HQ upgrade" out loud.
        let stream = callback(&[
            ("To", lua_number(2.0)),
            ("From", lua_number(2.0)),
            (
                "Msg",
                lua_table(&[
                    ("text", lua_string("Starting Tech 2 Land HQ upgrade")),
                    ("to", lua_string("notify")),
                    ("Chat", lua_bool(true)),
                ]),
            ),
            ("Sender", lua_string("Debil11")),
        ]);

        assert!(extract(&stream).is_empty());
    }

    #[test]
    fn an_empty_message_is_not_a_message() {
        let stream = delivered("   ", "Vindex", 1.0, &[], &[]);
        assert!(extract(&stream).is_empty());
    }
}
