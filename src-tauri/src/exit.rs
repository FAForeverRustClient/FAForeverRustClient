//! What closing the client does while a game runs.
//!
//! The window's close button and the tray's Quit both come here. Outside a
//! game they exit. During one, closing takes the lobby connection, the ICE
//! adapter and the replay relay down with it, so the game loses its
//! connectivity; what happens instead is the player's choice
//! (`GeneralPreferences::keep_running_during_game`):
//!
//! - on (the default): the window is hidden to the tray, everything keeps
//!   running, and the client exits by itself once the game has ended and its
//!   replay is uploaded, unless it was brought back from the tray in the
//!   meantime;
//! - off: the client asks first. The tray's Quit asks too: it used to exit
//!   outright, in a game or not.
//!
//! Asking is the page's dialog (`ExitGuard`) for the close button, where the
//! page is in front of the player. The tray asks with a native dialog, which
//! needs no page: the window may be hidden, or its page dead
//! (`webview_recovery`), and a Quit that could not ask would be a Quit that
//! does nothing for the length of a game. The close button asks natively too
//! until the page has said it is ready ([`PageReady`]): before then, at a
//! start, after a crash or a reload or a rebuild, a question sent to it may
//! have nobody listening.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use faf_app::App;
use faf_domain::state::JoinState;
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tokio::sync::broadcast::error::RecvError;

use crate::Core;

/// The tray icon's id, for its tooltip to say the client is waiting.
pub(crate) const TRAY_ID: &str = "main";
/// The tray tooltip in the ordinary case.
pub(crate) const TRAY_TOOLTIP: &str = "FAForever Rust Client";
const TRAY_TOOLTIP_WAITING: &str = "FAForever Rust Client: closes when your game ends";

/// The least the client stays up after the game ends: the server is still
/// being told how it ended.
const MIN_GRACE: Duration = Duration::from_secs(3);
/// The most it waits for the replay after the game ends. The recorder gives
/// the upload a minute, retries included (`UPLOAD_FLUSH_TIMEOUT`); this is
/// that and some room, and bounded because a recorder FA never connected to
/// would otherwise keep the client up for good.
const MAX_GRACE: Duration = Duration::from_secs(75);
const POLL: Duration = Duration::from_secs(1);

/// Set while the client is hidden to the tray waiting for a game to end.
#[derive(Default)]
pub(crate) struct ExitAfterGame(AtomicBool);

/// Set once the window's page has loaded and its close confirmation is
/// listening, which the page says itself (`commands::page_ready`). Cleared
/// whenever the page goes away: a crash, a reload, a rebuilt window
/// (`webview_recovery`). A reload that was asked for is not a page that
/// loaded, and a page whose load failed never says it is ready.
#[derive(Default)]
pub(crate) struct PageReady(AtomicBool);

/// The page says it is ready: from here the close button asks through it.
pub(crate) fn page_ready(app: &tauri::AppHandle) {
    if let Some(ready) = app.try_state::<PageReady>() {
        ready.0.store(true, Ordering::SeqCst);
    }
    #[cfg(windows)]
    crate::webview_recovery::on_page_ready(app);
}

/// The page is gone or going: ask natively until it says it is ready again.
/// Only a crash recovery tells (`webview_recovery`), which is Windows only.
#[cfg(windows)]
pub(crate) fn page_gone(app: &tauri::AppHandle) {
    if let Some(ready) = app.try_state::<PageReady>() {
        ready.0.store(false, Ordering::SeqCst);
    }
}

/// Where a request to close came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Origin {
    /// The window's close button.
    Window,
    /// The tray's Quit.
    Tray,
}

/// What a request to close the client comes to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Decision {
    /// Exit now: no game is running.
    Exit,
    /// Hide to the tray and exit once the game has ended.
    Hide,
    /// Ask first: a game is running and the setting is off, or the client is
    /// already waiting and was told to quit again.
    Ask,
}

/// The rule, apart from the window and the tray it acts on.
pub(crate) fn decide(
    in_game: bool,
    keep_running_during_game: bool,
    already_waiting: bool,
) -> Decision {
    match (in_game, keep_running_during_game && !already_waiting) {
        (false, _) => Decision::Exit,
        (true, true) => Decision::Hide,
        (true, false) => Decision::Ask,
    }
}

/// How the client asks, when it asks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Prompt {
    /// The page's own dialog, in the player's language.
    Page,
    /// A native dialog, which works without the page.
    Native,
}

/// The page asks only from the close button, and only once it has said it is
/// ready.
pub(crate) fn prompt_for(origin: Origin, page_ready: bool) -> Prompt {
    if origin == Origin::Window && page_ready {
        Prompt::Page
    } else {
        Prompt::Native
    }
}

fn in_game(core: &App) -> bool {
    core.with_state(|state| matches!(state.lobby.join, JoinState::InGame))
}

fn page_is_ready(app: &tauri::AppHandle) -> bool {
    app.try_state::<PageReady>()
        .is_some_and(|ready| ready.0.load(Ordering::SeqCst))
}

