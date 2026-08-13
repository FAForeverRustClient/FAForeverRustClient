//! The IRC session state machine: what to do about each inbound line.
//!
//! Split out of `infra::irc` because it is the part worth testing and was the
//! part that could not be: it used to be an `async fn` that wrote to a socket
//! and awaited a channel, so exercising one `MODE` line meant standing up a
//! `Sink` and an `mpsc`. It is now pure: line in, [`Effect`] list out: and
//! `infra::irc` is left owning the socket and performing them.
//!
//! This is also the file that has already broken chat once: `CAP LS 302`
//! licenses the server to attach *values* to capabilities (`sasl=PLAIN`), so
//! matching raw tokens found no `sasl` and killed the handshake. That kind of
//! bug is invisible in a transport test and obvious in a table of lines.
//!
//! It stays in `faf-app` rather than moving to `faf-domain` for one concrete
//! reason: its output vocabulary is [`ChatUpdate`], a *port* type. Moving the
//! logic without moving that would invert the dependency; moving both would
//! make a port type part of the domain. The pure/IO seam is clean here: the
//! crate seam is not.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use faf_domain::protocol::irc;
use faf_domain::state::{ChatMessageKind, ChatStatus, ChatUser};

use crate::ports::ChatUpdate;

/// Capabilities worth asking for. Anything the server does not offer is
/// dropped from the request rather than risking a `NAK`.
pub(crate) const WANTED_CAPS: [&str; 5] = [
    "sasl",
    "server-time",
    "message-tags",
    "multi-prefix",
    "draft/chathistory",
];

/// How much backlog to pull when a channel opens.
pub(crate) const HISTORY_LINES: u32 = 500;

/// Why a single connection attempt ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SessionEnd {
    /// `disconnect()` was called: stop for good.
    Cancelled,
    /// The socket closed (or never opened). Retry.
    Dropped,
    /// Authentication was rejected. Retrying with the same token is pointless;
    /// stop and let the user re-login.
    AuthFailed,
}

/// Something the caller must do as a result of a line.
///
/// Ordered: the caller performs them in sequence, and stops at the first that
/// fails. That preserves the old code's behaviour, where a failed write or a
/// dropped consumer returned immediately from the middle of an arm.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Effect {
    /// A raw line to write to the socket.
    Send(String),
    /// An update to hand to the chat service.
    Emit(ChatUpdate),
    /// A chat message to emit. Kept separate from [`Self::Emit`] because the
    /// id and the fallback timestamp come from the caller, which owns the
    /// counter and the clock: neither belongs in a pure function.
    Message {
        channel: String,
        sender: String,
        content: String,
        kind: ChatMessageKind,
        /// `server-time` when the server sent one; otherwise the caller
        /// stamps it.
        timestamp: Option<String>,
    },
    /// Our nick changed. Published so the rest of the client can see it.
    NickChanged(String),
    /// Stop trying to rejoin a channel: we were kicked from it.
    ForgetChannel(String),
    /// End the session.
    Stop(SessionEnd),
}

impl Effect {
    fn info(
        channel: &str,
        sender: &str,
        content: impl Into<String>,
        timestamp: Option<&str>,
    ) -> Self {
        Self::Message {
            channel: channel.to_string(),
            sender: sender.to_string(),
            content: content.into(),
            kind: ChatMessageKind::Info,
            timestamp: timestamp.map(str::to_string),
        }
    }
}

/// The connection's inputs that do not change while it runs.
pub(crate) struct SessionContext {
    pub username: String,
    pub sasl_token: String,
    /// Channels to join once registered. A snapshot: the live set is owned by
    /// the client and can change under us, which is exactly why the pure
    /// function gets a copy.
    pub wanted_channels: Vec<String>,
}

/// Mutable state of one connection: who we are, and who is in what.
pub(crate) struct SessionState {
    pub nick: String,
    /// Confirmed rosters, `channel -> (nick -> elevation)`.
    pub rosters: HashMap<String, BTreeMap<String, String>>,
    /// Names accumulated from `353` replies, flushed to `rosters` on `366`.
    pub pending_names: HashMap<String, BTreeMap<String, String>>,
    /// Capabilities the server granted.
    pub caps: BTreeSet<String>,
    /// Capabilities the server advertised, accumulated across `CAP LS` lines.
    pub offered_caps: BTreeSet<String>,
    /// Channels we've already asked history for, so a rejoin doesn't duplicate
    /// the backfill (the Python client keeps the same set).
    pub history_asked: BTreeSet<String>,
    /// Set once we've fallen back to requesting `sasl` alone after a NAK, so a
    /// second NAK is treated as fatal instead of looping.
    pub sasl_only_retry: bool,
    pub registered: bool,
}

impl SessionState {
    pub fn new(nick: String) -> Self {
        Self {
            nick,
            rosters: HashMap::new(),
            pending_names: HashMap::new(),
            caps: BTreeSet::new(),
            offered_caps: BTreeSet::new(),
            history_asked: BTreeSet::new(),
            sasl_only_retry: false,
            registered: false,
        }
    }

