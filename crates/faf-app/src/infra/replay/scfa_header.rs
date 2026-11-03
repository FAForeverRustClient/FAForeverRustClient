//! The `.scfareplay` stream's own header: the engine version, the scenario,
//! the game options and the army table, in the engine's binary Lua encoding.
//!
//! Separate from the container (`codec`) and from the command stream behind it
//! (`details`), because three readers need it on its own: the library listing,
//! the vault's map lookup, and the replay analysis (`infra::replay_analysis`),
//! which is why the primitives here are visible to the crate.

use std::collections::HashMap;
use std::io::{Cursor, Read};

use serde_json::Value;

const LOCAL_REPLAY_BODY_PREFIX_BYTES: u64 = 512 * 1024;
/// How much of a vault replay is fetched to read the map out of it. The
/// envelope is a few hundred bytes and the first compressed block decodes well
/// past the scenario path, which is the third string in the stream.
pub(super) const REPLAY_HEAD_BYTES: u64 = 64 * 1024;

/// Read the compact FA replay header from a compressed local replay body. The
/// JSON envelope has player names, but faction and displayed rating are stored
/// in the binary Lua army table that follows it.
#[derive(Default)]
pub(super) struct LocalBodyInfo {
    header_complete: bool,
    pub(super) player_stats: HashMap<String, BodyPlayerStats>,
    /// The armies as the engine loaded them, in slot order: `(team, name)`.
    ///
    /// This is the seating the game was actually played with, which is not
    /// what the `.fafreplay` envelope says. The envelope carries the lobby
    /// listing as it stood when whoever recorded the file sent the launch, so
    /// a player who joined late is missing from it and a player who switched
    /// team is in the old one -- 1v4 and 4v2 lineups for games that were 4v4,
    /// which is what "not all players show up" looked like. Observers are not
    /// armies and so are not here, and neither is the neutral civilian army,
    /// which is filtered out where this is read.
    pub(super) armies: Vec<LocalBodyArmy>,
    pub(super) map_name: Option<String>,
    pub(super) game_version: Option<i32>,
    /// The simulation mods the engine ran the game with, by name: the body's
    /// own mod table, see [`body_sim_mods`]. Empty when the game had none,
    /// `None` when the file ended before the table did.
    pub(super) sim_mods: Option<Vec<String>>,
}

/// What the army table says about one player, by name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct BodyPlayerStats {
    pub(super) faction: Option<i32>,
    pub(super) rating: Option<i32>,
    /// Two-letter country code, lower case.
    pub(super) country: Option<String>,
}

/// One army of the replay body's army table.
pub(super) struct LocalBodyArmy {
    pub(super) name: String,
    /// The engine's team number. 1 is "no team" (free-for-all, and the
    /// civilian armies); a team game numbers its sides from 2.
    pub(super) team: Option<i32>,
    /// `Civilian` in the army table: the map's neutral armies, never a player.
    pub(super) civilian: bool,
    /// No client behind this army: the engine writes `255` for the army's
    /// source when nobody was connected to it.
    ///
    /// In a skirmish that is an AI somebody added to the lobby, and it belongs
    /// in the lineup -- a 4v4 against four AI is a game of eight. In a co-op
    /// mission it is the mission's own script: `Order`, `QAI`, `Loyalist`,
    /// `UEF`, `Eris`. Those are the campaign's antagonists, not players, and
    /// listing them turned a solo mission into a five player game.
    pub(super) computer: bool,
    pub(super) faction: Option<i32>,
    pub(super) rating: Option<i32>,
    /// `Country` in the army table: the two-letter code the lobby had.
    pub(super) country: Option<String>,
}

fn extract_map_folder(path: &str) -> String {
    let path = if let Some((_, after)) = path.split_once("\r\n") {
        after
    } else if let Some((_, after)) = path.split_once('\n') {
        after
    } else {
        path
    };
    let normalized = path.replace('\\', "/");
    let parts: Vec<&str> = normalized.split('/').filter(|p| !p.is_empty()).collect();
    if let Some(maps_idx) = parts.iter().position(|p| p.eq_ignore_ascii_case("maps")) {
        if let Some(folder) = parts.get(maps_idx + 1) {
            return folder.to_string();
        }
    }
    if let Some(folder) = parts
        .iter()
        .find(|p| p.to_ascii_lowercase().starts_with("neroxis_map_generator_"))
    {
        return folder.to_string();
    }
    if let Some(last) = parts.last() {
        return last.replace("_scenario.lua", "").replace(".scmap", "");
    }
    String::new()
}

