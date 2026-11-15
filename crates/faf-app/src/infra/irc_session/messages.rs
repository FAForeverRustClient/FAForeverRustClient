use super::*;

pub(super) fn decide(line: &irc::IrcLine, state: &mut SessionState) -> Vec<Effect> {
    match line.command.as_str() {
        "PRIVMSG" | "NOTICE" => message(line, state),
        "TAGMSG" => tags(line, state),
        "REDACT" => redaction(line, state),
        _ => vec![],
    }
}

fn message(line: &irc::IrcLine, state: &mut SessionState) -> Vec<Effect> {
    let mut effects = Vec::new();
    let (Some(sender), Some(target), Some(content)) =
        (line.prefix_nick(), line.params.first(), line.params.get(1))
    else {
        return effects;
    };
    // Server notices (a prefix with no `!user@host`) are MOTD-style
    // chatter that belongs in a log, not in a channel: the Java client
    // doesn't surface them either.
    let from_server = line.prefix.as_deref().is_none_or(|p| !p.contains('!'));
    if from_server || sender.starts_with("HistServ") {
        return effects;
    }

    // A message addressed to us personally opens a conversation named
    // after the sender; anything else belongs to its channel.
    let channel = conversation(target, sender, state);
    if line
        .tag("msgid")
        .is_some_and(|id| state.redacted.iter().any(|held| held == id))
    {
        return effects;
    }
    let (kind, text) = match irc::parse_ctcp_action(content) {
        Some(action) => (ChatMessageKind::Action, action.to_string()),
        None if line.command == "NOTICE" => (ChatMessageKind::Notice, content.clone()),
        // A non-ACTION CTCP request (VERSION, PING, …) is not chat.
        None if content.starts_with('\u{1}') => return effects,
        None => (ChatMessageKind::Message, content.clone()),
    };
    effects.push(Effect::Message {
        channel,
        sender: sender.to_string(),
        content: text,
        kind,
        timestamp: line.server_time().map(str::to_string),
        msgid: line.tag("msgid").unwrap_or_default().to_string(),
        reply_to: line.tag("+draft/reply").unwrap_or_default().to_string(),
    });
    effects
}

fn tags(line: &irc::IrcLine, state: &mut SessionState) -> Vec<Effect> {
    let mut effects = Vec::new();
    let (Some(sender), Some(target)) = (line.prefix_nick(), line.params.first()) else {
        return effects;
    };
    let channel = conversation(target, sender, state);
    if line
        .tag("msgid")
        .is_some_and(|id| state.redacted.iter().any(|held| held == id))
    {
        return effects;
    }

    // With echo-message our own typing notices come back, and event
    // playback can replay old ones inside a history batch. Neither is
    // somebody composing now.
    let replayed = in_history_batch(line, state);
    let typing = line
        .tag("+typing")
        .filter(|_| !replayed && !state.is_me(sender));
    if let Some(state) = typing {
        effects.push(Effect::Emit(ChatUpdate::Typing {
            channel: channel.clone(),
            nickname: sender.to_string(),
            // `paused` and `done` both mean "take it down"; only
            // `active` means someone is still composing.
            composing: state.eq_ignore_ascii_case("active"),
        }));
    }

    if let Some(emoji) = line.tag("+draft/unreact") {
        let msgid = line.tag("+draft/reply").unwrap_or_default();
        if !msgid.is_empty() && !emoji.is_empty() {
            effects.push(Effect::Emit(ChatUpdate::ReactionRemoved {
                channel: channel.clone(),
                msgid: msgid.to_string(),
                emoji: emoji.to_string(),
                sender: sender.to_string(),
            }));
        }
    }

    if let Some(emoji) = line.tag("+draft/react") {
        // Without a reply tag the reaction has nothing to attach to.
        // Ergochat relays the tags verbatim, so a client that omits it
        // produces exactly this, and dropping is the only honest
        // response: guessing "the newest message" would put the emoji
        // on whatever happened to arrive last.
        let msgid = line.tag("+draft/reply").unwrap_or_default();
        if !msgid.is_empty() && !emoji.is_empty() {
            if let Some(id) = line.tag("msgid").filter(|id| !id.is_empty()) {
                if !state.reaction_events.iter().any(|event| event.id == id) {
                    state.reaction_events.push_back(ReactionEvent {
                        id: id.to_string(),
                        channel: channel.clone(),
                        msgid: msgid.to_string(),
                        emoji: emoji.to_string(),
                        sender: sender.to_string(),
                    });
                    if state.reaction_events.len() > MAX_REACTION_EVENTS {
                        state.reaction_events.pop_front();
                    }
                }
            }
            effects.push(Effect::Emit(ChatUpdate::Reaction {
                channel,
                msgid: msgid.to_string(),
                emoji: emoji.to_string(),
                sender: sender.to_string(),
            }));
        }
    }
    effects
}

fn redaction(line: &irc::IrcLine, state: &mut SessionState) -> Vec<Effect> {
    let mut effects = Vec::new();
    let (Some(target), Some(id)) = (line.params.first(), line.params.get(1)) else {
        return effects;
    };
    let sender = line.prefix_nick().unwrap_or_default();
    let channel = conversation(target, sender, state);
    if !state.redacted.iter().any(|held| held == id) {
        state.redacted.push_back(id.clone());
        if state.redacted.len() > MAX_REACTION_EVENTS {
            state.redacted.pop_front();
        }
    }
    if let Some(index) = state
        .reaction_events
        .iter()
        .position(|event| event.id == *id && event.channel.eq_ignore_ascii_case(&channel))
    {
        let event = state
            .reaction_events
            .remove(index)
            .expect("reaction index exists");
        if !state.reaction_events.iter().any(|other| {
            other.channel.eq_ignore_ascii_case(&event.channel)
                && other.msgid == event.msgid
                && other.emoji == event.emoji
                && other.sender.eq_ignore_ascii_case(&event.sender)
        }) {
            effects.push(Effect::Emit(ChatUpdate::ReactionRemoved {
                channel: event.channel,
                msgid: event.msgid,
                emoji: event.emoji,
                sender: event.sender,
            }));
        }
    } else {
        state
            .reaction_events
            .retain(|event| !(event.channel.eq_ignore_ascii_case(&channel) && event.msgid == *id));
        effects.push(Effect::Emit(ChatUpdate::MessageRedacted {
            channel,
            msgid: id.clone(),
        }));
    }
    effects
}
