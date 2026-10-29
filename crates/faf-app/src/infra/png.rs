//! RGBA pixels as a PNG, for the pictures the backend hands the page as
//! `data:` URLs: a map's preview out of its `.scmap`, and the unit and
//! strategic icons out of the game's texture archives.
//!
//! Written here rather than taken from a crate. The pixels are already exactly
//! what a PNG stores, so the whole job is a header, a zlib stream and three
//! checksums, and `flate2` (already in the tree for the replay files) does the
//! stream and the CRC. A dependency for the rest is a supplier to vet for no
//! work saved.

use std::io::Write as _;

use base64::Engine as _;

/// A plain RGBA PNG, compressed. `rgba` is four bytes per pixel, row by row
/// from the top.
pub fn encode_png(width: u32, height: u32, rgba: &[u8]) -> Vec<u8> {
    let row = width as usize * 4;
    let mut raw = Vec::with_capacity(rgba.len() + height as usize);
    if row > 0 {
        for line in rgba.chunks_exact(row) {
            raw.push(0); // filter: none
            raw.extend_from_slice(line);
        }
    }
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    // Writing into memory cannot fail.
    let _ = encoder.write_all(&raw);
    let compressed = encoder.finish().unwrap_or_default();

    let mut png = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    let mut header = Vec::with_capacity(13);
    header.extend_from_slice(&width.to_be_bytes());
    header.extend_from_slice(&height.to_be_bytes());
    header.extend_from_slice(&[8, 6, 0, 0, 0]); // 8 bits, RGBA, no interlace
    chunk(&mut png, b"IHDR", &header);
    chunk(&mut png, b"IDAT", &compressed);
    chunk(&mut png, b"IEND", &[]);
    png
}

/// [`encode_png`] as a `data:image/png;base64,...` URL.
pub fn png_data_url(width: u32, height: u32, rgba: &[u8]) -> String {
    format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(encode_png(width, height, rgba))
    )
}

fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], body: &[u8]) {
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(body);
    let mut crc = flate2::Crc::new();
    crc.update(kind);
    crc.update(body);
    out.extend_from_slice(&crc.sum().to_be_bytes());
}

#[cfg(test)]
mod tests {
    use std::io::Read as _;

    use super::*;

    /// The bytes a decoder would need to find: signature, the three chunk
    /// names, the dimensions written big-endian in the header, and the IEND
    /// chunk's CRC over its type alone (the value the PNG specification
    /// prints).
    #[test]
    fn the_png_is_shaped_like_a_png() {
        let png = encode_png(2, 1, &[1, 2, 3, 4, 5, 6, 7, 8]);
        assert_eq!(
            &png[0..8],
            &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]
        );
        assert_eq!(&png[12..16], b"IHDR");
        assert_eq!(&png[16..20], &2_u32.to_be_bytes());
        assert_eq!(&png[20..24], &1_u32.to_be_bytes());
        assert!(png.windows(4).any(|w| w == b"IDAT"));
        assert_eq!(&png[png.len() - 8..png.len() - 4], b"IEND");
        assert_eq!(&png[png.len() - 4..], &0xae42_6082_u32.to_be_bytes());
    }

    /// The image data inflates back to the pixels, each row behind its filter
    /// byte.
    #[test]
    fn the_pixels_survive_the_round_trip() {
        let png = encode_png(1, 2, &[1, 2, 3, 4, 5, 6, 7, 8]);
        let at = png.windows(4).position(|w| w == b"IDAT").unwrap();
        let length = u32::from_be_bytes([png[at - 4], png[at - 3], png[at - 2], png[at - 1]]);
        let body = &png[at + 4..at + 4 + length as usize];
        let mut raw = Vec::new();
        flate2::read::ZlibDecoder::new(body)
            .read_to_end(&mut raw)
            .unwrap();
        assert_eq!(raw, [0, 1, 2, 3, 4, 0, 5, 6, 7, 8]);
    }
}