/// Read the compact FA replay header from a compressed local replay body. The
/// JSON envelope has player names, but faction and displayed rating are stored
/// in the binary Lua army table that follows it, and the scenario file path is
/// in the game options table.
///
/// `None` means the body yielded nothing at all: an empty body, or one whose
/// compression no longer decodes. See [`playable_body`].
pub(super) fn local_body_player_stats(body: &[u8], compression: &str) -> Option<LocalBodyInfo> {
    local_body_player_stats_reader(body, compression)
}

pub(super) fn local_body_player_stats_reader(
    body: impl Read,
    compression: &str,
) -> Option<LocalBodyInfo> {
    let prefix = if compression.eq_ignore_ascii_case("zstd") {
        zstd::stream::read::Decoder::new(body)
            .map(read_replay_body_prefix)
            .unwrap_or_default()
    } else {
        let mut decoded =
            base64::read::DecoderReader::new(body, &base64::engine::general_purpose::STANDARD);
        let mut uncompressed_size = [0; 4];
        if decoded.read_exact(&mut uncompressed_size).is_err() {
            return None;
        }
        read_replay_body_prefix(flate2::read::ZlibDecoder::new(decoded))
    };
    if prefix.is_empty() {
        return None;
    }
    Some(parse_local_body_info(&prefix))
}

/// The map folder a `.fafreplay` names, read from the front of the file.
///
/// Two places name it, and the file decides which one is filled. A replay this
/// client recorded carries the map in its own JSON envelope; one served by the
/// FAF replay server carries the literal string `None` there, because the
/// server writes the envelope from a game record that has no map for a
/// campaign mission either. Underneath both is the command stream, which
/// always opens with the scenario the engine loaded
/// (`/maps/SCCA_Coop_A03.v0023/SCCA_Coop_A03.scmap`), and that is the mission's
/// own folder: the same thing `faf-scfa-replay-parser` reads, and the key the
/// co-op catalogue, the vault lookup and the preview service all use.
///
/// `head` may be a truncated file: the stream decoder keeps whatever it
/// decoded before the data ran out, which is far more than these strings.
pub(super) fn map_name_from_replay_head(head: &[u8]) -> Option<String> {
    let split = head.iter().position(|byte| *byte == b'\n')?;
    let header: Value = serde_json::from_slice(&head[..split]).ok()?;
    let envelope = header
        .get("mapname")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|map| !map.is_empty() && !map.eq_ignore_ascii_case("none"))
        .map(extract_map_folder)
        .filter(|map| !map.is_empty());
    if envelope.is_some() {
        return envelope;
    }
    let compression = header
        .get("compression")
        .and_then(Value::as_str)
        .unwrap_or_default();
    local_body_player_stats(&head[split + 1..], compression)?.map_name
}

/// The simulation mods a replay was played with, from the head of the file
/// alone (issue 638): the envelope's list, or the body's own mod table when
/// the envelope has none, which is every file the replay server writes. `None`
/// when neither answers, which is not the same as a game without mods.
pub(super) fn sim_mods_from_replay_head(head: &[u8]) -> Option<Vec<String>> {
    let split = head.iter().position(|byte| *byte == b'\n')?;
    let header: Value = serde_json::from_slice(&head[..split]).ok()?;
    let compression = header
        .get("compression")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let body = local_body_player_stats(&head[split + 1..], compression);
    super::library::replay_sim_mods(&header, body.as_ref())
}

/// Is there still a game inside this file?
///
/// The JSON envelope is written before the match and says nothing about what
/// followed it, so a file can carry a full description of a game whose command
/// stream is empty, truncated mid-frame, or no longer decompresses: a crash
/// during the write, a half-finished download, a copy that lost its tail. Such
/// a file used to list as an ordinary replay and hand Forged Alliance a stream
/// it cannot open, which is a failure the user meets several seconds into a
/// game launch instead of on the row itself.
///
/// A single recognised field is enough. This decides whether the archive
/// disowns a file, so it takes the lenient side of anything it cannot parse:
/// the replay body format is the engine's, not ours, and a version of it this
/// parser reads less of is still a replay.
pub(super) fn playable_body(info: Option<&LocalBodyInfo>) -> bool {
    info.is_some_and(|info| {
        info.map_name.is_some() || info.game_version.is_some() || !info.player_stats.is_empty()
    })
}

