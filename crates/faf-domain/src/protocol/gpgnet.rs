//! GPGNet wire codec: the binary framing the game and the ICE adapter speak.
//!
//! Forged Alliance's GPGNet channel uses Qt's `QDataStream` in **little-endian**
//! mode (see the Python client's `GPGNetServer.py` read/write helpers). There is
//! no outer length frame; messages are simply concatenated, each:
//!
//! ```text
//! message  = string(command) argcount(i32) arg*
//! arg      = type(u8: 0=int, 1=string) ( i32 | string )
//! string   = len(i32) bytes(len, UTF-8)
//! ```
//!
//! All integers are 32-bit little-endian, matching `QDataStream::writeInt` /
//! `readInt` with `ByteOrder::LittleEndian`. Strings are `writeBytes` (a `quint32`
//! length followed by the raw bytes) read back with `readInt` + `readRawData`.
//!
//! This module is pure: [`encode`] turns a [`GpgMessage`] into bytes, [`decode`]
//! reads one message from the front of a byte slice and says whether it was
//! complete, incomplete or invalid, and [`drain`] takes every complete message
//! off a buffer, leaving any partial trailing frame in place for the next read.
//!
//! # Limits
//!
//! Every length on this wire is supplied by the peer, and with no outer frame
//! there is no other way to tell a slow message from a bogus one. Without a
//! ceiling, a corrupt argument count asked for a multi-gigabyte allocation up
//! front, and a corrupt string length left the reader buffering forever for
//! bytes that would never arrive. The ceilings below are far above anything
//! Forged Alliance or the ICE adapter sends (the largest real message is the
//! end-of-game statistics JSON, tens of kilobytes), so they only ever reject a
//! stream that has already gone wrong.

/// The most bytes one message may span. Also the most a reader ever has to
/// buffer for an incomplete one: a frame that would need more is invalid.
pub const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;

/// The longest single string (the command or one argument).
pub const MAX_STRING_BYTES: usize = 4 * 1024 * 1024;

/// The most arguments one message may carry. Real messages carry a handful.
pub const MAX_ARGS: usize = 4096;

/// A single GPGNet argument. The wire distinguishes ints from strings by a type
/// tag, so we keep them apart rather than stringifying everything.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GpgArg {
    Int(i32),
    Str(String),
}

impl GpgArg {
    const TYPE_INT: u8 = 0;
    const TYPE_STRING: u8 = 1;
}

/// One GPGNet message: a command name and its typed arguments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GpgMessage {
    pub command: String,
    pub args: Vec<GpgArg>,
}

impl GpgMessage {
    pub fn new(command: impl Into<String>, args: Vec<GpgArg>) -> Self {
        Self {
            command: command.into(),
            args,
        }
    }
}

/// Encode one message to its wire bytes.
pub fn encode(message: &GpgMessage) -> Vec<u8> {
    let mut out = Vec::new();
    write_string(&mut out, &message.command);
    write_i32(&mut out, message.args.len() as i32);
    for arg in &message.args {
        match arg {
            GpgArg::Int(n) => {
                out.push(GpgArg::TYPE_INT);
                write_i32(&mut out, *n);
            }
            GpgArg::Str(s) => {
                out.push(GpgArg::TYPE_STRING);
                write_string(&mut out, s);
            }
        }
    }
    out
}

/// What reading one message from the front of a buffer produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decoded {
    /// A full message, and how many bytes of the buffer it consumed.
    Complete(GpgMessage, usize),
    /// Not enough bytes yet: a complete frame may still arrive.
    Incomplete,
    /// The bytes present can never form a valid frame. A byte stream with no
    /// outer framing has no way to find the next message after this, so the
    /// connection has to be dropped.
    Invalid(&'static str),
}

/// Read one message from the front of `buffer` without consuming anything.
pub fn decode(buffer: &[u8]) -> Decoded {
    match parse_message(buffer) {
        Ok(Some((message, consumed))) => Decoded::Complete(message, consumed),
        Ok(None) => Decoded::Incomplete,
        Err(reason) => Decoded::Invalid(reason),
    }
}

/// What [`drain`] took off a buffer.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Drained {
    /// Every complete message, in order, up to the first invalid frame.
    pub messages: Vec<GpgMessage>,
    /// Why the stream is unusable, when it is. The invalid bytes are left at
    /// the front of the buffer; the caller is expected to drop the connection.
    pub invalid: Option<&'static str>,
}

