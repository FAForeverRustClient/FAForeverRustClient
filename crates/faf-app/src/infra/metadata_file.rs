//! Reading a map's or a mod's metadata file without trusting its size.
//!
//! A map's `_scenario.lua` and `_save.lua` and a mod's `mod_info.lua` arrive
//! inside vault archives, which may expand to gigabytes (`vault_install`), and
//! the client reads them to list what is installed, to check an install, and
//! to upload one. `fs::read_to_string` allocated whatever size the file had,
//! so one oversized file in an archive was read whole into memory. Every read
//! of one goes through here instead, against a limit named for the file.
//!
//! What a parse keeps of a file is capped too ([`MAX_NAME_BYTES`] and the
//! limits beside it). A file within the read limit can still be almost all
//! description, and the installed lists and their cache keep what was parsed
//! for as long as the client runs.

use std::io::Read as _;
use std::path::Path;

/// The most of a `_scenario.lua` or a `mod_info.lua` read into memory.
///
/// Both are a few kilobytes. A long description or a long list of conflicts
/// adds kilobytes, not megabytes, so this is hundreds of times what a real one
/// needs and still nothing to hold in memory.
pub(crate) const MAX_METADATA_BYTES: u64 = 1024 * 1024;

/// The most of a name kept from a metadata file: a map's or a mod's name, or
/// a mod's author. Real ones are a few dozen characters.
pub(crate) const MAX_NAME_BYTES: usize = 256;

/// The most of a description kept. Real ones are a few sentences, and the
/// longest, with a changelog written into them, a few kilobytes.
pub(crate) const MAX_DESCRIPTION_BYTES: usize = 16 * 1024;

/// The longest identifier kept or accepted: a mod's `uid`, a version, a
/// scenario's `type`. A uid is a GUID, 36 characters, or a short slug.
pub(crate) const MAX_IDENTIFIER_BYTES: usize = 128;

/// `text` cut to at most `max_bytes`, at a character boundary.
///
/// For what is only shown (names, descriptions, versions): a long one loses
/// its end and the rest still reads. An identifier that is compared, such as a
/// mod's uid, is refused instead, since a shortened one could match another.
pub(crate) fn truncated(mut text: String, max_bytes: usize) -> String {
    if text.len() > max_bytes {
        let mut end = max_bytes;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
    }
    text
}

/// `path`'s bytes, refused with [`std::io::ErrorKind::FileTooLarge`] once they
/// pass `max_bytes`.
///
/// The length the file system states is refused up front, and the read itself
/// stops one byte past the limit, so a file that grows between the two is
/// refused as well, never read whole.
pub(crate) fn read_bounded(path: &Path, max_bytes: u64) -> std::io::Result<Vec<u8>> {
    let file = std::fs::File::open(path)?;
    let stated = file.metadata()?.len();
    if stated > max_bytes {
        return Err(too_large(path, max_bytes));
    }
    let mut bytes = Vec::with_capacity(usize::try_from(stated).unwrap_or(0));
    file.take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > max_bytes {
        return Err(too_large(path, max_bytes));
    }
    Ok(bytes)
}

/// [`read_bounded`] as UTF-8 text, refused like `fs::read_to_string` refuses
/// bytes that are not.
pub(crate) fn read_bounded_to_string(path: &Path, max_bytes: u64) -> std::io::Result<String> {
    String::from_utf8(read_bounded(path, max_bytes)?)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))
}

/// [`read_bounded_to_string`] on the blocking pool, for async callers.
pub(crate) async fn read_bounded_to_string_async(
    path: &Path,
    max_bytes: u64,
) -> std::io::Result<String> {
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || read_bounded_to_string(&path, max_bytes))
        .await
        .map_err(std::io::Error::other)?
}

fn too_large(path: &Path, max_bytes: u64) -> std::io::Error {
    const MIB: u64 = 1024 * 1024;
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string());
    let limit = if max_bytes >= MIB {
        format!("{} MiB", max_bytes / MIB)
    } else {
        format!("{max_bytes} bytes")
    };
    std::io::Error::new(
        std::io::ErrorKind::FileTooLarge,
        format!("{name} is larger than the {limit} allowed for it"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The case the limit exists for: refused by name and limit, and with an
    /// error a caller can tell from a missing file.
    #[test]
    fn an_oversized_metadata_file_is_refused_rather_than_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big_scenario.lua");
        std::fs::write(&path, vec![b'-'; 2 * 1024 * 1024 + 1]).unwrap();

        let error = read_bounded_to_string(&path, 2 * 1024 * 1024)
            .expect_err("a file past its limit must not be read");
        assert_eq!(error.kind(), std::io::ErrorKind::FileTooLarge);
        assert_eq!(
            error.to_string(),
            "big_scenario.lua is larger than the 2 MiB allowed for it"
        );

        // Exactly at the limit is still a metadata file.
        let at_limit = dir.path().join("mod_info.lua");
        std::fs::write(&at_limit, b"uid = \"a\"").unwrap();
        assert_eq!(read_bounded_to_string(&at_limit, 9).unwrap(), "uid = \"a\"");
        assert_eq!(
            read_bounded(&at_limit, 8).unwrap_err().kind(),
            std::io::ErrorKind::FileTooLarge
        );
    }

    #[test]
    fn a_kept_field_is_cut_at_a_character_boundary() {
        assert_eq!(truncated("short".into(), 16), "short");
        assert_eq!(truncated("abcdef".into(), 4), "abcd");
        // "é" is two bytes: a cut through it keeps the character before.
        assert_eq!(truncated("aé".into(), 2), "a");
    }
}
