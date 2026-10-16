//! Disk-first lookup catalogue loading. Live vault searches use a separate path.
use crate::ports::catalogue::CachedCatalogue;
use crate::runtime::{EventSink, ServiceCtx};
use chrono::Utc;
use faf_domain::state::{ModListStatus, ModsEvent};

pub(super) async fn load(ctx: &ServiceCtx, out: &EventSink, force: bool) {
    crate::runtime::expect_admitted(crate::runtime::Key::ModVault);

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
    // Installed mods' explicit update check observes Loading -> Ready even
    // for a delta. Startup cache refreshes never show a loading activity.
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
        if !had_ready {
            out.emit(ModsEvent::VaultLoaded {
                mods: cache.entries.clone(),
            });
            if force {
                out.emit(ModsEvent::VaultLoading);
            }
        }
    }
    let full = cached
        .as_ref()
        .is_none_or(|cache| !force && cache.needs_full_refresh(Utc::now()));
    let visible = force || (cached.is_none() && !had_ready);
    if visible && !force {
        out.emit(ModsEvent::VaultLoading);
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
                .mods
                .catalogue_full(visible.then_some(progress_tx))
                .await
        } else {
            ctx.ports.mods.catalogue_delta(&since).await
        }
    };
    tokio::pin!(request);
    let result = loop {
        tokio::select! {
            biased;
            () = cancel.cancelled() => {
                if visible { out.emit(ModsEvent::VaultCancelled); }
                return;
            }
            result = &mut request => break result,
            Some(progress) = progress_rx.recv(), if visible => out.emit(ModsEvent::VaultProgress { progress }),
        }
    };
    let batch = match result {
        Ok(batch) => batch,
        Err(reason) => {
            tracing::warn!(%reason, full, seconds = started.elapsed().as_secs_f32(), "mod vault: catalogue refresh failed");
            if visible {
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
        out.emit(ModsEvent::VaultUpdated {
            mods: batch.entries.clone(),
            removed_ids: batch.removed_ids.clone(),
        });
        let mut cache = cached.expect("delta has a cache");
        let changed: std::collections::HashSet<_> =
            batch.entries.iter().map(|entry| entry.mod_id).collect();
        cache.entries.retain(|entry| {
            !changed.contains(&entry.mod_id) && !batch.removed_ids.contains(&entry.mod_id)
        });
        cache.entries.extend(
            batch
                .entries
                .into_iter()
                .filter(|entry| !batch.removed_ids.contains(&entry.mod_id)),
        );
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
