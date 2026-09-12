//! The sound files a player has added, and the one directory they live in.
//!
//! The client ships five synthesised tones (see
//! `ui/src/features/notifications/notificationSound.ts`) and nothing else,
//! because a tone made of sine partials costs no file, no decoder and no
//! licence question. That is still true of the five. What it could not answer
//! is "I want *this* sound", which is what the request that brought this here
//! asked for, and no set of shipped tones ever answers that.
//!
//! So a player picks a file and the client keeps a copy. A copy rather than a
//! path, for two reasons: a path into somebody's Downloads folder stops working
//! the first time they tidy up, and a settings file that names a file inside
//! the client's own directory is one that can be carried to another machine
//! along with the directory. What is stored in the settings is therefore a
//! *file name*, never a path, and this module is the only thing that turns one
//! back into a location on disk.

use std::path::{Path, PathBuf};

/// Extensions a webview can decode. Checked on import so the failure is "that
/// is not a sound file" at the moment of picking, rather than silence weeks
/// later when the notification it was chosen for finally fires.
const PLAYABLE: [&str; 5] = ["wav", "mp3", "ogg", "flac", "m4a"];

/// Refuse anything larger. A notification tone is a second or two; a file this
/// size is a mistake, and the whole thing is read into memory to be decoded.
const MAX_BYTES: u64 = 5 * 1024 * 1024;

/// Where the copies live: `sounds/` under the client's data directory.
///
/// Under the data directory rather than the cache, because a cache cleaner is
/// entitled to delete a cache and a sound somebody chose is not disposable.
pub fn sounds_dir() -> Result<PathBuf, String> {
    Ok(super::data_dir()?.join("sounds"))
}

/// One stored sound's path, or an error naming what was wrong with the name.
///
/// The guard is the point of the function. A stored name comes out of a
/// settings file, which is a text file anybody can edit, so it is treated as
/// untrusted: anything with a separator or a parent component in it is refused
/// rather than joined onto the directory, which is how `../../` in a settings
/// file would otherwise read a file the client has no business reading.
pub fn sound_path(name: &str) -> Result<PathBuf, String> {
    if !is_safe_name(name) {
        return Err(format!("'{name}' is not a stored sound name"));
    }
    Ok(sounds_dir()?.join(name))
}

/// Whether a name is exactly one ordinary file name.
///
/// Split out and free of the filesystem so the rules are testable: no
/// separators, no parent or current directory, no empty string, and nothing
/// long enough to be a problem for the filesystem underneath.
pub(crate) fn is_safe_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 120
        && name != "."
        && name != ".."
        && !name.contains(['/', '\\', ':'])
        && !name.contains('\0')
        // A leading dot is a hidden file rather than a sound anybody picked.
        && !name.starts_with('.')
}

/// Whether this client can be expected to play the file.
pub(crate) fn is_playable_extension(name: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| PLAYABLE.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// The stored sounds, by name, sorted so the dropdown does not reshuffle.
///
/// A missing directory is an empty list, not an error: nobody has added a
/// sound yet, which is the normal state and not a problem to report.
pub fn list_sounds() -> Result<Vec<String>, String> {
    let dir = sounds_dir()?;
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(Vec::new());
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|entry| {
            entry
                .file_type()
                .map(|kind| kind.is_file())
                .unwrap_or(false)
        })
        .filter_map(|entry| entry.file_name().to_str().map(str::to_owned))
        .filter(|name| is_safe_name(name) && is_playable_extension(name))
        .collect();
    names.sort_by_key(|name| name.to_lowercase());
    Ok(names)
}

/// Copy a picked file into the sounds directory and return its stored name.
///
/// The name is the source file's own, so the dropdown says "horn.wav" rather
/// than an identifier nobody chose. A second file with a name already taken
/// gets a numbered suffix instead of overwriting the first: two sounds called
/// `notification.wav` from two different folders is the expected collision, and
/// silently replacing one of them would change a notification the player had
/// already set up.
pub fn import_sound(source: &Path) -> Result<String, String> {
    let name = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "that file has no usable name".to_string())?;
    if !is_playable_extension(name) {
        return Err(format!(
            "'{name}' is not a sound this client can play; use WAV, MP3, OGG, FLAC or M4A"
        ));
    }

    let size = std::fs::metadata(source)
        .map_err(|error| format!("could not read {}: {error}", source.display()))?
        .len();
    if size > MAX_BYTES {
        return Err(format!(
            "that file is {} MB; a notification sound is capped at {} MB",
            size / (1024 * 1024),
            MAX_BYTES / (1024 * 1024)
        ));
    }

    let dir = sounds_dir()?;
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("could not create {}: {error}", dir.display()))?;

    let stored = available_name(&dir, &sanitise(name));
    std::fs::copy(source, dir.join(&stored))
        .map_err(|error| format!("could not copy the sound in: {error}"))?;
    Ok(stored)
}