/// Take every complete message off `buffer`, removing the bytes consumed and
/// leaving any partial trailing frame behind for the next call.
///
/// Messages that arrived intact ahead of a corrupt frame are still returned,
/// so the peer's last words (a final `GameState`, say) are not lost along with
/// the connection.
pub fn drain(buffer: &mut Vec<u8>) -> Drained {
    let mut drained = Drained::default();
    let mut pos = 0usize;
    loop {
        match decode(&buffer[pos..]) {
            Decoded::Complete(message, consumed) => {
                drained.messages.push(message);
                pos += consumed;
            }
            Decoded::Incomplete => break,
            Decoded::Invalid(reason) => {
                drained.invalid = Some(reason);
                break;
            }
        }
    }
    if pos > 0 {
        buffer.drain(..pos);
    }
    drained
}

/// `Ok(None)` is an incomplete frame; `Err` names why a frame is invalid.
type Parsed<T> = Result<Option<T>, &'static str>;

fn parse_message(buf: &[u8]) -> Parsed<(GpgMessage, usize)> {
    let mut pos = 0usize;
    let Some(command) = read_string(buf, &mut pos)? else {
        return Ok(None);
    };
    let Some(argc) = read_i32(buf, &mut pos)? else {
        return Ok(None);
    };
    let argc = usize::try_from(argc).map_err(|_| "negative argument count")?;
    if argc > MAX_ARGS {
        return Err("too many arguments");
    }

    // Capacity is not taken from `argc` directly: even within the limit, the
    // count is only a claim until the arguments themselves have arrived. Each
    // argument is at least five bytes on the wire, so the bytes actually
    // present bound what can be filled now.
    let mut args = Vec::with_capacity(argc.min(buf.len().saturating_sub(pos) / 5));
    for _ in 0..argc {
        let Some(tag) = read_u8(buf, &mut pos)? else {
            return Ok(None);
        };
        let arg = match tag {
            GpgArg::TYPE_INT => read_i32(buf, &mut pos)?.map(GpgArg::Int),
            GpgArg::TYPE_STRING => read_string(buf, &mut pos)?.map(GpgArg::Str),
            _ => return Err("unknown argument type"),
        };
        let Some(arg) = arg else {
            return Ok(None);
        };
        args.push(arg);
    }
    Ok(Some((GpgMessage { command, args }, pos)))
}

/// Whether `pos + needed` bytes are present, after checking that a frame that
/// long is allowed at all. The order matters: a frame over the ceiling is
/// invalid however many bytes have arrived so far, which is what keeps a
/// reader from buffering towards it.
fn require(buf: &[u8], pos: usize, needed: usize) -> Parsed<()> {
    let end = pos.checked_add(needed).ok_or("frame too large")?;
    if end > MAX_FRAME_BYTES {
        return Err("frame too large");
    }
    Ok((end <= buf.len()).then_some(()))
}

fn read_u8(buf: &[u8], pos: &mut usize) -> Parsed<u8> {
    if require(buf, *pos, 1)?.is_none() {
        return Ok(None);
    }
    let b = buf[*pos];
    *pos += 1;
    Ok(Some(b))
}

fn read_i32(buf: &[u8], pos: &mut usize) -> Parsed<i32> {
    if require(buf, *pos, 4)?.is_none() {
        return Ok(None);
    }
    let bytes = [buf[*pos], buf[*pos + 1], buf[*pos + 2], buf[*pos + 3]];
    *pos += 4;
    Ok(Some(i32::from_le_bytes(bytes)))
}

fn read_string(buf: &[u8], pos: &mut usize) -> Parsed<String> {
    let start = *pos;
    let Some(len) = read_i32(buf, pos)? else {
        return Ok(None);
    };
    let len = usize::try_from(len).map_err(|_| "negative string length")?;
    if len > MAX_STRING_BYTES {
        return Err("string too long");
    }
    if require(buf, *pos, len)?.is_none() {
        // Rewind so a retry with more bytes re-reads the length too.
        *pos = start;
        return Ok(None);
    }
    let slice = &buf[*pos..*pos + len];
    let text = std::str::from_utf8(slice).map_err(|_| "string was not UTF-8")?;
    *pos += len;
    Ok(Some(text.to_string()))
}

fn write_i32(out: &mut Vec<u8>, n: i32) {
    out.extend_from_slice(&n.to_le_bytes());
}

