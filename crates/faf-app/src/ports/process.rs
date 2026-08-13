//! Game process port — launching `ForgedAlliance.exe`.
//!
//! The launcher hands over the GPGNet port the game must connect to (the
//! adapter's port), the lobby init mode, and the server-provided launch args; the
//! impl resolves the executable and builds the full command line. The real impl
//! spawns the game; the fake is inert.

use async_trait::async_trait;

/// Parameters for one game launch.
#[derive(Debug, Clone)]
pub struct GameLaunchParams {
    /// GPGNet port the game connects to (the adapter's `--gpgnet-port`).
    pub game_port: u16,
    /// Lobby init mode: 0 = normal (custom), 1 = auto (matchmaker).
    pub init_mode: i32,
    /// Featured mod, selecting the `init_<mod>.lua` bootstrap (e.g. `faf`).
    pub featured_mod: String,
    pub player_id: i32,
    pub player_login: String,
    /// Server-provided `game_launch` args (e.g. `/numgames N`). Client-derived
    /// rating args are a later phase (see the plan's known gap).
    pub args: Vec<String>,
}

#[async_trait]
pub trait ProcessPort: Send + Sync {
    /// Launch the game. Returns once the process has been spawned. Errors if the
    /// executable can't be resolved or started.
    async fn launch_game(&self, params: GameLaunchParams) -> Result<(), String>;

    /// Launch the game with an exact argument list — used for replay playback,
    /// which needs neither `/gpgnet` nor the other live-join arguments
    /// [`Self::launch_game`] adds. The caller (see `infra/replay.rs`) builds the
    /// full `/replay ... /init ... /nobugreport ...` list itself.
    async fn launch_replay(&self, args: Vec<String>) -> Result<(), String>;

    /// Kill the game process, if running. Idempotent.
    fn kill(&self);
}
