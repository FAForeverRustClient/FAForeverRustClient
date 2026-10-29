//! Codec for the DDS textures the game's interface draws: unit build icons
//! (64 by 64) and strategic icons (a few pixels square), read out of
//! `textures.scd` and `textures.nx2`.
//!
//! Every such icon in both archives is DXT5; DXT1 and DXT3 are read as well,
//! and so is uncompressed 32-bit colour, because a file written a little
//! differently tomorrow should still show. Mipmaps after the first level are
//! ignored. The output is straight RGBA, row by row from the top.

/// A decoded image.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedImage {
    pub width: u32,
    pub height: u32,
    /// Four bytes per pixel, red first.
    pub rgba: Vec<u8>,
}

const HEADER_BYTES: usize = 128;
const DDPF_FOURCC: u32 = 0x4;
const DDPF_RGB: u32 = 0x40;
/// The largest icon decoded: far beyond any interface texture, small enough
/// that a damaged header cannot ask for gigabytes.
const MAX_SIDE: u32 = 4096;

fn u32_at(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes([
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
    ])
}

/// Decode a DDS file's first image.
pub fn decode_dds(bytes: &[u8]) -> Result<DecodedImage, String> {
    if bytes.len() < HEADER_BYTES || &bytes[0..4] != b"DDS " {
        return Err("not a DDS file".into());
    }
    let height = u32_at(bytes, 12);
    let width = u32_at(bytes, 16);
    if width == 0 || height == 0 || width > MAX_SIDE || height > MAX_SIDE {
        return Err(format!("a DDS image of {width} by {height}"));
    }
    let flags = u32_at(bytes, 80);
    let data = &bytes[HEADER_BYTES..];
    if flags & DDPF_FOURCC != 0 {
        let fourcc = &bytes[84..88];
        let kind = match fourcc {
            b"DXT1" => Block::Dxt1,
            b"DXT3" => Block::Dxt3,
            b"DXT5" => Block::Dxt5,
            other => {
                return Err(format!(
                    "a DDS compression this does not read: {}",
                    String::from_utf8_lossy(other)
                ))
            }
        };
        return decode_blocks(width, height, data, kind);
    }
    if flags & DDPF_RGB != 0 && u32_at(bytes, 88) == 32 {
        let masks = [
            u32_at(bytes, 92),
            u32_at(bytes, 96),
            u32_at(bytes, 100),
            u32_at(bytes, 104),
        ];
        return decode_rgb32(width, height, data, masks);
    }
    Err("a DDS pixel format this does not read".into())
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Block {
    Dxt1,
    Dxt3,
    Dxt5,
}

fn expand_565(color: u16) -> [u8; 3] {
    let r = ((color >> 11) & 0x1f) as u8;
    let g = ((color >> 5) & 0x3f) as u8;
    let b = (color & 0x1f) as u8;
    [
        (r << 3) | (r >> 2),
        (g << 2) | (g >> 4),
        (b << 3) | (b >> 2),
    ]
}

fn mix(a: [u8; 3], b: [u8; 3], weight_a: u16, weight_b: u16) -> [u8; 3] {
    let total = weight_a + weight_b;
    let channel =
        |i: usize| ((u16::from(a[i]) * weight_a + u16::from(b[i]) * weight_b) / total) as u8;
    [channel(0), channel(1), channel(2)]
}

/// The four colours of a colour block, with the alpha of each: only DXT1's
/// three-colour mode has a transparent one.
fn palette(block: &[u8], four_colour_always: bool) -> [[u8; 4]; 4] {
    let c0 = u16::from_le_bytes([block[0], block[1]]);
    let c1 = u16::from_le_bytes([block[2], block[3]]);
    let (a, b) = (expand_565(c0), expand_565(c1));
    let opaque = |c: [u8; 3]| [c[0], c[1], c[2], 255];
    if four_colour_always || c0 > c1 {
        [
            opaque(a),
            opaque(b),
            opaque(mix(a, b, 2, 1)),
            opaque(mix(a, b, 1, 2)),
        ]
    } else {
        [opaque(a), opaque(b), opaque(mix(a, b, 1, 1)), [0, 0, 0, 0]]
    }
}

fn dxt5_alphas(block: &[u8]) -> [u8; 8] {
    let (a0, a1) = (u16::from(block[0]), u16::from(block[1]));
    let mut alphas = [block[0], block[1], 0, 0, 0, 0, 0, 0];
    if a0 > a1 {
        for i in 1..7u16 {
            alphas[i as usize + 1] = (((7 - i) * a0 + i * a1) / 7) as u8;
        }
    } else {
        for i in 1..5u16 {
            alphas[i as usize + 1] = (((5 - i) * a0 + i * a1) / 5) as u8;
        }
        alphas[6] = 0;
        alphas[7] = 255;
    }
    alphas
}

fn decode_blocks(
    width: u32,
    height: u32,
    data: &[u8],
    kind: Block,
) -> Result<DecodedImage, String> {
    let block_bytes = if kind == Block::Dxt1 { 8 } else { 16 };
    let blocks_wide = width.div_ceil(4) as usize;
    let blocks_high = height.div_ceil(4) as usize;
    if data.len() < blocks_wide * blocks_high * block_bytes {
        return Err("the DDS image is cut short".into());
    }
    let (w, h) = (width as usize, height as usize);
    let mut rgba = vec![0_u8; w * h * 4];
    for by in 0..blocks_high {
        for bx in 0..blocks_wide {
            let start = (by * blocks_wide + bx) * block_bytes;
            let block = &data[start..start + block_bytes];
            let (alpha_part, colour_part) = if kind == Block::Dxt1 {
                (&block[0..0], block)
            } else {
                (&block[0..8], &block[8..16])
            };
            let colours = palette(colour_part, kind != Block::Dxt1);
            let indices = u32::from_le_bytes([
                colour_part[4],
                colour_part[5],
                colour_part[6],
                colour_part[7],
            ]);
            let alpha_bits = if kind == Block::Dxt5 {
                alpha_part[2..8]
                    .iter()
                    .enumerate()
                    .fold(0_u64, |bits, (i, byte)| {
                        bits | (u64::from(*byte) << (8 * i))
                    })
            } else {
                0
            };
            let alphas = if kind == Block::Dxt5 {
                dxt5_alphas(alpha_part)
            } else {
                [0; 8]
            };
            for py in 0..4 {
                for px in 0..4 {
                    let (x, y) = (bx * 4 + px, by * 4 + py);
                    if x >= w || y >= h {
                        continue;
                    }
                    let n = py * 4 + px;
                    let mut pixel = colours[((indices >> (2 * n)) & 0b11) as usize];
                    match kind {
                        Block::Dxt1 => {}
                        Block::Dxt3 => {
                            let nibble = (alpha_part[n / 2] >> (4 * (n % 2))) & 0xf;
                            pixel[3] = nibble * 17;
                        }
                        Block::Dxt5 => {
                            pixel[3] = alphas[((alpha_bits >> (3 * n)) & 0b111) as usize]
                        }
                    }
                    let offset = (y * w + x) * 4;
                    rgba[offset..offset + 4].copy_from_slice(&pixel);
                }
            }
        }
    }
    Ok(DecodedImage {
        width,
        height,
        rgba,
    })
}

fn decode_rgb32(
    width: u32,
    height: u32,
    data: &[u8],
    masks: [u32; 4],
) -> Result<DecodedImage, String> {
    let pixels = width as usize * height as usize;
    if data.len() < pixels * 4 {
        return Err("the DDS image is cut short".into());
    }
    let channel = |value: u32, mask: u32| -> u8 {
        if mask == 0 {
            return 255;
        }
        let shifted = (value & mask) >> mask.trailing_zeros();
        let max = mask >> mask.trailing_zeros();
        ((shifted * 255) / max) as u8
    };
    let mut rgba = Vec::with_capacity(pixels * 4);
    let (pixels_bytes, _) = data[..pixels * 4].as_chunks::<4>();
    for pixel in pixels_bytes {
        let value = u32::from_le_bytes(*pixel);
        rgba.extend_from_slice(&[
            channel(value, masks[0]),
            channel(value, masks[1]),
            channel(value, masks[2]),
            channel(value, masks[3]),
        ]);
    }
    Ok(DecodedImage {
        width,
        height,
        rgba,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header(width: u32, height: u32, flags: u32, fourcc: &[u8; 4]) -> Vec<u8> {
        let mut bytes = vec![0_u8; HEADER_BYTES];
        bytes[0..4].copy_from_slice(b"DDS ");
        bytes[12..16].copy_from_slice(&height.to_le_bytes());
        bytes[16..20].copy_from_slice(&width.to_le_bytes());
        bytes[80..84].copy_from_slice(&flags.to_le_bytes());
        bytes[84..88].copy_from_slice(fourcc);
        bytes
    }

    #[test]
    fn a_dxt5_block_reads_its_colours_and_alphas() {
        let mut dds = header(4, 4, DDPF_FOURCC, b"DXT5");
        // Alpha: 255 and 0, every pixel index 0 except the second (index 1).
        dds.extend_from_slice(&[255, 0, 0b0000_1000, 0, 0, 0, 0, 0]);
        // Colour: pure red and pure blue, pixel 0 red, pixel 1 blue, the rest red.
        dds.extend_from_slice(&0xf800_u16.to_le_bytes());
        dds.extend_from_slice(&0x001f_u16.to_le_bytes());
        dds.extend_from_slice(&[0b0000_0100, 0, 0, 0]);
        let image = decode_dds(&dds).unwrap();
        assert_eq!((image.width, image.height), (4, 4));
        assert_eq!(&image.rgba[0..4], &[255, 0, 0, 255]);
        assert_eq!(&image.rgba[4..8], &[0, 0, 255, 0]);
        assert_eq!(&image.rgba[8..12], &[255, 0, 0, 255]);
    }

    #[test]
    fn dxt1_has_a_transparent_colour_in_three_colour_mode() {
        let mut dds = header(4, 4, DDPF_FOURCC, b"DXT1");
        // c0 <= c1: three colours and transparent; every pixel index 3.
        dds.extend_from_slice(&0x0000_u16.to_le_bytes());
        dds.extend_from_slice(&0xffff_u16.to_le_bytes());
        dds.extend_from_slice(&[0xff; 4]);
        let image = decode_dds(&dds).unwrap();
        assert!(image.rgba.chunks(4).all(|pixel| pixel[3] == 0));
    }

    #[test]
    fn an_image_smaller_than_a_block_is_cut_to_size() {
        let mut dds = header(2, 3, DDPF_FOURCC, b"DXT5");
        dds.extend_from_slice(&[0; 16]);
        let image = decode_dds(&dds).unwrap();
        assert_eq!(image.rgba.len(), 2 * 3 * 4);
    }

    #[test]
    fn uncompressed_colour_reads_through_its_masks() {
        let mut dds = header(1, 1, DDPF_RGB, b"\0\0\0\0");
        dds[88..92].copy_from_slice(&32_u32.to_le_bytes());
        dds[92..96].copy_from_slice(&0x00ff_0000_u32.to_le_bytes());
        dds[96..100].copy_from_slice(&0x0000_ff00_u32.to_le_bytes());
        dds[100..104].copy_from_slice(&0x0000_00ff_u32.to_le_bytes());
        dds[104..108].copy_from_slice(&0xff00_0000_u32.to_le_bytes());
        dds.extend_from_slice(&0x80_10_20_30_u32.to_le_bytes());
        assert_eq!(decode_dds(&dds).unwrap().rgba, [0x10, 0x20, 0x30, 0x80]);
    }

    #[test]
    fn damaged_files_are_refused() {
        assert!(decode_dds(b"not a dds").is_err());
        let mut short = header(64, 64, DDPF_FOURCC, b"DXT5");
        short.extend_from_slice(&[0; 16]);
        assert!(decode_dds(&short).is_err(), "cut short");
        assert!(decode_dds(&header(0, 4, DDPF_FOURCC, b"DXT5")).is_err());
        assert!(decode_dds(&header(4, 4, DDPF_FOURCC, b"ATI2")).is_err());
    }
}
