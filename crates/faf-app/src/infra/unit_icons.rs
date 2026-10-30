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
//! Reading every picture up front made the grid wait on more than a thousand
//! decodes and a few megabytes through the shell before it drew a single
//! icon. So the first ask reads only the archives' directories, which takes a
//! moment however many pictures there are, and answers with the names it
//! found; each picture is decoded when the page loads it, through the shell's
//! `unit-icon` scheme. The page loads only the icons it shows.
//!
//! A decoded picture is kept as a PNG file in the cache folder, so decoding
//! happens once per game version rather than once per session: a later
//! session reads small files. The first ask also starts filling that folder
//! with every picture in the background, so even the first session spends
//! the decoding only once. The folder notes which archives it was filled
//! from, their sizes and times, and starts over when one of them changes.
//!
//! A strategic icon is grey in the archive, and the game draws it in the
//! player's colour. The page shows it in its faction's, drawn here exactly as
//! the FAF unit database draws its own (see [`tint`]).

use std::collections::{BTreeMap, HashSet};
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};

use faf_domain::protocol::dds::{decode_dds, DecodedImage};
use serde::Serialize;

/// The pictures the installed game has, by the names the page asks for them.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitIcons {
    /// Upper-case blueprint ids.
    pub units: Vec<String>,
    /// Lower-case strategic icon names, `icon_land1_directfire`.
    pub strategic: Vec<String>,
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

/// The colour each faction's strategic icons are drawn in, as the page's
/// addresses name the faction: the FAF unit database's
/// (FAForever/etfreeman-db, its `img/strategic` sprites).
const FACTION_COLOURS: [(&str, [u8; 3]); 4] = [
    ("uef", [85, 170, 255]),
    ("aeon", [32, 255, 32]),
    ("cybran", [255, 80, 80]),
    ("seraphim", [255, 190, 44]),
];

/// Draws a strategic icon in a faction's colour the way the FAF unit
/// database's sprites have it, checked pixel by pixel against 353 of them:
/// its dark edge black, every grey the colour itself, white and the few
/// coloured marks as they are.
fn tint(rgba: &mut [u8], colour: [u8; 3]) {
    let (pixels, _) = rgba.as_chunks_mut::<4>();
    for pixel in pixels {
        if pixel[3] == 0 {
            continue;
        }
        let (Some(&high), Some(&low)) = (pixel[..3].iter().max(), pixel[..3].iter().min()) else {
            continue;
        };
        if high <= 64 {
            pixel[..3].copy_from_slice(&[0, 0, 0]);
        } else if low < 230 && high - low <= 24 {
            pixel[..3].copy_from_slice(&colour);
        }
    }
}

/// The two kinds of picture, as the page's addresses name them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Kind {
    Unit,
    Strategic,
}

/// What an address asks for: a picture, and for a strategic icon the faction
/// whose colour it is drawn in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Picture<'a> {
    kind: Kind,
    key: &'a str,
    /// An index into [`FACTION_COLOURS`].
    faction: Option<usize>,
}

impl Picture<'_> {
    /// `unit-UEL0201`, `strategic-icon_land1_directfire` or
    /// `strategic-cybran-icon_land1_directfire`.
    fn parse(address: &str) -> Option<Picture<'_>> {
        if let Some(key) = address.strip_prefix("unit-") {
            return Some(Picture {
                kind: Kind::Unit,
                key,
                faction: None,
            });
        }
        let rest = address.strip_prefix("strategic-")?;
        let tinted = rest.split_once('-').and_then(|(faction, key)| {
            let index = FACTION_COLOURS
                .iter()
                .position(|(name, _)| *name == faction)?;
            Some((index, key))
        });
        Some(match tinted {
            Some((index, key)) => Picture {
                kind: Kind::Strategic,
                key,
                faction: Some(index),
            },
            None => Picture {
                kind: Kind::Strategic,
                key: rest,
                faction: None,
            },
        })
    }

    /// The other way round from [`Picture::parse`].
    fn address(self) -> String {
        match (self.kind, self.faction) {
            (Kind::Unit, _) => format!("unit-{}", self.key),
            (Kind::Strategic, None) => format!("strategic-{}", self.key),
            (Kind::Strategic, Some(index)) => {
                format!("strategic-{}-{}", FACTION_COLOURS[index].0, self.key)
            }
        }
    }
}

