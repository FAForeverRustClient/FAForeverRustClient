//! Replays service.
//!
//! Thin handler (like `services/nav.rs`): asks the [`ReplayPort`] to do the
//! work, then emits `Connecting`/`Playing`/`Failed`. The actual protocol
//! (WebSocket relay, file decompression, launching FA) lives entirely behind
//! the port: see `infra/replay.rs`.

use faf_domain::state::{
    live_replay_delay_remaining, LiveReplayTarget, LiveReplayTracking, LiveReplayTrackingAction,
    NotificationAction, NotificationKind, ReplayCommand, ReplayEvent,
};
use std::{path::PathBuf, time::Duration};

use crate::runtime::{EventSink, ServiceCtx};
use crate::services::notifications;

/// A remaining wait, phrased for someone staring at a button.
fn describe(seconds: u32) -> String {
    match seconds {
        0..=59 => format!("{seconds}s"),
        _ => format!("{}m {}s", seconds / 60, seconds % 60),
    }
}

pub(crate) fn cancel_live_tracking(out: &EventSink) {
    if out.with_state(|state| state.replays.live_tracking.is_some()) {
        out.emit(ReplayEvent::LiveTrackingCleared);
    }
}

async fn watch_live(target: LiveReplayTarget, ctx: &ServiceCtx, out: &EventSink) {
    // Anti-ghosting, enforced here rather than only on the button: the Watch
    // button, notification action, scheduled auto-watch and Discord spectate
    // links all converge on this function.
    let (waiting, player) = out.with_state(|state| {
        let launched_at = state
            .lobby
            .live_games
            .iter()
            .find(|game| game.id == target.uid)
            .and_then(|game| game.launched_at);
        let waiting = live_replay_delay_remaining(launched_at, crate::services::now_seconds());
        let player = state
            .auth
            .player
            .as_ref()
            .map(|player| player.name.clone())
            .unwrap_or_else(|| "spectator".to_string());
        (waiting, player)
    });
    if waiting > 0 {
        out.emit(ReplayEvent::Failed {
            reason: format!(
                "Live replays are delayed by five minutes so nobody can watch \
                 an ongoing game for an advantage. Try again in {}.",
                describe(waiting)
            ),
        });
        return;
    }

    out.emit(ReplayEvent::Connecting);
    let uid = target.uid;
    match ctx.ports.replay.watch_live(target, player).await {
        Ok(warning) => out.emit(ReplayEvent::Playing {
            uid: Some(uid),
            warning,
        }),
        Err(reason) => out.emit(ReplayEvent::Failed { reason }),
    }
}

