//! Catalogue lessons: download, start, and the result read back from the log.
//!
//! The parts worth a test at this level are the ones that cross ports in a
//! fixed order: the featured mod is patched before the lesson's files are put
//! in place, the game starts offline on the lesson's folder, and the result is
//! read from the log the game was given only once the game has closed.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use faf_app::infra::fake_ports;
use faf_app::ports::{
    GameLaunchParams, GamePreparation, GameUpdaterPort, InstallPresence, ProcessPort, TrainingPort,
    UpdateProgress,
};
use faf_app::{App, Ports};
use faf_domain::state::{
    LessonLaunch, LessonPackage, LessonRecord, LessonScore, TrainingCatalogue, TrainingCommand,
    TrainingKind, TrainingResource, TrainingStatus,
};
use tokio::sync::{mpsc, Notify, Semaphore};

const FOLDER: &str = "FAF_Lesson_Gunships_01";
const LOG: &str = "C:/logs/offline-1.log";

struct Gate {
    entered: Semaphore,
    release: Semaphore,
}

impl Gate {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            entered: Semaphore::new(0),
            release: Semaphore::new(0),
        })
    }
}

fn package() -> LessonPackage {
    LessonPackage {
        folder: FOLDER.into(),
        files: vec![
            format!("{FOLDER}_scenario.lua"),
            format!("{FOLDER}_script.lua"),
        ],
    }
}

/// A catalogue holding one lesson, and a record of what was done with it.
#[derive(Default)]
struct StubLessons {
    install_gate: Option<Arc<Gate>>,
    save_gate: Option<Arc<Gate>>,
    installed: Mutex<Vec<LessonPackage>>,
    install_fails: bool,
    log: String,
    logs_read: Mutex<Vec<PathBuf>>,
    saved: Mutex<Vec<BTreeMap<String, LessonRecord>>>,
}

#[async_trait]
impl TrainingPort for StubLessons {
    async fn list_catalogue(&self, _refresh: bool) -> Result<TrainingCatalogue, String> {
        Ok(TrainingCatalogue {
            resources: vec![TrainingResource {
                id: "lesson-gunships".into(),
                title: "Gunships against flak".into(),
                kind: TrainingKind::Lesson,
                lesson: Some(package()),
                ..TrainingResource::default()
            }],
            ..TrainingCatalogue::default()
        })
    }

    async fn read_guide(&self, _url: String) -> Result<String, String> {
        Err("no guides here".into())
    }

    async fn read_recording(&self, _url: String) -> Result<String, String> {
        Err("no recordings here".into())
    }

    async fn install_lesson(&self, lesson: LessonPackage) -> Result<(), String> {
        if let Some(gate) = &self.install_gate {
            gate.entered.add_permits(1);
            gate.release.acquire().await.unwrap().forget();
        }
        if self.install_fails {
            return Err("could not download the lesson".into());
        }
        self.installed.lock().unwrap().push(lesson);
        Ok(())
    }

    async fn save_lesson_records(
        &self,
        records: BTreeMap<String, LessonRecord>,
    ) -> Result<(), String> {
        if let Some(gate) = &self.save_gate {
            gate.entered.add_permits(1);
            gate.release.acquire().await.unwrap().forget();
        }
        self.saved.lock().unwrap().push(records);
        Ok(())
    }

    async fn read_lesson_log(&self, path: PathBuf) -> Result<String, String> {
        self.logs_read.lock().unwrap().push(path);
        Ok(self.log.clone())
    }
}

/// Starts nothing, records what it was asked to start, and closes the game
/// when the test says so.
#[derive(Default)]
struct ScriptedGame {
    offline: Mutex<Vec<(String, String)>>,
    running: AtomicBool,
    exited: Notify,
}

#[async_trait]
impl ProcessPort for ScriptedGame {
    fn supports_live_launch(&self) -> bool {
        true
    }
    fn game_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }
    async fn launch_game(&self, _params: GameLaunchParams) -> Result<(), String> {
        Err("a lesson must never go through the lobby launch".into())
    }
    async fn launch_offline(&self, featured_mod: String, map: String) -> Result<(), String> {
        self.offline.lock().unwrap().push((featured_mod, map));
        Ok(())
    }
    async fn launch_offline_logged(
        &self,
        featured_mod: String,
        map: String,
    ) -> Result<Option<PathBuf>, String> {
        self.launch_offline(featured_mod, map).await?;
        Ok(Some(PathBuf::from(LOG)))
    }
    async fn launch_replay(&self, _args: Vec<String>) -> Result<(), String> {
        Ok(())
    }
    fn kill(&self) {}
    async fn wait_for_exit(&self) {
        self.exited.notified().await
    }
    fn set_paths(&self, _game_path: String, _replay_game_path: String) {}
    fn set_additional_arguments(&self, _arguments: Vec<String>) {}
    fn game_install_dir(&self) -> Option<PathBuf> {
        None
    }
    fn replay_install_dir(&self) -> Option<PathBuf> {
        None
    }
    fn installs_present(&self) -> InstallPresence {
        InstallPresence::default()
    }
}

