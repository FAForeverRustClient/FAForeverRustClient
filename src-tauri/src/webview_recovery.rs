//! Bringing the window back after its web view crashes (Windows).
//!
//! The window's page runs in WebView2's own processes; the core that holds the
//! lobby connection, the ICE adapter and the replay relay runs in this one. So
//! when the page dies, a game's connection does not, and all that is lost is
//! the page: it comes back by being loaded again, and reads the state afresh
//! from the core (`commands::snapshot`), as it does at a start. Without this
//! the client was left a dead window over a working connection.
//!
//! - The page's renderer exited: the page is reloaded.
//! - WebView2's browser process exited: nothing in the old web view can be
//!   reloaded, so the window is closed and built again, where it was.
//! - A renderer that has stopped responding is only logged. It may be busy,
//!   and a reload would throw its work away; WebView2 says so again if it
//!   stays stuck.
//! - A crashed embed (the News or Units site in its frame) is left to its
//!   frame.
//!
//! Capped: a page that crashes while it is drawn would otherwise come back
//! and crash forever. After three in five minutes it is left as it is.
//!
//! A window is not standing when Tauri hands back its handle: off the main
//! thread the native window is only queued, and if its creation then fails
//! the handle stays registered with nothing behind it. So the window counts
//! as standing once its page starts to load ([`on_main_page_load`]); until
//! then an Open from the tray is kept and carried out there, and a build that
//! has shown no page for [`BUILD_TIMEOUT`] counts as failed, so the next Open
//! builds another (under a fresh label, `window::MainWindow`).
//!
//! From a crash until the page says it is ready again (`exit::PageReady`),
//! closing the client asks natively rather than through a page that may not
//! be there to show the question.
//!
//! This recovers WebView2's processes, not this one: a crash of the client
//! itself takes the connection with it.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, PhysicalPosition, PhysicalSize};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, ICoreWebView2ProcessFailedEventArgs, COREWEBVIEW2_PROCESS_FAILED_KIND,
    COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
    COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
};
use webview2_com::ProcessFailedEventHandler;

use crate::window::main_window;

/// How many times the window is brought back within [`RECOVERY_SPAN`].
const MAX_RECOVERIES: usize = 3;
const RECOVERY_SPAN: Duration = Duration::from_secs(5 * 60);

/// How long a window being built may go without its page starting to load
/// before it counts as failed.
const BUILD_TIMEOUT: Duration = Duration::from_secs(20);

/// Where the window was, for the one built in its place.
#[derive(Debug, Clone, Copy)]
struct Geometry {
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    maximized: bool,
}

/// The recovery's state, managed by the app.
#[derive(Default)]
pub(crate) struct Recoveries {
    /// When the window was last brought back, for the cap.
    recent: Mutex<VecDeque<Instant>>,
    /// Set from closing the old window until the new one's page says it is
    /// ready (`on_page_ready`): the old one closing is otherwise the last
    /// window closing, which exits. Not cleared when the build call returns:
    /// the new window may still be on its way then, and the old one's exit
    /// request still to come. Left set when a build fails, so the client stays
    /// up in the tray, whose "Open client" builds one again.
    keep_alive: AtomicBool,
    /// Set when the old window is closed to be built again, so that its
    /// closing builds the new one.
    rebuild_on_destroy: AtomicBool,
    /// When the window now on its way was asked for; `None` once its page
    /// has started to load, or once building it failed outright.
    pending_since: Mutex<Option<Instant>>,
    /// Whether the main window's page has started to load, which is when the
    /// window stands.
    standing: AtomicBool,
    /// An Open from the tray that came while the window was not standing,
    /// carried out once it is.
    open_requested: AtomicBool,
    /// A rebuilt window, built hidden, to be shown once it stands unless the
    /// client is by then waiting in the tray for its game (`exit`). Decided
    /// then rather than when the build starts: the build first waits for the
    /// old browser process, and a Quit in that wait would otherwise be undone
    /// by a window coming back visible.
    show_when_standing: AtomicBool,
    /// The crashed window was maximised: the rebuilt one is maximised once
    /// the player activates it (an Open from the tray, or focusing it), not
    /// before. Maximising shows and activates a window, and a recovery that
    /// activates the client mid-game pulls the player out of the game; until
    /// then it stands at the crashed window's size, which was the screen's.
    maximize_when_shown: AtomicBool,
    /// Where the window that crashed was.
    geometry: Mutex<Option<Geometry>>,
}

/// What to do with the main window once it stands: show it, and whether to
/// focus it as well, or leave it as it is.
fn on_standing(open_requested: bool, rebuilt: bool, waiting: bool) -> Option<bool> {
    if open_requested {
        // Opened from the tray: shown and brought forward.
        Some(true)
    } else if rebuilt && !waiting {
        // Back where it was, without taking the focus from wherever it went.
        Some(false)
    } else {
        None
    }
}

