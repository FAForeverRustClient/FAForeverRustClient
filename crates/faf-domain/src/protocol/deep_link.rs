//! Codec for `faf://` links: a way into the client at one tournament, map,
//! mod, replay, patch note or unit history, from chat, from Discord or from a
//! browser.
//!
//! ```text
//! faf://tourney/<id>
//! faf://map/<folder name>
//! faf://mod/<uid>
//! faf://replay/<id>
//! faf://changelog/<release>
//! faf://units/<blueprint id>
//! ```
//!
//! A link reaches the client from anywhere: any web page can ask the
//! operating system to open one. So every part is checked against what that
//! kind of value can look like, and a link only ever *shows* something. None
//! of them starts a game, a download or an install; the replay link opens the
//! replay's entry in the vault, not the replay.
//!
//! No other FAF tool registers the scheme: neither the Java nor the Python
//! client does (the Python client's `fafgame://` and `faflive://` live only
//! inside its own chat), and Windows had no `faf` class on a machine with
//! both installed.

use serde::{Deserialize, Serialize};
use specta::Type;

/// The scheme, without `://`.
pub const SCHEME: &str = "faf";

/// The path's first part for each kind of link, with the spellings a person
/// is likely to write for the same thing.
const TARGETS: [&str; 8] = [
    "tourney",
    "tournament",
    "map",
    "mod",
    "replay",
    "changelog",
    "units",
    "unit",
];

/// What a link points at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum DeepLink {
    /// A tournament on the tournament service, by its id.
    Tourney { id: String },
    /// A map in the vault, by its folder name (`setons_clutch.v0004`).
    #[serde(rename_all = "camelCase")]
    Map { folder_name: String },
    /// A mod in the vault, by its uid.
    Mod { uid: String },
    /// A game's entry in the replay vault, by its game id.
    Replay { id: i32 },
    /// A game release's patch notes, by the changelog's release id.
    Changelog { release: String },
    /// One unit's history across the game releases, by blueprint id.
    Unit { id: String },
}

impl DeepLink {
    /// The link that points here, the inverse of [`parse_deep_link`].
    pub fn url(&self) -> String {
        let (target, value) = match self {
            DeepLink::Tourney { id } => ("tourney", percent_encode(id)),
            DeepLink::Map { folder_name } => ("map", percent_encode(folder_name)),
            DeepLink::Mod { uid } => ("mod", percent_encode(uid)),
            DeepLink::Replay { id } => ("replay", id.to_string()),
            DeepLink::Changelog { release } => ("changelog", percent_encode(release)),
            DeepLink::Unit { id } => ("units", percent_encode(id)),
        };
        format!("{SCHEME}://{target}/{value}")
    }
}

/// Why a link was not opened, for the notice that says so.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeepLinkError {
    /// Not a `faf://` link at all.
    NotALink,
    /// A `faf://` link to something the client does not know.
    UnknownTarget(String),
    /// A known target with a value that cannot be one.
    BadValue(String),
}

/// Read a `faf://` link. The scheme and the target are compared without
/// regard to case; a trailing slash, which some browsers add, is ignored, and
/// so are a query and a fragment.
pub fn parse_deep_link(text: &str) -> Result<DeepLink, DeepLinkError> {
    let text = text.trim();
    let (scheme, rest) = text.split_once("://").ok_or(DeepLinkError::NotALink)?;
    if !scheme.eq_ignore_ascii_case(SCHEME) {
        return Err(DeepLinkError::NotALink);
    }
    let rest = rest.split(['?', '#']).next().unwrap_or_default();
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    let (target, value) = rest.split_once('/').unwrap_or((rest, ""));
    let target = target.to_ascii_lowercase();
    if !TARGETS.contains(&target.as_str()) {
        return Err(DeepLinkError::UnknownTarget(target));
    }
    let value = percent_decode(value)
        .filter(|value| !value.contains('/') && !value.contains('\\'))
        .ok_or_else(|| DeepLinkError::BadValue(value.to_owned()))?;
    let bad = || DeepLinkError::BadValue(value.clone());
    let word = |max: usize, extra: &[char]| {
        !value.is_empty()
            && value.chars().count() <= max
            && value
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || extra.contains(&c))
    };
    match target.as_str() {
        "tourney" | "tournament" if word(64, &['-', '_']) => Ok(DeepLink::Tourney { id: value }),
        // Old vault maps have spaces and other punctuation in their folder
        // names, so the folder is anything printable that is not a path.
        "map" if is_folder_name(&value) => Ok(DeepLink::Map { folder_name: value }),
        "mod" if word(64, &['-', '_', '.']) => Ok(DeepLink::Mod { uid: value }),
        "replay" => value
            .parse::<i32>()
            .ok()
            .filter(|id| *id > 0 && value.bytes().all(|c| c.is_ascii_digit()))
            .map(|id| DeepLink::Replay { id })
            .ok_or_else(bad),
        "changelog" if word(32, &['.', '-', '_']) => Ok(DeepLink::Changelog { release: value }),
        "units" | "unit" if word(16, &['_']) => Ok(DeepLink::Unit {
            id: value.to_ascii_uppercase(),
        }),
        _ => Err(bad()),
    }
}

