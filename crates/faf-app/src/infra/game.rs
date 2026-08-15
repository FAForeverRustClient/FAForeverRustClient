//! Real game launcher: runs `ForgedAlliance.exe`.
//!
//! Builds the FA command line the way the Python client's `fa/play.py`
//! `build_argument_list` does: the server-provided launch args, then
//! `/init init_<mod>.lua`, `/nobugreport`, and `/gpgnet 127.0.0.1:<port>`. The
//! working directory is the executable's folder (where `init_<mod>.lua` lives).
//!
//! Two separate installs, two separate paths: mirrors the Python client's
//! `GameProcess` (live join) vs `ReplayProcess` (replay playback, a distinct
//! `REPLAYDATA_DIR/bin` install so replays can run a different FA
//! build/version than live games). [`GameConfig::game_path`] (`FAF_GAME_PATH`)
//! is used for [`ProcessPort::launch_game`]; [`GameConfig::replay_game_path`]
//! (`FAF_REPLAY_GAME_PATH`) for [`ProcessPort::launch_replay`]: they are
//! never interchanged, even if only one is set.
//!
//! Authenticated sessions use this launcher by default. Explicit offline/test
//! sessions inject [`FakeGame`] so the rest of the app remains install-free.
//!
//! Known gaps (later phases, see the plan): no replay server (`/savereplay`
//! omitted), no client-derived rating args, and no game-bin/init staging: the
//! FAF `init_<mod>.lua` must already be present beside the executable.

use std::collections::HashSet;
use std::fs::File;
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use std::time::Duration;

use async_trait::async_trait;
use tokio::process::{Child, Command};
use tokio::sync::Notify;

use crate::ports::{DiscoveredInstallPaths, GameLaunchParams, InstallPresence, ProcessPort};

const MANAGED_EXE: &str = "ForgedAlliance.exe";
const MAX_REFERENCE_CONFIG_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, Default)]
pub struct GameConfig {
    /// Path to `ForgedAlliance.exe` for live games (`FAF_GAME_PATH`).
    pub game_path: String,
    /// Path to `ForgedAlliance.exe` for replay playback (`FAF_REPLAY_GAME_PATH`)
    ///: a separate install, never falls back to [`Self::game_path`].
    pub replay_game_path: String,
    /// Literal arguments supplied by the user in Settings. They are prepended,
    /// leaving protocol-critical arguments later in the command line.
    pub additional_arguments: Vec<String>,
}

impl GameConfig {
    pub fn faf() -> Self {
        Self {
            game_path: std::env::var("FAF_GAME_PATH").unwrap_or_default(),
            replay_game_path: std::env::var("FAF_REPLAY_GAME_PATH").unwrap_or_default(),
            additional_arguments: Vec::new(),
        }
    }
}

pub struct GameProcess {
    /// Behind a lock because Settings can repoint the installs at runtime
    /// (`ProcessPort::set_paths`): the paths are no longer startup-only.
    config: Mutex<GameConfig>,
    child: Arc<Mutex<Option<Child>>>,
    /// Woken when the tracked child exits; see [`GameProcess::watch_for_exit`].
    exited: Arc<Notify>,
    /// Kept alive for the duration of a live game so FA has somewhere to stream
    /// its replay. Replaced on the next launch, which drops and stops the
    /// previous one.
    replay_recorder: Mutex<Option<crate::infra::replay_recorder::ReplayRecorder>>,
}

