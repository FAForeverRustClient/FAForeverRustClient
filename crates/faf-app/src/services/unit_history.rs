//! Unit history orchestration: read the unit list on every visit, and build a
//! unit's history when it is chosen.
//!
//! A history needs four things: the unit (from the list), the releases (the
//! changelog's index, which the Game section has usually loaded already), the
//! release tags (a release without one has nothing to read), and one
//! blueprint per release. The blueprints are read twelve at a time with the
//! progress reported, then the base game's copy and the fragmenting
//! projectiles are read, and the pure part of the work is done off the async
//! runtime.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use faf_domain::protocol::changelog::ChangelogRelease;
use faf_domain::protocol::unit_history::{
    blueprint_paths, build_history, release_number, ReleaseBlueprint, ReleaseInput, UnitHistory,
    UnitSummary,
};
use faf_domain::state::{
    normalized_selection, ChangelogStatus, UnitHistoryCommand, UnitHistoryEvent, UnitHistoryStatus,
    UnitListStatus,
};
use futures_util::{stream, StreamExt};
use tokio::time::Instant;

use crate::runtime::{EventSink, ServiceCtx};

/// Bound by round trips rather than bandwidth, like the changelog search,
/// which measured twelve as the point past which more only lengthened the
/// slowest replies.
const DOWNLOADS: usize = 12;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(200);

/// The histories being built. Owned by this service.
pub struct UnitHistoryContext {
    /// A unit chosen twice while its history is still being read is built
    /// once: the second choice finds it here and leaves it to the first.
    building: Mutex<HashMap<String, Arc<tokio_util::sync::CancellationToken>>>,
    downloads: Arc<tokio::sync::Semaphore>,
}

impl Default for UnitHistoryContext {
    fn default() -> Self {
        Self {
            building: Mutex::default(),
            downloads: Arc::new(tokio::sync::Semaphore::new(DOWNLOADS)),
        }
    }
}

pub(crate) struct SelectionWork {
    builds: Vec<(String, Arc<tokio_util::sync::CancellationToken>)>,
}

/// Takes a unit off [`UnitHistoryContext::building`] however the build ends.
struct Building<'a> {
    context: &'a UnitHistoryContext,
    id: String,
    owner: Arc<tokio_util::sync::CancellationToken>,
}

impl Drop for Building<'_> {
    fn drop(&mut self) {
        let mut building = self
            .context
            .building
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if building
            .get(&self.id)
            .is_some_and(|owner| Arc::ptr_eq(owner, &self.owner))
        {
            building.remove(&self.id);
        }
    }
}

pub async fn handle(cmd: UnitHistoryCommand, ctx: &ServiceCtx, out: &EventSink) {
    match cmd {
        UnitHistoryCommand::LoadList => load_list(ctx, out).await,
        UnitHistoryCommand::Select { id } => set_selection(vec![id], ctx, out).await,
        UnitHistoryCommand::SetSelection { ids } => set_selection(ids, ctx, out).await,
    }
}

/// Show these units and build histories not held yet. All selected units share
/// twelve downloads; a unit already on disk is built in a moment.
async fn set_selection(ids: Vec<String>, ctx: &ServiceCtx, out: &EventSink) {
    let work = begin_selection(ids, ctx, out);
    run_selection(work, ctx, out).await;
}

/// Claim the selection before task spawn, retaining work for units still selected.
pub(crate) fn begin_selection(
    ids: Vec<String>,
    ctx: &ServiceCtx,
    out: &EventSink,
) -> SelectionWork {
    let ids = normalized_selection(&ids);
    out.emit(UnitHistoryEvent::SelectionChanged { ids: ids.clone() });
    let ready = out.with_state(|state| {
        ids.iter()
            .filter(|id| {
                matches!(
                    state.unit_history.histories.get(*id),
                    Some(UnitHistoryStatus::Ready { .. })
                )
            })
            .cloned()
            .collect::<Vec<_>>()
    });
    let mut building = ctx
        .unit_history
        .building
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    building.retain(|id, cancelled| {
        if ids.contains(id) {
            true
        } else {
            cancelled.cancel();
            false
        }
    });
    let mut builds = Vec::new();
    for id in ids {
        if ready.contains(&id) || building.contains_key(&id) {
            continue;
        }
        let owner = Arc::new(tokio_util::sync::CancellationToken::new());
        building.insert(id.clone(), owner.clone());
        builds.push((id, owner));
    }
    SelectionWork { builds }
}

pub(crate) async fn run_selection(work: SelectionWork, ctx: &ServiceCtx, out: &EventSink) {
    futures_util::future::join_all(
        work.builds
            .into_iter()
            .map(|(id, owner)| build(id, owner, ctx, out)),
    )
    .await;
}

