//! Telling the rebuilt engine's `ForgedAlliance.exe` from the original (#781).
//!
//! Before every game and replay the updater writes the game version into the
//! executable at three fixed offsets (`install::patch_exe_version`). The
//! original engine reads it from there. The rebuilt engine (faf-re, the
//! `fafdevelop` featured mod's exe since 2026-11-15) takes the version from the
//! game files and replays from their header, and in its exe those offsets are
//! machine code: the stamp breaks it.
//!
//! Both files are called `ForgedAlliance.exe` and both can be 32-bit, so the
//! name and the machine type cannot tell them apart. The product name in the
//! exe's version resource can: the rebuilt engine writes [`PRODUCT_NAME`], the
//! original says "Supreme Commander Forged Alliance". The Java client tells
//! them apart the same way (`RebuiltEngineExecutable`). The file is read here
//! rather than through Windows, since the client runs on Linux as well.
//!
//! Every read is bounds-checked and a file that is not a well-formed PE is
//! simply "not the rebuilt engine": the original exe goes on being stamped
//! exactly as before.

use std::fs::File;
use std::io::{Read as _, Seek as _, SeekFrom};
use std::path::Path;

/// The product name the rebuilt engine writes into its version resource.
const PRODUCT_NAME: &str = "faf-re";

/// `RT_VERSION`, the resource type of a version resource.
const RT_VERSION: u32 = 16;

/// The most a resource section is read in full. Forged Alliance's is well
/// under a megabyte; a larger one is not an exe this is meant for.
const MAX_RESOURCE_SECTION: u32 = 32 * 1024 * 1024;

/// Whether `exe` is the rebuilt engine. `false` for anything unreadable.
pub(super) fn is_rebuilt_engine(exe: &Path) -> bool {
    product_name(exe).is_some_and(|name| name == PRODUCT_NAME)
}

/// The `ProductName` of an executable's version resource.
pub(super) fn product_name(exe: &Path) -> Option<String> {
    let mut file = File::open(exe).ok()?;
    let resources = Resources::read(&mut file)?;
    product_name_in(resources.version_info()?)
}

fn u16_at(bytes: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(
        bytes.get(at..at.checked_add(2)?)?.try_into().ok()?,
    ))
}

fn u32_at(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(
        bytes.get(at..at.checked_add(4)?)?.try_into().ok()?,
    ))
}

fn read_at(file: &mut File, offset: u64, len: usize) -> Option<Vec<u8>> {
    let mut buffer = vec![0; len];
    file.seek(SeekFrom::Start(offset)).ok()?;
    file.read_exact(&mut buffer).ok()?;
    Some(buffer)
}

/// The section holding the resource directory, and where in it that is.
struct Resources {
    section: Vec<u8>,
    /// The resource directory's root, as an offset into `section`.
    root: usize,
    /// The section's relative virtual address: data entries point by RVA.
    section_rva: u32,
}

impl Resources {
    fn read(file: &mut File) -> Option<Self> {
        let dos = read_at(file, 0, 64)?;
        if dos.get(0..2)? != b"MZ" {
            return None;
        }
        let pe = u64::from(u32_at(&dos, 0x3c)?);
        let coff = read_at(file, pe, 24)?;
        if coff.get(0..4)? != b"PE\0\0" {
            return None;
        }
        let section_count = usize::from(u16_at(&coff, 6)?);
        let optional_size = u16_at(&coff, 20)?;
        let optional = read_at(file, pe + 24, usize::from(optional_size))?;
        // The data directories follow the optional header's fixed fields,
        // which are longer in a 64-bit image. The resource table is the third.
        let directories = match u16_at(&optional, 0)? {
            0x10b => 96,
            0x20b => 112,
            _ => return None,
        };
        let resource_rva = u32_at(&optional, directories + 2 * 8)?;
        if resource_rva == 0 || section_count > 96 {
            return None;
        }
        let table = read_at(file, pe + 24 + u64::from(optional_size), section_count * 40)?;
        for header in table.chunks_exact(40) {
            let rva = u32_at(header, 12)?;
            let raw_size = u32_at(header, 16)?;
            let raw_at = u32_at(header, 20)?;
            if resource_rva >= rva && resource_rva - rva < raw_size {
                if raw_size > MAX_RESOURCE_SECTION {
                    return None;
                }
                let section = read_at(file, u64::from(raw_at), raw_size as usize)?;
                return Some(Self {
                    section,
                    root: (resource_rva - rva) as usize,
                    section_rva: rva,
                });
            }
        }
        None
    }

    /// The first version resource's bytes: type, then name, then language.
    fn version_info(&self) -> Option<&[u8]> {
        let names = self.entry(self.root, Some(RT_VERSION))?;
        let languages = self.entry(names, None)?;
        let data = self.entry(languages, None)?;
        let rva = u32_at(&self.section, data)?;
        let size = u32_at(&self.section, data + 4)? as usize;
        let start = rva.checked_sub(self.section_rva)? as usize;
        self.section.get(start..start.checked_add(size)?)
    }

