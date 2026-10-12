//! Calling off the game update behind a join or a search.
//!
//! `CancelJoin` and `Matchmake { start: false }` stopped the narration and the
//! request to the server, but the updater behind them was told nothing and
//! went on to the end of the featured mod, holding the install. The join
//! started next then waited behind it with nothing on screen. The updater is
//! handed a token now, and stops at its next safe point.
//!
//! The updater here behaves like the real one where this matters: a run holds
//! the install for as long as it writes (the real one's install lease), stops
//! between two files once called off, and drops a file still downloading. Each
//! of its files waits at a gate the test opens, so a run that is not stopped
//! holds the install until the test says otherwise, and the orders below are
//! exact rather than a matter of timing.
//!
//! The last two tests are the failure notifications of a search and a host:
//! both carry the client's own reason as the entry's `reason` parameter, which
//! is what tells the UI to word it plainly.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use faf_app::infra::{fake_ports, FakeAuth};
use faf_app::ports::{
    GameLaunchParams, GamePreparation, GameUpdaterPort, InstallPresence, PreparationPhase,
    PreparationStep, ProcessPort, UpdateProgress,
};
use faf_app::{App, Ports};
use faf_domain::state::{
    AuthCommand, HostGameConfig, LobbyCommand, LobbyEvent, MatchmakingState, Player,
};
use faf_domain::{AppCommand, AppEvent};
use tokio::sync::{broadcast, mpsc, Semaphore};
use tokio_util::sync::CancellationToken;

/// How long anything that should happen promptly gets before the test calls
/// it stuck. A safety net only: nothing waits this long when the test passes.
const PATIENCE: Duration = Duration::from_secs(5);

/// How many files every featured mod is made of here.
const FILES: usize = 3;

/// Seeded games in the fake lobby: 1 is on Theta Passage, 2 on Seton's
/// Clutch.
const FIRST_MAP: &str = "Theta Passage";
const SECOND_MAP: &str = "Seton's Clutch";

/// The launcher's preparation lock is one for the whole process, and these
/// tests run side by side in one. Each test that prepares holds this, so one
/// test's held update never stands in for another's.
static ONE_TEST_AT_A_TIME: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Claims live launch so preparation really runs, without an FA install.
struct LaunchableProcess;

#[async_trait]
impl ProcessPort for LaunchableProcess {
    fn supports_live_launch(&self) -> bool {
        true
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
    async fn wait_for_exit(&self) {
        std::future::pending::<()>().await
    }
    fn set_paths(&self, _game_path: String, _replay_game_path: String) {}
    fn set_additional_arguments(&self, _arguments: Vec<String>) {}
    fn game_install_dir(&self) -> Option<PathBuf> {
        Some(PathBuf::from("C:/faf"))
    }
    fn replay_install_dir(&self) -> Option<PathBuf> {
        None
    }
    fn installs_present(&self) -> InstallPresence {
        InstallPresence::default()
    }
}

/// Every run's name, and how it ended: `None` while it runs.
type Runs = Arc<Mutex<Vec<(String, Option<Result<(), String>>)>>>;

/// An updater shaped like the real one where calling it off is concerned.
///
/// A run is named after its map, or after its featured mod when it has none.
/// It takes the install (`install`, standing in for the real install lease),
/// then fetches [`FILES`] files. Each file is downloaded at the run's gate,
/// one permit per file, and a call-off stops the download where it is; it is
/// also looked at between two files. What every run did is recorded.
#[derive(Clone, Default)]
struct InstallLikeUpdater {
    install: Arc<tokio::sync::Mutex<()>>,
    gates: Arc<Mutex<HashMap<String, Arc<Semaphore>>>>,
    runs: Runs,
    /// Each file a run starts, as `"<run> file <n>"`, for runs that are not
    /// narrated on screen (a search's).
    started: Arc<Mutex<Option<mpsc::UnboundedSender<String>>>>,
}

impl InstallLikeUpdater {
    fn gate(&self, run: &str) -> Arc<Semaphore> {
        self.gates
            .lock()
            .unwrap()
            .entry(run.to_string())
            .or_insert_with(|| Arc::new(Semaphore::new(0)))
            .clone()
    }