impl GameProcess {
    pub fn new(config: GameConfig) -> Self {
        Self {
            config: Mutex::new(config),
            child: Arc::new(Mutex::new(None)),
            exited: Arc::new(Notify::new()),
            replay_recorder: Mutex::new(None),
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
    ///: they differ in which path/args they pass in, never in this logic.
    /// `what` names the install in the error when `game_path` is unset, so a
    /// misconfigured live-game vs. replay path is easy to tell apart. The
    /// message points at Settings rather than at the env var, because that is
    /// now the primary way to configure it.
    fn spawn(&self, game_path: &str, args: &[String], what: &str) -> Result<(), String> {
        if game_path.is_empty() {
            return Err(format!(
                "no {what} install configured: set it in Settings → Paths"
            ));
        }
        let exe = PathBuf::from(game_path);
        if !exe.is_file() {
            return Err(format!(
                "the configured {what} install no longer exists: {game_path}"
            ));
        }
        if is_original_game_executable(&exe) {
            return Err(format!(
                "the configured {what} path is the original Steam/retail game, not a FAF-managed executable: select the ForgedAlliance.exe under FAForever\\bin"
            ));
        }
        let work_dir = exe
            .parent()
            .map(PathBuf::from)
            .ok_or_else(|| format!("game path has no parent dir: {game_path}"))?;

        tracing::info!(argument_count = args.len(), "launching Forged Alliance");

        let mut command = Command::new(&exe);
        let config = self.config.lock().unwrap();
        command
            .args(&config.additional_arguments)
            .args(args)
            .current_dir(&work_dir);
        drop(config);

        let child = command
            .spawn()
            .map_err(|e| format!("could not start '{}': {e}", exe.display()))?;

        // `drop(prev)` here (the bug this replaces) only discards *our*
        // handle to the previous child: it does not send any signal, so
        // the old FA process kept running as an orphan. Confirmed live:
        // relaunching a replay left two `ForgedAlliance.exe` processes
        // alive simultaneously, apparently fighting over the same install's
        // shader cache/lock files: the previous process froze on a blank
        // post-shader-compile screen with zero further disk activity, no
        // crash, no error, exactly the reported hang. `start_kill()`
        // mirrors `ProcessPort::kill`'s own termination call.
        if let Some(mut prev) = self.child.lock().unwrap().replace(child) {
            let _ = prev.start_kill();
        }
        self.watch_for_exit();
        Ok(())
    }

    /// Poll the tracked child until it exits, then wake [`Self::wait_for_exit`].
    ///
    /// Polling rather than `Child::wait()` because `wait` needs `&mut Child`,
    /// and the handle has to stay in the shared slot for [`ProcessPort::kill`]
    /// to reach it. A game session lasts minutes, so a second of latency on
    /// noticing the exit costs nothing.
    fn watch_for_exit(&self) {
        let child = self.child.clone();
        let exited = self.exited.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(500)).await;
                let finished = {
                    let mut guard = child.lock().unwrap();
                    match guard.as_mut() {
                        // Taken by a newer launch or by `kill`: that launch owns
                        // its own watcher, so this one is done.
                        None => true,
                        Some(process) => match process.try_wait() {
                            Ok(Some(_status)) => {
                                *guard = None;
                                true
                            }
                            Ok(None) => false,
                            // The handle is unusable; treat it as gone rather
                            // than spinning on it forever.
                            Err(_) => {
                                *guard = None;
                                true
                            }
                        },
                    }
                };
                if finished {
                    exited.notify_waiters();
                    return;
                }
            }
        });
    }
}

#[async_trait]
impl ProcessPort for GameProcess {
    fn supports_live_launch(&self) -> bool {
        true
    }

    async fn launch_game(&self, params: GameLaunchParams) -> Result<(), String> {
        let path = self.config.lock().unwrap().game_path.clone();
        let log_path = crate::infra::game_logs::next_path("game", Some(params.game_id))?;

        // Started before the game, so the port in `/savereplay` is already
        // listening when FA connects to it. A recorder that cannot bind is not
        // a reason to refuse the launch: the game is playable, it just leaves no
        // replay behind, which is what happened on every launch before this.
        let recorder = match crate::infra::replay_recorder::ReplayRecorder::start(
            crate::infra::replay::local_replays_dir(),
            params.replay.clone(),
        )
        .await
        {
            Ok(recorder) => Some(recorder),
            Err(error) => {
                tracing::warn!(%error, "starting without replay recording");
                None
            }
        };
        let savereplay = recorder
            .as_ref()
            .map(|recorder| recorder.savereplay_url(params.game_id, &params.player_login));

        let result = self.spawn(
            &path,
            &build_arguments(&params, &log_path, savereplay.as_deref()),
            "game",
        );

        // Held for the game's lifetime: dropping the recorder aborts its
        // listener, and FA connects seconds after launch.
        if let Some(recorder) = recorder {
            *self.replay_recorder.lock().unwrap() = Some(recorder);
        }
        result
    }

    async fn launch_offline(&self, featured_mod: String, map: String) -> Result<(), String> {
        let path = self.config.lock().unwrap().game_path.clone();
        let log_path = crate::infra::game_logs::next_path("offline", None)?;
        self.spawn(
            &path,
            &offline_arguments(&featured_mod, &map, &log_path),
            "game",
        )
    }

