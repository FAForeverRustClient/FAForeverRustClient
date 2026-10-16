//! Disk-first lookup catalogue loading. Live vault searches use a separate path.
use crate::ports::catalogue::CachedCatalogue;
use crate::runtime::{EventSink, ServiceCtx};
use chrono::Utc;
use faf_domain::state::{MapListStatus, MapsEvent};

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
    let full = cached
        .as_ref()
        .is_none_or(|cache| cache.needs_full_refresh(Utc::now()));
    let visible = cached.is_none();
    if visible {
        out.emit(MapsEvent::VaultLoading);
    }
    let started = std::time::Instant::now();
    let (progress_tx, mut progress_rx) = tokio::sync::mpsc::channel(32);
    let since = cached
        .as_ref()
        .map(|cache| cache.newest_change.clone())
        .unwrap_or_default();
    let request = async {
        if full {
            ctx.ports
                .maps
                .catalogue_full(visible.then_some(progress_tx))
                .await
        } else {
            ctx.ports.maps.catalogue_delta(&since).await
        }
    };
    tokio::pin!(request);
    let result = loop {
        tokio::select! {
            biased;
            () = cancel.cancelled() => {
                if visible { out.emit(MapsEvent::VaultCancelled); }
                return;
            }
            result = &mut request => break result,
            Some(progress) = progress_rx.recv(), if visible => out.emit(MapsEvent::VaultProgress { progress }),
        }
    };
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
        removed = batch.removed_ids.len(),
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
        out.emit(MapsEvent::VaultUpdated {
            maps: batch.entries.clone(),
        });
        let mut cache = cached.expect("delta has a cache");
        let changed: std::collections::HashSet<_> =
            batch.entries.iter().map(|entry| entry.map_id).collect();
        cache
            .entries
            .retain(|entry| !changed.contains(&entry.map_id));
        cache
            .entries
            .extend(batch.entries.into_iter().filter(|entry| !entry.hidden));
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
