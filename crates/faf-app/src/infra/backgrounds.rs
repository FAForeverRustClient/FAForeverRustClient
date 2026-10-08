//! The picture behind the client's interface, when the player has picked one
//! (#439).
//!
//! Handled the way the notification sounds are: the picked file is copied into
//! the client's own data directory, the settings hold only the stored name, and
//! the webview reads it back as bytes. Copied rather than referenced, so moving
//! or deleting the original does not blank the window; read as bytes rather
//! than opened through the webview's asset protocol, which would have to be
//! opened up to the whole data directory to reach one file.

use std::path::{Path, PathBuf};

use super::notification_sounds::{is_safe_name, sanitise};

/// Formats every webview this client runs in can draw.
const IMAGES: [&str; 5] = ["png", "jpg", "jpeg", "webp", "gif"];

/// Refuse anything larger. A wallpaper at 4K is a few megabytes; the whole
/// file is read into memory every time the client starts.
const MAX_BYTES: u64 = 20 * 1024 * 1024;

/// Where the copy lives: `backgrounds/` under the client's data directory.
pub fn backgrounds_dir() -> Result<PathBuf, String> {
    Ok(super::data_dir()?.join("backgrounds"))
}

/// One stored picture's path. The name comes out of a settings file, which
/// anybody can edit, so anything but one plain file name is refused.
pub fn background_path(name: &str) -> Result<PathBuf, String> {
    if !is_safe_name(name) || !is_image(name) {
        return Err(format!("'{name}' is not a stored background"));
    }
    Ok(backgrounds_dir()?.join(name))
}

fn is_image(name: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| IMAGES.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Copy a picked picture in and return the name it was stored under.
///
/// Only one background is ever in use, so the pictures stored before it are
/// removed once the new one is in place: picking a few to compare should not
/// leave all of them on the disk.
pub fn import_background(source: &Path) -> Result<String, String> {
    let name = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "that file has no usable name".to_string())?;
    if !is_image(name) {
        return Err(format!(
            "'{name}' is not a picture this client can show; use PNG, JPEG, WebP or GIF"
        ));
    }
    let size = std::fs::metadata(source)
        .map_err(|error| format!("could not read {}: {error}", source.display()))?
        .len();
    if size > MAX_BYTES {
        return Err(format!(
            "that file is {} MB; a background is capped at {} MB",
            size / (1024 * 1024),
            MAX_BYTES / (1024 * 1024)
        ));
    }

    let dir = backgrounds_dir()?;
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("could not create {}: {error}", dir.display()))?;
    // A time prefix, so picking a file with the name of the current one still
    // stores a new name and the webview does not keep showing the old bytes.
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or_default();
    let stored = sanitise(&format!("{stamp}-{name}"));
    std::fs::copy(source, dir.join(&stored))
        .map_err(|error| format!("could not copy the picture in: {error}"))?;

    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            if entry.file_name().to_str() != Some(stored.as_str()) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    Ok(stored)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stored_name_has_to_be_one_picture_file() {
        // Refused before any directory is looked up, so these hold on a
        // machine with no data directory too.
        assert!(is_safe_name("1700000000-sunset.png") && is_image("1700000000-sunset.png"));
        assert!(background_path("../settings.json").is_err());
        assert!(background_path("notes.txt").is_err());
        assert!(background_path("").is_err());
    }
}
