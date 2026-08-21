//! Reconnect watchdog: bring the two long-lived sockets back on their own.
//!
//! Neither the lobby client nor the chat client survives the host being
//! suspended. Both notice promptly on resume, the lobby socket reading a close
//! and the chat client's keepalive failing, and until now both then simply
//! stayed down. A laptop opened after lunch showed a client that still looked
//! signed in, with an empty game list and a silent `#aeolus`, and the only way
//! back was the status bar's manual reconnect: which, for chat, did not work
//! at all (see the connection slots in [`infra::irc`](crate::infra::irc)).
//!
//! Neither reference client leaves this to the user. The Python client
//! reconnects both on a timer, and the Java client's `FafServerAccessor`
//! retries the lobby connection for as long as the session is signed in. This
//! is the same posture, in one place rather than two: the ports keep their own
//! in-session retry (the chat supervisor's ten attempts around one live
//! connection), and this watchdog covers the case they cannot: a connection
//! that has ended for good while the user is still logged in.
//!
//! It is deliberately driven by *state* rather than by events, like
//! [`discord`](crate::services::discord): "the lobby is disconnected and
//! should not be" is a property of the current snapshot, and rebuilding it
//! from a stream of deltas would only add ways to miss one.
//!
//! A disconnect the user asked for is left alone. `Disconnect` disarms the
//! socket's [`AutoReconnect`](crate::runtime::AutoReconnect) and `Connect`
//! arms it again, so hanging up from the status bar stays hung up until the
//! user says otherwise.

use std::sync::Arc;
use std::time::Duration;

use faf_domain::state::{AuthMode, AuthStatus, ChatCommand, ChatStatus, LobbyCommand, LobbyStatus};

use crate::runtime::{EventSink, ServiceCtx};
use crate::services;

/// How often the watchdog looks at the connection state.
///
/// Also the unit the backoff below is counted in, so it wants to be short
/// enough that the first retry feels immediate and long enough that the loop
/// costs nothing: a tick reads two statuses and two flags.
const TICK: Duration = Duration::from_secs(5);

/// Ceiling on the wait between attempts, in ticks (one minute).
///
/// A client left running through an overnight outage should keep trying: there
/// is no attempt limit here, only a floor on how often. The reconnect is a
/// single WebSocket open, which is cheaper than the polling both reference
/// clients do while merely idle.
const MAX_BACKOFF_TICKS: u32 = 12;

/// Start the watchdog. Called once from the runtime loop; lives for the process.
pub fn spawn(ctx: Arc<ServiceCtx>, sink: EventSink) {
    tokio::spawn(async move { run(ctx, sink).await });
}

/// The part of a socket's status this watchdog reacts to.
///
/// The lobby and chat slices each spell the same three states in a type of
/// their own; collapsing them here is what lets one piece of logic serve both.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Link {
    Down,
    /// Connecting: a handshake in flight. The lobby's includes generating the
    /// anti-smurf machine proof, which takes seconds on its own.
    Pending,
    Up,
}

/// What to do with one socket on one tick.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Step {
    /// Nothing to do: it is up, or the user hung it up.
    Idle,
    /// Waiting: either out the backoff, or on a handshake.
    Wait,
    Connect,
}

/// The backoff state for one socket.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct Retry {
    /// Attempts since the last time this socket was up.
    attempts: u32,
    /// Ticks still to wait before the next attempt.
    countdown: u32,
}

impl Retry {
    /// Advance one tick and say what the caller should do.
    ///
    /// `wanted` is false when the user is not signed in with a FAF account, or
    /// hung this socket up themselves.
    fn tick(&mut self, link: Link, wanted: bool) -> Step {
        if !wanted {
            *self = Self::default();
            return Step::Idle;
        }
        match link {
            // A connection that came up earns a clean schedule, so the next
            // unrelated drop is retried at once rather than a minute later.
            Link::Up => {
                *self = Self::default();
                Step::Idle
            }
            // Give a handshake the time it needs instead of racing it. The
            // countdown deliberately does not run down here: the backoff
            // measures the gap between *failures*, not between ticks.
            Link::Pending => Step::Wait,
            Link::Down if self.countdown > 0 => {
                self.countdown -= 1;
                Step::Wait
            }
            Link::Down => {
                self.attempts = self.attempts.saturating_add(1);
                self.countdown = self.attempts.min(MAX_BACKOFF_TICKS);
                Step::Connect
            }
        }
    }
}

