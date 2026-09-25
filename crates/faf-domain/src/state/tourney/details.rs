//! What a tournament says about itself: rating gates, prizes, streams,
//! news posts, articles and the audit log.

use super::*;

/// One line of a tournament's audit log.
///
/// Organiser-only: the service withholds `tlog` from everybody else, and sends
/// at most the last three hundred lines, newest first. Every organiser write
/// leaves one, which makes it the only place a co-organiser can see what
/// somebody else changed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    /// Unix seconds. The service stores milliseconds.
    pub at: Option<u32>,
    /// Who did it, already rendered by the service: an organiser's name, or a
    /// phrase like "Organizer link" for a token holder with no account.
    pub by: String,
    /// What they did, as a sentence the service composed.
    pub text: String,
}

/// Rating limits an organiser set on entry.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RatingGate {
    pub min: Option<i32>,
    pub max: Option<i32>,
    /// Ceiling on a whole team's combined rating.
    pub max_team: Option<i32>,
    /// Individual ratings are counted as at most this when summing a team.
    pub cap: Option<i32>,
}

/// The three currencies a cash prize may be named in.
///
/// The service's own list (`PRIZE_CURRENCIES`), and closed rather than a free
/// string: it decides which symbol is drawn, and an unknown code would render
/// as a bare number that reads as dollars to half the audience.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Currency {
    Usd,
    Eur,
    Rub,
}

impl Currency {
    pub fn from_wire(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_uppercase().as_str() {
            "USD" => Some(Self::Usd),
            "EUR" => Some(Self::Eur),
            "RUB" => Some(Self::Rub),
            _ => None,
        }
    }

    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Usd => "USD",
            Self::Eur => "EUR",
            Self::Rub => "RUB",
        }
    }
}

/// The headline cash prize, where an event has one.
///
/// A pair rather than a formatted string: the service stores the two halves and
/// formatting them is the client's job, since doing it here would freeze one
/// locale's punctuation into the state. Both halves are always present or the
/// whole thing is `None`, which mirrors `cleanPrize`: it answers
/// `{currency: null, amount: null}` for any pair it does not like, and half a
/// prize is not a prize.
///
/// The amount is held in cents rather than as a float. The service rounds to
/// two decimals (`Math.round(n * 100) / 100`), so cents are exact, and an
/// integer keeps the whole state tree comparable by `Eq` for a field that is
/// `$100` in practice. `i32` rather than `i64` because the bindings generator
/// refuses 64-bit integers, and it caps this at twenty-one million dollars.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Prize {
    pub currency: Currency,
    pub amount_cents: i32,
}

/// A livestream the organiser named, with an optional word about it.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Stream {
    /// Always `http(s)`: the service refuses every other scheme on the way in,
    /// and the frontend's own allow-list refuses it again on the way out.
    pub url: String,
    /// What this stream is, e.g. "Main stream (English)". Often empty.
    pub info: String,
}

/// A rules or FAQ page.
///
/// Site-wide rather than per-tournament: the tournament team writes them once
/// and every official event points at the same text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Article {
    pub id: String,
    pub title: String,
    /// Reduced to plain text on the way in, like every other field somebody
    /// else's editor produced.
    pub body: String,
    /// Set on a sub-page, so the list can be shown as the two levels it is.
    pub parent_id: Option<String>,
}

/// One announcement from the organiser.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NewsPost {
    pub id: String,
    pub body: String,
    /// Who wrote it.
    pub by: String,
    /// Unix seconds.
    pub at: Option<u32>,
    /// When it was last corrected, in Unix seconds, or `None` for a post that
    /// stands as written. Shown rather than acted on: a schedule change that
    /// has itself been changed is worth flagging.
    pub edited_at: Option<u32>,
    /// Marked urgent by the organiser: a schedule change rather than a note.
    pub important: bool,
}
