//! Failure combinations: work called off part-way, batches that half fail, and
//! loaders that must try again after a failure but not after a success.
//!
//! Three groups, each about what is left behind when something does not go to
//! plan:
//!
//! - **Cancellation.** A replay launch and a map generation can both be called
//!   off from the overlay while a port is still busy. Cancel travels in the
//!   priority lane, so it must land while the slow work is still held, and
//!   what follows must be "back to idle" rather than an error: no launch after
//!   the fact, no failure notification, no generated map recorded, and the
//!   single-flight generator key free for the next run.
//! - **Partial failures.** Resolving replay maps, looking up live games and
//!   loading a party's league placements all ask about several things at
//!   once. One failed lookup must not take the answered ones down with it,
//!   and what is recorded for the failed ones decides whether they are asked
//!   about again.
//! - **Retries.** A loader with a "loaded once" rule must still try again
//!   after a failure, or a user who was offline for the first attempt keeps
//!   an empty tab for the rest of the session. The map vault and leaderboard
//!   catalogue have their own files (`map_vault_load.rs`,
//!   `leaderboard_catalog.rs`); the mod vault, the co-op catalogue and the
//!   events tab's tournament top-up are pinned here. The tournament list's own
//!   `Load`, the training library and the tutorials catalogue reload on every
//!   request by design, so they have no such rule to pin.
//!
//! Every port that has to be caught mid-call waits at a gate the test opens,
//! so the interleavings are exact rather than a matter of timing.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use faf_app::infra::{
    fake_ports, FakeCoop, FakeGame, FakeMapGenerator, FakeMods, FakePlayerCard, FakeReplay,
    FakeTourney,
};
use faf_app::ports::{
    CoopPort, GameLaunchParams, GeneratorUpdate, InstallPresence, MapGeneratorPort, ModPrepFailure,
    ModSearchPage, ModsPort, PlayerCardPort, PreparationPhase, PreparationSink, PreparationStep,
    ProcessPort, ReplayPlaybackPort, ReplayVaultPort, RequestError, TourneyReadPort,
    VaultSearchResult,
};
use faf_app::{App, Ports};
use faf_domain::protocol::vault_query::ModVaultQuery;
use faf_domain::state::replays::{OnlineLookup, ReplayDownloadStatus};
use faf_domain::state::settings::GamePreferencesPatch;
use faf_domain::state::{
    CoopCommand, CoopMission, CoopResult, CoopScenario, CoopStatus, CopySource, EntrantRatings,
    EventsCommand, GeneratorOptionQuery, GeneratorOptions, GeneratorPreset, GeneratorStatus,
    InstalledMod, LiveReplayTarget, LiveReplayTrackingAction, LocalReplay, MapGeneratorCommand,
    MatchmakerPlayerProfile, ModDownloadSize, ModDownloadTarget, ModListStatus, ModsCommand,
    PlayerCardCommand, PlayerCardProfile, PlayerLeaguePlacement, PlayerMapStats, PlayerSummary,
    RatingCheck, RatingHistoryPage, RatingHistoryQuery, RenameCheck, ReplayCommand, ReplayQuery,
    ReplayStatus, SeriesDetail, SettingsCommand, Tourney, TourneyPreset, TourneySeries, VaultMod,
    VaultReplay,
};
use faf_domain::AppCommand;
use tokio::sync::{mpsc, watch, Semaphore};
use tokio::task::JoinHandle;

/// How long anything that should happen promptly gets before the test calls
/// it a hang. A safety net only: nothing here waits this long when it passes.
const PROMPTLY: Duration = Duration::from_secs(5);

// ── Shared helpers ──────────────────────────────────────────────────────────

/// One held-open call.
struct Gate {
    entered: AtomicBool,
    open: Semaphore,
}

/// Closed until released: the semaphore starts with no permits.
impl Default for Gate {
    fn default() -> Self {
        Self {
            entered: AtomicBool::new(false),
            open: Semaphore::new(0),
        }
    }
}

/// Port calls that wait until the test lets them through. A permit released
/// before anybody waits is kept, so a gate can be opened in advance.
#[derive(Default, Clone)]
struct Gates(Arc<Mutex<HashMap<String, Arc<Gate>>>>);

impl Gates {
    fn gate(&self, key: &str) -> Arc<Gate> {
        self.0
            .lock()
            .expect("gates poisoned")
            .entry(key.to_string())
            .or_default()
            .clone()
    }

    /// Called by a port: record the call, then wait to be let through.
    async fn pass(&self, key: &str) {
        let gate = self.gate(key);
        gate.entered.store(true, Ordering::SeqCst);
        gate.open.acquire().await.expect("gate closed").forget();
    }

    fn release(&self, key: &str) {
        self.gate(key).open.add_permits(1);
    }

    fn entered(&self, key: &str) -> bool {
        self.gate(key).entered.load(Ordering::SeqCst)
    }

    /// Wait until a port call for `key` is in flight.
    async fn wait_entered(&self, key: &str) {
        for _ in 0..1000 {
            if self.entered(key) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("no port call for {key} arrived");
    }
}

fn start(ports: Ports) -> Arc<App> {
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());
    Arc::new(app)
}

/// Dispatch without blocking the test, and hand back the command's completion.
fn spawn_command(app: &Arc<App>, command: AppCommand) -> JoinHandle<()> {
    let app = app.clone();
    tokio::spawn(async move {
        app.dispatch_and_wait(command)
            .await
            .expect("command completes");
    })
}

/// Run a command to completion, failing the test if it does not finish
/// promptly. Used for the priority-lane cancels, whose whole point is not to
/// wait behind the work they cancel.
async fn run_promptly(app: &App, command: AppCommand, what: &str) {
    tokio::time::timeout(PROMPTLY, app.dispatch_and_wait(command))
        .await
        .unwrap_or_else(|_| panic!("{what} did not complete while the work was held"))
        .expect("command completes");
}

/// Wait for a spawned command, failing the test if it hangs.
async fn finished(handle: JoinHandle<()>, what: &str) {
    tokio::time::timeout(PROMPTLY, handle)
        .await
        .unwrap_or_else(|_| panic!("{what} never finished"))
        .expect("command task panicked");
}

/// The titles of every notification raised so far.
fn notification_titles(app: &App) -> Vec<String> {
    app.snapshot()
        .notifications
        .items
        .into_iter()
        .map(|notification| notification.title)
        .collect()
}

// ── Cancelling a replay launch ──────────────────────────────────────────────

/// Counts replay launches, which is the one thing a cancelled start must
/// never reach. Everything else is the offline game.
#[derive(Default)]
struct RecordingProcess {
    replay_launches: AtomicUsize,
}

