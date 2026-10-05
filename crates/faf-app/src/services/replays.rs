//! Replays service.
//!
//! Thin handler (like `services/nav.rs`): asks the replay ports (vault,
//! library, details, playback; see [`crate::ports::replay`]) to do the work,
//! then emits `Connecting`/`Playing`/`Failed`. The actual protocol (WebSocket
//! relay, file decompression, launching FA) lives entirely behind the ports:
//! see `infra/replay/`.

use crate::ports::PreparationStep;
use faf_domain::state::ReplayPreparation;
use faf_domain::state::{
    live_replay_delay_remaining, LiveReplayTarget, LiveReplayTracking, LiveReplayTrackingAction,
    NotificationAction, NotificationKind, ReplayCommand, ReplayEvent, ReplayQuery,
    ResolvedReplayMap, VaultReplay,
};
use std::collections::HashMap;
use std::{path::PathBuf, time::Duration};

use crate::runtime::{EventSink, LatestRequest, ServiceCtx};
use crate::services::notifications;

/// The replay service's operational context: which vault and local listings
/// may still land, and the replay launch in flight. Owned by this service.
#[derive(Default)]
pub struct ReplaysContext {
    /// Only the newest vault search may land. Commands run concurrently, so
    /// request order is not response order.
    vault_generation: LatestRequest,
    /// Only the newest local listing may land. Deleting a replay invalidates
    /// it as well, so an older directory scan cannot restore the deleted row.
    local_generation: LatestRequest,
    /// The in-flight replay launch, so the overlay's Cancel button has
    /// something to press. Same shape as the auth service's login
    /// cancellation, and for the same reason: dropping the future is the only
    /// thing that actually stops work that is several awaits deep inside a
    /// port.
    cancellation: std::sync::Mutex<Option<tokio_util::sync::CancellationToken>>,
}

/// How many replay heads are fetched at the same time.
const RESOLVE_MAPS_AT_ONCE: usize = 6;
/// How many games one resolve command will look up at all.
const MAX_MAPS_PER_RESOLVE: usize = 120;

/// A remaining wait, phrased for someone staring at a button.
fn describe(seconds: u32) -> String {
    match seconds {
        0..=59 => format!("{seconds}s"),
        _ => format!("{}m {}s", seconds / 60, seconds % 60),
    }
}

/// Start a replay, and stop if the user calls it off.
///
/// Dropping the port's future is what cancels it: fetching the file,
/// decompressing it, preparing the map and opening the relay are a chain of
/// awaits, and the one it is sitting in when Cancel is pressed never resumes.
/// Once the port has returned, Forged Alliance has already been handed the
/// file and there is nothing left to call off, so a cancel arriving then loses
/// the race and the launch is reported as the launch it is.
///
/// Cancelling emits [`ReplayEvent::Closed`], which is the same "back to idle,
/// you can start another one" this uses when a replay session ends of its own
/// accord. A cancelled start is not a failure and must not be reported as one:
/// the overlay would turn into an error nobody asked about.
async fn launch(
    work: impl std::future::Future<Output = Result<Option<String>, String>>,
    uid: Option<i32>,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    let token = tokio_util::sync::CancellationToken::new();
    if let Ok(mut slot) = ctx.replays.cancellation.lock() {
        // Replacing an armed token cancels it: two launches cannot be in
        // flight, and the older one is the one nobody is waiting for.
        if let Some(previous) = slot.replace(token.clone()) {
            previous.cancel();
        }
    }

    // What the preparation is doing, onto the starting dialog (#392).
    let sink = out.clone();
    ctx.ports
        .replay_playback
        .set_preparation_progress(Some(std::sync::Arc::new(move |step: PreparationStep| {
            sink.emit(ReplayEvent::Preparing {
                step: ReplayPreparation {
                    detail: step.detail,
                    progress: step.progress,
                },
            });
        })));
    let result = tokio::select! {
        result = work => result,
        () = token.cancelled() => {
            ctx.ports.replay_playback.set_preparation_progress(None);
            out.emit(ReplayEvent::Closed);
            return;
        }
    };
    ctx.ports.replay_playback.set_preparation_progress(None);

    if let Ok(mut slot) = ctx.replays.cancellation.lock() {
        // Disarmed, so a Cancel pressed after the game is up cannot idle the
        // status of a replay that is playing.
        slot.take();
    }
    match result {
        Ok(warning) => out.emit(ReplayEvent::Playing { uid, warning }),
        Err(reason) => fail(out, reason),
    }
}

