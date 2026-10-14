//! The `.fafreplay` container: a JSON header line, then the `.scfareplay`
//! command stream compressed one of two ways.
//!
//! Separate from what the stream says (`scfa_header`, `details`) because this
//! layer knows nothing about the game: it splits the envelope off and
//! decompresses the body, bounded either way against a file that claims to
//! expand without limit.

use std::io::{BufRead, Read, Write};
use std::path::Path;

use serde_json::Value;

use crate::infra::vault_install::MAX_DOWNLOAD_BYTES;

/// A replay's command stream, decompressed as it is read.
pub(super) type ReplayStream = Box<dyn Read + Send>;

/// The `.fafreplay` JSON header, and the command stream behind it as a reader
/// that decompresses as it goes. The header is `None` for a legacy
/// `.scfareplay`, which is the bare stream with nothing in front of it.
///
/// A stream, not a buffer: details and analysis walk the command records once,
/// front to back, and holding the whole expansion to do that cost up to the
/// 1 GiB cap in memory for one replay. Only the header line is read whole.
///
/// The stream ends at [`MAX_DECOMPRESSED_REPLAY_BYTES`], and a legacy body at
/// the size its `qCompress` prefix states. Past either there is nothing more
/// to read, which the walkers take as the end of the game. Playback, which
/// hands the stream to FA, still refuses such a file outright
/// ([`decode_replay_body_to`]).
pub(super) fn open_replay_stream(path: &Path) -> Result<(Option<Value>, ReplayStream), String> {
    let file_size = std::fs::metadata(path)
        .map_err(|error| format!("could not inspect replay file {}: {error}", path.display()))?
        .len();
    if file_size > MAX_DOWNLOAD_BYTES {
        return Err(format!(
            "replay file exceeds the allowed size of {} MB",
            MAX_DOWNLOAD_BYTES / (1024 * 1024)
        ));
    }
    let file = std::fs::File::open(path)
        .map_err(|error| format!("could not read replay file {}: {error}", path.display()))?;
    let mut reader = std::io::BufReader::new(file);

    let is_fafreplay = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("fafreplay"));

    if !is_fafreplay {
        return Ok((None, Box::new(reader)));
    }
    let mut line = Vec::new();
    (&mut reader)
        .take(MAX_HEADER_LINE_BYTES)
        .read_until(b'\n', &mut line)
        .map_err(|error| format!("could not read replay file {}: {error}", path.display()))?;
    if line.pop() != Some(b'\n') {
        return Err("corrupted fafreplay: missing newline delimiter".to_string());
    }
    let meta: Value =
        serde_json::from_slice(&line).map_err(|e| format!("corrupted fafreplay header: {e}"))?;
    let compression = meta
        .get("compression")
        .and_then(Value::as_str)
        .unwrap_or("qtcompress");
    let stream = decompressing(reader, compression)?;
    Ok((Some(meta), stream))
}

/// The longest JSON header line read. A real one is a few kilobytes: the
/// teams, the featured mod and its file versions.
const MAX_HEADER_LINE_BYTES: u64 = 16 * 1024 * 1024;

fn decompressing(
    body: impl BufRead + Send + 'static,
    compression: &str,
) -> Result<ReplayStream, String> {
    if compression.eq_ignore_ascii_case("zstd") {
        let decoder = zstd::stream::read::Decoder::with_buffer(body)
            .map_err(|e| format!("could not create zstd decoder: {e}"))?;
        Ok(Box::new(decoder.take(MAX_DECOMPRESSED_REPLAY_BYTES)))
    } else {
        let mut decoded =
            base64::read::DecoderReader::new(body, &base64::engine::general_purpose::STANDARD);
        let mut uncompressed_size = [0; 4];
        decoded
            .read_exact(&mut uncompressed_size)
            .map_err(|e| format!("invalid legacy replay body size: {e}"))?;
        let expected = u32::from_be_bytes(uncompressed_size);
        if u64::from(expected) > MAX_DECOMPRESSED_REPLAY_BYTES {
            return Err("replay expands beyond the allowed size".to_string());
        }
        Ok(Box::new(
            flate2::read::ZlibDecoder::new(decoded).take(u64::from(expected)),
        ))
    }
}

