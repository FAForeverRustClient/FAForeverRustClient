//! Preference writes are patches merged into the backend's state, not whole
//! groups copied out of the webview's last snapshot.
//!
//! The report this pins: two changes made before the first one's event came
//! back each carried the *old* value of the other field, so the second write
//! reverted the first. Also here, because it is the other settings write whose
//! order mattered: removing a notification sound clears what plays it before
//! the file goes.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use faf_app::infra::fake_ports;
use faf_app::ports::SettingsPort;
use faf_app::{App, Ports};
use faf_domain::state::settings::{
    BrowsingPreferencesPatch, GamePreferencesPatch, HostGamePreferencesPatch,
};
use faf_domain::state::{
    GamePreferences, NotificationPreferences, NotificationSound, NotificationSoundChoices,
    SettingsCommand, SettingsState,
};
use faf_domain::AppState;

/// A stored sound name that is never on disk, so the removal under test finds
/// nothing to delete and touches nothing real. The sounds directory is not
/// injectable (see `infra::notification_sounds`), so this is the one name that
/// is safe to hand it.
fn absent_sound() -> String {
    format!("faf-test-absent-{}.wav", std::process::id())
}

#[derive(Default)]
struct RecordingSettings {
    initial: SettingsState,
    saved: Arc<Mutex<Vec<SettingsState>>>,
}

#[async_trait]
impl SettingsPort for RecordingSettings {
    async fn load(&self) -> SettingsState {
        self.initial.clone()
    }

    async fn save(&self, settings: &SettingsState) {
        self.saved.lock().unwrap().push(settings.clone());
    }
}

/// Settings whose startup cache pass cannot sweep the real game-files cache of
/// whoever runs the suite: `cache_dir` is not injectable either.
fn initial_settings() -> SettingsState {
    SettingsState {
        game: GamePreferences {
            cache_lifetime_days: None,
            ..GamePreferences::default()
        },
        ..SettingsState::default()
    }
}

async fn loaded_app(initial: SettingsState) -> (App, Arc<Mutex<Vec<SettingsState>>>) {
    let saved = Arc::new(Mutex::new(Vec::new()));
    let ports = Ports {
        settings: Arc::new(RecordingSettings {
            initial,
            saved: saved.clone(),
        }),
        ..fake_ports()
    };
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());
    app.dispatch_and_wait(SettingsCommand::Load.into())
        .await
        .unwrap();
    saved.lock().unwrap().clear();
    (app, saved)
}