/// One copy of a picture: which archive, which entry in it.
#[derive(Debug, Clone, Copy)]
struct Entry {
    archive: usize,
    index: usize,
}

/// Where every picture is in the archives, and where the decoded ones go.
struct Catalog {
    archives: Vec<Mutex<zip::ZipArchive<BufReader<File>>>>,
    /// Every copy of a picture, FAF's first: one that does not decode falls
    /// back to the base game's.
    units: BTreeMap<String, Vec<Entry>>,
    strategic: BTreeMap<String, Vec<Entry>>,
    /// The folder of decoded pictures, when there is a cache folder.
    cache: Option<PathBuf>,
    /// The pictures no copy of which decodes, so they are not tried again.
    broken: Mutex<HashSet<(Kind, String)>>,
}

/// The executable the catalogue was read for, and the catalogue.
type Held = Option<(String, Arc<Catalog>)>;

fn held() -> &'static Mutex<Held> {
    static READ: OnceLock<Mutex<Held>> = OnceLock::new();
    READ.get_or_init(Mutex::default)
}

/// The pictures of the install whose executable is `game_path`, read once
/// per install and kept for the session.
pub fn unit_icons(game_path: &str) -> UnitIcons {
    let mut held = held().lock().unwrap_or_else(PoisonError::into_inner);
    let catalog = match held.as_ref() {
        Some((path, catalog)) if path == game_path => catalog.clone(),
        _ => {
            let install = install_dir_of(game_path);
            let retail = super::game_updater::find_retail_install();
            let catalog = Arc::new(read_catalog(
                retail.map(|dir| dir.join("gamedata").join("textures.scd")),
                install.map(|dir| dir.join("gamedata").join("textures.nx2")),
                super::cache_dir().ok().map(|root| root.join("unit-icons")),
            ));
            *held = Some((game_path.to_owned(), catalog.clone()));
            let filling = catalog.clone();
            let started = std::thread::Builder::new()
                .name("unit-icon-cache".into())
                .spawn(move || filling.fill_cache());
            if let Err(error) = started {
                tracing::warn!(%error, "could not start filling the unit icon cache");
            }
            catalog
        }
    };
    UnitIcons {
        units: catalog.units.keys().cloned().collect(),
        strategic: catalog.strategic.keys().cloned().collect(),
    }
}

/// The picture a `unit-icon` address names, as PNG: `unit-UEL0201`,
/// `strategic-icon_land1_directfire`, or that icon in a faction's colour,
/// `strategic-cybran-icon_land1_directfire`; from the install [`unit_icons`]
/// read last. `None` for a name it does not have or a picture that does not
/// decode.
pub fn icon_png(name: &str) -> Option<Vec<u8>> {
    let picture = Picture::parse(name)?;
    let catalog = held()
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .as_ref()
        .map(|(_, catalog)| catalog.clone())?;
    catalog.png(picture)
}

/// `…/FAForever/bin/ForgedAlliance.exe` → `…/FAForever`.
pub(super) fn install_dir_of(game_path: &str) -> Option<PathBuf> {
    let path = Path::new(game_path);
    path.parent()?
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .map(Path::to_path_buf)
}