/// Show a main window that has just stood.
///
/// Asked for (`focus`): shown, maximised if the window it replaced was,
/// and brought forward. Automatic: shown and nothing else. A rebuilt window
/// is built unfocused, so this first show does not activate it
/// (`window::Build::Recovery`); unminimising and maximising would, so they
/// wait for the player ([`on_activated`]).
fn show(window: &tauri::WebviewWindow, focus: bool) {
    let _ = window.show();
    if focus {
        on_activated(window.app_handle());
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// The player has brought the main window forward: from the tray, or by
/// focusing it. A rebuilt window whose predecessor was maximised is
/// maximised now, when activating it no longer takes anything from anyone.
pub(crate) fn on_activated(app: &tauri::AppHandle) {
    let Some(recoveries) = app.try_state::<Recoveries>() else {
        return;
    };
    if recoveries.maximize_when_shown.swap(false, Ordering::SeqCst) {
        if let Some(window) = main_window(app) {
            let _ = window.maximize();
        }
    }
}

impl Recoveries {
    /// Whether one more recovery is within the cap; counts it if it is.
    fn allow(&self, now: Instant) -> bool {
        let mut recent = lock(&self.recent);
        while recent
            .front()
            .is_some_and(|at| now.duration_since(*at) > RECOVERY_SPAN)
        {
            recent.pop_front();
        }
        if recent.len() >= MAX_RECOVERIES {
            return false;
        }
        recent.push_back(now);
        true
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Where the main window stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WindowState {
    /// Its page has started to load: it can be shown.
    Standing,
    /// Asked for, and within [`BUILD_TIMEOUT`]: wait for it.
    Coming,
    /// No window, or one that never came: build one.
    Missing,
}

/// The rule, apart from the window it describes.
fn classify(standing: bool, registered: bool, pending_for: Option<Duration>) -> WindowState {
    if standing && registered {
        WindowState::Standing
    } else if pending_for.is_some_and(|age| age < BUILD_TIMEOUT) {
        WindowState::Coming
    } else {
        WindowState::Missing
    }
}

/// Where the main window stands now.
pub(crate) fn window_state(app: &tauri::AppHandle) -> WindowState {
    let Some(recoveries) = app.try_state::<Recoveries>() else {
        return WindowState::Standing;
    };
    let pending_for = lock(&recoveries.pending_since).map(|since| since.elapsed());
    classify(
        recoveries.standing.load(Ordering::SeqCst),
        main_window(app).is_some(),
        pending_for,
    )
}

/// The first window is about to be built: it is coming, not missing.
pub(crate) fn expect_window(app: &tauri::AppHandle) {
    if let Some(recoveries) = app.try_state::<Recoveries>() {
        *lock(&recoveries.pending_since) = Some(Instant::now());
        recoveries.standing.store(false, Ordering::SeqCst);
    }
}

/// Open the client from the tray when its window is not standing: once it
/// stands, or, when there is none on its way, by building one.
pub(crate) fn open_when_standing(app: &tauri::AppHandle) {
    let Some(recoveries) = app.try_state::<Recoveries>() else {
        return;
    };
    recoveries.open_requested.store(true, Ordering::SeqCst);
    if window_state(app) == WindowState::Missing {
        rebuild(app);
    }
}

/// Hidden to the tray: an Open kept from before no longer stands.
pub(crate) fn forget_open(app: &tauri::AppHandle) {
    if let Some(recoveries) = app.try_state::<Recoveries>() {
        recoveries.open_requested.store(false, Ordering::SeqCst);
    }
}

/// The main window's page has started or finished loading: the window
/// stands, and an Open that came while it did not is carried out now. On the
/// main thread, where the window it shows is already there.
pub(crate) fn on_main_page_load(window: &tauri::WebviewWindow) {
    let app = window.app_handle();
    if !crate::window::is_main(app, window.label()) {
        return;
    }
    let Some(recoveries) = app.try_state::<Recoveries>() else {
        return;
    };
    recoveries.standing.store(true, Ordering::SeqCst);
    *lock(&recoveries.pending_since) = None;
    let open_requested = recoveries.open_requested.swap(false, Ordering::SeqCst);
    let rebuilt = recoveries.show_when_standing.swap(false, Ordering::SeqCst);
    if let Some(focus) = on_standing(open_requested, rebuilt, crate::exit::waiting(app)) {
        show(window, focus);
    }
}

/// Watch the main window's web view for a crash. Called whenever the window is
/// built, the first time and after a rebuild.
pub(crate) fn watch(window: &tauri::WebviewWindow) {
    let app = window.app_handle().clone();
    let result = window.with_webview(move |webview| {
        // SAFETY: WebView2's COM objects, on the thread that owns them, which
        // is where `with_webview` runs this. The handler is called on the same
        // thread.
        unsafe {
            let core = match webview.controller().CoreWebView2() {
                Ok(core) => core,
                Err(error) => {
                    tracing::warn!(%error, "could not reach the web view to watch it for crashes");
                    return;
                }
            };
            let handler = ProcessFailedEventHandler::create(Box::new(
                move |sender: Option<ICoreWebView2>,
                      args: Option<ICoreWebView2ProcessFailedEventArgs>| {
                    let Some(args) = args else {
                        return Ok(());
                    };
                    let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
                    args.ProcessFailedKind(&mut kind)?;
                    on_process_failed(&app, kind, sender);
                    Ok(())
                },
            ));
            let mut token = 0i64;
            if let Err(error) = core.add_ProcessFailed(&handler, &mut token) {
                tracing::warn!(%error, "could not watch the web view for crashes");
            }
        }
    });
    if let Err(error) = result {
        tracing::warn!(%error, "could not watch the web view for crashes");
    }
}

fn on_process_failed(
    app: &tauri::AppHandle,
    kind: COREWEBVIEW2_PROCESS_FAILED_KIND,
    sender: Option<ICoreWebView2>,
) {
    let recoveries = app.state::<Recoveries>();
    if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED {
        // Gone until the reloaded page says otherwise, which a reload that
        // fails to load never does.
        crate::exit::page_gone(app);
        if !recoveries.allow(Instant::now()) {
            tracing::error!(
                "the window's page crashed again; leaving it rather than reloading it in a loop"
            );
            return;
        }
        tracing::error!("the window's page crashed; reloading it");
        if let Some(sender) = sender {
            // SAFETY: as in `watch`: the web view's own thread.
            if let Err(error) = unsafe { sender.Reload() } {
                tracing::error!(%error, "could not reload the window's page");
            }
        }
    } else if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED {
        crate::exit::page_gone(app);
        if !recoveries.allow(Instant::now()) {
            tracing::error!(
                "the web view's browser process exited again; leaving the window as it is"
            );
            return;
        }
        tracing::error!("the web view's browser process exited; building the window again");
        let Some(window) = main_window(app) else {
            return;
        };
        // On the main thread, so these are answered here and now.
        if let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) {
            *lock(&recoveries.geometry) = Some(Geometry {
                position,
                size,
                maximized: window.is_maximized().unwrap_or(false),
            });
        }
        // Kept alive from here, before the old window goes: the exit request
        // its closing makes may come before or after its `Destroyed` event.
        recoveries.keep_alive.store(true, Ordering::SeqCst);
        recoveries.rebuild_on_destroy.store(true, Ordering::SeqCst);
        recoveries.standing.store(false, Ordering::SeqCst);
        // The window this was waiting on, if it crashed before its page ever
        // loaded, is the one going now: nothing is on its way any more, and
        // the rebuild must not take it for one that is.
        *lock(&recoveries.pending_since) = None;
        // Closed now, built again once it is gone (`on_main_destroyed`).
        if let Err(error) = window.destroy() {
            recoveries.keep_alive.store(false, Ordering::SeqCst);
            recoveries.rebuild_on_destroy.store(false, Ordering::SeqCst);
            tracing::error!(%error, "could not close the broken window");
        }
    } else {
        tracing::warn!(kind = kind.0, "a web view process failed; left to WebView2");
    }
}

/// The main window is gone. If it was closed to be built again, build it.
pub(crate) fn on_main_destroyed(app: &tauri::AppHandle) {
    let rebuild_due = app
        .try_state::<Recoveries>()
        .is_some_and(|recoveries| recoveries.rebuild_on_destroy.swap(false, Ordering::SeqCst));
    if rebuild_due {
        rebuild(app);
    }
}

/// Build the main window again, on a thread of its own.
///
/// Not inside the event that asks for it: Tauri documents that building a
/// window from an event handler can deadlock on Windows. The client is kept
/// from exiting until the new window's page says it is ready
/// (`on_page_ready`).
///
/// Always built hidden, and shown once it stands (`on_main_page_load`):
/// unless the client is by then waiting in the tray for its game to end
/// (`exit`), where shown it would come back on its own and then exit under
/// the player when the game ended. Decided when it stands, not here: the build
/// first waits for the old browser process, and a Quit or an Open in that
/// wait is what counts.
///
/// Also where opening the client from the tray goes when there is no window
/// standing and none on its way: after a rebuild that failed.
pub(crate) fn rebuild(app: &tauri::AppHandle) {
    let Some(recoveries) = app.try_state::<Recoveries>() else {
        return;
    };
    {
        let mut pending = lock(&recoveries.pending_since);
        if pending.is_some_and(|since| since.elapsed() < BUILD_TIMEOUT) {
            // One is on its way already.
            return;
        }
        *pending = Some(Instant::now());
    }
    // The page of the window about to be built has not loaded yet.
    crate::exit::page_gone(app);
    recoveries.keep_alive.store(true, Ordering::SeqCst);
    recoveries.standing.store(false, Ordering::SeqCst);
    recoveries.show_when_standing.store(true, Ordering::SeqCst);
    let geometry = lock(&recoveries.geometry).take();
    recoveries.maximize_when_shown.store(
        geometry.is_some_and(|geometry| geometry.maximized),
        Ordering::SeqCst,
    );
    let app = app.clone();
    std::thread::spawn(move || {
        match crate::window::build_main(&app, crate::window::Build::Recovery) {
            Ok(window) => {
                // Queued after the window itself, from this thread, so they
                // reach it once it stands. Neither shows it.
                if let Some(geometry) = geometry {
                    let _ = window.set_size(geometry.size);
                    let _ = window.set_position(geometry.position);
                }
                watch(&window);
                tracing::info!(label = window.label(), "building the window again");
            }
            Err(error) => {
                tracing::error!(%error, "could not build the window again");
                // Failed outright: the next Open may try again at once.
                *lock(&app.state::<Recoveries>().pending_since) = None;
            }
        }
    });
}

/// The window's page says it is ready: a rebuilt window is standing, so its
/// predecessor's closing can no longer be mistaken for the last window going.
pub(crate) fn on_page_ready(app: &tauri::AppHandle) {
    if let Some(recoveries) = app.try_state::<Recoveries>() {
        recoveries.keep_alive.store(false, Ordering::SeqCst);
    }
}

/// Keep the client running while its only window is rebuilt: closing it is
/// otherwise the last window closing, which exits. An exit the client asked
/// for itself carries a code and is left alone.
pub(crate) fn on_run_event(app: &tauri::AppHandle, event: &tauri::RunEvent) {
    if let tauri::RunEvent::ExitRequested {
        code: None, api, ..
    } = event
    {
        if app
            .try_state::<Recoveries>()
            .is_some_and(|recoveries| recoveries.keep_alive.load(Ordering::SeqCst))
        {
            api.prevent_exit();
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::{
        classify, on_standing, Recoveries, WindowState, BUILD_TIMEOUT, MAX_RECOVERIES,
        RECOVERY_SPAN,
    };

    #[test]
    fn a_rebuilt_window_is_shown_once_it_stands_unless_the_client_was_hidden_meanwhile() {
        // Rebuilt, client not waiting: back where it was, focus left alone.
        assert_eq!(on_standing(false, true, false), Some(false));
        // Rebuilt, but Quit while it was being built: stays hidden.
        assert_eq!(on_standing(false, true, true), None);
        // Opened from the tray meanwhile: shown and focused.
        assert_eq!(on_standing(true, true, false), Some(true));
        assert_eq!(on_standing(true, false, false), Some(true));
        // The first window at a start, built visible: nothing to do.
        assert_eq!(on_standing(false, false, false), None);
    }

    #[test]
    fn brings_the_window_back_a_few_times_then_leaves_it() {
        let recoveries = Recoveries::default();
        let start = Instant::now();
        for _ in 0..MAX_RECOVERIES {
            assert!(recoveries.allow(start));
        }
        assert!(!recoveries.allow(start + Duration::from_secs(1)));
    }

    #[test]
    fn a_crash_long_after_the_last_ones_is_recovered_again() {
        let recoveries = Recoveries::default();
        let start = Instant::now();
        for _ in 0..MAX_RECOVERIES {
            assert!(recoveries.allow(start));
        }
        assert!(recoveries.allow(start + RECOVERY_SPAN + Duration::from_secs(1)));
    }

    #[test]
    fn a_window_stands_once_its_page_loads_and_not_when_its_handle_exists() {
        assert_eq!(classify(true, true, None), WindowState::Standing);
        // Registered, page not loaded yet, asked for a moment ago: on its way.
        assert_eq!(
            classify(false, true, Some(Duration::from_secs(2))),
            WindowState::Coming
        );
        // Registered, but its page never loaded: its native window failed,
        // and an Open builds another.
        assert_eq!(
            classify(false, true, Some(BUILD_TIMEOUT)),
            WindowState::Missing
        );
        assert_eq!(classify(false, true, None), WindowState::Missing);
        assert_eq!(classify(false, false, None), WindowState::Missing);
    }
}
