//! Game process port: launching `ForgedAlliance.exe`.
//!
//! The launcher hands over the GPGNet port the game must connect to (the
//! adapter's port), the lobby init mode, and the server-provided launch args; the
//! impl resolves the executable and builds the full command line. The real impl
//! spawns the game; the fake is inert.

use async_trait::async_trait;
use std::path::PathBuf;

/// Parameters for one game launch.
#[derive(Debug, Clone)]
pub struct GameLaunchParams {
    pub game_id: i32,
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

/// Which of the configured executables actually exist on disk right now.
///
/// Two independent installs by design (see `faf-domain`'s settings module): a
/// user can have replay playback working while live games aren't configured, or
/// the reverse.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct InstallPresence {
    pub game: bool,
    pub replay: bool,
}

/// Existing FAF-managed executables discovered from another installed client.
///
/// These are deliberately executable paths, not the original Steam/retail
/// installation directory stored by the reference clients. The latter is only
/// source material for their patchers and must never become our update target.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DiscoveredInstallPaths {
    pub game: Option<String>,
    pub replay: Option<String>,
}

#[async_trait]
pub trait ProcessPort: Send + Sync {
    /// Whether this port is backed by a configured live-game launcher. The
    /// lobby service uses the capability instead of reading environment
    /// configuration directly, keeping deployment choices behind the port.
    fn supports_live_launch(&self) -> bool;

    /// Launch the game. Returns once the process has been spawned. Errors if the
    /// executable can't be resolved or started.
    async fn launch_game(&self, params: GameLaunchParams) -> Result<(), String>;

    /// Launch a single-player game on the *live* install: no lobby, no
    /// connectivity adapter, no `/gpgnet`.
    ///
    /// Used for tutorials. Distinct from [`Self::launch_game`], which always
    /// points the game at an adapter port, and from [`Self::launch_replay`],
    /// which runs the separate replay install: a tutorial is a real game on
    /// the real install, it just has nobody to connect to. Mirrors the Java
    /// client's `launchOfflineGame`.
    async fn launch_offline(&self, featured_mod: String, map: String) -> Result<(), String>;

    /// Launch the game with an exact argument list: used for replay playback,
    /// which needs neither `/gpgnet` nor the other live-join arguments
    /// [`Self::launch_game`] adds. The caller (see `infra/replay.rs`) builds the
    /// full `/replay ... /init ... /nobugreport ...` list itself.
    async fn launch_replay(&self, args: Vec<String>) -> Result<(), String>;

    /// Kill the game process, if running. Idempotent.
    fn kill(&self);

    /// Resolve when the currently running game process exits.
    ///
    /// Without this the client has no idea the game ended: it stays `InGame`
    /// until the user explicitly terminates, so the Play tab keeps saying the
    /// player is in a game and refuses another join. Both reference clients
    /// watch the process instead (the Python client's `GameSession._exited` on
    /// `QProcess.finished`, Java's `GameRunner`).
    ///
    /// The default never resolves, which is the honest answer for a fake that
    /// never starts a process: no exit will ever happen.
    async fn wait_for_exit(&self) {
        std::future::pending::<()>().await
    }

    /// Point the launcher at new install paths.
    ///
    /// Called by the settings service whenever either path changes, so picking
    /// an install in Settings takes effect immediately. Before this existed the
    /// paths were read from env vars once at startup, which is why the Settings
    /// UI used to say "takes effect after restarting the client".
    fn set_paths(&self, game_path: String, replay_game_path: String);

    /// Replace the literal user-supplied arguments prepended to launches.
    /// Implementations pass these directly to the process API, never a shell.
    fn set_additional_arguments(&self, arguments: Vec<String>);

    /// The directory the live install's patched files live under: the parent
    /// of `bin/`, derived from the configured executable. `None` when no live
    /// path is set.
    ///
    /// Exposed here, rather than read from the environment by whoever needs
    /// it, because [`Self::set_paths`] can repoint the install at runtime and
    /// the game updater must patch the install that is about to be *launched*,
    /// not the one that was configured at startup.
    fn game_install_dir(&self) -> Option<PathBuf>;

    /// Stat the configured executables. Drives the missing-install banner, and
    /// is the reason it can distinguish "no path set" from "path set but the
    /// file is gone": both report `false`, and both are worth telling the user
    /// about.
    fn installs_present(&self) -> InstallPresence;

    /// Validate one candidate executable without changing the active paths.
    /// Used during startup migration so a stale explicit setting can be
    /// repaired from a discovered reference-client install.
    fn install_path_is_present(&self, _path: &str) -> bool {
        false
    }

    /// Find usable FAF-managed live/replay executables left by another client.
    ///
    /// The settings service only consults this when the corresponding explicit
    /// path is unset. Fakes and test doubles have no host installation to
    /// inspect, so the default is intentionally empty.
    fn discover_install_paths(&self) -> DiscoveredInstallPaths {
        DiscoveredInstallPaths::default()
    }
}
