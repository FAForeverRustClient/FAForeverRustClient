//! A generator preset save is answered for the request that made it, so the
//! dialog can say "Saved" for its own save and nothing else.

use faf_app::infra::fake_ports;
use faf_app::App;
use faf_domain::state::{GeneratorOptions, MapGeneratorCommand};

#[tokio::test]
async fn a_saved_preset_is_answered_by_its_request_id() {
    let (app, app_loop) = App::new("test", fake_ports());
    tokio::spawn(app_loop.run());

    app.dispatch_and_wait(
        MapGeneratorCommand::SavePreset {
            name: "Team Ladder".into(),
            options: GeneratorOptions::default(),
            request_id: 9,
        }
        .into(),
    )
    .await
    .unwrap();

    let answer = app.snapshot().map_generator.preset_save;
    assert_eq!(
        answer.map(|outcome| (outcome.request_id, outcome.saved)),
        Some((9, true))
    );
}