    pub fn is_me(&self, nick: &str) -> bool {
        nick.eq_ignore_ascii_case(&self.nick)
    }

    /// Every channel a nick is currently in: needed by `QUIT` and `NICK`,
    /// which arrive without a channel.
    fn channels_with(&self, nick: &str) -> Vec<String> {
        let mut found: Vec<String> = self
            .rosters
            .iter()
            .filter(|(_, roster)| roster.contains_key(nick))
            .map(|(channel, _)| channel.clone())
            .collect();
        // `HashMap` iteration order is arbitrary; without this a QUIT would
        // emit its per-channel updates in a different order every run, which
        // makes the behaviour untestable and the UI's ordering luck.
        found.sort();
        found
    }
}

/// Decide what one inbound line means.
///
/// Mutates `state` and returns the effects the caller must perform. Note that
/// the state is updated *fully* before any effect runs, where the old code
/// interleaved them; the difference is only observable when an effect fails,
/// which means the session is ending and this state is about to be dropped.
pub(crate) fn handle_line(
    line: &irc::IrcLine,
    state: &mut SessionState,
    ctx: &SessionContext,
) -> Vec<Effect> {
    let mut effects = Vec::new();

    match line.command.as_str() {
        "PING" => {
            let payload = line.params.first().cloned().unwrap_or_default();
            effects.push(Effect::Send(irc::format_line("PONG", &[&payload])));
        }
        "PONG" => {}
        "CAP" => match line.params.get(1).map(String::as_str) {
            Some("LS") => {
                // `CAP * LS * :<caps>` means more lines follow; the final line
                // omits the `*`. The capability list is always the trailing param.
                let more = line.params.get(2).map(String::as_str) == Some("*");
                if let Some(caps) = line.params.last() {
                    state.offered_caps.extend(capability_names(caps));
                }
                if more {
                    return effects;
                }
                if !state.offered_caps.contains("sasl") {
                    effects.push(Effect::Stop(SessionEnd::AuthFailed));
                    return effects;
                }
                let requested: Vec<&str> = WANTED_CAPS
                    .iter()
                    .copied()
                    .filter(|c| state.offered_caps.contains(*c))
                    .collect();
                effects.push(Effect::Send(irc::format_line(
                    "CAP",
                    &["REQ", &requested.join(" ")],
                )));
            }
            Some("ACK") => {
                if let Some(caps) = line.params.last() {
                    state.caps.extend(capability_names(caps));
                }
                effects.push(Effect::Send("AUTHENTICATE PLAIN".to_string()));
            }
            Some("NAK") => {
                // An optional capability must never cost us the connection:
                // drop back to the bare `sasl` request the client used before
                // it negotiated anything else. Only a second NAK is fatal.
                if state.sasl_only_retry {
                    effects.push(Effect::Stop(SessionEnd::AuthFailed));
                    return effects;
                }
                state.sasl_only_retry = true;
                effects.push(Effect::Send(irc::format_line("CAP", &["REQ", "sasl"])));
            }
            _ => {}
        },
        "AUTHENTICATE" => {
            if line.params.first().map(String::as_str) == Some("+") {
                let payload = irc::sasl_plain_payload(
                    "",
                    &ctx.username,
                    &format!("token:{}", ctx.sasl_token),
                );
                effects.push(Effect::Send(irc::format_line("AUTHENTICATE", &[&payload])));
            }
        }
        // RPL_SASLSUCCESS
        "903" => {
            effects.push(Effect::Send("CAP END".to_string()));
            effects.push(Effect::Send(irc::format_line("NICK", &[&state.nick])));
            effects.push(Effect::Send(irc::format_line(
                "USER",
                &[&state.nick, "0", "*", &state.nick],
            )));
        }
        "904" | "905" => {
            effects.push(Effect::Stop(SessionEnd::AuthFailed));
        }
        // ERR_NICKNAMEINUSE: take the same escape hatch as the Python client.
        "433" => {
            state.nick.push('_');
            effects.push(Effect::NickChanged(state.nick.clone()));
            effects.push(Effect::Send(irc::format_line("NICK", &[&state.nick])));
        }
        // RPL_WELCOME: registered. The server's idea of our nick wins.
        "001" => {
            if let Some(nick) = line.params.first() {
                state.nick = nick.clone();
                effects.push(Effect::NickChanged(nick.clone()));
            }
            state.registered = true;
            effects.push(Effect::Emit(ChatUpdate::Status(
                ChatStatus::Connected,
                state.nick.clone(),
            )));
            for channel in &ctx.wanted_channels {
                effects.push(Effect::Send(irc::format_line("JOIN", &[channel])));
            }
        }
        // RPL_NAMREPLY: the trailing param is a space-separated nick list.
        "353" => {
            let (Some(channel), Some(names)) = (line.params.get(2), line.params.last()) else {
                return effects;
            };
            let pending = state.pending_names.entry(channel.clone()).or_default();
            for entry in names.split_whitespace() {
                pending.insert(
                    irc::strip_nick_prefix(entry).to_string(),
                    irc::nick_prefix(entry).to_string(),
                );
            }
        }
        // RPL_ENDOFNAMES
        "366" => {
            let Some(channel) = line.params.get(1) else {
                return effects;
            };
            let roster = state.pending_names.remove(channel).unwrap_or_default();
            effects.push(Effect::Emit(ChatUpdate::Users {
                channel: channel.clone(),
                users: roster
                    .iter()
                    .map(|(name, elevation)| ChatUser::new(name, elevation))
                    .collect(),
            }));
            state.rosters.insert(channel.clone(), roster);
        }
        // RPL_TOPIC on join, and RPL_NOTOPIC.
        "332" | "331" => {
            let Some(channel) = line.params.get(1) else {
                return effects;
            };
            let topic = if line.command == "332" {
                line.params.last().cloned().unwrap_or_default()
            } else {
                String::new()
            };
            effects.push(Effect::Emit(ChatUpdate::Topic {
                channel: channel.clone(),
                topic,
            }));
        }
        "TOPIC" => {
            let (Some(channel), Some(topic)) = (line.params.first(), line.params.get(1)) else {
                return effects;
            };
            effects.push(Effect::Emit(ChatUpdate::Topic {
                channel: channel.clone(),
                topic: topic.clone(),
            }));
            if let Some(nick) = line.prefix_nick() {
                effects.push(Effect::info(
                    channel,
                    nick,
                    format!("changed the topic to: {topic}"),
                    line.server_time(),
                ));
            }
        }
        "JOIN" => {
            let (Some(nick), Some(channel)) = (line.prefix_nick(), line.params.first()) else {
                return effects;
            };
            if state.is_me(nick) {
                effects.push(Effect::Emit(ChatUpdate::ChannelJoined(channel.clone())));
                state.rosters.entry(channel.clone()).or_default();
                // Backfill the conversation so the tab doesn't open empty.
                if state.history_asked.insert(channel.clone()) {
                    effects.push(Effect::Send(irc::format_line(
                        "CHATHISTORY",
                        &["LATEST", channel, "*", &HISTORY_LINES.to_string()],
                    )));
                }
            } else {
                state
                    .rosters
                    .entry(channel.clone())
                    .or_default()
                    .insert(nick.to_string(), String::new());
                effects.push(Effect::Emit(ChatUpdate::UserJoined {
                    channel: channel.clone(),
                    user: ChatUser::new(nick, ""),
                }));
                effects.push(Effect::info(
                    channel,
                    nick,
                    "joined the channel.",
                    line.server_time(),
                ));
            }
        }
        "PART" => {
            let (Some(nick), Some(channel)) = (line.prefix_nick(), line.params.first()) else {
                return effects;
            };
            if state.is_me(nick) {
                state.rosters.remove(channel);
                state.history_asked.remove(channel);
                effects.push(Effect::Emit(ChatUpdate::ChannelLeft(channel.clone())));
            } else {
                if let Some(roster) = state.rosters.get_mut(channel) {
                    roster.remove(nick);
                }
                effects.push(Effect::Emit(ChatUpdate::UserLeft {
                    channel: channel.clone(),
                    user: nick.to_string(),
                }));
                effects.push(Effect::info(
                    channel,
                    nick,
                    "left the channel.",
                    line.server_time(),
                ));
            }
        }
        "KICK" => {
            let (Some(channel), Some(nick)) = (line.params.first(), line.params.get(1)) else {
                return effects;
            };
            if state.is_me(nick) {
                state.rosters.remove(channel);
                state.history_asked.remove(channel);
                effects.push(Effect::ForgetChannel(channel.clone()));
                effects.push(Effect::Emit(ChatUpdate::ChannelLeft(channel.clone())));
            } else {
                if let Some(roster) = state.rosters.get_mut(channel) {
                    roster.remove(nick);
                }
                effects.push(Effect::Emit(ChatUpdate::UserLeft {
                    channel: channel.clone(),
                    user: nick.clone(),
                }));
                effects.push(Effect::info(
                    channel,
                    nick,
                    "was kicked from the channel.",
                    line.server_time(),
                ));
            }
        }
        "QUIT" => {
            let Some(nick) = line.prefix_nick() else {
                return effects;
            };
            let reason = line.params.first().cloned().unwrap_or_default();
            // The Python client silences the server's default "Quit: <nick>"
            // text, which carries no information.
            let text = if reason.is_empty() || reason.contains(nick) {
                "quit.".to_string()
            } else {
                format!("quit: {reason}")
            };
            for channel in state.channels_with(nick) {
                if let Some(roster) = state.rosters.get_mut(&channel) {
                    roster.remove(nick);
                }
                effects.push(Effect::Emit(ChatUpdate::UserLeft {
                    channel: channel.clone(),
                    user: nick.to_string(),
                }));
                effects.push(Effect::info(
                    &channel,
                    nick,
                    text.clone(),
                    line.server_time(),
                ));
            }
        }
        "NICK" => {
            let (Some(old), Some(new)) = (line.prefix_nick(), line.params.first()) else {
                return effects;
            };
            if state.is_me(old) {
                state.nick = new.clone();
                effects.push(Effect::NickChanged(new.clone()));
            }
            for roster in state.rosters.values_mut() {
                if let Some(elevation) = roster.remove(old) {
                    roster.insert(new.clone(), elevation);
                }
            }
            effects.push(Effect::Emit(ChatUpdate::UserRenamed {
                old_name: old.to_string(),
                new_name: new.clone(),
            }));
        }
        "MODE" => {
            let Some(channel) = line.params.first() else {
                return effects;
            };
            if !channel.starts_with('#') {
                return effects; // a user mode on ourselves: nothing to show
            }
            let Some(modes) = line.params.get(1) else {
                return effects;
            };
            for (nick, modes) in membership_mode_changes(modes, &line.params[2..]) {
                let current = state
                    .rosters
                    .get(channel)
                    .and_then(|r| r.get(&nick))
                    .cloned()
                    .unwrap_or_default();
                let elevation = irc::apply_mode(&current, &modes);
                if let Some(roster) = state.rosters.get_mut(channel) {
                    if let Some(slot) = roster.get_mut(&nick) {
                        *slot = elevation.clone();
                    }
                }
                effects.push(Effect::Emit(ChatUpdate::UserElevation {
                    channel: channel.clone(),
                    user: nick,
                    elevation,
                }));
            }
        }
        "PRIVMSG" | "NOTICE" => {
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
            let channel = if target.starts_with('#') {
                target.clone()
            } else {
                sender.to_string()
            };
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
            });
        }
        _ => {} // numeric replies we don't need yet
    }

    effects
}