#[async_trait]
impl ProcessPort for RecordingProcess {
    fn supports_live_launch(&self) -> bool {
        FakeGame.supports_live_launch()
    }
    async fn launch_game(&self, params: GameLaunchParams) -> Result<(), String> {
        FakeGame.launch_game(params).await
    }
    async fn launch_offline(&self, featured_mod: String, map: String) -> Result<(), String> {
        FakeGame.launch_offline(featured_mod, map).await
    }
    async fn launch_replay(&self, _args: Vec<String>) -> Result<(), String> {
        self.replay_launches.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    fn kill(&self) {
        FakeGame.kill()
    }
    fn set_paths(&self, game_path: String, replay_game_path: String) {
        FakeGame.set_paths(game_path, replay_game_path)
    }
    fn set_additional_arguments(&self, arguments: Vec<String>) {
        FakeGame.set_additional_arguments(arguments)
    }
    fn game_install_dir(&self) -> Option<PathBuf> {
        FakeGame.game_install_dir()
    }
    fn replay_install_dir(&self) -> Option<PathBuf> {
        FakeGame.replay_install_dir()
    }
    fn installs_present(&self) -> InstallPresence {
        FakeGame.installs_present()
    }
}

/// A vault replay launch in its real order: download the file (held at the
/// `download` gate), prepare the install while reporting a step (held at the
/// `prepare` gate), then hand the file to FA through the process port, the
/// way the real playback does.
struct GatedPlayback {
    gates: Gates,
    process: Arc<RecordingProcess>,
    progress: Mutex<Option<PreparationSink>>,
}

#[async_trait]
impl ReplayPlaybackPort for GatedPlayback {
    async fn watch_live(
        &self,
        target: LiveReplayTarget,
        player: String,
    ) -> Result<Option<String>, String> {
        FakeReplay.watch_live(target, player).await
    }

    async fn play_file(&self, path: PathBuf) -> Result<Option<String>, String> {
        FakeReplay.play_file(path).await
    }

    async fn watch_vault(&self, uid: i32) -> Result<Option<String>, String> {
        self.gates.pass("download").await;
        let progress = self.progress.lock().unwrap().clone();
        if let Some(report) = progress {
            report(PreparationStep::indeterminate(
                PreparationPhase::Downloading,
                format!("engine build for {uid}"),
            ));
        }
        self.gates.pass("prepare").await;
        self.process
            .launch_replay(vec!["/replay".into(), format!("{uid}.fafreplay")])
            .await?;
        Ok(None)
    }

    fn set_install_dir(&self, _dir: Option<PathBuf>) {}