/// Patches nothing and reports success, recording what it was asked for.
#[derive(Default)]
struct QuietUpdater {
    seen: Mutex<Vec<GamePreparation>>,
}

#[async_trait]
impl GameUpdaterPort for QuietUpdater {
    async fn prepare(&self, request: GamePreparation) -> mpsc::Receiver<UpdateProgress> {
        self.seen.lock().unwrap().push(request);
        let (tx, rx) = mpsc::channel(1);
        tx.send(UpdateProgress::Finished(Ok(()))).await.unwrap();
        rx
    }
}

struct Harness {
    app: App,
    lessons: Arc<StubLessons>,
    game: Arc<ScriptedGame>,
    updater: Arc<QuietUpdater>,
}

async fn harness(lessons: StubLessons, game: ScriptedGame) -> Harness {
    let lessons = Arc::new(lessons);
    let game = Arc::new(game);
    let updater = Arc::new(QuietUpdater::default());
    let (app, app_loop) = App::new(
        "test",
        Ports {
            training: lessons.clone(),
            process: game.clone(),
            updater: updater.clone(),
            ..fake_ports()
        },
    );
    tokio::spawn(app_loop.run());
    app.dispatch(TrainingCommand::Load.into()).await.unwrap();
    wait_for(&app, |app| {
        app.snapshot().training.status == TrainingStatus::Ready
    })
    .await;
    Harness {
        app,
        lessons,
        game,
        updater,
    }
}

