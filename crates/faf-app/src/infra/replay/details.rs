//! Replay details: the game options, in-game chat and per-player command counts
//! a whole `.scfareplay` body yields once the user asks for them.
//!
//! Separate from the header reader because this walks past the header into
//! the command stream, the largest thing in a replay, and the chat in that
//! stream is a subject of its own with its own rules for what one line is.

use std::io::{BufReader, Cursor, Read};
use std::path::Path;

use faf_domain::state::{ReplayChatMessage, ReplayCommandStats, ReplayDetails, ReplayGameOption};
use serde_json::Value;

use super::codec::{open_replay_stream, read_head};
use super::library::envelope_sim_mods;
use super::scfa_header::{
    body_sim_mods, game_version_from_string, next_command_record, parse_replay_lua, replay_string,
    replay_u32, replay_u8, skip_replay_bytes,
};

pub(super) async fn read_detailed_info(path: &Path) -> Result<ReplayDetails, String> {
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || {
        let (header, stream) = open_replay_stream(&path)?;
        let mut details = parse_detailed_info(stream)?;
        // The envelope's list when it has one, as for the listing; the body's
        // own table otherwise, which is every file the replay server wrote.
        if let Some(mods) = header.as_ref().and_then(envelope_sim_mods) {
            details.sim_mods = mods;
        }
        Ok(details)
    })
    .await
    .map_err(|error| format!("could not parse replay details: {error}"))?
}

/// [`parse_detailed_info`] over a body already in memory.
pub fn parse_detailed_info_from_body(body: &[u8]) -> ReplayDetails {
    // A slice cannot fail to read, and the head parser answers once it has
    // the last of it, so the fallback is never taken.
    parse_detailed_info(body).unwrap_or_else(|_| replay_details_with_version(None))
}

/// The details of one replay, read off its command stream as it is
/// decompressed. Only the head, the part in front of the first record, is
/// held in memory; the records are read one at a time.
fn parse_detailed_info(mut stream: impl Read) -> Result<ReplayDetails, String> {
    let (head, rest) = read_head(&mut stream, |bytes, last| {
        let mut cursor = Cursor::new(bytes);
        let head = read_details_head(&mut cursor);
        (head.whole || last).then(|| (head, cursor.position() as usize))
    })?;
    let game_options = extract_game_options(head.game_options_lua.as_ref(), head.game_version);
    let Some(sources) = head.sources else {
        return Ok(ReplayDetails {
            game_options,
            chat_messages: Vec::new(),
            command_stats: Vec::new(),
            sim_seconds: 0,
            sim_mods: head.sim_mods.unwrap_or_default(),
            game_version: head.game_version,
        });
    };

    let mut records = BufReader::new(Cursor::new(rest).chain(stream));
    let stream = walk_command_stream(&mut records, &sources);

    Ok(ReplayDetails {
        game_options,
        chat_messages: stream.chat_messages,
        command_stats: stream.command_stats,
        sim_seconds: stream.ticks / TICKS_PER_SECOND,
        // The body's own table. The caller puts the envelope's list over it
        // when the `.fafreplay` header this body was unwrapped from has one.
        sim_mods: head.sim_mods.unwrap_or_default(),
        game_version: head.game_version,
    })
}

/// What stands in front of the command stream, as far as it could be read.
struct DetailsHead {
    game_version: Option<i32>,
    game_options_lua: Option<Value>,
    /// The mods the body's own table names; `None` when the head ended
    /// before it.
    sim_mods: Option<Vec<String>>,
    /// The command sources the stream switches between. `None` when the head
    /// ended before their table, and then there is no stream to walk either.
    sources: Option<Vec<String>>,
    /// Whether every part of it was read, up to the first command record. A
    /// head that is not whole was cut short by the end of what has been read
    /// so far, or is malformed; only reading more tells the two apart.
    whole: bool,
}

