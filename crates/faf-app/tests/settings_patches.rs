//! Preference writes are patches merged into the backend's state, not whole
//! groups copied out of the webview's last snapshot.
//!
//! The report this pins: two changes made before the first one's event came
//! back each carried the *old* value of the other field, so the second write
//! reverted the first. Also here, because it is the other settings write whose
//! order mattered: removing a notification sound clears what plays it before
//! the file goes.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use faf_app::infra::fake_ports;
use faf_app::ports::{NotificationSoundsPort, SettingsPort};
use faf_app::{App, Ports};
use faf_domain::state::mods::ModPreset;
use faf_domain::state::settings::{
    BrowsingPreferencesPatch, GamePreferencesPatch, HostGamePreferencesPatch, PreferenceList,
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

    async fn save(&self, settings: &SettingsState) -> Result<(), String> {
        self.saved.lock().unwrap().push(settings.clone());
        Ok(())
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

/// A settings store whose writes can be made to fail. Paired with a sounds port
/// that records what it was asked to delete, so a test can see whether the
/// file went after a failed save.
struct FlakySettings {
    initial: SettingsState,
    failing: Arc<AtomicBool>,
}

#[async_trait]
impl SettingsPort for FlakySettings {
    async fn load(&self) -> SettingsState {
        self.initial.clone()
    }

    async fn save(&self, _settings: &SettingsState) -> Result<(), String> {
        if self.failing.load(Ordering::SeqCst) {
            Err("disk full".into())
        } else {
            Ok(())
        }
    }
}

#[derive(Default)]
struct RecordingSounds {
    removed: Mutex<Vec<String>>,
}

impl NotificationSoundsPort for RecordingSounds {
    fn accepts(&self, name: &str) -> bool {
        !name.contains(['/', '\\'])
    }

    fn remove(&self, name: &str) -> Result<(), String> {
        self.removed.lock().unwrap().push(name.to_owned());
        Ok(())
    }
}

/// A settings store whose next write can be held until the test lets it go.
struct HeldSettings {
    initial: SettingsState,
    hold: Arc<AtomicBool>,
    release: Arc<tokio::sync::Notify>,
}

#[async_trait]
impl SettingsPort for HeldSettings {
    async fn load(&self) -> SettingsState {
        self.initial.clone()
    }

    async fn save(&self, _settings: &SettingsState) -> Result<(), String> {
        if self.hold.swap(false, Ordering::SeqCst) {
            self.release.notified().await;
        }
        Ok(())
    }
}

/// Sounds as files that come and go, so "is it still there" has an answer.
struct SoundFiles(Mutex<std::collections::HashSet<String>>);

impl NotificationSoundsPort for SoundFiles {
    fn accepts(&self, name: &str) -> bool {
        !name.contains(['/', '\\'])
    }

    fn remove(&self, name: &str) -> Result<(), String> {
        self.0.lock().unwrap().remove(name);
        Ok(())
    }

    fn exists(&self, name: &str) -> bool {
        self.0.lock().unwrap().contains(name)
    }
}

fn choose_for_other(sound: &str) -> faf_domain::AppCommand {
    use faf_domain::state::settings::{
        NotificationPreferencesPatch, NotificationSoundChoicesPatch,
    };
    SettingsCommand::PatchNotifications {
        patch: Box::new(NotificationPreferencesPatch {
            sounds: Some(NotificationSoundChoicesPatch {
                other: Some(NotificationSound::Custom(sound.into())),
                ..NotificationSoundChoicesPatch::default()
            }),
            ..NotificationPreferencesPatch::default()
        }),
    }
    .into()
}

/// The dropdown still lists a sound while it is being removed. Choosing it in
/// that window, or after it is gone, must not leave a saved setting naming a
/// deleted file; another sound is still chosen as usual.
#[tokio::test]
async fn a_sound_being_removed_cannot_be_chosen_again() {
    let hold = Arc::new(AtomicBool::new(false));
    let release = Arc::new(tokio::sync::Notify::new());
    let files = Arc::new(SoundFiles(Mutex::new(
        ["horn.wav", "bell.wav"].map(String::from).into(),
    )));
    let ports = Ports {
        settings: Arc::new(HeldSettings {
            initial: SettingsState {
                notifications: NotificationPreferences {
                    sounds: NotificationSoundChoices {
                        mention: NotificationSound::Custom("horn.wav".into()),
                        ..NotificationSoundChoices::default()
                    },
                    ..NotificationPreferences::default()
                },
                ..initial_settings()
            },
            hold: hold.clone(),
            release: release.clone(),
        }),
        notification_sounds: files.clone(),
        ..fake_ports()
    };
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());
    let app = Arc::new(app);
    app.dispatch_and_wait(SettingsCommand::Load.into())
        .await
        .unwrap();

    // The removal clears its references, then waits on its save.
    hold.store(true, Ordering::SeqCst);
    let removal = tokio::spawn({
        let app = app.clone();
        async move {
            app.dispatch_and_wait(
                SettingsCommand::RemoveNotificationSound {
                    name: "horn.wav".into(),
                }
                .into(),
            )
            .await
        }
    });
    until(&app, |state| {
        state.settings.notifications.sounds.mention == NotificationSound::Chime
    })
    .await;

    // In that window the user picks the sound for one row and another sound
    // for a second. Not waited on: its own save queues behind the held one,
    // so the state it emits first is what is checked. The second row shows
    // the change has been applied, so the check cannot pass by being early.
    {
        use faf_domain::state::settings::{
            NotificationPreferencesPatch, NotificationSoundChoicesPatch,
        };
        app.dispatch(
            SettingsCommand::PatchNotifications {
                patch: Box::new(NotificationPreferencesPatch {
                    sounds: Some(NotificationSoundChoicesPatch {
                        other: Some(NotificationSound::Custom("horn.wav".into())),
                        game_full: Some(NotificationSound::Custom("bell.wav".into())),
                        ..NotificationSoundChoicesPatch::default()
                    }),
                    ..NotificationPreferencesPatch::default()
                }),
            }
            .into(),
        )
        .await
        .unwrap();
    }
    until(&app, |state| {
        state.settings.notifications.sounds.game_full
            == NotificationSound::Custom("bell.wav".into())
    })
    .await;
    assert_ne!(
        app.snapshot().settings.notifications.sounds.other,
        NotificationSound::Custom("horn.wav".into()),
        "a sound being removed was chosen again"
    );

    release.notify_one();
    removal.await.unwrap().unwrap();
    assert!(!files.exists("horn.wav"));

    // Gone now, so still refused; a sound that exists is chosen normally.
    app.dispatch_and_wait(choose_for_other("horn.wav"))
        .await
        .unwrap();
    assert_ne!(
        app.snapshot().settings.notifications.sounds.other,
        NotificationSound::Custom("horn.wav".into())
    );
    app.dispatch_and_wait(choose_for_other("bell.wav"))
        .await
        .unwrap();
    assert_eq!(
        app.snapshot().settings.notifications.sounds.other,
        NotificationSound::Custom("bell.wav".into())
    );
}

#[tokio::test]
async fn a_sound_is_kept_when_the_settings_naming_it_could_not_be_saved() {
    let failing = Arc::new(AtomicBool::new(false));
    let sounds = Arc::new(RecordingSounds::default());
    let ports = Ports {
        settings: Arc::new(FlakySettings {
            initial: SettingsState {
                notifications: NotificationPreferences {
                    sounds: NotificationSoundChoices {
                        mention: NotificationSound::Custom("horn.wav".into()),
                        ..NotificationSoundChoices::default()
                    },
                    ..NotificationPreferences::default()
                },
                ..initial_settings()
            },
            failing: failing.clone(),
        }),
        notification_sounds: sounds.clone(),
        ..fake_ports()
    };
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());
    app.dispatch_and_wait(SettingsCommand::Load.into())
        .await
        .unwrap();

    // The write fails: the saved settings on disk still play horn.wav, so
    // deleting it would leave that row playing nothing after a restart.
    failing.store(true, Ordering::SeqCst);
    app.dispatch_and_wait(
        SettingsCommand::RemoveNotificationSound {
            name: "horn.wav".into(),
        }
        .into(),
    )
    .await
    .unwrap();
    assert!(sounds.removed.lock().unwrap().is_empty());
    let state = app.snapshot();
    assert_eq!(state.notifications.items.len(), 1);
    assert_eq!(
        state.notifications.items[0].title,
        "Could not remove the sound"
    );

    // Once a write succeeds the same removal goes through, even though state
    // stopped naming the sound on the first attempt.
    failing.store(false, Ordering::SeqCst);
    app.dispatch_and_wait(
        SettingsCommand::RemoveNotificationSound {
            name: "horn.wav".into(),
        }
        .into(),
    )
    .await
    .unwrap();
    assert_eq!(*sounds.removed.lock().unwrap(), ["horn.wav"]);
}