fn read_replay_body_prefix(mut reader: impl Read) -> Vec<u8> {
    let mut prefix = Vec::new();
    let mut chunk = [0; 16 * 1024];
    // Checked at doubling sizes, so a header that never completes costs about
    // two parses of the full prefix rather than one per chunk.
    let mut next_check = chunk.len();
    while prefix.len() < LOCAL_REPLAY_BODY_PREFIX_BYTES as usize {
        let size = chunk
            .len()
            .min(LOCAL_REPLAY_BODY_PREFIX_BYTES as usize - prefix.len());
        match reader.read(&mut chunk[..size]) {
            Ok(0) | Err(_) => break,
            Ok(count) => prefix.extend_from_slice(&chunk[..count]),
        }
        if prefix.len() >= next_check {
            if parse_local_body_info(&prefix).header_complete {
                break;
            }
            next_check = prefix.len() * 2;
        }
    }
    prefix
}

fn parse_local_body_info(body: &[u8]) -> LocalBodyInfo {
    let mut cursor = Cursor::new(body);
    let game_version = game_version_from_string(replay_string(&mut cursor).as_deref());
    // Two fixed-width fields, not strings. `faf-scfa-replay-parser` reads them
    // as `read(3)` and `read(4)`, and so does this module's own
    // `parse_detailed_info_from_body`; only this function read them as
    // NUL-terminated strings. On every replay anyone has produced the bytes
    // are `\r\n\0` and `\r\n\x1a\0`, so the two agree and the difference never
    // showed -- verified against 93 files from a real archive and the
    // reference parser's own 13 fixtures. They agree by coincidence, though:
    // any other byte there and the string read walks to the next NUL, and
    // every field after it is read from the wrong offset with no error
    // anywhere. Read the widths the format actually specifies.
    if !skip_replay_bytes(&mut cursor, 3) {
        return LocalBodyInfo {
            game_version,
            ..Default::default()
        };
    }
    let raw_map = replay_string(&mut cursor);
    if !skip_replay_bytes(&mut cursor, 4) {
        return LocalBodyInfo {
            game_version,
            map_name: raw_map
                .as_deref()
                .map(extract_map_folder)
                .filter(|m| !m.is_empty()),
            ..Default::default()
        };
    }
    let Some(_) = replay_u32(&mut cursor) else {
        return LocalBodyInfo {
            game_version,
            map_name: raw_map
                .as_deref()
                .map(extract_map_folder)
                .filter(|m| !m.is_empty()),
            ..Default::default()
        };
    };
    let sim_mods = parse_replay_lua(&mut cursor, 0).map(|table| body_sim_mods(&table));
    let Some(_) = replay_u32(&mut cursor) else {
        return LocalBodyInfo {
            game_version,
            map_name: raw_map
                .as_deref()
                .map(extract_map_folder)
                .filter(|m| !m.is_empty()),
            sim_mods,
            ..Default::default()
        };
    };
    let game_options = parse_replay_lua(&mut cursor, 0);

    let map_name = game_options
        .as_ref()
        .and_then(|opts| opts.get("ScenarioFile"))
        .and_then(Value::as_str)
        .map(extract_map_folder)
        .filter(|m| !m.is_empty())
        .or_else(|| {
            raw_map
                .as_deref()
                .map(extract_map_folder)
                .filter(|m| !m.is_empty())
        });

    let Some(source_count) = replay_u8(&mut cursor) else {
        return LocalBodyInfo {
            map_name,
            game_version,
            sim_mods,
            ..Default::default()
        };
    };
    let mut sources = Vec::with_capacity(source_count as usize);
    for _ in 0..source_count {
        let Some(name) = replay_string(&mut cursor) else {
            return LocalBodyInfo {
                map_name,
                game_version,
                sim_mods,
                ..Default::default()
            };
        };
        let Some(_) = replay_u32(&mut cursor) else {
            return LocalBodyInfo {
                map_name,
                game_version,
                sim_mods,
                ..Default::default()
            };
        };
        sources.push(name);
    }
    if replay_u8(&mut cursor).is_none() {
        return LocalBodyInfo {
            map_name,
            game_version,
            sim_mods,
            ..Default::default()
        };
    }
    let Some(army_count) = replay_u8(&mut cursor) else {
        return LocalBodyInfo {
            map_name,
            game_version,
            sim_mods,
            ..Default::default()
        };
    };
    let mut stats = HashMap::new();
    let mut armies = Vec::new();
    // Whether the army table was read to the end. A file that stops in the
    // middle of it still yields the armies before the cut, and those are a
    // believable-looking lineup that is missing players: exactly the thing
    // this reads the table to avoid. A partial table answers nothing.
    let mut armies_complete = true;
    for _ in 0..army_count {
        if replay_u32(&mut cursor).is_none() {
            armies_complete = false;
            break;
        }
        let Some(Value::Object(data)) = parse_replay_lua(&mut cursor, 0) else {
            armies_complete = false;
            break;
        };
        let Some(source) = replay_u8(&mut cursor) else {
            armies_complete = false;
            break;
        };
        if source != u8::MAX {
            let _ = replay_u8(&mut cursor);
        }
        let name = data
            .get("PlayerName")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| sources.get(source as usize).cloned());
        let Some(name) = name else { continue };
        let faction = data.get("Faction").and_then(replay_i32_value);
        let rating = replay_displayed_rating(&data);
        let country = data
            .get("Country")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|code| code.len() == 2 && code.chars().all(|c| c.is_ascii_alphabetic()))
            .map(str::to_ascii_lowercase);
        armies.push(LocalBodyArmy {
            name: name.clone(),
            team: data.get("Team").and_then(replay_i32_value),
            civilian: data
                .get("Civilian")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            computer: source == u8::MAX,
            faction,
            rating,
            country: country.clone(),
        });
        stats.insert(
            name,
            BodyPlayerStats {
                faction,
                rating,
                country,
            },
        );
    }
    LocalBodyInfo {
        player_stats: stats,
        armies: if armies_complete { armies } else { Vec::new() },
        header_complete: armies_complete,
        map_name,
        game_version,
        sim_mods,
    }
}

