//! Launcher orchestration — turns a `game_launch` order into a running game.
//!
//! Backend-neutral: it asks the [`IcePort`](crate::ports::IcePort) for a
//! [`ConnectivitySession`](crate::ports::ConnectivitySession) (Go or Java decide
//! their own internals), launches the game on the session's GPGNet port, and
//! bridges the session's relay channels to the lobby:
//!
//! - `session.to_lobby` → `lobby.send_game_relay` (adapter → lobby)
//! - lobby `target: "game"` messages → [`LaunchSession::forward_to_adapter`] →
//!   `session.from_lobby` (lobby → adapter)
//!
//! The lobby connect loop owns the returned [`LaunchSession`] and feeds it the
//! relay messages arriving on the same socket. On any setup failure we stop the
//! adapter and emit `LaunchFailed`.

use faf_domain::state::{GameLaunch, LobbyEvent};
use serde_json::Value;
use tokio::sync::mpsc;

use crate::ports::{GameLaunchParams, IceParams, RelayMsg};
use crate::runtime::{EventSink, ServiceCtx};

/// A live launch: the channel into the adapter, used to forward lobby
/// game-relay messages. Dropping it does not stop the game.
pub struct LaunchSession {
    from_lobby: mpsc::Sender<RelayMsg>,
}

impl LaunchSession {
    /// Forward a lobby `target: "game"` message to the connectivity backend.
    pub fn forward_to_adapter(&self, command: String, args: Vec<Value>) {
        // try_send: if the backend buffer is full or gone, drop — the session
        // will end and the game/adapter recover or tear down.
        let _ = self.from_lobby.try_send(RelayMsg { command, args });
    }
}

/// Run the launch chain. Emits `InGame` on success (returning the session) or
/// `LaunchFailed` on any failure (returning `None`, after stopping the adapter).
pub async fn start(
    launch: &GameLaunch,
    ctx: &ServiceCtx,
    out: &EventSink,
) -> Option<LaunchSession> {
    let Some(player) = out.snapshot().auth.player else {
        return fail(ctx, out, "not logged in".into());
    };
    let init_mode = init_mode_for(&launch.game_type);

    // 1. Bring up the connectivity backend (it picks its own ports / control plane).
    let session = match ctx
        .ports
        .ice
        .start(IceParams {
            player_id: player.id,
            player_login: player.name.clone(),
            game_id: launch.uid,
            init_mode,
        })
        .await
    {
        Ok(session) => session,
        Err(e) => return fail(ctx, out, format!("ice adapter: {e}")),
    };

    // 2. Launch the game pointed at the adapter's GPGNet port.
    let game_params = GameLaunchParams {
        game_port: session.game_port,
        init_mode,
        featured_mod: launch.mod_name.clone(),
        player_id: player.id,
        player_login: player.name.clone(),
        args: launch.args.clone(),
    };
    if let Err(e) = ctx.ports.process.launch_game(game_params).await {
        ctx.ports.ice.stop();
        return fail(ctx, out, format!("game launch: {e}"));
    }

    // 3. Pump adapter → lobby. The reverse direction is driven by the lobby loop
    //    via `forward_to_adapter`.
    let lobby = ctx.ports.lobby.clone();
    let mut to_lobby = session.to_lobby;
    tokio::spawn(async move {
        while let Some(msg) = to_lobby.recv().await {
            lobby.send_game_relay(msg.command, msg.args);
        }
    });

    out.emit(LobbyEvent::InGame);
    Some(LaunchSession {
        from_lobby: session.from_lobby,
    })
}

/// Stop the adapter and emit `LaunchFailed`. Always returns `None` so call sites
/// can `return fail(..)`.
fn fail(ctx: &ServiceCtx, out: &EventSink, reason: String) -> Option<LaunchSession> {
    eprintln!("[launcher] launch failed: {reason}");
    ctx.ports.ice.stop();
    out.emit(LobbyEvent::LaunchFailed { reason });
    None
}

/// Custom games init in NORMAL mode (0); matchmaker games in AUTO (1).
fn init_mode_for(game_type: &str) -> i32 {
    if game_type == "matchmaker" {
        1
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn init_mode_normal_for_custom_auto_for_matchmaker() {
        assert_eq!(init_mode_for("custom"), 0);
        assert_eq!(init_mode_for(""), 0);
        assert_eq!(init_mode_for("matchmaker"), 1);
    }
}
