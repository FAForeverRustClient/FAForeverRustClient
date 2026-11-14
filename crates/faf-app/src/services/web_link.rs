//! The web link: FAF's web client (webclient.faforever.com) steering this
//! client, so a player can start a search from their phone and be told on it
//! when the match is found. See `faf_domain::protocol::web_link` for what
//! crosses it and why it is safe to.
//!
//! Driven by state, like Rich Presence: nothing in the UI asks for a
//! connection. While the player has turned the link on and is signed in, one
//! connection is kept open, and the state the browser shows is sent whenever
//! it changes and a browser is there to see it. "Match found" is sent whether
//! or not one is: that is the message the phone in the kitchen is waiting for,
//! and the server turns it into a push notification.
//!
//! A request from a browser is checked against this client's own state and
//! becomes the command the Play tab would send for the same thing, run the way
//! a Discord join is. Every one that runs leaves a notification here.

use std::sync::Arc;
use std::time::Duration;

use faf_domain::protocol::web_link::{self, Inbound, Outbound, RemoteCommand};
use faf_domain::state::{AppState, JoinState, MatchmakingState, NotificationKind};
use faf_domain::AppEvent;
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::broadcast::Receiver;

use crate::ports::{WebLinkError, WebLinkSession};
use crate::runtime::{EventSink, ServiceCtx};
use crate::services::notifications;

/// Waits between attempts, growing to the last.
const RETRY: [Duration; 5] = [
    Duration::from_secs(2),
    Duration::from_secs(5),
    Duration::from_secs(15),
    Duration::from_secs(30),
    Duration::from_secs(60),
];
/// A refused hello (an expired token being renewed, the server restarting)
/// is worth another try, but not a fast one.
const AFTER_REFUSAL: Duration = Duration::from_secs(60);
/// Another computer on this account took the link. Leave it for a while
/// rather than taking it straight back: the player is probably at that one.
const AFTER_REPLACED: Duration = Duration::from_secs(10 * 60);
/// A connection that lasted this long was working: losing it is not a reason
/// to back off.
const STABLE: Duration = Duration::from_secs(60);
/// How often a changed state is sent, at most.
const PUBLISH_EVERY: Duration = Duration::from_millis(750);

pub fn spawn(ctx: Arc<ServiceCtx>, sink: EventSink) {
    let events = sink.subscribe();
    tokio::spawn(async move { run(ctx, sink, events).await });
}

/// Turned on, and signed in.
fn wanted(state: &AppState) -> bool {
    state.settings.web_link.enabled && state.auth.player.is_some()
}

/// Wait for the next event; false once the event stream has closed.
async fn next_event(events: &mut Receiver<AppEvent>) -> bool {
    !matches!(events.recv().await, Err(RecvError::Closed))
}

/// Sleep for `wait`, unless the link stops being wanted first. False once the
/// event stream has closed.
async fn pause(wait: Duration, events: &mut Receiver<AppEvent>, sink: &EventSink) -> bool {
    let deadline = tokio::time::sleep(wait);
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            _ = &mut deadline => return true,
            alive = next_event(events) => {
                if !alive {
                    return false;
                }
                if !sink.with_state(wanted) {
                    return true;
                }
            }
        }
    }
}

enum Ended {
    /// The connection dropped, or the link was turned off or signed out of.
    Dropped,
    Replaced,
    /// The client is shutting down.
    Closed,
}

async fn run(ctx: Arc<ServiceCtx>, sink: EventSink, mut events: Receiver<AppEvent>) {
    let mut attempt = 0usize;
    // Said once each time the link is turned on, so the player knows it works.
    let mut announced = false;
    loop {
        while !sink.with_state(wanted) {
            announced = false;
            attempt = 0;
            if !next_event(&mut events).await {
                return;
            }
        }

        let wait = match ctx.ports.web_link.connect().await {
            Ok(session) => {
                let opened = tokio::time::Instant::now();
                tracing::info!(browsers = session.browsers, "web link connected");
                if !announced {
                    announced = true;
                    notifications::add_text(
                        &sink,
                        NotificationKind::WebLink,
                        notifications::Text::new("notifications.msg.webLinkConnected"),
                        "Connected to the web client",
                        "You can start a search on this PC from webclient.faforever.com.",
                        None,
                    );
                }
                match serve(&ctx, &sink, &mut events, session).await {
                    Ended::Closed => return,
                    Ended::Replaced => {
                        tracing::info!("web link taken over by another computer on this account");
                        AFTER_REPLACED
                    }
                    // A connection that held for a while comes back at once
                    // (the server restarted); one that keeps dropping straight
                    // after the welcome backs off like a refusal to connect.
                    Ended::Dropped if opened.elapsed() >= STABLE => {
                        attempt = 0;
                        RETRY[0]
                    }
                    Ended::Dropped => {
                        let wait = RETRY[attempt.min(RETRY.len() - 1)];
                        attempt += 1;
                        wait
                    }
                }
            }
            // Signed in a moment ago: the token is a moment behind.
            Err(WebLinkError::NotSignedIn) => RETRY[0],
            Err(WebLinkError::Refused { code, message }) => {
                tracing::warn!(%code, %message, "the web client refused the link");
                AFTER_REFUSAL
            }
            Err(WebLinkError::Unavailable(reason)) => {
                let wait = RETRY[attempt.min(RETRY.len() - 1)];
                attempt += 1;
                tracing::debug!(%reason, ?wait, "web link unavailable");
                wait
            }
        };
        if !pause(wait, &mut events, &sink).await {
            return;
        }
    }
}