    /// Let `files` more of `run`'s files through.
    fn open(&self, run: &str, files: usize) {
        self.gate(run).add_permits(files);
    }

    /// Report each file a run starts on the returned channel.
    fn watch_files(&self) -> mpsc::UnboundedReceiver<String> {
        let (tx, rx) = mpsc::unbounded_channel();
        *self.started.lock().unwrap() = Some(tx);
        rx
    }

    /// How `run`'s last run ended, if it has.
    fn ended(&self, run: &str) -> Option<Result<(), String>> {
        self.runs
            .lock()
            .unwrap()
            .iter()
            .rev()
            .find(|(name, _)| name == run)
            .and_then(|(_, ended)| ended.clone())
    }
}

#[async_trait]
impl GameUpdaterPort for InstallLikeUpdater {
    async fn prepare(&self, request: GamePreparation) -> mpsc::Receiver<UpdateProgress> {
        self.prepare_cancellable(request, CancellationToken::new())
            .await
    }

    async fn prepare_cancellable(
        &self,
        request: GamePreparation,
        called_off: CancellationToken,
    ) -> mpsc::Receiver<UpdateProgress> {
        let run = request.map_folder.unwrap_or(request.featured_mod);
        let gate = self.gate(&run);
        let install = self.install.clone();
        let runs = self.runs.clone();
        let started = self.started.lock().unwrap().clone();
        runs.lock().unwrap().push((run.clone(), None));
        let (tx, rx) = mpsc::channel(1);
        tokio::spawn(async move {
            let stopped = || Err("called off".to_string());
            let outcome = async {
                // The real updater takes the install lease first, and waits
                // for it unless it is called off.
                let _install = tokio::select! {
                    held = install.lock_owned() => held,
                    () = called_off.cancelled() => return stopped(),
                };
                for file in 0..FILES {
                    if called_off.is_cancelled() {
                        return stopped();
                    }
                    let name = format!("{run} file {file}");
                    if let Some(started) = &started {
                        let _ = started.send(name.clone());
                    }
                    let step = PreparationStep::indeterminate(PreparationPhase::Downloading, name);
                    let _ = tx.send(UpdateProgress::Step(step)).await;
                    tokio::select! {
                        permit = gate.acquire() => permit.expect("gate closed").forget(),
                        () = called_off.cancelled() => return stopped(),
                    }
                }
                Ok(())
            }
            .await;
            if let Some(entry) = runs
                .lock()
                .unwrap()
                .iter_mut()
                .rev()
                .find(|(name, ended)| *name == run && ended.is_none())
            {
                entry.1 = Some(outcome.clone());
            }
            let _ = tx.send(UpdateProgress::Finished(outcome)).await;
        });
        rx
    }
}

/// Every lobby event seen so far, so assertions can look back over all of it.
struct Log {
    events: broadcast::Receiver<AppEvent>,
    seen: Vec<LobbyEvent>,
}

impl Log {
    fn new(app: &App) -> Self {
        Self {
            events: app.subscribe(),
            seen: Vec::new(),
        }
    }