    async fn launch_replay(&self, args: Vec<String>) -> Result<(), String> {
        let path = self.config.lock().unwrap().replay_game_path.clone();
        self.spawn(&path, &args, "replay")
    }

    fn kill(&self) {
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.start_kill();
        }
    }

    async fn wait_for_exit(&self) {
        self.exited.notified().await
    }

    fn set_paths(&self, game_path: String, replay_game_path: String) {
        let mut config = self.config.lock().unwrap();
        config.game_path = game_path;
        config.replay_game_path = replay_game_path;
    }

    fn set_additional_arguments(&self, arguments: Vec<String>) {
        self.config.lock().unwrap().additional_arguments = arguments;
    }

    fn game_install_dir(&self) -> Option<PathBuf> {
        managed_install_dir_of(&self.config.lock().unwrap().game_path)
    }

    fn installs_present(&self) -> InstallPresence {
        let config = self.config.lock().unwrap();
        let present = managed_executable_is_present;
        InstallPresence {
            game: present(&config.game_path),
            replay: present(&config.replay_game_path),
        }
    }

    fn install_path_is_present(&self, path: &str) -> bool {
        managed_executable_is_present(path)
    }

    fn discover_install_paths(&self) -> DiscoveredInstallPaths {
        discover_reference_install_paths()
    }
}

/// Locate the data roots used by the Java and Python clients, then select an
/// existing managed executable from them. Both reference clients store the
/// original Steam/retail directory separately; importing that directory here
/// would be unsafe because our updater derives its write target from the
/// configured executable.
fn discover_reference_install_paths() -> DiscoveredInstallPaths {
    let app_data = std::env::var_os("APPDATA").map(PathBuf::from);
    let program_data = std::env::var_os("PROGRAMDATA")
        .or_else(|| std::env::var_os("ALLUSERSPROFILE"))
        .map(PathBuf::from);

    let java_prefs = app_data
        .as_ref()
        .map(|root| root.join("Forged Alliance Forever").join("client.prefs"));
    let python_ini = app_data
        .as_ref()
        .map(|root| root.join("ForgedAllianceForever").join("FA Lobby.ini"));

    discover_from_reference_configs(
        java_prefs.as_deref(),
        python_ini.as_deref(),
        program_data.as_deref(),
    )
}

fn discover_from_reference_configs(
    java_prefs: Option<&Path>,
    python_ini: Option<&Path>,
    default_program_data: Option<&Path>,
) -> DiscoveredInstallPaths {
    let mut roots = Vec::new();
    if let Some(path) = java_prefs.and_then(java_data_root) {
        roots.push(path);
    }
    if let Some(path) = python_ini.and_then(python_data_root) {
        roots.push(path);
    }
    if let Some(path) = default_program_data {
        roots.push(path.join("FAForever"));
    }

    let mut seen = HashSet::new();
    roots.retain(|path| seen.insert(path.clone()));

    DiscoveredInstallPaths {
        game: newest_existing_executable(&roots, &["bin", MANAGED_EXE]),
        replay: newest_existing_executable(&roots, &["replaydata", "bin", MANAGED_EXE]),
    }
}

fn java_data_root(path: &Path) -> Option<PathBuf> {
    let text = read_small_text_file(path)?;
    let document: serde_json::Value = serde_json::from_str(&text).ok()?;
    document
        .pointer("/data/baseDataDirectory")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
}