/// Capability *names* from a `CAP LS`/`CAP ACK` list.
///
/// `CAP LS 302` licenses the server to attach values, so Ergochat answers with
/// `sasl=PLAIN,EXTERNAL draft/chathistory=...` rather than bare names. Matching
/// the raw tokens against [`WANTED_CAPS`] therefore finds nothing: including
/// `sasl`, which aborts the handshake. Everything after the first `=` is the
/// value and is dropped here.
pub(crate) fn capability_names(list: &str) -> impl Iterator<Item = String> + '_ {
    list.split_whitespace().map(|cap| {
        cap.split_once('=')
            .map_or(cap, |(name, _)| name)
            .to_string()
    })
}

/// Pair each membership mode in a `MODE` change with the nick it applies to.
///
/// `MODE #chan +oo-v a b c` carries one argument per parameterised mode, in
/// order. Only `qaohv` (the modes that map to a visible prefix) are returned;
/// the others still consume their argument so the pairing stays aligned.
pub(crate) fn membership_mode_changes(modes: &str, args: &[String]) -> Vec<(String, String)> {
    /// Modes that always take an argument, whether set or cleared.
    const ARG_ALWAYS: &str = "qaohvbeIk";
    /// Modes that take an argument only when being set.
    const ARG_WHEN_SET: &str = "lfj";

    let mut changes: Vec<(String, String)> = Vec::new();
    let mut next_arg = args.iter();
    let mut adding = true;

    for c in modes.chars() {
        match c {
            '+' => adding = true,
            '-' => adding = false,
            _ => {
                let takes_arg = ARG_ALWAYS.contains(c) || (adding && ARG_WHEN_SET.contains(c));
                if !takes_arg {
                    continue;
                }
                let Some(arg) = next_arg.next() else { break };
                if !"qaohv".contains(c) {
                    continue;
                }
                let sign = if adding { '+' } else { '-' };
                match changes.iter_mut().find(|(nick, _)| nick == arg) {
                    Some((_, acc)) => {
                        acc.push(sign);
                        acc.push(c);
                    }
                    None => changes.push((arg.clone(), format!("{sign}{c}"))),
                }
            }
        }
    }
    changes
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> SessionContext {
        SessionContext {
            username: "Ada".into(),
            sasl_token: "tok".into(),
            wanted_channels: vec!["#aeolus".into()],
        }
    }

    /// Parse a raw line and hand it to the state machine.
    fn run(state: &mut SessionState, raw: &str) -> Vec<Effect> {
        let line = irc::parse_line(raw).unwrap_or_else(|| panic!("unparseable line: {raw}"));
        handle_line(&line, state, &ctx())
    }

    fn registered() -> SessionState {
        let mut state = SessionState::new("Ada".into());
        state.registered = true;
        state
    }

    fn sent(effects: &[Effect]) -> Vec<String> {
        effects
            .iter()
            .filter_map(|e| match e {
                Effect::Send(line) => Some(line.trim_end().to_string()),
                _ => None,
            })
            .collect()
    }

    fn emitted(effects: &[Effect]) -> Vec<&ChatUpdate> {
        effects
            .iter()
            .filter_map(|e| match e {
                Effect::Emit(update) => Some(update),
                _ => None,
            })
            .collect()
    }

    // ── handshake ────────────────────────────────────────────────────────

    #[test]
    fn a_ping_is_answered_with_its_payload() {
        let mut state = registered();
        assert_eq!(sent(&run(&mut state, "PING :abc123")), vec!["PONG abc123"]);
    }

    #[test]
    fn cap_ls_requests_only_what_the_server_offered() {
        // Asking for a capability the server lacks gets the *whole* request
        // NAK'd, taking `sasl` down with it.
        let mut state = SessionState::new("Ada".into());
        let effects = run(&mut state, ":srv CAP * LS :sasl server-time multi-prefix");
        let request = sent(&effects).join(" ");
        assert!(request.contains("sasl"));
        assert!(request.contains("server-time"));
        assert!(request.contains("multi-prefix"));
        assert!(
            !request.contains("draft/chathistory"),
            "not offered, must not be requested: {request}"
        );
    }

    #[test]
    fn cap_ls_302_values_are_stripped_before_matching() {
        // The regression that killed live chat: `CAP LS 302` lets the server
        // answer `sasl=PLAIN,EXTERNAL`, and matching raw tokens finds no
        // `sasl` at all.
        let mut state = SessionState::new("Ada".into());
        let effects = run(
            &mut state,
            ":srv CAP * LS :multi-prefix sasl=PLAIN,EXTERNAL draft/chathistory=1000 server-time",
        );
        assert!(state.offered_caps.contains("sasl"));
        let request = sent(&effects).join(" ");
        assert!(request.contains("sasl"), "got: {request}");
        assert!(
            !request.contains("PLAIN"),
            "the value must not be sent back"
        );
    }

    #[test]
    fn a_continued_cap_ls_waits_for_the_final_line() {
        // `CAP * LS * :<caps>` means more is coming. Requesting after the
        // first line would ask for half the list.
        let mut state = SessionState::new("Ada".into());
        let first = run(&mut state, ":srv CAP * LS * :multi-prefix");
        assert!(sent(&first).is_empty(), "must not request yet");
        assert!(state.offered_caps.contains("multi-prefix"));

        let second = run(&mut state, ":srv CAP * LS :sasl");
        assert_eq!(sent(&second).len(), 1, "now it requests");
        assert!(state.offered_caps.contains("multi-prefix"), "accumulated");
    }

    #[test]
    fn a_server_without_sasl_ends_the_session_rather_than_hanging() {
        let mut state = SessionState::new("Ada".into());
        let effects = run(&mut state, ":srv CAP * LS :multi-prefix server-time");
        assert_eq!(effects, vec![Effect::Stop(SessionEnd::AuthFailed)]);
    }

    #[test]
    fn a_cap_nak_falls_back_to_bare_sasl_once_then_gives_up() {
        // An optional capability must never cost the connection.
        let mut state = SessionState::new("Ada".into());
        let first = run(&mut state, ":srv CAP * NAK :sasl draft/chathistory");
        assert_eq!(sent(&first), vec!["CAP REQ sasl"]);
        assert!(state.sasl_only_retry);

        // A second NAK means even bare sasl was refused: that is fatal.
        let second = run(&mut state, ":srv CAP * NAK :sasl");
        assert_eq!(second, vec![Effect::Stop(SessionEnd::AuthFailed)]);
    }

    #[test]
    fn cap_ack_starts_the_sasl_exchange() {
        let mut state = SessionState::new("Ada".into());
        let effects = run(&mut state, ":srv CAP * ACK :sasl server-time");
        assert_eq!(sent(&effects), vec!["AUTHENTICATE PLAIN"]);
        assert!(state.caps.contains("sasl"));
    }

    #[test]
    fn the_authenticate_challenge_sends_the_token_payload() {
        let mut state = SessionState::new("Ada".into());
        let effects = run(&mut state, "AUTHENTICATE +");
        let line = sent(&effects).join("");
        assert!(line.starts_with("AUTHENTICATE "));
        let expected = irc::sasl_plain_payload("", "Ada", "token:tok");
        assert!(line.contains(&expected));
    }

    #[test]
    fn sasl_success_registers() {
        let mut state = SessionState::new("Ada".into());
        assert_eq!(
            sent(&run(&mut state, ":srv 903 * :SASL successful")),
            vec!["CAP END", "NICK Ada", "USER Ada 0 * Ada"]
        );
    }

    #[test]
    fn sasl_failure_ends_the_session() {
        for code in ["904", "905"] {
            let mut state = SessionState::new("Ada".into());
            assert_eq!(
                run(&mut state, &format!(":srv {code} * :bad password")),
                vec![Effect::Stop(SessionEnd::AuthFailed)],
                "{code}"
            );
        }
    }

    #[test]
    fn a_taken_nick_is_retried_with_an_underscore() {
        let mut state = SessionState::new("Ada".into());
        let effects = run(&mut state, ":srv 433 * Ada :Nickname is already in use");
        assert_eq!(state.nick, "Ada_");
        assert!(effects.contains(&Effect::NickChanged("Ada_".into())));
        assert_eq!(sent(&effects), vec!["NICK Ada_"]);
    }

    #[test]
    fn welcome_takes_the_servers_nick_and_joins_every_wanted_channel() {
        let mut state = SessionState::new("Ada".into());
        let effects = run(&mut state, ":srv 001 Ada_ :Welcome");
        assert_eq!(state.nick, "Ada_", "the server's idea of our nick wins");
        assert!(state.registered);
        assert!(effects.contains(&Effect::NickChanged("Ada_".into())));
        assert_eq!(
            emitted(&effects),
            vec![&ChatUpdate::Status(ChatStatus::Connected, "Ada_".into())]
        );
        assert_eq!(sent(&effects), vec!["JOIN #aeolus"]);
    }

    // ── rosters ──────────────────────────────────────────────────────────

    #[test]
    fn names_accumulate_then_flush_on_end_of_names() {
        let mut state = registered();
        let during = run(&mut state, ":srv 353 Ada = #aeolus :@Bob +Cid Dee");
        assert!(
            emitted(&during).is_empty(),
            "nothing is published until 366: a half roster would flicker"
        );

        let effects = run(&mut state, ":srv 366 Ada #aeolus :End of /NAMES");
        let ChatUpdate::Users { channel, users } = emitted(&effects)[0] else {
            panic!("expected a roster");
        };
        assert_eq!(channel, "#aeolus");
        assert_eq!(users.len(), 3);
        let bob = users.iter().find(|u| u.name == "Bob").unwrap();
        assert_eq!(bob.elevation, "@", "the prefix becomes elevation");
        assert!(state.pending_names.is_empty(), "flushed");
        assert_eq!(state.rosters["#aeolus"].len(), 3);
    }

    #[test]
    fn joining_ourselves_opens_the_channel_and_backfills_once() {
        let mut state = registered();
        let first = run(&mut state, ":Ada!u@h JOIN #uef");
        assert!(emitted(&first).contains(&&ChatUpdate::ChannelJoined("#uef".into())));
        assert_eq!(
            sent(&first),
            vec!["CHATHISTORY LATEST #uef * 500"],
            "the tab must not open empty"
        );

        // A rejoin must not duplicate the backfill.
        let again = run(&mut state, ":Ada!u@h JOIN #uef");
        assert!(sent(&again).is_empty());
    }

    #[test]
    fn someone_else_joining_lands_in_the_roster_with_a_notice() {
        let mut state = registered();
        run(&mut state, ":Ada!u@h JOIN #uef");
        let effects = run(&mut state, ":Bob!u@h JOIN #uef");

        assert!(state.rosters["#uef"].contains_key("Bob"));
        assert!(emitted(&effects).iter().any(|u| matches!(
            u,
            ChatUpdate::UserJoined { channel, user } if channel == "#uef" && user.name == "Bob"
        )));
        assert!(effects.iter().any(|e| matches!(
            e,
            Effect::Message { content, kind, .. }
                if content == "joined the channel." && *kind == ChatMessageKind::Info
        )));
    }

    #[test]
    fn our_own_part_closes_the_channel_and_forgets_its_backfill() {
        let mut state = registered();
        run(&mut state, ":Ada!u@h JOIN #uef");
        let effects = run(&mut state, ":Ada!u@h PART #uef");

        assert!(emitted(&effects).contains(&&ChatUpdate::ChannelLeft("#uef".into())));
        assert!(!state.rosters.contains_key("#uef"));
        assert!(
            !state.history_asked.contains("#uef"),
            "rejoining must backfill again"
        );
    }

    #[test]
    fn being_kicked_stops_us_rejoining_but_parting_does_not() {
        // The distinction matters: a PART is usually our own doing and the
        // channel stays in the wanted set for the next reconnect, while a
        // KICK must not be undone automatically.
        let mut state = registered();
        run(&mut state, ":Ada!u@h JOIN #uef");
        let parted = run(&mut state, ":Ada!u@h PART #uef");
        assert!(!parted.iter().any(|e| matches!(e, Effect::ForgetChannel(_))));

        run(&mut state, ":Ada!u@h JOIN #uef");
        let kicked = run(&mut state, ":Op!u@h KICK #uef Ada :behave");
        assert!(kicked.contains(&Effect::ForgetChannel("#uef".into())));
    }

    #[test]
    fn a_quit_is_reported_in_every_channel_the_nick_was_in() {
        let mut state = registered();
        for channel in ["#a", "#b"] {
            run(&mut state, &format!(":Ada!u@h JOIN {channel}"));
            run(&mut state, &format!(":Bob!u@h JOIN {channel}"));
        }
        let effects = run(&mut state, ":Bob!u@h QUIT :Connection reset");

        let leaves: Vec<&ChatUpdate> = emitted(&effects)
            .into_iter()
            .filter(|u| matches!(u, ChatUpdate::UserLeft { .. }))
            .collect();
        assert_eq!(leaves.len(), 2, "one per channel");
        assert!(!state.rosters["#a"].contains_key("Bob"));
        assert!(!state.rosters["#b"].contains_key("Bob"));
        assert!(effects.iter().any(|e| matches!(
            e,
            Effect::Message { content, .. } if content == "quit: Connection reset"
        )));
    }

    #[test]
    fn a_default_quit_message_is_silenced() {
        // Servers echo "Quit: <nick>", which tells the reader nothing.
        let mut state = registered();
        run(&mut state, ":Ada!u@h JOIN #a");
        run(&mut state, ":Bob!u@h JOIN #a");
        let effects = run(&mut state, ":Bob!u@h QUIT :Quit: Bob");
        assert!(effects.iter().any(|e| matches!(
            e,
            Effect::Message { content, .. } if content == "quit."
        )));
    }

    #[test]
    fn a_rename_updates_every_roster_and_our_own_nick() {
        let mut state = registered();
        run(&mut state, ":Ada!u@h JOIN #a");
        run(&mut state, ":Bob!u@h JOIN #a");

        let effects = run(&mut state, ":Bob!u@h NICK Bobby");
        assert!(state.rosters["#a"].contains_key("Bobby"));
        assert!(!state.rosters["#a"].contains_key("Bob"));
        assert!(
            !effects.iter().any(|e| matches!(e, Effect::NickChanged(_))),
            "not us"
        );

        let ours = run(&mut state, ":Ada!u@h NICK Zara");
        assert_eq!(state.nick, "Zara");
        assert!(ours.contains(&Effect::NickChanged("Zara".into())));
    }

    // ── modes ────────────────────────────────────────────────────────────

    #[test]
    fn a_mode_change_updates_elevation_in_the_roster() {
        let mut state = registered();
        run(&mut state, ":Ada!u@h JOIN #a");
        run(&mut state, ":Bob!u@h JOIN #a");

        let effects = run(&mut state, ":Op!u@h MODE #a +o Bob");
        assert_eq!(state.rosters["#a"]["Bob"], "@");
        assert!(emitted(&effects).iter().any(|u| matches!(
            u,
            ChatUpdate::UserElevation { user, elevation, .. }
                if user == "Bob" && elevation == "@"
        )));
    }

    #[test]
    fn a_user_mode_on_ourselves_is_ignored() {
        // `MODE Ada +i` has no channel and nothing to show.
        let mut state = registered();
        assert!(run(&mut state, ":Ada MODE Ada :+i").is_empty());
    }

    #[test]
    fn a_ban_consumes_its_argument_without_changing_elevation() {
        // `+b` takes an argument but is not a membership prefix. Skipping the
        // argument would misalign every nick after it.
        let mut state = registered();
        run(&mut state, ":Ada!u@h JOIN #a");
        run(&mut state, ":Bob!u@h JOIN #a");

        let effects = run(&mut state, ":Op!u@h MODE #a +bo baddie!*@* Bob");
        assert_eq!(state.rosters["#a"]["Bob"], "@", "the +o still found Bob");
        assert_eq!(emitted(&effects).len(), 1);
    }

    // ── messages ─────────────────────────────────────────────────────────

    #[test]
    fn a_channel_message_becomes_a_message_in_that_channel() {
        let mut state = registered();
        let effects = run(&mut state, ":Bob!u@h PRIVMSG #a :hello");
        assert_eq!(
            effects,
            vec![Effect::Message {
                channel: "#a".into(),
                sender: "Bob".into(),
                content: "hello".into(),
                kind: ChatMessageKind::Message,
                timestamp: None,
            }]
        );
    }

    #[test]
    fn a_private_message_opens_a_conversation_named_after_the_sender() {
        let mut state = registered();
        let effects = run(&mut state, ":Bob!u@h PRIVMSG Ada :psst");
        let Effect::Message { channel, .. } = &effects[0] else {
            panic!("expected a message");
        };
        assert_eq!(channel, "Bob", "not our own nick");
    }

    #[test]
    fn a_ctcp_action_becomes_an_action_line() {
        let mut state = registered();
        let effects = run(&mut state, ":Bob!u@h PRIVMSG #a :\u{1}ACTION waves\u{1}");
        let Effect::Message { content, kind, .. } = &effects[0] else {
            panic!("expected a message");
        };
        assert_eq!(content, "waves");
        assert_eq!(*kind, ChatMessageKind::Action);
    }

    #[test]
    fn a_non_action_ctcp_request_is_not_chat() {
        // VERSION/PING requests would otherwise render as control characters.
        let mut state = registered();
        assert!(run(&mut state, ":Bob!u@h PRIVMSG #a :\u{1}VERSION\u{1}").is_empty());
    }

    #[test]
    fn a_notice_keeps_its_own_kind() {
        let mut state = registered();
        let effects = run(&mut state, ":Bob!u@h NOTICE #a :heads up");
        let Effect::Message { kind, .. } = &effects[0] else {
            panic!("expected a message");
        };
        assert_eq!(*kind, ChatMessageKind::Notice);
    }

    #[test]
    fn server_notices_and_history_replay_are_not_surfaced() {
        let mut state = registered();
        // No `!user@host` in the prefix: a server notice, i.e. MOTD chatter.
        assert!(run(&mut state, ":irc.faforever.com NOTICE * :*** Looking up").is_empty());
        // HistServ replays the backfill; the lines themselves arrive separately.
        assert!(run(&mut state, ":HistServ!u@h PRIVMSG #a :replaying").is_empty());
    }

    #[test]
    fn a_server_time_tag_is_carried_onto_the_message() {
        // Without this every backfilled line would be stamped "now", which is
        // the whole reason `server-time` is negotiated.
        let mut state = registered();
        let effects = run(
            &mut state,
            "@time=2026-01-01T12:00:00.000Z :Bob!u@h PRIVMSG #a :old news",
        );
        let Effect::Message { timestamp, .. } = &effects[0] else {
            panic!("expected a message");
        };
        assert_eq!(timestamp.as_deref(), Some("2026-01-01T12:00:00.000Z"));
    }

    // ── topics ───────────────────────────────────────────────────────────

    #[test]
    fn the_topic_arrives_on_join_and_when_changed() {
        let mut state = registered();
        let on_join = run(&mut state, ":srv 332 Ada #a :Welcome to #a");
        assert_eq!(
            emitted(&on_join),
            vec![&ChatUpdate::Topic {
                channel: "#a".into(),
                topic: "Welcome to #a".into()
            }]
        );

        // RPL_NOTOPIC clears it rather than leaving the old one.
        let none = run(&mut state, ":srv 331 Ada #a :No topic is set");
        assert_eq!(
            emitted(&none),
            vec![&ChatUpdate::Topic {
                channel: "#a".into(),
                topic: String::new()
            }]
        );

        let changed = run(&mut state, ":Bob!u@h TOPIC #a :new topic");
        assert!(emitted(&changed)
            .iter()
            .any(|u| matches!(u, ChatUpdate::Topic { topic, .. } if topic == "new topic")));
        assert!(changed.iter().any(|e| matches!(
            e,
            Effect::Message { content, .. } if content == "changed the topic to: new topic"
        )));
    }

    // ── robustness ───────────────────────────────────────────────────────

    #[test]
    fn malformed_lines_are_ignored_rather_than_panicking() {
        // Every arm destructures params that a hostile or buggy server may
        // omit. None of these should do anything at all.
        let mut state = registered();
        for raw in [
            "JOIN",
            "PART",
            "KICK #a",
            "MODE",
            "MODE #a",
            "NICK",
            "TOPIC #a",
            ":srv 353 Ada",
            ":srv 366 Ada",
            ":srv 332 Ada",
            "PRIVMSG",
            ":Bob!u@h PRIVMSG #a",
            "QUIT",
        ] {
            let Some(line) = irc::parse_line(raw) else {
                continue;
            };
            let effects = handle_line(&line, &mut state, &ctx());
            assert!(
                !effects.iter().any(|e| matches!(e, Effect::Stop(_))),
                "`{raw}` must not end the session"
            );
        }
    }

    #[test]
    fn an_unknown_numeric_is_silently_ignored() {
        let mut state = registered();
        assert!(run(&mut state, ":srv 375 Ada :- MOTD -").is_empty());
    }

    #[test]
    fn a_quit_reports_its_channels_in_a_stable_order() {
        // Rosters live in a `HashMap`, so without an explicit sort the update
        // order would vary run to run.
        let mut state = registered();
        for channel in ["#c", "#a", "#b"] {
            run(&mut state, &format!(":Ada!u@h JOIN {channel}"));
            run(&mut state, &format!(":Bob!u@h JOIN {channel}"));
        }
        let effects = run(&mut state, ":Bob!u@h QUIT :bye");
        let channels: Vec<String> = emitted(&effects)
            .into_iter()
            .filter_map(|u| match u {
                ChatUpdate::UserLeft { channel, .. } => Some(channel.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(channels, vec!["#a", "#b", "#c"]);
    }

    // ── the helpers that moved here with the state machine ───────────────

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn capability_values_are_stripped_from_names() {
        let offered: Vec<String> =
            capability_names("multi-prefix sasl=PLAIN,EXTERNAL draft/chathistory=1000 server-time")
                .collect();
        assert_eq!(
            offered,
            vec!["multi-prefix", "sasl", "draft/chathistory", "server-time"]
        );
    }

    #[test]
    fn bare_capability_names_are_untouched() {
        let offered: Vec<String> = capability_names("sasl server-time").collect();
        assert_eq!(offered, vec!["sasl", "server-time"]);
    }

    #[test]
    fn an_empty_capability_list_yields_nothing() {
        assert_eq!(capability_names("").count(), 0);
    }

    #[test]
    fn pairs_a_single_op_grant_with_its_nick() {
        assert_eq!(
            membership_mode_changes("+o", &args(&["Stormlord"])),
            vec![("Stormlord".to_string(), "+o".to_string())]
        );
    }

    #[test]
    fn pairs_multiple_modes_with_their_nicks_in_order() {
        assert_eq!(
            membership_mode_changes("+oo", &args(&["a", "b"])),
            vec![
                ("a".to_string(), "+o".to_string()),
                ("b".to_string(), "+o".to_string())
            ]
        );
    }

    #[test]
    fn honours_a_sign_change_mid_string() {
        assert_eq!(
            membership_mode_changes("+o-v", &args(&["a", "b"])),
            vec![
                ("a".to_string(), "+o".to_string()),
                ("b".to_string(), "-v".to_string())
            ]
        );
    }

    #[test]
    fn accumulates_repeated_changes_for_one_nick() {
        assert_eq!(
            membership_mode_changes("+ov", &args(&["a", "a"])),
            vec![("a".to_string(), "+o+v".to_string())]
        );
    }
}
