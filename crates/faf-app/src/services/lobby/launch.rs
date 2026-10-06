//! Acting on a launch order: starting the game beside the update loop, holding
//! the relay traffic that arrives before the adapter exists, and stopping a
//! game that was called off or terminated.

use faf_domain::state::{GameLaunch, LobbyEvent, NotificationAction, NotificationKind};
use futures_util::future::BoxFuture;

use crate::runtime::{EventSink, ServiceCtx};
use crate::services::launcher::{self, LaunchSession};
use crate::services::notifications;

/// Work the connect loop runs beside the lobby updates. Borrowing, because it
/// lives exactly as long as the loop that owns the context it borrows.
#[derive(Default)]
pub(super) struct Background<'a> {
    /// `launcher::start` for the launch order being acted on.
    pub(super) launch: Option<BoxFuture<'a, Option<LaunchSession>>>,
    /// A party member's featured-mod update when its leader starts a search.
    /// See `LobbyUpdate::Matchmaking`.
    pub(super) warm_up: Option<BoxFuture<'a, ()>>,
}

/// The game being launched or played, as far as the lobby loop is concerned.
#[derive(Default)]
pub(super) struct LaunchSlot {
    /// The running game's adapter link, once the launch has produced one.
    pub(super) session: Option<LaunchSession>,
    /// Relay messages that arrived while the launch was still under way. The
    /// old loop never lost these because it did not read the socket at all
    /// until the launch was done; reading it now means keeping them until the
    /// adapter exists, in order.
    held: Vec<(String, Vec<serde_json::Value>)>,
    /// The launch under way was called off: by the server's `match_cancelled`
    /// or a kill notice. A launch that gets as far as a game anyway is then
    /// stopped as soon as it reports back.
    pub(super) called_off: bool,
    /// The launch order's game title, for the "Game launched" notice.
    name: String,
}

/// How many relay messages are kept for an adapter that does not exist yet.
/// A launch exchanges a few dozen; the cap is only against a runaway.
const MAX_HELD_RELAYS: usize = 512;

impl LaunchSlot {
    pub(super) async fn started(
        &mut self,
        session: Option<LaunchSession>,
        ctx: &ServiceCtx,
        out: &EventSink,
    ) {
        // No join slot to free: the launch order's handler freed the one
        // waiting for this game when it started the launch. Freeing "any"
        // here would also drop the records of called-off join requests whose
        // answers are still coming, and could free a join begun meanwhile.
        let held = std::mem::take(&mut self.held);
        let called_off = std::mem::replace(&mut self.called_off, false);
        let Some(session) = session else {
            return;
        };
        if called_off {
            tracing::info!("lobby: the launch finished after it was called off; stopping the game");
            terminate_game(ctx, out);
            notifications::add_required(
                out,
                NotificationKind::Error,
                "Match cancelled",
                "The server cancelled the match after launch, so Forged Alliance was stopped.",
                Some(NotificationAction::OpenMatchmaking),
            );
            return;
        }
        for (command, args) in held {
            session.forward_to_adapter(command, args).await;
        }
        self.session = Some(session);
        if out.with_state(|state| state.settings.notifications.game_launched) {
            notifications::add(
                out,
                NotificationKind::GameLaunched,
                "Game launched",
                format!("{} started successfully.", self.name),
                None,
            );
        }
    }
}

/// The server's launch order: `LobbyUpdate::Launch`.
pub(super) fn on_launch_order<'a>(
    launch_order: GameLaunch,
    ctx: &'a ServiceCtx,
    out: &'a EventSink,
    launch_enabled: bool,
    launch: &mut LaunchSlot,
    background: &mut Background<'a>,
) {
    // The server's acceptance of a join the user called off after its
    // request went out. Starting it used to supersede whatever the
    // user had picked since and launch the game they gave up on.
    // The server has already counted this player into the game, so
    // it is told the game ended, as after the game exits; otherwise
    // it can refuse the next join.
    if ctx
        .lobby
        .operations
        .take_called_off_launch(launch_order.uid)
    {
        tracing::info!(
            game_id = launch_order.uid,
            "lobby: not launching a join that was called off"
        );
        ctx.ports.lobby.send_game_relay(
            "GameState".into(),
            vec![serde_json::Value::String("Ended".into())],
        );
        return;
    }
    let already_prepared = out.with_state(|state| {
        matches!(
            state.lobby.join,
            faf_domain::state::JoinState::Joining {
                id,
                prepared: true,
            } if id == launch_order.uid
        )
    });
    out.emit(LobbyEvent::Launching {
        launch: launch_order.clone(),
    });
    if !launch_enabled {
        // The server answered the join for this game, so the join
        // waiting on that answer is done with the slot. See below.
        ctx.lobby.operations.release_join_launched(launch_order.uid);
        return;
    }
    if background.launch.take().is_some() {
        // The server does not send a second order while the first is
        // being acted on; if it ever does, the newer one is the game.
        tracing::warn!("a launch order arrived while another was starting; replacing it");
        ctx.ports.ice.stop();
    }
    launch.session = None;
    launch.held.clear();
    launch.called_off = false;
    launch.name = launch_order.name.clone();
    // A launch order is new work, with an id of its own: whatever an
    // earlier join did, this one has not been cancelled, and a
    // `CancelJoin` pressed while it prepares reaches it. It runs
    // beside the update loop rather than inside it (see the loop).
    let operations = &ctx.lobby.operations;
    let operation = operations.begin();
    let game_id = launch_order.uid;
    background.launch = Some(Box::pin(async move {
        operations
            .run(
                operation,
                launcher::start(&launch_order, ctx, out, already_prepared),
            )
            .await
    }));
    // The server answered the join for this game, so the join waiting
    // on that answer is done with the slot. Only that one: a launch for
    // a join the user called off must not free a newer join's slot.
    // Not the refusal path's helper: that one consumes the records of
    // called-off attempts, which their own answers still need.
    ctx.lobby.operations.release_join_launched(game_id);
}

/// A relay message for the game's adapter: `LobbyUpdate::GameRelay`.
pub(super) async fn on_game_relay(
    command: String,
    args: Vec<serde_json::Value>,
    launch: &mut LaunchSlot,
    background: &mut Background<'_>,
) {
    tracing::debug!(
        %command,
        has_launch_session = launch.session.is_some(),
        "game relay message received"
    );
    if let Some(session) = launch.session.as_ref() {
        session.forward_to_adapter(command, args).await;
    } else if background.launch.is_some() {
        if launch.held.len() < MAX_HELD_RELAYS {
            launch.held.push((command, args));
        } else {
            tracing::warn!(%command, "relay message dropped: too many held for a launch");
        }
    }
}

pub(super) fn terminate_game(ctx: &ServiceCtx, out: &EventSink) {
    // A launch still being prepared has no process to kill yet. The flag is
    // what stops it at its next step instead of letting it start a game
    // nobody wants any more; a launch that already finished never reads it,
    // and the next one clears it when it starts.
    ctx.lobby.operations.cancel();
    ctx.ports.process.kill();
    ctx.ports.ice.stop();
    ctx.lobby.operations.release_any_join();
    ctx.lobby.running_game.clear();
    out.emit(LobbyEvent::GameTerminated);
}