    /// Where an entry of the directory at `directory` leads, as an offset into
    /// the section: the entry with `id`, or the first one. Entries point
    /// relative to the root directory, whose position in the section is not
    /// necessarily zero; the high bit only marks a subdirectory.
    fn entry(&self, directory: usize, id: Option<u32>) -> Option<usize> {
        let count = usize::from(u16_at(&self.section, directory + 12)?)
            + usize::from(u16_at(&self.section, directory + 14)?);
        (0..count).find_map(|index| {
            let at = directory + 16 + index * 8;
            let name = u32_at(&self.section, at)?;
            if id.is_some_and(|id| name != id) {
                return None;
            }
            let target = u32_at(&self.section, at + 4)? & 0x7fff_ffff;
            self.root.checked_add(target as usize)
        })
    }
}

/// One block of a `VS_VERSIONINFO`: a length, a key, an optional value, and
/// child blocks, each starting on a four-byte boundary.
struct Block {
    start: usize,
    end: usize,
    key: String,
    value: usize,
    value_end: usize,
    children: usize,
}

fn align4(offset: usize) -> usize {
    (offset + 3) & !3
}

/// UTF-16 from `from` up to a terminating zero or `limit`, and where the text
/// ends, its terminator included.
fn utf16_until_nul(bytes: &[u8], from: usize, limit: usize) -> Option<(String, usize)> {
    let mut units = Vec::new();
    let mut at = from;
    while at + 2 <= limit {
        let unit = u16_at(bytes, at)?;
        at += 2;
        if unit == 0 {
            break;
        }
        units.push(unit);
    }
    Some((String::from_utf16_lossy(&units), at))
}

impl Block {
    fn at(info: &[u8], start: usize, limit: usize) -> Option<Self> {
        let length = usize::from(u16_at(info, start)?);
        // Shorter than its own header: a corrupt block, and stopping here is
        // what keeps the walk from looping on it.
        if length < 6 {
            return None;
        }
        let end = start.checked_add(length)?.min(limit).min(info.len());
        let value_length = usize::from(u16_at(info, start + 2)?);
        let text = u16_at(info, start + 4)? == 1;
        let (key, after_key) = utf16_until_nul(info, start + 6, end)?;
        let value = align4(after_key);
        // A text value's length counts characters, a binary one's bytes.
        let value_end = value + if text { value_length * 2 } else { value_length };
        Some(Self {
            start,
            end,
            key,
            value,
            value_end: value_end.min(end),
            children: align4(value_end),
        })
    }

    fn children<'a>(&self, info: &'a [u8]) -> impl Iterator<Item = Block> + 'a {
        let end = self.end;
        let mut at = self.children;
        std::iter::from_fn(move || {
            if at >= end {
                return None;
            }
            let block = Block::at(info, at, end)?;
            at = align4(block.end.max(block.start + 6));
            Some(block)
        })
    }

    fn text(&self, info: &[u8]) -> String {
        utf16_until_nul(info, self.value, self.value_end)
            .map(|(text, _)| text)
            .unwrap_or_default()
    }
}

/// `ProductName` from `StringFileInfo`, in whichever language table has it.
fn product_name_in(info: &[u8]) -> Option<String> {
    let root = Block::at(info, 0, info.len())?;
    for file_info in root.children(info) {
        if file_info.key != "StringFileInfo" {
            continue;
        }
        for table in file_info.children(info) {
            for string in table.children(info) {
                if string.key == "ProductName" {
                    return Some(string.text(info));
                }
            }
        }
    }
    None
}

