//! Companion programs through the service boundary: the settings reach the
//! process port, Test start runs the stored entry and nothing else, and what
//! the launcher reports becomes the result Settings shows and, for a failure,
//! a notification.
//!
//! Starting, skipping and closing the programs themselves is the launcher's
//! business and tested beside it (`infra::companions`).

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use faf_app::infra::fake_ports;
use faf_app::ports::{GameLaunchParams, InstallPresence, ProcessPort, SettingsPort};
use faf_app::{App, Ports};
use faf_domain::state::settings::{CompanionCommand, CompanionProgramPatch};
use faf_domain::state::{
    CompanionOutcome, CompanionProgram, CompanionRun, GamePreferences, SettingsCommand,
    SettingsState,
};
use tokio::sync::mpsc;

struct StoredSettings(SettingsState);

#[async_trait]
impl SettingsPort for StoredSettings {
    async fn load(&self) -> Option<SettingsState> {
        Some(self.0.clone())
    }

    async fn save(&self, _settings: &SettingsState) -> Result<(), String> {
        Ok(())
    }
}

/// A launcher that starts nothing: it records what it is told and asked,
/// and hands its report channel to whoever listens.
struct RecordingProcess {
    companions: Arc<Mutex<Vec<Vec<CompanionProgram>>>>,
    started: Arc<Mutex<Vec<CompanionProgram>>>,
    reports: Mutex<Option<mpsc::UnboundedReceiver<CompanionRun>>>,
}

#[async_trait]
impl ProcessPort for RecordingProcess {
    fn supports_live_launch(&self) -> bool {
        false
    }
    async fn launch_game(&self, _params: GameLaunchParams) -> Result<(), String> {
        Err("not used in this test".into())
    }
    async fn launch_offline(&self, _featured_mod: String, _map: String) -> Result<(), String> {
        Err("not used in this test".into())
    }
    async fn launch_replay(&self, _args: Vec<String>) -> Result<(), String> {
        Err("not used in this test".into())
    }
    fn kill(&self) {}
    fn set_paths(&self, _game_path: String, _replay_game_path: String) {}
    fn set_additional_arguments(&self, _arguments: Vec<String>) {}
    fn game_install_dir(&self) -> Option<PathBuf> {
        None
    }
    fn replay_install_dir(&self) -> Option<PathBuf> {
        None
    }
    fn installs_present(&self) -> InstallPresence {
        InstallPresence::default()
    }

    fn set_companions(&self, companions: Vec<CompanionProgram>) {
        self.companions.lock().unwrap().push(companions);
    }

    async fn start_companion(&self, companion: CompanionProgram) -> CompanionRun {
        self.started.lock().unwrap().push(companion.clone());
        CompanionRun {
            id: companion.id,
            name: companion.name,
            outcome: CompanionOutcome::Started { pid: 4242 },
            at: 1,
        }
    }

    async fn companion_reports(&self) -> mpsc::UnboundedReceiver<CompanionRun> {
        self.reports
            .lock()
            .unwrap()
            .take()
            .expect("the reports are asked for once")
    }
}

struct Harness {
    app: App,
    companions: Arc<Mutex<Vec<Vec<CompanionProgram>>>>,
    started: Arc<Mutex<Vec<CompanionProgram>>>,
    reports: mpsc::UnboundedSender<CompanionRun>,
}

fn helper() -> CompanionProgram {
    CompanionProgram {
        id: "helper".into(),
        name: "Helper".into(),
        program: "C:/Tools/helper.exe".into(),
        arguments: "\"C:/Settings/helper.ini\"".into(),
        enabled: false,
        ..CompanionProgram::default()
    }
}

async fn start(companions: Vec<CompanionProgram>) -> Harness {
    let recorded = Arc::new(Mutex::new(Vec::new()));
    let started = Arc::new(Mutex::new(Vec::new()));
    let (reports, receiver) = mpsc::unbounded_channel();
    let ports = Ports {
        settings: Arc::new(StoredSettings(SettingsState {
            game: GamePreferences {
                companions,
                // Off, so the startup cache pass cannot sweep a real cache.
                cache_lifetime_days: None,
                ..GamePreferences::default()
            },
            ..SettingsState::default()
        })),
        process: Arc::new(RecordingProcess {
            companions: recorded.clone(),
            started: started.clone(),
            reports: Mutex::new(Some(receiver)),
        }),
        ..fake_ports()
    };
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());
    app.dispatch_and_wait(SettingsCommand::Load.into())
        .await
        .unwrap();
    Harness {
        app,
        companions: recorded,
        started,
        reports,
    }
}