fn write_string(out: &mut Vec<u8>, s: &str) {
    write_i32(out, s.len() as i32);
    out.extend_from_slice(s.as_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;

    /// [`drain`] on a stream that is known to be well formed.
    fn decode_all(buf: &mut Vec<u8>) -> Vec<GpgMessage> {
        let drained = drain(buf);
        assert_eq!(drained.invalid, None, "a valid stream must not be rejected");
        drained.messages
    }

    /// A frame header: the command, then a claimed argument count.
    fn header(command: &str, argc: i32) -> Vec<u8> {
        let mut out = Vec::new();
        write_string(&mut out, command);
        write_i32(&mut out, argc);
        out
    }

    /// The case that used to reserve `i32::MAX` arguments before a single one
    /// had arrived. It is now refused outright, and a count within the limit
    /// but without its arguments is only incomplete.
    #[test]
    fn a_huge_argument_count_is_invalid_without_allocating_for_it() {
        assert_eq!(
            decode(&header("GameState", i32::MAX)),
            Decoded::Invalid("too many arguments")
        );
        assert_eq!(
            decode(&header("GameState", -1)),
            Decoded::Invalid("negative argument count")
        );
        assert_eq!(
            decode(&header("GameState", MAX_ARGS as i32)),
            Decoded::Incomplete
        );
    }

    #[test]
    fn a_truncated_frame_is_incomplete_at_every_cut() {
        let msg = GpgMessage::new(
            "ConnectToPeer",
            vec![GpgArg::Str("127.0.0.1:0".into()), GpgArg::Int(42)],
        );
        let full = encode(&msg);
        for cut in 0..full.len() {
            assert_eq!(decode(&full[..cut]), Decoded::Incomplete, "cut at {cut}");
        }
        assert_eq!(decode(&full), Decoded::Complete(msg, full.len()));
    }

    #[test]
    fn invalid_frames_say_why() {
        let mut negative = Vec::new();
        write_i32(&mut negative, -5);
        assert_eq!(
            decode(&negative),
            Decoded::Invalid("negative string length")
        );

        let mut bad_tag = header("GameState", 1);
        bad_tag.push(7);
        assert_eq!(decode(&bad_tag), Decoded::Invalid("unknown argument type"));

        let mut not_utf8 = Vec::new();
        write_i32(&mut not_utf8, 2);
        not_utf8.extend_from_slice(&[0xff, 0xfe]);
        assert_eq!(decode(&not_utf8), Decoded::Invalid("string was not UTF-8"));
    }

    /// A length nobody sends is rejected on sight rather than waited for: the
    /// reader would otherwise buffer up to two gigabytes for it.
    #[test]
    fn oversized_lengths_are_invalid_before_their_bytes_arrive() {
        let mut long_string = Vec::new();
        write_i32(&mut long_string, (MAX_STRING_BYTES + 1) as i32);
        assert_eq!(decode(&long_string), Decoded::Invalid("string too long"));

        // Each string within its own limit, but the frame over the total.
        let mut long_frame = header("Stats", 3);
        for _ in 0..3 {
            long_frame.push(GpgArg::TYPE_STRING);
            write_i32(&mut long_frame, MAX_STRING_BYTES as i32);
            long_frame.resize(long_frame.len() + MAX_STRING_BYTES, b'x');
        }
        assert_eq!(decode(&long_frame), Decoded::Invalid("frame too large"));
    }

    /// The largest string allowed still decodes: the limits only reject.
    #[test]
    fn a_string_at_the_limit_still_decodes() {
        let msg = GpgMessage::new("Stats", vec![GpgArg::Str("x".repeat(MAX_STRING_BYTES))]);
        let mut buf = encode(&msg);
        assert_eq!(decode_all(&mut buf), vec![msg]);
        assert!(buf.is_empty());
    }

    #[test]
    fn drain_keeps_the_messages_ahead_of_an_invalid_frame() {
        let first = GpgMessage::new("GameState", vec![GpgArg::Str("Ended".into())]);
        let mut buf = encode(&first);
        let mut garbage = Vec::new();
        write_i32(&mut garbage, -1);
        buf.extend_from_slice(&garbage);

        let drained = drain(&mut buf);
        assert_eq!(drained.messages, vec![first]);
        assert_eq!(drained.invalid, Some("negative string length"));
        assert_eq!(buf, garbage, "the invalid bytes are left for the caller");
    }

    fn roundtrip(msg: &GpgMessage) -> Vec<GpgMessage> {
        let mut buf = encode(msg);
        decode_all(&mut buf)
    }

    #[test]
    fn roundtrips_mixed_args() {
        let msg = GpgMessage::new(
            "ConnectToPeer",
            vec![
                GpgArg::Str("127.0.0.1:0".into()),
                GpgArg::Str("Stormlord".into()),
                GpgArg::Int(42),
            ],
        );
        let mut buf = encode(&msg);
        let out = decode_all(&mut buf);
        assert_eq!(out, vec![msg]);
        assert!(buf.is_empty(), "fully consumed");
    }

    #[test]
    fn roundtrips_no_args() {
        let msg = GpgMessage::new("GameFull", vec![]);
        assert_eq!(roundtrip(&msg), vec![msg]);
    }

    #[test]
    fn gamestate_byte_layout_is_little_endian() {
        // "GameState" (9 bytes) + 1 arg, a string "Idle".
        let msg = GpgMessage::new("GameState", vec![GpgArg::Str("Idle".into())]);
        let bytes = encode(&msg);
        let mut expected = Vec::new();
        expected.extend_from_slice(&9i32.to_le_bytes()); // command length
        expected.extend_from_slice(b"GameState");
        expected.extend_from_slice(&1i32.to_le_bytes()); // arg count
        expected.push(1); // STRING tag
        expected.extend_from_slice(&4i32.to_le_bytes()); // "Idle" length
        expected.extend_from_slice(b"Idle");
        assert_eq!(bytes, expected);
    }

    #[test]
    fn createlobby_int_arg_layout() {
        // CreateLobby(mode=0, port=0, "me", id=7, 1): ints carry a 0 tag + i32 LE.
        let msg = GpgMessage::new(
            "CreateLobby",
            vec![
                GpgArg::Int(0),
                GpgArg::Int(0),
                GpgArg::Str("me".into()),
                GpgArg::Int(7),
                GpgArg::Int(1),
            ],
        );
        let mut buf = encode(&msg);
        let out = decode_all(&mut buf);
        assert_eq!(out, vec![msg]);
    }

    #[test]
    fn decodes_multiple_messages_in_one_buffer() {
        let a = GpgMessage::new("GameState", vec![GpgArg::Str("Lobby".into())]);
        let b = GpgMessage::new("GameFull", vec![]);
        let mut buf = encode(&a);
        buf.extend(encode(&b));
        let out = decode_all(&mut buf);
        assert_eq!(out, vec![a, b]);
        assert!(buf.is_empty());
    }

    #[test]
    fn partial_frame_is_left_buffered_until_complete() {
        let msg = GpgMessage::new("JoinGame", vec![GpgArg::Str("peer".into()), GpgArg::Int(3)]);
        let full = encode(&msg);

        // Feed all but the last byte: nothing decodes, everything stays buffered.
        let mut buf = full[..full.len() - 1].to_vec();
        let out = decode_all(&mut buf);
        assert!(out.is_empty());
        assert_eq!(buf.len(), full.len() - 1, "incomplete frame retained");

        // Append the final byte: now it decodes and the buffer drains.
        buf.push(*full.last().unwrap());
        let out = decode_all(&mut buf);
        assert_eq!(out, vec![msg]);
        assert!(buf.is_empty());
    }

    #[test]
    fn split_in_the_middle_of_the_length_prefix() {
        let msg = GpgMessage::new("GameState", vec![GpgArg::Str("Launching".into())]);
        let full = encode(&msg);

        // Only 2 bytes: not even a full length prefix.
        let mut buf = full[..2].to_vec();
        assert!(decode_all(&mut buf).is_empty());
        assert_eq!(buf.len(), 2);

        buf.extend_from_slice(&full[2..]);
        assert_eq!(decode_all(&mut buf), vec![msg]);
        assert!(buf.is_empty());
    }

    #[test]
    fn one_complete_message_then_a_partial_one() {
        let a = GpgMessage::new("GameFull", vec![]);
        let b = GpgMessage::new("GameState", vec![GpgArg::Str("Ended".into())]);
        let mut buf = encode(&a);
        let b_bytes = encode(&b);
        buf.extend_from_slice(&b_bytes[..3]); // partial second message

        let out = decode_all(&mut buf);
        assert_eq!(out, vec![a]); // first drains, second stays
        assert_eq!(buf, b_bytes[..3].to_vec());

        buf.extend_from_slice(&b_bytes[3..]);
        assert_eq!(decode_all(&mut buf), vec![b]);
    }
}