    /// Record events until one matches, or fail after [`PATIENCE`].
    async fn until(&mut self, what: &str, matches: impl Fn(&LobbyEvent) -> bool) {
        let events = &mut self.events;
        let seen = &mut self.seen;
        tokio::time::timeout(PATIENCE, async {
            loop {
                match events.recv().await {
                    Ok(AppEvent::Lobby(event)) => {
                        let found = matches(&event);
                        seen.push(event);
                        if found {
                            return;
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => panic!("the app stopped"),
                    _ => {}
                }
            }
        })
        .await
        .unwrap_or_else(|_| panic!("never saw {what}"));
    }
}

fn start(updater: InstallLikeUpdater) -> Arc<App> {
    let ports = Ports {
        auth: Arc::new(FakeAuth {
            player: Player::new(7, "Ada"),
            delay: Duration::ZERO,
            fail_with: None,
        }),
        process: Arc::new(LaunchableProcess),
        updater: Arc::new(updater),
        ..fake_ports()
    };
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());
    Arc::new(app)
}

async fn signed_in_and_connected(app: &App, log: &mut Log) {
    app.dispatch_and_wait(AuthCommand::Login { remember: false }.into())
        .await
        .unwrap();
    app.dispatch(LobbyCommand::Connect.into()).await.unwrap();
    log.until("the lobby connecting", |event| {
        matches!(event, LobbyEvent::GamesUpdated { .. })
    })
    .await;
}

fn join(id: i32) -> AppCommand {
    LobbyCommand::Join {
        id,
        password: None,
        replace_mods: false,
    }
    .into()
}

/// Run a command without blocking the test on it.
fn spawn_command(app: &Arc<App>, command: AppCommand) {
    let app = app.clone();
    tokio::spawn(async move { app.dispatch_and_wait(command).await });
}

fn is_step(event: &LobbyEvent, name: &str) -> bool {
    matches!(event, LobbyEvent::Preparing { detail, .. } if detail == name)
}

/// A join called off while its update is part-way through: the next join
/// prepares at once, and narrates. Its updater used to wait for the whole of
/// the first one, which held the install to the end of its files.
#[tokio::test]
async fn a_join_called_off_mid_update_lets_the_next_join_prepare_at_once() {
    let _alone = ONE_TEST_AT_A_TIME.lock().await;
    let updater = InstallLikeUpdater::default();
    let app = start(updater.clone());
    let mut log = Log::new(&app);
    signed_in_and_connected(&app, &mut log).await;

    // Join A gets one file in and is called off on the second.
    updater.open(FIRST_MAP, 1);
    spawn_command(&app, join(1));
    log.until("join A on its second file", |event| {
        is_step(event, &format!("{FIRST_MAP} file 1"))
    })
    .await;
    app.dispatch_and_wait(LobbyCommand::CancelJoin.into())
        .await
        .unwrap();

    // Join B prepares straight away, with every gate of A's still shut.
    spawn_command(&app, join(2));
    log.until("join B preparing", |event| {
        is_step(event, &format!("{SECOND_MAP} file 0"))
    })
    .await;
    assert_eq!(
        updater.ended(FIRST_MAP),
        Some(Err("called off".to_string())),
        "the called-off join's update was not stopped"
    );
    assert!(
        !log.seen
            .iter()
            .any(|event| is_step(event, &format!("{FIRST_MAP} file 2"))),
        "the called-off update went on to its next file"
    );

    // B goes on to its own launch.
    updater.open(SECOND_MAP, FILES);
    log.until(
        "B's launch",
        |event| matches!(event, LobbyEvent::Launching { launch } if launch.uid == 2),
    )
    .await;
    assert_eq!(updater.ended(SECOND_MAP), Some(Ok(())));
}

/// A search stopped while its featured mod is still coming down: the update
/// behind it stops, and a join started straight after prepares at once. The
/// search's update used to run to the end while holding the launcher's
/// preparation lock, so the join waited behind all of it, unnarrated.
#[tokio::test]
async fn a_search_stopped_mid_update_lets_the_next_join_prepare_at_once() {
    let _alone = ONE_TEST_AT_A_TIME.lock().await;
    let updater = InstallLikeUpdater::default();
    let mut files = updater.watch_files();
    let app = start(updater.clone());
    let mut log = Log::new(&app);
    signed_in_and_connected(&app, &mut log).await;

    // The search's update gets one file in and is stopped on the second.
    updater.open("faf", 1);
    spawn_command(
        &app,
        LobbyCommand::StartSearch {
            queue_names: vec!["ladder1v1".into()],
        }
        .into(),
    );
    let second = tokio::time::timeout(PATIENCE, async {
        while let Some(file) = files.recv().await {
            if file == "faf file 1" {
                return;
            }
        }
    });
    second
        .await
        .expect("the search's update never got to its second file");
    app.dispatch_and_wait(
        LobbyCommand::Matchmake {
            queue_name: "ladder1v1".into(),
            start: false,
        }
        .into(),
    )
    .await
    .unwrap();

    // The join prepares straight away, with the search's gate still shut.
    spawn_command(&app, join(1));
    log.until("the join preparing", |event| {
        is_step(event, &format!("{FIRST_MAP} file 0"))
    })
    .await;
    assert_eq!(
        updater.ended("faf"),
        Some(Err("called off".to_string())),
        "the stopped search's update was not stopped"
    );
    assert_eq!(app.snapshot().lobby.matchmaking, MatchmakingState::Idle);
    assert!(
        !app.snapshot()
            .notifications
            .items
            .iter()
            .any(|notification| notification.title == "Could not start the search"),
        "a search the user stopped was reported as failed"
    );

    updater.open(FIRST_MAP, FILES);
    log.until(
        "the join's launch",
        |event| matches!(event, LobbyEvent::Launching { launch } if launch.uid == 1),
    )
    .await;
}

/// An updater whose every run fails at once, with the HTTP client's own
/// wording.
struct FailingUpdater;

const OFFLINE: &str = "could not update faf: request failed: error sending request for url \
                       (https://api.faforever.com/data/featuredMod)";

#[async_trait]
impl GameUpdaterPort for FailingUpdater {
    async fn prepare(&self, _request: GamePreparation) -> mpsc::Receiver<UpdateProgress> {
        let (tx, rx) = mpsc::channel(1);
        let _ = tx
            .send(UpdateProgress::Finished(Err(OFFLINE.to_string())))
            .await;
        rx
    }
}

/// A search whose featured mod could not be updated says why in a
/// notification, and hands that reason over as the entry's `reason`, so the
/// UI says it plainly instead of showing the HTTP client's English.
#[tokio::test]
async fn a_search_that_could_not_be_prepared_hands_its_reason_to_the_notification_view() {
    let _alone = ONE_TEST_AT_A_TIME.lock().await;
    let ports = Ports {
        process: Arc::new(LaunchableProcess),
        updater: Arc::new(FailingUpdater),
        ..fake_ports()
    };
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());
    let mut log = Log::new(&app);
    app.dispatch(LobbyCommand::Connect.into()).await.unwrap();
    log.until("the lobby connecting", |event| {
        matches!(event, LobbyEvent::GamesUpdated { .. })
    })
    .await;

