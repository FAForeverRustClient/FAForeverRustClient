//! The settings tab's cache controls go through `GameCachePort`, never the
//! real cache directory, so a test can watch them and cannot delete anything.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use faf_app::infra::fake_ports;
use faf_app::ports::GameCachePort;
use faf_app::{App, Ports};
use faf_domain::state::{GameCacheInfo, SettingsCommand};

#[derive(Default)]
struct RecordingCache {
    calls: Mutex<Vec<&'static str>>,
}

#[async_trait]
impl GameCachePort for RecordingCache {
    async fn expire(&self, _lifetime_days: u32) {
        self.calls.lock().unwrap().push("expire");
    }

    async fn clear(&self) {
        self.calls.lock().unwrap().push("clear");
    }

    async fn inspect(&self, _install_dirs: &[PathBuf]) -> Option<GameCacheInfo> {
        self.calls.lock().unwrap().push("inspect");
        Some(GameCacheInfo {
            total_size_bytes: 4_096.0,
            ..GameCacheInfo::default()
        })
    }
}

fn start(cache: Arc<RecordingCache>) -> App {
    let (app, app_loop) = App::new(
        "test",
        Ports {
            game_cache: cache,
            ..fake_ports()
        },
    );
    tokio::spawn(app_loop.run());
    app
}

#[tokio::test]
async fn clearing_goes_through_the_port_and_measures_again() {
    let cache = Arc::new(RecordingCache::default());
    let app = start(cache.clone());

    app.dispatch_and_wait(SettingsCommand::ClearGameCache.into())
        .await
        .unwrap();

    assert_eq!(*cache.calls.lock().unwrap(), ["clear", "inspect"]);
    assert_eq!(app.snapshot().settings.cache_info.total_size_bytes, 4_096.0);
}

#[tokio::test]
async fn refreshing_only_measures() {
    let cache = Arc::new(RecordingCache::default());
    let app = start(cache.clone());

    app.dispatch_and_wait(SettingsCommand::RefreshGameCache.into())
        .await
        .unwrap();

    assert_eq!(*cache.calls.lock().unwrap(), ["inspect"]);
}
