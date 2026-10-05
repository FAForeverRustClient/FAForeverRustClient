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
    read_replay_body_prefix_limit(&mut reader, LOCAL_REPLAY_BODY_PREFIX_BYTES as usize)
}

fn read_replay_body_prefix_limit(mut reader: impl Read, limit: usize) -> Vec<u8> {
    let mut prefix = Vec::new();
    let mut chunk = [0_u8; 16 * 1024];
    while prefix.len() < limit {
        let remaining = limit - prefix.len();
        let size = remaining.min(chunk.len());
        match reader.read(&mut chunk[..size]) {
            Ok(0) | Err(_) => break,
            Ok(read) => prefix.extend_from_slice(&chunk[..read]),
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
    let _sim_mods = parse_replay_lua(&mut cursor, 0);
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
            ..Default::default()
        };
    };
    let mut sources = Vec::with_capacity(source_count as usize);
    for _ in 0..source_count {
        let Some(name) = replay_string(&mut cursor) else {
            return LocalBodyInfo {
                map_name,
                game_version,
                ..Default::default()
            };
        };
        let Some(_) = replay_u32(&mut cursor) else {
            return LocalBodyInfo {
                map_name,
                game_version,
                ..Default::default()
            };
        };
        sources.push(name);
    }
    if replay_u8(&mut cursor).is_none() {
        return LocalBodyInfo {
            map_name,
            game_version,
            ..Default::default()
        };
    }
    let Some(army_count) = replay_u8(&mut cursor) else {
        return LocalBodyInfo {
            map_name,
            game_version,
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
        map_name,
        game_version,
    }
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
    // Truncated for the same reason as `displayed_rating_with_fields`: this is
    // the same number read from a local replay's header instead of the vault,
    // and the two must not disagree about the same player.
    let rating = mean - 3.0 * deviation;
    (rating.is_finite() && rating >= f64::from(i32::MIN) && rating <= f64::from(i32::MAX))
        .then_some(rating as i32)
}

#[cfg(test)]
mod tests {
    use super::*;
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