/// The names in the body's mod table.
///
/// The engine writes the mods it loaded in front of the game options, one
/// table per mod with the fields of its `mod_info.lua` (`name`, `uid`,
/// `version`, `ui_only`, ...), and an empty table for a game without any.
/// This is the list to trust: the `.fafreplay` envelope the replay server
/// writes carries no `sim_mods` at all, so a missing key there says nothing
/// about the game (issue 638). Checked against the vault replays from
/// 27457000 on, where twenty of forty files name mods here and none does in
/// the envelope.
pub(super) fn body_sim_mods(table: &Value) -> Vec<String> {
    let Some(mods) = table.as_object() else {
        return Vec::new();
    };
    mods.values()
        .filter(|entry| entry.get("ui_only").and_then(Value::as_bool) != Some(true))
        .filter_map(|entry| entry.get("name").and_then(Value::as_str))
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(String::from)
        .collect()
}

/// The next record of the command stream: its type, with its payload read
/// into `payload`.
///
/// A record is a type byte, a little-endian `u16` length that counts those
/// three bytes, then the payload. `None` at the end of the stream, and at a
/// record that is shorter than its own prefix or longer than what is left,
/// which is where both walkers have always stopped.
pub(crate) fn next_command_record(stream: &mut impl Read, payload: &mut Vec<u8>) -> Option<u8> {
    let mut prefix = [0u8; 3];
    stream.read_exact(&mut prefix).ok()?;
    let length = usize::from(u16::from_le_bytes([prefix[1], prefix[2]]));
    if length < 3 {
        return None;
    }
    payload.resize(length - 3, 0);
    stream.read_exact(payload).ok()?;
    Some(prefix[0])
}

pub(crate) fn replay_u8(cursor: &mut Cursor<&[u8]>) -> Option<u8> {
    let mut value = [0; 1];
    Read::read_exact(cursor, &mut value).ok()?;
    Some(value[0])
}

