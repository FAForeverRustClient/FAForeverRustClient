//! Lobby service.
//!
//! Bridges the bidirectional, streaming [`LobbyPort`](crate::ports::LobbyPort) to
//! events: it connects, then maps each
//! [`LobbyUpdate`](crate::ports::LobbyUpdate) onto an event until the
//! stream ends. `Join` sends a `game_join` over the live connection; the server's
//! reply (`Launching` / `JoinFailed`) arrives back on that same update stream.
//!
//! When a launch order arrives, the connect loop also drives the
//! [`launcher`](crate::services::launcher): it
//! starts the ICE adapter + game and then forwards the `target: "game"` relay
//! messages (which arrive on this very stream) to the adapter. Keeping the launch
//! session in this loop means no cross-task plumbing: the loop already sees both
//! the launch order and the relay traffic.
//!
//! Split by lifecycle, one module each:
//!
//! - `connection`: the connect loop, reconnecting, and restoring the game
//!   session a dropped socket took with it.
//! - `joining`: joining and hosting a custom game, and calling a join off.
//! - `launch`: acting on a launch order beside the update loop.
//! - `matchmaking`: searches, parties, matches found, queues, vetoes and the
//!   map pools seen.
//! - `game_notifications`: the game, friend and queue-opponent signals.
//! - `avatars`: the avatar picker and the fallback when one lapses.
//! - `updates`: the dispatch of each server update to the modules above.

mod avatars;
mod connection;
mod game_notifications;
mod joining;
mod launch;
mod matchmaking;
mod updates;

use faf_domain::state::{HostGameConfig, JoinState, LobbyCommand, LobbyEvent};

use crate::runtime::{
    AutoReconnect, Cancellable, EventSink, LatestRequest, LobbyOperations, RunningGame, ServiceCtx,
    SingleFlight,
};

pub use connection::reconnect;

/// The lobby connection's operational context: its single-flight guard, the
/// joins, hosts and launch orders in progress, and what this session remembers
/// about the game being played.
///
/// Owned by this service. The launcher, auth and reconnect services reach the
/// parts they need through the named methods below, never the fields.
#[derive(Default)]
pub struct LobbyContext {
    /// Single-flight guard for the lobby connection while `Connect` owns an
    /// active/connecting socket. A redundant request is dropped, so overlapping
    /// connections cannot race and clobber each other's state.
    active: SingleFlight,
    /// The lobby's joins, hosts and launch orders: which one is current,
    /// whether it was called off, and which join holds the single-flight join
    /// slot. See [`LobbyOperations`].
    ///
    /// The launcher only ever asks whether its work was called off and starts
    /// a launch uncancelled, so it goes through [`Self::launch_cancelled`] and
    /// [`Self::clear_launch_cancellation`] rather than this field.
    operations: LobbyOperations,
    /// Which match the match-start watchdog was armed for. A timer for a
    /// match that was cancelled must not call off the next one found on the
    /// same queue; see `watch_for_match_start`.
    match_generation: LatestRequest,
    /// The title of the game this client last asked the server to host, so
    /// the launch order that answers it starts on the hosting preference.
    /// Taken by that launch; see `launcher::launch`.
    hosted_title: std::sync::Mutex<Option<String>>,
    /// The game this client is currently playing, if any. Read when the lobby
    /// socket comes back, so the server can be told to restore the game
    /// session it dropped along with the connection.
    running_game: RunningGame,
    /// Whether [`reconnect`](crate::services::reconnect) should bring this
    /// socket back after an unexpected drop, so a user who hung up stays hung
    /// up while a laptop resume does not.
    auto_reconnect: AutoReconnect,
    /// Whether this session has compared the matchmaker map pools with the
    /// ones last seen (#406). Once per run: pools change between releases,
    /// not between reconnects.
    map_pools_checked: std::sync::atomic::AtomicBool,
    /// The search being prepared before the server is asked for it, so that
    /// Stop, or the end of the connection, reaches the updater behind it. See
    /// `matchmaking::start_search`.
    search_preparation: Cancellable<()>,
}

impl LobbyContext {
    /// Whether the lobby work running here was called off or superseded. The
    /// launcher asks at every boundary where a cancelled join could still be
    /// narrated or started; see [`LobbyOperations::is_cancelled`].
    pub fn launch_cancelled(&self) -> bool {
        self.operations.is_cancelled()
    }

    /// The token that is raised when the lobby work running here is called
    /// off or superseded, for the preparation to hand to the updater; see
    /// [`LobbyOperations::called_off`].
    pub fn launch_called_off(&self) -> tokio_util::sync::CancellationToken {
        self.operations.called_off()
    }

    /// A launch order is new work and starts uncancelled, whatever an earlier
    /// join did. Inside a named operation this leaves that operation current;
    /// see [`LobbyOperations::clear`].
    pub fn clear_launch_cancellation(&self) {
        self.operations.clear();
    }

    /// Take the title of the game this client last asked to host, so the
    /// launch can tell whether it is starting that game. Taken either way:
    /// the next launch is somebody else's game unless a new host request says
    /// otherwise.
    pub fn take_hosted_title(&self) -> Option<String> {
        self.hosted_title.lock().unwrap().take()
    }

