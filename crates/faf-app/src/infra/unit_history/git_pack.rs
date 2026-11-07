//! Decode the self-contained blob packs sent for indexed Unit History requests.
//! Git framing and offset deltas follow gitprotocol-v2 and gitformat-pack.

use std::collections::{BTreeSet, HashMap};
use std::io::Read;

use flate2::bufread::ZlibDecoder;
use sha1::{Digest, Sha1};

use super::MAX_BLUEPRINT_BYTES;

pub(super) const MAX_PACK_BYTES: u64 = 4 * 1024 * 1024;
const MAX_EXPANDED_BYTES: usize = 16 * 1024 * 1024;

pub(super) fn blob_id(source: &[u8]) -> String {
    let mut hash = Sha1::new();
    hash.update(format!("blob {}\0", source.len()));
    hash.update(source);
    format!("{:x}", hash.finalize())
}

pub(super) fn unpack(
    response: &[u8],
    wanted: &BTreeSet<String>,
) -> Option<HashMap<String, String>> {
    let pack = packfile(response)?;
    let (mut data, checksum) = pack.split_at_checked(pack.len().checked_sub(20)?)?;
    if Sha1::digest(data)[..] != *checksum {
        return None;
    }
    let pack_size = data.len();
    if take(&mut data, 8)? != b"PACK\0\0\0\x02" {
        return None;
    }
    let count = u32::from_be_bytes(take(&mut data, 4)?.try_into().ok()?) as usize;
    // A non-thin pack can include bases, but a response much larger than the
    // request is unsuitable for this shortcut.
    if count > wanted.len().checked_mul(2)? {
        return None;
    }

    let mut offsets: HashMap<usize, Vec<u8>> = HashMap::with_capacity(count);
    let mut expanded = 0_usize;
    for _ in 0..count {
        let position = pack_size - data.len();
        let header = byte(&mut data)?;
        let kind = (header >> 4) & 7;
        let size = read_size(&mut data, header, 4)?;
        if size > MAX_BLUEPRINT_BYTES as usize {
            return None;
        }
        let base = match kind {
            3 => None,
            6 => {
                let distance = read_distance(&mut data)?;
                Some(offsets.get(&position.checked_sub(distance)?)?)
            }
            _ => return None,
        };
        // Account for inflated instructions as well as resulting objects.
        expanded = expanded.checked_add(size)?;
        if expanded > MAX_EXPANDED_BYTES {
            return None;
        }
        let content = inflate(&mut data, size)?;
        let blob = match base {
            Some(base) => {
                let remaining = MAX_EXPANDED_BYTES - expanded;
                let blob = apply_delta(base, &content, remaining)?;
                expanded += blob.len();
                blob
            }
            None => content,
        };
        offsets.insert(position, blob);
    }
    if !data.is_empty() {
        return None;
    }
    Some(
        offsets
            .into_values()
            .filter_map(|blob| {
                let id = blob_id(&blob);
                wanted
                    .contains(&id)
                    .then(|| (id, String::from_utf8_lossy(&blob).into_owned()))
            })
            .collect(),
    )
}

fn packfile(mut response: &[u8]) -> Option<Vec<u8>> {
    response = response.strip_prefix(b"000dpackfile\n")?;
    let mut pack = Vec::new();
    while !response.is_empty() {
        let size =
            usize::from_str_radix(std::str::from_utf8(take(&mut response, 4)?).ok()?, 16).ok()?;
        if size == 0 {
            return (response.is_empty() || response == b"0002").then_some(pack);
        }
        let packet = take(&mut response, size.checked_sub(4)?)?;
        match packet.split_first()? {
            (1, bytes) => pack.extend_from_slice(bytes),
            (2, _) => (),
            _ => return None,
        }
    }
    None
}

fn take<'a>(input: &mut &'a [u8], len: usize) -> Option<&'a [u8]> {
    let (head, tail) = input.split_at_checked(len)?;
    *input = tail;
    Some(head)
}

fn byte(input: &mut &[u8]) -> Option<u8> {
    Some(take(input, 1)?[0])
}