pub(crate) fn replay_u32(cursor: &mut Cursor<&[u8]>) -> Option<u32> {
    let mut value = [0; 4];
    Read::read_exact(cursor, &mut value).ok()?;
    Some(u32::from_le_bytes(value))
}

pub(super) fn skip_replay_bytes(cursor: &mut Cursor<&[u8]>, count: u64) -> bool {
    cursor.set_position(cursor.position().saturating_add(count));
    cursor.position() <= cursor.get_ref().len() as u64
}

pub(crate) fn replay_string(cursor: &mut Cursor<&[u8]>) -> Option<String> {
    let start = cursor.position() as usize;
    let rest = cursor.get_ref().get(start..)?;
    let end = rest.iter().position(|byte| *byte == 0)?;
    cursor.set_position((start + end + 1) as u64);
    Some(String::from_utf8_lossy(&rest[..end]).into_owned())
}

pub(super) fn game_version_from_string(version: Option<&str>) -> Option<i32> {
    let version = version?;
    version
        .starts_with("Supreme Commander v1")
        .then(|| version.rsplit('.').next()?.parse().ok())
        .flatten()
}

pub(crate) fn parse_replay_lua(cursor: &mut Cursor<&[u8]>, depth: u8) -> Option<Value> {
    if depth > 64 {
        return None;
    }
    match replay_u8(cursor)? {
        0 => {
            let mut bytes = [0; 4];
            Read::read_exact(cursor, &mut bytes).ok()?;
            serde_json::Number::from_f64(f32::from_le_bytes(bytes) as f64).map(Value::Number)
        }
        1 => Some(Value::String(replay_string(cursor)?)),
        2 => {
            replay_u8(cursor)?;
            Some(Value::Null)
        }
        3 => Some(Value::Bool(replay_u8(cursor)? != 0)),
        4 => {
            let mut object = serde_json::Map::new();
            loop {
                let next = *cursor.get_ref().get(cursor.position() as usize)?;
                if next == 5 {
                    cursor.set_position(cursor.position() + 1);
                    break;
                }
                let key = parse_replay_lua_with_type(cursor, depth + 1, next)?;
                let value = parse_replay_lua(cursor, depth + 1)?;
                let key = key
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| key.to_string());
                object.insert(key, value);
            }
            Some(Value::Object(object))
        }
        _ => None,
    }
}

fn parse_replay_lua_with_type(cursor: &mut Cursor<&[u8]>, depth: u8, kind: u8) -> Option<Value> {
    cursor.set_position(cursor.position() + 1);
    match kind {
        0 => {
            let mut bytes = [0; 4];
            Read::read_exact(cursor, &mut bytes).ok()?;
            serde_json::Number::from_f64(f32::from_le_bytes(bytes) as f64).map(Value::Number)
        }
        1 => Some(Value::String(replay_string(cursor)?)),
        2 => {
            replay_u8(cursor)?;
            Some(Value::Null)
        }
        3 => Some(Value::Bool(replay_u8(cursor)? != 0)),
        4 => {
            cursor.set_position(cursor.position() - 1);
            parse_replay_lua(cursor, depth)
        }
        _ => None,
    }
}

fn replay_i32_value(value: &Value) -> Option<i32> {
    value
        .as_f64()
        .and_then(|number| i32::try_from(number.round() as i64).ok())
}

