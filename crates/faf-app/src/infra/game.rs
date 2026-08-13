//! Real game launcher — runs `ForgedAlliance.exe`.
//!
//! Builds the FA command line the way the Python client's `fa/play.py`
//! `build_argument_list` does: the server-provided launch args, then
//! `/init init_<mod>.lua`, `/nobugreport`, and `/gpgnet 127.0.0.1:<port>`. The
//! working directory is the executable's folder (where `init_<mod>.lua` lives).
//!
//! Two separate installs, two separate paths — mirrors the Python client's
//! `GameProcess` (live join) vs `ReplayProcess` (replay playback, a distinct
//! `REPLAYDATA_DIR/bin` install so replays can run a different FA
//! build/version than live games). [`GameConfig::game_path`] (`FAF_GAME_PATH`)
//! is used for [`ProcessPort::launch_game`]; [`GameConfig::replay_game_path`]
//! (`FAF_REPLAY_GAME_PATH`) for [`ProcessPort::launch_replay`] — they are
//! never interchanged, even if only one is set.
//!
//! Real launch is opt-in via `FAF_REAL_LAUNCH=1`, with [`FakeGame`] as the
//! default so the app runs without the game installed.
//!
//! Known gaps (later phases, see the plan): no replay server (`/savereplay`
//! omitted), no client-derived rating args, and no game-bin/init staging — the
//! FAF `init_<mod>.lua` must already be present beside the executable.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use tokio::process::{Child, Command};

use crate::ports::{GameLaunchParams, ProcessPort};

#[derive(Debug, Clone, Default)]
pub struct GameConfig {
    /// Path to `ForgedAlliance.exe` for live games (`FAF_GAME_PATH`).
    pub game_path: String,
    /// Path to `ForgedAlliance.exe` for replay playback (`FAF_REPLAY_GAME_PATH`)
    /// — a separate install, never falls back to [`Self::game_path`].
    pub replay_game_path: String,
}

impl GameConfig {
    pub fn faf() -> Self {
        Self {
            game_path: std::env::var("FAF_GAME_PATH").unwrap_or_default(),
            replay_game_path: std::env::var("FAF_REPLAY_GAME_PATH").unwrap_or_default(),
        }
    }
}

pub struct GameProcess {
    config: GameConfig,
    child: Arc<Mutex<Option<Child>>>,
}

impl GameProcess {
    pub fn new(config: GameConfig) -> Self {
        Self {
            config,
            child: Arc::new(Mutex::new(None)),
        }
    }

    pub fn faf() -> Self {
        Self::new(GameConfig::faf())
    }
}

impl GameProcess {
    /// Resolve `game_path`, spawn it with `args` in its own parent directory
    /// (the FA working directory), and track the child for [`ProcessPort::kill`].
    /// Shared by [`ProcessPort::launch_game`] and [`ProcessPort::launch_replay`]
    /// — they differ in which path/args they pass in, never in this logic.
    /// `missing_var` names the env var in the error when `game_path` is unset,
    /// so a misconfigured live-game vs. replay path is easy to tell apart.
    fn spawn(&self, game_path: &str, args: &[String], missing_var: &str) -> Result<(), String> {
        if game_path.is_empty() {
            return Err(format!("{missing_var} is not set"));
        }
        let exe = PathBuf::from(game_path);
        let work_dir = exe
            .parent()
            .map(PathBuf::from)
            .ok_or_else(|| format!("game path has no parent dir: {game_path}"))?;

        eprintln!("[game] launching {} {}", exe.display(), args.join(" "));

        let mut command = Command::new(&exe);
        command.args(args).current_dir(&work_dir);

        let child = command
            .spawn()
            .map_err(|e| format!("could not start '{}': {e}", exe.display()))?;

        // `drop(prev)` here (the bug this replaces) only discards *our*
        // handle to the previous child — it does not send any signal, so
        // the old FA process kept running as an orphan. Confirmed live:
        // relaunching a replay left two `ForgedAlliance.exe` processes
        // alive simultaneously, apparently fighting over the same install's
        // shader cache/lock files — the previous process froze on a blank
        // post-shader-compile screen with zero further disk activity, no
        // crash, no error, exactly the reported hang. `start_kill()`
        // mirrors `ProcessPort::kill`'s own termination call.
        if let Some(mut prev) = self.child.lock().unwrap().replace(child) {
            let _ = prev.start_kill();
        }
        Ok(())
    }
}

#[async_trait]
impl ProcessPort for GameProcess {
    async fn launch_game(&self, params: GameLaunchParams) -> Result<(), String> {
        self.spawn(&self.config.game_path, &build_arguments(&params), "FAF_GAME_PATH")
    }

    async fn launch_replay(&self, args: Vec<String>) -> Result<(), String> {
        self.spawn(&self.config.replay_game_path, &args, "FAF_REPLAY_GAME_PATH")
    }

    fn kill(&self) {
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.start_kill();
        }
    }
}

/// Build the FA argument list: server args first, then init/bugreport/gpgnet.
/// Mirrors `fa/play.py:build_argument_list` (replay `/savereplay` omitted until we
/// run a replay server).
fn build_arguments(params: &GameLaunchParams) -> Vec<String> {
    let mut args = params.args.clone();
    args.push("/init".into());
    args.push(format!("init_{}.lua", params.featured_mod));
    args.push("/nobugreport".into());
    args.push("/gpgnet".into());
    args.push(format!("127.0.0.1:{}", params.game_port));
    args
}

/// Inert game launcher — used offline and in tests. Launching is a no-op success.
#[derive(Debug, Clone, Default)]
pub struct FakeGame;

#[async_trait]
impl ProcessPort for FakeGame {
    async fn launch_game(&self, _params: GameLaunchParams) -> Result<(), String> {
        Ok(())
    }
    async fn launch_replay(&self, _args: Vec<String>) -> Result<(), String> {
        Ok(())
    }
    fn kill(&self) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params() -> GameLaunchParams {
        GameLaunchParams {
            game_port: 7237,
            init_mode: 0,
            featured_mod: "faf".into(),
            player_id: 1,
            player_login: "me".into(),
            args: vec!["/numgames".into(), "5".into()],
        }
    }

    #[test]
    fn builds_fa_command_line_in_order() {
        let args = build_arguments(&params());
        assert_eq!(
            args,
            vec![
                "/numgames",
                "5",
                "/init",
                "init_faf.lua",
                "/nobugreport",
                "/gpgnet",
                "127.0.0.1:7237",
            ]
        );
    }
}
