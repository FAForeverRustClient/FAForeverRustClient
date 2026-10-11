//! Chat service.
//!
//! Bridges the streaming [`ChatPort`](crate::ports::ChatPort) to events: same
//! shape as [`services::lobby`](crate::services::lobby): connect, then map each
//! [`ChatUpdate`] onto an event until the stream ends.
//!
//! It also owns composer-input interpretation: `SendMessage` carries whatever
//! the user typed, and this is where a leading `/me`, `/join`, `/msg`,
//! `/topic` or `/part` becomes the corresponding port call. The Python client
//! puts the same logic in its chat controller; keeping it behind the IPC
//! boundary means the grammar has one implementation and one test suite
//! ([`faf_domain::protocol::chat_input`]) instead of one per frontend.
//!
//! Messages the user sends need no optimistic event here: the port produces the
//! local echo (this client doesn't negotiate IRC's `echo-message` capability),
//! so unlike the Java client's `label`/`PENDING`-message reconciliation there
//! is nothing to reconcile.

use faf_domain::protocol::chat_input::{self, ChatInput};
use faf_domain::state::{
    auto_join_channels, mentions, read_marker_key, ChatCommand, ChatEvent, ChatMessage,
    ChatMessageKind, ChatStatus, NotificationAction, NotificationKind, SettingsEvent,
};

use crate::ports::ChatUpdate;
use crate::runtime::{AutoReconnect, EventSink, LatestRequest, ServiceCtx, SingleFlight};
use crate::services::notifications;

/// The chat connection's operational context: its single-flight guard,
/// whether it should come back after a drop, and the throttles on what the
/// composer and the read markers send.
///
/// Owned by this service. The reconnect service asks whether the connection
/// should come back through [`Self::auto_reconnect_armed`].
#[derive(Default)]
pub struct ChatContext {
    /// Single-flight guard for the chat connection while `Connect` owns an
    /// active/connecting socket, the same guard the lobby connection keeps. A
    /// redundant request is dropped, so overlapping connections cannot race
    /// and clobber each other's state.
    active: SingleFlight,
    /// Whether [`reconnect`](crate::services::reconnect) should bring this
    /// socket back after an unexpected drop, so a user who hung up stays hung
    /// up while a laptop resume does not.
    auto_reconnect: AutoReconnect,
    /// When a composing notice was last sent per channel, so the composer can
    /// report on every keystroke while the wire sees one line every few
    /// seconds.
    typing_sent: std::sync::Mutex<std::collections::HashMap<String, u32>>,
    /// Read markers can change on every channel click. Only the last click in
    /// a short burst writes settings, while state updates remain immediate.
    read_marker_persist_generation: LatestRequest,
}

impl ChatContext {
    /// Whether an explicit `Connect` armed the chat connection to come back
    /// after an unexpected drop. Read by
    /// [`reconnect`](crate::services::reconnect).
    pub fn auto_reconnect_armed(&self) -> bool {
        self.auto_reconnect.armed()
    }
}