fn read_details_head(cursor: &mut Cursor<&[u8]>) -> DetailsHead {
    let version = replay_string(cursor);
    let mut head = DetailsHead {
        game_version: game_version_from_string(version.as_deref()),
        game_options_lua: None,
        sim_mods: None,
        sources: None,
        whole: false,
    };
    if !skip_replay_bytes(cursor, 3) {
        return head;
    }
    let raw_map = replay_string(cursor);
    if !skip_replay_bytes(cursor, 4) || replay_u32(cursor).is_none() {
        return head;
    }
    let Some(mods) = parse_replay_lua(cursor, 0) else {
        return head;
    };
    head.sim_mods = Some(body_sim_mods(&mods));
    if replay_u32(cursor).is_none() {
        return head;
    }
    head.game_options_lua = parse_replay_lua(cursor, 0);

    let Some(source_count) = replay_u8(cursor) else {
        return head;
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
        let Some(name) = replay_string(cursor) else {
            break;
        };
        if replay_u32(cursor).is_none() {
            break;
        }
        sources.push(name);
    }
    let cheats = replay_u8(cursor);
    let army_count = replay_u8(cursor);
    let mut whole = version.is_some()
        && raw_map.is_some()
        && head.game_options_lua.is_some()
        && sources.len() == usize::from(source_count)
        && cheats.is_some()
        && army_count.is_some();

    for _ in 0..army_count.unwrap_or(0) {
        if replay_u32(cursor).is_none() {
            whole = false;
            break;
        }
        if !matches!(parse_replay_lua(cursor, 0), Some(Value::Object(_))) {
            whole = false;
            break;
        }
        let Some(source) = replay_u8(cursor) else {
            whole = false;
            break;
        };
        if source != u8::MAX && replay_u8(cursor).is_none() {
            whole = false;
            break;
        }
    }

    whole &= skip_replay_bytes(cursor, 4);
    head.sources = Some(sources);
    head.whole = whole;
    head
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

/// How far back [`fold_chat_record`] looks for the line a record repeats.
///
/// The two-second window alone is no bound: a stream whose clock never
/// advances keeps every record inside it, and comparing each new record with
/// all the earlier ones made a crafted replay of a few hundred megabytes cost
/// minutes to hours of a blocking thread. The copies of one line arrive
/// together, one per recipient, so a game would need more than this many
/// players to spread them further apart.
const CHAT_LOOKBACK: usize = 256;

/// The most chat lines one replay's details keep. A long, chatty team game
/// has a few hundred; anything past this is not a conversation anybody reads.
const MAX_CHAT_RECORDS: usize = 20_000;

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
fn walk_command_stream(stream: &mut impl Read, sources: &[String]) -> CommandStream {
    let mut current_ticks: u32 = 0;
    let mut records: Vec<ChatRecord> = Vec::new();
    let mut counts: Vec<u32> = vec![0; sources.len()];
    let mut current_source: Option<usize> = None;
    let mut buffer = Vec::new();

    while let Some(cmd_type) = next_command_record(stream, &mut buffer) {
        let payload = buffer.as_slice();

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
    let oldest = records.len().saturating_sub(CHAT_LOOKBACK);
    for index in (oldest..records.len()).rev() {
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
        None if records.len() >= MAX_CHAT_RECORDS => {}
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

    fn chat_line(message: String) -> ChatRecord {
        ChatRecord {
            time_seconds: 0,
            to: "all".into(),
            sender: Some("someone".into()),
            id: None,
            message,
        }
    }

    #[test]
    fn a_stream_whose_clock_never_moves_is_folded_in_bounded_time() {
        // Every record at second zero: the two-second window alone used to
        // compare each new one with all before it.
        let mut records = Vec::new();
        for n in 0..(MAX_CHAT_RECORDS + 500) {
            fold_chat_record(&mut records, chat_line(format!("line {n}")));
        }
        assert_eq!(records.len(), MAX_CHAT_RECORDS);
        // A copy of a recent line is still recognised as one.
        let last = records.last().unwrap().message.clone();
        let mut copy = chat_line(last);
        copy.sender = None;
        fold_chat_record(&mut records, copy);
        assert_eq!(records.len(), MAX_CHAT_RECORDS);
    }

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

    /// A reader that hands out a few bytes per call, the way a decompressor
    /// is free to.
    struct Trickle<'a>(&'a [u8]);

    impl Read for Trickle<'_> {
        fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
            let count = out.len().min(self.0.len()).min(7);
            out[..count].copy_from_slice(&self.0[..count]);
            self.0 = &self.0[count..];
            Ok(count)
        }
    }

    /// A whole body: the head the engine writes in front of the command
    /// stream, for one player, with a scenario table too large for the first
    /// read of a head, then `stream`.
    fn body_with_a_large_head(stream: &[u8]) -> Vec<u8> {
        let mut body = b"Supreme Commander v1.50.3675\0".to_vec();
        body.extend_from_slice(&[0; 3]);
        body.extend_from_slice(b"/maps/x/x_scenario.lua\0");
        body.extend_from_slice(&[0; 4]);
        body.extend_from_slice(&0u32.to_le_bytes());
        body.extend_from_slice(&lua_table(&[]));
        body.extend_from_slice(&0u32.to_le_bytes());
        body.extend_from_slice(&lua_table(&[(
            "Description",
            lua_string(&"x".repeat(200_000)),
        )]));
        body.push(1);
        body.extend_from_slice(b"Vindex\0");
        body.extend_from_slice(&1u32.to_le_bytes());
        body.push(0); // cheats
        body.push(0); // armies
        body.extend_from_slice(&[0; 4]);
        body.extend_from_slice(stream);
        body
    }

    #[test]
    fn a_head_longer_than_the_first_read_is_read_whole_and_the_records_after_it_walked() {
        let mut stream = source(0);
        stream.extend_from_slice(&order());
        stream.extend_from_slice(&order());
        stream.extend_from_slice(&advance(600));

        let details =
            parse_detailed_info(Trickle(&body_with_a_large_head(&stream))).expect("a whole body");
        assert_eq!(details.game_version, Some(3675));
        assert_eq!(details.command_stats.len(), 1);
        assert_eq!(details.command_stats[0].player, "Vindex");
        assert_eq!(details.command_stats[0].commands, 2);
        assert_eq!(details.sim_seconds, 60);
    }

    #[test]
    fn a_body_that_ends_inside_its_head_gives_back_what_was_read() {
        let body = body_with_a_large_head(&advance(600));
        let details = parse_detailed_info(Trickle(&body[..100_000])).expect("not an error");
        assert_eq!(details.game_version, Some(3675));
        assert!(details.command_stats.is_empty());
        assert_eq!(details.sim_seconds, 0);
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
