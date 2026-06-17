//! Real game launcher — runs `ForgedAlliance.exe`.
//!
//! Builds the FA command line the way the Python client's `fa/play.py`
//! `build_argument_list` does: the server-provided launch args, then
//! `/init init_<mod>.lua`, `/nobugreport`, and `/gpgnet 127.0.0.1:<port>`. The
//! working directory is the executable's folder (where `init_<mod>.lua` lives).
//!
//! The executable is located via `FAF_GAME_PATH`; this path is opt-in via
//! `FAF_REAL_LAUNCH=1`, with [`FakeGame`] as the default so the app runs without
//! the game installed.
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
    /// Path to `ForgedAlliance.exe`.
    pub game_path: String,
}

impl GameConfig {
    pub fn faf() -> Self {
        Self {
            game_path: std::env::var("FAF_GAME_PATH").unwrap_or_default(),
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

#[async_trait]
impl ProcessPort for GameProcess {
    async fn launch_game(&self, params: GameLaunchParams) -> Result<(), String> {
        let game_path = self.config.game_path.clone();
        if game_path.is_empty() {
            return Err("FAF_GAME_PATH is not set".into());
        }
        let exe = PathBuf::from(&game_path);
        let work_dir = exe
            .parent()
            .map(PathBuf::from)
            .ok_or_else(|| format!("game path has no parent dir: {game_path}"))?;

        let args = build_arguments(&params);
        eprintln!(
            "[game] launching {} {}",
            exe.display(),
            args.join(" ")
        );

        let mut command = Command::new(&exe);
        command.args(&args).current_dir(&work_dir);

        let child = command
            .spawn()
            .map_err(|e| format!("could not start '{}': {e}", exe.display()))?;

        if let Some(prev) = self.child.lock().unwrap().replace(child) {
            drop(prev);
        }
        Ok(())
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
