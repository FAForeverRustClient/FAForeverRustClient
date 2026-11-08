//! "Play offline" on a machine where FAF's copy of the game was never set up.
//!
//! Signed out there is nothing to start and nothing to set it up with, so the
//! player is told how to get there. Signed in, the client fetches the files
//! the way an online launch does before its first game, says so while it
//! runs, and then starts the game; Cancel stops it before anything starts.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use faf_app::infra::fake_ports;
use faf_app::ports::{
    GameLaunchParams, GamePreparation, GameUpdaterPort, InstallPresence, PreparationPhase,
    PreparationStep, ProcessPort, UpdateProgress,
};
use faf_app::{App, Ports};
use faf_domain::state::{
    AuthCommand, AuthEvent, AuthStatus, NotificationKind, OfflineGamePreparation,
};
use faf_domain::AppEvent;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// A game install that is there or not, and the offline starts asked of it.
#[derive(Default)]
struct Install {
    present: AtomicBool,
    offline: Mutex<Vec<(String, String)>>,
}

#[async_trait]
impl ProcessPort for Install {
    fn supports_live_launch(&self) -> bool {
        true
    }
    async fn launch_game(&self, _params: GameLaunchParams) -> Result<(), String> {
        Ok(())
    }
    async fn launch_offline(&self, featured_mod: String, map: String) -> Result<(), String> {
        self.offline.lock().unwrap().push((featured_mod, map));
        Ok(())
    }
    async fn launch_replay(&self, _args: Vec<String>) -> Result<(), String> {
        Ok(())
    }
    fn kill(&self) {}
    fn set_paths(&self, _game_path: String, _replay_game_path: String) {}
    fn set_additional_arguments(&self, _arguments: Vec<String>) {}
    fn game_install_dir(&self) -> Option<PathBuf> {
        Some(PathBuf::from("FAForever"))
    }
    fn replay_install_dir(&self) -> Option<PathBuf> {
        None
    }
    fn installs_present(&self) -> InstallPresence {
        let game = self.present.load(Ordering::SeqCst);
        InstallPresence {
            game,
            game_pending: !game,
            ..InstallPresence::default()
        }
    }
    fn install_path_is_present(&self, _path: &str) -> bool {
        self.present.load(Ordering::SeqCst)
    }
}

/// An updater that reports one step and then writes the game into `install`,
/// or holds the run open until the test lets it go.
struct Updater {
    install: Arc<Install>,
    seen: Mutex<Vec<GamePreparation>>,
    hold: bool,
    held: Mutex<Option<(mpsc::Sender<UpdateProgress>, CancellationToken)>>,
}

impl Updater {
    fn new(install: Arc<Install>, hold: bool) -> Self {
        Self {
            install,
            seen: Mutex::default(),
            hold,
            held: Mutex::default(),
        }
    }
}

#[async_trait]
impl GameUpdaterPort for Updater {
    async fn prepare(&self, _request: GamePreparation) -> mpsc::Receiver<UpdateProgress> {
        unreachable!("an offline game's update must be cancellable")
    }
    async fn prepare_cancellable(
        &self,
        request: GamePreparation,
        cancel: CancellationToken,
    ) -> mpsc::Receiver<UpdateProgress> {
        self.seen.lock().unwrap().push(request);
        let (tx, rx) = mpsc::channel(8);
        tx.send(UpdateProgress::Step(PreparationStep {
            phase: PreparationPhase::Downloading,
            detail: "Downloading ForgedAlliance.exe".into(),
            progress: Some(40),
        }))
        .await
        .unwrap();
        if self.hold {
            *self.held.lock().unwrap() = Some((tx, cancel));
        } else {
            self.install.present.store(true, Ordering::SeqCst);
            tx.send(UpdateProgress::Finished(Ok(()))).await.unwrap();
        }
        rx
    }
}

fn app(install: &Arc<Install>, updater: &Arc<Updater>) -> Arc<App> {
    let (app, app_loop) = App::new(
        "test",
        Ports {
            process: install.clone(),
            updater: updater.clone(),
            ..fake_ports()
        },
    );
    tokio::spawn(app_loop.run());
    Arc::new(app)
}

/// How many times the player was told the game is being downloaded.
fn download_notices(app: &App) -> usize {
    app.snapshot()
        .notifications
        .items
        .iter()
        .filter(|item| {
            item.text.as_ref().map(|text| text.key.as_str())
                == Some("notifications.msg.offlineGameDownloading")
        })
        .count()
}

/// Notifications other than the download notice: failures, above all.
fn other_notices(app: &App) -> usize {
    app.snapshot().notifications.items.len() - download_notices(app)
}