#[tokio::test]
async fn two_quick_toggles_of_the_same_list_both_survive() {
    let (app, saved) = loaded_app(initial_settings()).await;

    // Back to back, the second sent before the first one's event could reach
    // the webview: under a whole-list patch the second carried a list without
    // the first, and only one star survived.
    for folder in ["gap_of_rohan.v0001", "dawn.v0003"] {
        app.dispatch(
            SettingsCommand::SetListMember {
                list: PreferenceList::FavoriteMaps,
                value: folder.into(),
                member: true,
            }
            .into(),
        )
        .await
        .unwrap();
    }
    for uid in ["eco-graph", "acu-highlight"] {
        app.dispatch(
            SettingsCommand::SetListMember {
                list: PreferenceList::FavoriteMods,
                value: uid.into(),
                member: true,
            }
            .into(),
        )
        .await
        .unwrap();
    }
    for login in ["Aurora", "Bo"] {
        app.dispatch(
            SettingsCommand::SetListMember {
                list: PreferenceList::MutedPlayers,
                value: login.into(),
                member: true,
            }
            .into(),
        )
        .await
        .unwrap();
    }
    for (player, color) in [("Aurora", "#112233"), ("Bo", "#445566")] {
        app.dispatch(
            SettingsCommand::SetPlayerNameColor {
                player: player.into(),
                color: Some(color.into()),
            }
            .into(),
        )
        .await
        .unwrap();
    }
    for name in ["Replay", "Team"] {
        app.dispatch(
            SettingsCommand::SaveModPreset {
                preset: ModPreset {
                    name: name.into(),
                    uids: Vec::new(),
                },
            }
            .into(),
        )
        .await
        .unwrap();
    }

    until(&app, |state| {
        let browsing = &state.settings.browsing;
        let chat = &state.settings.chat;
        browsing.favorite_maps.len() == 2
            && browsing.favorite_mods.len() == 2
            && browsing.mod_presets.len() == 2
            && chat.muted_players.len() == 2
            && chat.name_colors.players.len() == 2
    })
    .await;

    // And an unstar right behind them removes only its own entry.
    app.dispatch(
        SettingsCommand::SetListMember {
            list: PreferenceList::FavoriteMaps,
            value: "GAP_OF_ROHAN.v0001".into(),
            member: false,
        }
        .into(),
    )
    .await
    .unwrap();
    app.dispatch(
        SettingsCommand::DeleteModPreset {
            name: "replay".into(),
        }
        .into(),
    )
    .await
    .unwrap();
    until(&app, |state| {
        state.settings.browsing.favorite_maps == ["dawn.v0003"]
            && state.settings.browsing.mod_presets.len() == 1
    })
    .await;

    let state = app.snapshot().settings;
    assert_eq!(state.browsing.favorite_mods, ["eco-graph", "acu-highlight"]);
    assert_eq!(state.browsing.mod_presets[0].name, "Team");
    assert_eq!(state.chat.muted_players, ["Aurora", "Bo"]);
    until(&app, |_| saved.lock().unwrap().last() == Some(&state)).await;
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