pub async fn handle(cmd: ChatCommand, ctx: &ServiceCtx, out: &EventSink) {
    match cmd {
        ChatCommand::Connect { username } => {
            // Armed before the guard, so asking for a connection while one
            // is already in flight still re-arms the watchdog.
            ctx.chat.auto_reconnect.arm();
            connect(username, ctx, out, false).await;
        }
        ChatCommand::SendMessage {
            channel,
            content,
            reply_to,
        } => send(ctx, out, channel, content, reply_to),
        ChatCommand::JoinChannel { channel } => ctx.ports.chat.join_channel(channel),
        ChatCommand::LeaveChannel { channel } => {
            ctx.ports.chat.leave_channel(channel, String::new())
        }
        ChatCommand::SelectChannel { channel } => {
            let marker = out.with_state(|state| {
                let username = state.chat.username.clone();
                if username.trim().is_empty() {
                    return None;
                }
                state
                    .chat
                    .channel(&channel)
                    .and_then(|chat_channel| {
                        chat_channel.messages.last().map(|message| {
                            let key = read_marker_key(&username, &channel);
                            (key, message.timestamp.clone())
                        })
                    })
                    .filter(|(key, timestamp)| {
                        state.settings.chat.read_markers.get(key) != Some(timestamp)
                    })
            });
            out.emit(ChatEvent::ChannelSelected {
                channel: channel.clone(),
            });
            if let Some((key, timestamp)) = marker {
                let mut preferences = out.with_state(|state| state.settings.chat.clone());
                preferences.read_markers.insert(key, timestamp);
                out.emit(SettingsEvent::ChatChanged {
                    preferences: Box::new(preferences),
                });
                persist_read_markers_after_quiet_period(ctx, out);
            }
        }
        ChatCommand::SetShowJoinsParts { enabled } => {
            out.emit(ChatEvent::JoinsPartsToggled { enabled })
        }
        ChatCommand::SetTyping { channel, composing } => set_typing(ctx, channel, composing),
        ChatCommand::React {
            channel,
            msgid,
            emoji,
        } => {
            // A message the server never tagged has nothing to anchor to. The
            // UI hides the affordance in that case; this is the backstop.
            if msgid.is_empty() {
                return;
            }
            ctx.ports.chat.react(channel, msgid, emoji);
        }
        ChatCommand::Unreact {
            channel,
            msgid,
            emoji,
        } => {
            if msgid.is_empty() {
                return;
            }
            ctx.ports.chat.unreact(channel, msgid, emoji);
        }
        ChatCommand::Disconnect => {
            // Hanging up is a decision, not a fault: the watchdog must not
            // undo it on its next tick.
            ctx.chat.auto_reconnect.disarm();
            ctx.chat.read_marker_persist_generation.invalidate();
            ctx.ports.chat.disconnect();
            crate::services::settings::persist(ctx, out).await;
        }
    }
}

/// The watchdog's retry. Unlike `ChatCommand::Connect` it does not arm
/// auto-reconnect: a retry spawned just before the user pressed Disconnect
/// would otherwise re-arm it, and chat would come back against their wishes.
/// The same shape as `lobby::reconnect`.
pub async fn reconnect(username: String, ctx: &ServiceCtx, out: &EventSink) {
    connect(username, ctx, out, true).await;
}

async fn connect(username: String, ctx: &ServiceCtx, out: &EventSink, only_if_armed: bool) {
    // Single-flight: only one connection may be active at a time,
    // same guard shape as the lobby service.
    if !ctx.chat.active.try_start() {
        return; // a connection is already active/connecting
    }
    // Read once the guard is held, the last moment a Disconnect could have
    // landed between the watchdog's tick and this retry.
    if only_if_armed && !ctx.chat.auto_reconnect.armed() {
        ctx.chat.active.finish();
        return;
    }

    out.emit(ChatEvent::Connecting);
    let mut updates = ctx.ports.chat.connect(username).await;

    while let Some(update) = updates.recv().await {
        let connected = matches!(&update, ChatUpdate::Status(ChatStatus::Connected, _));
        let mut quiet_history = false;
        if let ChatUpdate::Message { channel, message } = &update {
            let (
                is_quiet_history,
                muted,
                username,
                hide_foe_messages,
                is_foe,
                private_messages,
                mentions_enabled,
            ) = out.with_state(|state| {
                let key = read_marker_key(&state.chat.username, channel);
                let quiet_history = state
                    .settings
                    .chat
                    .read_markers
                    .get(&key)
                    .is_some_and(|marker| timestamp_at_or_before(&message.timestamp, marker));
                (
                    quiet_history,
                    state
                        .settings
                        .chat
                        .muted_players
                        .iter()
                        .any(|login| login.eq_ignore_ascii_case(&message.sender)),
                    state.chat.username.clone(),
                    state.settings.chat.hide_foe_messages,
                    state.social.is_foe(&message.sender),
                    state.settings.notifications.private_messages,
                    state.settings.notifications.mentions,
                )
            });
            quiet_history = is_quiet_history;
            if muted {
                continue;
            }
            let incoming = !message.sender.is_empty()
                && !message.sender.eq_ignore_ascii_case(&username)
                && matches!(
                    message.kind,
                    ChatMessageKind::Message | ChatMessageKind::Action
                );
            if incoming && !quiet_history {
                let private = !channel.starts_with('#');
                let mentioned = !private && mentions(&message.content, &username);
                let hidden_foe = hide_foe_messages && is_foe;
                let notify = !hidden_foe
                    && ((private && private_messages) || (mentioned && mentions_enabled));
                if notify {
                    // The body is what they wrote, so only the title has an entry.
                    notifications::add_text(
                        out,
                        if private {
                            NotificationKind::PrivateMessage
                        } else {
                            NotificationKind::Mention
                        },
                        notifications::Text::new(if private {
                            "notifications.msg.privateMessage"
                        } else {
                            "notifications.msg.mention"
                        })
                        .with("sender", &message.sender),
                        if private {
                            format!("Message from {}", message.sender)
                        } else {
                            format!("{} mentioned you", message.sender)
                        },
                        summarize(&message.content),
                        Some(NotificationAction::OpenChat {
                            channel: channel.clone(),
                        }),
                    );
                }
            }
        }
        out.emit(to_event(update, quiet_history));
        if connected {
            let channels =
                out.with_state(|state| auto_join_channels(state, &ctx.ports.os_language));
            for channel in channels {
                ctx.ports.chat.join_channel(channel);
            }
        }
    }

    ctx.chat.active.finish();
    out.emit(ChatEvent::Disconnected);
}