/// Act on a request to close, from the window's close button or the tray's
/// Quit. Returns the decision so the caller can stop the window closing when
/// it is anything but an exit; the exit itself is the caller's.
pub(crate) fn on_close_request(app: &tauri::AppHandle, origin: Origin) -> Decision {
    let Some(core) = app.try_state::<Core>() else {
        return Decision::Exit;
    };
    let (in_game, keep_running) = core.0.with_state(|state| {
        (
            matches!(state.lobby.join, JoinState::InGame),
            state.settings.general.keep_running_during_game,
        )
    });
    let decision = decide(in_game, keep_running, waiting(app));
    match decision {
        Decision::Exit => {}
        Decision::Hide => {
            if let Some(waiting) = app.try_state::<ExitAfterGame>() {
                waiting.0.store(true, Ordering::SeqCst);
            }
            if let Some(window) = crate::window::main_window(app) {
                let _ = window.hide();
            }
            // An Open kept from before this no longer stands.
            #[cfg(windows)]
            crate::webview_recovery::forget_open(app);
            set_tray_tooltip(app, TRAY_TOOLTIP_WAITING);
            tracing::info!("closed during a game: hidden to the tray until the game ends");
        }
        Decision::Ask => match prompt_for(origin, page_is_ready(app)) {
            Prompt::Page => {
                crate::tray::restore_main_window(app);
                let _ = app.emit("app://request-exit-confirm", ());
            }
            Prompt::Native => ask_natively(app),
        },
    }
    decision
}

/// The warning `ExitGuard` gives, as a native dialog. English, like the tray:
/// the page's language lives in the page.
fn ask_natively(app: &tauri::AppHandle) {
    let handle = app.clone();
    app.dialog()
        .message(
            "Closing the client now also shuts down the connection to the game, so you would \
             drop out of the match. Quit the game first if it is still in progress.",
        )
        .title("Forged Alliance is still running")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Close anyway".to_string(),
            "Keep the client open".to_string(),
        ))
        .show(move |close| {
            if close {
                tracing::info!("closed during a game, confirmed in the native dialog");
                handle.exit(0);
            }
        });
}

/// The client was brought back while it waited: it no longer exits after the
/// game. Called wherever the window is shown again.
pub(crate) fn cancel(app: &tauri::AppHandle) {
    let Some(waiting) = app.try_state::<ExitAfterGame>() else {
        return;
    };
    if waiting.0.swap(false, Ordering::SeqCst) {
        set_tray_tooltip(app, TRAY_TOOLTIP);
        tracing::info!("brought back from the tray: staying open after the game");
    }
}

fn set_tray_tooltip(app: &tauri::AppHandle, tooltip: &str) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(tooltip));
    }
}

/// Whether the client is hidden to the tray waiting for its game to end. A
/// window built again meanwhile (`webview_recovery`) is built hidden too.
pub(crate) fn waiting(app: &tauri::AppHandle) -> bool {
    app.try_state::<ExitAfterGame>()
        .is_some_and(|waiting| waiting.0.load(Ordering::SeqCst))
}

/// Whether the client should exit now, given how long ago the game ended.
pub(crate) fn may_exit(since_game_ended: Duration, replay_pending: bool) -> bool {
    since_game_ended >= MIN_GRACE && (!replay_pending || since_game_ended >= MAX_GRACE)
}

/// Exit once the game a hidden client is waiting on has ended and its replay
/// is uploaded.
///
/// Every event the core sends is a moment the game may have ended at, so this
/// checks then rather than on a timer. From there it polls the replay upload,
/// and stays if the client is brought back from the tray or a game starts.
pub(crate) fn watch(app: &tauri::App, core: Arc<App>) {
    let handle = app.handle().clone();
    let mut events = core.subscribe();
    tauri::async_runtime::spawn(async move {
        loop {
            match events.recv().await {
                Ok(_) | Err(RecvError::Lagged(_)) => {}
                Err(RecvError::Closed) => break,
            }
            if !waiting(&handle) || in_game(&core) {
                continue;
            }
            let ended = Instant::now();
            loop {
                tokio::time::sleep(POLL).await;
                if !waiting(&handle) || in_game(&core) {
                    break;
                }
                if may_exit(ended.elapsed(), core.replay_upload_pending()) {
                    tracing::info!(
                        waited_seconds = ended.elapsed().as_secs(),
                        replay_pending = core.replay_upload_pending(),
                        "the game has ended: exiting as asked"
                    );
                    handle.exit(0);
                    return;
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::{decide, may_exit, prompt_for, Decision, Origin, Prompt, MAX_GRACE, MIN_GRACE};

    #[test]
    fn outside_a_game_closing_exits_whatever_the_setting() {
        assert_eq!(decide(false, true, false), Decision::Exit);
        assert_eq!(decide(false, false, false), Decision::Exit);
    }

    #[test]
    fn during_a_game_it_hides_to_the_tray_or_asks() {
        assert_eq!(decide(true, true, false), Decision::Hide);
        assert_eq!(decide(true, false, false), Decision::Ask);
    }

    #[test]
    fn quitting_again_while_waiting_asks_rather_than_hiding_again() {
        assert_eq!(decide(true, true, true), Decision::Ask);
    }

    #[test]
    fn the_tray_and_a_broken_page_ask_natively() {
        assert_eq!(prompt_for(Origin::Window, true), Prompt::Page);
        assert_eq!(prompt_for(Origin::Window, false), Prompt::Native);
        assert_eq!(prompt_for(Origin::Tray, true), Prompt::Native);
        assert_eq!(prompt_for(Origin::Tray, false), Prompt::Native);
    }

    #[test]
    fn exits_after_the_replay_is_up_and_never_before_the_minimum() {
        assert!(!may_exit(Duration::ZERO, false));
        assert!(may_exit(MIN_GRACE, false));
        // Still uploading: stays, up to the cap.
        assert!(!may_exit(Duration::from_secs(30), true));
        assert!(may_exit(MAX_GRACE, true));
    }
}