/// A minimal executable with a version resource, for tests here and in
/// `install`. No binaries in the repository: the bytes are built.
#[cfg(test)]
pub(super) fn test_executable(product: Option<&str>, wide: bool) -> Vec<u8> {
    fn pad4(bytes: &mut Vec<u8>) {
        while bytes.len() % 4 != 0 {
            bytes.push(0);
        }
    }
    fn block(key: &str, text: Option<&str>, binary: &[u8], children: &[Vec<u8>]) -> Vec<u8> {
        let mut out = vec![0_u8; 6];
        for unit in key.encode_utf16().chain([0]) {
            out.extend(unit.to_le_bytes());
        }
        pad4(&mut out);
        let (value_length, kind) = match text {
            Some(text) => {
                let units: Vec<u16> = text.encode_utf16().chain([0]).collect();
                for unit in &units {
                    out.extend(unit.to_le_bytes());
                }
                (units.len(), 1_u16)
            }
            None => {
                out.extend(binary);
                (binary.len(), 0)
            }
        };
        for child in children {
            pad4(&mut out);
            out.extend(child);
        }
        let length = out.len() as u16;
        out[0..2].copy_from_slice(&length.to_le_bytes());
        out[2..4].copy_from_slice(&(value_length as u16).to_le_bytes());
        out[4..6].copy_from_slice(&kind.to_le_bytes());
        out
    }

    let mut strings = vec![block("CompanyName", Some("Somebody"), &[], &[])];
    if let Some(product) = product {
        strings.push(block("ProductName", Some(product), &[], &[]));
    }
    let table = block("040904b0", None, &[], &strings);
    let string_info = block("StringFileInfo", None, &[], &[table]);
    let info = block("VS_VERSION_INFO", None, &[0; 52], &[string_info]);

    const SECTION_RVA: u32 = 0x1000;
    const SECTION_AT: u32 = 0x400;
    // Root directory -> type 16 -> name 1 -> language 0x409 -> data entry.
    let mut rsrc = vec![0_u8; 0x58];
    let directory = |rsrc: &mut Vec<u8>, at: usize, id: u32, target: u32| {
        rsrc[at + 14..at + 16].copy_from_slice(&1_u16.to_le_bytes());
        rsrc[at + 16..at + 20].copy_from_slice(&id.to_le_bytes());
        rsrc[at + 20..at + 24].copy_from_slice(&target.to_le_bytes());
    };
    directory(&mut rsrc, 0x00, RT_VERSION, 0x8000_0018);
    directory(&mut rsrc, 0x18, 1, 0x8000_0030);
    directory(&mut rsrc, 0x30, 0x409, 0x48);
    rsrc[0x48..0x4c].copy_from_slice(&(SECTION_RVA + 0x58).to_le_bytes());
    rsrc[0x4c..0x50].copy_from_slice(&(info.len() as u32).to_le_bytes());
    rsrc.extend(&info);
    pad4(&mut rsrc);

    let optional_size: u16 = if wide { 240 } else { 224 };
    let directories = if wide { 112 } else { 96 };
    let mut exe = vec![0_u8; SECTION_AT as usize];
    exe[0..2].copy_from_slice(b"MZ");
    exe[0x3c..0x40].copy_from_slice(&0x40_u32.to_le_bytes());
    exe[0x40..0x44].copy_from_slice(b"PE\0\0");
    exe[0x46..0x48].copy_from_slice(&1_u16.to_le_bytes());
    exe[0x54..0x56].copy_from_slice(&optional_size.to_le_bytes());
    let optional = 0x58;
    let magic: u16 = if wide { 0x20b } else { 0x10b };
    exe[optional..optional + 2].copy_from_slice(&magic.to_le_bytes());
    let resource = optional + directories + 16;
    exe[resource..resource + 4].copy_from_slice(&SECTION_RVA.to_le_bytes());
    exe[resource + 4..resource + 8].copy_from_slice(&(rsrc.len() as u32).to_le_bytes());
    let section = optional + usize::from(optional_size);
    exe[section..section + 5].copy_from_slice(b".rsrc");
    exe[section + 8..section + 12].copy_from_slice(&(rsrc.len() as u32).to_le_bytes());
    exe[section + 12..section + 16].copy_from_slice(&SECTION_RVA.to_le_bytes());
    exe[section + 16..section + 20].copy_from_slice(&(rsrc.len() as u32).to_le_bytes());
    exe[section + 20..section + 24].copy_from_slice(&SECTION_AT.to_le_bytes());
    exe.extend(rsrc);
    exe
}

#[cfg(test)]
mod tests {
    use super::*;

    fn written(bytes: &[u8]) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ForgedAlliance.exe");
        std::fs::write(&path, bytes).unwrap();
        (dir, path)
    }

    #[test]
    fn the_rebuilt_engine_is_recognised_in_either_width() {
        for wide in [false, true] {
            let (_dir, path) = written(&test_executable(Some(PRODUCT_NAME), wide));
            assert_eq!(product_name(&path).as_deref(), Some(PRODUCT_NAME));
            assert!(is_rebuilt_engine(&path), "wide: {wide}");
        }
    }

    #[test]
    fn the_original_engine_is_not() {
        let (_dir, path) = written(&test_executable(
            Some("Supreme Commander Forged Alliance"),
            false,
        ));
        assert_eq!(
            product_name(&path).as_deref(),
            Some("Supreme Commander Forged Alliance")
        );
        assert!(!is_rebuilt_engine(&path));
    }

    #[test]
    fn an_exe_without_a_product_name_is_not() {
        let (_dir, path) = written(&test_executable(None, false));
        assert_eq!(product_name(&path), None);
        assert!(!is_rebuilt_engine(&path));
    }

    #[test]
    fn anything_else_is_not() {
        let (_dir, path) = written(b"not an executable at all");
        assert!(!is_rebuilt_engine(&path));
        let (_dir, path) = written(&[]);
        assert!(!is_rebuilt_engine(&path));
        assert!(!is_rebuilt_engine(Path::new("does/not/exist.exe")));
        // Cut short inside the resource section.
        let full = test_executable(Some(PRODUCT_NAME), false);
        let (_dir, path) = written(&full[..full.len() - 40]);
        assert!(!is_rebuilt_engine(&path));
    }
}