/// How often a still-composing notice is refreshed.
///
/// The IRCv3 draft names three seconds, and the receiving side's timeout is
/// built around that number (see `TYPING_TIMEOUT_SECONDS`). Sending on every
/// keystroke instead would put a line on the wire per character typed, which
/// is a lot of traffic to say one thing.
const TYPING_REFRESH_SECONDS: u32 = 3;

/// Announce composing state, throttled.
///
/// Only the repeats are throttled. A `done` always goes out immediately: it is
/// the message that *removes* an indicator, and delaying it is exactly the
/// failure everyone has seen in other clients.
fn set_typing(ctx: &ServiceCtx, channel: String, composing: bool) {
    let now = super::now_seconds();
    {
        let mut sent = ctx.chat.typing_sent.lock().expect("typing lock poisoned");
        if composing {
            let last = sent.get(&channel).copied().unwrap_or(0);
            if now.saturating_sub(last) < TYPING_REFRESH_SECONDS {
                return;
            }
            sent.insert(channel.clone(), now);
        } else {
            // Forgetting the timestamp means the next `active` is sent at once
            // rather than waiting out a window that started before the pause.
            sent.remove(&channel);
        }
    }
    ctx.ports.chat.set_typing(channel, composing);
}

const READ_MARKER_PERSIST_DELAY: std::time::Duration = std::time::Duration::from_millis(400);

fn persist_read_markers_after_quiet_period(ctx: &ServiceCtx, out: &EventSink) {
    // The one settings write that does not go through `settings::persist`,
    // so it has to honour the same rule by hand: nothing is written before
    // the settings file has been read, or the write is defaults for
    // everything else in it.
    if !ctx.settings.has_loaded() {
        return;
    }
    let generation = ctx.chat.read_marker_persist_generation.begin();
    let latest = ctx.chat.read_marker_persist_generation.clone();
    let serial = ctx.settings.write_order();
    let settings = ctx.ports.settings.clone();
    let out = out.clone();
    tokio::spawn(async move {
        tokio::time::sleep(READ_MARKER_PERSIST_DELAY).await;
        if !latest.is_current(generation) {
            return;
        }
        let _guard = serial.acquire().await;
        let preferences = out.with_state(|state| state.settings.clone());
        if let Err(reason) = settings.save(&preferences).await {
            // The markers are in state; the next settings write carries them.
            tracing::warn!(%reason, "chat read markers were not saved");
        }
    });
}

fn summarize(content: &str) -> String {
    let mut summary = content.chars().take(180).collect::<String>();
    if content.chars().count() > 180 {
        summary.push('…');
    }
    summary
}