/// The most of a command stream read into memory to get past its head. The
/// head is a handful of Lua tables (the mods, the scenario, one per army),
/// kilobytes in a real replay.
const MAX_HEAD_BYTES: usize = 16 * 1024 * 1024;

/// What a head is first read with, before it has to grow.
const FIRST_HEAD_BYTES: usize = 64 * 1024;

/// Read the head of a command stream into memory until `parse` can make sense
/// of it, and leave the records behind it in the stream.
///
/// The head is parsed from a slice, because its Lua tables are read with a
/// cursor that looks ahead; the records are not, because they are most of a
/// replay. So the head is read in doubling steps: `parse` gets everything read
/// so far and whether that is all it will get (the stream ended, or
/// [`MAX_HEAD_BYTES`] was reached), and answers what it read and where the
/// head ended, or `None` while it needs more. Given the last of it, it has to
/// answer. Returned with that answer are the bytes already read past the head,
/// which are the first of the records.
pub(crate) fn read_head<T>(
    stream: &mut impl Read,
    parse: impl Fn(&[u8], bool) -> Option<(T, usize)>,
) -> Result<(T, Vec<u8>), String> {
    let mut bytes = Vec::new();
    let mut wanted = FIRST_HEAD_BYTES;
    loop {
        let missing = (wanted - bytes.len()) as u64;
        let read = stream
            .by_ref()
            .take(missing)
            .read_to_end(&mut bytes)
            .map_err(|error| format!("could not decompress replay: {error}"))?;
        let last = (read as u64) < missing || wanted >= MAX_HEAD_BYTES;
        if let Some((parsed, end)) = parse(&bytes, last) {
            let rest = bytes.split_off(end.min(bytes.len()));
            return Ok((parsed, rest));
        }
        if last {
            return Err("replay header could not be read".to_string());
        }
        wanted = (wanted * 2).min(MAX_HEAD_BYTES);
    }
}

const MAX_DECOMPRESSED_REPLAY_BYTES: u64 = 1024 * 1024 * 1024;

/// Stream a replay body into a private file and publish it only after the full
/// decode succeeds. This bounds both zstd and legacy qCompress expansion and
/// avoids holding the expanded command stream in memory.
pub(super) fn decode_replay_body_to(
    body: &[u8],
    is_zstd: bool,
    output: &Path,
) -> Result<(), String> {
    let parent = output
        .parent()
        .ok_or_else(|| "replay cache path has no parent".to_string())?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("could not create replay cache file: {error}"))?;

    let written = if is_zstd {
        let decoder = zstd::stream::read::Decoder::new(body)
            .map_err(|error| format!("could not decompress replay: {error}"))?;
        copy_bounded(decoder, &mut temporary)?
    } else {
        decode_legacy_qcompress_to(body, &mut temporary)?
    };
    if written > MAX_DECOMPRESSED_REPLAY_BYTES {
        return Err("replay expands beyond the allowed size".into());
    }
    temporary
        .flush()
        .map_err(|error| format!("could not finish replay cache file: {error}"))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| format!("could not sync replay cache file: {error}"))?;
    temporary
        .persist(output)
        .map(|_| ())
        .map_err(|error| format!("could not publish replay cache file: {}", error.error))
}

fn copy_bounded(
    mut reader: impl std::io::Read,
    writer: &mut impl std::io::Write,
) -> Result<u64, String> {
    let mut limited = reader.by_ref().take(MAX_DECOMPRESSED_REPLAY_BYTES + 1);
    let written = std::io::copy(&mut limited, writer)
        .map_err(|error| format!("could not decompress replay: {error}"))?;
    if written > MAX_DECOMPRESSED_REPLAY_BYTES {
        return Err("replay expands beyond the allowed size".into());
    }
    Ok(written)
}

