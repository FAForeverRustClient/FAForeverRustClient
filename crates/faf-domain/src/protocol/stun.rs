//! STUN Binding codec (RFC 5389) and ICE server URLs (RFC 7064, RFC 7065).
//!
//! The connectivity check asks each relay the FAF API handed out whether it
//! answers from this network, which is the one question a launch error and a
//! log file cannot answer before a game. A STUN Binding Request is the
//! smallest message every STUN and TURN server answers without credentials:
//! a twenty-byte header with no attributes. The success response carries the
//! address the server saw the request come from, which is the player's public
//! address as the rest of the internet sees it.
//!
//! This module is pure: [`binding_request`] builds the request for a
//! transaction id the caller chose, [`parse_binding_response`] reads an answer
//! and checks it belongs to that transaction, and [`parse_ice_url`] turns a
//! `stun:`/`turn:` URL into the host, port and transport to probe. The socket
//! work is `faf-app`'s `infra::connectivity`.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

use serde::{Deserialize, Serialize};
use specta::Type;

/// The fixed value every RFC 5389 message carries in bytes 4..8. It is what
/// tells a STUN answer from any other datagram, and the key the
/// XOR-MAPPED-ADDRESS attribute is scrambled with.
pub const MAGIC_COOKIE: u32 = 0x2112_A442;

/// Every STUN message starts with a header of this many bytes.
pub const HEADER_LEN: usize = 20;

/// The 96-bit id that pairs an answer with its request.
pub type TransactionId = [u8; 12];

const BINDING_REQUEST: u16 = 0x0001;
const BINDING_SUCCESS: u16 = 0x0101;
const BINDING_ERROR: u16 = 0x0111;

const ATTR_MAPPED_ADDRESS: u16 = 0x0001;
const ATTR_ERROR_CODE: u16 = 0x0009;
const ATTR_XOR_MAPPED_ADDRESS: u16 = 0x0020;

const FAMILY_IPV4: u8 = 0x01;
const FAMILY_IPV6: u8 = 0x02;

/// A Binding Request with no attributes, for `transaction`.
///
/// No attributes is deliberate: neither credentials nor a FINGERPRINT are
/// needed for a binding, and a request that carries nothing cannot be refused
/// for carrying the wrong thing.
pub fn binding_request(transaction: &TransactionId) -> [u8; HEADER_LEN] {
    let mut message = [0u8; HEADER_LEN];
    message[0..2].copy_from_slice(&BINDING_REQUEST.to_be_bytes());
    // Bytes 2..4 are the length of the attributes, which is zero.
    message[4..8].copy_from_slice(&MAGIC_COOKIE.to_be_bytes());
    message[8..20].copy_from_slice(transaction);
    message
}

/// A Binding Success Response.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BindingSuccess {
    /// Where the server saw the request come from: XOR-MAPPED-ADDRESS, or the
    /// older MAPPED-ADDRESS when a server sends only that. `None` when it sent
    /// neither, which still proves the server answered.
    pub mapped: Option<SocketAddr>,
}

/// Why a datagram is not a usable answer to a binding request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StunError {
    /// Shorter than a header, or than the length the header announces.
    Truncated,
    /// Not a STUN message: the two leading bits are set, the cookie is wrong,
    /// or the announced length is not a multiple of four.
    NotStun,
    /// A STUN message, but the answer to some other request.
    WrongTransaction,
    /// The server answered with a Binding Error Response.
    ErrorResponse { code: u16 },
    /// A STUN message of a type that does not answer a binding request.
    UnexpectedType(u16),
    /// An address attribute shorter than its family requires.
    Malformed,
}

impl std::fmt::Display for StunError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StunError::Truncated => write!(f, "the answer was cut short"),
            StunError::NotStun => write!(f, "the answer was not a STUN message"),
            StunError::WrongTransaction => write!(f, "the answer was for another request"),
            StunError::ErrorResponse { code } => {
                write!(f, "the server refused with STUN error {code}")
            }
            StunError::UnexpectedType(kind) => {
                write!(f, "the server answered with STUN message type {kind:#06x}")
            }
            StunError::Malformed => write!(f, "the answer carried a malformed address"),
        }
    }
}

fn read_u16(bytes: &[u8], at: usize) -> u16 {
    u16::from_be_bytes([bytes[at], bytes[at + 1]])
}