async fn load_list(ctx: &ServiceCtx, out: &EventSink) {
    // A reload with a list on screen is not shown as a load, and a failed one
    // leaves that list alone, as the changelog index does.
    let showing = out.with_state(|state| {
        matches!(state.unit_history.list_status, UnitListStatus::Ready)
            && !state.unit_history.units.is_empty()
    });
    if !showing {
        out.emit(UnitHistoryEvent::ListLoading);
    }
    let install_dir = ctx.ports.process.game_install_dir();
    match ctx.ports.unit_history.list_units(install_dir).await {
        Ok(units) => out.emit(UnitHistoryEvent::ListLoaded { units }),
        Err(reason) => {
            if !showing {
                out.emit(UnitHistoryEvent::ListFailed { reason });
            }
        }
    }
}

async fn build(
    id: String,
    owner: Arc<tokio_util::sync::CancellationToken>,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    let _building = Building {
        context: &ctx.unit_history,
        id: id.clone(),
        owner: owner.clone(),
    };
    let held = out.with_state(|state| {
        matches!(
            state.unit_history.histories.get(&id),
            Some(UnitHistoryStatus::Ready { .. })
        )
    });
    if held || owner.is_cancelled() {
        return;
    }
    let result = tokio::select! {
        biased;
        () = owner.cancelled() => return,
        result = history(&id, ctx, out) => result,
    };
    if owner.is_cancelled() {
        return;
    }
    match result {
        Ok(history) => out.emit(UnitHistoryEvent::HistoryLoaded {
            history: Box::new(history),
        }),
        Err(reason) => out.emit(UnitHistoryEvent::HistoryFailed { id, reason }),
    }
}

/// The unit, from the list; a link can open the section on a unit before the
/// list was ever read, so it is read here then.
async fn unit(id: &str, ctx: &ServiceCtx, out: &EventSink) -> Result<UnitSummary, String> {
    if let Some(unit) = out.with_state(|state| state.unit_history.unit(id).cloned()) {
        return Ok(unit);
    }
    load_list(ctx, out).await;
    out.with_state(|state| state.unit_history.unit(id).cloned())
        .ok_or_else(|| format!("unit {id} is not in the installed game"))
}

async fn releases(ctx: &ServiceCtx, out: &EventSink) -> Result<Vec<ChangelogRelease>, String> {
    let loaded = out.with_state(|state| {
        (state.changelog.status == ChangelogStatus::Ready).then(|| state.changelog.releases.clone())
    });
    match loaded {
        Some(releases) => Ok(releases),
        None => ctx.ports.changelog.list_releases().await,
    }
}

async fn history(id: &str, ctx: &ServiceCtx, out: &EventSink) -> Result<UnitHistory, String> {
    let unit = unit(id, ctx, out).await?;
    let tags = ctx.ports.unit_history.release_tags().await?;
    // Oldest first: release numbers grow with the date.
    let mut releases: Vec<(u32, ChangelogRelease)> = releases(ctx, out)
        .await?
        .into_iter()
        .filter(|release| !release.is_rolling() && tags.contains(&release.id))
        .filter_map(|release| release_number(&release.id).map(|number| (number, release)))
        .collect();
    releases.sort_by_key(|(number, _)| *number);
    if releases.is_empty() {
        return Err("no release of the changelog has a tag in the game repository".into());
    }

    let total = releases.len() as u32;
    out.emit(UnitHistoryEvent::HistoryProgress {
        id: id.to_owned(),
        fetched: 0,
        total,
    });
    let port = ctx.ports.unit_history.clone();
    let jobs: Vec<_> = releases
        .iter()
        .enumerate()
        .map(|(index, (number, release))| {
            let port = port.clone();
            let downloads = ctx.unit_history.downloads.clone();
            let paths = blueprint_paths(*number, &unit.path);
            let tag = release.id.clone();
            async move {
                let _permit = downloads
                    .acquire_owned()
                    .await
                    .expect("unit history budget stays open");
                (index, port.release_blueprint(&tag, &paths).await)
            }
        })
        .collect();
    let mut reads = stream::iter(jobs).buffer_unordered(DOWNLOADS);
    let mut blueprints: Vec<Option<ReleaseBlueprint>> = vec![None; releases.len()];
    let mut fetched = 0;
    let mut reported = Instant::now();
    while let Some((index, blueprint)) = reads.next().await {
        blueprints[index] = Some(blueprint);
        fetched += 1;
        if reported.elapsed() >= PROGRESS_INTERVAL {
            reported = Instant::now();
            out.emit(UnitHistoryEvent::HistoryProgress {
                id: id.to_owned(),
                fetched,
                total,
            });
        }
    }
    drop(reads);

    let install_dir = ctx.ports.process.game_install_dir();
    let (base, fragmenting) = tokio::join!(
        port.base_game(&unit),
        port.fragmenting_projectiles(install_dir)
    );
    let inputs: Vec<ReleaseInput> = releases
        .into_iter()
        .zip(blueprints)
        .map(|((_, release), blueprint)| ReleaseInput {
            release: release.id,
            date: release.date,
            blueprint: blueprint
                .unwrap_or_else(|| ReleaseBlueprint::Failed("the release was not read".into())),
        })
        .collect();
    tokio::task::spawn_blocking(move || {
        build_history(unit, inputs, &base, &|projectile: &str| {
            fragmenting.contains(&projectile.to_ascii_lowercase())
        })
    })
    .await
    .map_err(|_| "the unit history could not be built".to_owned())
}