/// Legacy `.fafreplay` body format: standard base64, decoding to Qt's
/// `qCompress` container: a 4-byte big-endian uncompressed-length prefix
/// followed by a raw zlib stream. Mirrors `qUncompress(QByteArray.fromBase64(..))`
/// in the Python client's `fa/replay.py`.
fn decode_legacy_qcompress_to(
    body: &[u8],
    writer: &mut impl std::io::Write,
) -> Result<u64, String> {
    use std::io::Read as _;

    let mut decoded =
        base64::read::DecoderReader::new(body, &base64::engine::general_purpose::STANDARD);
    let mut prefix = [0_u8; 4];
    decoded
        .read_exact(&mut prefix)
        .map_err(|error| format!("could not read legacy qCompress header: {error}"))?;
    let expected = u32::from_be_bytes(prefix);
    if u64::from(expected) > MAX_DECOMPRESSED_REPLAY_BYTES {
        return Err("replay expands beyond the allowed size".into());
    }
    let written = copy_bounded(flate2::read::ZlibDecoder::new(decoded), writer)?;
    if written != u64::from(expected) {
        return Err("legacy replay size does not match its qCompress header".into());
    }
    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_replay_rejects_an_oversized_advertised_expansion() {
        use base64::Engine as _;

        let dir = tempfile::tempdir().expect("temporary replay directory");
        let output = dir.path().join("expanded.scfareplay");
        let body = base64::engine::general_purpose::STANDARD
            .encode(((MAX_DECOMPRESSED_REPLAY_BYTES + 1) as u32).to_be_bytes());

        let error = decode_replay_body_to(body.as_bytes(), false, &output)
            .expect_err("oversized replay must fail");

        assert!(error.contains("expands beyond"));
        assert!(!output.exists(), "a rejected replay must not be published");
    }

    /// The command stream every case below wraps: long enough to span several
    /// reads of every decoder.
    fn command_stream() -> Vec<u8> {
        (0..300_000u32).map(|n| (n % 251) as u8).collect()
    }

    fn opened(dir: &tempfile::TempDir, compression: &str, body: &[u8]) -> (Value, Vec<u8>) {
        let path = dir.path().join(format!("{compression}.fafreplay"));
        let mut file = format!("{{\"compression\":\"{compression}\"}}\n").into_bytes();
        file.extend_from_slice(body);
        std::fs::write(&path, file).expect("replay written");
        let (meta, mut stream) = open_replay_stream(&path).expect("replay opens");
        let mut read = Vec::new();
        stream.read_to_end(&mut read).expect("stream reads");
        (meta.expect("a fafreplay has a header"), read)
    }

    #[test]
    fn a_zstd_replay_opens_as_its_command_stream() {
        let dir = tempfile::tempdir().expect("temporary replay directory");
        let body = zstd::encode_all(command_stream().as_slice(), 3).expect("zstd encodes");
        let (meta, read) = opened(&dir, "zstd", &body);
        assert_eq!(meta["compression"], "zstd");
        assert_eq!(read, command_stream());
    }

    #[test]
    fn a_legacy_replay_opens_as_its_command_stream() {
        use base64::Engine as _;

        let dir = tempfile::tempdir().expect("temporary replay directory");
        let stream = command_stream();
        let mut zlib = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        zlib.write_all(&stream).expect("zlib encodes");
        let mut qcompress = (stream.len() as u32).to_be_bytes().to_vec();
        qcompress.extend(zlib.finish().expect("zlib finishes"));
        let body = base64::engine::general_purpose::STANDARD.encode(qcompress);

        let (_, read) = opened(&dir, "qtcompress", body.as_bytes());
        assert_eq!(read, stream);
    }

    #[test]
    fn a_head_is_read_until_it_parses_and_the_rest_is_left_for_the_records() {
        // A "head" that is everything up to the first zero byte, placed past
        // the first read so it has to grow.
        let mut stream = vec![1u8; FIRST_HEAD_BYTES * 3];
        stream.extend_from_slice(&[0, 7, 8, 9]);
        let mut reader = stream.as_slice();
        let (head_length, rest) = read_head(&mut reader, |bytes, _| {
            let end = bytes.iter().position(|byte| *byte == 0)?;
            Some((end, end + 1))
        })
        .expect("the head is found");
        assert_eq!(head_length, FIRST_HEAD_BYTES * 3);
        let mut records = rest;
        records.extend_from_slice(reader);
        assert_eq!(records, [7, 8, 9]);
    }
}