fn read_catalog(base: Option<PathBuf>, faf: Option<PathBuf>, cache: Option<PathBuf>) -> Catalog {
    let archives: Vec<PathBuf> = [base, faf].into_iter().flatten().collect();
    let mut catalog = Catalog {
        archives: Vec::new(),
        units: BTreeMap::new(),
        strategic: BTreeMap::new(),
        cache: cache.filter(|folder| prepare_cache(folder, &archives)),
        broken: Mutex::default(),
    };
    // The base game first, then FAF's copies in front of it.
    for archive in archives {
        if let Err(error) = catalog.add_archive(&archive) {
            tracing::warn!(archive = %archive.display(), %error, "could not read unit icons");
        }
    }
    for (one, other) in SHARED_ICONS {
        for (missing, present) in [(one, other), (other, one)] {
            if !catalog.units.contains_key(missing) {
                if let Some(copies) = catalog.units.get(present).cloned() {
                    catalog.units.insert(missing.to_owned(), copies);
                }
            }
        }
    }
    catalog
}

/// What the cache folder was filled from: each archive's path, size and time
/// of last change.
fn stamp_of(archives: &[PathBuf]) -> String {
    archives
        .iter()
        .map(|archive| {
            let metadata = std::fs::metadata(archive).ok();
            let size = metadata.as_ref().map_or(0, std::fs::Metadata::len);
            let changed = metadata
                .and_then(|metadata| metadata.modified().ok())
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |since| since.as_secs());
            format!("{}\t{size}\t{changed}\n", archive.display())
        })
        .collect()
}

/// Empties the cache folder when it was filled from other archives, or other
/// versions of them. `false` when the folder cannot be used at all.
fn prepare_cache(folder: &Path, archives: &[PathBuf]) -> bool {
    let stamp = stamp_of(archives);
    let stamp_file = folder.join("stamp.txt");
    if std::fs::read_to_string(&stamp_file).is_ok_and(|held| held == stamp) {
        return true;
    }
    if folder.exists() {
        if let Err(error) = std::fs::remove_dir_all(folder) {
            tracing::warn!(folder = %folder.display(), %error, "could not empty the unit icon cache");
            return false;
        }
    }
    std::fs::create_dir_all(folder)
        .and_then(|()| std::fs::write(&stamp_file, stamp))
        .map_err(|error| {
            tracing::warn!(folder = %folder.display(), %error, "could not prepare the unit icon cache");
        })
        .is_ok()
}

/// A picture's file in the cache folder, named as the page's address names
/// it. Only for a name that is nothing but letters, digits and underscores,
/// which every unit id and strategic icon name of the game is.
fn cache_file(folder: &Path, picture: Picture) -> Option<PathBuf> {
    let key = picture.key;
    if key.is_empty()
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    {
        return None;
    }
    Some(folder.join(format!("{}.png", picture.address())))
}

impl Catalog {
    fn add_archive(&mut self, archive: &Path) -> Result<(), String> {
        let file = File::open(archive).map_err(|e| e.to_string())?;
        let zip = zip::ZipArchive::new(BufReader::new(file)).map_err(|e| e.to_string())?;
        let number = self.archives.len();
        for index in 0..zip.len() {
            let Some(Ok(name)) = zip.name_for_index(index) else {
                continue;
            };
            let name = name.replace('\\', "/").to_ascii_lowercase();
            let (list, key) = if let Some(file) =
                name.strip_prefix("textures/ui/common/icons/units/")
            {
                let Some(id) = file
                    .strip_suffix("_icon.dds")
                    .filter(|id| !id.contains('/'))
                else {
                    continue;
                };
                (&mut self.units, id.to_ascii_uppercase())
            } else if let Some(file) = name.strip_prefix("textures/ui/common/game/strategicicons/")
            {
                let Some(icon) = file
                    .strip_suffix("_rest.dds")
                    .filter(|icon| !icon.contains('/'))
                else {
                    continue;
                };
                (&mut self.strategic, icon.to_owned())
            } else {
                continue;
            };
            list.entry(key).or_default().insert(
                0,
                Entry {
                    archive: number,
                    index,
                },
            );
        }
        self.archives.push(Mutex::new(zip));
        Ok(())
    }

