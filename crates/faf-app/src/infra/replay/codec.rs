//! The `.fafreplay` container: a JSON header line, then the `.scfareplay`
//! command stream compressed one of two ways.
//!
//! Separate from what the stream says (`scfa_header`, `details`) because this
//! layer knows nothing about the game: it splits the envelope off and
//! decompresses the body, bounded either way against a file that claims to
//! expand without limit.

use std::io::{Read, Write};
use std::path::Path;

use serde_json::Value;

use crate::infra::vault_install::MAX_DOWNLOAD_BYTES;

/// The decompressed command stream, plus the `.fafreplay` JSON header it came
/// wrapped in. The header is `None` for a legacy `.scfareplay`, which is the
/// bare stream with nothing in front of it.
pub(super) fn read_replay_header_and_body(path: &Path) -> Result<(Option<Value>, Vec<u8>), String> {
    let file_size = std::fs::metadata(path)
        .map_err(|error| format!("could not inspect replay file {}: {error}", path.display()))?
        .len();
    if file_size > MAX_DOWNLOAD_BYTES {
        return Err(format!(
            "replay file exceeds the allowed size of {} MB",
            MAX_DOWNLOAD_BYTES / (1024 * 1024)
        ));
    }
    let bytes = std::fs::read(path)
        .map_err(|error| format!("could not read replay file {}: {error}", path.display()))?;

    let is_fafreplay = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("fafreplay"));

    if !is_fafreplay {
        return Ok((None, bytes));
    }
    let (meta, body) = split_fafreplay_bytes(&bytes)?;
    let compression = meta
        .get("compression")
        .and_then(Value::as_str)
        .unwrap_or("qtcompress");
    let body_bytes = decompress_replay_body(body, compression)?;
    Ok((Some(meta), body_bytes))
}

fn split_fafreplay_bytes(bytes: &[u8]) -> Result<(Value, &[u8]), String> {
    let newline_idx = bytes
        .iter()
        .position(|&b| b == b'\n')
        .ok_or_else(|| "corrupted fafreplay: missing newline delimiter".to_string())?;
    let header_slice = &bytes[..newline_idx];
    let body_slice = &bytes[newline_idx + 1..];
    let meta: Value = serde_json::from_slice(header_slice)
        .map_err(|e| format!("corrupted fafreplay header: {e}"))?;
    Ok((meta, body_slice))
}

fn decompress_replay_body(body: &[u8], compression: &str) -> Result<Vec<u8>, String> {
    if compression.eq_ignore_ascii_case("zstd") {
        let decoder = zstd::stream::read::Decoder::new(body)
            .map_err(|e| format!("could not create zstd decoder: {e}"))?;
        let mut out = Vec::new();
        copy_bounded(decoder, &mut out)?;
        Ok(out)
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
        let zlib = flate2::read::ZlibDecoder::new(decoded);
        let mut out = Vec::new();
        let written = copy_bounded(zlib, &mut out)?;
        if written != u64::from(expected) {
            return Err("legacy replay size does not match its qCompress header".to_string());
        }
        Ok(out)
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
}