    /// The game this client is playing, if any. Auth reads it so an offline
    /// launch cannot replace a game that is already running.
    pub fn running_game_id(&self) -> Option<i32> {
        self.running_game.id()
    }

    /// Record the game the launcher just started, so a lobby socket that comes
    /// back while it runs can have its game session restored.
    pub fn set_running_game(&self, game_id: i32) {
        self.running_game.set(game_id);
    }

    /// A handle on the running game for the launcher's game-exit watcher. The
    /// watcher is a spawned task that outlives the launch, and it is the one
    /// that clears the game once the process exits.
    pub fn running_game_handle(&self) -> RunningGame {
        self.running_game.clone()
    }

    /// Whether an explicit `Connect` armed the lobby connection to come back
    /// after an unexpected drop. Read by
    /// [`reconnect`](crate::services::reconnect).
    pub fn auto_reconnect_armed(&self) -> bool {
        self.auto_reconnect.armed()
    }
}

pub async fn handle(cmd: LobbyCommand, ctx: &ServiceCtx, out: &EventSink) {
    match cmd {
        LobbyCommand::Connect => {
            // An explicit Connect is what asks for the lobby to be kept up,
            // so it is what arms the watchdog in `services::reconnect`; until
            // it did, a connection whose adapter had given up stayed down for
            // good. Armed before the guard, so asking while a connection is
            // already in flight still re-arms it. The same shape as chat.
            ctx.lobby.auto_reconnect.arm();
            connection::connect(ctx, out).await
        }
        LobbyCommand::Join {
            id,
            password,
            replace_mods,
        } => joining::join(id, password, replace_mods, ctx, out).await,
        // Opening the host dialog from another tab. Nothing is hosted here: the
        // title crosses into the lobby slice and the dialog does the rest, so
        // the map and the featured mod stay the host's decision.
        LobbyCommand::PrepareHost { title } => out.emit(LobbyEvent::HostPrepared {
            title: title
                .trim()
                .chars()
                .take(HostGameConfig::MAX_TITLE_CHARS)
                .collect(),
        }),
        LobbyCommand::ClearHostPrefill => out.emit(LobbyEvent::HostPrefillCleared),
        LobbyCommand::Host { config } => joining::host(config, ctx, out).await,
        LobbyCommand::Matchmake { queue_name, start } => {
            matchmaking::matchmake(queue_name, start, ctx, out)
        }
        LobbyCommand::StartSearch { queue_names } => {
            matchmaking::start_search(queue_names, ctx, out).await
        }
        LobbyCommand::LeaveParty => matchmaking::leave_party(ctx, out),
        LobbyCommand::KickPartyMember { player_id } => ctx.ports.lobby.kick_party_member(player_id),
        LobbyCommand::InviteToParty { player_id } => {
            matchmaking::invite_to_party(player_id, ctx, out)
        }
        LobbyCommand::AcceptPartyInvite { player_id } => {
            matchmaking::accept_party_invite(player_id, ctx, out)
        }
        LobbyCommand::SetPartyFactions { factions } => ctx.ports.lobby.set_party_factions(factions),
        LobbyCommand::SetPlayMode { mode } => out.emit(LobbyEvent::PlayModeChanged { mode }),
        LobbyCommand::SetPlayerVetoes { vetoes } => {
            matchmaking::set_player_vetoes(vetoes, ctx, out).await
        }
        LobbyCommand::LoadAvatars => avatars::load_avatars(ctx, out),
        LobbyCommand::SelectAvatar { url } => {
            if avatars::select_avatar(ctx, out, url.clone()) {
                avatars::remember_own_avatar(ctx, out, url.as_deref().unwrap_or_default()).await;
            }
        }
        LobbyCommand::DeclineModReplacement => {
            // Nothing to stop: preparation already returned, having installed
            // nothing. This only clears the prompt.
            if out.with_state(|state| {
                matches!(state.lobby.join, JoinState::NeedsModReplacement { .. })
            }) {
                out.emit(LobbyEvent::JoinCancelled);
            }
        }
        LobbyCommand::CancelJoin => joining::cancel_join(ctx, out),
        LobbyCommand::TerminateGame => {
            launch::terminate_game(ctx, out);
        }
        LobbyCommand::Disconnect => {
            // The user hung up, so the reconnect watchdog leaves it hung up.
            // Disarmed before the socket closes: the watchdog reads the flag
            // when it sees `Disconnected`, which this is about to cause.
            ctx.lobby.auto_reconnect.disarm();
            // Cancels the active connection; the `Connect` task above then sees the
            // stream close and emits `Disconnected`.
            out.emit(LobbyEvent::JoinCancelled);
            ctx.ports.lobby.disconnect();
            // Called off as well as released. Releasing alone left the
            // operation current, so a download finishing after the hang-up
            // still read "live" and sent its join, on the next connection if
            // one had come up by then.
            ctx.lobby.operations.cancel();
            ctx.lobby.operations.release_any_join();
        }
    }
}