    fn png(&self, picture: Picture) -> Option<Vec<u8>> {
        let Picture { kind, key, faction } = picture;
        let file = self
            .cache
            .as_deref()
            .and_then(|folder| cache_file(folder, picture));
        if let Some(png) = file.as_ref().and_then(|file| std::fs::read(file).ok()) {
            return Some(png);
        }
        let broken_key = (kind, key.to_owned());
        if self
            .broken
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .contains(&broken_key)
        {
            return None;
        }
        let copies = match kind {
            Kind::Unit => self.units.get(key),
            Kind::Strategic => self.strategic.get(key),
        };
        let Some(mut image) = copies
            .into_iter()
            .flatten()
            .find_map(|entry| self.decode(*entry))
        else {
            self.broken
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .insert(broken_key);
            return None;
        };
        if let Some(index) = faction {
            tint(&mut image.rgba, FACTION_COLOURS[index].1);
        }
        let png = super::png::encode_png(image.width, image.height, &image.rgba);
        if let Some(file) = file {
            // Written beside and moved in, so a request reading the folder at
            // the same time never finds half a picture.
            let partial = file.with_extension(format!("{:?}.part", std::thread::current().id()));
            if std::fs::write(&partial, &png).is_ok() && std::fs::rename(&partial, &file).is_err() {
                let _ = std::fs::remove_file(&partial);
            }
        }
        Some(png)
    }

    /// Decodes every picture the cache folder does not have yet into it.
    fn fill_cache(&self) {
        let Some(folder) = self.cache.as_deref() else {
            return;
        };
        // The units, then each strategic icon in each faction's colour: the
        // grey ones the page never asks for.
        let units = self.units.keys().map(|key| Picture {
            kind: Kind::Unit,
            key,
            faction: None,
        });
        let strategic = self.strategic.keys().flat_map(|key| {
            (0..FACTION_COLOURS.len()).map(move |index| Picture {
                kind: Kind::Strategic,
                key,
                faction: Some(index),
            })
        });
        for picture in units.chain(strategic) {
            if cache_file(folder, picture).is_some_and(|file| !file.exists()) {
                self.png(picture);
            }
        }
    }