async fn sign_in(app: &App) {
    app.dispatch_and_wait(AuthCommand::LoginTest.into())
        .await
        .unwrap();
    assert!(app.snapshot().auth.player.is_some());
}

#[tokio::test]
async fn signed_out_it_is_refused_with_how_to_set_the_game_up() {
    let install = Arc::new(Install::default());
    let updater = Arc::new(Updater::new(install.clone(), false));
    let app = app(&install, &updater);

    app.dispatch_and_wait(AuthCommand::LaunchOfflineGame.into())
        .await
        .unwrap();

    let auth = app.snapshot().auth;
    assert_eq!(auth.status, AuthStatus::Failed);
    let error = auth.error.unwrap();
    assert!(error.contains("Sign in once"), "{error}");
    assert!(
        updater.seen.lock().unwrap().is_empty(),
        "nothing to update with"
    );
    assert!(install.offline.lock().unwrap().is_empty());
}

#[tokio::test]
async fn signed_in_it_sets_the_game_up_and_then_starts_it() {
    let install = Arc::new(Install::default());
    let updater = Arc::new(Updater::new(install.clone(), false));
    let app = app(&install, &updater);
    sign_in(&app).await;
    let mut events = app.subscribe();

    app.dispatch_and_wait(AuthCommand::LaunchOfflineGame.into())
        .await
        .unwrap();

    let seen = updater.seen.lock().unwrap().clone();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].featured_mod, "faf");
    assert_eq!(seen[0].map_folder, None);
    assert_eq!(
        *install.offline.lock().unwrap(),
        vec![("faf".to_string(), String::new())]
    );

    // The step was shown while it ran, and nothing is left showing after.
    let mut steps = Vec::new();
    while let Ok(event) = events.try_recv() {
        if let AppEvent::Auth(AuthEvent::OfflineGamePreparing { detail, progress }) = event {
            steps.push(OfflineGamePreparation { detail, progress });
        }
    }
    assert!(steps.contains(&OfflineGamePreparation {
        detail: "Downloading ForgedAlliance.exe".into(),
        progress: Some(40),
    }));
    let snapshot = app.snapshot();
    assert_eq!(snapshot.auth.offline_game, None);
    assert!(snapshot.auth.player.is_some(), "still signed in");
    assert!(
        snapshot.install.game_ready,
        "the banner and the login hint see the files"
    );
    // The download is said once, where it is hard to miss, and nothing failed.
    assert_eq!(download_notices(&app), 1);
    let notice = snapshot
        .notifications
        .items
        .iter()
        .find(|item| item.text.is_some())
        .unwrap();
    assert_eq!(notice.kind, NotificationKind::GameInstall);
    assert_eq!(other_notices(&app), 0);
}

#[tokio::test]
async fn cancelling_the_set_up_never_starts_the_game() {
    let install = Arc::new(Install::default());
    let updater = Arc::new(Updater::new(install.clone(), true));
    let app = app(&install, &updater);
    sign_in(&app).await;

    let launch = {
        let app = app.clone();
        tokio::spawn(async move {
            app.dispatch_and_wait(AuthCommand::LaunchOfflineGame.into())
                .await
                .unwrap();
        })
    };
    tokio::time::timeout(Duration::from_secs(2), async {
        while app.snapshot().auth.offline_game.is_none() || updater.held.lock().unwrap().is_none() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();

    app.dispatch_and_wait(AuthCommand::CancelOfflineGame.into())
        .await
        .unwrap();
    // The run stops at its next safe point and answers.
    let (sender, token) = updater.held.lock().unwrap().take().unwrap();
    assert!(token.is_cancelled());
    sender
        .send(UpdateProgress::Finished(Err("called off".into())))
        .await
        .unwrap();
    drop(sender);
    tokio::time::timeout(Duration::from_secs(2), launch)
        .await
        .unwrap()
        .unwrap();

    let snapshot = app.snapshot();
    assert_eq!(snapshot.auth.offline_game, None);
    assert!(install.offline.lock().unwrap().is_empty());
    assert_eq!(download_notices(&app), 1, "the download was announced");
    assert_eq!(other_notices(&app), 0, "a cancel is not a failure");
}

#[tokio::test]
async fn an_install_that_is_there_starts_without_an_update() {
    let install = Arc::new(Install::default());
    install.present.store(true, Ordering::SeqCst);
    let updater = Arc::new(Updater::new(install.clone(), false));
    let app = app(&install, &updater);
    sign_in(&app).await;

    app.dispatch_and_wait(AuthCommand::LaunchOfflineGame.into())
        .await
        .unwrap();

    assert!(updater.seen.lock().unwrap().is_empty());
    assert_eq!(install.offline.lock().unwrap().len(), 1);
    assert_eq!(download_notices(&app), 0, "nothing is downloaded");
}
