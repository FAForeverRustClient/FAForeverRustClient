//! The auth session's commit boundary.
//!
//! A login or restore only stages the session it obtained; the auth service
//! publishes it (access token current, refresh token remembered, renewal
//! running) once the attempt is known to be still wanted, and drops it
//! otherwise. These tests drive the service through a fake port that keeps
//! that two-phase contract and records what went live, and hold the profile
//! request at a gate so a cancel can arrive while it is in flight. The OAuth
//! adapter's own half of the contract is tested in `infra::oauth`.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use faf_app::infra::fake_ports;
use faf_app::ports::{AuthError, AuthPort, AuthResult};
use faf_app::{App, Ports};
use faf_domain::state::{AuthCommand, AuthEvent, AuthMode, AuthStatus, Player};
use faf_domain::{AppCommand, AppEvent};
use tokio::sync::Semaphore;
use tokio::task::JoinHandle;

const PATIENCE: Duration = Duration::from_secs(5);

/// A port call held until the test lets it through.
struct Gate {
    entered: Semaphore,
    release: Semaphore,
}

impl Gate {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            entered: Semaphore::new(0),
            release: Semaphore::new(0),
        })
    }

    /// Called by the port: say it arrived, then wait to be let through.
    async fn pass(&self) {
        self.entered.add_permits(1);
        self.release.acquire().await.expect("gate closed").forget();
    }

    async fn wait_entered(&self, what: &str) {
        tokio::time::timeout(PATIENCE, self.entered.acquire())
            .await
            .unwrap_or_else(|_| panic!("{what} never reached the port"))
            .expect("gate closed")
            .forget();
    }

    fn open(&self) {
        self.release.add_permits(1);
    }
}

/// What of the session is staged and what went live.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct Session {
    /// A staged session: whether committing persists its refresh token, and
    /// whether it renews.
    staged: Option<(bool, bool)>,
    access_token: bool,
    refresh_token_saved: bool,
    renewing: bool,
    logouts: usize,
}

impl Session {
    fn is_live(&self) -> bool {
        self.access_token || self.refresh_token_saved || self.renewing
    }
}

/// A port with the OAuth adapter's contract: the profile lookup (`/me`) waits
/// at a gate, and only a commit publishes what a login or restore staged.
struct StagingAuth {
    session: Arc<Mutex<Session>>,
    profile: Arc<Gate>,
    restore: Arc<Gate>,
    profile_fails: bool,
}

#[async_trait]
impl AuthPort for StagingAuth {
    async fn login(&self, remember: bool) -> AuthResult<Player> {
        self.session.lock().unwrap().staged = None;
        self.profile.pass().await;
        if self.profile_fails {
            return Err(AuthError::new("Could not load profile (/me returned 500)"));
        }
        self.session.lock().unwrap().staged = Some((remember, remember));
        Ok(Player::new(7, "Ada"))
    }

    async fn restore(&self) -> AuthResult<Option<Player>> {
        self.session.lock().unwrap().staged = None;
        self.restore.pass().await;
        // The remembered refresh token is the user's from before; a restore
        // only renews the session it brings back.
        self.session.lock().unwrap().staged = Some((false, true));
        Ok(Some(Player::new(7, "Ada")))
    }

    fn commit_session(&self) -> bool {
        let mut session = self.session.lock().unwrap();
        let Some((persist, renew)) = session.staged.take() else {
            return false;
        };
        session.access_token = true;
        session.refresh_token_saved |= persist;
        session.renewing = renew;
        true
    }

    fn discard_pending_session(&self) {
        self.session.lock().unwrap().staged = None;
    }

    async fn logout(&self) -> AuthResult<()> {
        let mut session = self.session.lock().unwrap();
        let logouts = session.logouts + 1;
        *session = Session {
            logouts,
            ..Session::default()
        };
        Ok(())
    }
}

struct Harness {
    app: Arc<App>,
    session: Arc<Mutex<Session>>,
    profile: Arc<Gate>,
    restore: Arc<Gate>,
}

impl Harness {
    fn new(profile_fails: bool) -> Self {
        let session = Arc::new(Mutex::new(Session::default()));
        let profile = Gate::new();
        let restore = Gate::new();
        let (app, app_loop) = App::new(
            "test",
            Ports {
                auth: Arc::new(StagingAuth {
                    session: session.clone(),
                    profile: profile.clone(),
                    restore: restore.clone(),
                    profile_fails,
                }),
                ..fake_ports()
            },
        );
        tokio::spawn(app_loop.run());
        Self {
            app: Arc::new(app),
            session,
            profile,
            restore,
        }
    }

    fn session(&self) -> Session {
        self.session.lock().unwrap().clone()
    }

    fn spawn(&self, command: AppCommand) -> JoinHandle<()> {
        let app = self.app.clone();
        tokio::spawn(async move {
            app.dispatch_and_wait(command)
                .await
                .expect("command completes");
        })
    }

    async fn run(&self, what: &str, command: AppCommand) {
        tokio::time::timeout(PATIENCE, self.app.dispatch_and_wait(command))
            .await
            .unwrap_or_else(|_| panic!("{what} was held up"))
            .expect("the loop is running");
    }
}

