use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use faf_app::infra::fake_ports;
use faf_app::ports::ReplayPort;
use faf_app::{App, Ports};
use faf_domain::state::{
    LiveReplayTarget, LocalReplay, LocalReplayStatus, ReplayCommand, ReplayEvent, ReplayQuery,
};
use faf_domain::AppEvent;

struct DownloadReplay {
    requested: Arc<Mutex<Vec<i32>>>,
    watched: Arc<Mutex<Vec<i32>>>,
}

#[async_trait]
impl ReplayPort for DownloadReplay {
    async fn watch_live(
        &self,
        _target: LiveReplayTarget,
        _player: String,
    ) -> Result<Option<String>, String> {
        unreachable!()
    }

    async fn play_file(&self, _path: PathBuf) -> Result<Option<String>, String> {
        unreachable!()
    }

    async fn search_vault(
        &self,
        _query: ReplayQuery,
    ) -> Result<faf_app::ports::VaultSearchResult, String> {
        unreachable!()
    }

    async fn list_featured_mods(&self) -> Result<Vec<String>, String> {
        unreachable!()
    }

    async fn watch_vault(&self, uid: i32) -> Result<Option<String>, String> {
        self.watched.lock().unwrap().push(uid);
        Ok(None)
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

    async fn load_details(
        &self,
        _uid: i32,
        _local_path: Option<PathBuf>,
    ) -> Result<faf_domain::state::ReplayDetails, String> {
        Ok(faf_domain::state::ReplayDetails::default())
    }

    async fn list_local(&self, _limit: usize) -> Result<Vec<LocalReplay>, String> {
        unreachable!()
    }

    async fn delete_local(&self, _path: PathBuf) -> Result<(), String> {
        unreachable!()
    }

    fn set_install_dir(&self, _dir: Option<PathBuf>) {}
}

#[tokio::test]
async fn downloading_a_vault_replay_does_not_launch_it_and_updates_the_library() {
    let requested = Arc::new(Mutex::new(Vec::new()));
    let ports = Ports {
        replay: Arc::new(DownloadReplay {
            requested: requested.clone(),
            watched: Arc::new(Mutex::new(Vec::new())),
        }),
        ..fake_ports()
    };
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());
    let mut events = app.subscribe();

    app.dispatch(ReplayCommand::DownloadVault { uid: 42 }.into())
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
}

#[tokio::test]
async fn watching_a_vault_replay_reports_its_download_in_the_replay_lifecycle() {
    let watched = Arc::new(Mutex::new(Vec::new()));
    let ports = Ports {
        replay: Arc::new(DownloadReplay {
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
        AppEvent::Replays(ReplayEvent::VaultDownloadStarted { uid: 27456965 })
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