async fn wait_for(app: &App, done: impl Fn(&App) -> bool) {
    for _ in 0..300 {
        if done(app) {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!(
        "never got there: {:?}",
        app.snapshot().training.lesson_launch
    );
}

fn launch() -> faf_domain::AppCommand {
    TrainingCommand::LaunchLesson {
        resource_id: "lesson-gunships".into(),
    }
    .into()
}

#[tokio::test]
async fn a_lesson_is_installed_then_started_offline_on_its_folder() {
    let h = harness(StubLessons::default(), ScriptedGame::default()).await;
    h.app.dispatch(launch()).await.unwrap();
    wait_for(&h.app, |app| {
        matches!(
            app.snapshot().training.lesson_launch,
            LessonLaunch::Playing { .. }
        )
    })
    .await;

    let prepared = h.updater.seen.lock().unwrap();
    assert_eq!(prepared.len(), 1);
    assert_eq!(prepared[0].featured_mod, "faf");
    // The map comes from the catalogue repository, not from the vault.
    assert_eq!(prepared[0].map_folder, None);
    assert_eq!(*h.lessons.installed.lock().unwrap(), vec![package()]);
    assert_eq!(
        *h.game.offline.lock().unwrap(),
        vec![("faf".to_string(), FOLDER.to_string())]
    );
}

#[tokio::test]
async fn the_result_is_read_from_the_log_once_the_game_closes_and_kept() {
    let h = harness(
        StubLessons {
            log: format!(
                "INFO: loading\nINFO: FAF_LESSON_RESULT lesson={FOLDER} stars=2 max=3 seconds=431\n"
            ),
            ..StubLessons::default()
        },
        ScriptedGame::default(),
    )
    .await;
    h.app.dispatch(launch()).await.unwrap();
    wait_for(&h.app, |app| {
        matches!(
            app.snapshot().training.lesson_launch,
            LessonLaunch::Playing { .. }
        )
    })
    .await;
    // Nothing is read while the game is still open.
    assert!(h.lessons.logs_read.lock().unwrap().is_empty());

    // The watcher registers right after the launch; give it the moment.
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    h.game.exited.notify_waiters();

    let score = LessonScore {
        stars: 2,
        max_stars: 3,
        seconds: 431,
    };
    wait_for(&h.app, |app| {
        app.snapshot().training.lesson_launch
            == LessonLaunch::Finished {
                resource_id: "lesson-gunships".into(),
                score: Some(score),
            }
    })
    .await;
    assert_eq!(
        *h.lessons.logs_read.lock().unwrap(),
        vec![PathBuf::from(LOG)]
    );
    assert_eq!(
        h.app.snapshot().training.lesson_records["lesson-gunships"].best,
        score
    );
    wait_for(&h.app, |_| !h.lessons.saved.lock().unwrap().is_empty()).await;
    assert_eq!(
        h.lessons.saved.lock().unwrap()[0]["lesson-gunships"].best,
        score
    );
}

#[tokio::test]
async fn a_run_quit_before_its_debrief_records_nothing() {
    let h = harness(
        StubLessons {
            log: "INFO: loading\nINFO: Exiting\n".into(),
            ..StubLessons::default()
        },
        ScriptedGame::default(),
    )
    .await;
    h.app.dispatch(launch()).await.unwrap();
    wait_for(&h.app, |app| {
        matches!(
            app.snapshot().training.lesson_launch,
            LessonLaunch::Playing { .. }
        )
    })
    .await;
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    h.game.exited.notify_waiters();
    wait_for(&h.app, |app| {
        matches!(
            app.snapshot().training.lesson_launch,
            LessonLaunch::Finished { score: None, .. }
        )
    })
    .await;
    assert!(h.app.snapshot().training.lesson_records.is_empty());
    assert!(h.lessons.saved.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_running_game_refuses_the_lesson_before_anything_is_downloaded() {
    let h = harness(
        StubLessons::default(),
        ScriptedGame {
            running: AtomicBool::new(true),
            ..ScriptedGame::default()
        },
    )
    .await;
    h.app.dispatch(launch()).await.unwrap();
    wait_for(&h.app, |app| {
        matches!(
            app.snapshot().training.lesson_launch,
            LessonLaunch::Failed { .. }
        )
    })
    .await;
    assert!(h.updater.seen.lock().unwrap().is_empty());
    assert!(h.lessons.installed.lock().unwrap().is_empty());
    assert!(h.game.offline.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_game_started_during_lesson_preparation_is_not_replaced() {
    let gate = Gate::new();
    let h = harness(
        StubLessons {
            install_gate: Some(gate.clone()),
            ..StubLessons::default()
        },
        ScriptedGame::default(),
    )
    .await;
    h.app.dispatch(launch()).await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(3), gate.entered.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    h.game.running.store(true, Ordering::SeqCst);
    gate.release.add_permits(1);
    wait_for(&h.app, |app| {
        matches!(
            app.snapshot().training.lesson_launch,
            LessonLaunch::Failed { .. }
        )
    })
    .await;
    assert!(h.game.offline.lock().unwrap().is_empty());
    assert!(h.game.running.load(Ordering::SeqCst));
}

#[tokio::test]
async fn a_lesson_keeps_shutdown_waiting_until_its_result_is_saved() {
    let gate = Gate::new();
    let h = harness(
        StubLessons {
            save_gate: Some(gate.clone()),
            log: format!("INFO: FAF_LESSON_RESULT lesson={FOLDER} stars=2 max=3 seconds=431\n"),
            ..StubLessons::default()
        },
        ScriptedGame::default(),
    )
    .await;
    h.app.dispatch(launch()).await.unwrap();
    wait_for(&h.app, |app| {
        matches!(
            app.snapshot().training.lesson_launch,
            LessonLaunch::Playing { .. }
        )
    })
    .await;
    assert!(h.app.lesson_result_pending());
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    h.game.exited.notify_waiters();
    tokio::time::timeout(std::time::Duration::from_secs(3), gate.entered.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    assert!(
        h.app.lesson_result_pending(),
        "finishing in state must not bypass the save"
    );
    assert!(h.lessons.saved.lock().unwrap().is_empty());
    gate.release.add_permits(1);
    wait_for(&h.app, |app| !app.lesson_result_pending()).await;
    assert_eq!(h.lessons.saved.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_lesson_that_cannot_be_installed_is_never_started() {
    let h = harness(
        StubLessons {
            install_fails: true,
            ..StubLessons::default()
        },
        ScriptedGame::default(),
    )
    .await;
    h.app.dispatch(launch()).await.unwrap();
    wait_for(&h.app, |app| {
        matches!(
            app.snapshot().training.lesson_launch,
            LessonLaunch::Failed { .. }
        )
    })
    .await;
    match h.app.snapshot().training.lesson_launch {
        LessonLaunch::Failed { reason, .. } => assert!(reason.contains("download")),
        other => panic!("expected a failure, got {other:?}"),
    }
    assert!(h.game.offline.lock().unwrap().is_empty());
}