async fn until(app: &App, ready: impl Fn(&faf_domain::AppState) -> bool) {
    for _ in 0..200 {
        if ready(&app.snapshot()) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("the state never got there");
}

#[tokio::test]
async fn the_stored_companions_reach_the_launcher_and_so_does_every_change() {
    let harness = start(vec![helper()]).await;
    assert_eq!(
        harness.companions.lock().unwrap().last(),
        Some(&vec![helper()])
    );

    harness
        .app
        .dispatch_and_wait(
            SettingsCommand::AddCompanion {
                companion: CompanionProgram {
                    id: "second".into(),
                    ..CompanionProgram::default()
                },
            }
            .into(),
        )
        .await
        .unwrap();
    let pushed = harness.companions.lock().unwrap().last().cloned().unwrap();
    assert_eq!(pushed.len(), 2);
    assert_eq!(pushed[1].id, "second");
    assert_eq!(harness.app.snapshot().settings.game.companions, pushed);
}

fn base_of(entry: &CompanionProgram) -> CompanionCommand {
    CompanionCommand {
        program: entry.program.clone(),
        arguments: entry.arguments.clone(),
        working_dir: entry.working_dir.clone(),
    }
}

fn set_program(id: &str, base: Option<CompanionCommand>, program: &str) -> SettingsCommand {
    SettingsCommand::PatchCompanion {
        id: id.into(),
        base,
        patch: CompanionProgramPatch {
            program: Some(program.into()),
            arguments: Some("arbitrary arguments".into()),
            ..Default::default()
        },
    }
}

/// The settings service decides, at the moment it applies a change, whether
/// the change may alter what an entry runs: the shell's earlier check saw an
/// older list. Every way of reaching a command nobody confirmed for the entry
/// as it is now is refused there.
#[tokio::test]
async fn a_command_change_is_applied_only_to_the_entry_it_was_confirmed_for() {
    let harness = start(Vec::new()).await;
    let app = &harness.app;
    let stored = || app.snapshot().settings.game.companions;
    let run = |command: SettingsCommand| app.dispatch_and_wait(command.into());

    // A patch that raced an Add: the shell saw no entry, so it asked nothing.
    // Without a base it cannot change what the new entry runs.
    run(SettingsCommand::AddCompanion {
        companion: CompanionProgram {
            id: "new".into(),
            ..CompanionProgram::default()
        },
    })
    .await
    .unwrap();
    run(set_program("new", None, "C:/Tools/unconfirmed.exe"))
        .await
        .unwrap();
    assert_eq!(stored()[0].program, "", "refused: no base");

    // With the base the shell checked it against, it lands.
    run(set_program(
        "new",
        Some(base_of(&stored()[0])),
        "C:/Tools/confirmed.exe",
    ))
    .await
    .unwrap();
    assert_eq!(stored()[0].program, "C:/Tools/confirmed.exe");
    let confirmed = base_of(&stored()[0]);

    // A second change confirmed against the same, now stale, entry.
    run(set_program(
        "new",
        Some(CompanionCommand::default()),
        "C:/Tools/stale.exe",
    ))
    .await
    .unwrap();
    assert_eq!(
        stored()[0].program,
        "C:/Tools/confirmed.exe",
        "refused: stale base"
    );

    // Removed and made again under the same id: the old base no longer fits.
    run(SettingsCommand::RemoveCompanion { id: "new".into() })
        .await
        .unwrap();
    run(SettingsCommand::AddCompanion {
        companion: CompanionProgram {
            id: "new".into(),
            ..CompanionProgram::default()
        },
    })
    .await
    .unwrap();
    run(set_program(
        "new",
        Some(confirmed),
        "C:/Tools/confirmed.exe",
    ))
    .await
    .unwrap();
    assert_eq!(stored()[0].program, "", "refused: a different entry now");

    // No entry at all, an Add that brings a program, a duplicate id, and a
    // whole list through the game settings: all leave the list alone.
    run(set_program(
        "absent",
        Some(CompanionCommand::default()),
        "C:/Tools/x.exe",
    ))
    .await
    .unwrap();
    run(SettingsCommand::AddCompanion {
        companion: CompanionProgram {
            id: "loaded".into(),
            program: "C:/Tools/x.exe".into(),
            ..CompanionProgram::default()
        },
    })
    .await
    .unwrap();
    run(SettingsCommand::AddCompanion {
        companion: CompanionProgram {
            id: "new".into(),
            ..CompanionProgram::default()
        },
    })
    .await
    .unwrap();
    run(SettingsCommand::PatchGame {
        patch: Box::new(faf_domain::state::settings::GamePreferencesPatch {
            companions: Some(vec![CompanionProgram {
                id: "listed".into(),
                program: "C:/Tools/x.exe".into(),
                ..CompanionProgram::default()
            }]),
            ..Default::default()
        }),
    })
    .await
    .unwrap();
    let ids: Vec<String> = stored().iter().map(|entry| entry.id.clone()).collect();
    assert_eq!(ids, ["new"]);
    assert!(!stored()[0].has_command());
}

#[tokio::test]
async fn test_start_runs_the_stored_entry_switched_off_or_not() {
    let harness = start(vec![helper()]).await;
    harness
        .app
        .dispatch_and_wait(
            SettingsCommand::TestCompanion {
                id: "helper".into(),
                expected: None,
            }
            .into(),
        )
        .await
        .unwrap();
    assert_eq!(*harness.started.lock().unwrap(), vec![helper()]);
    let reported = harness.app.snapshot().install.companions;
    assert_eq!(reported.len(), 1);
    assert_eq!(reported[0].outcome, CompanionOutcome::Started { pid: 4242 });

    // An id with no entry starts nothing: the page cannot name a program.
    harness
        .app
        .dispatch_and_wait(
            SettingsCommand::TestCompanion {
                id: "other".into(),
                expected: None,
            }
            .into(),
        )
        .await
        .unwrap();
    assert_eq!(harness.started.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_launch_report_is_recorded_and_only_a_failure_raises_a_notification() {
    let harness = start(vec![helper()]).await;
    let raised_for_companions = |state: &faf_domain::AppState| {
        state
            .notifications
            .items
            .iter()
            .filter(|item| {
                item.text
                    .as_ref()
                    .is_some_and(|text| text.key == "notifications.msg.companionFailed")
            })
            .count()
    };

    harness
        .reports
        .send(CompanionRun {
            id: "helper".into(),
            name: "Helper".into(),
            outcome: CompanionOutcome::AlreadyRunning { pid: 7 },
            at: 2,
        })
        .unwrap();
    until(&harness.app, |state| !state.install.companions.is_empty()).await;
    assert_eq!(raised_for_companions(&harness.app.snapshot()), 0);

    harness
        .reports
        .send(CompanionRun {
            id: "helper".into(),
            name: "Helper".into(),
            outcome: CompanionOutcome::Failed {
                reason: "the program was not found".into(),
            },
            at: 3,
        })
        .unwrap();
    until(&harness.app, |state| {
        state
            .install
            .companions
            .iter()
            .any(|run| run.outcome.is_failure())
    })
    .await;
    let state = harness.app.snapshot();
    assert_eq!(state.install.companions.len(), 1, "one result per entry");
    assert_eq!(raised_for_companions(&state), 1);
    let raised = state
        .notifications
        .items
        .iter()
        .find(|item| item.title.ends_with("did not start"))
        .unwrap();
    assert_eq!(raised.title, "Helper did not start");
    assert_eq!(raised.body, "the program was not found");
    let text = raised.text.as_ref().unwrap();
    assert_eq!(text.key, "notifications.msg.companionFailed");
    assert_eq!(text.params.get("name").map(String::as_str), Some("Helper"));
}

#[tokio::test]
async fn two_quick_changes_to_one_entry_both_survive_and_add_and_remove_touch_only_their_own() {
    let harness = start(vec![helper()]).await;
    let patch = |patch: CompanionProgramPatch| SettingsCommand::PatchCompanion {
        id: "helper".into(),
        base: None,
        patch,
    };
    // Both built from the same page state, sent one after the other: with
    // whole lists the second would carry the first's old value back.
    let (first, second) = tokio::join!(
        harness.app.dispatch_and_wait(
            patch(CompanionProgramPatch {
                enabled: Some(true),
                ..Default::default()
            })
            .into()
        ),
        harness.app.dispatch_and_wait(
            patch(CompanionProgramPatch {
                close_with_game: Some(true),
                ..Default::default()
            })
            .into()
        ),
    );
    first.unwrap();
    second.unwrap();
    let stored = &harness.app.snapshot().settings.game.companions[0];
    assert!(stored.enabled && stored.close_with_game);
    assert_eq!(
        stored.program,
        helper().program,
        "the rest of the entry is untouched"
    );

    // The id is never changed by a patch.
    harness
        .app
        .dispatch_and_wait(
            patch(CompanionProgramPatch {
                id: Some("elsewhere".into()),
                ..Default::default()
            })
            .into(),
        )
        .await
        .unwrap();
    assert_eq!(
        harness.app.snapshot().settings.game.companions[0].id,
        "helper"
    );

    harness
        .app
        .dispatch_and_wait(
            SettingsCommand::AddCompanion {
                companion: CompanionProgram {
                    id: "second".into(),
                    ..CompanionProgram::default()
                },
            }
            .into(),
        )
        .await
        .unwrap();
    harness
        .app
        .dispatch_and_wait(
            SettingsCommand::RemoveCompanion {
                id: "helper".into(),
            }
            .into(),
        )
        .await
        .unwrap();
    let ids: Vec<String> = harness
        .app
        .snapshot()
        .settings
        .game
        .companions
        .iter()
        .map(|entry| entry.id.clone())
        .collect();
    assert_eq!(ids, ["second"]);
    // And the launcher was handed the result.
    assert_eq!(
        harness
            .companions
            .lock()
            .unwrap()
            .last()
            .map(|list| list.len()),
        Some(1)
    );
}

/// Counts what replay playback asks of the launcher around a replacement.
#[derive(Default)]
struct ReplacementProcess {
    stopped: std::sync::atomic::AtomicUsize,
    released: std::sync::atomic::AtomicUsize,
}

#[async_trait]
impl ProcessPort for ReplacementProcess {
    fn supports_live_launch(&self) -> bool {
        false
    }
    async fn launch_game(&self, _params: GameLaunchParams) -> Result<(), String> {
        Err("not used in this test".into())
    }
    async fn launch_offline(&self, _featured_mod: String, _map: String) -> Result<(), String> {
        Err("not used in this test".into())
    }
    async fn launch_replay(&self, _args: Vec<String>) -> Result<(), String> {
        Err("not used in this test".into())
    }
    fn kill(&self) {}
    fn set_paths(&self, _game_path: String, _replay_game_path: String) {}
    fn set_additional_arguments(&self, _arguments: Vec<String>) {}
    fn game_install_dir(&self) -> Option<PathBuf> {
        None
    }
    fn replay_install_dir(&self) -> Option<PathBuf> {
        None
    }
    fn installs_present(&self) -> InstallPresence {
        InstallPresence::default()
    }
    async fn stop_replay(&self) {
        self.stopped
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }
    fn release_replay_replacement(&self) {
        self.released
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Opening a replay stops the one playing first. When the new one then fails
/// to open, the stopped one's companion programs must be let go, or a
/// close-with-game companion has nothing left to close it.
#[tokio::test]
async fn a_replay_that_fails_to_open_lets_the_stopped_replays_companions_go() {
    use faf_app::ports::ReplayPlaybackPort;
    let process = Arc::new(ReplacementProcess::default());
    let adapters = faf_app::infra::ReplayAdapters::faf(
        faf_app::infra::TokenStore::default(),
        process.clone(),
        Arc::new(faf_app::infra::FakeMapGenerator),
    );
    let missing = std::env::temp_dir().join("faf-companion-test-missing.fafreplay");
    assert!(adapters.playback.play_file(missing).await.is_err());
    assert_eq!(process.stopped.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert_eq!(
        process.released.load(std::sync::atomic::Ordering::SeqCst),
        1
    );
}

/// A Test start after an edit names the command the page showed. When the
/// edit was refused (overtaken by another change), what is stored is not what
/// the player asked to start, and nothing starts; the refusal is shown.
#[tokio::test]
async fn a_test_start_after_a_refused_edit_starts_nothing_and_says_why() {
    let harness = start(vec![helper()]).await;
    let app = &harness.app;
    let typed = CompanionCommand {
        program: "C:/Tools/typed.exe".into(),
        ..base_of(&helper())
    };
    // The edit was made against a command the entry no longer runs.
    app.dispatch_and_wait(
        SettingsCommand::PatchCompanion {
            id: "helper".into(),
            base: Some(CompanionCommand::default()),
            patch: CompanionProgramPatch {
                program: Some(typed.program.clone()),
                ..Default::default()
            },
        }
        .into(),
    )
    .await
    .unwrap();
    let state = app.snapshot();
    assert_eq!(state.settings.game.companions[0].program, helper().program);
    assert!(state.notifications.items.iter().any(|item| item
        .text
        .as_ref()
        .is_some_and(|text| text.key == "notifications.msg.companionChangeRefused")));

    // The Test start that follows asks for the typed command: not stored, so
    // the stored one is not started in its place.
    app.dispatch_and_wait(
        SettingsCommand::TestCompanion {
            id: "helper".into(),
            expected: Some(typed),
        }
        .into(),
    )
    .await
    .unwrap();
    assert!(harness.started.lock().unwrap().is_empty());
    let reported = &app.snapshot().install.companions;
    assert!(reported[0].outcome.is_failure());

    // Asking for what is stored starts it.
    app.dispatch_and_wait(
        SettingsCommand::TestCompanion {
            id: "helper".into(),
            expected: Some(base_of(&helper())),
        }
        .into(),
    )
    .await
    .unwrap();
    assert_eq!(harness.started.lock().unwrap().len(), 1);
}

/// A launcher whose stop never finishes: the old replay window is slow to
/// close, and the request opening the next one is called off meanwhile.
#[derive(Default)]
struct StuckStopProcess {
    inner: ReplacementProcess,
    stop_begun: tokio::sync::Notify,
}

#[async_trait]
impl ProcessPort for StuckStopProcess {
    fn supports_live_launch(&self) -> bool {
        false
    }
    async fn launch_game(&self, _params: GameLaunchParams) -> Result<(), String> {
        Err("not used in this test".into())
    }
    async fn launch_offline(&self, _featured_mod: String, _map: String) -> Result<(), String> {
        Err("not used in this test".into())
    }
    async fn launch_replay(&self, _args: Vec<String>) -> Result<(), String> {
        Err("not used in this test".into())
    }
    fn kill(&self) {}
    fn set_paths(&self, _game_path: String, _replay_game_path: String) {}
    fn set_additional_arguments(&self, _arguments: Vec<String>) {}
    fn game_install_dir(&self) -> Option<PathBuf> {
        None
    }
    fn replay_install_dir(&self) -> Option<PathBuf> {
        None
    }
    fn installs_present(&self) -> InstallPresence {
        InstallPresence::default()
    }
    async fn stop_replay(&self) {
        self.inner.stop_replay().await;
        self.stop_begun.notify_one();
        std::future::pending::<()>().await;
    }
    fn release_replay_replacement(&self) {
        self.inner.release_replay_replacement();
    }
}

/// Both ways of opening a replay, called off while the previous replay is
/// still being stopped, let its companion programs go.
#[tokio::test]
async fn a_replay_request_called_off_during_the_stop_lets_the_companions_go() {
    use faf_app::ports::ReplayPlaybackPort;
    for live in [false, true] {
        let process = Arc::new(StuckStopProcess::default());
        let adapters = Arc::new(faf_app::infra::ReplayAdapters::faf(
            faf_app::infra::TokenStore::default(),
            process.clone(),
            Arc::new(faf_app::infra::FakeMapGenerator),
        ));
        let request = {
            let adapters = Arc::clone(&adapters);
            tokio::spawn(async move {
                if live {
                    let target = faf_domain::state::LiveReplayTarget {
                        uid: 1,
                        mod_name: "faf".into(),
                        map: "scmp_009".into(),
                    };
                    let _ = adapters.playback.watch_live(target, "player".into()).await;
                } else {
                    let missing = std::env::temp_dir().join("faf-companion-test-stuck.fafreplay");
                    let _ = adapters.playback.play_file(missing).await;
                }
            })
        };
        process.stop_begun.notified().await;
        request.abort();
        let _ = request.await;
        let released = process
            .inner
            .released
            .load(std::sync::atomic::Ordering::SeqCst);
        assert_eq!(released, 1, "live: {live}");
    }
}