/// Delete one stored sound. A name that is not there is not an error: the
/// caller wanted it gone and it is.
pub fn remove_sound(name: &str) -> Result<(), String> {
    let path = sound_path(name)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("could not remove {}: {error}", path.display())),
    }
}

/// A file name reduced to what this module is willing to store.
///
/// Deliberately the same character set [`super::sanitize_folder_name`] uses,
/// plus the leading-dot rule, so a name that survives this is one
/// [`is_safe_name`] accepts.
pub(crate) fn sanitise(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            other if (other as u32) < 0x20 => '_',
            other => other,
        })
        .collect();
    let trimmed = cleaned.trim_start_matches('.').trim();
    let bounded = if trimmed.len() > 120 {
        // Keep the extension: it is what decides whether the file plays.
        let extension = Path::new(trimmed)
            .extension()
            .and_then(|ext| ext.to_str())
            .unwrap_or("wav")
            .to_string();
        let keep = 119 - extension.len().min(100);
        format!("{}.{}", &trimmed[..keep], extension)
    } else {
        trimmed.to_string()
    };
    if bounded.is_empty() {
        "sound.wav".to_string()
    } else {
        bounded
    }
}

/// `name`, or `name (2)` and upwards until nothing is in the way.
fn available_name(dir: &Path, name: &str) -> String {
    if !dir.join(name).exists() {
        return name.to_string();
    }
    let path = Path::new(name);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("sound");
    let extension = path.extension().and_then(|e| e.to_str()).unwrap_or("wav");
    for n in 2..1000 {
        let candidate = format!("{stem} ({n}).{extension}");
        if !dir.join(&candidate).exists() {
            return candidate;
        }
    }
    // A thousand files of the same name is not a case worth a distinct error.
    format!("{stem} ({}).{extension}", std::process::id())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stored_name_is_one_ordinary_file_name() {
        assert!(is_safe_name("horn.wav"));
        assert!(is_safe_name("my sound (2).mp3"));
        assert!(!is_safe_name(""));
        assert!(!is_safe_name("."));
        assert!(!is_safe_name(".."));
        assert!(!is_safe_name(".hidden.wav"));
    }

    #[test]
    fn a_name_that_walks_out_of_the_directory_is_refused() {
        // The settings file is editable text, so this is reachable without a
        // bug anywhere in the client.
        for escape in [
            "../../../etc/passwd",
            "..\\..\\windows\\system32\\config\\sam",
            "C:\\Windows\\notepad.exe",
            "sub/dir.wav",
        ] {
            assert!(!is_safe_name(escape), "{escape} should be refused");
            assert!(sound_path(escape).is_err(), "{escape} should not resolve");
        }
    }

    #[test]
    fn only_formats_a_webview_can_decode_are_accepted() {
        assert!(is_playable_extension("horn.wav"));
        assert!(is_playable_extension("HORN.WAV"));
        assert!(is_playable_extension("tune.mp3"));
        assert!(!is_playable_extension("notes.txt"));
        assert!(!is_playable_extension("payload.exe"));
        assert!(!is_playable_extension("nodots"));
    }

    #[test]
    fn sanitising_keeps_the_extension_and_strips_the_rest() {
        assert_eq!(sanitise("horn.wav"), "horn.wav");
        assert_eq!(sanitise("a/b:c.wav"), "a_b_c.wav");
        assert_eq!(sanitise("...hidden.wav"), "hidden.wav");
        assert_eq!(sanitise("   "), "sound.wav");

        let long = format!("{}.wav", "n".repeat(300));
        let bounded = sanitise(&long);
        assert!(bounded.len() <= 120, "{} chars", bounded.len());
        assert!(bounded.ends_with(".wav"));
        assert!(is_safe_name(&bounded));
    }

    #[test]
    fn a_second_file_of_the_same_name_does_not_replace_the_first() {
        let dir = std::env::temp_dir().join(format!("faf-sounds-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let _ = std::fs::remove_file(dir.join("horn.wav"));
        let _ = std::fs::remove_file(dir.join("horn (2).wav"));

        assert_eq!(available_name(&dir, "horn.wav"), "horn.wav");
        std::fs::write(dir.join("horn.wav"), b"first").unwrap();
        assert_eq!(available_name(&dir, "horn.wav"), "horn (2).wav");

        std::fs::remove_file(dir.join("horn.wav")).unwrap();
        std::fs::remove_dir_all(&dir).ok();
    }
}