/// What the last publish sent, so an unchanged state is not sent again.
#[derive(Default)]
struct Published {
    state: Option<String>,
    games: Option<String>,
}

async fn send(session: &WebLinkSession, message: Outbound) -> bool {
    session.outbound.send(message).await.is_ok()
}

/// Send the state and the lobby list, each only if it changed.
async fn publish(session: &WebLinkSession, sink: &EventSink, last: &mut Published) -> bool {
    let (state, games) = sink.with_state(|state| {
        (
            Outbound::State {
                state: web_link::snapshot(state),
            },
            Outbound::Games {
                games: web_link::games(state),
            },
        )
    });
    for (message, previous) in [(state, &mut last.state), (games, &mut last.games)] {
        let text = web_link::encode(&message);
        if previous.as_deref() == Some(text.as_str()) {
            continue;
        }
        if !send(session, message).await {
            return false;
        }
        *previous = Some(text);
    }
    true
}

/// Which events can change what the browser shows.
fn affects_view(event: &AppEvent) -> bool {
    matches!(
        event,
        AppEvent::Lobby(_) | AppEvent::Social(_) | AppEvent::Auth(_) | AppEvent::Settings(_)
    )
}

async fn serve(
    ctx: &Arc<ServiceCtx>,
    sink: &EventSink,
    events: &mut Receiver<AppEvent>,
    mut session: WebLinkSession,
) -> Ended {
    let mut browsers = session.browsers;
    let mut last = Published::default();
    let mut dirty = true;
    let mut matchmaking: MatchmakingState =
        sink.with_state(|state| state.lobby.matchmaking.clone());
    let mut join: JoinState = sink.with_state(|state| state.lobby.join.clone());
    // A search or join the web client started is under way: if it stops at a
    // decision only the player at the PC can make, or fails, their phone is
    // told. Nothing is said about what the player started at the PC.
    let mut remote = false;
    let mut tick = tokio::time::interval(PUBLISH_EVERY);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            message = session.inbound.recv() => match message {
                None => return Ended::Dropped,
                Some(Inbound::Browsers { count }) => {
                    if browsers == 0 && count > 0 {
                        // The server keeps what it was sent for browsers that
                        // come later, and nothing was sent while none were
                        // here: start again from the whole state.
                        last = Published::default();
                        dirty = true;
                    }
                    browsers = count;
                }
                Some(Inbound::Command { id, command }) => {
                    let result = answer(ctx, sink, &command, &mut last);
                    dirty = true;
                    let (ok, error) = match result {
                        Ok(started) => {
                            remote |= started;
                            (true, None)
                        }
                        Err(error) => (false, Some(error)),
                    };
                    if !send(&session, Outbound::Result { id, ok, error }).await {
                        return Ended::Dropped;
                    }
                }
                Some(Inbound::Replaced) => return Ended::Replaced,
                Some(Inbound::Error { code, message }) => {
                    tracing::warn!(%code, %message, "the web client reported a problem");
                }
                Some(Inbound::Welcome { .. }) | Some(Inbound::Unknown) => {}
            },
            event = events.recv() => {
                match event {
                    Ok(event) => {
                        if !affects_view(&event) {
                            continue;
                        }
                    }
                    Err(RecvError::Lagged(_)) => {}
                    Err(RecvError::Closed) => return Ended::Closed,
                }
                if !sink.with_state(wanted) {
                    return Ended::Dropped;
                }
                dirty = true;
                let (now, now_join) =
                    sink.with_state(|state| (state.lobby.matchmaking.clone(), state.lobby.join.clone()));
                if let Some(queue) = web_link::match_found(&matchmaking, &now) {
                    // At once, and whether or not a browser is open: this is
                    // what reaches the phone.
                    let event = sink.with_state(|state| web_link::match_found_event(queue, state));
                    if !publish(&session, sink, &mut last).await || !send(&session, event).await {
                        return Ended::Dropped;
                    }
                    dirty = false;
                }
                if remote {
                    if let Some(reason) = web_link::attention(&join, &now_join) {
                        if !publish(&session, sink, &mut last).await
                            || !send(&session, web_link::attention_event(reason)).await
                        {
                            return Ended::Dropped;
                        }
                        dirty = false;
                        remote = false;
                    }
                    let search_ended = matchmaking.is_looking()
                        && matches!(now, MatchmakingState::Idle | MatchmakingState::Cancelled { .. });
                    if matches!(now_join, JoinState::InGame) || (search_ended && matches!(now_join, JoinState::Idle)) {
                        // The game is running, or the search ended without one.
                        remote = false;
                    }
                }
                matchmaking = now;
                join = now_join;
            }
            _ = tick.tick() => {
                if dirty && browsers > 0 {
                    if !publish(&session, sink, &mut last).await {
                        return Ended::Dropped;
                    }
                    dirty = false;
                }
            }
        }
    }
}

