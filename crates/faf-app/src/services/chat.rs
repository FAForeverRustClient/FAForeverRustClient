//! Chat service.
//!
//! Bridges the streaming [`ChatPort`](crate::ports::ChatPort) to events —
//! same shape as [`services::lobby`](crate::services::lobby): connect, then map
//! each [`ChatUpdate`] onto an event until the stream ends. `SendMessage` is a
//! pure pass-through: the port itself produces the local echo (this client
//! doesn't negotiate IRC's `echo-message` capability), so unlike the Java
//! client's `label`/`PENDING`-message reconciliation, there is nothing to
//! optimistically emit here.

use std::sync::atomic::Ordering;

use faf_domain::state::{ChatCommand, ChatEvent};

use crate::ports::ChatUpdate;
use crate::runtime::{EventSink, ServiceCtx};

pub async fn handle(cmd: ChatCommand, ctx: &ServiceCtx, out: &EventSink) {
    match cmd {
        ChatCommand::Connect { username } => {
            // Single-flight: only one connection may be active at a time,
            // same guard shape as the lobby service.
            if ctx
                .chat_active
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_err()
            {
                return; // a connection is already active/connecting
            }

            out.emit(ChatEvent::Connecting);
            let mut updates = ctx.ports.chat.connect(username).await;
            out.emit(ChatEvent::Connected);

            while let Some(update) = updates.recv().await {
                match update {
                    ChatUpdate::MessageReceived(message) => {
                        out.emit(ChatEvent::MessageReceived { message })
                    }
                    ChatUpdate::UsersUpdated(users) => out.emit(ChatEvent::UsersUpdated { users }),
                }
            }

            ctx.chat_active.store(false, Ordering::SeqCst);
            out.emit(ChatEvent::Disconnected);
        }
        ChatCommand::SendMessage { content } => ctx.ports.chat.send_message(content),
        ChatCommand::Disconnect => ctx.ports.chat.disconnect(),
    }
}
