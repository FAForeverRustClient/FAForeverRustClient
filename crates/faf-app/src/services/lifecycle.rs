//! Backend ownership of account connections and automatic party-room changes.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use faf_domain::protocol::lobby::party_chat_channel;
use faf_domain::state::{AuthEvent, AuthMode, AuthStatus, ChatEvent, ChatStatus};
use faf_domain::{AppEvent, AppState};
use tokio::sync::broadcast::error::RecvError;
use tokio_util::sync::CancellationToken;

use crate::runtime::{AutoReconnect, EventSink, ServiceCtx};
use crate::services;

/// Updated synchronously with auth reduction, before a published sign-in can
/// race an explicit Disconnect. Reconnect attempts only read these intents.
#[derive(Default)]
pub(crate) struct LifecycleContext {
    lobby: AutoReconnect,
    chat: AutoReconnect,
    chat_epoch: AtomicU64,
}

impl LifecycleContext {
    pub(crate) fn observe(&self, event: &AppEvent) {
        if let AppEvent::Auth(event) = event {
            if event.resets_account_activity() {
                match event {
                    AuthEvent::LoggedIn { .. } | AuthEvent::TestLoggedIn { .. } => {
                        self.request_lobby();
                        self.request_chat();
                    }
                    _ => {
                        self.stop_lobby();
                        self.stop_chat();
                    }
                }
            }
        }
        if matches!(event, AppEvent::Chat(ChatEvent::Connected { .. })) {
            self.chat_epoch.fetch_add(1, Ordering::Release);
        }
    }

    pub(crate) fn request_lobby(&self) {
        self.lobby.arm();
    }
    pub(crate) fn stop_lobby(&self) {
        self.lobby.disarm();
    }
    pub(crate) fn lobby_wanted(&self) -> bool {
        self.lobby.armed()
    }
    pub(crate) fn request_chat(&self) {
        self.chat.arm();
    }
    pub(crate) fn stop_chat(&self) {
        self.chat.disarm();
    }
    pub(crate) fn chat_wanted(&self) -> bool {
        self.chat.armed()
    }
    pub(crate) fn chat_epoch(&self) -> u64 {
        self.chat_epoch.load(Ordering::Acquire)
    }
}

struct AccountView {
    username: String,
    chat_connected: bool,
    party_channel: Option<String>,
    chat_epoch: u64,
}

fn account_view(state: &AppState, context: &LifecycleContext) -> Option<AccountView> {
    if state.auth.status != AuthStatus::LoggedIn || state.auth.mode == AuthMode::Offline {
        return None;
    }
    let player = state.auth.player.as_ref()?;
    if player.name.trim().is_empty() {
        return None;
    }
    Some(AccountView {
        username: player.name.clone(),
        chat_connected: state.chat.status == ChatStatus::Connected,
        party_channel: party_chat_channel(&state.lobby.party, &state.social, Some(player)),
        chat_epoch: context.chat_epoch(),
    })
}

/// Subscribe before spawning, then inspect current state on each relevant
/// wakeup. Missed events cannot lose a party change or a connection epoch.
pub(crate) fn spawn(ctx: Arc<ServiceCtx>, sink: EventSink) {
    let mut events = sink.subscribe();
    tokio::spawn(async move {
        let mut account: Option<CancellationToken> = None;
        let mut joined: Option<String> = None;
        let mut epoch = 0;
        loop {
            let scoped = sink.scoped_to_account();
            let session = scoped.account_token();
            if let Some(view) = scoped.with_state(|state| account_view(state, &ctx.lifecycle)) {
                if !session.is_cancelled() {
                    if account.as_ref().is_none_or(CancellationToken::is_cancelled) {
                        account = Some(session.clone());
                        joined = None;
                        let (lobby_ctx, lobby_out) = (ctx.clone(), scoped.clone());
                        tokio::spawn(async move {
                            services::lobby::reconnect(&lobby_ctx, &lobby_out).await;
                        });
                        let (chat_ctx, chat_out) = (ctx.clone(), scoped.clone());
                        let username = view.username;
                        tokio::spawn(async move {
                            services::chat::start_account(username, &chat_ctx, &chat_out).await;
                        });
                    }
                    let reconnected = epoch != view.chat_epoch;
                    epoch = view.chat_epoch;
                    // Keep the previous room through a transient disconnect:
                    // the IRC adapter remembers desired rooms across retries.
                    // Part an obsolete room even while offline, then join the
                    // replacement only once registration has completed.
                    let obsolete = joined.is_some() && joined != view.party_channel;
                    let current = view.party_channel.filter(|_| view.chat_connected);
                    if (view.chat_connected && (reconnected || joined != current)
                        || !view.chat_connected && obsolete)
                        && services::chat::sync_party_channel(
                            &ctx,
                            &session,
                            epoch,
                            joined.as_deref().filter(|_| obsolete),
                            current.as_deref(),
                        )
                    {
                        joined = current;
                    }
                }
            } else {
                account = None;
                joined = None;
            }
            loop {
                match events.recv().await {
                    Ok(AppEvent::Auth(_) | AppEvent::Lobby(_) | AppEvent::Social(_))
                    | Ok(AppEvent::Chat(
                        ChatEvent::Connected { .. }
                        | ChatEvent::Connecting
                        | ChatEvent::Disconnected,
                    ))
                    | Err(RecvError::Lagged(_)) => break,
                    Ok(_) => {}
                    Err(RecvError::Closed) => return,
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use faf_domain::state::Player;

    #[test]
    fn lifecycle_login_intent_preserves_disconnect_until_the_next_account() {
        let context = LifecycleContext::default();
        context.observe(
            &AuthEvent::LoggedIn {
                player: Player::new(1, "First"),
            }
            .into(),
        );
        assert!(context.lobby_wanted() && context.chat_wanted());
        context.stop_lobby();
        context.stop_chat();
        context.observe(
            &AuthEvent::SignInLinkReady {
                url: "ignored".into(),
            }
            .into(),
        );
        assert!(!context.lobby_wanted() && !context.chat_wanted());
        context.observe(&AuthEvent::LoggedOut.into());
        context.observe(
            &AuthEvent::TestLoggedIn {
                player: Player::new(2, "Second"),
            }
            .into(),
        );
        assert!(context.lobby_wanted() && context.chat_wanted());
        context.observe(&AuthEvent::WentOffline.into());
        assert!(!context.lobby_wanted() && !context.chat_wanted());
    }
}
