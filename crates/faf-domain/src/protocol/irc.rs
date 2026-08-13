//! IRC wire codec: pure line parsing/formatting for the FAF chat protocol.
//!
//! FAF chat is plain IRC (Ergochat) tunneled over a WebSocket: one complete IRC
//! line per WS text frame in both directions (see `faf-app/infra/irc.rs`). This
//! module only deals with the line grammar itself: no IO, no async.

/// IRC mode-prefix characters a nick can carry in `NAMES` replies and in the
/// source of a message. Ordered strongest-first, matching Ergochat.
pub const ELEVATION_PREFIXES: [char; 5] = ['~', '&', '@', '%', '+'];

/// One parsed IRC line: optional IRCv3 `@tags`, an optional `:prefix`, a
/// command (verb or 3-digit numeric), and its params (the last of which may
/// have been sent `:trailing`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct IrcLine {
    /// Raw `key=value` message tags, in the order they were sent. Kept rather
    /// than discarded because `server-time` is what puts replayed
    /// `CHATHISTORY` lines at their original instant instead of at receipt time.
    pub tags: Vec<(String, String)>,
    pub prefix: Option<String>,
    pub command: String,
    pub params: Vec<String>,
}

impl IrcLine {
    /// The nick portion of the prefix (`nick!user@host` -> `nick`), stripped of
    /// any mode prefix, if any.
    pub fn prefix_nick(&self) -> Option<&str> {
        // Strip the elevation prefix *first*: the `@` of `user@host` would
        // otherwise be found before the `!`, truncating the nick to nothing.
        let prefix = strip_nick_prefix(self.prefix.as_deref()?);
        let end = prefix.find(['!', '@']).unwrap_or(prefix.len());
        Some(&prefix[..end])
    }

    pub fn tag(&self, key: &str) -> Option<&str> {
        self.tags
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }

    /// The IRCv3 `server-time` tag (an RFC 3339 instant), if the server sent
    /// one. Present on every line once the `server-time` capability is
    /// negotiated, which is what makes history backfill order correctly.
    pub fn server_time(&self) -> Option<&str> {
        self.tag("time").filter(|t| !t.is_empty())
    }
}

/// Parse one raw IRC line (a single WS frame), including any leading `@tags`.
pub fn parse_line(line: &str) -> Option<IrcLine> {
    let line = line.trim_end_matches(['\r', '\n']);
    if line.is_empty() {
        return None;
    }

    let mut rest = line;
    let mut tags = Vec::new();
    if let Some(after_at) = rest.strip_prefix('@') {
        let (raw_tags, after) = after_at.split_once(' ')?;
        tags = parse_tags(raw_tags);
        rest = after.trim_start();
    }

    let prefix = if let Some(after_colon) = rest.strip_prefix(':') {
        let (p, after) = after_colon.split_once(' ')?;
        rest = after.trim_start();
        Some(p.to_string())
    } else {
        None
    };

    let (command, mut params_rest) = match rest.split_once(' ') {
        Some((c, p)) => (c.to_string(), p),
        None => (rest.to_string(), ""),
    };
    if command.is_empty() {
        return None;
    }

    let mut params = Vec::new();
    loop {
        params_rest = params_rest.trim_start();
        if params_rest.is_empty() {
            break;
        }
        if let Some(trailing) = params_rest.strip_prefix(':') {
            params.push(trailing.to_string());
            break;
        }
        match params_rest.split_once(' ') {
            Some((p, remainder)) => {
                params.push(p.to_string());
                params_rest = remainder;
            }
            None => {
                params.push(params_rest.to_string());
                break;
            }
        }
    }

    Some(IrcLine {
        tags,
        prefix,
        command: command.to_ascii_uppercase(),
        params,
    })
}

/// Split the `@`-segment of a line into `key=value` pairs, undoing the escape
/// sequences the IRCv3 message-tags spec defines for the value.
fn parse_tags(raw: &str) -> Vec<(String, String)> {
    raw.split(';')
        .filter(|t| !t.is_empty())
        .map(|tag| match tag.split_once('=') {
            Some((k, v)) => (k.to_string(), unescape_tag_value(v)),
            None => (tag.to_string(), String::new()),
        })
        .collect()
}

fn unescape_tag_value(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some(':') => out.push(';'),
            Some('s') => out.push(' '),
            Some('r') => out.push('\r'),
            Some('n') => out.push('\n'),
            Some('\\') => out.push('\\'),
            // "\<anything else>" is defined as the literal character.
            Some(other) => out.push(other),
            None => {}
        }
    }
    out
}

/// Format one IRC line from a command and its params. The last param is sent
/// `:trailing` if it is empty, contains a space, or itself starts with `:`,
/// exactly when the grammar requires it.
pub fn format_line(command: &str, params: &[&str]) -> String {
    let mut out = String::from(command);
    if let Some((last, init)) = params.split_last() {
        for p in init {
            out.push(' ');
            out.push_str(p);
        }
        out.push(' ');
        if last.is_empty() || last.contains(' ') || last.starts_with(':') {
            out.push(':');
        }
        out.push_str(last);
    }
    out
}