    fn set_preparation_progress(&self, sink: Option<PreparationSink>) {
        *self.progress.lock().unwrap() = sink;
    }
}

struct ReplayHarness {
    app: Arc<App>,
    gates: Gates,
    process: Arc<RecordingProcess>,
}

fn replay_harness() -> ReplayHarness {
    let gates = Gates::default();
    let process = Arc::new(RecordingProcess::default());
    let app = start(Ports {
        replay_playback: Arc::new(GatedPlayback {
            gates: gates.clone(),
            process: process.clone(),
            progress: Mutex::new(None),
        }),
        process: process.clone(),
        ..fake_ports()
    });
    ReplayHarness {
        app,
        gates,
        process,
    }
}

const REPLAY: i32 = 4242;

/// Start watching a vault replay, call it off once the launch is held at
/// `stage`, then open every gate and check that nothing the cancel stopped
/// comes back.
async fn cancel_watch_held_at(stage: &str) {
    let h = replay_harness();
    if stage == "prepare" {
        h.gates.release("download");
    }
    let watch = spawn_command(&h.app, ReplayCommand::WatchVault { uid: REPLAY }.into());
    h.gates.wait_entered(stage).await;
    assert_eq!(h.app.snapshot().replays.status, ReplayStatus::Connecting);

    // Priority lane: done while the launch is still held, not queued behind it.
    run_promptly(&h.app, ReplayCommand::CancelWatch.into(), "CancelWatch").await;
    // The launch's own command ends with the cancel, gates still shut: its
    // future was dropped rather than left waiting.
    finished(watch, "the cancelled WatchVault").await;

    let replays = h.app.snapshot().replays;
    assert_eq!(
        replays.status,
        ReplayStatus::Idle,
        "a cancelled start is idle, not failed and not still connecting"
    );
    assert_eq!(replays.download_status, ReplayDownloadStatus::Idle);
    assert_eq!(
        replays.preparing, None,
        "no preparation step left on screen"
    );

    // Opening the gates now would let a launch through if anything were still
    // waiting on them. A short pause gives it the chance to (wrongly) happen.
    h.gates.release("download");
    h.gates.release("prepare");
    tokio::time::sleep(Duration::from_millis(50)).await;

    assert_eq!(
        h.process.replay_launches.load(Ordering::SeqCst),
        0,
        "a cancelled replay must never be handed to FA"
    );
    if stage == "download" {
        assert!(
            !h.gates.entered("prepare"),
            "preparation must not start after the download was called off"
        );
    }
    assert_eq!(h.app.snapshot().replays.status, ReplayStatus::Idle);
    assert!(
        !notification_titles(&h.app).contains(&"Replay failed".to_string()),
        "calling a launch off is not a failure"
    );
}

/// Cancel pressed while the replay file is still downloading: the cancel lands
/// at once, the download's continuation never runs, and FA is never started.
#[tokio::test]
async fn cancelling_a_replay_mid_download_never_launches_it() {
    cancel_watch_held_at("download").await;
}

/// Cancel pressed after the download, while the install is being prepared for
/// the replay: same outcome, and the preparation progress is cleared with it.
#[tokio::test]
async fn cancelling_a_replay_during_preparation_never_launches_it() {
    cancel_watch_held_at("prepare").await;
}

/// Once the port has handed the replay to FA there is nothing left to call
/// off: a late Cancel loses the race and must not idle a replay that is
/// playing.
#[tokio::test]
async fn a_cancel_after_the_replay_launched_leaves_it_playing() {
    let h = replay_harness();
    h.gates.release("download");
    h.gates.release("prepare");

    h.app
        .dispatch_and_wait(ReplayCommand::WatchVault { uid: REPLAY }.into())
        .await
        .unwrap();
    assert_eq!(
        h.app.snapshot().replays.status,
        ReplayStatus::Playing { uid: Some(REPLAY) }
    );

    run_promptly(&h.app, ReplayCommand::CancelWatch.into(), "CancelWatch").await;

    assert_eq!(
        h.app.snapshot().replays.status,
        ReplayStatus::Playing { uid: Some(REPLAY) },
        "a replay already playing is not cancelled"
    );
    assert_eq!(h.process.replay_launches.load(Ordering::SeqCst), 1);
}

/// A second replay started while the first is still downloading replaces it.
/// The first is cancelled by the second, and settles only after the second
/// has started. It used to settle as if it were still the current launch:
/// clearing the second's progress sink and emitting `Closed`, which idled the
/// starting dialog of the replay that was actually on its way.
#[tokio::test]
async fn a_replaced_replay_launch_leaves_its_replacement_starting() {
    const REPLACEMENT: i32 = REPLAY + 1;
    let h = replay_harness();

    let replaced = spawn_command(&h.app, ReplayCommand::WatchVault { uid: REPLAY }.into());
    h.gates.wait_entered("download").await;

    // Only the replacement can cancel the first launch, so once the first
    // command has finished the replacement has started, and the first
    // settled after it.
    let replacement = spawn_command(
        &h.app,
        ReplayCommand::WatchVault { uid: REPLACEMENT }.into(),
    );
    finished(replaced, "the replaced WatchVault").await;
    let replays = h.app.snapshot().replays;
    assert_eq!(
        replays.status,
        ReplayStatus::Connecting,
        "the replaced launch idled the one that replaced it"
    );
    // A watch's download is a step of its launch, narrated through
    // `preparing`; it never marks the library download's status.
    assert_eq!(replays.download_status, ReplayDownloadStatus::Idle);

    // The replacement's own preparation still reaches its dialog.
    h.gates.release("download");
    h.gates.wait_entered("prepare").await;
    let preparing = h.app.snapshot().replays.preparing;
    assert_eq!(
        preparing.map(|step| step.detail),
        Some(format!("engine build for {REPLACEMENT}")),
        "the replaced launch took the replacement's progress sink with it"
    );

    h.gates.release("prepare");
    finished(replacement, "the replacement WatchVault").await;
    assert_eq!(
        h.app.snapshot().replays.status,
        ReplayStatus::Playing {
            uid: Some(REPLACEMENT)
        }
    );
    assert_eq!(h.process.replay_launches.load(Ordering::SeqCst), 1);
    assert!(!notification_titles(&h.app).contains(&"Replay failed".to_string()));
}

/// Watch pressed twice on the same replay while it is starting: a double
/// click, or the card's Watch and then the panel's. The second is the same
/// request and is dropped. It used to replace the first launch with itself,
/// throwing away the download in progress and starting it again.
#[tokio::test]
async fn watching_a_replay_that_is_already_starting_changes_nothing() {
    let h = replay_harness();

    let first = spawn_command(&h.app, ReplayCommand::WatchVault { uid: REPLAY }.into());
    h.gates.wait_entered("download").await;

    // Returns at once rather than waiting at the download gate itself.
    run_promptly(
        &h.app,
        ReplayCommand::WatchVault { uid: REPLAY }.into(),
        "the repeated WatchVault",
    )
    .await;
    let replays = h.app.snapshot().replays;
    assert_eq!(replays.status, ReplayStatus::Connecting);
    assert_eq!(replays.download_status, ReplayDownloadStatus::Idle);

    h.gates.release("download");
    h.gates.release("prepare");
    finished(first, "the first WatchVault").await;
    assert_eq!(
        h.app.snapshot().replays.status,
        ReplayStatus::Playing { uid: Some(REPLAY) }
    );
    assert_eq!(h.process.replay_launches.load(Ordering::SeqCst), 1);
}

/// A live replay refused before it became a launch, here a game whose start
/// is unknown, while another replay is starting. The refusal is reported, but
/// it owns no launch: the starting replay keeps its dialog and still plays.
#[tokio::test]
async fn a_refused_live_replay_leaves_a_starting_replay_alone() {
    let h = replay_harness();

    let starting = spawn_command(&h.app, ReplayCommand::WatchVault { uid: REPLAY }.into());
    h.gates.wait_entered("download").await;

    run_promptly(
        &h.app,
        ReplayCommand::TrackLive {
            target: LiveReplayTarget {
                uid: 999_999,
                mod_name: "faf".into(),
                map: "scmp_009".into(),
            },
            action: LiveReplayTrackingAction::Watch,
        }
        .into(),
        "the refused TrackLive",
    )
    .await;
    assert_eq!(
        h.app.snapshot().replays.status,
        ReplayStatus::Connecting,
        "a refusal that started nothing closed the dialog of a replay that is starting"
    );
    assert!(
        notification_titles(&h.app).contains(&"Replay failed".to_string()),
        "the refusal itself is still reported"
    );

    h.gates.release("download");
    h.gates.release("prepare");
    finished(starting, "the starting WatchVault").await;
    assert_eq!(
        h.app.snapshot().replays.status,
        ReplayStatus::Playing { uid: Some(REPLAY) }
    );
}

/// The `reason` parameter of every "Replay failed" notification raised so far,
/// with the body it went out with.
fn replay_failure_reasons(app: &App) -> Vec<(Option<String>, String)> {
    app.snapshot()
        .notifications
        .items
        .into_iter()
        .filter(|notification| notification.title == "Replay failed")
        .map(|notification| {
            let text = notification
                .text
                .expect("the failure names its catalogue entry");
            assert_eq!(text.key, "notifications.msg.replayFailed");
            (text.params.get("reason").cloned(), notification.body)
        })
        .collect()
}

/// A replay that did not start hands its reason to the notification view as
/// the entry's `reason`, both when it owns the launch and when another replay
/// is starting. The parameter is what tells the view the body is the client's
/// own reason, to be said plainly; without it the raw English was the body.
#[tokio::test]
async fn a_replay_that_did_not_start_hands_its_reason_to_the_notification_view() {
    let h = replay_harness();
    let unknown_game = || -> AppCommand {
        ReplayCommand::TrackLive {
            target: LiveReplayTarget {
                uid: 999_999,
                mod_name: "faf".into(),
                map: "scmp_009".into(),
            },
            action: LiveReplayTrackingAction::Watch,
        }
        .into()
    };

    // Nothing else starting: the refusal is the replay's failure.
    run_promptly(&h.app, unknown_game(), "the refused TrackLive").await;
    // Another replay starting: the refusal is only reported.
    let starting = spawn_command(&h.app, ReplayCommand::WatchVault { uid: REPLAY }.into());
    h.gates.wait_entered("download").await;
    run_promptly(&h.app, unknown_game(), "the refused TrackLive").await;

    let reasons = replay_failure_reasons(&h.app);
    assert_eq!(reasons.len(), 2, "{reasons:?}");
    for (reason, body) in reasons {
        assert_eq!(reason.as_deref(), Some(body.as_str()));
    }

    h.gates.release("download");
    h.gates.release("prepare");
    finished(starting, "the starting WatchVault").await;
}

// ── Cancelling a map generation ─────────────────────────────────────────────

/// A generator that behaves like `NeroxisMapGenerator` where cancellation is
/// concerned: `cancel` raises a flag, a run in flight stops when it sees it
/// and reports `Cancelled`, and starting a run clears the flag, because a
/// stale cancellation must not stop the run that follows it.
///
/// A run reports `Generating`, then waits at the `run` gate before reporting
/// the map it made. The preflight waits at the `preflight` gate when
/// `hold_preflight` is set.
struct GatedGenerator {
    gates: Gates,
    hold_preflight: bool,
    /// The preflight refuses the options, as a failed generator download or
    /// a Java that cannot start would.
    refuse_preflight: AtomicBool,
    /// The preflight answers with no name, as a release older than `--parse`
    /// does.
    nameless_preflight: AtomicBool,
    cancel: watch::Sender<bool>,
    cancels: AtomicUsize,
    runs: AtomicUsize,
    previews: AtomicUsize,
}

impl GatedGenerator {
    fn new(gates: Gates, hold_preflight: bool) -> Self {
        Self {
            gates,
            hold_preflight,
            refuse_preflight: AtomicBool::new(false),
            nameless_preflight: AtomicBool::new(false),
            cancel: watch::channel(false).0,
            cancels: AtomicUsize::new(0),
            runs: AtomicUsize::new(0),
            previews: AtomicUsize::new(0),
        }
    }