/// Interpret one line of composer input and act on it.
fn send(ctx: &ServiceCtx, out: &EventSink, channel: String, content: String, reply_to: String) {
    let chat = &ctx.ports.chat;
    match chat_input::parse(&content) {
        ChatInput::Message(text) if text.is_empty() => {}
        ChatInput::Message(text) => chat.send_message(channel, text, reply_to),
        ChatInput::Action(text) => chat.send_action(channel, text),
        ChatInput::PrivateMessage { target, content } => {
            // Opening the conversation first means the echoed message lands in
            // a channel the UI already knows about, rather than creating one.
            chat.join_channel(target.clone());
            // A `/msg` opens a fresh conversation, so there is nothing in it
            // that an anchor could point at.
            chat.send_message(target, content, String::new());
        }
        ChatInput::Join(target) => chat.join_channel(target),
        ChatInput::Leave { reason } => chat.leave_channel(channel, reason),
        ChatInput::Topic(topic) => chat.set_topic(channel, topic),
        ChatInput::Unknown(command) => {
            // Local-only feedback, right where the user was typing: the Python
            // client announces send failures in the same spot.
            let timestamp = chrono::Utc::now().to_rfc3339();
            out.emit(ChatEvent::MessageReceived {
                channel,
                message: ChatMessage {
                    id: format!("local-{command}-{timestamp}"),
                    sender: String::new(),
                    content: format!(
                        "Unknown command {command}. Try /me, /msg, /join, /topic or /part."
                    ),
                    timestamp,
                    kind: ChatMessageKind::Error,
                    msgid: String::new(),
                    reply_to: String::new(),
                },
            });
        }
    }
}

fn to_event(update: ChatUpdate, quiet_history: bool) -> ChatEvent {
    match update {
        ChatUpdate::Status(ChatStatus::Connected, username) => ChatEvent::Connected { username },
        ChatUpdate::Status(ChatStatus::Connecting, _) => ChatEvent::Connecting,
        ChatUpdate::Status(ChatStatus::Disconnected, _) => ChatEvent::Disconnected,
        ChatUpdate::ChannelJoined(channel) => ChatEvent::ChannelJoined { channel },
        ChatUpdate::ChannelLeft(channel) => ChatEvent::ChannelLeft { channel },
        ChatUpdate::Topic { channel, topic } => ChatEvent::TopicChanged { channel, topic },
        ChatUpdate::Message { channel, message } if quiet_history => {
            ChatEvent::MessageReceivedQuietly { channel, message }
        }
        ChatUpdate::Message { channel, message } => ChatEvent::MessageReceived { channel, message },
        ChatUpdate::Users { channel, users } => ChatEvent::UsersUpdated { channel, users },
        ChatUpdate::UserJoined { channel, user } => ChatEvent::UserJoined { channel, user },
        ChatUpdate::UserLeft { channel, user } => ChatEvent::UserLeft { channel, user },
        ChatUpdate::UserElevation {
            channel,
            user,
            elevation,
        } => ChatEvent::UserElevationChanged {
            channel,
            user,
            elevation,
        },
        ChatUpdate::UserRenamed { old_name, new_name } => {
            ChatEvent::UserRenamed { old_name, new_name }
        }
        ChatUpdate::Typing {
            channel,
            nickname,
            composing,
        } => ChatEvent::TypingChanged {
            channel,
            nickname,
            composing,
            // Stamped on arrival rather than taken from `server-time`: the
            // reader compares it against its own clock to expire the notice,
            // and the server's clock is not the one that matters for that.
            at_seconds: super::now_seconds(),
        },
        ChatUpdate::Reaction {
            channel,
            msgid,
            emoji,
            sender,
        } => ChatEvent::ReactionReceived {
            channel,
            msgid,
            emoji,
            sender,
        },
        ChatUpdate::ReactionRemoved {
            channel,
            msgid,
            emoji,
            sender,
        } => ChatEvent::ReactionRemoved {
            channel,
            msgid,
            emoji,
            sender,
        },
    }
}

/// Compare RFC3339 message times while tolerating synthetic or legacy values.
/// Exact matches remain quiet even when a malformed timestamp is encountered.
fn timestamp_at_or_before(timestamp: &str, marker: &str) -> bool {
    match (
        chrono::DateTime::parse_from_rfc3339(timestamp),
        chrono::DateTime::parse_from_rfc3339(marker),
    ) {
        (Ok(timestamp), Ok(marker)) => timestamp <= marker,
        _ => timestamp == marker,
    }
}