/// Build a SASL PLAIN payload: base64 of `authzid\0authcid\0password`.
pub fn sasl_plain_payload(authzid: &str, authcid: &str, password: &str) -> String {
    use base64::Engine as _;
    let raw = format!("{authzid}\0{authcid}\0{password}");
    base64::engine::general_purpose::STANDARD.encode(raw)
}

/// Strip IRC mode-prefix characters (as seen in NAMES/353 replies) from a nick.
pub fn strip_nick_prefix(name: &str) -> &str {
    name.trim_start_matches(ELEVATION_PREFIXES)
}

/// The mode-prefix characters a NAMES entry carries, e.g. `"@nick"` -> `"@"`.
/// Empty for an unprivileged nick.
pub fn nick_prefix(name: &str) -> &str {
    let end = name.len() - strip_nick_prefix(name).len();
    &name[..end]
}

/// Wrap text as a CTCP `ACTION`: the wire form of `/me`.
pub fn ctcp_action(text: &str) -> String {
    format!("\u{1}ACTION {text}\u{1}")
}

/// Unwrap a CTCP `ACTION` payload, or `None` if this isn't one. Other CTCP
/// verbs (VERSION, PING, …) also return `None`: we neither display nor answer
/// them, matching the reference clients' handling of chat-visible CTCP.
pub fn parse_ctcp_action(content: &str) -> Option<&str> {
    let inner = content.strip_prefix('\u{1}')?;
    let inner = inner.strip_suffix('\u{1}').unwrap_or(inner);
    inner
        .strip_prefix("ACTION ")
        .or_else(|| (inner == "ACTION").then_some(""))
}