    fn start_run(&self, map_name: String) -> mpsc::Receiver<GeneratorUpdate> {
        self.runs.fetch_add(1, Ordering::SeqCst);
        self.cancel.send_replace(false);
        let mut cancelled = self.cancel.subscribe();
        let gates = self.gates.clone();
        let (tx, rx) = mpsc::channel(8);
        tokio::spawn(async move {
            let _ = tx
                .send(GeneratorUpdate::Status(GeneratorStatus::Generating {
                    version: "1.7.7".into(),
                    detail: "placing mexes".into(),
                }))
                .await;
            let outcome = tokio::select! {
                () = gates.pass("run") => GeneratorStatus::Generated {
                    maps: vec![map_name],
                },
                _ = cancelled.wait_for(|raised| *raised) => GeneratorStatus::Cancelled,
            };
            let _ = tx.send(GeneratorUpdate::Status(outcome)).await;
        });
        rx
    }
}

const GENERATED_MAP: &str = "neroxis_map_generator_1.7.7_gated";

#[async_trait]
impl MapGeneratorPort for GatedGenerator {
    async fn generate_named(&self, map_name: String) -> mpsc::Receiver<GeneratorUpdate> {
        self.start_run(map_name)
    }

    async fn generate(&self, _options: GeneratorOptions) -> mpsc::Receiver<GeneratorUpdate> {
        self.start_run(GENERATED_MAP.into())
    }

    async fn query_options(
        &self,
        query: GeneratorOptionQuery,
        version: Option<String>,
        progress: Option<mpsc::Sender<GeneratorUpdate>>,
    ) -> Result<Vec<String>, String> {
        FakeMapGenerator
            .query_options(query, version, progress)
            .await
    }

    async fn preflight(&self, _options: GeneratorOptions) -> Result<String, String> {
        if self.hold_preflight {
            self.gates.pass("preflight").await;
        }
        if self.refuse_preflight.load(Ordering::SeqCst) {
            return Err("could not download the map generator".into());
        }
        if self.nameless_preflight.load(Ordering::SeqCst) {
            return Ok(String::new());
        }
        Ok(GENERATED_MAP.into())
    }

    async fn help(&self, version: Option<String>) -> Result<String, String> {
        FakeMapGenerator.help(version).await
    }

    fn cancel(&self) {
        self.cancels.fetch_add(1, Ordering::SeqCst);
        self.cancel.send_replace(true);
    }

    async fn save_preset(&self, name: &str, options: &GeneratorOptions) -> Result<(), String> {
        FakeMapGenerator.save_preset(name, options).await
    }

    async fn list_presets(&self) -> Vec<GeneratorPreset> {
        FakeMapGenerator.list_presets().await
    }

    async fn delete_preset(&self, name: &str) -> Result<(), String> {
        FakeMapGenerator.delete_preset(name).await
    }

    async fn latest_version(&self) -> Result<String, String> {
        FakeMapGenerator.latest_version().await
    }

    async fn available_versions(&self) -> Result<Vec<String>, String> {
        FakeMapGenerator.available_versions().await
    }

    fn is_installed(&self, _map_name: &str) -> bool {
        false
    }

    async fn clean_up(&self, protected_maps: &[String]) -> Result<usize, String> {
        FakeMapGenerator.clean_up(protected_maps).await
    }