async fn finish(what: &str, task: JoinHandle<()>) {
    tokio::time::timeout(PATIENCE, task)
        .await
        .unwrap_or_else(|_| panic!("{what} never finished"))
        .unwrap_or_else(|error| panic!("{what} panicked: {error}"));
}

/// Every command that calls a sign-in off, with the status it leaves.
fn calls_off() -> Vec<(&'static str, AppCommand, AuthStatus, AuthMode)> {
    vec![
        (
            "Logout",
            AuthCommand::Logout.into(),
            AuthStatus::LoggedOut,
            AuthMode::Account,
        ),
        (
            "CancelLogin",
            AuthCommand::CancelLogin.into(),
            AuthStatus::LoggedOut,
            AuthMode::Account,
        ),
        (
            "LogoutTest",
            AuthCommand::LogoutTest.into(),
            AuthStatus::LoggedOut,
            AuthMode::Account,
        ),
        (
            "PlayOffline",
            AuthCommand::PlayOffline.into(),
            AuthStatus::LoggedIn,
            AuthMode::Offline,
        ),
        (
            "LoginTest",
            AuthCommand::LoginTest.into(),
            AuthStatus::LoggedIn,
            AuthMode::Test,
        ),
    ]
}

/// A remembered sign-in is waiting on its profile request when the user
/// calls it off. No token is published, no refresh token is saved for the
/// next start, and nothing renews, whichever command called it off.
#[tokio::test]
async fn a_sign_in_called_off_during_the_profile_request_leaves_no_session() {
    for (name, call_off, status, mode) in calls_off() {
        let h = Harness::new(false);

        let login = h.spawn(AuthCommand::Login { remember: true }.into());
        h.profile.wait_entered(name).await;
        h.run(name, call_off).await;
        finish(&format!("{name}: the cancelled login"), login).await;
        // The profile answering now must change nothing.
        h.profile.open();

        let session = h.session();
        assert!(!session.is_live(), "{name}: {session:?}");
        assert_eq!(session.staged, None, "{name}: a session stayed staged");
        let auth = h.app.snapshot().auth;
        assert_eq!((auth.status, auth.mode), (status, mode), "{name}");
        assert_ne!(
            auth.player.map(|player| player.id),
            Some(7),
            "{name}: the called-off sign-in landed"
        );
    }
}

/// The token exchange worked but `/me` did not: the login fails and nothing
/// of the session it would have been goes live.
#[tokio::test]
async fn a_failed_profile_lookup_leaves_no_session() {
    let h = Harness::new(true);
    h.profile.open();

    h.run("the login", AuthCommand::Login { remember: true }.into())
        .await;

    assert_eq!(h.app.snapshot().auth.status, AuthStatus::Failed);
    let session = h.session();
    assert!(!session.is_live(), "{session:?}");
    assert_eq!(session.staged, None);
}

/// The commit boundary must not get in the way of a sign-in that is wanted.
#[tokio::test]
async fn a_successful_sign_in_is_published_and_remembered_as_before() {
    for remember in [true, false] {
        let h = Harness::new(false);
        h.profile.open();

        h.run("the login", AuthCommand::Login { remember }.into())
            .await;

        let auth = h.app.snapshot().auth;
        assert_eq!(auth.status, AuthStatus::LoggedIn);
        assert_eq!(auth.player.map(|player| player.id), Some(7));
        assert_eq!(
            h.session(),
            Session {
                staged: None,
                access_token: true,
                refresh_token_saved: remember,
                renewing: remember,
                logouts: 0,
            },
            "remember: {remember}"
        );
    }
}

/// A restore has no cancel, so the commands that call a sign-in off only make
/// it stale. When its answer arrives afterwards it must be dropped, not
/// published behind the screen the user chose. `Logout` is left out: it waits
/// for the restore's lock and then tears the session down through the port,
/// which `command_contracts::a_restore_answering_after_a_logout_*` covers.
#[tokio::test]
async fn a_restore_called_off_while_it_runs_does_not_go_live() {
    for (name, call_off, status, mode) in calls_off() {
        if name == "Logout" {
            continue;
        }
        let h = Harness::new(false);
        let mut events = h.app.subscribe();

        let restore = h.spawn(AuthCommand::Restore.into());
        h.restore.wait_entered(name).await;
        // These complete at once, so the restore's answer arrives strictly
        // after it was called off.
        h.run(name, call_off).await;
        h.restore.open();
        finish(&format!("{name}: the restore"), restore).await;

        let session = h.session();
        assert!(
            !session.is_live(),
            "{name}: the restore's session went live: {session:?}"
        );
        assert_eq!(session.staged, None, "{name}: a session stayed staged");
        let auth = h.app.snapshot().auth;
        assert_eq!((auth.status, auth.mode), (status, mode), "{name}");
        while let Ok(event) = events.try_recv() {
            assert!(
                !matches!(event, AppEvent::Auth(AuthEvent::LoggedIn { .. })),
                "{name}: the restore signed the user in"
            );
        }
    }
}

#[tokio::test]
async fn a_restore_that_is_still_wanted_goes_live() {
    let h = Harness::new(false);
    h.restore.open();

    h.run("the restore", AuthCommand::Restore.into()).await;

    assert_eq!(
        h.app.snapshot().auth.player.map(|player| player.id),
        Some(7)
    );
    let session = h.session();
    assert!(session.access_token && session.renewing, "{session:?}");
    assert_eq!(session.staged, None);
}
