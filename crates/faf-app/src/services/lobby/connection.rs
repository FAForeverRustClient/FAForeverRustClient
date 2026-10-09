//! The lobby connection: connecting, the update loop that runs for as long as
//! the socket does, bringing it back for the reconnect watchdog, and restoring
//! the game session a dropped socket took with it.

use faf_domain::state::{LobbyEvent, SocialEvent};

use crate::ports::LobbyUpdate;
use crate::runtime::{EventSink, ServiceCtx};
use crate::services::launcher::LaunchSession;

use super::game_notifications::GameNotificationTracker;
use super::launch::{Background, LaunchSlot};
use super::updates::handle_update;

/// Bring the lobby back for the reconnect watchdog.
///
/// Not `handle(LobbyCommand::Connect)`, because that arms the watchdog: a
/// retry the watchdog spawned just before the user pressed Disconnect would
/// then re-arm it, and the client would reconnect against the user's wishes.
/// The flag is read once the connection guard is held, which is the last
/// moment a Disconnect could have landed in between.
pub async fn reconnect(ctx: &ServiceCtx, out: &EventSink) {
    connect_with(ctx, out, true).await;
}

pub(super) async fn connect(ctx: &ServiceCtx, out: &EventSink) {
    connect_with(ctx, out, false).await;
}

async fn connect_with(ctx: &ServiceCtx, out: &EventSink, only_if_armed: bool) {
    if !ctx.lobby.active.try_start() {
        return;
    }
    if only_if_armed && !ctx.lobby.auto_reconnect.armed() {
        ctx.lobby.active.finish();
        return;
    }

    out.emit(LobbyEvent::Connecting);
    // Deliberately no `Connected` here. `connect` returns as soon as the session
    // task is spawned, long before the socket is open, let alone authenticated.
    // Emitting it here made `LobbyStatus::Connected` true for seconds while the
    // lobby would still reject everything, and that flag gates the join guard and
    // the whole UI. It is emitted on `LobbyUpdate::Authenticated` instead.
    let mut updates = ctx.ports.lobby.connect().await;

    let launch_enabled = ctx.ports.process.supports_live_launch();
    let mut launch = LaunchSlot::default();
    let mut background = Background::default();
    let mut game_notifications = GameNotificationTracker::default();

    loop {
        // The launch and the search's warm-up run here, beside the updates,
        // rather than being awaited in the middle of one. Awaiting the launch
        // stopped this loop for as long as the launch took, which for a
        // generated map or a patch is tens of seconds to minutes; the socket
        // behind it stopped being read, and a `match_cancelled` sent in that
        // time was only seen once the game had already been started. Java runs
        // both as futures beside the connection (`GameRunner`).
        let next = tokio::select! {
            update = updates.recv() => Next::Update(update),
            started = async { background.launch.as_mut().expect("guarded").await },
                if background.launch.is_some() => Next::Started(started),
            () = async { background.warm_up.as_mut().expect("guarded").await },
                if background.warm_up.is_some() => Next::WarmedUp,
        };
        match next {
            Next::Update(None) => break,
            Next::Update(Some(update)) => {
                handle_update(
                    update,
                    ctx,
                    out,
                    launch_enabled,
                    &mut launch,
                    &mut background,
                    &mut game_notifications,
                )
                .await
            }
            Next::Started(session) => {
                background.launch = None;
                launch.started(session, ctx, out).await;
            }
            Next::WarmedUp => {
                background.warm_up = None;
                background.warm_up_called_off = None;
            }
        }
    }
    // A party member's update is for a search the connection took with it.
    // Called off and dropped before the launch below is awaited: unpolled, it
    // would keep the launcher's preparation lock that launch may be waiting
    // for.
    background.warm_up_called_off = None;
    background.warm_up = None;
    // A launch still under way when the connection ended is finished rather
    // than dropped halfway, which could leave an adapter running for a game
    // that never started. It is the order the old loop had too: the launch
    // completed, then the closed stream was read.
    if let Some(starting) = background.launch.take() {
        let session = starting.await;
        launch.started(session, ctx, out).await;
    }

    ctx.lobby.active.finish();
    // The connection a join was being prepared for is gone, so the join is
    // too: the same reasoning as an explicit Disconnect.
    ctx.lobby.operations.cancel();
    ctx.lobby.operations.release_any_join();
    out.emit(LobbyEvent::Disconnected);
    // So is a search being prepared, whose updater stops at its next safe
    // point. After `Disconnected`, which leaves the search idle, so the
    // preparation that stops here finds it no longer wanted and goes quietly.
    ctx.lobby.search_preparation.cancel(|_| true);
    out.emit(SocialEvent::Cleared);
}

/// What the connect loop is waiting for next.
enum Next {
    Update(Option<LobbyUpdate>),
    Started(Option<LaunchSession>),
    WarmedUp,
}

/// Put the server's game connection back after the socket that held it went.
///
/// The lobby server hangs a player's game connection off the socket the game
/// was launched on. Lose that socket -- a drop, or the user pressing
/// Disconnect and then Reconnect -- and the connection goes with it: the ICE
/// adapter carries on offering candidates to a server that is no longer
/// relaying them, and the players in the running game never reconnect to each
/// other. That is the report this exists for.
///
/// Sent on every transition into "authenticated" while a game is running, and
/// only then, which is what the reference client does in `GameRunner`. The
/// server answers a game that has since ended with a warning rather than an
/// error, so a race with the game's last seconds costs nothing.
pub(super) fn restore_game_session(ctx: &ServiceCtx) {
    let Some(game_id) = ctx.lobby.running_game.id() else {
        return;
    };
    tracing::info!(
        game_id,
        "lobby reconnected during a game; restoring the session"
    );
    ctx.ports.lobby.restore_game_session(game_id);
}
