//! Fake lobby provider — emits an evolving game list without any network.
//!
//! Stands in for the real FAF lobby protocol. On `connect` it sends an immediate
//! snapshot, then mutates the list every couple of seconds (player counts change,
//! games come and go) so the live-update path is visibly exercised. `disconnect`
//! cancels the loop, exercising the same teardown path as the real client.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use faf_domain::state::Game;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::ports::LobbyPort;

/// Interval between simulated lobby updates.
const TICK: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Default)]
pub struct FakeLobby {
    /// Cancels the in-flight connection's update loop. Shared so `disconnect`
    /// (a separate call) can reach the task started by `connect`.
    cancel: Arc<Mutex<Option<CancellationToken>>>,
}

#[async_trait]
impl LobbyPort for FakeLobby {
    async fn connect(&self) -> mpsc::Receiver<Vec<Game>> {
        let token = CancellationToken::new();
        // Replace (and cancel) any previous connection.
        if let Some(prev) = self.cancel.lock().unwrap().replace(token.clone()) {
            prev.cancel();
        }

        let (tx, rx) = mpsc::channel(8);
        tokio::spawn(async move {
            let mut games = seed_games();
            // Immediate first snapshot so the UI fills instantly.
            if tx.send(games.clone()).await.is_err() {
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
                if tx.send(games.clone()).await.is_err() {
                    break; // receiver dropped — consumer gone, stop.
                }
            }
        });
        rx
    }

    fn disconnect(&self) {
        if let Some(token) = self.cancel.lock().unwrap().take() {
            token.cancel();
        }
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
        },
        Game {
            id: 2,
            title: "Team Battle".into(),
            host: "Aurora".into(),
            players: 5,
            max_players: 8,
            map: "Seton's Clutch".into(),
        },
        Game {
            id: 3,
            title: "Sandbox".into(),
            host: "Vex".into(),
            players: 2,
            max_players: 12,
            map: "Open Palms".into(),
        },
    ]
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
        });
    } else if !tick.is_multiple_of(3) && present {
        games.retain(|g| g.id != TRANSIENT_ID);
    }
}