fn is_folder_name(value: &str) -> bool {
    !value.is_empty()
        && value.chars().count() <= 128
        && value != "."
        && value != ".."
        && !value
            .chars()
            .any(|c| c.is_control() || matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|'))
}

/// The first `faf://` link among a process's arguments, the way the operating
/// system starts a registered handler: the executable, then the link. Only an
/// argument that starts with the scheme counts, so nothing else this client is
/// started with is ever read as a link.
pub fn deep_link_argument(argv: &[String]) -> Option<&str> {
    let prefix = format!("{SCHEME}://");
    argv.iter().skip(1).map(String::as_str).find(|argument| {
        argument.len() > prefix.len()
            && argument
                .get(..prefix.len())
                .is_some_and(|start| start.eq_ignore_ascii_case(&prefix))
    })
}

fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' => {
                let hex = text.get(index + 1..index + 3)?;
                out.push(u8::from_str_radix(hex, 16).ok()?);
                index += 3;
            }
            b'+' => {
                out.push(b' ');
                index += 1;
            }
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

fn percent_encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link(text: &str) -> DeepLink {
        parse_deep_link(text).unwrap_or_else(|error| panic!("{text}: {error:?}"))
    }

    #[test]
    fn every_target_reads() {
        assert_eq!(
            link("faf://tourney/42"),
            DeepLink::Tourney { id: "42".into() }
        );
        assert_eq!(
            link("faf://map/setons_clutch.v0004"),
            DeepLink::Map {
                folder_name: "setons_clutch.v0004".into()
            }
        );
        assert_eq!(
            link("faf://mod/e2d7e6c4-3a1b-4bd4-9b2a-9d4b3c2a1f00"),
            DeepLink::Mod {
                uid: "e2d7e6c4-3a1b-4bd4-9b2a-9d4b3c2a1f00".into()
            }
        );
        assert_eq!(
            link("faf://replay/23456789"),
            DeepLink::Replay { id: 23_456_789 }
        );
        assert_eq!(
            link("faf://changelog/3837"),
            DeepLink::Changelog {
                release: "3837".into()
            }
        );
        assert_eq!(
            link("faf://units/uel0201"),
            DeepLink::Unit {
                id: "UEL0201".into()
            }
        );
    }

    #[test]
    fn what_browsers_and_people_add_is_tolerated() {
        assert_eq!(
            link("FAF://Tourney/42/"),
            DeepLink::Tourney { id: "42".into() }
        );
        assert_eq!(
            link("faf://replay/7?ref=discord#x"),
            DeepLink::Replay { id: 7 }
        );
        assert_eq!(
            link("faf://map/Old%20Map%20(final)"),
            DeepLink::Map {
                folder_name: "Old Map (final)".into()
            },
            "old vault maps have spaces in their folders"
        );
        assert_eq!(
            link("  faf://unit/xsl0401  "),
            DeepLink::Unit {
                id: "XSL0401".into()
            }
        );
    }

    #[test]
    fn anything_else_is_refused_and_says_why() {
        assert_eq!(
            parse_deep_link("https://faforever.com"),
            Err(DeepLinkError::NotALink)
        );
        assert_eq!(
            parse_deep_link("faf:tourney/1"),
            Err(DeepLinkError::NotALink)
        );
        assert_eq!(
            parse_deep_link("faf://game/12"),
            Err(DeepLinkError::UnknownTarget("game".into()))
        );
        assert_eq!(
            parse_deep_link("faf://tourney"),
            Err(DeepLinkError::BadValue(String::new()))
        );
        for bad in [
            "faf://replay/-3",
            "faf://replay/0",
            "faf://replay/1e3",
            "faf://replay/99999999999",
            "faf://tourney/a b",
            "faf://map/..",
            "faf://map/a%2Fb",
            "faf://map/a/b",
            "faf://map/C:%5Cwindows",
            "faf://units/UEL0201%00",
            "faf://map/%zz",
            "faf://changelog/",
        ] {
            assert!(
                matches!(parse_deep_link(bad), Err(DeepLinkError::BadValue(_))),
                "{bad}: {:?}",
                parse_deep_link(bad)
            );
        }
    }

    #[test]
    fn a_link_writes_back_to_what_it_was_read_from() {
        for text in [
            "faf://tourney/42",
            "faf://map/Old%20Map%20%28final%29",
            "faf://replay/7",
            "faf://units/UEL0201",
        ] {
            assert_eq!(link(text).url(), text);
            assert_eq!(link(&link(text).url()), link(text));
        }
    }

    #[test]
    fn only_an_argument_with_the_scheme_is_a_link() {
        let argv = |rest: &[&str]| {
            std::iter::once("faf-client.exe")
                .chain(rest.iter().copied())
                .map(str::to_owned)
                .collect::<Vec<_>>()
        };
        assert_eq!(
            deep_link_argument(&argv(&["--flag", "faf://tourney/1"])),
            Some("faf://tourney/1")
        );
        assert_eq!(
            deep_link_argument(&argv(&["FAF://units/x"])),
            Some("FAF://units/x")
        );
        assert_eq!(deep_link_argument(&argv(&["replay.fafreplay"])), None);
        assert_eq!(deep_link_argument(&argv(&["faf://"])), None);
        assert_eq!(
            deep_link_argument(&["faf://tourney/1".to_owned()]),
            None,
            "argv[0] is the program"
        );
    }
}
