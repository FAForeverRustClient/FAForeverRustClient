//! Unit build icons and strategic icons, read out of the game files on this
//! machine, for the unit history's grid.
//!
//! The same pictures the game's own interface draws: `textures/ui/common/
//! icons/units/<id>_icon.dds` and `textures/ui/common/game/strategicicons/
//! <name>_rest.dds`, from the original game's `textures.scd` with FAF's
//! `textures.nx2` over it. Read from disk rather than a website because the
//! site the patch notes take their icons from has none for a fair number of
//! units, and the installed game has every unit it can build.
//!
//! The pictures reach the page through a shell command of their own rather
//! than the application state: they are a few megabytes, wanted only while
//! the section is open, and never change while the client runs. They are
//! read once per game install and kept for the session.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use faf_domain::protocol::dds::{decode_dds, DecodedImage};
use serde::Serialize;

/// The pictures, as `data:image/png;base64,...` URLs.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitIcons {
    /// By upper-case blueprint id.
    pub units: BTreeMap<String, String>,
    /// By lower-case strategic icon name, `icon_land1_directfire`.
    pub strategic: BTreeMap<String, String>,
}

/// Units that have no icon of their own and show another's, as the FAF unit
/// database (FAForever/etfreeman-db, `vite-plugin-spritesmith.js`) does: a
/// headquarters factory and its support factory share one picture, and an
/// egg shows the unit that hatches from it. Tried in both directions, only
/// for a unit that has no picture of its own.
const SHARED_ICONS: [(&str, &str); 29] = [
    ("UEB0201", "ZEB9501"),
    ("UEB0202", "ZEB9502"),
    ("UEB0203", "ZEB9503"),
    ("UEB0301", "ZEB9601"),
    ("UEB0302", "ZEB9602"),
    ("UEB0303", "ZEB9603"),
    ("URB0201", "ZRB9501"),
    ("URB0202", "ZRB9502"),
    ("URB0203", "ZRB9503"),
    ("URB0301", "ZRB9601"),
    ("URB0302", "ZRB9602"),
    ("URB0303", "ZRB9603"),
    ("UAB0201", "ZAB9501"),
    ("UAB0202", "ZAB9502"),
    ("UAB0203", "ZAB9503"),
    ("UAB0301", "ZAB9601"),
    ("UAB0302", "ZAB9602"),
    ("UAB0303", "ZAB9603"),
    ("XSB0201", "ZSB9501"),
    ("XSB0202", "ZSB9502"),
    ("XSB0203", "ZSB9503"),
    ("XSB0301", "ZSB9601"),
    ("XSB0302", "ZSB9602"),
    ("XSB0303", "ZSB9603"),
    ("XRL0003", "XRL0305"),
    ("DRLK005", "DRLK001"),
    ("XRL0005", "URL0304"),
    ("XRL0004", "URL0205"),
    ("XRL0002", "URL0309"),
];

/// An icon file larger than this is not an interface icon.
const MAX_ICON_BYTES: u64 = 1024 * 1024;

/// The icons for the install whose executable is `game_path`, read once per
/// install and kept for the session.
pub fn unit_icons(game_path: &str) -> Arc<UnitIcons> {
    /// The executable the icons were read for, and the icons.
    type Held = Option<(String, Arc<UnitIcons>)>;
    static READ: OnceLock<Mutex<Held>> = OnceLock::new();
    let held = READ.get_or_init(Mutex::default);
    let mut held = held
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some((path, icons)) = held.as_ref() {
        if path == game_path {
            return icons.clone();
        }
    }
    let install = install_dir_of(game_path);
    let retail = super::game_updater::find_retail_install();
    let icons = Arc::new(read_icons(
        retail.map(|dir| dir.join("gamedata").join("textures.scd")),
        install.map(|dir| dir.join("gamedata").join("textures.nx2")),
    ));
    *held = Some((game_path.to_owned(), icons.clone()));
    icons
}

/// `…/FAForever/bin/ForgedAlliance.exe` → `…/FAForever`.
pub(super) fn install_dir_of(game_path: &str) -> Option<PathBuf> {
    let path = Path::new(game_path);
    path.parent()?
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .map(Path::to_path_buf)
}

fn read_icons(base: Option<PathBuf>, faf: Option<PathBuf>) -> UnitIcons {
    let mut icons = UnitIcons::default();
    // The base game first, then FAF's copies over it.
    for archive in [base, faf].into_iter().flatten() {
        if let Err(error) = read_archive(&archive, &mut icons) {
            tracing::warn!(archive = %archive.display(), %error, "could not read unit icons");
        }
    }
    for (one, other) in SHARED_ICONS {
        for (missing, present) in [(one, other), (other, one)] {
            if !icons.units.contains_key(missing) {
                if let Some(picture) = icons.units.get(present).cloned() {
                    icons.units.insert(missing.to_owned(), picture);
                }
            }
        }
    }
    icons
}

