use super::*;
use std::collections::HashMap;

fn deliver(state: &mut AppState, event: AppEvent) -> FrontendUpdate {
    crate::reduce(state, &event);
    FrontendUpdate::capture(state, &event)
        .unwrap_or_else(|| FrontendUpdate::from_delta(event).expect("compact delta"))
}

#[test]
fn settings_updates_carry_normalized_values_without_unrelated_caches() {
    let mut state = AppState::default();
    state.settings.kept_generated_maps = vec!["unrelated".repeat(100_000)];
    let update = deliver(
        &mut state,
        SettingsEvent::AppearanceChanged {
            preferences: AppearancePreferences {
                ui_scale: 400,
                ..Default::default()
            },
        }
        .into(),
    );
    let FrontendUpdate::Settings(settings) = &update else {
        panic!("settings update")
    };
    let SettingsUpdate::Appearance(appearance) = settings.as_ref() else {
        panic!("appearance group")
    };
    assert_eq!(appearance.ui_scale, 200);
    assert_eq!(appearance.as_ref(), &state.settings.appearance);
    assert!(serde_json::to_vec(&update).unwrap().len() < 2_000);
    assert_eq!(state.settings.kept_generated_maps.len(), 1);
}

#[test]
fn normalized_paths_and_kept_maps_do_not_need_a_frontend_rule() {
    let mut state = AppState::default();
    let paths = deliver(
        &mut state,
        SettingsEvent::PathsChanged {
            preferences: PathPreferences {
                maps_dir: "  maps  ".into(),
                ..Default::default()
            },
        }
        .into(),
    );
    let paths = serde_json::to_value(paths).unwrap();
    assert_eq!(paths["event"]["field"], "paths");
    assert_eq!(paths["event"]["value"]["mapsDir"], "maps");
    state.settings.kept_generated_maps = vec!["neroxis_a".into()];
    let kept = deliver(
        &mut state,
        SettingsEvent::KeptGeneratedMaps {
            map_names: vec![" NEROXIS_A ".into(), " ".into(), "neroxis_b".into()],
        }
        .into(),
    );
    let kept = serde_json::to_value(kept).unwrap();
    assert_eq!(kept["event"]["field"], "keptGeneratedMaps");
    assert_eq!(
        kept["event"]["value"],
        serde_json::json!(["neroxis_a", "neroxis_b"])
    );
}

#[test]
fn notification_updates_preserve_the_rust_history_cap_and_later_changes() {
    let mut state = AppState::default();
    let mut last = None;
    for id in 0..51 {
        last = Some(deliver(
            &mut state,
            NotificationEvent::Added {
                notification: ClientNotification {
                    id: id.to_string(),
                    kind: NotificationKind::FriendOnline,
                    title: "Online".into(),
                    body: String::new(),
                    created_at: String::new(),
                    read: false,
                    action: None,
                    text: None,
                },
            }
            .into(),
        ));
    }
    let FrontendUpdate::Notifications(snapshot) = last.unwrap() else {
        panic!("notification snapshot")
    };
    assert_eq!(snapshot.items.len(), 50);
    assert_eq!(snapshot.items[0].id, "50");
    assert_eq!(snapshot.items[49].id, "1");
    deliver(
        &mut state,
        NotificationEvent::Read { id: "50".into() }.into(),
    );
    assert!(
        !snapshot.items[0].read,
        "the queued update must keep its own reduction result"
    );
    assert!(state.notifications.items[0].read);
}

#[test]
fn preview_deltas_move_their_bytes_without_copying_or_resending_the_cache() {
    let mut state = AppState::default();
    let image = "x".repeat(1024 * 1024);
    let pointer = image.as_ptr();
    let event: AppEvent = MapGeneratorEvent::PreviewsLoaded {
        previews: HashMap::from([("example".into(), image)]),
    }
    .into();
    assert!(FrontendUpdate::capture(&state, &event).is_none());
    let FrontendUpdate::MapGenerator(event) = FrontendUpdate::from_delta(event).unwrap() else {
        panic!("preview delta")
    };
    let MapGeneratorEvent::PreviewsLoaded { previews } = event.as_ref() else {
        panic!("preview payload")
    };
    assert_eq!(previews["example"].as_ptr(), pointer);
    state.map_generator.previews = previews.clone();
    let progress: AppEvent = MapGeneratorEvent::StatusChanged {
        status: GeneratorStatus::Preparing,
    }
    .into();
    assert!(FrontendUpdate::capture(&state, &progress).is_none());
    let update = FrontendUpdate::from_delta(progress).unwrap();
    assert!(serde_json::to_vec(&update).unwrap().len() < 200);
}
