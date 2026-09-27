//! Nothing may be written to the settings file before it has been read.
//!
//! Every command runs on its own task, and the webview renders and takes
//! clicks as soon as it has a snapshot, which is well before the settings load
//! it is racing has emitted anything. Until `Loaded` lands, `state.settings`
//! is `SettingsState::default()`, and settings are persisted as a whole
//! document read back out of state. So a single preference set during startup
//! used to save defaults for everything else along with it: theme, paths,
//! column widths, favourites, vetoes, all of it, from one click. That is the
//! "my settings reset themselves" report.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use faf_app::infra::fake_ports;
use faf_app::ports::SettingsPort;
use faf_app::{App, Ports};
use faf_domain::state::{SettingsCommand, SettingsState, Theme};
use tokio::sync::Notify;

/// A settings file that holds something, and takes its time being read.
///
/// The wait stands in for what the load actually does before it emits: a file
/// read, install discovery, and (until this was moved off that path) a walk of
/// the whole game-files cache and both install directories, stat-ing every
/// file in them.
struct SlowSettings {
    stored: SettingsState,
    released: Arc<Notify>,
    saved: Arc<Mutex<Vec<SettingsState>>>,
}

#[async_trait]
impl SettingsPort for SlowSettings {
    async fn load(&self) -> SettingsState {
        self.released.notified().await;
        self.stored.clone()
    }

    async fn save(&self, settings: &SettingsState) {
        self.saved.lock().unwrap().push(settings.clone());
    }
}

/// What the player had configured before this launch.
fn stored_settings() -> SettingsState {
    SettingsState {
        theme: Theme::PythonClient,
        game_path: "C:/FA/bin/ForgedAlliance.exe".into(),
        ..SettingsState::default()
    }
}

struct Harness {
    app: Arc<App>,
    released: Arc<Notify>,
    saved: Arc<Mutex<Vec<SettingsState>>>,
}

fn harness() -> Harness {
    let released = Arc::new(Notify::new());
    let saved = Arc::new(Mutex::new(Vec::new()));
    let ports = Ports {
        settings: Arc::new(SlowSettings {
            stored: stored_settings(),
            released: released.clone(),
            saved: saved.clone(),
        }),
        ..fake_ports()
    };
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());
    Harness {
        app: Arc::new(app),
        released,
        saved,
    }
}

#[tokio::test]
async fn a_preference_set_during_startup_does_not_write_defaults_over_the_file() {
    let Harness {
        app,
        released,
        saved,
    } = harness();

    // Startup dispatches the load; it is still in flight.
    let loading = app.clone();
    let load = tokio::spawn(async move {
        loading
            .dispatch_and_wait(SettingsCommand::Load.into())
            .await
            .expect("the load must finish");
    });

    // The player clicks something in the window that is already on screen.
    app.dispatch_and_wait(
        SettingsCommand::SetTheme {
            theme: Theme::ForgeLight,
        }
        .into(),
    )
    .await
    .unwrap();

    assert!(
        saved.lock().unwrap().is_empty(),
        "a write before the file was read would have been a document of defaults, \
         erasing the stored theme and game path"
    );

    // And the file is still the player's once the load lands.
    released.notify_one();
    tokio::time::timeout(Duration::from_secs(5), load)
        .await
        .expect("the load must not hang")
        .expect("the load task must not panic");
    let state = app.snapshot().settings;
    assert_eq!(
        state.theme,
        Theme::PythonClient,
        "the loaded file wins over the change that raced it"
    );
    assert_eq!(state.game_path, "C:/FA/bin/ForgedAlliance.exe");
}

#[tokio::test]
async fn a_preference_set_after_the_load_is_persisted_as_before() {
    let Harness {
        app,
        released,
        saved,
    } = harness();

    // A permit rather than a wake, so it does not matter whether the load has
    // reached its await yet.
    released.notify_one();
    app.dispatch_and_wait(SettingsCommand::Load.into())
        .await
        .unwrap();

    app.dispatch_and_wait(
        SettingsCommand::SetTheme {
            theme: Theme::ForgeLight,
        }
        .into(),
    )
    .await
    .unwrap();

    let saved = saved.lock().unwrap();
    let last = saved.last().expect("the change must reach the file");
    assert_eq!(last.theme, Theme::ForgeLight);
    assert_eq!(
        last.game_path, "C:/FA/bin/ForgedAlliance.exe",
        "and it carries the rest of the loaded document with it"
    );
}
