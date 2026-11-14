//! Notices: what the server says to the player rather than to the client.

use serde_json::Value;

/// Operational severity attached to a lobby `notice` frame.
///
/// `Kill` and `Kick` are commands as well as presentation hints: the former
/// terminates the active FA process, while the latter ends this lobby session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServerNoticeStyle {
    Info,
    Warning,
    Error,
    Kill,
    Kick,
}

/// A `notice` message: how the server means it, and its words.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notice {
    pub style: ServerNoticeStyle,
    /// The server's text, trimmed and bounded. It is the server's markup, not
    /// plain text: see [`Self::plain_text`].
    pub text: String,
}

impl Notice {
    pub(super) fn decode(value: &Value) -> Self {
        let (style, text) = parse_server_notice(value);
        Self { style, text }
    }

    /// The greeting every client that is not the official one gets on every
    /// sign-in. Nobody can act on it, so it is shown nowhere.
    pub fn is_unofficial_client_greeting(&self) -> bool {
        is_unofficial_client_notice(self.style, &self.text)
    }

    /// The server's answer to a banned account, after which it closes the
    /// connection and would refuse every new one the same way.
    pub fn is_ban(&self) -> bool {
        is_ban_notice(self.style, &self.text)
    }

    /// The text without the server's markup.
    pub fn plain_text(&self) -> String {
        plain_notice_text(&self.text)
    }
}

/// How much of the server's text is kept. It is shown to the player as it
/// came, and nothing says how long the server may make it.
pub(super) const MAX_SERVER_MESSAGE_CHARS: usize = 4_000;

/// The server's own words in a message's `text`, when it sent any: trimmed
/// and bounded.
pub(super) fn server_words(value: &Value) -> Option<String> {
    let text = value
        .get("text")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())?;
    Some(text.chars().take(MAX_SERVER_MESSAGE_CHARS).collect())
}

/// The same, with words of this client's own for a message that has none.
pub(super) fn server_text(value: &Value, fallback: &str) -> String {
    server_words(value).unwrap_or_else(|| fallback.chars().take(MAX_SERVER_MESSAGE_CHARS).collect())
}

pub(super) fn parse_server_notice(value: &Value) -> (ServerNoticeStyle, String) {
    let style = match value.get("style").and_then(Value::as_str) {
        Some("warning" | "warn") => ServerNoticeStyle::Warning,
        Some("error") => ServerNoticeStyle::Error,
        Some("kill") => ServerNoticeStyle::Kill,
        Some("kick") => ServerNoticeStyle::Kick,
        _ => ServerNoticeStyle::Info,
    };
    (style, server_text(value, "The lobby server sent a notice."))
}

/// The server greets every client it does not recognise as the official one
/// with "You are using an unofficial client version!", on every sign-in,
/// including each silent reconnect. It is not addressed to anyone who could act
/// on it (this client is unofficial on purpose), and it arrived as a required
/// notification with a sound several times an hour (#310). It is dropped here,
/// by its text, so any other `info` notice from the server still comes through.
pub(super) fn is_unofficial_client_notice(style: ServerNoticeStyle, text: &str) -> bool {
    style == ServerNoticeStyle::Info
        && text
            .trim_start()
            .to_ascii_lowercase()
            .starts_with("you are using an unofficial client")
}

/// The server's answer to a banned account (#488): `BanError` in
/// `server/exceptions.py`, sent as an `error` notice by `lobbyconnection.py`
/// just before it aborts the connection, at sign-in and again on a join or a
/// host. Matched by its text, because an `error` notice on its own is also
/// how the server reports a request it merely refused, with the connection
/// left open.
pub(super) fn is_ban_notice(style: ServerNoticeStyle, text: &str) -> bool {
    style == ServerNoticeStyle::Error
        && text
            .trim_start()
            .to_ascii_lowercase()
            .starts_with("you are banned from faf")
}

/// A notice's text without the markup the server writes into it: `<br>` as a
/// line break, any other tag dropped, and no more than one empty line in a row.
pub(super) fn plain_notice_text(text: &str) -> String {
    let mut plain = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('<') {
        plain.push_str(&rest[..start]);
        let Some(end) = rest[start..].find('>') else {
            plain.push_str(&rest[start..]);
            rest = "";
            break;
        };
        let tag = rest[start + 1..start + end]
            .trim()
            .trim_end_matches('/')
            .trim()
            .to_ascii_lowercase();
        if tag == "br" {
            plain.push('\n');
        }
        rest = &rest[start + end + 1..];
    }
    plain.push_str(rest);
    let mut lines: Vec<&str> = Vec::new();
    for line in plain.lines().map(str::trim) {
        if line.is_empty() && lines.last().is_none_or(|last| last.is_empty()) {
            continue;
        }
        lines.push(line);
    }
    while lines.last().is_some_and(|last| last.is_empty()) {
        lines.pop();
    }
    lines.join("\n")
}
