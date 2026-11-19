//! The picture of a map that ships with Forged Alliance, read out of the
//! original game's own files.
//!
//! The preview service has art for the base-game maps, but not much of it:
//! `content.faforever.com/maps/previews/small/scmp_009.png` is 100 by 100
//! pixels, where a vault map's small preview is 128 and its large one 512. The
//! game tiles draw their picture well over twice that size, so a base-game map
//! was the one soft picture in a list of sharp ones. The service's large
//! preview of a base-game map is only 256 pixels, and it has the mass, hydro
//! and spawn markers drawn on, which the tiles leave off.
//!
//! The original game's `.scmap` carries the same terrain at 256 by 256 with
//! nothing drawn on it (see [`super::scmap`]), and every player has it: FAF
//! cannot start a game without the original install. Read from there, the
//! picture costs no download at all; where the game is not found, the page
//! falls back to the preview service as before.

use std::path::{Path, PathBuf};

use super::game_updater::is_base_game_map;

/// The preview of the base-game map `folder_name` (`scmp_009`, any case), as
/// PNG, from the original game at `original_game_dir`.
///
/// `None` for a name that is not a base-game map, which is also what keeps a
/// name off the wire from naming any other file, and for a map the install
/// does not have or whose preview does not decode.
pub fn preview_png(original_game_dir: &Path, folder_name: &str) -> Option<Vec<u8>> {
    let scmap = scmap_path(original_game_dir, folder_name)?;
    match super::scmap::preview_png(&scmap) {
        Ok(png) => Some(png),
        Err(error) => {
            tracing::debug!(%error, folder_name, "no preview in a base-game map");
            None
        }
    }
}

/// [`preview_png`] from the original game the install check reported
/// (`ResolvedPaths::original_game_dir`, empty when it found none), or, when
/// that check has not run yet, wherever discovery finds the game now. The
/// lobby can draw its first tiles before the check lands, and the page
/// remembers a miss for the rest of the session.
pub fn preview_png_from(checked_game_dir: Option<String>, folder_name: &str) -> Option<Vec<u8>> {
    if !is_base_game_map(folder_name) {
        return None;
    }
    let game = match checked_game_dir {
        Some(dir) => PathBuf::from(dir),
        None => super::game_updater::find_retail_install()?,
    };
    preview_png(&game, folder_name)
}

/// `<game>/maps/SCMP_009/SCMP_009.scmap`, matched without regard to case: the
/// game ships the folders upper case, and a case-sensitive file system (the
/// game under Wine) would otherwise miss every one of them for a name the
/// lobby sends lower case.
fn scmap_path(original_game_dir: &Path, folder_name: &str) -> Option<PathBuf> {
    if original_game_dir.as_os_str().is_empty() || !is_base_game_map(folder_name) {
        return None;
    }
    let folder = entry_named(&original_game_dir.join("maps"), folder_name)?;
    let scmap = entry_named(&folder, &format!("{folder_name}.scmap"))?;
    scmap.is_file().then_some(scmap)
}

/// The entry of `dir` called `name`, ignoring ASCII case.
fn entry_named(dir: &Path, name: &str) -> Option<PathBuf> {
    let exact = dir.join(name);
    if exact.exists() {
        return Some(exact);
    }
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .find(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .eq_ignore_ascii_case(name)
        })
        .map(|entry| entry.path())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A one-pixel `.scmap` as far as its preview goes: the magic, the two
    /// floats and the padding, the preview's length, and an uncompressed DDS
    /// whose bytes are blue, green, red, alpha.
    fn scmap_bytes() -> Vec<u8> {
        let mut dds = vec![0_u8; 128];
        dds[0..4].copy_from_slice(b"DDS ");
        dds[12..16].copy_from_slice(&1_u32.to_le_bytes());
        dds[16..20].copy_from_slice(&1_u32.to_le_bytes());
        dds[80..84].copy_from_slice(&0x41_u32.to_le_bytes());
        dds[88..92].copy_from_slice(&32_u32.to_le_bytes());
        for (at, mask) in [0x00ff_0000_u32, 0x0000_ff00, 0x0000_00ff, 0xff00_0000]
            .into_iter()
            .enumerate()
        {
            dds[92 + at * 4..96 + at * 4].copy_from_slice(&mask.to_le_bytes());
        }
        dds.extend_from_slice(&[1, 2, 3, 255]);

        let mut file = b"Map\x1a".to_vec();
        file.resize(30, 0);
        file.extend_from_slice(&(dds.len() as u32).to_le_bytes());
        file.extend_from_slice(&dds);
        file.extend_from_slice(&60_u32.to_le_bytes());
        file
    }

    /// An original game holding `SCMP_009` the way the game ships it.
    fn game_with_setons_clutch() -> tempfile::TempDir {
        let game = tempfile::tempdir().unwrap();
        let folder = game.path().join("maps").join("SCMP_009");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("SCMP_009.scmap"), scmap_bytes()).unwrap();
        game
    }

    #[test]
    fn a_base_game_map_is_read_from_the_original_game_in_any_case() {
        let game = game_with_setons_clutch();
        for name in ["scmp_009", "SCMP_009", "Scmp_009"] {
            let png = preview_png(game.path(), name).expect("the map's preview");
            assert_eq!(&png[1..4], b"PNG", "{name}");
        }
    }

    #[test]
    fn a_map_the_game_does_not_ship_is_not_looked_for() {
        let game = game_with_setons_clutch();
        // A vault map, a version of a base-game folder, and names that try to
        // step out of the maps folder: none of them is a base-game map.
        for name in [
            "setons_clutch.v0002",
            "scmp_009.v0001",
            "../scmp_009",
            "scmp_009/../x",
        ] {
            assert_eq!(preview_png(game.path(), name), None, "{name}");
        }
    }

    #[test]
    fn a_missing_install_or_map_has_no_preview() {
        let game = game_with_setons_clutch();
        assert_eq!(preview_png(Path::new(""), "scmp_009"), None);
        assert_eq!(preview_png(game.path(), "scmp_001"), None);
    }

    #[test]
    fn the_checked_install_is_the_one_read() {
        let game = game_with_setons_clutch();
        let dir = game.path().display().to_string();
        assert!(preview_png_from(Some(dir), "scmp_009").is_some());
        // Checked and found nothing: no game to read, and no discovery either.
        assert_eq!(preview_png_from(Some(String::new()), "scmp_009"), None);
        // Not a base-game map: refused before anything is looked up.
        assert_eq!(preview_png_from(None, "setons_clutch.v0002"), None);
    }

    #[test]
    fn a_damaged_map_file_has_no_preview() {
        let game = tempfile::tempdir().unwrap();
        let folder = game.path().join("maps").join("SCMP_009");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("SCMP_009.scmap"), b"not a map").unwrap();
        assert_eq!(preview_png(game.path(), "scmp_009"), None);
    }
}
