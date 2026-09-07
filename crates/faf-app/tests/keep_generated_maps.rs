//! Whether a finished generator run's maps are spared by the Maps tab's sweep.
//!
//! This used to be a checkbox inside the Generate map dialog, answered once per
//! run at the moment nobody has yet seen the maps. It is one standing
//! preference now, and these pin both halves of that: off, a run leaves no
//! trace in the kept list; on, it records what it produced, so the sweep has
//! something to spare.
//!
//! Names rather than the switch alone is the part worth a test of its own:
//! turning the switch off later must not retroactively condemn maps that were
//! kept while it was on.

use faf_app::infra::fake_ports;
use faf_app::App;
use faf_domain::protocol::map_generator::GeneratorOptions;
use faf_domain::state::{GamePreferences, MapGeneratorCommand, SettingsCommand};

/// What `FakeMapGenerator` reports a successful run produced.
const OFFLINE_MAP: &str = "neroxis_map_generator_1.7.7_offline";

async fn app() -> App {
    let (app, app_loop) = App::new("test", fake_ports());
    tokio::spawn(app_loop.run());
    app
}

async fn generate(app: &App) {
    app.dispatch_and_wait(
        MapGeneratorCommand::Generate {
            options: GeneratorOptions::default(),
        }
        .into(),
    )
    .await
    .unwrap();
}

async fn set_keep(app: &App, keep: bool) {
    app.dispatch_and_wait(
        SettingsCommand::SetGame {
            preferences: GamePreferences {
                keep_generated_maps: keep,
                ..GamePreferences::default()
            },
        }
        .into(),
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn a_run_keeps_nothing_by_default() {
    let app = app().await;
    assert!(
        !app.snapshot().settings.game.keep_generated_maps,
        "a generated map is disposable until somebody says otherwise",
    );

    generate(&app).await;

    assert!(
        app.snapshot().settings.kept_generated_maps.is_empty(),
        "nothing asked for these maps to be kept",
    );
}

#[tokio::test]
async fn the_standing_preference_records_what_a_run_produced() {
    let app = app().await;
    set_keep(&app, true).await;

    generate(&app).await;

    assert_eq!(
        app.snapshot().settings.kept_generated_maps,
        vec![OFFLINE_MAP.to_string()],
    );
}

#[tokio::test]
async fn turning_the_preference_off_leaves_what_was_already_kept() {
    let app = app().await;
    set_keep(&app, true).await;
    generate(&app).await;

    set_keep(&app, false).await;
    generate(&app).await;

    assert_eq!(
        app.snapshot().settings.kept_generated_maps,
        vec![OFFLINE_MAP.to_string()],
        "the second run adds nothing, and the first run's map is not withdrawn",
    );
}
