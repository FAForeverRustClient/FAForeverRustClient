//! Fake lobby provider — emits an evolving game list without any network.
//!
//! Stands in for the real FAF lobby protocol. On `connect` it sends an immediate
//! snapshot, then mutates the list every couple of seconds (player counts change,
//! games come and go) so the live-update path is visibly exercised. `join` pushes
//! a synthetic `game_launch` back on the same stream after a short delay, so the
//! join path is exercised end-to-end offline. `disconnect` cancels the loop,
//! exercising the same teardown path as the real client.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use faf_domain::state::{Game, GameLaunch, HostGameRequest};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::ports::{LobbyPort, LobbyUpdate};

/// Delay before the fake server "accepts" a host request, mirroring [`JOIN_DELAY`].
const HOST_DELAY: Duration = Duration::from_millis(150);

/// Interval between simulated lobby updates.
const TICK: Duration = Duration::from_secs(2);
/// Delay before the fake server "accepts" a join and replies with a launch order.
const JOIN_DELAY: Duration = Duration::from_millis(150);

#[derive(Debug, Clone, Default)]
pub struct FakeLobby {
    /// Cancels the in-flight connection's update loop. Shared so `disconnect`
    /// (a separate call) can reach the task started by `connect`.
    cancel: Arc<Mutex<Option<CancellationToken>>>,
    /// The live connection's update sender, so `join` (a separate call) can push a
    /// reply onto the same stream the service is draining.
    updates: Arc<Mutex<Option<mpsc::Sender<LobbyUpdate>>>>,
}

#[async_trait]
impl LobbyPort for FakeLobby {
    async fn connect(&self) -> mpsc::Receiver<LobbyUpdate> {
        let token = CancellationToken::new();
        // Replace (and cancel) any previous connection.
        if let Some(prev) = self.cancel.lock().unwrap().replace(token.clone()) {
            prev.cancel();
        }

        let (tx, rx) = mpsc::channel(8);
        *self.updates.lock().unwrap() = Some(tx.clone());
        tokio::spawn(async move {
            let mut games = seed_games();
            // Immediate first snapshot so the UI fills instantly.
            if tx.send(LobbyUpdate::Games(games.clone())).await.is_err() {
                return;
            }
            let mut tick: u32 = 0;
            loop {
                tokio::select! {
                    _ = token.cancelled() => break, // disconnect requested
                    _ = tokio::time::sleep(TICK) => {}
                }
                tick = tick.wrapping_add(1);
                evolve(&mut games, tick);
                if tx.send(LobbyUpdate::Games(games.clone())).await.is_err() {
                    break; // receiver dropped — consumer gone, stop.
                }
            }
        });
        rx
    }

    fn join(&self, id: i32) {
        // Push a synthetic launch order back on the live stream, mimicking the
        // server's `game_launch`. No-op if there's no active connection.
        let Some(tx) = self.updates.lock().unwrap().clone() else {
            return;
        };
        tokio::spawn(async move {
            tokio::time::sleep(JOIN_DELAY).await;
            let _ = tx.send(LobbyUpdate::Launch(fake_launch(id))).await;
        });
    }

    fn send_game_relay(&self, _command: String, _args: Vec<serde_json::Value>) {
        // The fake stops at the launch order; it doesn't simulate in-game relay.
    }

    fn host(&self, _req: HostGameRequest) {
        // Fabricate an id and report success shortly after, mirroring `join`'s
        // synthetic reply — good enough to exercise the Host dialog's state
        // transitions offline. The fake's periodic snapshot (started in
        // `connect`) isn't taught about this game, so it won't appear in the
        // list — acceptable, since this stands in for the *reply*, not the
        // list's visual fidelity.
        let Some(tx) = self.updates.lock().unwrap().clone() else {
            return;
        };
        tokio::spawn(async move {
            tokio::time::sleep(HOST_DELAY).await;
            let _ = tx.send(LobbyUpdate::Hosted { id: fake_host_id() }).await;
        });
    }

    fn disconnect(&self) {
        if let Some(token) = self.cancel.lock().unwrap().take() {
            token.cancel();
        }
        // Drop the sender handle so a later `join` before reconnect is a no-op.
        *self.updates.lock().unwrap() = None;
    }
}

fn seed_games() -> Vec<Game> {
    vec![
        Game {
            id: 1,
            title: "Ranked 1v1".into(),
            host: "Stormlord".into(),
            players: 1,
            max_players: 2,
            map: "Theta Passage".into(),
            mod_name: "faf".into(),
            rating_min: Some(1000),
            rating_max: Some(1400),
            teams: [("1".to_string(), vec!["Stormlord".to_string()])].into(),
            ..Default::default()
        },
        Game {
            id: 2,
            title: "Team Battle".into(),
            host: "Aurora".into(),
            players: 5,
            max_players: 8,
            map: "Seton's Clutch".into(),
            mod_name: "faf".into(),
            sim_mods: vec!["Total Mayhem".into()],
            teams: [
                ("1".to_string(), vec!["Aurora".to_string(), "Stormlord".to_string()]),
                ("2".to_string(), vec!["Vex".to_string()]),
            ]
            .into(),
            ..Default::default()
        },
        Game {
            id: 3,
            title: "Sandbox".into(),
            host: "Vex".into(),
            players: 2,
            max_players: 12,
            map: "Open Palms".into(),
            mod_name: "faf".into(),
            password_protected: true,
            ..Default::default()
        },
    ]
}

/// A fabricated id for a freshly hosted game — high enough to not collide with
/// `seed_games`'s ids or the `evolve` transient id.
fn fake_host_id() -> i32 {
    1000
}

/// A plausible `game_launch` for the joined game, so the offline join path lands
/// in `JoinState::Launched`.
fn fake_launch(id: i32) -> GameLaunch {
    GameLaunch {
        uid: id,
        mod_name: "faf".into(),
        name: format!("Game {id}"),
        mapname: "scmp_009".into(),
        game_type: "custom".into(),
        rating_type: "global".into(),
        args: vec!["/numgames".into(), "0".into()],
    }
}

/// Mutate the list a little each tick: bump a player count, and every few ticks
/// toggle a transient game in and out so additions/removals are exercised too.
fn evolve(games: &mut Vec<Game>, tick: u32) {
    if let Some(g) = games.first_mut() {
        g.players = 1 + (tick % g.max_players.max(1) as u32) as i32;
    }

    const TRANSIENT_ID: i32 = 99;
    let present = games.iter().any(|g| g.id == TRANSIENT_ID);
    if tick.is_multiple_of(3) && !present {
        games.push(Game {
            id: TRANSIENT_ID,
            title: "Quick Match".into(),
            host: "Nomad".into(),
            players: 3,
            max_players: 4,
            map: "Canis River".into(),
            mod_name: "faf".into(),
            ..Default::default()
        });
    } else if !tick.is_multiple_of(3) && present {
        games.retain(|g| g.id != TRANSIENT_ID);
    }
}