/// Read the answer to the binding request sent as `transaction`.
///
/// Unknown attributes are skipped rather than failing the answer. RFC 5389
/// asks a client to discard a success response carrying an unknown
/// comprehension-required attribute, but this is a reachability check, not a
/// NAT traversal: a server old enough to send RFC 3489's SOURCE-ADDRESS has
/// still proved it is reachable, which is the only thing being asked.
pub fn parse_binding_response(
    bytes: &[u8],
    transaction: &TransactionId,
) -> Result<BindingSuccess, StunError> {
    if bytes.len() < HEADER_LEN {
        return Err(StunError::Truncated);
    }
    if bytes[0] & 0xC0 != 0 {
        return Err(StunError::NotStun);
    }
    let cookie = u32::from_be_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]);
    let length = usize::from(read_u16(bytes, 2));
    if cookie != MAGIC_COOKIE || length % 4 != 0 {
        return Err(StunError::NotStun);
    }
    let end = HEADER_LEN + length;
    if bytes.len() < end {
        return Err(StunError::Truncated);
    }
    if bytes[8..20] != transaction[..] {
        return Err(StunError::WrongTransaction);
    }

    let kind = read_u16(bytes, 0);
    let mut xor_mapped = None;
    let mut mapped = None;
    let mut error_code = None;
    let mut offset = HEADER_LEN;
    while offset + 4 <= end {
        let attribute = read_u16(bytes, offset);
        let size = usize::from(read_u16(bytes, offset + 2));
        let start = offset + 4;
        if start + size > end {
            return Err(StunError::Truncated);
        }
        let value = &bytes[start..start + size];
        match attribute {
            ATTR_XOR_MAPPED_ADDRESS => xor_mapped = Some(xor_address(value, transaction)?),
            ATTR_MAPPED_ADDRESS => mapped = Some(plain_address(value)?),
            ATTR_ERROR_CODE if value.len() >= 4 => {
                // Class in the low three bits of byte 2, number in byte 3.
                error_code = Some(u16::from(value[2] & 0x07) * 100 + u16::from(value[3]));
            }
            _ => {}
        }
        // Attributes are padded to a four-byte boundary.
        offset = start + size.div_ceil(4) * 4;
    }

    match kind {
        BINDING_SUCCESS => Ok(BindingSuccess {
            mapped: xor_mapped.or(mapped),
        }),
        BINDING_ERROR => Err(StunError::ErrorResponse {
            code: error_code.unwrap_or(0),
        }),
        other => Err(StunError::UnexpectedType(other)),
    }
}

/// MAPPED-ADDRESS: reserved byte, family, port, address, all in the clear.
fn plain_address(value: &[u8]) -> Result<SocketAddr, StunError> {
    address(value, |_| 0, |_| 0)
}

/// XOR-MAPPED-ADDRESS: the same layout, with the port XORed against the top
/// half of the cookie and the address against the cookie followed by the
/// transaction id. Scrambled so a NAT that rewrites addresses it finds in
/// packets cannot rewrite this one.
fn xor_address(value: &[u8], transaction: &TransactionId) -> Result<SocketAddr, StunError> {
    let mut key = [0u8; 16];
    key[0..4].copy_from_slice(&MAGIC_COOKIE.to_be_bytes());
    key[4..16].copy_from_slice(transaction);
    address(value, |index| key[index], |index| key[index])
}

fn address(
    value: &[u8],
    port_key: impl Fn(usize) -> u8,
    address_key: impl Fn(usize) -> u8,
) -> Result<SocketAddr, StunError> {
    if value.len() < 4 {
        return Err(StunError::Malformed);
    }
    let port = u16::from_be_bytes([value[2] ^ port_key(0), value[3] ^ port_key(1)]);
    let ip = match value[1] {
        FAMILY_IPV4 if value.len() >= 8 => {
            let mut octets = [0u8; 4];
            for (index, octet) in octets.iter_mut().enumerate() {
                *octet = value[4 + index] ^ address_key(index);
            }
            IpAddr::V4(Ipv4Addr::from(octets))
        }
        FAMILY_IPV6 if value.len() >= 20 => {
            let mut octets = [0u8; 16];
            for (index, octet) in octets.iter_mut().enumerate() {
                *octet = value[4 + index] ^ address_key(index);
            }
            IpAddr::V6(Ipv6Addr::from(octets))
        }
        _ => return Err(StunError::Malformed),
    };
    Ok(SocketAddr::new(ip, port))
}

