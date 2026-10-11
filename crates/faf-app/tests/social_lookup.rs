//! Looking an offline player's account up by login, for the user menu.
//!
//! Friend, foe, note and report all address an account by id, which the
//! online list has and a replay lineup does not. The menu asks once per name;
//! the answer is kept, and a name with no account behind it is kept as such.

use faf_app::infra::fake_ports;
use faf_app::App;
use faf_domain::state::{LoginLookup, SocialCommand};

/// The fake API's one login that matches no account.
const NO_ACCOUNT: &str = "NotAPlayer";

async fn look_up(app: &App, login: &str) {
    app.dispatch_and_wait(
        SocialCommand::LookUpLogin {
            login: login.into(),
        }
        .into(),
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn an_offline_login_is_resolved_once_and_a_missing_account_is_remembered() {
    let (app, app_loop) = App::new("test", fake_ports());
    tokio::spawn(app_loop.run());

    look_up(&app, "Somebody").await;
    look_up(&app, NO_ACCOUNT).await;
    let lookups = app.snapshot().social.login_lookups;
    assert_eq!(lookups.len(), 2);
    assert!(
        lookups[0].login.eq_ignore_ascii_case("Somebody") && lookups[0].id.is_some(),
        "the account was found: {lookups:?}"
    );
    assert_eq!(
        lookups[1],
        LoginLookup {
            login: NO_ACCOUNT.into(),
            id: None
        },
        "a login with no account is answered, so the menu stops waiting"
    );

    // Asked again under another spelling: already answered, so nothing moves.
    look_up(&app, "SOMEBODY").await;
    assert_eq!(app.snapshot().social.login_lookups, lookups);
}

#[tokio::test]
async fn a_blank_login_is_not_looked_up() {
    let (app, app_loop) = App::new("test", fake_ports());
    tokio::spawn(app_loop.run());

    look_up(&app, "   ").await;
    assert!(app.snapshot().social.login_lookups.is_empty());
}