fn read_size(input: &mut &[u8], mut next: u8, first_bits: u32) -> Option<usize> {
    let mut value = usize::from(next) & ((1 << first_bits) - 1);
    let mut shift = first_bits;
    while next & 0x80 != 0 {
        next = byte(input)?;
        let part = usize::from(next & 0x7f);
        if part > usize::MAX.checked_shr(shift)? {
            return None;
        }
        value |= part << shift;
        shift += 7;
    }
    Some(value)
}

fn read_distance(input: &mut &[u8]) -> Option<usize> {
    let mut next = byte(input)?;
    let mut distance = usize::from(next & 0x7f);
    while next & 0x80 != 0 {
        next = byte(input)?;
        distance = distance
            .checked_add(1)?
            .checked_mul(128)?
            .checked_add(usize::from(next & 0x7f))?;
    }
    Some(distance)
}

fn inflate(input: &mut &[u8], size: usize) -> Option<Vec<u8>> {
    let mut decoder = ZlibDecoder::new(*input);
    let mut data = Vec::with_capacity(size);
    decoder
        .by_ref()
        .take(size as u64 + 1)
        .read_to_end(&mut data)
        .ok()?;
    if data.len() != size || decoder.total_in() == 0 {
        return None;
    }
    take(input, decoder.total_in() as usize)?;
    Some(data)
}

fn apply_delta(base: &[u8], mut instructions: &[u8], remaining: usize) -> Option<Vec<u8>> {
    let next = byte(&mut instructions)?;
    if read_size(&mut instructions, next, 7)? != base.len() {
        return None;
    }
    let next = byte(&mut instructions)?;
    let size = read_size(&mut instructions, next, 7)?;
    if size > remaining || size > MAX_BLUEPRINT_BYTES as usize {
        return None;
    }
    let mut result = Vec::with_capacity(size);
    while !instructions.is_empty() {
        let opcode = byte(&mut instructions)?;
        let fragment = match opcode {
            0 => return None,
            1..=127 => take(&mut instructions, usize::from(opcode))?,
            _ => {
                let offset = fields(&mut instructions, opcode, 4)?;
                let length = fields(&mut instructions, opcode >> 4, 3)?;
                let length = if length == 0 { 65_536 } else { length };
                base.get(offset..offset.checked_add(length)?)?
            }
        };
        if fragment.len() > size - result.len() {
            return None;
        }
        result.extend_from_slice(fragment);
    }
    (result.len() == size).then_some(result)
}

fn fields(input: &mut &[u8], flags: u8, count: usize) -> Option<usize> {
    let mut value = 0;
    for index in 0..count {
        if flags & (1 << index) != 0 {
            value |= usize::from(byte(input)?) << (8 * index);
        }
    }
    Some(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{write::ZlibEncoder, Compression};
    use std::io::Write;

    #[test]
    fn unit_history_pack_rebuilds_offset_deltas_and_validates_the_response() {
        fn compress(pack: &mut Vec<u8>, source: &[u8]) {
            let mut encoder = ZlibEncoder::new(pack, Compression::fast());
            encoder.write_all(source).unwrap();
            encoder.finish().unwrap();
        }
        let mut pack = b"PACK\0\0\0\x02\0\0\0\x02".to_vec();
        pack.push(0x33);
        compress(&mut pack, b"abc");
        let distance = u8::try_from(pack.len() - 12).unwrap();
        pack.extend_from_slice(&[0x66, distance]);
        compress(&mut pack, &[3, 4, 0x90, 3, 1, b'd']);
        let checksum = Sha1::digest(&pack);
        pack.extend_from_slice(&checksum);
        let mut wire = b"000dpackfile\n".to_vec();
        for part in pack.chunks(20) {
            wire.extend(format!("{:04x}", part.len() + 5).bytes());
            wire.push(1);
            wire.extend_from_slice(part);
        }
        wire.extend_from_slice(b"0000");
        let original = blob_id(b"abc");
        let changed = blob_id(b"abcd");
        let ids = BTreeSet::from([original.clone(), changed.clone()]);
        assert_eq!(
            unpack(&wire, &ids).unwrap(),
            HashMap::from([(original, "abc".into()), (changed, "abcd".into())])
        );
        assert!(unpack(&wire[..wire.len() - 5], &ids).is_none());
        wire[20] ^= 1;
        assert!(unpack(&wire, &ids).is_none());
    }
}