fn python_data_root(path: &Path) -> Option<PathBuf> {
    let text = read_small_text_file(path)?;
    let mut section = "";

    for raw_line in text.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with(';') || line.starts_with('#') {
            continue;
        }
        if let Some(name) = line
            .strip_prefix('[')
            .and_then(|value| value.strip_suffix(']'))
        {
            section = name.trim();
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let is_data_path = (section.eq_ignore_ascii_case("client")
            && key.eq_ignore_ascii_case("data_path"))
            || key.eq_ignore_ascii_case("client/data_path")
            || key.eq_ignore_ascii_case(r"client\data_path");
        if !is_data_path {
            continue;
        }

        let value = value.trim().trim_matches('"').replace(r"\\", r"\");
        if !value.is_empty() {
            return Some(PathBuf::from(value));
        }
    }
    None
}

fn read_small_text_file(path: &Path) -> Option<String> {
    let file = File::open(path).ok()?;
    let mut bytes = Vec::new();
    file.take(MAX_REFERENCE_CONFIG_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > MAX_REFERENCE_CONFIG_BYTES {
        return None;
    }
    String::from_utf8(bytes).ok()
}

fn newest_existing_executable(roots: &[PathBuf], suffix: &[&str]) -> Option<String> {
    roots
        .iter()
        .map(|root| {
            suffix
                .iter()
                .fold(root.clone(), |path, part| path.join(part))
        })
        .filter(|path| path.is_file())
        .max_by_key(|path| {
            path.metadata()
                .and_then(|metadata| metadata.modified())
                .ok()
        })
        .map(|path| path.to_string_lossy().into_owned())
}

/// `…/FAForever/bin/ForgedAlliance.exe` → `…/FAForever`: two `parent()` calls
/// up from the executable, the same derivation `infra::replay` uses for the
/// replay install. The file itself need not exist: the updater's whole job is
/// to put it there: but the path must be shaped like an install, so a bare
/// `ForgedAlliance.exe` with no directories above it yields `None` rather than
/// an empty path that would patch into the working directory.
fn install_dir_of(exe_path: &str) -> Option<PathBuf> {
    if exe_path.is_empty() {
        return None;
    }
    PathBuf::from(exe_path)
        .parent()?
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .map(PathBuf::from)
}

fn managed_install_dir_of(exe_path: &str) -> Option<PathBuf> {
    let exe = Path::new(exe_path);
    let install_dir = install_dir_of(exe_path)?;
    (!is_original_game_executable(exe)).then_some(install_dir)
}

fn managed_executable_is_present(path: &str) -> bool {
    let exe = Path::new(path);
    exe.is_file() && managed_install_dir_of(path).is_some()
}

/// The reference clients validate an original FA root through its base archive.
/// Its executable has the same filename and `bin/` shape as the managed copy,
/// so checking only `ForgedAlliance.exe` cannot keep the updater out of Steam.
fn is_original_game_executable(exe: &Path) -> bool {
    install_dir_of(&exe.to_string_lossy())
        .is_some_and(|root| root.join("gamedata").join("lua.scd").is_file())
}

/// Build the FA argument list: server args first, then init/bugreport/gpgnet.
///
/// Mirrors `fa/play.py:build_argument_list`. `savereplay` is the address of the
/// local [`crate::infra::replay_recorder::ReplayRecorder`]; without it FA writes
/// no replay for a networked game at all, which is why played games used to
/// leave nothing in the local library.
fn build_arguments(
    params: &GameLaunchParams,
    log_path: &Path,
    savereplay: Option<&str>,
) -> Vec<String> {
    let mut args = params.args.clone();
    args.push("/init".into());
    args.push(format!("init_{}.lua", params.featured_mod));
    args.push("/nobugreport".into());
    if let Some(url) = savereplay {
        args.push("/savereplay".into());
        args.push(url.to_string());
    }
    args.push("/gpgnet".into());
    args.push(format!("127.0.0.1:{}", params.game_port));
    args.push("/log".into());
    args.push(log_path.display().to_string());
    args
}

/// The command line for a single-player launch.
///
/// Mirrors the Java client's `LaunchCommandBuilder` for `launchOfflineGame`:
/// the init script for the featured mod, no bug reporter, and the scenario to
/// load. Deliberately no `/gpgnet`: there is no adapter and no lobby.
fn offline_arguments(featured_mod: &str, map: &str, log_path: &Path) -> Vec<String> {
    vec![
        "/init".into(),
        format!("init_{featured_mod}.lua"),
        "/nobugreport".into(),
        "/map".into(),
        map.into(),
        "/log".into(),
        log_path.display().to_string(),
    ]
}

/// Inert game launcher: used offline and in tests. Launching is a no-op success.
#[derive(Debug, Clone, Default)]
pub struct FakeGame;

#[async_trait]
impl ProcessPort for FakeGame {
    fn supports_live_launch(&self) -> bool {
        false
    }

    async fn launch_game(&self, _params: GameLaunchParams) -> Result<(), String> {
        Ok(())
    }
    async fn launch_offline(&self, _featured_mod: String, _map: String) -> Result<(), String> {
        Ok(())
    }
    async fn launch_replay(&self, _args: Vec<String>) -> Result<(), String> {
        Ok(())
    }
    fn kill(&self) {}
    fn set_paths(&self, _game_path: String, _replay_game_path: String) {}

    fn set_additional_arguments(&self, _arguments: Vec<String>) {}

    fn game_install_dir(&self) -> Option<PathBuf> {
        None
    }

    /// Reports nothing installed: there is no real install behind this fake, and
    /// claiming otherwise would suppress the missing-install banner in exactly
    /// the offline mode where it is most accurate.
    fn installs_present(&self) -> InstallPresence {
        InstallPresence::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params() -> GameLaunchParams {
        GameLaunchParams {
            game_id: 99,
            game_port: 7237,
            init_mode: 0,
            featured_mod: "faf".into(),
            player_id: 1,
            player_login: "me".into(),
            args: vec!["/numgames".into(), "5".into()],
            replay: Default::default(),
        }
    }

    #[test]
    fn builds_fa_command_line_in_order() {
        let args = build_arguments(&params(), Path::new("diagnostics/game-99.log"), None);
        assert_eq!(
            &args[..7],
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
        assert_eq!(args[7], "/log");
        assert!(args[8].ends_with("game-99.log"));
    }

    #[test]
    fn savereplay_precedes_gpgnet_when_a_recorder_is_listening() {
        // Ordering matches `fa/play.py`, and the flag is what makes FA emit a
        // replay for a networked game at all: without it a played game leaves
        // nothing on disk, which is the bug this fixes.
        let url = "gpgnet://127.0.0.1:5000/99/me.SCFAreplay";
        let args = build_arguments(&params(), Path::new("diagnostics/game-99.log"), Some(url));
        let save = args.iter().position(|a| a == "/savereplay").unwrap();
        assert_eq!(args[save + 1], url);
        assert!(save < args.iter().position(|a| a == "/gpgnet").unwrap());
    }

    #[test]
    fn no_recorder_means_no_savereplay_flag() {
        // A recorder that could not bind must not leave FA streaming at a dead
        // port: the game is still perfectly playable without a replay.
        let args = build_arguments(&params(), Path::new("diagnostics/game-99.log"), None);
        assert!(!args.iter().any(|a| a == "/savereplay"));
    }

    #[test]
    fn an_unset_path_is_not_present_and_a_real_file_is() {
        let process = GameProcess::new(GameConfig::default());
        assert_eq!(process.installs_present(), InstallPresence::default());

        // The test binary itself is a file that certainly exists, which is all
        // `installs_present` checks. (`file!()` would be relative to the
        // workspace root, not the crate dir the test runs in.)
        let existing = std::env::current_exe().unwrap().display().to_string();
        process.set_paths(existing, String::new());
        assert_eq!(
            process.installs_present(),
            InstallPresence {
                game: true,
                replay: false
            }
        );
    }

    #[test]
    fn a_configured_but_missing_path_is_not_present() {
        // The case a persisted setting hits after the user moves or uninstalls
        // the game: a non-empty path that no longer resolves.
        let process = GameProcess::new(GameConfig {
            game_path: "definitely/not/here/ForgedAlliance.exe".into(),
            replay_game_path: String::new(),
            ..GameConfig::default()
        });
        assert!(!process.installs_present().game);
    }

    #[test]
    fn the_install_dir_is_two_levels_up_from_the_executable() {
        // `…/FAForever/bin/ForgedAlliance.exe` is where FAF puts the patched
        // engine; the file set the updater manages is rooted one level above
        // `bin/`.
        let process = GameProcess::new(GameConfig {
            game_path: "C:/games/FAForever/bin/ForgedAlliance.exe".into(),
            ..GameConfig::default()
        });
        assert_eq!(
            process.game_install_dir(),
            Some(PathBuf::from("C:/games/FAForever"))
        );
    }

    #[test]
    fn an_unconfigured_or_rootless_path_has_no_install_dir() {
        // Nothing configured yet, and a bare filename: the latter would
        // otherwise resolve to the empty path and patch into whatever
        // directory the client happens to be running from.
        for path in ["", "ForgedAlliance.exe", "bin/ForgedAlliance.exe"] {
            let process = GameProcess::new(GameConfig {
                game_path: path.into(),
                ..GameConfig::default()
            });
            assert_eq!(process.game_install_dir(), None, "for {path:?}");
        }
    }

    #[test]
    fn original_steam_install_is_not_a_managed_update_target() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("Supreme Commander Forged Alliance");
        let exe = root.join("bin").join(MANAGED_EXE);
        std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
        std::fs::create_dir_all(root.join("gamedata")).unwrap();
        std::fs::write(&exe, b"vanilla").unwrap();
        std::fs::write(root.join("gamedata").join("lua.scd"), b"base game").unwrap();

        let process = GameProcess::new(GameConfig {
            game_path: exe.to_string_lossy().into_owned(),
            ..GameConfig::default()
        });
        assert!(!process.installs_present().game);
        assert_eq!(process.game_install_dir(), None);
    }

    #[test]
    fn repointing_the_install_in_settings_moves_the_updates_target() {
        let process = GameProcess::new(GameConfig {
            game_path: "C:/old/bin/ForgedAlliance.exe".into(),
            ..GameConfig::default()
        });
        process.set_paths("C:/new/bin/ForgedAlliance.exe".into(), String::new());
        assert_eq!(
            process.game_install_dir(),
            Some(PathBuf::from("C:/new")),
            "the updater must follow the path the launcher will actually use"
        );
    }

    #[test]
    fn set_paths_replaces_both_paths() {
        let process = GameProcess::new(GameConfig {
            game_path: "old-game".into(),
            replay_game_path: "old-replay".into(),
            ..GameConfig::default()
        });
        process.set_paths("new-game".into(), "new-replay".into());
        let config = process.config.lock().unwrap();
        assert_eq!(config.game_path, "new-game");
        assert_eq!(config.replay_game_path, "new-replay");
    }

    #[test]
    fn changing_paths_preserves_additional_arguments() {
        let process = GameProcess::new(GameConfig::default());
        process.set_additional_arguments(vec!["/windowed".into()]);
        process.set_paths("new-game".into(), "new-replay".into());
        assert_eq!(
            process.config.lock().unwrap().additional_arguments,
            vec!["/windowed"]
        );
    }

    #[tokio::test]
    async fn launching_without_a_configured_install_points_at_settings() {
        let process = GameProcess::new(GameConfig::default());
        let error = process.launch_replay(vec![]).await.unwrap_err();
        assert!(error.contains("replay"), "names which install: {error}");
        assert!(
            error.contains("Settings"),
            "points somewhere useful: {error}"
        );
    }

    #[tokio::test]
    async fn launching_a_vanished_install_says_so() {
        let process = GameProcess::new(GameConfig {
            game_path: String::new(),
            replay_game_path: "definitely/not/here/ForgedAlliance.exe".into(),
            ..GameConfig::default()
        });
        let error = process.launch_replay(vec![]).await.unwrap_err();
        assert!(error.contains("no longer exists"), "{error}");
    }

    #[test]
    fn discovers_custom_java_managed_live_and_replay_installs() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("custom-faf-data");
        let live = data.join("bin").join(MANAGED_EXE);
        let replay = data.join("replaydata").join("bin").join(MANAGED_EXE);
        std::fs::create_dir_all(live.parent().unwrap()).unwrap();
        std::fs::create_dir_all(replay.parent().unwrap()).unwrap();
        std::fs::write(&live, b"live").unwrap();
        std::fs::write(&replay, b"replay").unwrap();

        let prefs = temp.path().join("client.prefs");
        std::fs::write(
            &prefs,
            serde_json::json!({ "data": { "baseDataDirectory": data } }).to_string(),
        )
        .unwrap();

        let found = discover_from_reference_configs(Some(&prefs), None, None);
        assert_eq!(found.game.as_deref(), live.to_str());
        assert_eq!(found.replay.as_deref(), replay.to_str());
    }

    #[test]
    fn discovers_python_custom_data_path_but_not_original_game_path() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("python-data");
        let live = data.join("bin").join(MANAGED_EXE);
        std::fs::create_dir_all(live.parent().unwrap()).unwrap();
        std::fs::write(&live, b"live").unwrap();

        let ini = temp.path().join("FA Lobby.ini");
        std::fs::write(
            &ini,
            format!(
                "[ForgedAlliance] debt=ignored\napp/path=C:/original-game\n[client]\ndata_path={}\n",
                data.display()
            ),
        )
        .unwrap();

        let found = discover_from_reference_configs(None, Some(&ini), None);
        assert_eq!(found.game.as_deref(), live.to_str());
        assert_eq!(found.replay, None);
    }
}