/// Report a replay that did not start.
///
/// Both halves, and both on purpose. The status keeps the tab's own state
/// machine honest, which is what re-enables the buttons; the notification is
/// what the user actually reads, because the status line used to be a strip of
/// text above the search panel that a reader who had just double-clicked a game
/// was not looking at, and that the next successful action wiped without a
/// trace. Failures belong where every other operational message in this client
/// already collects.
///
/// `add_required`, not `add`: a launch that did not happen is not an event
/// alert, and turning match and chat notifications off must not silence the one
/// message explaining why nothing opened.
fn fail(out: &EventSink, reason: String) {
    notifications::add_required(
        out,
        NotificationKind::Error,
        "Replay failed",
        reason.clone(),
        None,
    );
    out.emit(ReplayEvent::Failed { reason });
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
        fail(
            out,
            format!(
                "Live replays are delayed by five minutes so nobody can watch \
                 an ongoing game for an advantage. Try again in {}.",
                describe(waiting)
            ),
        );
        return;
    }

    out.emit(ReplayEvent::Connecting);
    let uid = target.uid;
    launch(
        ctx.ports.replay_playback.watch_live(target, player),
        Some(uid),
        ctx,
        out,
    )
    .await;
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
                fail(
                    out,
                    "That live game no longer has a known start time.".into(),
                );
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
            launch(
                ctx.ports.replay_playback.play_file(PathBuf::from(path)),
                None,
                ctx,
                out,
            )
            .await;
        }
        ReplayCommand::CancelWatch => {
            if let Ok(mut slot) = ctx.replays.cancellation.lock() {
                if let Some(token) = slot.take() {
                    token.cancel();
                }
            }
        }
        ReplayCommand::SearchVault { query } => {
            let generation = ctx.replays.vault_generation.begin();
            out.emit(ReplayEvent::VaultLoading);
            let result = ctx.ports.replay_vault.search_vault((*query).clone()).await;
            if !ctx.replays.vault_generation.is_current(generation) {
                return;
            }
            match result {
                Ok(mut search) => {
                    // A full page is direct evidence that another one exists,
                    // and it outranks the reported count. The API's totals for
                    // a table this size can be capped or estimated, and
                    // deriving `has_more` from the count alone meant a capped
                    // total stranded the user on its last page with a dead
                    // Next button.
                    let full_page = search.replays.len() as u32 >= query.page_size;
                    // A game still being played has a record and no end yet.
                    // It belongs to the live tab, where it can be watched;
                    // here it was a replay that did not exist (#399). Counted
                    // for `full_page` above first, so dropping it never makes
                    // a page look like the last one.
                    search.replays.retain(|replay| !replay.end_time.is_empty());
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
        ReplayCommand::LoadRecentMatchmaker => {
            let Some(login) =
                out.with_state(|state| state.auth.player.as_ref().map(|p| p.name.clone()))
            else {
                return;
            };
            out.emit(ReplayEvent::RecentMatchmakerLoading);
            match ctx
                .ports
                .replay_vault
                .search_vault(recent_matchmaker_query(login))
                .await
            {
                Ok(search) => out.emit(ReplayEvent::RecentMatchmakerLoaded {
                    replays: search.replays,
                }),
                Err(reason) => out.emit(ReplayEvent::RecentMatchmakerFailed { reason }),
            }
        }
        ReplayCommand::LoadFeaturedMods => {
            // Best-effort: the filter falls back to a free-choice "any" when
            // the list can't be fetched, so a failure here isn't worth a
            // user-visible error of its own.
            if let Ok(mods) = ctx.ports.replay_vault.list_featured_mods().await {
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
            launch(
                ctx.ports.replay_playback.watch_vault(uid),
                Some(uid),
                ctx,
                out,
            )
            .await;
        }
        ReplayCommand::DownloadVault { uid } => {
            out.emit(ReplayEvent::VaultDownloadStarted { uid });
            match ctx.ports.replay_vault.download_vault(uid).await {
                Ok(replay) => out.emit(ReplayEvent::VaultDownloaded { uid, replay }),
                Err(reason) => out.emit(ReplayEvent::VaultDownloadFailed { uid, reason }),
            }
        }
        ReplayCommand::LoadLocal { limit } => {
            let generation = ctx.replays.local_generation.begin();
            out.emit(ReplayEvent::LocalLoading);
            let result = ctx.ports.replay_library.list_local(limit as usize).await;
            if !ctx.replays.local_generation.is_current(generation) {
                return;
            }
            match result {
                Ok(replays) => out.emit(ReplayEvent::LocalLoaded { replays }),
                Err(reason) => out.emit(ReplayEvent::LocalLoadFailed { reason }),
            }
        }
        ReplayCommand::DeleteLocal { path } => {
            // Prevent an older directory scan from restoring the deleted row.
            ctx.replays.local_generation.invalidate();
            match ctx
                .ports
                .replay_library
                .delete_local(PathBuf::from(&path))
                .await
            {
                Ok(()) => out.emit(ReplayEvent::LocalDeleted { path }),
                Err(reason) => out.emit(ReplayEvent::LocalLoadFailed { reason }),
            }
        }
        ReplayCommand::LoadDetails { uid, local_path } => {
            out.emit(ReplayEvent::DetailsLoading { uid });
            let path_buf = local_path.map(PathBuf::from);
            match ctx.ports.replay_details.load_details(uid, path_buf).await {
                Ok(details) => out.emit(ReplayEvent::DetailsLoaded { uid, details }),
                Err(reason) => out.emit(ReplayEvent::DetailsFailed { uid, reason }),
            }
        }
        ReplayCommand::LoadAnalysis { uid, local_path } => {
            out.emit(ReplayEvent::AnalysisLoading { uid });
            let path_buf = local_path.map(PathBuf::from);
            match ctx.ports.replay_details.load_analysis(uid, path_buf).await {
                Ok(analysis) => out.emit(ReplayEvent::AnalysisLoaded { analysis }),
                Err(reason) => out.emit(ReplayEvent::AnalysisFailed { uid, reason }),
            }
        }
        ReplayCommand::ResolveMaps { uids } => {
            // One small ranged download per game, run a few at a time. In
            // sequence a page of them would still be arriving after the reader
            // had moved on; all at once would be a burst at somebody else's
            // vault for a cosmetic detail. The cap is on the command as well,
            // so a page that grows never turns into a flood.
            let mut maps = Vec::with_capacity(uids.len().min(MAX_MAPS_PER_RESOLVE));
            for chunk in uids
                .iter()
                .take(MAX_MAPS_PER_RESOLVE)
                .collect::<Vec<_>>()
                .chunks(RESOLVE_MAPS_AT_ONCE)
            {
                let lookups = chunk.iter().map(|uid| async {
                    // A failure is recorded as "no map", not retried: the view
                    // asks once per game, and a row that keeps asking on every
                    // render is worse than a row that says it does not know.
                    let map = ctx
                        .ports
                        .replay_vault
                        .replay_map_name(**uid)
                        .await
                        .ok()
                        .flatten()
                        .unwrap_or_default();
                    ResolvedReplayMap { uid: **uid, map }
                });
                maps.extend(futures_util::future::join_all(lookups).await);
            }
            if !maps.is_empty() {
                out.emit(ReplayEvent::MapsResolved { maps });
            }
        }
        ReplayCommand::LookUpOnline { uid } => {
            // A single-id search rather than a port method of its own: the
            // vault query already has a `replay_id` field, and this way the
            // lookup goes down exactly the code path the search tab uses.
            // The result lands in `online_lookups`, never in `vault`, so
            // opening a local replay does not replace what the Online tab is
            // showing.
            out.emit(ReplayEvent::OnlineLookupStarted { uid });
            let query = ReplayQuery {
                replay_id: uid.to_string(),
                page_size: 1,
                ..ReplayQuery::default()
            };
            match ctx.ports.replay_vault.search_vault(query).await {
                Ok(search) => out.emit(ReplayEvent::OnlineLookupFinished {
                    uid,
                    replay: search
                        .replays
                        .into_iter()
                        .find(|replay| replay.uid == uid)
                        .map(Box::new),
                }),
                Err(reason) => out.emit(ReplayEvent::OnlineLookupFailed { uid, reason }),
            }
        }
        ReplayCommand::LookUpOnlineMany { uids } => look_up_many(uids, ctx, out).await,
    }
}

/// How many game ids one request asks about.
///
/// The API rewrites anything above 100 down to its default page size without
/// saying so, and each row here drags a dozen `playerStats` and their players
/// along with it: a page of twenty-five is a document worth reading in one go
/// rather than a megabyte of JSON for a list somebody is scrolling past.
const LOOKUP_BATCH: usize = 25;

/// Ask the vault about a set of game ids, in batches.
///
/// Every id is marked as being looked up first, so a second call about the
/// same games while this one is in flight finds them already claimed. An id
/// the vault does not answer for is recorded as missing rather than left
/// pending: a running game the API has not written a row for yet is a result,
/// and asking again every time the list refreshes is not.
///
/// The claim is checked here, too, not only promised: ids already claimed or
/// answered are dropped before anything is asked. A burst of overlapping
/// calls used to look every game up as many times as it was asked about.
async fn look_up_many(uids: Vec<i32>, ctx: &ServiceCtx, out: &EventSink) {
    let uids: Vec<i32> = out.with_state(|state| {
        uids.into_iter()
            .filter(|uid| !state.replays.online_lookups.contains_key(uid))
            .collect()
    });
    if uids.is_empty() {
        return;
    }
    for uid in &uids {
        out.emit(ReplayEvent::OnlineLookupStarted { uid: *uid });
    }
    for chunk in uids.chunks(LOOKUP_BATCH) {
        let query = ReplayQuery {
            replay_ids: chunk.iter().map(i32::to_string).collect(),
            page_size: chunk.len() as u32,
            ..ReplayQuery::default()
        };
        match ctx.ports.replay_vault.search_vault(query).await {
            Ok(search) => {
                let mut found: HashMap<i32, VaultReplay> = search
                    .replays
                    .into_iter()
                    .map(|replay| (replay.uid, replay))
                    .collect();
                for uid in chunk {
                    out.emit(ReplayEvent::OnlineLookupFinished {
                        uid: *uid,
                        replay: found.remove(uid).map(Box::new),
                    });
                }
            }
            Err(reason) => {
                for uid in chunk {
                    out.emit(ReplayEvent::OnlineLookupFailed {
                        uid: *uid,
                        reason: reason.clone(),
                    });
                }
            }
        }
    }
}
/// The matchmaker leaderboards, by the technical names a replay's rating
/// changes carry. `global` is left out: that is every custom game.
const MATCHMAKER_LEADERBOARDS: [&str; 4] =
    ["ladder_1v1", "tmm_2v2", "tmm_3v3", "tmm_4v4_full_share"];

/// How many games the matchmaker tab lists.
const RECENT_MATCHMAKER_GAMES: u32 = 10;

/// The player's own latest matchmaker games, newest first (#301).
///
/// An exact login rather than a part of one, so another player whose name
/// contains this one is not mixed in.
fn recent_matchmaker_query(login: String) -> ReplayQuery {
    ReplayQuery {
        player: login,
        exact_player: true,
        leaderboards: MATCHMAKER_LEADERBOARDS
            .iter()
            .map(|name| (*name).to_string())
            .collect(),
        page_size: RECENT_MATCHMAKER_GAMES,
        ..ReplayQuery::default()
    }
}
