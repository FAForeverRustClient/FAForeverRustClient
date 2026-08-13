//! IRC wire codec — pure line parsing/formatting for the FAF chat protocol.
//!
//! FAF chat is plain IRC (Ergochat) tunneled over a WebSocket: one complete IRC
//! line per WS text frame in both directions (see `faf-app/infra/irc.rs`). This
//! module only deals with the line grammar itself — no IO, no async.

/// One parsed IRC line: an optional `:prefix`, a command (verb or 3-digit
/// numeric), and its params (the last of which may have been sent `:trailing`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IrcLine {
    pub prefix: Option<String>,
    pub command: String,
    pub params: Vec<String>,
}

impl IrcLine {
    /// The nick portion of the prefix (`nick!user@host` -> `nick`), if any.
    pub fn prefix_nick(&self) -> Option<&str> {
        let prefix = self.prefix.as_deref()?;
        let end = prefix.find(['!', '@']).unwrap_or(prefix.len());
        Some(&prefix[..end])
    }
}

/// Parse one raw IRC line (a single WS text frame). Tolerates and skips a
/// leading `@tags` segment even though we don't negotiate `message-tags` —
/// defensive against a server sending them anyway.
pub fn parse_line(line: &str) -> Option<IrcLine> {
    let line = line.trim_end_matches(['\r', '\n']);
    if line.is_empty() {
        return None;
    }

    let mut rest = line;
    if let Some(after_at) = rest.strip_prefix('@') {
        let (_tags, after) = after_at.split_once(' ')?;
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
        prefix,
        command: command.to_ascii_uppercase(),
        params,
    })
}

/// Format one IRC line from a command and its params. The last param is sent
/// `:trailing` if it is empty, contains a space, or itself starts with `:` —
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
    name.trim_start_matches(['~', '&', '@', '%', '+'])
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
        let line = parse_line(":irc.faforever.com 353 nick = #aeolus :user1 @user2 +user3").unwrap();
        assert_eq!(line.command, "353");
        assert_eq!(
            line.params,
            vec!["nick", "=", "#aeolus", "user1 @user2 +user3"]
        );
    }

    #[test]
    fn tolerates_and_skips_leading_tags() {
        let line = parse_line("@time=2024-01-01T00:00:00.000Z :nick!u@h PRIVMSG #aeolus :hi").unwrap();
        assert_eq!(line.prefix_nick(), Some("nick"));
        assert_eq!(line.command, "PRIVMSG");
        assert_eq!(line.params, vec!["#aeolus", "hi"]);
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
}
