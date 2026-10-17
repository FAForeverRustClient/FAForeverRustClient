//! Client self-update, end to end through the loop.
//!
//! The domain owns the version comparison and has its own tests; what those
//! cannot show is that the running build's version reaches it, that the
//! channel preference reaches the port, and that "install" can only ever run
//! the file this client downloaded. Below those, the same for the release
//! notes and the What's new popup: that the startup decision reads the stored
//! version, that a fresh install has the running build recorded, and that a
//! popup is recorded only once it is dismissed.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use faf_app::infra::{fake_ports, FakeClientUpdates};
use faf_app::ports::{ClientUpdatePort, DownloadProgress, SettingsPort};
use faf_app::{App, Ports};
use faf_domain::state::{
    ClientRelease, ClientReleaseNotes, ClientReleaseNotesStatus, ClientUpdateCommand,
    ClientUpdateState, ClientUpdateStatus, ReleaseChannel, SettingsCommand, SettingsState,
    UpdatePreferences,
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// What the stub was asked to do, in order.
#[derive(Debug, Default)]
struct Calls {
    channels: Vec<ReleaseChannel>,
    downloaded: Vec<String>,
    installed: Vec<String>,
}

struct StubUpdates {
    calls: Arc<Mutex<Calls>>,
    latest: Result<Option<ClientRelease>, String>,
    /// The path a successful download reports, or the failure to report.
    download: Result<String, String>,
}

#[async_trait]
impl ClientUpdatePort for StubUpdates {
    async fn latest(&self, channel: ReleaseChannel) -> Result<Option<ClientRelease>, String> {
        self.calls.lock().unwrap().channels.push(channel);
        self.latest.clone()
    }

    async fn download(
        &self,
        release: ClientRelease,
        _called_off: CancellationToken,
    ) -> mpsc::Receiver<DownloadProgress> {
        self.calls.lock().unwrap().downloaded.push(release.version);
        let (tx, rx) = mpsc::channel(8);
        let outcome = self.download.clone();
        tokio::spawn(async move {
            let _ = tx
                .send(DownloadProgress::Received {
                    received_bytes: 512,
                    total_bytes: 1024,
                })
                .await;
            let _ = tx.send(DownloadProgress::Finished(outcome)).await;
        });
        rx
    }

    async fn install(&self, path: String) -> Result<(), String> {
        self.calls.lock().unwrap().installed.push(path);
        Ok(())
    }
}

/// A port that must never be reached.
struct ForbiddenUpdates;

#[async_trait]
impl ClientUpdatePort for ForbiddenUpdates {
    async fn latest(&self, _channel: ReleaseChannel) -> Result<Option<ClientRelease>, String> {
        panic!("no check should have been made");
    }
    async fn download(
        &self,
        _release: ClientRelease,
        _called_off: CancellationToken,
    ) -> mpsc::Receiver<DownloadProgress> {
        panic!("no download should have been started");
    }
    async fn install(&self, path: String) -> Result<(), String> {
        panic!("no installer should have been started ({path})");
    }
}

struct Harness {
    app: App,
    calls: Arc<Mutex<Calls>>,
}

fn release(version: &str) -> ClientRelease {
    ClientRelease {
        version: version.into(),
        notes_url: format!("https://example.invalid/releases/{version}"),
        download_url: "https://example.invalid/installer".into(),
        asset_name: "installer".into(),
        size_bytes: 1024,
        pre_release: false,
        published_at: "2026-02-01T00:00:00Z".into(),
    }
}

/// `version` is the *running* client's version: the thing every comparison in
/// this feature is made against.
fn harness(
    version: &str,
    latest: Result<Option<ClientRelease>, String>,
    download: Result<String, String>,
) -> Harness {
    let calls = Arc::new(Mutex::new(Calls::default()));
    let ports = Ports {
        client_update: Arc::new(StubUpdates {
            calls: calls.clone(),
            latest,
            download,
        }),
        ..fake_ports()
    };
    let (app, app_loop) = App::new(version, ports);
    tokio::spawn(app_loop.run());
    Harness { app, calls }
}

async fn settle(app: &App, condition: impl Fn(&ClientUpdateState) -> bool, what: &str) {
    for _ in 0..300 {
        if condition(&app.snapshot().client_update) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!(
        "timed out waiting for {what}: {:?}",
        app.snapshot().client_update
    );
}

#[tokio::test]
async fn a_newer_release_is_offered_with_its_notes() {
    let h = harness("0.2.0", Ok(Some(release("0.3.0"))), Ok("installer".into()));
    h.app
        .dispatch(ClientUpdateCommand::Check.into())
        .await
        .unwrap();

    settle(
        &h.app,
        |state| state.status == ClientUpdateStatus::Available,
        "the offer",
    )
    .await;

    let state = h.app.snapshot().client_update;
    assert_eq!(state.current_version, "0.2.0");
    let offered = state.banner_release().expect("a banner release");
    assert_eq!(offered.version, "0.3.0");
    assert!(offered.notes_url.contains("0.3.0"));
}

#[tokio::test]
async fn an_older_release_is_reported_as_up_to_date_rather_than_offered() {
    // The check is a comparison, not "is there a release": a client ahead of
    // the newest published tag must not be told to downgrade.
    let h = harness("0.9.0", Ok(Some(release("0.3.0"))), Ok("installer".into()));
    h.app
        .dispatch(ClientUpdateCommand::Check.into())
        .await
        .unwrap();

    settle(
        &h.app,
        |state| state.status == ClientUpdateStatus::UpToDate,
        "the up-to-date result",
    )
    .await;
    assert_eq!(h.app.snapshot().client_update.release, None);
}

#[tokio::test]
async fn update_notice_fresh_offer_respects_background_download_setting() {
    for enabled in [false, true] {
        let mut candidate = release("0.3.0");
        candidate.published_at = chrono::Utc::now().to_rfc3339();
        let h = harness("0.2.0", Ok(Some(candidate)), Ok("installer".into()));
        h.app
            .dispatch_and_wait(
                SettingsCommand::PatchUpdates {
                    patch: UpdatePreferences {
                        background_download: enabled,
                        ..Default::default()
                    }
                    .into(),
                }
                .into(),
            )
            .await
            .unwrap();
        h.app
            .dispatch_and_wait(ClientUpdateCommand::Check.into())
            .await
            .unwrap();
        let state = h.app.snapshot().client_update;
        assert!(!state.overdue);
        assert_eq!(
            h.calls.lock().unwrap().downloaded.len(),
            usize::from(enabled)
        );
        if enabled {
            assert!(matches!(state.status, ClientUpdateStatus::Ready { .. }));
        } else {
            assert_eq!(state.status, ClientUpdateStatus::Available);
        }
    }
}

#[tokio::test]
async fn a_development_build_is_never_offered_an_update() {
    // `App::new("test", …)` is what every test and every `cargo run` produces.
    // Offering an installer over a local build would be actively destructive.
    let h = harness("test", Ok(Some(release("9.9.9"))), Ok("installer".into()));
    h.app
        .dispatch(ClientUpdateCommand::Check.into())
        .await
        .unwrap();

    settle(
        &h.app,
        |state| state.status == ClientUpdateStatus::UpToDate,
        "the refusal to offer",
    )
    .await;
    assert_eq!(h.app.snapshot().client_update.banner_release(), None);
}

#[tokio::test]
async fn a_failed_check_is_not_reported_as_up_to_date() {
    // The distinction that matters: an unreachable release list must not look
    // like a client that is current.
    let h = harness("0.2.0", Err("github unreachable".into()), Ok("x".into()));
    h.app
        .dispatch(ClientUpdateCommand::Check.into())
        .await
        .unwrap();

    settle(
        &h.app,
        |state| matches!(state.status, ClientUpdateStatus::Failed { .. }),
        "the failure",
    )
    .await;
    match h.app.snapshot().client_update.status {
        ClientUpdateStatus::Failed { reason } => assert!(reason.contains("unreachable")),
        other => panic!("expected a failure, got {other:?}"),
    }
}

#[tokio::test]
async fn downloading_reports_progress_and_then_the_installer_path() {
    let h = harness(
        "0.2.0",
        Ok(Some(release("0.3.0"))),
        Ok("/tmp/faf-client-0.3.0".into()),
    );
    h.app
        .dispatch(ClientUpdateCommand::Check.into())
        .await
        .unwrap();
    settle(
        &h.app,
        |state| state.status == ClientUpdateStatus::Available,
        "the offer",
    )
    .await;

    h.app
        .dispatch(ClientUpdateCommand::Download.into())
        .await
        .unwrap();
    settle(
        &h.app,
        |state| matches!(state.status, ClientUpdateStatus::Ready { .. }),
        "the download",
    )
    .await;

    assert_eq!(
        h.calls.lock().unwrap().downloaded,
        vec!["0.3.0".to_string()]
    );
    match h.app.snapshot().client_update.status {
        ClientUpdateStatus::Ready { path } => assert_eq!(path, "/tmp/faf-client-0.3.0"),
        other => panic!("expected a ready installer, got {other:?}"),
    }
}

#[tokio::test]
async fn installing_runs_exactly_the_file_that_was_downloaded() {
    // The path is never a command parameter, so the UI cannot ask the backend
    // to execute something else.
    let h = harness(
        "0.2.0",
        Ok(Some(release("0.3.0"))),
        Ok("/tmp/faf-client-0.3.0".into()),
    );
    h.app
        .dispatch(ClientUpdateCommand::Check.into())
        .await
        .unwrap();
    settle(
        &h.app,
        |state| state.status == ClientUpdateStatus::Available,
        "the offer",
    )
    .await;
    h.app
        .dispatch(ClientUpdateCommand::Download.into())
        .await
        .unwrap();
    settle(
        &h.app,
        |state| matches!(state.status, ClientUpdateStatus::Ready { .. }),
        "the download",
    )
    .await;

    h.app
        .dispatch(ClientUpdateCommand::Install.into())
        .await
        .unwrap();
    settle(
        &h.app,
        |state| state.status == ClientUpdateStatus::Installing,
        "the install",
    )
    .await;

    assert_eq!(
        h.calls.lock().unwrap().installed,
        vec!["/tmp/faf-client-0.3.0".to_string()]
    );
}

#[tokio::test]
async fn install_does_nothing_when_no_installer_has_been_downloaded() {
    let ports = Ports {
        client_update: Arc::new(ForbiddenUpdates),
        ..fake_ports()
    };
    let (app, app_loop) = App::new("0.2.0", ports);
    tokio::spawn(app_loop.run());

    app.dispatch(ClientUpdateCommand::Install.into())
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(60)).await;
    assert_eq!(
        app.snapshot().client_update.status,
        ClientUpdateStatus::Idle
    );
}

#[tokio::test]
async fn a_release_with_no_installer_for_this_platform_fails_with_a_reason() {
    let mut without_asset = release("0.3.0");
    without_asset.download_url = String::new();
    without_asset.asset_name = String::new();
    let h = harness("0.2.0", Ok(Some(without_asset)), Ok("x".into()));

    h.app
        .dispatch(ClientUpdateCommand::Check.into())
        .await
        .unwrap();
    settle(
        &h.app,
        |state| state.status == ClientUpdateStatus::Available,
        "the offer",
    )
    .await;

    h.app
        .dispatch(ClientUpdateCommand::Download.into())
        .await
        .unwrap();
    settle(
        &h.app,
        |state| matches!(state.status, ClientUpdateStatus::Failed { .. }),
        "the refusal",
    )
    .await;

    // The port was never asked to fetch something that does not exist.
    assert!(h.calls.lock().unwrap().downloaded.is_empty());
    // …and the release stays on offer so the notes link still works.
    assert!(h.app.snapshot().client_update.banner_release().is_some());
}

#[tokio::test]
async fn dismissing_hides_the_banner_without_forgetting_the_release() {
    let h = harness("0.2.0", Ok(Some(release("0.3.0"))), Ok("x".into()));
    h.app
        .dispatch(ClientUpdateCommand::Check.into())
        .await
        .unwrap();
    settle(
        &h.app,
        |state| state.status == ClientUpdateStatus::Available,
        "the offer",
    )
    .await;

    h.app
        .dispatch(ClientUpdateCommand::Dismiss.into())
        .await
        .unwrap();
    settle(
        &h.app,
        |state| state.dismissed_version == "0.3.0",
        "the dismissal",
    )
    .await;

    let state = h.app.snapshot().client_update;
    assert_eq!(state.banner_release(), None, "the banner is gone");
    assert!(
        state.release.is_some(),
        "Settings still shows what is available"
    );
}

#[tokio::test]
async fn the_startup_check_runs_when_settings_load() {
    let h = harness("0.2.0", Ok(Some(release("0.3.0"))), Ok("x".into()));
    h.app.dispatch(SettingsCommand::Load.into()).await.unwrap();

    settle(
        &h.app,
        |state| state.status == ClientUpdateStatus::Available,
        "the automatic check",
    )
    .await;
    // Default settings offer prereleases: every release so far is one.
    assert_eq!(
        h.calls.lock().unwrap().channels,
        vec![ReleaseChannel::PreRelease]
    );
}

/// Whether the notification centre carries an update announcement.
///
/// By kind rather than by count: anything else adding a notification would
/// otherwise satisfy one of these tests and break the other.
fn announced(app: &App) -> bool {
    app.snapshot()
        .notifications
        .items
        .iter()
        .any(|item| item.kind == faf_domain::state::NotificationKind::ClientUpdate)
}

/// An app whose stored settings turn optional announcements off, and whose
/// update port answers with `latest`.
///
/// The preference has to be *stored*, not merely set: `Load` replaces the
/// whole settings slice from the port, so anything reading it after startup
/// must read the post-load value. Setting it in-session and then loading would
/// silently put the default back, which is what an earlier version of this
/// test did, and it caught it.
async fn announcements_off(latest: Result<Option<ClientRelease>, String>) -> Harness {
    let stored = faf_domain::state::SettingsState {
        updates: UpdatePreferences {
            automatic: false,
            pre_release: false,
            ..UpdatePreferences::default()
        },
        ..Default::default()
    };
    let calls = Arc::new(Mutex::new(Calls::default()));
    let ports = Ports {
        client_update: Arc::new(StubUpdates {
            calls: calls.clone(),
            latest,
            download: Ok("installer".into()),
        }),
        settings: Arc::new(faf_app::infra::FakeSettings { initial: stored }),
        ..fake_ports()
    };
    let (app, app_loop) = App::new("0.2.0", ports);
    tokio::spawn(app_loop.run());

    app.dispatch(SettingsCommand::Load.into()).await.unwrap();
    for _ in 0..300 {
        if !app.snapshot().settings.updates.automatic {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(!app.snapshot().settings.updates.automatic, "load applied");
    Harness { app, calls }
}

#[tokio::test]
async fn the_startup_check_runs_whatever_the_announcement_preference_says() {
    // This used to be the opposite test: the preference turned the startup
    // check off entirely, and `ForbiddenUpdates` panicked if it ran. That was
    // defensible while an update was only ever an offer. It stopped being
    // defensible once a release the client can install itself became a gate,
    // because a security update a checkbox switches off is not one.
    let h = announcements_off(Ok(Some(release("0.3.0")))).await;
    settle(
        &h.app,
        |state| state.status == ClientUpdateStatus::Available,
        "the startup check",
    )
    .await;
    assert_eq!(
        h.calls.lock().unwrap().channels,
        vec![ReleaseChannel::Stable]
    );
}

#[tokio::test]
async fn an_optional_update_is_not_announced_when_announcements_are_off() {
    // No installer for this platform, so the client cannot insist on it: this
    // is exactly the update somebody turning announcements off meant.
    let mut optional = release("0.3.0");
    optional.download_url = String::new();
    optional.published_at = chrono::Utc::now().to_rfc3339();
    let h = announcements_off(Ok(Some(optional))).await;

    settle(
        &h.app,
        |state| state.status == ClientUpdateStatus::Available,
        "the startup check",
    )
    .await;
    tokio::time::sleep(Duration::from_millis(60)).await;
    assert!(
        !announced(&h.app),
        "an optional update reached the notification centre anyway",
    );
}

#[tokio::test]
async fn a_required_update_is_announced_even_when_announcements_are_off() {
    // They are about to meet a dialog they cannot dismiss. Meeting it with no
    // idea why would be worse than one notification they did not ask for.
    let h = announcements_off(Ok(Some(release("0.3.0")))).await;

    settle(
        &h.app,
        |state| state.status == ClientUpdateStatus::Available,
        "the startup check",
    )
    .await;
    for _ in 0..300 {
        if announced(&h.app) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("a required update was never announced");
}

#[tokio::test]
async fn the_opt_out_is_a_preference_the_settings_page_can_change() {
    let h = harness("0.2.0", Ok(None), Ok("x".into()));
    h.app
        .dispatch(
            SettingsCommand::PatchUpdates {
                patch: UpdatePreferences {
                    automatic: false,
                    pre_release: false,
                    ..UpdatePreferences::default()
                }
                .into(),
            }
            .into(),
        )
        .await
        .unwrap();

    for _ in 0..300 {
        if !h.app.snapshot().settings.updates.automatic {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("the preference never reached the state the UI renders from");
}

#[tokio::test]
async fn the_prerelease_preference_selects_the_channel_the_port_is_asked_for() {
    // Java picks between two entirely different tasks here; the equivalent
    // mistake for us is silently always asking for stable.
    let h = harness("0.2.0", Ok(None), Ok("x".into()));
    h.app
        .dispatch(
            SettingsCommand::PatchUpdates {
                patch: UpdatePreferences {
                    automatic: true,
                    pre_release: true,
                    ..UpdatePreferences::default()
                }
                .into(),
            }
            .into(),
        )
        .await
        .unwrap();
    for _ in 0..300 {
        if h.app.snapshot().settings.updates.pre_release {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    h.app
        .dispatch(ClientUpdateCommand::Check.into())
        .await
        .unwrap();
    settle(
        &h.app,
        |state| state.status == ClientUpdateStatus::UpToDate,
        "the check",
    )
    .await;

    assert_eq!(
        h.calls.lock().unwrap().channels,
        vec![ReleaseChannel::PreRelease]
    );
}

// ── Release notes and What's new ────────────────────────────────────────────

/// What the notes stub was asked, in total.
#[derive(Debug, Default)]
struct NotesCalls {
    checks: usize,
    notes_loads: usize,
}

/// A release source that keeps the notes of the list it read, the way the
/// real adapter does: after a check that reached the list they are in memory,
/// and before one they are not.
struct NotesUpdates {
    latest: Result<Option<ClientRelease>, String>,
    notes: Vec<ClientReleaseNotes>,
    read: Mutex<bool>,
    calls: Arc<Mutex<NotesCalls>>,
}

#[async_trait]
impl ClientUpdatePort for NotesUpdates {
    async fn latest(&self, _channel: ReleaseChannel) -> Result<Option<ClientRelease>, String> {
        self.calls.lock().unwrap().checks += 1;
        if self.latest.is_ok() {
            *self.read.lock().unwrap() = true;
        }
        self.latest.clone()
    }

    async fn release_notes(&self) -> Result<Vec<ClientReleaseNotes>, String> {
        self.calls.lock().unwrap().notes_loads += 1;
        Ok(self.notes.clone())
    }

    fn cached_release_notes(&self) -> Option<Vec<ClientReleaseNotes>> {
        (*self.read.lock().unwrap()).then(|| self.notes.clone())
    }

    async fn download(
        &self,
        release: ClientRelease,
        called_off: CancellationToken,
    ) -> mpsc::Receiver<DownloadProgress> {
        FakeClientUpdates.download(release, called_off).await
    }

    async fn install(&self, path: String) -> Result<(), String> {
        FakeClientUpdates.install(path).await
    }
}

/// A settings file holding `updates`, which records every write. `None` is no
/// settings file at all: a fresh install.
struct RecordingSettings {
    updates: Option<UpdatePreferences>,
    saved: Arc<Mutex<Vec<SettingsState>>>,
}

#[async_trait]
impl SettingsPort for RecordingSettings {
    async fn load(&self) -> Option<SettingsState> {
        Some(SettingsState {
            updates: self.updates.clone()?,
            // Off, so the startup cache pass these tests run cannot sweep the
            // real game-files cache of whoever runs the suite.
            game: faf_domain::state::GamePreferences {
                cache_lifetime_days: None,
                ..faf_domain::state::GamePreferences::default()
            },
            ..SettingsState::default()
        })
    }

    async fn save(&self, settings: &SettingsState) -> Result<(), String> {
        self.saved.lock().unwrap().push(settings.clone());
        Ok(())
    }
}

fn release_notes(version: &str) -> ClientReleaseNotes {
    ClientReleaseNotes {
        version: version.into(),
        published_at: Some("2026-02-01T00:00:00Z".into()),
        pre_release: true,
        notes_url: format!("https://example.invalid/releases/tag/v{version}"),
        blocks: vec![],
        required: false,
    }
}

struct StartedHarness {
    app: App,
    calls: Arc<Mutex<NotesCalls>>,
    saved: Arc<Mutex<Vec<SettingsState>>>,
}

impl StartedHarness {
    /// The last-seen version each write so far stored, in order.
    fn saved_last_seen(&self) -> Vec<Option<String>> {
        self.saved
            .lock()
            .unwrap()
            .iter()
            .map(|settings| settings.updates.last_seen_version.clone())
            .collect()
    }
}

/// A client running `version`, started with a settings file whose update
/// preferences say `last_seen` and `show_whats_new`, and whose release check
/// answers `latest`. Returns once the startup (the settings load, the What's
/// new decision and the check) has finished.
async fn started(
    version: &str,
    last_seen: Option<&str>,
    show_whats_new: bool,
    latest: Result<Option<ClientRelease>, String>,
) -> StartedHarness {
    let stored = UpdatePreferences {
        show_whats_new,
        last_seen_version: last_seen.map(str::to_string),
        ..UpdatePreferences::default()
    };
    started_from(version, Some(stored), latest).await
}

/// [`started`], from the settings file `stored` describes: `None` for none.
async fn started_from(
    version: &str,
    stored: Option<UpdatePreferences>,
    latest: Result<Option<ClientRelease>, String>,
) -> StartedHarness {
    let calls = Arc::new(Mutex::new(NotesCalls::default()));
    let saved = Arc::new(Mutex::new(Vec::new()));
    let ports = Ports {
        client_update: Arc::new(NotesUpdates {
            latest,
            notes: vec![release_notes("0.4.0"), release_notes("0.3.0")],
            read: Mutex::new(false),
            calls: calls.clone(),
        }),
        settings: Arc::new(RecordingSettings {
            updates: stored,
            saved: saved.clone(),
        }),
        ..fake_ports()
    };
    let (app, app_loop) = App::new(version, ports);
    tokio::spawn(app_loop.run());
    app.dispatch_and_wait(SettingsCommand::Load.into())
        .await
        .unwrap();
    StartedHarness { app, calls, saved }
}

#[tokio::test]
async fn a_fresh_install_records_the_build_and_shows_nothing() {
    // No settings file at all: everything is new, and a list of changes since
    // some earlier build would be measured against nothing.
    let h = started_from("0.4.0", None, Ok(None)).await;

    let state = h.app.snapshot();
    assert_eq!(state.client_update.whats_new, None);
    assert_eq!(
        state.settings.updates.last_seen_version.as_deref(),
        Some("0.4.0")
    );
    // Written down at once, so the first update finds a file that says so
    // even if nothing else is ever changed before it.
    assert_eq!(h.saved_last_seen().last(), Some(&Some("0.4.0".into())));
    assert_eq!(h.calls.lock().unwrap().notes_loads, 0);
}

#[tokio::test]
async fn a_development_build_records_nothing_on_a_fresh_install() {
    // `test` is not a release: recording it would make the first real build
    // read as an update from a version that never existed.
    let h = started_from("test", None, Ok(None)).await;

    let state = h.app.snapshot();
    assert_eq!(state.client_update.whats_new, None);
    assert_eq!(state.settings.updates.last_seen_version, None);
    let saved = h.saved_last_seen();
    assert!(saved.iter().all(Option::is_none), "{saved:?}");
}

#[tokio::test]
async fn a_settings_file_from_before_the_record_shows_whats_new() {
    // The update from a build that never recorded anything (0.8.0) to the
    // one that does: the update this popup ships in has to announce itself.
    let h = started("0.4.0", None, true, Ok(None)).await;

    let state = h.app.snapshot();
    assert_eq!(state.client_update.whats_new.as_deref(), Some("0.4.0"));
    assert_eq!(
        state.client_update.notes_status,
        ClientReleaseNotesStatus::Ready
    );
    // Recorded only once it is dismissed, as after any other update.
    assert_eq!(state.settings.updates.last_seen_version, None);
    let saved = h.saved_last_seen();
    assert!(saved.iter().all(Option::is_none), "{saved:?}");
}

#[tokio::test]
async fn the_first_start_after_an_update_shows_whats_new_with_the_checks_notes() {
    let h = started("0.4.0", Some("0.3.0"), true, Ok(None)).await;

    let state = h.app.snapshot();
    assert_eq!(state.client_update.whats_new.as_deref(), Some("0.4.0"));
    // The notes came with the check: one request, no second one for them.
    assert_eq!(
        state.client_update.notes_status,
        ClientReleaseNotesStatus::Ready
    );
    assert_eq!(state.client_update.notes.len(), 2);
    {
        let calls = h.calls.lock().unwrap();
        assert_eq!((calls.checks, calls.notes_loads), (1, 0));
    }
    // Nothing is recorded until the popup is dismissed.
    assert_eq!(
        state.settings.updates.last_seen_version.as_deref(),
        Some("0.3.0")
    );
    let saved = h.saved_last_seen();
    assert!(
        saved.iter().all(|seen| seen.as_deref() == Some("0.3.0")),
        "{saved:?}"
    );
}

#[tokio::test]
async fn dismissing_whats_new_remembers_the_running_build() {
    let h = started("0.4.0", Some("0.3.0"), true, Ok(None)).await;
    assert!(h.app.snapshot().client_update.whats_new.is_some());

    h.app
        .dispatch_and_wait(ClientUpdateCommand::DismissWhatsNew.into())
        .await
        .unwrap();

    let state = h.app.snapshot();
    assert_eq!(state.client_update.whats_new, None);
    assert_eq!(
        state.settings.updates.last_seen_version.as_deref(),
        Some("0.4.0")
    );
    assert_eq!(h.saved_last_seen().last(), Some(&Some("0.4.0".into())));
}

#[tokio::test]
async fn an_update_with_whats_new_turned_off_is_remembered_quietly() {
    // Recorded rather than left alone, so switching the popup back on later
    // announces the next update and not a backlog.
    let h = started("0.4.0", Some("0.3.0"), false, Ok(None)).await;

    assert_eq!(h.app.snapshot().client_update.whats_new, None);
    assert_eq!(h.saved_last_seen().last(), Some(&Some("0.4.0".into())));
}

#[tokio::test]
async fn the_same_build_again_changes_nothing() {
    let h = started("0.4.0", Some("0.4.0"), true, Ok(None)).await;

    assert_eq!(h.app.snapshot().client_update.whats_new, None);
    let saved = h.saved_last_seen();
    assert!(
        saved.iter().all(|seen| seen.as_deref() == Some("0.4.0")),
        "{saved:?}"
    );
}

#[tokio::test]
async fn a_downgrade_is_remembered_without_a_popup() {
    let h = started("0.4.0", Some("0.5.0"), true, Ok(None)).await;

    let state = h.app.snapshot();
    assert_eq!(state.client_update.whats_new, None);
    assert_eq!(
        state.settings.updates.last_seen_version.as_deref(),
        Some("0.4.0")
    );
    assert_eq!(h.saved_last_seen().last(), Some(&Some("0.4.0".into())));
}

#[tokio::test]
async fn a_pending_popup_loads_the_notes_itself_when_the_check_failed() {
    // The check never reached the list, so it had nothing to hand on, and a
    // popup without notes is an empty box.
    let h = started(
        "0.4.0",
        Some("0.3.0"),
        true,
        Err("github unreachable".into()),
    )
    .await;

    let state = h.app.snapshot();
    assert_eq!(state.client_update.whats_new.as_deref(), Some("0.4.0"));
    assert_eq!(
        state.client_update.notes_status,
        ClientReleaseNotesStatus::Ready
    );
    let calls = h.calls.lock().unwrap();
    assert_eq!((calls.checks, calls.notes_loads), (1, 1));
}

#[tokio::test]
async fn loading_notes_offline_says_they_are_unavailable() {
    // The offline port invents nothing, and says so rather than showing an
    // empty list as if there had never been a release.
    let (app, app_loop) = App::new("0.4.0", fake_ports());
    tokio::spawn(app_loop.run());

    app.dispatch_and_wait(ClientUpdateCommand::LoadNotes.into())
        .await
        .unwrap();

    match app.snapshot().client_update.notes_status {
        ClientReleaseNotesStatus::Failed { reason } => {
            assert!(reason.contains("offline"), "{reason}")
        }
        other => panic!("expected a failure, got {other:?}"),
    }
}