async fn until(app: &App, done: impl Fn(&AppState) -> bool) {
    for _ in 0..300 {
        if done(&app.snapshot()) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("state never reached the expected shape");
}

#[tokio::test]
async fn two_quick_patches_to_different_fields_both_survive() {
    let (app, saved) = loaded_app(initial_settings()).await;

    // Back to back, neither waiting for the other's event: exactly what two
    // clicks inside one round trip look like. Under the whole-group protocol
    // the second carried the first one's old value and undid it.
    app.dispatch(
        SettingsCommand::PatchBrowsing {
            patch: Box::new(BrowsingPreferencesPatch {
                favorite_maps: Some(vec!["adaptive_tabula.v0006".into()]),
                ..BrowsingPreferencesPatch::default()
            }),
        }
        .into(),
    )
    .await
    .unwrap();
    app.dispatch(
        SettingsCommand::PatchBrowsing {
            patch: Box::new(BrowsingPreferencesPatch {
                vault_page_size: Some(48),
                // A nested group takes a patch too: one host field changes and
                // every other one keeps what it held.
                host_game: Some(HostGamePreferencesPatch {
                    title: Some("  Friday 4v4  ".into()),
                    ..HostGamePreferencesPatch::default()
                }),
                ..BrowsingPreferencesPatch::default()
            }),
        }
        .into(),
    )
    .await
    .unwrap();
    // A third, in another group, so the merge is per group and not a lock on
    // the whole document that happened to be held.
    app.dispatch(
        SettingsCommand::PatchGame {
            patch: Box::new(GamePreferencesPatch {
                steam_presence: Some(false),
                ..GamePreferencesPatch::default()
            }),
        }
        .into(),
    )
    .await
    .unwrap();

    until(&app, |state| {
        let browsing = &state.settings.browsing;
        browsing.favorite_maps == ["adaptive_tabula.v0006"]
            && browsing.vault_page_size == 48
            && browsing.host_game.title == "Friday 4v4"
            && !state.settings.game.steam_presence
    })
    .await;

    let state = app.snapshot().settings;
    // Untouched by any patch, so exactly as loaded.
    let defaults = SettingsState::default();
    assert_eq!(
        state.browsing.host_game.featured_mod,
        defaults.browsing.host_game.featured_mod
    );
    assert_eq!(
        state.browsing.host_game.rating_min,
        defaults.browsing.host_game.rating_min
    );
    assert_eq!(
        state.browsing.mod_vault_preset,
        defaults.browsing.mod_vault_preset
    );
    assert_eq!(state.game.cache_lifetime_days, None);

    // And the document on disk is the merged one, not whichever write was last.
    until(&app, |_| saved.lock().unwrap().len() >= 3).await;
    assert_eq!(saved.lock().unwrap().last().unwrap(), &state);
}

#[tokio::test]
async fn a_present_null_clears_an_optional_preference() {
    let (app, _saved) = loaded_app(SettingsState {
        game: GamePreferences {
            // Set, so clearing it is observable; the alert only measures.
            cache_size_alert_gb: Some(40),
            ..initial_settings().game
        },
        ..initial_settings()
    })
    .await;

    // What the webview sends for "no alert": the field present, as `null`.
    let command: SettingsCommand = serde_json::from_value(serde_json::json!({
        "type": "patchGame",
        "payload": { "patch": { "cacheSizeAlertGb": null } }
    }))
    .unwrap();
    app.dispatch_and_wait(command.into()).await.unwrap();

    let game = app.snapshot().settings.game;
    assert_eq!(game.cache_size_alert_gb, None);
    // Absent fields stay as they were, null-clearing is not "reset the group".
    assert_eq!(game.cache_lifetime_days, None);
    assert_eq!(
        game.steam_presence,
        GamePreferences::default().steam_presence
    );
}

#[tokio::test]
async fn removing_a_sound_clears_what_plays_it_and_saves_before_the_file_goes() {
    let name = absent_sound();
    let (app, saved) = loaded_app(SettingsState {
        notifications: NotificationPreferences {
            sounds: NotificationSoundChoices {
                mention: NotificationSound::Custom(name.clone()),
                other: NotificationSound::Custom(name.clone()),
                party_invite: NotificationSound::Custom("keep-me.wav".into()),
                ..NotificationSoundChoices::default()
            },
            ..NotificationPreferences::default()
        },
        ..initial_settings()
    })
    .await;

    app.dispatch_and_wait(SettingsCommand::RemoveNotificationSound { name }.into())
        .await
        .unwrap();

    let state = app.snapshot();
    let sounds = &state.settings.notifications.sounds;
    assert_eq!(sounds.mention, NotificationSound::Chime);
    assert_eq!(sounds.other, NotificationSound::Chime);
    // Another added sound is not this one.
    assert_eq!(
        sounds.party_invite,
        NotificationSound::Custom("keep-me.wav".into())
    );
    // Written down before the delete, which is the ordering that matters.
    assert_eq!(
        saved
            .lock()
            .unwrap()
            .last()
            .map(|saved| &saved.notifications.sounds),
        Some(sounds)
    );
    // A file that is already gone is not a failure worth a notification.
    assert!(
        state.notifications.items.is_empty(),
        "{:?}",
        state.notifications.items
    );
}

#[tokio::test]
async fn a_name_that_is_not_a_stored_sound_changes_nothing_and_says_so() {
    let (app, saved) = loaded_app(initial_settings()).await;
    let before = app.snapshot().settings;

    app.dispatch_and_wait(
        SettingsCommand::RemoveNotificationSound {
            name: "../settings.json".into(),
        }
        .into(),
    )
    .await
    .unwrap();

    let state = app.snapshot();
    assert_eq!(state.settings, before);
    assert!(saved.lock().unwrap().is_empty());
    assert_eq!(state.notifications.items.len(), 1);
    assert_eq!(
        state.notifications.items[0].title,
        "Could not remove the sound"
    );
}
