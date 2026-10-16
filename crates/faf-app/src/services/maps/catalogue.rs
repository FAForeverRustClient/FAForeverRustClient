//! Disk-first lookup catalogue loading. Live vault searches use a separate path.
use crate::ports::catalogue::{
    changes_anything, is_later, merge_changes, CachedCatalogue, CatalogueBatch,
};
use crate::runtime::{EventSink, ServiceCtx};
use chrono::Utc;
use faf_domain::state::{MapListStatus, MapsEvent, VaultMap};
use tokio_util::sync::CancellationToken;

pub(super) async fn load(ctx: &ServiceCtx, out: &EventSink) {
    crate::runtime::expect_admitted(crate::runtime::Key::MapVault);
    if out.with_state(|state| matches!(state.maps.vault_status, MapListStatus::Ready)) {
        return;
    }
    let cancel = ctx.maps.catalogue.begin();
    let cached = tokio::select! {
        biased;
        () = cancel.cancelled() => {
            out.emit(MapsEvent::VaultCancelled);
            return;
        }
        cached = ctx.ports.maps.load_catalogue_cache() => cached,
    };
    if let Some(cache) = &cached {
        tracing::info!(entries = cache.entries.len(), age_seconds = ?cache.age_seconds(Utc::now()), "map vault: loaded disk catalogue");
        out.emit(MapsEvent::VaultLoaded {
            maps: cache.entries.clone(),
        });
    }
    let mut full = cached
        .as_ref()
        .is_none_or(|cache| cache.needs_full_refresh(Utc::now()));
    let visible = cached.is_none();
    if visible {
        out.emit(MapsEvent::VaultLoading);
    }
    let since = cached
        .as_ref()
        .map(|cache| cache.newest_change.clone())
        .unwrap_or_default();
    let started = std::time::Instant::now();
    let Some(mut result) = fetch(ctx, out, &cancel, full, visible, &since).await else {
        return;
    };
    // A weekly crawl that fails leaves the saved copy, and without this it
    // stayed due, so every later start tried the crawl again and nothing
    // brought the copy up to date in the meantime. A delta still can.
    if full && cached.is_some() {
        if let Err(reason) = &result {
            tracing::warn!(%reason, "map vault: weekly catalogue refresh failed; fetching changes instead");
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
            tracing::warn!(%reason, full, seconds = started.elapsed().as_secs_f32(), "map vault: catalogue refresh failed");
            if visible {
                out.emit(MapsEvent::VaultLoadFailed { reason });
            }
            return;
        }
    };
    tracing::info!(
        full,
        changes = batch.entries.len(),
        pages = batch.pages,
        seconds = started.elapsed().as_secs_f32(),
        "map vault: catalogue refreshed"
    );
    let catalogue = if full {
        out.emit(MapsEvent::VaultLoaded {
            maps: batch.entries.clone(),
        });
        CachedCatalogue {
            full_at: Utc::now().to_rfc3339(),
            newest_change: batch.newest_change,
            entries: batch.entries,
        }
    } else {
        let mut cache = cached.expect("delta has a cache");
        let key = |map: &VaultMap| map.map_id;
        let keep = |map: &VaultMap| !map.hidden;
        let changed = changes_anything(&cache.entries, &batch.entries, key, keep);
        if changed {
            out.emit(MapsEvent::VaultUpdated {
                maps: batch.entries.clone(),
            });
            merge_changes(&mut cache.entries, &batch.entries, key, keep);
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
        if let Err(reason) = ctx.ports.maps.save_catalogue_cache(catalogue).await {
            tracing::warn!(%reason, "map vault: could not save catalogue cache");
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
) -> Option<Result<CatalogueBatch<VaultMap>, String>> {
    let (progress_tx, mut progress_rx) = tokio::sync::mpsc::channel(32);
    let request = async {
        if full {
            ctx.ports
                .maps
                .catalogue_full(visible.then_some(progress_tx))
                .await
        } else {
            ctx.ports.maps.catalogue_delta(since).await
        }
    };
    tokio::pin!(request);
    loop {
        tokio::select! {
            biased;
            () = cancel.cancelled() => {
                if visible { out.emit(MapsEvent::VaultCancelled); }
                return None;
            }
            result = &mut request => return Some(result),
            Some(progress) = progress_rx.recv(), if visible => out.emit(MapsEvent::VaultProgress { progress }),
        }
    }
}