/// How a relay URL is reached.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum IceTransport {
    Udp,
    Tcp,
    /// `stuns:` and `turns:`: TCP with TLS on top. The check opens the TCP
    /// connection and stops there.
    Tls,
}

/// The scheme of an ICE server URL.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IceScheme {
    Stun,
    Stuns,
    Turn,
    Turns,
}

/// One `stun:`/`turn:` URL, taken apart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IceUrl {
    pub scheme: IceScheme,
    /// A name, an IPv4 address, or an IPv6 address without its brackets.
    pub host: String,
    pub port: u16,
    pub transport: IceTransport,
}

impl IceUrl {
    /// `host:port`, with an IPv6 host in brackets so the result parses back.
    pub fn endpoint(&self) -> String {
        if self.host.contains(':') {
            format!("[{}]:{}", self.host, self.port)
        } else {
            format!("{}:{}", self.host, self.port)
        }
    }
}

/// Take an ICE server URL apart, or `None` when it is not one.
///
/// The defaults are the RFCs': port 3478 for `stun:`/`turn:` and 5349 for the
/// TLS schemes; `turn:` is UDP unless `?transport=tcp` says otherwise, and a
/// `stun:` URL is probed over UDP, which is how the adapters use it.
pub fn parse_ice_url(raw: &str) -> Option<IceUrl> {
    let (scheme, rest) = raw.trim().split_once(':')?;
    let scheme = match scheme.to_ascii_lowercase().as_str() {
        "stun" => IceScheme::Stun,
        "stuns" => IceScheme::Stuns,
        "turn" => IceScheme::Turn,
        "turns" => IceScheme::Turns,
        _ => return None,
    };
    // Not part of the grammar, but written often enough by hand that refusing
    // it would only hide a server behind a typo.
    let rest = rest.trim_start_matches("//");
    let (authority, query) = match rest.split_once('?') {
        Some((authority, query)) => (authority, Some(query)),
        None => (rest, None),
    };

    let (host, port) = if let Some(bracketed) = authority.strip_prefix('[') {
        let (host, after) = bracketed.split_once(']')?;
        let port = match after.strip_prefix(':') {
            Some(port) => Some(port.parse::<u16>().ok()?),
            None if after.is_empty() => None,
            None => return None,
        };
        (host.to_string(), port)
    } else {
        match authority.split_once(':') {
            Some((host, port)) => (host.to_string(), Some(port.parse::<u16>().ok()?)),
            None => (authority.to_string(), None),
        }
    };
    if host.is_empty() || host.contains('/') || host.contains('@') {
        return None;
    }

    let secure = matches!(scheme, IceScheme::Stuns | IceScheme::Turns);
    let requested = query
        .into_iter()
        .flat_map(|query| query.split('&'))
        .find_map(|pair| {
            let (key, value) = pair.split_once('=')?;
            key.eq_ignore_ascii_case("transport")
                .then(|| value.to_ascii_lowercase())
        });
    let transport = match (secure, requested.as_deref()) {
        (true, None | Some("tcp")) => IceTransport::Tls,
        (true, Some(_)) => return None,
        (false, None | Some("udp")) => IceTransport::Udp,
        (false, Some("tcp")) => IceTransport::Tcp,
        (false, Some(_)) => return None,
    };

    Some(IceUrl {
        scheme,
        host,
        port: port.unwrap_or(if secure { 5349 } else { 3478 }),
        transport,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const TRANSACTION: TransactionId = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

    /// A response header for `kind` followed by `attributes`.
    fn response(kind: u16, attributes: &[u8], transaction: &TransactionId) -> Vec<u8> {
        let mut message = Vec::new();
        message.extend_from_slice(&kind.to_be_bytes());
        message.extend_from_slice(&(attributes.len() as u16).to_be_bytes());
        message.extend_from_slice(&MAGIC_COOKIE.to_be_bytes());
        message.extend_from_slice(transaction);
        message.extend_from_slice(attributes);
        message
    }

    /// An XOR-MAPPED-ADDRESS for an IPv4 address, encoded by hand from the
    /// RFC's description rather than by the decoder under test.
    fn xor_mapped_ipv4(ip: [u8; 4], port: u16) -> Vec<u8> {
        let cookie = MAGIC_COOKIE.to_be_bytes();
        let port = port ^ (MAGIC_COOKIE >> 16) as u16;
        let mut attribute = vec![0x00, 0x20, 0x00, 0x08, 0x00, FAMILY_IPV4];
        attribute.extend_from_slice(&port.to_be_bytes());
        for (index, octet) in ip.iter().enumerate() {
            attribute.push(octet ^ cookie[index]);
        }
        attribute
    }

    #[test]
    fn a_binding_request_is_a_bare_header() {
        let request = binding_request(&TRANSACTION);
        assert_eq!(request.len(), 20);
        assert_eq!(&request[0..2], &[0x00, 0x01], "Binding Request");
        assert_eq!(&request[2..4], &[0x00, 0x00], "no attributes");
        assert_eq!(&request[4..8], &[0x21, 0x12, 0xA4, 0x42], "magic cookie");
        assert_eq!(&request[8..20], &TRANSACTION);
    }

    #[test]
    fn reads_the_public_ipv4_address_from_xor_mapped_address() {
        let answer = response(
            BINDING_SUCCESS,
            &xor_mapped_ipv4([203, 0, 113, 7], 51_234),
            &TRANSACTION,
        );
        assert_eq!(
            parse_binding_response(&answer, &TRANSACTION),
            Ok(BindingSuccess {
                mapped: Some("203.0.113.7:51234".parse().unwrap()),
            })
        );
    }

    /// The test vector from RFC 5769 section 2.2, minus its integrity and
    /// fingerprint attributes, which are skipped like any other unknown one.
    #[test]
    fn decodes_the_rfc_5769_ipv4_vector() {
        let transaction: TransactionId = [
            0xb7, 0xe7, 0xa7, 0x01, 0xbc, 0x34, 0xd6, 0x86, 0xfa, 0x87, 0xdf, 0xae,
        ];
        let attributes = [
            // SOFTWARE "test vector " (comprehension-optional, skipped).
            0x80, 0x22, 0x00, 0x0b, 0x74, 0x65, 0x73, 0x74, 0x20, 0x76, 0x65, 0x63, 0x74, 0x6f,
            0x72, 0x20, // XOR-MAPPED-ADDRESS 192.0.2.1:32853
            0x00, 0x20, 0x00, 0x08, 0x00, 0x01, 0xa1, 0x47, 0xe1, 0x12, 0xa6, 0x43,
        ];
        let answer = response(BINDING_SUCCESS, &attributes, &transaction);
        assert_eq!(
            parse_binding_response(&answer, &transaction)
                .unwrap()
                .mapped,
            Some("192.0.2.1:32853".parse().unwrap())
        );
    }

    #[test]
    fn decodes_an_ipv6_xor_mapped_address() {
        // RFC 5769 section 2.3: 2001:db8:1234:5678:11:2233:4455:6677 port 32853.
        let transaction: TransactionId = [
            0xb7, 0xe7, 0xa7, 0x01, 0xbc, 0x34, 0xd6, 0x86, 0xfa, 0x87, 0xdf, 0xae,
        ];
        let attributes = [
            0x00, 0x20, 0x00, 0x14, 0x00, 0x02, 0xa1, 0x47, 0x01, 0x13, 0xa9, 0xfa, 0xa5, 0xd3,
            0xf1, 0x79, 0xbc, 0x25, 0xf4, 0xb5, 0xbe, 0xd2, 0xb9, 0xd9,
        ];
        let answer = response(BINDING_SUCCESS, &attributes, &transaction);
        assert_eq!(
            parse_binding_response(&answer, &transaction)
                .unwrap()
                .mapped,
            Some(
                "[2001:db8:1234:5678:11:2233:4455:6677]:32853"
                    .parse()
                    .unwrap()
            )
        );
    }

    #[test]
    fn falls_back_to_the_plain_mapped_address() {
        let attribute = [0x00, 0x01, 0x00, 0x08, 0x00, 0x01, 0x0d, 0x96, 10, 0, 0, 1];
        let answer = response(BINDING_SUCCESS, &attribute, &TRANSACTION);
        assert_eq!(
            parse_binding_response(&answer, &TRANSACTION)
                .unwrap()
                .mapped,
            Some("10.0.0.1:3478".parse().unwrap())
        );
    }

    #[test]
    fn a_success_without_an_address_still_counts_as_an_answer() {
        let answer = response(BINDING_SUCCESS, &[], &TRANSACTION);
        assert_eq!(
            parse_binding_response(&answer, &TRANSACTION),
            Ok(BindingSuccess { mapped: None })
        );
    }

    #[test]
    fn a_short_datagram_is_truncated() {
        assert_eq!(
            parse_binding_response(&[0x01, 0x01, 0x00], &TRANSACTION),
            Err(StunError::Truncated)
        );
        // A header announcing twelve bytes of attributes that never came.
        let mut answer = response(
            BINDING_SUCCESS,
            &xor_mapped_ipv4([1, 2, 3, 4], 1),
            &TRANSACTION,
        );
        answer.truncate(24);
        assert_eq!(
            parse_binding_response(&answer, &TRANSACTION),
            Err(StunError::Truncated)
        );
    }

    #[test]
    fn an_attribute_running_past_the_message_is_truncated() {
        // Claims eight bytes of value, carries four.
        let attribute = [0x00, 0x20, 0x00, 0x08, 0x00, 0x01, 0x00, 0x00];
        let answer = response(BINDING_SUCCESS, &attribute, &TRANSACTION);
        assert_eq!(
            parse_binding_response(&answer, &TRANSACTION),
            Err(StunError::Truncated)
        );
    }

    #[test]
    fn rejects_what_is_not_stun_or_not_ours() {
        let mut answer = response(BINDING_SUCCESS, &[], &TRANSACTION);
        answer[4] = 0;
        assert_eq!(
            parse_binding_response(&answer, &TRANSACTION),
            Err(StunError::NotStun),
            "wrong cookie"
        );
        let mut answer = response(BINDING_SUCCESS, &[], &TRANSACTION);
        answer[0] |= 0x80;
        assert_eq!(
            parse_binding_response(&answer, &TRANSACTION),
            Err(StunError::NotStun),
            "leading bits set"
        );
        let answer = response(BINDING_SUCCESS, &[], &[9; 12]);
        assert_eq!(
            parse_binding_response(&answer, &TRANSACTION),
            Err(StunError::WrongTransaction)
        );
    }

    #[test]
    fn an_error_response_carries_its_code() {
        // ERROR-CODE 401 Unauthorized: class 4, number 1.
        let attribute = [0x00, 0x09, 0x00, 0x04, 0x00, 0x00, 0x04, 0x01];
        let answer = response(BINDING_ERROR, &attribute, &TRANSACTION);
        assert_eq!(
            parse_binding_response(&answer, &TRANSACTION),
            Err(StunError::ErrorResponse { code: 401 })
        );
    }

    #[test]
    fn a_malformed_address_is_refused() {
        // IPv4 family with only two bytes of address.
        let attribute = [0x00, 0x20, 0x00, 0x04, 0x00, 0x01, 0x00, 0x01];
        let answer = response(BINDING_SUCCESS, &attribute, &TRANSACTION);
        assert_eq!(
            parse_binding_response(&answer, &TRANSACTION),
            Err(StunError::Malformed)
        );
    }

    #[test]
    fn parses_the_urls_the_api_hands_out() {
        let url = parse_ice_url("turn:coturn-eu-1.example.org?transport=tcp").unwrap();
        assert_eq!(url.scheme, IceScheme::Turn);
        assert_eq!(url.host, "coturn-eu-1.example.org");
        assert_eq!(url.port, 3478);
        assert_eq!(url.transport, IceTransport::Tcp);

        let url = parse_ice_url("turn:relay.example.org:443?transport=udp").unwrap();
        assert_eq!((url.port, url.transport), (443, IceTransport::Udp));

        let url = parse_ice_url("stun:stun.example.org").unwrap();
        assert_eq!(
            (url.scheme, url.port, url.transport),
            (IceScheme::Stun, 3478, IceTransport::Udp)
        );

        let url = parse_ice_url("TURNS:relay.example.org").unwrap();
        assert_eq!(
            (url.scheme, url.port, url.transport),
            (IceScheme::Turns, 5349, IceTransport::Tls)
        );
    }

    #[test]
    fn keeps_an_ipv6_host_without_its_brackets() {
        let url = parse_ice_url("stun:[2001:db8::1]:19302").unwrap();
        assert_eq!(url.host, "2001:db8::1");
        assert_eq!(url.port, 19302);
        assert_eq!(url.endpoint(), "[2001:db8::1]:19302");
    }

    #[test]
    fn refuses_what_is_not_an_ice_url() {
        for raw in [
            "",
            "http://example.org",
            "turn:",
            "turn:host:notaport",
            "turn:host?transport=sctp",
            "turns:host?transport=udp",
            "stun:[2001:db8::1",
            "turn:user@host",
        ] {
            assert_eq!(parse_ice_url(raw), None, "{raw:?}");
        }
    }
}
