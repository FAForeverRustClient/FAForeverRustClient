//! Player notes are local preferences, but the write must still travel through
//! the app loop so Rust remains the sole owner of persisted UI state.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use faf_app::infra::fake_ports;
use faf_app::ports::SettingsPort;
use faf_app::{App, Ports};
use faf_domain::state::{SettingsCommand, SettingsState};

#[derive(Default)]
struct RecordingSettings {
    saved: Arc<Mutex<Vec<SettingsState>>>,
}

#[async_trait]
impl SettingsPort for RecordingSettings {
    async fn load(&self) -> SettingsState {
        SettingsState::default()
    }

    async fn save(&self, settings: &SettingsState) {
        self.saved.lock().unwrap().push(settings.clone());
    }
}

async fn wait_for_note(app: &App, player_id: i32, expected: Option<&str>) {
    for _ in 0..100 {
        let note = app
            .snapshot()
            .settings
            .social
            .note_for(player_id)
            .map(|entry| entry.note.as_str().to_owned());
        if note.as_deref() == expected {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("player note did not reach authoritative state");
}

async fn wait_for_saved_note(
    saved: &Arc<Mutex<Vec<SettingsState>>>,
    player_id: i32,
    expected: Option<&str>,
) {
    for _ in 0..100 {
        let note = saved
            .lock()
            .unwrap()
            .last()
            .and_then(|settings| settings.social.note_for(player_id))
            .map(|entry| entry.note.clone());
        if note.as_deref() == expected {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("player note did not reach the settings port");
}

#[tokio::test]
async fn setting_and_clearing_a_player_note_crosses_the_app_loop() {
    let saved = Arc::new(Mutex::new(Vec::new()));
    let ports = Ports {
        settings: Arc::new(RecordingSettings {
            saved: saved.clone(),
        }),
        ..fake_ports()
    };
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());

    app.dispatch(
        SettingsCommand::SetPlayerNote {
            player_id: 42,
            login: "Aurora".into(),
            note: "Met in the 2v2 tournament".into(),
        }
        .into(),
    )
    .await
    .unwrap();
    wait_for_note(&app, 42, Some("Met in the 2v2 tournament")).await;
    wait_for_saved_note(&saved, 42, Some("Met in the 2v2 tournament")).await;

    app.dispatch(
        SettingsCommand::SetPlayerNote {
            player_id: 42,
            login: "Aurora".into(),
            note: String::new(),
        }
        .into(),
    )
    .await
    .unwrap();
    wait_for_note(&app, 42, None).await;
    wait_for_saved_note(&saved, 42, None).await;
}