fn replay_displayed_rating(data: &serde_json::Map<String, Value>) -> Option<i32> {
    let mean = data.get("MEAN").and_then(Value::as_f64)?;
    let deviation = data.get("DEV").and_then(Value::as_f64)?;
    // The same number the vault gives for the same player, read from a local
    // replay's header instead, so it goes through the same rule.
    faf_domain::protocol::rating::displayed_points(mean, deviation)
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_envelope_names_the_mods_when_it_has_a_list() {
        // Issue 638: the head of a vault replay, as a range request returns
        // it: the envelope line and then compressed bytes cut off anywhere.
        let mut head =
            br#"{"uid":27457062,"sim_mods":{"a1b2":"Random Events","c3d4":{"name":"No Rush"}}}"#
                .to_vec();
        head.push(b'\n');
        head.extend_from_slice(&[0x28, 0xb5, 0x2f, 0xfd, 0x60]);
        let mut mods = super::sim_mods_from_replay_head(&head).unwrap();
        mods.sort();
        assert_eq!(mods, ["No Rush", "Random Events"]);
        // The replay server's envelope has no list at all and no body to
        // fall back on here: no answer, not an empty one.
        assert_eq!(super::sim_mods_from_replay_head(b"{\"uid\":1}\n"), None);
        // An envelope cut off before its end is not readable yet.
        assert_eq!(
            super::sim_mods_from_replay_head(b"{\"uid\":1,\"sim_mods\":{"),
            None
        );
    }

    use super::*;

    /// A vault replay's head: the replay server's envelope, which names no
    /// mods, over a body that opens with the given mod table.
    fn vault_head_with_mod_table(table: &[u8]) -> Vec<u8> {
        let mut body = Vec::new();
        body.extend_from_slice(b"Supreme Commander v1.50.3817\0\r\n\0");
        body.extend_from_slice(b"Replay v1.9\r\n/maps/SCMP_009/SCMP_009.scmap\0\r\n\x1a\0");
        body.extend_from_slice(&(table.len() as u32).to_le_bytes());
        body.extend_from_slice(table);
        let mut head = br#"{"uid":27457006,"compression":"zstd"}"#.to_vec();
        head.push(b'\n');
        head.extend(zstd::encode_all(body.as_slice(), 0).unwrap());
        head
    }

    fn lua_string(out: &mut Vec<u8>, text: &str) {
        out.push(1);
        out.extend_from_slice(text.as_bytes());
        out.push(0);
    }

    fn lua_mod(out: &mut Vec<u8>, index: f32, name: &str, ui_only: bool) {
        out.push(0);
        out.extend_from_slice(&index.to_le_bytes());
        out.push(4);
        lua_string(out, "name");
        lua_string(out, name);
        lua_string(out, "ui_only");
        out.extend_from_slice(&[3, u8::from(ui_only)]);
        out.push(5);
    }

    #[test]
    fn the_body_names_the_mods_the_envelope_leaves_out() {
        // Issue 638: the replay server writes no `sim_mods` into the
        // envelope, so every vault replay read as a game without mods. The
        // engine's own table in the body is what it ran with.
        let mut table = vec![4];
        lua_mod(&mut table, 1.0, "Reclaim Turret", false);
        lua_mod(&mut table, 2.0, "M28AI", false);
        lua_mod(&mut table, 3.0, "Notify", true);
        table.push(5);
        let mut mods = sim_mods_from_replay_head(&vault_head_with_mod_table(&table)).unwrap();
        mods.sort();
        assert_eq!(mods, ["M28AI", "Reclaim Turret"]);
        // An empty table is the body saying the game had none.
        assert_eq!(
            sim_mods_from_replay_head(&vault_head_with_mod_table(&[4, 5])),
            Some(Vec::new())
        );
    }

    #[test]
    fn performance_metadata_decoding_stops_before_the_command_stream() {
        let mut body = super::super::test_support::local_body_with_army_after(b"\r\n\x1a\0");
        body.resize(512 * 1024, 0);
        let mut reader = Cursor::new(body.as_slice());
        let prefix = read_replay_body_prefix(&mut reader);
        assert!(parse_local_body_info(&prefix).header_complete);
        assert!(reader.position() < 32 * 1024);
        assert_eq!(parse_local_body_info(&prefix).armies.len(), 3);
    }
    use crate::infra::replay::test_support::{local_body_with_army_after, qcompressed_body};

    #[test]
    fn local_body_parser_extracts_faction_and_displayed_rating() {
        let encoded = qcompressed_body();
        let stats = local_body_player_stats(encoded.as_bytes(), "").expect("a decodable body");
        assert_eq!(
            stats.player_stats.get("TestPlayer"),
            Some(&BodyPlayerStats {
                faction: Some(1),
                rating: Some(1200),
                country: Some("de".to_string()),
            })
        );
        assert_eq!(stats.map_name.as_deref(), Some("SCMP_009"));
    }

    /// The four bytes after the map string are a width, not a string.
    ///
    /// `faf-scfa-replay-parser` reads them with `read(4)`, and so does
    /// [`parse_detailed_info_from_body`]; the listing's own reader used to look
    /// for a NUL instead. Every replay anyone has produced carries
    /// `\r\n\x1a\0` there, so the two agreed on all 93 files of a real archive
    /// and on the reference parser's own fixtures. They agree by coincidence.
    /// With no NUL in those four bytes the string read runs on into the army
    /// table, and every field after it is taken from the wrong offset: no
    /// error, no empty list, just a roster that is quietly somebody else's.
    #[test]
    fn the_field_after_the_map_string_is_four_bytes_wide_not_a_string() {
        let body = local_body_with_army_after(&[0x01, 0x02, 0x03, 0x04]);
        let info = parse_local_body_info(&body);

        assert_eq!(info.map_name.as_deref(), Some("SCMP_009"));
        assert_eq!(
            info.armies
                .iter()
                .map(|army| army.name.as_str())
                .collect::<Vec<_>>(),
            ["TestPlayer", "Guest", "civilian"]
        );
    }

    #[test]
    fn extract_map_folder_handles_replay_version_prefix_and_paths() {
        assert_eq!(
            extract_map_folder("Replay v1.9\r\n/maps/scmp_001/scmp_001_scenario.lua"),
            "scmp_001"
        );
        assert_eq!(
            extract_map_folder(
                "Replay v1.9\r\n/maps/setons_clutch.v0001/setons_clutch_scenario.lua"
            ),
            "setons_clutch.v0001"
        );
        assert_eq!(
            extract_map_folder("Replay v1.9\r\n\\maps\\neroxis_map_generator_1.22.1_abc_xyz\\neroxis_map_generator_1.22.1_abc_xyz_scenario.lua"),
            "neroxis_map_generator_1.22.1_abc_xyz"
        );
        assert_eq!(
            extract_map_folder("/maps/dual_gap_adaptive.v0002/dual_gap_adaptive_scenario.lua"),
            "dual_gap_adaptive.v0002"
        );
        assert_eq!(extract_map_folder("SCMP_009.scmap"), "SCMP_009");
    }

    /// A vault replay's head is all it takes to name the mission it was played
    /// on, which is the whole of issue #89: the API has no map for a co-op
    /// game, and the FAF replay server writes the literal string "None" into
    /// the envelope because its own game record has none either.
    #[test]
    fn a_replay_head_names_the_mission_the_listing_could_not() {
        let mut body = Vec::new();
        body.extend_from_slice(b"Supreme Commander v1.50.3836\0");
        body.extend_from_slice(b"\r\n\0");
        body.extend_from_slice(b"Replay v1.9\r\n/maps/SCCA_Coop_A03.v0023/SCCA_Coop_A03.scmap\0");
        body.extend_from_slice(b"\r\n\x1a\0");
        // Enough incompressible filler that the compressed stream runs well
        // past the range this fetches, so the truncated case below is the real
        // one rather than an accident of a tiny fixture.
        let mut seed = 1_u32;
        for _ in 0..(400 * 1024) {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            body.push((seed >> 24) as u8);
        }
        let compressed = zstd::stream::encode_all(&body[..], 0).unwrap();
        assert!(compressed.len() > REPLAY_HEAD_BYTES as usize);

        let head = |envelope: &str| {
            let mut bytes = envelope.as_bytes().to_vec();
            bytes.push(b'\n');
            bytes.extend_from_slice(&compressed);
            bytes
        };

        let served = head(r#"{"featured_mod":"coop","mapname":"None","compression":"zstd"}"#);
        assert_eq!(
            map_name_from_replay_head(&served).as_deref(),
            Some("SCCA_Coop_A03.v0023"),
            "the stream names the scenario the engine loaded"
        );

        // Only the head is fetched, so only the head may be needed.
        let truncated = &served[..REPLAY_HEAD_BYTES as usize];
        assert_eq!(
            map_name_from_replay_head(truncated).as_deref(),
            Some("SCCA_Coop_A03.v0023"),
            "a truncated stream still decodes the strings it opens with"
        );

        // A recording this client made fills the envelope in itself, and that
        // answer is taken without decompressing anything.
        let own = head(r#"{"mapname":"scca_coop_a03.v0023","compression":"zstd"}"#);
        assert_eq!(
            map_name_from_replay_head(&own).as_deref(),
            Some("scca_coop_a03.v0023")
        );

        assert_eq!(map_name_from_replay_head(b"not a replay at all"), None);
    }
}