    /// Asked for once per finished run, so it counts maps being recorded.
    async fn map_previews(&self, _map_names: &[String]) -> HashMap<String, String> {
        self.previews.fetch_add(1, Ordering::SeqCst);
        HashMap::new()
    }
}

/// An app on the gated generator, with "keep generated maps" switched on so a
/// recorded map would show up in the keep list.
async fn generator_harness(hold_preflight: bool) -> (Arc<App>, Gates, Arc<GatedGenerator>) {
    let gates = Gates::default();
    let generator = Arc::new(GatedGenerator::new(gates.clone(), hold_preflight));
    let app = start(Ports {
        map_generator: generator.clone(),
        ..fake_ports()
    });
    app.dispatch_and_wait(
        SettingsCommand::PatchGame {
            patch: Box::new(GamePreferencesPatch {
                keep_generated_maps: Some(true),
                ..GamePreferencesPatch::default()
            }),
        }
        .into(),
    )
    .await
    .unwrap();
    (app, gates, generator)
}

fn generate() -> AppCommand {
    MapGeneratorCommand::Generate {
        options: GeneratorOptions::default(),
    }
    .into()
}

/// What a cancelled run must leave behind: a cancelled status, no failure
/// reported, no map recorded, and a generator that takes the next run.
async fn assert_cancelled_cleanly(app: &Arc<App>, gates: &Gates, generator: &GatedGenerator) {
    assert_eq!(
        app.snapshot().map_generator.status,
        GeneratorStatus::Cancelled,
        "a cancelled run is cancelled, not failed and not generated"
    );
    let titles = notification_titles(app);
    assert!(
        !titles.iter().any(|title| title == "Map generation failed"),
        "calling a run off is not a failure: {titles:?}"
    );
    assert!(
        !titles.iter().any(|title| title == "Map ready"),
        "a cancelled run did not produce a map: {titles:?}"
    );
    assert_eq!(
        generator.previews.load(Ordering::SeqCst),
        0,
        "no map from a cancelled run is recorded"
    );
    assert!(
        app.snapshot().settings.kept_generated_maps.is_empty(),
        "no map from a cancelled run is kept"
    );

    // The single-flight key is free again: a new run is accepted and finishes.
    let runs_before = generator.runs.load(Ordering::SeqCst);
    gates.release("preflight");
    gates.release("run");
    tokio::time::timeout(PROMPTLY, app.dispatch_and_wait(generate()))
        .await
        .expect("the next Generate finishes")
        .unwrap();
    assert_eq!(
        generator.runs.load(Ordering::SeqCst),
        runs_before + 1,
        "the next Generate must run rather than be dropped as a duplicate"
    );
    assert_eq!(
        app.snapshot().map_generator.status,
        GeneratorStatus::Generated {
            maps: vec![GENERATED_MAP.into()]
        }
    );
    assert_eq!(generator.previews.load(Ordering::SeqCst), 1);
}

/// Cancel pressed while a generation is running reaches the port at once,
/// and the run ends cancelled with nothing recorded and the generator free.
#[tokio::test]
async fn cancelling_a_map_generation_mid_run_ends_cancelled_and_frees_the_generator() {
    let (app, gates, generator) = generator_harness(false).await;

    let run = spawn_command(&app, generate());
    gates.wait_entered("run").await;

    run_promptly(&app, MapGeneratorCommand::Cancel.into(), "Cancel").await;
    assert_eq!(
        generator.cancels.load(Ordering::SeqCst),
        1,
        "Cancel reaches the port while the run is in flight"
    );
    finished(run, "the cancelled Generate").await;

    assert_cancelled_cleanly(&app, &gates, &generator).await;
}

/// The lobby-join path, reproducing a map by name, cancels the same way.
#[tokio::test]
async fn cancelling_a_named_reproduction_mid_run_ends_cancelled() {
    let (app, gates, generator) = generator_harness(false).await;

    let run = spawn_command(
        &app,
        MapGeneratorCommand::GenerateNamed {
            map_name: "neroxis_map_generator_1.7.7_named".into(),
        }
        .into(),
    );
    gates.wait_entered("run").await;

    run_promptly(&app, MapGeneratorCommand::Cancel.into(), "Cancel").await;
    finished(run, "the cancelled GenerateNamed").await;

    assert_cancelled_cleanly(&app, &gates, &generator).await;
}

/// Cancel pressed while the options are still being checked, before any run
/// exists. The dialog offers Cancel then (the status is already `Preparing`),
/// and the preflight can take a JVM start and a first-time generator download.
///
/// The port only stops a run in flight, and starting a run clears any earlier
/// cancellation, so a service that went straight on to `generate` after the
/// preflight lost this Cancel and generated the map anyway.
#[tokio::test]
async fn cancelling_during_the_preflight_stops_the_run_before_it_starts() {
    let (app, gates, generator) = generator_harness(true).await;
    // Open in advance, so a run that wrongly starts finishes instead of
    // hanging the test.
    gates.release("run");

    let run = spawn_command(&app, generate());
    gates.wait_entered("preflight").await;

    run_promptly(&app, MapGeneratorCommand::Cancel.into(), "Cancel").await;
    gates.release("preflight");
    finished(run, "the cancelled Generate").await;

    assert_eq!(
        generator.runs.load(Ordering::SeqCst),
        0,
        "a run cancelled during its preflight must never start"
    );
    // The `run` permit released above is still there, so the follow-up run in
    // here needs only the one it adds; take the spare back first.
    gates
        .gate("run")
        .open
        .try_acquire()
        .expect("the spare run permit is unused")
        .forget();
    assert_cancelled_cleanly(&app, &gates, &generator).await;
}

/// The same Cancel, when the preflight then fails (the generator download or
/// the Java start). The run was already called off, so the failure answers a
/// question nobody is asking any more: it must not turn `Cancelled` into
/// `Failed` or raise an error notification.
#[tokio::test]
async fn a_preflight_failing_after_a_cancel_stays_cancelled() {
    let (app, gates, generator) = generator_harness(true).await;
    generator.refuse_preflight.store(true, Ordering::SeqCst);

    let run = spawn_command(&app, generate());
    gates.wait_entered("preflight").await;

    run_promptly(&app, MapGeneratorCommand::Cancel.into(), "Cancel").await;
    gates.release("preflight");
    finished(run, "the cancelled Generate").await;

    assert_eq!(
        app.snapshot().map_generator.status,
        GeneratorStatus::Cancelled,
        "a run called off during its preflight is cancelled, whatever the preflight said"
    );
    let titles = notification_titles(&app);
    assert!(
        !titles
            .iter()
            .any(|title| title == "Those options will not generate"),
        "no error for a run the user already called off: {titles:?}"
    );
    assert_eq!(generator.runs.load(Ordering::SeqCst), 0);

    // And the generator is free for the next run, which reports its own
    // refusal as usual.
    gates.release("preflight");
    tokio::time::timeout(PROMPTLY, app.dispatch_and_wait(generate()))
        .await
        .expect("the next Generate finishes")
        .unwrap();
    assert!(matches!(
        app.snapshot().map_generator.status,
        GeneratorStatus::Failed { .. }
    ));
    assert!(notification_titles(&app)
        .iter()
        .any(|title| title == "Those options will not generate"));
}

/// A refused run's notification names its catalogue entry and hands over the
/// generator's reason as that entry's `reason`. The parameter is what tells
/// the notification view the body is the client's own failure reason, to be
/// said plainly with the original on hover; without it the view showed the
/// raw reason as the whole body, in English, under an English title.
#[tokio::test]
async fn a_refused_run_hands_its_reason_to_the_notification_view() {
    let (app, _gates, generator) = generator_harness(false).await;
    generator.refuse_preflight.store(true, Ordering::SeqCst);

    tokio::time::timeout(PROMPTLY, app.dispatch_and_wait(generate()))
        .await
        .expect("the refused Generate finishes")
        .unwrap();

    let refusal = app
        .snapshot()
        .notifications
        .items
        .into_iter()
        .find(|notification| notification.title == "Those options will not generate")
        .expect("the refusal is reported");
    let text = refusal.text.expect("the refusal names its catalogue entry");
    assert_eq!(text.key, "notifications.msg.mapOptionsRejected");
    assert_eq!(
        text.params.get("reason").map(String::as_str),
        Some("could not download the map generator")
    );
    // The English body stays the reason as it was, for the OS notification
    // and for anything that reads it raw.
    assert_eq!(refusal.body, "could not download the map generator");
}

/// A release too old to work a name out says so under a catalogue entry,
/// with the release it needs as a parameter, so the notice reads in the
/// user's language. It had no entry, and stayed English.
#[tokio::test]
async fn a_generator_that_cannot_resolve_a_name_names_the_release_that_can() {
    let (app, _gates, generator) = generator_harness(false).await;
    generator.nameless_preflight.store(true, Ordering::SeqCst);

    tokio::time::timeout(
        PROMPTLY,
        app.dispatch_and_wait(
            MapGeneratorCommand::Preflight {
                options: GeneratorOptions::default(),
            }
            .into(),
        ),
    )
    .await
    .expect("the preflight finishes")
    .unwrap();

    let notice = app
        .snapshot()
        .notifications
        .items
        .into_iter()
        .find(|notification| notification.title == "This generator cannot resolve a name")
        .expect("the notice is raised");
    let text = notice.text.expect("the notice names its catalogue entry");
    assert_eq!(text.key, "notifications.msg.generatorCannotParse");
    let version = text.params.get("version").expect("the release it needs");
    assert!(
        notice
            .body
            .contains(&format!("generator {version} or newer")),
        "{}",
        notice.body
    );
}

// ── Partial failures: replay maps ───────────────────────────────────────────

/// Reads a map name out of a replay head: games divisible by three cannot be
/// read, game 4's head names no map, and the rest name `map_<uid>`.
struct PartlyReadableHeads;

#[async_trait]
impl ReplayVaultPort for PartlyReadableHeads {
    async fn search_vault(&self, query: ReplayQuery) -> Result<VaultSearchResult, String> {
        FakeReplay.search_vault(query).await
    }
    async fn list_featured_mods(&self) -> Result<Vec<String>, String> {
        FakeReplay.list_featured_mods().await
    }
    async fn download_vault(&self, uid: i32) -> Result<LocalReplay, String> {
        FakeReplay.download_vault(uid).await
    }
    async fn replay_map_name(&self, uid: i32) -> Result<Option<String>, String> {
        match uid {
            uid if uid % 3 == 0 => Err(format!("replay {uid} is not on the host")),
            4 => Ok(None),
            uid => Ok(Some(format!("map_{uid}"))),
        }
    }
}

/// Resolving a page of replay maps where some heads cannot be read: every
/// game still gets an answer, the readable ones their map and the failed ones
/// an empty "not known", so the view stops asking about them. The failures
/// sit in both batches of six, and the second batch is still asked.
#[tokio::test]
async fn resolving_replay_maps_records_every_game_when_some_lookups_fail() {
    let app = start(Ports {
        replay_vault: Arc::new(PartlyReadableHeads),
        ..fake_ports()
    });
    let uids: Vec<i32> = (1..=9).collect();

    app.dispatch_and_wait(ReplayCommand::ResolveMaps { uids }.into())
        .await
        .unwrap();

    let resolved = app.snapshot().replays.resolved_maps;
    let expected: HashMap<i32, String> = [
        (1, "map_1"),
        (2, "map_2"),
        (3, ""),
        (4, ""),
        (5, "map_5"),
        (6, ""),
        (7, "map_7"),
        (8, "map_8"),
        (9, ""),
    ]
    .into_iter()
    .map(|(uid, map)| (uid, map.to_string()))
    .collect();
    assert_eq!(resolved, expected);
}

// ── Partial failures: live game lookups ─────────────────────────────────────

/// A game row the vault answers with.
fn vault_row(uid: i32) -> VaultReplay {
    VaultReplay {
        uid,
        title: format!("game {uid}"),
        map: String::new(),
        map_thumbnail_url: String::new(),
        mod_name: "faf".into(),
        start_time: String::new(),
        end_time: String::new(),
        replay_available: false,
        duration_seconds: None,
        game_duration_seconds: None,
        teams: Vec::new(),
        average_rating: None,
        quality: None,
        reviews_average: None,
        reviews_count: None,
        game_version: None,
        validity: String::new(),
        victory_condition: String::new(),
    }
}

/// Answers id searches with a row for every even id, and fails any batch
/// that names `failing`.
struct OneFailingBatch {
    failing: i32,
    asked: Mutex<Vec<Vec<i32>>>,
}

#[async_trait]
impl ReplayVaultPort for OneFailingBatch {
    async fn search_vault(&self, query: ReplayQuery) -> Result<VaultSearchResult, String> {
        let ids: Vec<i32> = query
            .replay_ids
            .iter()
            .map(|id| id.parse().expect("numeric game id"))
            .collect();
        self.asked.lock().unwrap().push(ids.clone());
        if ids.contains(&self.failing) {
            return Err("the API timed out".into());
        }
        Ok(VaultSearchResult {
            replays: ids
                .into_iter()
                .filter(|id| id % 2 == 0)
                .map(vault_row)
                .collect(),
            total_pages: None,
            total_records: None,
        })
    }
    async fn list_featured_mods(&self) -> Result<Vec<String>, String> {
        FakeReplay.list_featured_mods().await
    }
    async fn download_vault(&self, uid: i32) -> Result<LocalReplay, String> {
        FakeReplay.download_vault(uid).await
    }
}

/// Sixty live games are looked up in batches of twenty-five, and the middle
/// batch fails. The batches either side are still asked and land as found or
/// missing; only the failed batch's games are marked failed, none is left
/// loading.
#[tokio::test]
async fn a_failed_lookup_batch_marks_only_its_own_games_and_the_rest_still_land() {
    let vault = Arc::new(OneFailingBatch {
        failing: 30,
        asked: Mutex::new(Vec::new()),
    });
    let app = start(Ports {
        replay_vault: vault.clone(),
        ..fake_ports()
    });
    let uids: Vec<i32> = (1..=60).collect();

    app.dispatch_and_wait(ReplayCommand::LookUpOnlineMany { uids }.into())
        .await
        .unwrap();

    let asked = vault.asked.lock().unwrap().clone();
    assert_eq!(
        asked.iter().map(Vec::len).collect::<Vec<_>>(),
        vec![25, 25, 10],
        "every batch is asked, including the ones after the failure"
    );

    let lookups = app.snapshot().replays.online_lookups;
    assert_eq!(lookups.len(), 60, "every game has an outcome");
    for uid in 1..=60 {
        let outcome = lookups.get(&uid).expect("every game is recorded");
        let failed_batch = (26..=50).contains(&uid);
        match outcome {
            OnlineLookup::Failed { reason } => {
                assert!(failed_batch, "game {uid} was in a batch that answered");
                assert_eq!(reason, "the API timed out");
            }
            OnlineLookup::Found(replay) => {
                assert!(!failed_batch, "game {uid} was in the failed batch");
                assert_eq!(replay.uid, uid);
                assert_eq!(uid % 2, 0, "only even games have a row");
            }
            OnlineLookup::Missing => {
                assert!(!failed_batch, "game {uid} was in the failed batch");
                assert_eq!(uid % 2, 1, "only odd games have no row");
            }
            OnlineLookup::Loading => panic!("game {uid} was left loading"),
        }
    }
}

// ── Partial failures: party league placements ───────────────────────────────

fn placement(division: &str) -> PlayerLeaguePlacement {
    PlayerLeaguePlacement {
        technical_name: "ladder_1v1".into(),
        season_number: 12,
        division: division.into(),
        subdivision: "II".into(),
        score: 7,
        highest_score: 10,
        games_played: 20,
        image_url: String::new(),
    }
}

/// League placements on demand: records every request, fails the next one
/// when `fail_next` is set, and otherwise places only player 1.
#[derive(Default)]
struct ScriptedPlacements {
    fail_next: AtomicBool,
    asked: Mutex<Vec<Vec<i32>>>,
}

#[async_trait]
impl PlayerCardPort for ScriptedPlacements {
    async fn search_players(
        &self,
        query: &str,
        limit: i32,
    ) -> Result<Vec<PlayerSummary>, RequestError> {
        FakePlayerCard.search_players(query, limit).await
    }
    async fn players_by_login(
        &self,
        logins: &[String],
    ) -> Result<Vec<PlayerSummary>, RequestError> {
        FakePlayerCard.players_by_login(logins).await
    }
    async fn players_by_id(&self, ids: &[i32]) -> Result<Vec<PlayerSummary>, RequestError> {
        FakePlayerCard.players_by_id(ids).await
    }
    async fn load_profile(
        &self,
        player_id: Option<i32>,
        login: &str,
    ) -> Result<PlayerCardProfile, String> {
        FakePlayerCard.load_profile(player_id, login).await
    }
    async fn load_matchmaker_profile(
        &self,
        player_id: i32,
        login: &str,
    ) -> Result<MatchmakerPlayerProfile, String> {
        FakePlayerCard
            .load_matchmaker_profile(player_id, login)
            .await
    }
    async fn load_league_placements(
        &self,
        player_ids: &[i32],
    ) -> Result<BTreeMap<i32, Vec<PlayerLeaguePlacement>>, String> {
        self.asked.lock().unwrap().push(player_ids.to_vec());
        if self.fail_next.swap(false, Ordering::SeqCst) {
            return Err("the league service is down".into());
        }
        Ok(player_ids
            .iter()
            .filter(|id| **id == 1)
            .map(|id| (*id, vec![placement("gold")]))
            .collect())
    }
    async fn load_rating_history(
        &self,
        query: &RatingHistoryQuery,
    ) -> Result<RatingHistoryPage, String> {
        FakePlayerCard.load_rating_history(query).await
    }
    async fn load_map_stats(&self, player_id: i32) -> Result<PlayerMapStats, String> {
        FakePlayerCard.load_map_stats(player_id).await
    }
}

fn party(player_ids: &[i32]) -> AppCommand {
    PlayerCardCommand::LoadPartyPlacements {
        player_ids: player_ids.to_vec(),
    }
    .into()
}

fn placements_app() -> (Arc<App>, Arc<ScriptedPlacements>) {
    let port = Arc::new(ScriptedPlacements::default());
    let app = start(Ports {
        player_card: port.clone(),
        ..fake_ports()
    });
    (app, port)
}

/// A failed placement lookup records nothing, so the party's next change asks
/// about the same members again instead of leaving their seats blank for the
/// session.
#[tokio::test]
async fn a_failed_placement_lookup_leaves_the_party_unrecorded_and_is_asked_again() {
    let (app, port) = placements_app();
    port.fail_next.store(true, Ordering::SeqCst);

    app.dispatch_and_wait(party(&[2, 1])).await.unwrap();
    assert!(
        app.snapshot().player_card.party_placements.is_empty(),
        "a failure must not be recorded as 'no placement'"
    );

    app.dispatch_and_wait(party(&[1, 2])).await.unwrap();

    assert_eq!(
        *port.asked.lock().unwrap(),
        vec![vec![1, 2], vec![1, 2]],
        "the failed members are asked about again"
    );
    let recorded = app.snapshot().player_card.party_placements;
    assert_eq!(recorded.get(&1), Some(&vec![placement("gold")]));
    assert_eq!(recorded.get(&2), Some(&Vec::new()));
}

/// A successful lookup records the placed and the unplaced alike, so the next
/// party change asks only about members not seen before, and a change that
/// brings nobody new asks nothing.
#[tokio::test]
async fn a_placement_lookup_records_placed_and_unplaced_and_asks_only_for_newcomers() {
    let (app, port) = placements_app();

    app.dispatch_and_wait(party(&[1, 2])).await.unwrap();
    let recorded = app.snapshot().player_card.party_placements;
    assert_eq!(recorded.get(&1), Some(&vec![placement("gold")]));
    assert_eq!(
        recorded.get(&2),
        Some(&Vec::new()),
        "an unplaced member is recorded as known-unplaced"
    );

    app.dispatch_and_wait(party(&[2, 3, 1])).await.unwrap();
    app.dispatch_and_wait(party(&[3, 1, 2])).await.unwrap();

    assert_eq!(
        *port.asked.lock().unwrap(),
        vec![vec![1, 2], vec![3]],
        "only the newcomer is asked about, and then nobody"
    );
    assert_eq!(
        app.snapshot().player_card.party_placements.get(&3),
        Some(&Vec::new())
    );
}

// ── Retries: loaders with a "loaded once" rule ──────────────────────────────

/// The mod vault, failing its first crawl and answering every later one.
#[derive(Default)]
struct FlakyModVault {
    crawls: AtomicUsize,
}

#[async_trait]
impl ModsPort for FlakyModVault {
    async fn list_vault(&self) -> Result<Vec<VaultMod>, String> {
        if self.crawls.fetch_add(1, Ordering::SeqCst) == 0 {
            return Err("the vault is unreachable".into());
        }
        Ok(Vec::new())
    }
    async fn search_vault(&self, query: ModVaultQuery) -> Result<ModSearchPage, String> {
        FakeMods.search_vault(query).await
    }
    async fn list_installed(&self) -> Result<Vec<InstalledMod>, String> {
        FakeMods.list_installed().await
    }
    async fn download_sizes(&self, targets: Vec<ModDownloadTarget>) -> Vec<ModDownloadSize> {
        FakeMods.download_sizes(targets).await
    }
    async fn install_mod(&self, uid: String, url: String) -> Result<Vec<InstalledMod>, String> {
        FakeMods.install_mod(uid, url).await
    }
    async fn update_mod(
        &self,
        old_folder: String,
        uid: String,
        url: String,
    ) -> Result<Vec<InstalledMod>, String> {
        FakeMods.update_mod(old_folder, uid, url).await
    }
    async fn uninstall_mod(&self, folder_name: String) -> Result<Vec<InstalledMod>, String> {
        FakeMods.uninstall_mod(folder_name).await
    }
    async fn toggle_mod(&self, uid: String, enabled: bool) -> Result<Vec<InstalledMod>, String> {
        FakeMods.toggle_mod(uid, enabled).await
    }
    async fn set_active_mods(&self, uids: Vec<String>) -> Result<Vec<InstalledMod>, String> {
        FakeMods.set_active_mods(uids).await
    }
    async fn ensure_game_mods(
        &self,
        mods: &BTreeMap<String, String>,
        replace_conflicts: bool,
    ) -> Result<(), ModPrepFailure> {
        FakeMods.ensure_game_mods(mods, replace_conflicts).await
    }
}

/// `LoadVault` refuses a second crawl of a loaded catalogue (`ReloadVault` is
/// the one that goes past that, see `mods_reload.rs`), but a failed crawl is
/// no reason to refuse: the next `LoadVault` tries again, and once that
/// succeeds the one after it does nothing.
#[tokio::test]
async fn a_failed_mod_vault_load_is_retried_and_a_loaded_one_is_not() {
    let vault = Arc::new(FlakyModVault::default());
    let app = start(Ports {
        mods: vault.clone(),
        ..fake_ports()
    });

    app.dispatch_and_wait(ModsCommand::LoadVault.into())
        .await
        .unwrap();
    assert!(matches!(
        app.snapshot().mods.vault_status,
        ModListStatus::Failed { .. }
    ));

    app.dispatch_and_wait(ModsCommand::LoadVault.into())
        .await
        .unwrap();
    assert_eq!(
        vault.crawls.load(Ordering::SeqCst),
        2,
        "a failure is retried"
    );
    assert_eq!(app.snapshot().mods.vault_status, ModListStatus::Ready);

    app.dispatch_and_wait(ModsCommand::LoadVault.into())
        .await
        .unwrap();
    assert_eq!(
        vault.crawls.load(Ordering::SeqCst),
        2,
        "a loaded catalogue is not crawled again"
    );
}

/// The co-op catalogue, failing its first fetch and answering every later one
/// with the offline catalogue.
#[derive(Default)]
struct FlakyCoop {
    fetches: AtomicUsize,
}

#[async_trait]
impl CoopPort for FlakyCoop {
    async fn list_catalog(&self) -> Result<(Vec<CoopScenario>, Vec<CoopMission>), RequestError> {
        if self.fetches.fetch_add(1, Ordering::SeqCst) == 0 {
            return Err(RequestError::offline("503 Service Unavailable"));
        }
        FakeCoop.list_catalog().await
    }
    async fn list_leaderboard(
        &self,
        mission_id: i32,
        player_count: i32,
    ) -> Result<Vec<CoopResult>, RequestError> {
        FakeCoop.list_leaderboard(mission_id, player_count).await
    }
}

/// The co-op catalogue is fetched once for the panel, the host dialog and the
/// replay tab together, but a failed fetch is retried by the next of them,
/// and only a loaded one is left alone.
#[tokio::test]
async fn a_failed_coop_catalogue_is_retried_and_a_loaded_one_is_not() {
    let coop = Arc::new(FlakyCoop::default());
    let app = start(Ports {
        coop: coop.clone(),
        ..fake_ports()
    });

    app.dispatch_and_wait(CoopCommand::LoadCatalog.into())
        .await
        .unwrap();
    assert!(matches!(
        app.snapshot().coop.catalog_status,
        CoopStatus::Failed { .. }
    ));

    app.dispatch_and_wait(CoopCommand::LoadCatalog.into())
        .await
        .unwrap();
    assert_eq!(
        coop.fetches.load(Ordering::SeqCst),
        2,
        "a failure is retried"
    );
    assert_eq!(app.snapshot().coop.catalog_status, CoopStatus::Ready);

    app.dispatch_and_wait(CoopCommand::LoadCatalog.into())
        .await
        .unwrap();
    assert_eq!(
        coop.fetches.load(Ordering::SeqCst),
        2,
        "a loaded catalogue is not fetched again"
    );
}

/// The tournament list behind the events tab, failing its first read and
/// answering every later one with the offline events.
struct FlakyTourneyList {
    lists: AtomicUsize,
    inner: FakeTourney,
}

#[async_trait]
impl TourneyReadPort for FlakyTourneyList {
    fn asset_base(&self) -> String {
        self.inner.asset_base()
    }
    async fn list(&self) -> Result<Vec<Tourney>, RequestError> {
        if self.lists.fetch_add(1, Ordering::SeqCst) == 0 {
            return Err(RequestError::offline("the tournament service is down"));
        }
        self.inner.list().await
    }
    async fn detail(&self, tournament_id: &str) -> Result<Tourney, RequestError> {
        self.inner.detail(tournament_id).await
    }
    async fn check_rating(&self, tournament_id: &str) -> Result<RatingCheck, RequestError> {
        self.inner.check_rating(tournament_id).await
    }
    async fn player_ratings(
        &self,
        tournament_id: &str,
        player_id: &str,
        refresh: bool,
    ) -> Result<EntrantRatings, RequestError> {
        self.inner
            .player_ratings(tournament_id, player_id, refresh)
            .await
    }
    async fn copy_sources(&self) -> Result<Vec<CopySource>, RequestError> {
        self.inner.copy_sources().await
    }
    async fn presets(&self) -> Result<Vec<TourneyPreset>, RequestError> {
        self.inner.presets().await
    }
    async fn check_renames(&self, tournament_id: &str) -> Result<RenameCheck, RequestError> {
        self.inner.check_renames(tournament_id).await
    }
    async fn series(&self) -> Result<Vec<TourneySeries>, RequestError> {
        self.inner.series().await
    }
    async fn series_detail(&self, series_id: &str) -> Result<SeriesDetail, RequestError> {
        self.inner.series_detail(series_id).await
    }
    async fn mark_news_read(&self, tournament_id: &str) -> Result<(), RequestError> {
        self.inner.mark_news_read(tournament_id).await
    }
}

/// The events tab tops its calendar up with the tournament list only while
/// that list is empty. A failed read leaves it empty, so the next visit asks
/// again; once it has events, later visits leave it alone.
#[tokio::test]
async fn a_failed_tournament_top_up_is_retried_by_the_next_events_visit_and_a_loaded_one_is_not() {
    let tourneys = Arc::new(FlakyTourneyList {
        lists: AtomicUsize::new(0),
        inner: FakeTourney::default(),
    });
    let app = start(Ports {
        tourney_read: tourneys.clone(),
        ..fake_ports()
    });

    app.dispatch_and_wait(EventsCommand::Load.into())
        .await
        .unwrap();
    assert_eq!(tourneys.lists.load(Ordering::SeqCst), 1);
    assert!(app.snapshot().tourney.events.is_empty());

    app.dispatch_and_wait(EventsCommand::Load.into())
        .await
        .unwrap();
    assert_eq!(
        tourneys.lists.load(Ordering::SeqCst),
        2,
        "a failed top-up is retried"
    );
    let loaded: HashSet<String> = app
        .snapshot()
        .tourney
        .events
        .iter()
        .map(|event| event.id.clone())
        .collect();
    assert!(!loaded.is_empty(), "the retry brought the events in");

    app.dispatch_and_wait(EventsCommand::Load.into())
        .await
        .unwrap();
    assert_eq!(
        tourneys.lists.load(Ordering::SeqCst),
        2,
        "a loaded list is not read again by the events tab"
    );
}