fn read_archive(archive: &Path, icons: &mut UnitIcons) -> Result<(), String> {
    let file = std::fs::File::open(archive).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(std::io::BufReader::new(file)).map_err(|e| e.to_string())?;
    for index in 0..zip.len() {
        let Ok(mut entry) = zip.by_index(index) else {
            continue;
        };
        let Ok(name) = entry.name() else {
            continue;
        };
        let name = name.replace('\\', "/").to_ascii_lowercase();
        let target = if let Some(file) = name.strip_prefix("textures/ui/common/icons/units/") {
            file.strip_suffix("_icon.dds")
                .filter(|id| !id.contains('/'))
                .map(|id| (true, id.to_ascii_uppercase()))
        } else if let Some(file) = name.strip_prefix("textures/ui/common/game/strategicicons/") {
            file.strip_suffix("_rest.dds")
                .filter(|icon| !icon.contains('/'))
                .map(|icon| (false, icon.to_owned()))
        } else {
            None
        };
        let Some((unit, key)) = target else {
            continue;
        };
        if entry.size() > MAX_ICON_BYTES {
            continue;
        }
        let mut bytes = Vec::new();
        if entry.read_to_end(&mut bytes).is_err() {
            continue;
        }
        let Ok(image) = decode_dds(&bytes) else {
            continue;
        };
        let url = data_url(&image);
        if unit {
            icons.units.insert(key, url);
        } else {
            icons.strategic.insert(key, url);
        }
    }
    Ok(())
}

fn data_url(image: &DecodedImage) -> String {
    super::png::png_data_url(image.width, image.height, &image.rgba)
}

#[cfg(test)]
mod tests {
    use std::io::Write as _;

    use super::*;

    fn dds_4x4_red() -> Vec<u8> {
        let mut bytes = vec![0_u8; 128];
        bytes[0..4].copy_from_slice(b"DDS ");
        bytes[12..16].copy_from_slice(&4_u32.to_le_bytes());
        bytes[16..20].copy_from_slice(&4_u32.to_le_bytes());
        bytes[80..84].copy_from_slice(&4_u32.to_le_bytes());
        bytes[84..88].copy_from_slice(b"DXT5");
        bytes.extend_from_slice(&[255, 255, 0, 0, 0, 0, 0, 0]);
        bytes.extend_from_slice(&0xf800_u16.to_le_bytes());
        bytes.extend_from_slice(&0xf800_u16.to_le_bytes());
        bytes.extend_from_slice(&[0; 4]);
        bytes
    }

    fn archive(dir: &Path, name: &str, files: &[(&str, Vec<u8>)]) -> PathBuf {
        let path = dir.join(name);
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
        for (file, bytes) in files {
            zip.start_file(*file, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap();
        path
    }

    #[test]
    fn icons_come_from_both_archives_and_shared_pictures_fill_gaps() {
        let dir = tempfile::tempdir().unwrap();
        let base = archive(
            dir.path(),
            "textures.scd",
            &[
                (
                    "textures/ui/common/icons/units/uel0201_icon.dds",
                    dds_4x4_red(),
                ),
                (
                    "textures/ui/common/game/strategicicons/icon_land1_directfire_rest.dds",
                    dds_4x4_red(),
                ),
                (
                    "textures/ui/common/game/strategicicons/icon_land1_directfire_over.dds",
                    dds_4x4_red(),
                ),
            ],
        );
        let faf = archive(
            dir.path(),
            "textures.nx2",
            &[
                (
                    "textures/ui/common/icons/units/ZEB9501_icon.dds",
                    dds_4x4_red(),
                ),
                (
                    "textures/ui/common/icons/units/broken_icon.dds",
                    b"not a dds".to_vec(),
                ),
            ],
        );
        let icons = read_icons(Some(base), Some(faf));
        assert!(icons.units["UEL0201"].starts_with("data:image/png;base64,"));
        assert!(icons.units.contains_key("ZEB9501"));
        assert_eq!(
            icons.units.get("UEB0201"),
            icons.units.get("ZEB9501"),
            "the headquarters shows its support factory's picture"
        );
        assert!(!icons.units.contains_key("BROKEN"));
        assert_eq!(
            icons.strategic.keys().collect::<Vec<_>>(),
            ["icon_land1_directfire"]
        );
    }

    #[test]
    fn the_install_is_two_folders_up_from_the_game() {
        assert_eq!(
            install_dir_of("C:/ProgramData/FAForever/bin/ForgedAlliance.exe"),
            Some(PathBuf::from("C:/ProgramData/FAForever"))
        );
        assert_eq!(install_dir_of("ForgedAlliance.exe"), None);
    }
}
