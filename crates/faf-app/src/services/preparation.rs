//! One run of the game updater at a time, whoever asked for it: the launch of
//! an online game, a search getting the install ready, and the set-up of an
//! offline game.
//!
//! Apart from `services::launcher` because the offline game needs it too, and
//! the Android client has the offline game and no launcher.

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::ports::{GamePreparation, UpdateProgress};
use crate::runtime::{EventSink, ServiceCtx};

/// The updater's turn. Owned by this module.
#[derive(Default)]
pub struct PreparationContext {
    /// One preparation at a time, whoever asked for it.
    ///
    /// The updater writes into the game install and the maps folder, and two
    /// runs at once write the same files. That became possible when a search
    /// started preparing the install before the queue (see
    /// `launcher::prepare_search`): a match can be found while that run is
    /// still going, and the launch's own run must wait for it rather than race
    /// it. Java chains the two the same way, the launch being the continuation
    /// of the search's preparation (`GameRunner.startSearchMatchmaker`). The
    /// second run is then cheap, because files matching by MD5 are skipped.
    ///
    /// One per app rather than one per process: the install is the client's,
    /// and a second app in the same process (every test, side by side) has an
    /// updater turn of its own that has no reason to wait for this one.
    updater: tokio::sync::Mutex<()>,
}

/// What a preparation called off ends with, where an outcome is needed at
/// all. Never shown: the caller called the work off and goes quietly.
pub(super) const CALLED_OFF: &str = "the preparation was called off";

/// Wait for the updater's turn ([`PreparationContext::updater`]), unless the
/// work it is wanted for is called off first. A join cancelled while it waits
/// behind another preparation used to wait out that whole preparation before
/// it noticed.
pub(super) async fn lock_preparation<'a>(
    ctx: &'a ServiceCtx,
    called_off: &CancellationToken,
) -> Option<tokio::sync::MutexGuard<'a, ()>> {
    tokio::select! {
        guard = ctx.preparation.updater.lock() => Some(guard),
        () = called_off.cancelled() => None,
    }
}

/// Drain an updater run, holding the updater's turn while it is wanted, and
/// answer its outcome; `narrate` is handed each step that is still wanted.
///
/// The turn is let go the moment the run is called off, and the run itself
/// was handed the same token, so it stops at its next safe point: between
/// two files, or in the middle of a download (see
/// `GameUpdaterPort::prepare_cancellable`). It used to be told nothing and go
/// on to the end of the featured mod, the map and the simulation mods, with
/// the install's lease held, so the next join's updater waited behind all of
/// it with nothing on screen. Now the next preparation waits for one file at
/// most, on the install's lease, and narrates from there.
///
/// The stream is still drained rather than dropped, so this returns when the
/// run has stopped. A step that arrives after the call-off is not narrated:
/// each one would put the join back into `Preparing`, which reopened the
/// progress dialog over and over after Cancel.
pub(super) async fn drain_preparation(
    guard: tokio::sync::MutexGuard<'_, ()>,
    mut updates: mpsc::Receiver<UpdateProgress>,
    called_off: &CancellationToken,
    narrate: impl Fn(crate::ports::PreparationStep),
) -> Result<(), String> {
    let mut one_at_a_time = Some(guard);
    // The port always ends with `Finished`; treating a stream that closes
    // without one as a failure keeps a panicked adapter task from looking like
    // a successful update.
    let mut outcome = Err("the game updater stopped without finishing".to_string());
    loop {
        let update = tokio::select! {
            update = updates.recv() => update,
            () = called_off.cancelled(), if one_at_a_time.is_some() => {
                one_at_a_time = None;
                continue;
            }
        };
        let Some(update) = update else {
            break;
        };
        if called_off.is_cancelled() {
            one_at_a_time = None;
            continue;
        }
        match update {
            UpdateProgress::Step(step) => narrate(step),
            UpdateProgress::Finished(result) => outcome = result,
        }
    }
    outcome
}

/// Bring a featured mod up to date, handing each step that is still wanted to
/// `narrate`: for work that has a progress line of its own, such as an
/// offline game whose install has never been patched.
///
/// Stops once `called_off` is raised, the way a join's preparation does (see
/// [`drain_preparation`]), and then answers `Err`.
pub(super) async fn prepare_featured_mod_narrated(
    featured_mod: &str,
    ctx: &ServiceCtx,
    out: &EventSink,
    called_off: &CancellationToken,
    narrate: impl Fn(crate::ports::PreparationStep),
) -> Result<(), String> {
    let cache_rolling_branches = out.with_state(|state| state.settings.game.cache_rolling_branches);
    let Some(guard) = lock_preparation(ctx, called_off).await else {
        return Err(CALLED_OFF.to_string());
    };
    let updates = ctx
        .ports
        .updater
        .prepare_cancellable(
            GamePreparation {
                featured_mod: featured_mod.to_string(),
                map_folder: None,
                cache_rolling_branches,
            },
            called_off.clone(),
        )
        .await;
    let outcome = drain_preparation(guard, updates, called_off, narrate).await;
    if called_off.is_cancelled() {
        return Err(CALLED_OFF.to_string());
    }
    outcome
}