pub async fn handle(cmd: ReplayCommand, ctx: &ServiceCtx, out: &EventSink) {
    match cmd {
        ReplayCommand::WatchLive(target) => {
            cancel_live_tracking(out);
            watch_live(target, ctx, out).await;
        }
        ReplayCommand::TrackLive { target, action } => {
            let now = crate::services::now_seconds();
            let game = out.with_state(|state| {
                state
                    .lobby
                    .live_games
                    .iter()
                    .find(|game| game.id == target.uid)
                    .map(|game| (game.title.clone(), game.launched_at))
            });
            let Some((title, Some(launched_at))) = game else {
                out.emit(ReplayEvent::Failed {
                    reason: "That live game no longer has a known start time.".into(),
                });
                return;
            };
            let waiting = live_replay_delay_remaining(Some(launched_at), now);
            let tracking = LiveReplayTracking {
                target,
                title,
                action,
                ready_at: now.saturating_add(waiting),
            };
            out.emit(ReplayEvent::LiveTrackingScheduled {
                tracking: tracking.clone(),
            });

            if waiting > 0 {
                tokio::time::sleep(Duration::from_secs(u64::from(waiting))).await;
            }
            if !out.with_state(|state| state.replays.live_tracking.as_ref() == Some(&tracking)) {
                return;
            }
            out.emit(ReplayEvent::LiveTrackingCleared);

            match action {
                LiveReplayTrackingAction::Notify => notifications::add(
                    out,
                    NotificationKind::ReplayAvailable,
                    "Live replay ready",
                    format!("{} is now available to watch.", tracking.title),
                    Some(NotificationAction::WatchLive {
                        target: tracking.target,
                    }),
                ),
                LiveReplayTrackingAction::Watch => {
                    notifications::add(
                        out,
                        NotificationKind::ReplayAvailable,
                        "Live replay ready",
                        format!("Launching {} now.", tracking.title),
                        None,
                    );
                    watch_live(tracking.target, ctx, out).await;
                }
            }
        }
        ReplayCommand::CancelLiveTracking => out.emit(ReplayEvent::LiveTrackingCleared),
        ReplayCommand::OpenFile { path } => {
            cancel_live_tracking(out);
            out.emit(ReplayEvent::Connecting);
            match ctx.ports.replay.play_file(PathBuf::from(path)).await {
                Ok(warning) => out.emit(ReplayEvent::Playing { uid: None, warning }),
                Err(reason) => out.emit(ReplayEvent::Failed { reason }),
            }
        }
        ReplayCommand::SearchVault { query } => {
            // Ordering the API cannot combine with the requested filters is
            // adjusted here rather than at the request, so the query echoed
            // back with the results is the one that actually ran and the sort
            // picker stops showing an option the answer was not sorted by.
            let query = Box::new(query.accepted_by_api());
            let generation = ctx.replay_vault_generation.begin();
            out.emit(ReplayEvent::VaultLoading);
            let result = ctx.ports.replay.search_vault((*query).clone()).await;
            if !ctx.replay_vault_generation.is_current(generation) {
                return;
            }
            match result {
                Ok(search) => {
                    // A full page is direct evidence that another one exists,
                    // and it outranks the reported count. The API's totals for
                    // a table this size can be capped or estimated, and
                    // deriving `has_more` from the count alone meant a capped
                    // total stranded the user on its last page with a dead
                    // Next button.
                    let full_page = search.replays.len() as u32 >= query.page_size;
                    let has_more = full_page
                        || search
                            .total_pages
                            .is_some_and(|pages| query.page < pages as u32);
                    out.emit(ReplayEvent::VaultLoaded {
                        replays: search.replays,
                        query,
                        has_more,
                        total_pages: search.total_pages,
                        total_records: search.total_records,
                    })
                }
                Err(reason) => out.emit(ReplayEvent::VaultLoadFailed { reason }),
            }
        }
        ReplayCommand::LoadFeaturedMods => {
            // Best-effort: the filter falls back to a free-choice "any" when
            // the list can't be fetched, so a failure here isn't worth a
            // user-visible error of its own.
            if let Ok(mods) = ctx.ports.replay.list_featured_mods().await {
                out.emit(ReplayEvent::FeaturedModsLoaded { mods });
            }
        }
        ReplayCommand::WatchVault { uid } => {
            cancel_live_tracking(out);
            out.emit(ReplayEvent::Connecting);
            // Watching a vault replay downloads it before launching FA. Keep
            // that work visible in the shared bottom status task, just like
            // the map and mod preparation done for a lobby join.
            out.emit(ReplayEvent::VaultDownloadStarted { uid });
            match ctx.ports.replay.watch_vault(uid).await {
                Ok(warning) => out.emit(ReplayEvent::Playing {
                    uid: Some(uid),
                    warning,
                }),
                Err(reason) => out.emit(ReplayEvent::Failed { reason }),
            }
        }
        ReplayCommand::DownloadVault { uid } => {
            out.emit(ReplayEvent::VaultDownloadStarted { uid });
            match ctx.ports.replay.download_vault(uid).await {
                Ok(replay) => out.emit(ReplayEvent::VaultDownloaded { uid, replay }),
                Err(reason) => out.emit(ReplayEvent::VaultDownloadFailed { uid, reason }),
            }
        }
        ReplayCommand::LoadLocal { limit } => {
            let generation = ctx.replay_local_generation.begin();
            out.emit(ReplayEvent::LocalLoading);
            let result = ctx.ports.replay.list_local(limit as usize).await;
            if !ctx.replay_local_generation.is_current(generation) {
                return;
            }
            match result {
                Ok(replays) => out.emit(ReplayEvent::LocalLoaded { replays }),
                Err(reason) => out.emit(ReplayEvent::LocalLoadFailed { reason }),
            }
        }
        ReplayCommand::DeleteLocal { path } => {
            // Prevent an older directory scan from restoring the deleted row.
            ctx.replay_local_generation.invalidate();
            match ctx.ports.replay.delete_local(PathBuf::from(&path)).await {
                Ok(()) => out.emit(ReplayEvent::LocalDeleted { path }),
                Err(reason) => out.emit(ReplayEvent::LocalLoadFailed { reason }),
            }
        }
        ReplayCommand::LoadDetails { uid, local_path } => {
            out.emit(ReplayEvent::DetailsLoading { uid });
            let path_buf = local_path.map(PathBuf::from);
            match ctx.ports.replay.load_details(uid, path_buf).await {
                Ok(details) => out.emit(ReplayEvent::DetailsLoaded { uid, details }),
                Err(reason) => out.emit(ReplayEvent::DetailsFailed { uid, reason }),
            }
        }
    }
}
