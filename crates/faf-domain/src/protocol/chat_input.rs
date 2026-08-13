//! Composer input grammar: the mIRC-style slash commands both reference
//! clients accept, parsed into an intent.
//!
//! The Python client parses these in its chat controller (`MessageAction`); we
//! keep the grammar here, next to the IRC codec, so the meaning of `/me` is
//! defined and tested once instead of being re-derived in the UI. Pure: no IO,
//! no state.

/// What the user meant by a line of composer input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChatInput {
    /// Ordinary text destined for the current channel.
    Message(String),
    /// `/me <text>`: a CTCP ACTION.
    Action(String),
    /// `/msg <nick> <text>`: opens (or continues) a private conversation.
    PrivateMessage { target: String, content: String },
    /// `/join <channel>`: `#` is added if the user omitted it.
    Join(String),
    /// `/part [reason]` or `/leave [reason]`: leaves the current channel.
    Leave { reason: String },
    /// `/topic <text>`: set the current channel's topic.
    Topic(String),
    /// A `/command` we don't implement, or one missing its arguments. Carries
    /// the offending word so the UI can say what went wrong rather than
    /// silently sending it to the channel as text.
    Unknown(String),
}

/// Parse one line of composer input. Leading/trailing whitespace is trimmed;
/// an all-whitespace line yields `Message("")`, which callers should drop.
///
/// A line starting with `//` is an escape hatch for sending literal text that
/// begins with a slash: the same convention mIRC and IRC clients generally use.
pub fn parse(raw: &str) -> ChatInput {
    let line = raw.trim();

    if let Some(escaped) = line.strip_prefix("//") {
        return ChatInput::Message(format!("/{escaped}"));
    }
    let Some(rest) = line.strip_prefix('/') else {
        return ChatInput::Message(line.to_string());
    };

    let (command, args) = match rest.split_once(char::is_whitespace) {
        Some((c, a)) => (c, a.trim()),
        None => (rest, ""),
    };

    match command.to_lowercase().as_str() {
        "me" if !args.is_empty() => ChatInput::Action(args.to_string()),
        "msg" | "query" | "pm" => match args.split_once(char::is_whitespace) {
            Some((target, content)) if !content.trim().is_empty() => ChatInput::PrivateMessage {
                target: target.to_string(),
                content: content.trim().to_string(),
            },
            _ => ChatInput::Unknown(format!("/{command}")),
        },
        "join" | "j" if !args.is_empty() => {
            let channel = args.split_whitespace().next().unwrap_or_default();
            ChatInput::Join(with_hash(channel))
        }
        "part" | "leave" | "close" => ChatInput::Leave {
            reason: args.to_string(),
        },
        "topic" if !args.is_empty() => ChatInput::Topic(args.to_string()),
        _ => ChatInput::Unknown(format!("/{command}")),
    }
}

/// Channel names need a leading `#`; the Java client's join field adds it for
/// the user, so the composer does too.
fn with_hash(name: &str) -> String {
    if name.starts_with('#') {
        name.to_string()
    } else {
        format!("#{name}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_text_is_a_message() {
        assert_eq!(
            parse("hello there"),
            ChatInput::Message("hello there".into())
        );
    }

    #[test]
    fn whitespace_is_trimmed() {
        assert_eq!(parse("  hi  "), ChatInput::Message("hi".into()));
        assert_eq!(parse("   "), ChatInput::Message(String::new()));
    }

    #[test]
    fn double_slash_escapes_a_literal_slash() {
        assert_eq!(
            parse("//me is literal"),
            ChatInput::Message("/me is literal".into())
        );
    }

    #[test]
    fn me_becomes_an_action() {
        assert_eq!(parse("/me waves"), ChatInput::Action("waves".into()));
        // Without text there is nothing to emote.
        assert_eq!(parse("/me"), ChatInput::Unknown("/me".into()));
    }

    #[test]
    fn msg_splits_target_from_content() {
        assert_eq!(
            parse("/msg Stormlord hey there"),
            ChatInput::PrivateMessage {
                target: "Stormlord".into(),
                content: "hey there".into(),
            }
        );
        assert_eq!(parse("/msg Stormlord"), ChatInput::Unknown("/msg".into()));
        assert_eq!(parse("/msg"), ChatInput::Unknown("/msg".into()));
    }

    #[test]
    fn query_and_pm_are_aliases_of_msg() {
        for line in ["/query Bob hi", "/pm Bob hi"] {
            assert_eq!(
                parse(line),
                ChatInput::PrivateMessage {
                    target: "Bob".into(),
                    content: "hi".into(),
                }
            );
        }
    }

    #[test]
    fn join_adds_the_missing_hash_and_ignores_extra_words() {
        assert_eq!(parse("/join newbie"), ChatInput::Join("#newbie".into()));
        assert_eq!(parse("/join #newbie"), ChatInput::Join("#newbie".into()));
        assert_eq!(parse("/j newbie now"), ChatInput::Join("#newbie".into()));
        assert_eq!(parse("/join"), ChatInput::Unknown("/join".into()));
    }

    #[test]
    fn leave_takes_an_optional_reason() {
        assert_eq!(
            parse("/part"),
            ChatInput::Leave {
                reason: String::new()
            }
        );
        assert_eq!(
            parse("/leave bye all"),
            ChatInput::Leave {
                reason: "bye all".into()
            }
        );
    }

    #[test]
    fn topic_requires_text() {
        assert_eq!(
            parse("/topic new topic"),
            ChatInput::Topic("new topic".into())
        );
        assert_eq!(parse("/topic"), ChatInput::Unknown("/topic".into()));
    }

    #[test]
    fn commands_are_case_insensitive() {
        assert_eq!(parse("/ME waves"), ChatInput::Action("waves".into()));
    }

    #[test]
    fn an_unimplemented_command_reports_itself() {
        assert_eq!(parse("/kick someone"), ChatInput::Unknown("/kick".into()));
    }
}