/// Apply an IRC `MODE` change to a nick's current elevation string.
///
/// `modes` is the mode argument (`"+o"`, `"-v"`, `"+ov"`, …); only the
/// membership modes that map to a visible prefix are considered, exactly like
/// the Python client's `_parse_elevation`. Returns the new elevation, ordered
/// strongest-first so `nick_prefix`-style comparisons stay stable.
pub fn apply_mode(current: &str, modes: &str) -> String {
    let prefix_for = |m: char| match m {
        'q' => Some('~'),
        'a' => Some('&'),
        'o' => Some('@'),
        'h' => Some('%'),
        'v' => Some('+'),
        _ => None,
    };

    let mut active: Vec<char> = current.chars().collect();
    let mut adding = true;
    for c in modes.chars() {
        match c {
            '+' => adding = true,
            '-' => adding = false,
            _ => {
                let Some(prefix) = prefix_for(c) else {
                    continue;
                };
                if adding {
                    if !active.contains(&prefix) {
                        active.push(prefix);
                    }
                } else {
                    active.retain(|p| *p != prefix);
                }
            }
        }
    }

    ELEVATION_PREFIXES
        .iter()
        .filter(|p| active.contains(p))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_simple_command_with_trailing() {
        let line = parse_line("PING :abc").unwrap();
        assert_eq!(line.prefix, None);
        assert_eq!(line.command, "PING");
        assert_eq!(line.params, vec!["abc"]);
    }

    #[test]
    fn parses_prefixed_numeric_with_multiple_params() {
        let line = parse_line(":irc.faforever.com 001 nick :Welcome").unwrap();
        assert_eq!(line.prefix.as_deref(), Some("irc.faforever.com"));
        assert_eq!(line.command, "001");
        assert_eq!(line.params, vec!["nick", "Welcome"]);
    }

    #[test]
    fn parses_privmsg_and_extracts_nick_from_prefix() {
        let line = parse_line(":nick!user@host PRIVMSG #aeolus :hello world").unwrap();
        assert_eq!(line.prefix_nick(), Some("nick"));
        assert_eq!(line.command, "PRIVMSG");
        assert_eq!(line.params, vec!["#aeolus", "hello world"]);
    }

    #[test]
    fn parses_names_reply_with_multiple_nicks_in_trailing() {
        let line =
            parse_line(":irc.faforever.com 353 nick = #aeolus :user1 @user2 +user3").unwrap();
        assert_eq!(line.command, "353");
        assert_eq!(
            line.params,
            vec!["nick", "=", "#aeolus", "user1 @user2 +user3"]
        );
    }

    #[test]
    fn parses_leading_tags_and_exposes_server_time() {
        let line =
            parse_line("@time=2024-01-01T00:00:00.000Z :nick!u@h PRIVMSG #aeolus :hi").unwrap();
        assert_eq!(line.prefix_nick(), Some("nick"));
        assert_eq!(line.command, "PRIVMSG");
        assert_eq!(line.params, vec!["#aeolus", "hi"]);
        assert_eq!(line.server_time(), Some("2024-01-01T00:00:00.000Z"));
    }

    #[test]
    fn parses_multiple_tags_including_valueless_ones() {
        let line = parse_line("@time=2024-01-01T00:00:00Z;draft/bot PING :x").unwrap();
        assert_eq!(line.tag("time"), Some("2024-01-01T00:00:00Z"));
        assert_eq!(line.tag("draft/bot"), Some(""));
        assert_eq!(line.tag("absent"), None);
    }

    #[test]
    fn unescapes_tag_values() {
        let line = parse_line(r"@msg=a\sb\:c\\d PING :x").unwrap();
        assert_eq!(line.tag("msg"), Some("a b;c\\d"));
    }

    #[test]
    fn a_line_without_tags_has_no_server_time() {
        assert_eq!(parse_line("PING :x").unwrap().server_time(), None);
    }

    #[test]
    fn prefix_nick_strips_an_elevation_prefix() {
        let line = parse_line(":@op!u@h PRIVMSG #aeolus :hi").unwrap();
        assert_eq!(line.prefix_nick(), Some("op"));
    }

    #[test]
    fn parses_cap_ack() {
        let line = parse_line("CAP * ACK :sasl").unwrap();
        assert_eq!(line.prefix, None);
        assert_eq!(line.command, "CAP");
        assert_eq!(line.params, vec!["*", "ACK", "sasl"]);
    }

    #[test]
    fn command_only_has_no_params() {
        let line = parse_line("PING").unwrap();
        assert_eq!(line.command, "PING");
        assert!(line.params.is_empty());
    }

    #[test]
    fn allows_empty_trailing_param() {
        let line = parse_line("JOIN #aeolus :").unwrap();
        assert_eq!(line.params, vec!["#aeolus", ""]);
    }

    #[test]
    fn empty_line_is_none() {
        assert_eq!(parse_line(""), None);
        assert_eq!(parse_line("\r\n"), None);
    }

    #[test]
    fn format_line_no_trailing_needed() {
        assert_eq!(format_line("JOIN", &["#aeolus"]), "JOIN #aeolus");
        assert_eq!(format_line("NICK", &["foo"]), "NICK foo");
    }

    #[test]
    fn format_line_adds_colon_when_trailing_has_space() {
        assert_eq!(
            format_line("PRIVMSG", &["#aeolus", "hello world"]),
            "PRIVMSG #aeolus :hello world"
        );
    }

    #[test]
    fn format_line_adds_colon_for_empty_trailing() {
        assert_eq!(format_line("JOIN", &["#aeolus", ""]), "JOIN #aeolus :");
    }

    #[test]
    fn format_line_no_params() {
        assert_eq!(format_line("CAP END", &[]), "CAP END");
    }

    #[test]
    fn sasl_plain_matches_rfc4616_example() {
        // RFC 4616 §2 example: authzid "", authcid "tim", password "tanstaaftanstaaf".
        assert_eq!(
            sasl_plain_payload("", "tim", "tanstaaftanstaaf"),
            "AHRpbQB0YW5zdGFhZnRhbnN0YWFm"
        );
    }

    #[test]
    fn strips_nick_mode_prefixes() {
        assert_eq!(strip_nick_prefix("@moderator"), "moderator");
        assert_eq!(strip_nick_prefix("+voiced"), "voiced");
        assert_eq!(strip_nick_prefix("plain"), "plain");
        assert_eq!(strip_nick_prefix("~owner"), "owner");
    }

    #[test]
    fn extracts_nick_mode_prefixes() {
        assert_eq!(nick_prefix("@moderator"), "@");
        assert_eq!(nick_prefix("~&owner"), "~&");
        assert_eq!(nick_prefix("plain"), "");
    }

    #[test]
    fn round_trips_a_ctcp_action() {
        let wire = ctcp_action("waves");
        assert_eq!(wire, "\u{1}ACTION waves\u{1}");
        assert_eq!(parse_ctcp_action(&wire), Some("waves"));
    }

    #[test]
    fn tolerates_a_ctcp_action_missing_its_closing_delimiter() {
        assert_eq!(parse_ctcp_action("\u{1}ACTION waves"), Some("waves"));
    }

    #[test]
    fn plain_text_and_other_ctcp_are_not_actions() {
        assert_eq!(parse_ctcp_action("just talking"), None);
        assert_eq!(parse_ctcp_action("\u{1}VERSION\u{1}"), None);
    }

    #[test]
    fn mode_grants_and_revokes_elevation() {
        assert_eq!(apply_mode("", "+o"), "@");
        assert_eq!(apply_mode("@", "-o"), "");
        assert_eq!(apply_mode("", "+ov"), "@+");
        assert_eq!(apply_mode("@+", "-v"), "@");
    }

    #[test]
    fn mode_handles_mixed_signs_and_ignores_unrelated_modes() {
        assert_eq!(apply_mode("", "+o-v"), "@");
        assert_eq!(apply_mode("@", "+b"), "@");
    }

    #[test]
    fn mode_result_is_ordered_strongest_first_and_deduplicated() {
        assert_eq!(apply_mode("+", "+q"), "~+");
        assert_eq!(apply_mode("@", "+o"), "@");
    }
}