    fn decode(&self, entry: Entry) -> Option<DecodedImage> {
        // Only the read holds the archive: the decode runs beside the others.
        let bytes = {
            let mut archive = self
                .archives
                .get(entry.archive)?
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            let mut file = archive.by_index(entry.index).ok()?;
            if file.size() > MAX_ICON_BYTES {
                return None;
            }
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes).ok()?;
            bytes
        };
        decode_dds(&bytes).ok()
    }
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
                    "textures/ui/common/icons/units/ual0101_icon.dds",
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
                (
                    "textures/ui/common/icons/units/UAL0101_icon.dds",
                    b"not a dds either".to_vec(),
                ),
            ],
        );
        let catalog = read_catalog(Some(base), Some(faf), None);
        let png = |kind: Kind, key: &str| {
            catalog.png(Picture {
                kind,
                key,
                faction: None,
            })
        };
        assert!(png(Kind::Unit, "UEL0201").is_some_and(|png| png.starts_with(b"\x89PNG")));
        assert!(png(Kind::Unit, "ZEB9501").is_some());
        assert_eq!(
            png(Kind::Unit, "UEB0201"),
            png(Kind::Unit, "ZEB9501"),
            "the headquarters shows its support factory's picture"
        );
        assert_eq!(png(Kind::Unit, "BROKEN"), None);
        assert!(
            png(Kind::Unit, "UAL0101").is_some(),
            "a copy in FAF's archive that does not decode falls back to the base game's"
        );
        assert_eq!(
            catalog.strategic.keys().collect::<Vec<_>>(),
            ["icon_land1_directfire"]
        );
        assert_eq!(png(Kind::Strategic, "icon_land1_directfire_over"), None);
    }

    #[test]
    fn decoded_pictures_are_kept_until_an_archive_changes() {
        let dir = tempfile::tempdir().unwrap();
        let cache = dir.path().join("unit-icons");
        let units = |files: &[(&str, Vec<u8>)]| archive(dir.path(), "textures.nx2", files);
        let faf = units(&[(
            "textures/ui/common/icons/units/uel0201_icon.dds",
            dds_4x4_red(),
        )]);

        let first = read_catalog(None, Some(faf.clone()), Some(cache.clone()));
        first.fill_cache();
        drop(first);
        let file = cache.join("unit-UEL0201.png");
        let png = std::fs::read(&file).unwrap();
        assert!(png.starts_with(b"\x89PNG"));

        // A later session reads the file, whatever the archive holds now.
        std::fs::write(&file, b"kept").unwrap();
        let catalog = read_catalog(None, Some(faf), Some(cache.clone()));
        assert_eq!(catalog.png(unit("UEL0201")).as_deref(), Some(&b"kept"[..]));
        // Closes the archive, which Windows wants before it is written again.
        drop(catalog);

        // A new game version starts the folder over.
        let faf = units(&[
            (
                "textures/ui/common/icons/units/uel0201_icon.dds",
                dds_4x4_red(),
            ),
            (
                "textures/ui/common/icons/units/uel0101_icon.dds",
                dds_4x4_red(),
            ),
        ]);
        let catalog = read_catalog(None, Some(faf), Some(cache.clone()));
        assert!(!file.exists());
        assert_eq!(catalog.png(unit("UEL0201")), Some(png));
    }

    fn unit(key: &str) -> Picture<'_> {
        Picture {
            kind: Kind::Unit,
            key,
            faction: None,
        }
    }

    #[test]
    fn only_plain_names_get_a_cache_file() {
        let folder = Path::new("cache");
        let strategic = Picture::parse("strategic-cybran-icon_land1_directfire").unwrap();
        assert_eq!(
            cache_file(folder, strategic),
            Some(folder.join("strategic-cybran-icon_land1_directfire.png"))
        );
        assert_eq!(cache_file(folder, unit("../UEL0201")), None);
        assert_eq!(cache_file(folder, unit("")), None);
    }

    #[test]
    fn addresses_name_the_picture_and_the_faction() {
        assert_eq!(Picture::parse("unit-UEL0201"), Some(unit("UEL0201")));
        let tinted = Picture::parse("strategic-seraphim-icon_land1_directfire").unwrap();
        assert_eq!(
            (tinted.kind, tinted.key, tinted.faction),
            (Kind::Strategic, "icon_land1_directfire", Some(3))
        );
        let grey = Picture::parse("strategic-icon_land1_directfire").unwrap();
        assert_eq!((grey.key, grey.faction), ("icon_land1_directfire", None));
        for address in [
            "unit-UEL0201",
            "strategic-icon_land1_directfire",
            "strategic-uef-icon_land1_directfire",
        ] {
            assert_eq!(Picture::parse(address).unwrap().address(), address);
        }
        assert_eq!(Picture::parse("other-UEL0201"), None);
    }

    #[test]
    fn a_strategic_icon_takes_the_colour_as_the_unit_database_draws_it() {
        // The edge, the two greys of the fill, white, a red mark, and a
        // transparent pixel, as the game's icons have them.
        let mut rgba = [
            8, 4, 8, 255, //
            123, 125, 123, 255, //
            90, 87, 90, 255, //
            255, 255, 255, 255, //
            255, 0, 0, 255, //
            123, 125, 123, 0,
        ];
        tint(&mut rgba, [255, 80, 80]);
        assert_eq!(
            rgba,
            [
                0, 0, 0, 255, //
                255, 80, 80, 255, //
                255, 80, 80, 255, //
                255, 255, 255, 255, //
                255, 0, 0, 255, //
                123, 125, 123, 0,
            ]
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