    app.dispatch_and_wait(
        LobbyCommand::StartSearch {
            queue_names: vec!["ladder1v1".into()],
        }
        .into(),
    )
    .await
    .unwrap();

    let failure = app
        .snapshot()
        .notifications
        .items
        .into_iter()
        .find(|notification| notification.title == "Could not start the search")
        .expect("the failure is reported");
    let text = failure.text.expect("the failure names its catalogue entry");
    assert_eq!(text.key, "notifications.msg.searchFailed");
    assert_eq!(text.params.get("reason").map(String::as_str), Some(OFFLINE));
    assert_eq!(failure.body, OFFLINE);
}

/// A host request refused before it was sent, here for a visibility the
/// server does not know, is reported under a catalogue entry of its own, with
/// the reason as its parameter. It had neither, so the title stayed English.
#[tokio::test]
async fn a_host_refused_before_it_was_sent_hands_its_reason_to_the_notification_view() {
    let (app, app_loop) = App::new("test", fake_ports());
    tokio::spawn(app_loop.run());

    app.dispatch_and_wait(
        LobbyCommand::Host {
            config: HostGameConfig {
                title: "Friday game".into(),
                mod_name: "faf".into(),
                visibility: "secret".into(),
                map: "scmp_009".into(),
                password: None,
                enforce_rating_range: false,
                rating_min: None,
                rating_max: None,
            },
        }
        .into(),
    )
    .await
    .unwrap();

    let refusal = app
        .snapshot()
        .notifications
        .items
        .into_iter()
        .find(|notification| notification.title == "Could not host game")
        .expect("the refusal is reported");
    let text = refusal.text.expect("the refusal names its catalogue entry");
    assert_eq!(text.key, "notifications.msg.hostFailed");
    assert_eq!(
        text.params.get("reason").map(String::as_str),
        Some(refusal.body.as_str())
    );
    assert!(refusal.body.contains("Visibility"), "{}", refusal.body);
}