async fn run(ctx: Arc<ServiceCtx>, sink: EventSink) {
    let mut lobby = Retry::default();
    let mut chat = Retry::default();

    loop {
        tokio::time::sleep(TICK).await;

        let Some(watch) = sink.with_state(observe) else {
            // Signed out, or in the credential-free test mode, whose fake
            // ports connect on demand and never drop.
            lobby = Retry::default();
            chat = Retry::default();
            continue;
        };

        if lobby.tick(watch.lobby, ctx.lobby_auto_reconnect.armed()) == Step::Connect {
            tracing::info!(attempt = lobby.attempts, "reconnecting to the lobby");
            let (ctx, sink) = (ctx.clone(), sink.clone());
            tokio::spawn(async move {
                services::lobby::handle(LobbyCommand::Connect, &ctx, &sink).await;
            });
        }

        if chat.tick(watch.chat, ctx.chat_auto_reconnect.armed()) == Step::Connect {
            tracing::info!(attempt = chat.attempts, "reconnecting to chat");
            let (ctx, sink, username) = (ctx.clone(), sink.clone(), watch.username);
            tokio::spawn(async move {
                services::chat::handle(ChatCommand::Connect { username }, &ctx, &sink).await;
            });
        }
    }
}

/// What one tick needs to know, or `None` when nothing should be reconnected.
struct Watch {
    lobby: Link,
    chat: Link,
    /// The nickname chat authenticates with; the port needs it explicitly.
    username: String,
}

fn observe(state: &faf_domain::AppState) -> Option<Watch> {
    if state.auth.status != AuthStatus::LoggedIn || state.auth.mode != AuthMode::Account {
        return None;
    }
    let username = state.auth.player.as_ref()?.name.clone();
    if username.trim().is_empty() {
        return None;
    }
    Some(Watch {
        lobby: match state.lobby.status {
            LobbyStatus::Disconnected => Link::Down,
            LobbyStatus::Connecting => Link::Pending,
            LobbyStatus::Connected => Link::Up,
        },
        chat: match state.chat.status {
            ChatStatus::Disconnected => Link::Down,
            ChatStatus::Connecting => Link::Pending,
            ChatStatus::Connected => Link::Up,
        },
        username,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Run `link` for `ticks` ticks and collect the steps taken.
    fn drive(retry: &mut Retry, link: Link, ticks: usize) -> Vec<Step> {
        (0..ticks).map(|_| retry.tick(link, true)).collect()
    }

    #[test]
    fn a_dropped_socket_is_retried_at_once() {
        let mut retry = Retry::default();
        assert_eq!(retry.tick(Link::Down, true), Step::Connect);
    }

    #[test]
    fn retries_back_off_one_tick_at_a_time() {
        let mut retry = Retry::default();
        // Attempt 1 waits one tick, attempt 2 waits two, and so on.
        assert_eq!(
            drive(&mut retry, Link::Down, 7),
            [
                Step::Connect,
                Step::Wait,
                Step::Connect,
                Step::Wait,
                Step::Wait,
                Step::Connect,
                Step::Wait,
            ]
        );
    }

    #[test]
    fn the_backoff_is_capped() {
        let mut retry = Retry::default();
        for _ in 0..200 {
            retry.tick(Link::Down, true);
        }
        assert!(retry.countdown <= MAX_BACKOFF_TICKS);
    }

    #[test]
    fn a_handshake_in_flight_is_left_alone() {
        let mut retry = Retry::default();
        assert_eq!(retry.tick(Link::Down, true), Step::Connect);
        // However long the handshake takes, nothing starts a second one, and
        // the backoff it earned survives so a failure is not retried instantly.
        assert!(drive(&mut retry, Link::Pending, 10)
            .iter()
            .all(|step| *step == Step::Wait));
        assert_eq!(retry.tick(Link::Down, true), Step::Wait);
        assert_eq!(retry.tick(Link::Down, true), Step::Connect);
    }

    #[test]
    fn a_connection_that_came_up_clears_the_schedule() {
        let mut retry = Retry::default();
        drive(&mut retry, Link::Down, 7);
        assert_eq!(retry.tick(Link::Up, true), Step::Idle);
        // The next drop is unrelated to the ones before it.
        assert_eq!(retry.tick(Link::Down, true), Step::Connect);
    }

    #[test]
    fn a_socket_the_user_hung_up_stays_down() {
        let mut retry = Retry::default();
        for _ in 0..10 {
            assert_eq!(retry.tick(Link::Down, false), Step::Idle);
        }
        // And is retried immediately once they ask for it again.
        assert_eq!(retry.tick(Link::Down, true), Step::Connect);
    }
}
