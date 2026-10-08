use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use faf_app::infra::fake_ports;
use faf_app::ports::{ReplayPlaybackPort, ReplayVaultPort};
use faf_app::{App, Ports};
use faf_domain::state::{
    LiveReplayTarget, LocalReplay, LocalReplayStatus, ReplayCommand, ReplayEvent, ReplayQuery,
};
use faf_domain::AppEvent;

/// One double for both halves of a vault replay, so a test that installs it in
/// both slots sees a download and a launch in the same place.
struct DownloadReplay {
    requested: Arc<Mutex<Vec<i32>>>,
    /// Every launch of any kind: a vault watch by uid, a file or live watch as
    /// `-1`. Recorded rather than `unreachable!`, because a panic in the
    /// command's task does not fail the test that sent it.
    watched: Arc<Mutex<Vec<i32>>>,
}

#[async_trait]
impl ReplayVaultPort for DownloadReplay {
    async fn search_vault(
        &self,
        _query: ReplayQuery,
    ) -> Result<faf_app::ports::VaultSearchResult, String> {
        unreachable!()
    }

    async fn list_featured_mods(&self) -> Result<Vec<String>, String> {
        unreachable!()
    }

    async fn download_vault(&self, uid: i32) -> Result<LocalReplay, String> {
        self.requested.lock().unwrap().push(uid);
        Ok(LocalReplay {
            path: format!("C:/replays/{uid}.fafreplay"),
            file_name: format!("{uid}.fafreplay"),
            uid: Some(uid),
            map: "scmp_009".into(),
            mod_name: "faf".into(),
            title: "Downloaded replay".into(),
            recorder: "Host".into(),
            start_time: None,
            duration_seconds: None,
            modified_time: 1,
            file_size_bytes: 100,
            num_players: 2,
            teams: Vec::new(),
            average_rating: None,
            sim_mods: Vec::new(),
            status: LocalReplayStatus::Complete,
            watchable: true,
            game_version: None,
        })
    }
}

/// The other half of the same double: watching a vault replay is a launch.
#[async_trait]
impl ReplayPlaybackPort for DownloadReplay {
    async fn watch_live(
        &self,
        _target: LiveReplayTarget,
        _player: String,
    ) -> Result<Option<String>, String> {
        self.watched.lock().unwrap().push(-1);
        Ok(None)
    }

    async fn play_file(&self, _path: PathBuf) -> Result<Option<String>, String> {
        self.watched.lock().unwrap().push(-1);
        Ok(None)
    }

    async fn watch_vault(&self, uid: i32) -> Result<Option<String>, String> {
        self.watched.lock().unwrap().push(uid);
        Ok(None)
    }

    fn set_install_dir(&self, _dir: Option<PathBuf>) {}
}
#[tokio::test]
async fn downloading_a_vault_replay_does_not_launch_it_and_updates_the_library() {
    let requested = Arc::new(Mutex::new(Vec::new()));
    let watched = Arc::new(Mutex::new(Vec::new()));
    // In both slots: a download that also launched would reach the playback
    // port, and the default fake there would have hidden it.
    let replay = Arc::new(DownloadReplay {
        requested: requested.clone(),
        watched: watched.clone(),
    });
    let ports = Ports {
        replay_vault: replay.clone(),
        replay_playback: replay,
        ..fake_ports()
    };
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());
    let mut events = app.subscribe();

    // Waited for, so the "no launch" check below runs after the whole command,
    // not just after its last event.
    app.dispatch_and_wait(ReplayCommand::DownloadVault { uid: 42 }.into())
        .await
        .unwrap();

    assert!(matches!(
        events.recv().await.unwrap(),
        AppEvent::Replays(ReplayEvent::VaultDownloadStarted { uid: 42 })
    ));
    assert!(matches!(
        events.recv().await.unwrap(),
        AppEvent::Replays(ReplayEvent::VaultDownloaded { uid: 42, .. })
    ));
    assert_eq!(*requested.lock().unwrap(), vec![42]);
    assert_eq!(app.snapshot().replays.local[0].uid, Some(42));
    assert!(
        watched.lock().unwrap().is_empty(),
        "downloading launched the replay: {:?}",
        watched.lock().unwrap()
    );
}

/// Watching a vault replay downloads it as the first step of its launch,
/// which the launch narrates (`ReplayEvent::Preparing`, from the playback
/// port). It does not mark the library download's status: that used to be
/// set here and cleared when the watch ended, which also ended a real
/// download into the library running beside it.
#[tokio::test]
async fn watching_a_vault_replay_does_not_pass_for_a_library_download() {
    let watched = Arc::new(Mutex::new(Vec::new()));
    let ports = Ports {
        replay_playback: Arc::new(DownloadReplay {
            requested: Arc::new(Mutex::new(Vec::new())),
            watched: watched.clone(),
        }),
        ..fake_ports()
    };
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());
    let mut events = app.subscribe();

    app.dispatch(ReplayCommand::WatchVault { uid: 27456965 }.into())
        .await
        .unwrap();

    assert!(matches!(
        events.recv().await.unwrap(),
        AppEvent::Replays(ReplayEvent::Connecting)
    ));
    assert!(matches!(
        events.recv().await.unwrap(),
        AppEvent::Replays(ReplayEvent::Playing {
            uid: Some(27456965),
            warning: None,
        })
    ));
    assert_eq!(*watched.lock().unwrap(), vec![27456965]);
}
