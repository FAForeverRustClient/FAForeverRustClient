//! Disk-first lookup catalogue loading. Live vault searches use a separate path.
use crate::ports::catalogue::{
    changes_anything, is_later, merge_changes, CachedCatalogue, CatalogueBatch,
};
use crate::runtime::{EventSink, ServiceCtx};
use chrono::Utc;
use faf_domain::state::{ModListStatus, ModsEvent, VaultMod};
use tokio_util::sync::CancellationToken;

/// Load the mod catalogue: `LoadVault` (`force` off), or "Check for updates"
/// (`ReloadVault`, `force` on), which always asks the server and shows
/// Loading until it has.
pub(super) async fn load(ctx: &ServiceCtx, out: &EventSink, force: bool) {
    crate::runtime::expect_admitted(if force {
        crate::runtime::Key::ModVaultCheck
    } else {
        crate::runtime::Key::ModVault
    });
    // One load or check at a time: a check waits here for a background load
    // already running, and a load that waited for a check finds it Ready.
    let _writer = ctx.mods.catalogue_writer.lock().await;

    if !force
        && out.with_state(|state| {
            matches!(
                state.mods.vault_status,
                ModListStatus::Loading | ModListStatus::Ready
            )
        })
    {
        return;
    }
    let had_ready = out.with_state(|state| state.mods.vault_status == ModListStatus::Ready);
    let cancel = ctx.mods.catalogue.begin();
    // A check shows Loading until the server has answered, and nothing in
    // between: the saved copy published first read as Ready, and the update
    // check reported on that copy before the server said anything.
    if force {
        out.emit(ModsEvent::VaultLoading);
    }
    let cached = tokio::select! {
        biased;
        () = cancel.cancelled() => {
            if force || !had_ready { out.emit(ModsEvent::VaultCancelled); }
            return;
        }
        cached = ctx.ports.mods.load_catalogue_cache() => cached,
    };
    if let Some(cache) = &cached {
        tracing::info!(entries = cache.entries.len(), age_seconds = ?cache.age_seconds(Utc::now()), "mod vault: loaded disk catalogue");
        if !had_ready && !force {
            out.emit(ModsEvent::VaultLoaded {
                mods: cache.entries.clone(),
            });
        }
    }
    let mut full = cached
        .as_ref()
        .is_none_or(|cache| !force && cache.needs_full_refresh(Utc::now()));
    let visible = force || (cached.is_none() && !had_ready);
    if visible && !force {
        out.emit(ModsEvent::VaultLoading);
    }
    let since = cached
        .as_ref()
        .map(|cache| cache.newest_change.clone())
        .unwrap_or_default();
    let started = std::time::Instant::now();
    let Some(mut result) = fetch(ctx, out, &cancel, full, visible, &since).await else {
        return;
    };
    // A weekly crawl that fails falls back to the changes since the saved
    // copy, as for maps: otherwise it stayed due and nothing refreshed it.
    if full && cached.is_some() {
        if let Err(reason) = &result {
            tracing::warn!(%reason, "mod vault: weekly catalogue refresh failed; fetching changes instead");
            full = false;
            let Some(delta) = fetch(ctx, out, &cancel, false, false, &since).await else {
                return;
            };
            result = delta;
        }
    }
    let batch = match result {
        Ok(batch) => batch,
        Err(reason) => {
            tracing::warn!(%reason, full, seconds = started.elapsed().as_secs_f32(), "mod vault: catalogue refresh failed");
            if visible {
                // A check that could not reach the server still leaves the
                // saved copy to look things up in; the failure is what it says.
                if force && !had_ready {
                    if let Some(cache) = &cached {
                        out.emit(ModsEvent::VaultLoaded {
                            mods: cache.entries.clone(),
                        });
                    }
                }
                out.emit(ModsEvent::VaultLoadFailed { reason });
            }
            return;
        }
    };
    tracing::info!(
        full,
        changes = batch.entries.len(),
        removed = batch.removed_ids.len(),
        pages = batch.pages,
        seconds = started.elapsed().as_secs_f32(),
        "mod vault: catalogue refreshed"
    );
    let catalogue = if full {
        out.emit(ModsEvent::VaultLoaded {
            mods: batch.entries.clone(),
        });
        CachedCatalogue {
            full_at: Utc::now().to_rfc3339(),
            newest_change: batch.newest_change,
            entries: batch.entries,
        }
    } else {
        let mut cache = cached.expect("delta has a cache");
        let removed = batch.removed_ids.clone();
        let key = |item: &VaultMod| item.mod_id;
        let keep = |item: &VaultMod| !removed.contains(&item.mod_id);
        let changed = changes_anything(&cache.entries, &batch.entries, key, keep)
            || cache
                .entries
                .iter()
                .any(|item| removed.contains(&item.mod_id));
        if changed {
            cache.entries.retain(|item| !removed.contains(&item.mod_id));
            merge_changes(&mut cache.entries, &batch.entries, key, keep);
        }
        if force && !had_ready {
            // Nothing was published from the copy (see above): the whole
            // catalogue, brought up to date, is the answer.
            out.emit(ModsEvent::VaultLoaded {
                mods: cache.entries.clone(),
            });
        } else if changed || force {
            // A check always ends its Loading, changed or not.
            out.emit(ModsEvent::VaultUpdated {
                mods: batch.entries.clone(),
                removed_ids: batch.removed_ids.clone(),
            });
        }
        if !changed && !is_later(&batch.newest_change, &cache.newest_change) {
            return;
        }
        cache.newest_change = batch.newest_change;
        cache
    };
    // Review totals and game counts may stay stale until the weekly full
    // refresh. The lookup index supplies art and metadata, not live searches.
    if !catalogue.newest_change.is_empty() {
        if let Err(reason) = ctx.ports.mods.save_catalogue_cache(catalogue).await {
            tracing::warn!(%reason, "mod vault: could not save catalogue cache");
        }
    }
}

/// One read of the catalogue, whole or since `since`, with its progress shown
/// when `visible`. `None` when it was called off, which has been said already.
async fn fetch(
    ctx: &ServiceCtx,
    out: &EventSink,
    cancel: &CancellationToken,
    full: bool,
    visible: bool,
    since: &str,
) -> Option<Result<CatalogueBatch<VaultMod>, String>> {
    let (progress_tx, mut progress_rx) = tokio::sync::mpsc::channel(32);
    let request = async {
        if full {
            ctx.ports
                .mods
                .catalogue_full(visible.then_some(progress_tx))
                .await
        } else {
            ctx.ports.mods.catalogue_delta(since).await
        }
    };
    tokio::pin!(request);
    loop {
        tokio::select! {
            biased;
            () = cancel.cancelled() => {
                if visible { out.emit(ModsEvent::VaultCancelled); }
                return None;
            }
            result = &mut request => return Some(result),
            Some(progress) = progress_rx.recv(), if visible => out.emit(ModsEvent::VaultProgress { progress }),
        }
    }
}
