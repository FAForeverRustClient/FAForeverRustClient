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
//! This module is pure: [`encode`] turns a [`GpgMessage`] into bytes, and
//! [`decode`] drains every *complete* message from a byte buffer, leaving any
//! partial trailing frame in place for the next read.

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

/// Drain every complete message from `buffer`, removing the bytes consumed and
/// leaving any partial trailing frame behind for the next call.
///
/// Malformed framing that can never complete (e.g. a negative length or an
/// invalid arg type) is unrecoverable on a byte stream, so we stop draining and
/// leave the offending bytes in the buffer; callers treat a stuck buffer as a
/// protocol error and tear the connection down.
pub fn decode(buffer: &mut Vec<u8>) -> Vec<GpgMessage> {
    let mut messages = Vec::new();
    let mut pos = 0usize;
    // Not enough bytes yet, or a frame we can't parse: stop here and keep
    // the unconsumed tail.
    while let ParseResult::Done(message, consumed) = parse_message(&buffer[pos..]) {
        messages.push(message);
        pos += consumed;
    }
    if pos > 0 {
        buffer.drain(..pos);
    }
    messages
}

enum ParseResult {
    /// A full message plus the number of bytes it consumed.
    Done(GpgMessage, usize),
    /// Need more bytes: a complete frame may yet arrive.
    Incomplete,
    /// The bytes present cannot form a valid frame (bad length/type).
    Invalid,
}

fn parse_message(buf: &[u8]) -> ParseResult {
    let mut pos = 0usize;
    let command = match read_string(buf, &mut pos) {
        Read::Ok(s) => s,
        Read::Incomplete => return ParseResult::Incomplete,
        Read::Invalid => return ParseResult::Invalid,
    };
    let argc = match read_i32(buf, &mut pos) {
        Read::Ok(n) => n,
        Read::Incomplete => return ParseResult::Incomplete,
        Read::Invalid => return ParseResult::Invalid,
    };
    if argc < 0 {
        return ParseResult::Invalid;
    }

    let mut args = Vec::with_capacity(argc as usize);
    for _ in 0..argc {
        let tag = match read_u8(buf, &mut pos) {
            Read::Ok(b) => b,
            Read::Incomplete => return ParseResult::Incomplete,
            Read::Invalid => return ParseResult::Invalid,
        };
        match tag {
            GpgArg::TYPE_INT => match read_i32(buf, &mut pos) {
                Read::Ok(n) => args.push(GpgArg::Int(n)),
                Read::Incomplete => return ParseResult::Incomplete,
                Read::Invalid => return ParseResult::Invalid,
            },
            GpgArg::TYPE_STRING => match read_string(buf, &mut pos) {
                Read::Ok(s) => args.push(GpgArg::Str(s)),
                Read::Incomplete => return ParseResult::Incomplete,
                Read::Invalid => return ParseResult::Invalid,
            },
            _ => return ParseResult::Invalid,
        }
    }
    ParseResult::Done(GpgMessage { command, args }, pos)
}

/// Outcome of reading one field from a byte slice.
enum Read<T> {
    Ok(T),
    Incomplete,
    Invalid,
}

fn read_u8(buf: &[u8], pos: &mut usize) -> Read<u8> {
    if *pos + 1 > buf.len() {
        return Read::Incomplete;
    }
    let b = buf[*pos];
    *pos += 1;
    Read::Ok(b)
}

fn read_i32(buf: &[u8], pos: &mut usize) -> Read<i32> {
    if *pos + 4 > buf.len() {
        return Read::Incomplete;
    }
    let bytes = [buf[*pos], buf[*pos + 1], buf[*pos + 2], buf[*pos + 3]];
    *pos += 4;
    Read::Ok(i32::from_le_bytes(bytes))
}

fn read_string(buf: &[u8], pos: &mut usize) -> Read<String> {
    let start = *pos;
    let len = match read_i32(buf, pos) {
        Read::Ok(n) => n,
        Read::Incomplete => return Read::Incomplete,
        Read::Invalid => return Read::Invalid,
    };
    if len < 0 {
        return Read::Invalid;
    }
    let len = len as usize;
    if *pos + len > buf.len() {
        // Rewind so a retry with more bytes re-reads the length too.
        *pos = start;
        return Read::Incomplete;
    }
    let slice = &buf[*pos..*pos + len];
    match std::str::from_utf8(slice) {
        Ok(s) => {
            *pos += len;
            Read::Ok(s.to_string())
        }
        Err(_) => Read::Invalid,
    }
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

    fn roundtrip(msg: &GpgMessage) -> Vec<GpgMessage> {
        let mut buf = encode(msg);
        decode(&mut buf)
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
        let out = decode(&mut buf);
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
        let out = decode(&mut buf);
        assert_eq!(out, vec![msg]);
    }

    #[test]
    fn decodes_multiple_messages_in_one_buffer() {
        let a = GpgMessage::new("GameState", vec![GpgArg::Str("Lobby".into())]);
        let b = GpgMessage::new("GameFull", vec![]);
        let mut buf = encode(&a);
        buf.extend(encode(&b));
        let out = decode(&mut buf);
        assert_eq!(out, vec![a, b]);
        assert!(buf.is_empty());
    }

    #[test]
    fn partial_frame_is_left_buffered_until_complete() {
        let msg = GpgMessage::new("JoinGame", vec![GpgArg::Str("peer".into()), GpgArg::Int(3)]);
        let full = encode(&msg);

        // Feed all but the last byte: nothing decodes, everything stays buffered.
        let mut buf = full[..full.len() - 1].to_vec();
        let out = decode(&mut buf);
        assert!(out.is_empty());
        assert_eq!(buf.len(), full.len() - 1, "incomplete frame retained");

        // Append the final byte: now it decodes and the buffer drains.
        buf.push(*full.last().unwrap());
        let out = decode(&mut buf);
        assert_eq!(out, vec![msg]);
        assert!(buf.is_empty());
    }

    #[test]
    fn split_in_the_middle_of_the_length_prefix() {
        let msg = GpgMessage::new("GameState", vec![GpgArg::Str("Launching".into())]);
        let full = encode(&msg);

        // Only 2 bytes: not even a full length prefix.
        let mut buf = full[..2].to_vec();
        assert!(decode(&mut buf).is_empty());
        assert_eq!(buf.len(), 2);

        buf.extend_from_slice(&full[2..]);
        assert_eq!(decode(&mut buf), vec![msg]);
        assert!(buf.is_empty());
    }

    #[test]
    fn one_complete_message_then_a_partial_one() {
        let a = GpgMessage::new("GameFull", vec![]);
        let b = GpgMessage::new("GameState", vec![GpgArg::Str("Ended".into())]);
        let mut buf = encode(&a);
        let b_bytes = encode(&b);
        buf.extend_from_slice(&b_bytes[..3]); // partial second message

        let out = decode(&mut buf);
        assert_eq!(out, vec![a]); // first drains, second stays
        assert_eq!(buf, b_bytes[..3].to_vec());

        buf.extend_from_slice(&b_bytes[3..]);
        assert_eq!(decode(&mut buf), vec![b]);
    }
}
