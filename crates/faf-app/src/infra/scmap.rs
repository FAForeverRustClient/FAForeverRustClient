//! The preview image a `.scmap` carries, for a map that is not in the vault yet.
//!
//! The upload dialog shows what is about to be published, and for a map that
//! nobody has uploaded the vault has no thumbnail to offer: the picture has to
//! come out of the file on disk.
//!
//! # The format, as measured
//!
//! The header is the same in every version (`20-Domains/FAF-Engine/formats/scmap`):
//!
//! ```text
//! 16 bytes  magic, beginning `Map\x1a`
//! f32       width, discarded
//! f32       height, discarded
//! 6 bytes   zero padding
//! u32       preview length
//! ..        preview, an embedded DDS
//! u32       version
//! ```
//!
//! The preview is **not** DXT-compressed, which is the thing worth writing
//! down: a survey of the 400 real `.scmap` files on a developer machine found
//! every one of them carrying the same 256 by 256 uncompressed image, 262272
//! bytes, `fourcc` zero, flags `0x41` (RGB with alpha), 32 bits per pixel, and
//! the masks `R=0x00ff0000 G=0x0000ff00 B=0x000000ff A=0xff000000`. On a
//! little-endian machine those masks are the byte order B, G, R, A.
//!
//! The image is read by the same DDS codec as the unit icons
//! (`faf_domain::protocol::dds`), which follows those masks, and wrapped in a
//! PNG ([`super::png`]) so it reaches the webview as an ordinary image.

use std::io::Read;
use std::path::Path;

use faf_domain::protocol::dds::{decode_dds, DecodedImage};

/// `Map\x1a`. The rest of the 16 byte magic varies.
const SCMAP_MAGIC: &[u8; 4] = b"Map\x1a";
/// Magic, two floats, six zero bytes: the preview length sits here.
const PREVIEW_LENGTH_AT: u64 = 16 + 4 + 4 + 6;
/// Refuse a preview that claims to be bigger than any real one. The largest
/// measured is 262272; this leaves room for a 1024 by 1024 without letting a
/// corrupt length allocate freely.
const MAX_PREVIEW_BYTES: u32 = 8 * 1024 * 1024;

/// The preview of `path`, as a `data:image/png;base64,...` URL.
pub fn preview_data_url(path: &Path) -> Result<String, String> {
    let image = read_preview(path)?;
    Ok(super::png::png_data_url(
        image.width,
        image.height,
        &image.rgba,
    ))
}

fn read_preview(path: &Path) -> Result<DecodedImage, String> {
    let mut file = std::fs::File::open(path)
        .map_err(|error| format!("could not open the map file: {error}"))?;

    let mut magic = [0_u8; 4];
    read_exact(&mut file, &mut magic, "the map file's header")?;
    if &magic != SCMAP_MAGIC {
        return Err("that file does not look like a Supreme Commander map".to_string());
    }

    seek(&mut file, PREVIEW_LENGTH_AT)?;
    let length = read_u32(&mut file, "the preview's length")?;
    if length == 0 {
        return Err("the map carries no preview image".to_string());
    }
    if length > MAX_PREVIEW_BYTES {
        return Err("the map's preview image is implausibly large".to_string());
    }

    let mut dds = vec![0_u8; length as usize];
    read_exact(&mut file, &mut dds, "the preview image")?;
    decode_dds(&dds)
        .map_err(|reason| format!("the map's preview image could not be read: {reason}"))
}

fn seek(file: &mut std::fs::File, to: u64) -> Result<(), String> {
    use std::io::Seek as _;
    file.seek(std::io::SeekFrom::Start(to))
        .map(|_| ())
        .map_err(|error| format!("could not read the map file: {error}"))
}

fn read_exact(file: &mut impl Read, into: &mut [u8], what: &str) -> Result<(), String> {
    file.read_exact(into)
        .map_err(|error| format!("could not read {what}: {error}"))
}

fn read_u32(file: &mut impl Read, what: &str) -> Result<u32, String> {
    let mut bytes = [0_u8; 4];
    read_exact(file, &mut bytes, what)?;
    Ok(u32::from_le_bytes(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A map file as far as the preview: the magic, the two floats and the
    /// padding, the preview's length and the preview itself.
    fn map_with_preview(dds: &[u8]) -> Vec<u8> {
        let mut file = b"Map".to_vec();
        file.resize(PREVIEW_LENGTH_AT as usize, 0);
        file.extend_from_slice(&(dds.len() as u32).to_le_bytes());
        file.extend_from_slice(dds);
        file.extend_from_slice(&60_u32.to_le_bytes());
        file
    }

    /// The preview every real map carries, shrunk to one pixel: uncompressed,
    /// flags `0x41`, 32 bits, and the masks that make the bytes B, G, R, A.
    fn bgra_dds(pixel: [u8; 4]) -> Vec<u8> {
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
        dds.extend_from_slice(&pixel);
        dds
    }

    fn written(bytes: &[u8]) -> tempfile::TempPath {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        std::io::Write::write_all(&mut file, bytes).unwrap();
        file.into_temp_path()
    }

    #[test]
    fn the_preview_reads_from_bgra_to_rgba() {
        // Blue 1, green 2, red 3, alpha 4 as stored.
        let path = written(&map_with_preview(&bgra_dds([1, 2, 3, 4])));
        let preview = read_preview(&path).expect("a valid preview");
        assert_eq!(preview.rgba, vec![3, 2, 1, 4]);
        assert_eq!((preview.width, preview.height), (1, 1));
    }

    #[test]
    fn a_file_that_is_no_map_is_refused() {
        let path = written(b"not a map at all");
        assert!(read_preview(&path).is_err());
    }

    #[test]
    fn a_damaged_preview_is_refused() {
        let mut dds = bgra_dds([1, 2, 3, 4]);
        dds.truncate(130);
        let path = written(&map_with_preview(&dds));
        assert!(read_preview(&path).is_err());
    }
}