/// Check a browser's request and start it. The lobby commands run on their own
/// tasks: a search spends a while getting the maps ready, and the link keeps
/// answering meanwhile. `Ok(true)` when a search or a join was started.
fn answer(
    ctx: &Arc<ServiceCtx>,
    sink: &EventSink,
    command: &serde_json::Value,
    last: &mut Published,
) -> Result<bool, String> {
    let Some(command) = RemoteCommand::parse(command) else {
        return Err("Not something the web client may ask for.".into());
    };
    let planned = sink.with_state(|state| web_link::plan(&command, state))?;
    match &command {
        RemoteCommand::Refresh => {
            *last = Published::default();
            return Ok(false);
        }
        RemoteCommand::StartSearch { queues } => {
            // "1 vs 1, 2 vs 2", as the Play tab names the queues.
            let queues = sink.with_state(|state| {
                queues
                    .iter()
                    .map(|name| {
                        state
                            .lobby
                            .matchmaker_queues
                            .iter()
                            .find(|queue| &queue.queue_name == name)
                            .map(|queue| web_link::queue_title(queue.team_size))
                            .unwrap_or_else(|| name.clone())
                    })
                    .collect::<Vec<_>>()
                    .join(", ")
            });
            notifications::add_required_text(
                sink,
                NotificationKind::WebLink,
                notifications::Text::new("notifications.msg.webLinkSearch").with("queues", &queues),
                "Search started from the web client",
                queues,
                None,
            );
        }
        RemoteCommand::StopSearch { .. } if !planned.is_empty() => {
            notifications::add_required_text(
                sink,
                NotificationKind::WebLink,
                notifications::Text::new("notifications.msg.webLinkStop"),
                "Search stopped from the web client",
                "",
                None,
            );
        }
        RemoteCommand::StopSearch { .. } => {}
        RemoteCommand::JoinGame { game_id, .. } => {
            let title = sink.with_state(|state| {
                state
                    .lobby
                    .games
                    .iter()
                    .find(|game| game.id == *game_id)
                    .map(|game| game.title.clone())
                    .unwrap_or_default()
            });
            notifications::add_required_text(
                sink,
                NotificationKind::WebLink,
                notifications::Text::new("notifications.msg.webLinkJoin").with("title", &title),
                "Joining a game from the web client",
                title,
                None,
            );
        }
    }
    // The action only: a join carries the lobby's password.
    let action = match &command {
        RemoteCommand::StartSearch { .. } => "start search",
        RemoteCommand::StopSearch { .. } => "stop search",
        RemoteCommand::JoinGame { .. } => "join game",
        RemoteCommand::Refresh => "refresh",
    };
    tracing::info!(action, "web link request");
    let started = matches!(
        command,
        RemoteCommand::StartSearch { .. } | RemoteCommand::JoinGame { .. }
    );
    for planned in planned {
        let ctx = ctx.clone();
        let sink = sink.clone();
        tokio::spawn(async move { crate::runtime::run_command(planned, &ctx, &sink).await });
    }
    Ok(started)
}
