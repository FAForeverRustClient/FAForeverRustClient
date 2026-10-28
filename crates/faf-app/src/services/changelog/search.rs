//! On-demand archive lookup with a reusable text index and bounded downloads.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use faf_domain::protocol::changelog::{ChangelogEntry, ChangelogRelease, ChangelogSearchDocument};
use faf_domain::state::changelog::ChangelogSearchState;
use faf_domain::state::{ChangelogEvent, ChangelogStatus};
use futures_util::{stream, StreamExt};
use tokio::time::Instant;

use crate::runtime::{EventSink, ServiceCtx};

const CACHE_BYTES: usize = 16 * 1024 * 1024;
/// The first search reads every note, about 170 small files from GitHub's
/// CDN, and is bound by round trips rather than bandwidth: four at a time took
/// 13 to 25 seconds, twelve about 6, and more only lengthened the slowest
/// replies.
const DOWNLOADS: usize = 12;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(200);
const ROLLING_SEARCH_TTL: Duration = Duration::from_secs(60);

pub(super) struct IndexedEntry {
    pub(super) entry: ChangelogEntry,
    document: ChangelogSearchDocument,
    bytes: usize,
    expires: Option<Instant>,
}

impl IndexedEntry {
    fn new(entry: ChangelogEntry, rolling: bool) -> Arc<Self> {
        // Count without creating a second serialized copy of the whole note.
        struct Size(usize);
        impl std::io::Write for Size {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.0 += bytes.len();
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let document = ChangelogSearchDocument::new(&entry);
        let mut size = Size(0);
        let bytes = if serde_json::to_writer(&mut size, &entry).is_ok() {
            size.0 + document.allocated_bytes()
        } else {
            CACHE_BYTES + 1
        };
        Arc::new(Self {
            entry,
            document,
            bytes,
            expires: rolling.then(|| Instant::now() + ROLLING_SEARCH_TTL),
        })
    }
}

#[derive(Default)]
pub(super) struct SearchCache {
    entries: BTreeMap<String, Arc<IndexedEntry>>,
    bytes: usize,
}

impl SearchCache {
    pub(super) fn get(&self, source: &str) -> Option<Arc<IndexedEntry>> {
        self.entries
            .get(source)
            .filter(|entry| entry.expires.is_none_or(|expires| expires > Instant::now()))
            .cloned()
    }

    fn insert(&mut self, source: String, indexed: Arc<IndexedEntry>) {
        if indexed.bytes > CACHE_BYTES || !super::complete_entry(&indexed.entry) {
            return;
        }
        if let Some(previous) = self.entries.remove(&source) {
            self.bytes -= previous.bytes;
        }
        while self.bytes + indexed.bytes > CACHE_BYTES || self.entries.len() >= 512 {
            let Some((_, removed)) = self.entries.pop_first() else {
                break;
            };
            self.bytes -= removed.bytes;
        }
        self.bytes += indexed.bytes;
        self.entries.insert(source, indexed);
    }
}

fn remember(
    ctx: &ServiceCtx,
    release: &ChangelogRelease,
    entry: ChangelogEntry,
) -> Arc<IndexedEntry> {
    // Parsing and index construction happen outside the cache lock.
    keep(ctx, release, IndexedEntry::new(entry, release.is_rolling()))
}

/// [`remember`] for a note just downloaded, with the index built off the
/// async runtime like the parse before it: sizing the note serializes it
/// whole, and the search's downloads all run inside its one task.
async fn remember_downloaded(
    ctx: &ServiceCtx,
    release: &ChangelogRelease,
    entry: ChangelogEntry,
) -> Result<Arc<IndexedEntry>, String> {
    let rolling = release.is_rolling();
    let indexed = tokio::task::spawn_blocking(move || IndexedEntry::new(entry, rolling))
        .await
        .map_err(|_| format!("release {} could not be indexed", release.id))?;
    Ok(keep(ctx, release, indexed))
}

fn keep(
    ctx: &ServiceCtx,
    release: &ChangelogRelease,
    indexed: Arc<IndexedEntry>,
) -> Arc<IndexedEntry> {
    ctx.changelog
        .search_cache
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .insert(release.source_url.clone(), indexed.clone());
    indexed
}

pub(super) async fn run(query: String, ctx: &ServiceCtx, out: &EventSink) {
    let request_id = ctx.changelog.search_generation.begin() as u32;
    let cancel = ctx.changelog.search_cancel.begin();
    let query = query.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut search = ChangelogSearchState {
        request_id,
        query,
        ..Default::default()
    };
    if search.query.is_empty() {
        out.emit(ChangelogEvent::SearchUpdated { search });
        return;
    }
    if search.query.chars().count() > 128 {
        search.status = ChangelogStatus::Failed {
            reason: "the search text is too long".into(),
        };
        out.emit(ChangelogEvent::SearchUpdated { search });
        return;
    }
    let folded_query = search.query.to_lowercase();
    search.status = ChangelogStatus::Loading;
    out.emit(ChangelogEvent::SearchUpdated {
        search: search.clone(),
    });
    let mut releases = out.with_state(|state| state.changelog.releases.clone());
    if releases.is_empty() {
        let loaded = tokio::select! {
            biased;
            () = cancel.cancelled() => return,
            loaded = ctx.ports.changelog.list_releases() => loaded,
        };
        match loaded {
            Ok(loaded) => {
                releases = loaded;
                out.emit(ChangelogEvent::Loaded {
                    releases: releases.clone(),
                });
            }
            Err(reason) => {
                search.status = ChangelogStatus::Failed { reason };
                if !cancel.is_cancelled() {
                    out.emit(ChangelogEvent::SearchUpdated { search });
                }
                return;
            }
        }
    }
    search.total = releases.len().min(u32::MAX as usize) as u32;
    let mut matches = BTreeMap::new();
    let mut successful = 0_u32;
    let mut missing = Vec::new();
    // Show cached matches first. Slow rolling downloads must not hold them up.
    for (position, release) in releases.into_iter().enumerate() {
        if cancel.is_cancelled() {
            return;
        }
        let cached = ctx
            .changelog
            .search_cache
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&release.source_url);
        let cached = cached.or_else(|| {
            if release.is_rolling() {
                return None;
            }
            let entry = out.with_state(|state| {
                state
                    .changelog
                    .entries
                    .get(&release.id)
                    .filter(|entry| super::complete_entry(entry))
                    .cloned()
            });
            entry.map(|entry| remember(ctx, &release, entry))
        });
        if let Some(indexed) = cached {
            search.scanned += 1;
            successful += 1;
            if let Some(found) = indexed.document.search(&folded_query) {
                matches.insert(position, found);
            }
        } else {
            missing.push((position, release));
        }
    }
    if !missing.is_empty() {
        search.matches = matches.values().cloned().collect();
        out.emit(ChangelogEvent::SearchUpdated {
            search: search.clone(),
        });
    }
    let jobs = missing.into_iter().map(|(position, release)| async move {
        let loaded = match ctx.ports.changelog.load_entry(release.clone()).await {
            Ok(entry) => remember_downloaded(ctx, &release, entry).await,
            Err(reason) => Err(reason),
        };
        (position, loaded)
    });
    let mut pending = stream::iter(jobs).buffer_unordered(DOWNLOADS);
    let mut last_progress = Instant::now();
    let mut since_progress = 0;
    loop {
        let next = tokio::select! {
            biased;
            () = cancel.cancelled() => return,
            next = pending.next() => next,
        };
        let Some((position, loaded)) = next else {
            break;
        };
        search.scanned += 1;
        since_progress += 1;
        match loaded {
            Ok(indexed) => {
                successful += 1;
                if !super::complete_entry(&indexed.entry) {
                    search.failed += 1;
                }
                if let Some(found) = indexed.document.search(&folded_query) {
                    matches.insert(position, found);
                }
            }
            Err(_) => search.failed += 1,
        }
        if since_progress >= 8
            && last_progress.elapsed() >= PROGRESS_INTERVAL
            && search.scanned < search.total
        {
            search.matches = matches.values().cloned().collect();
            if !cancel.is_cancelled() {
                out.emit(ChangelogEvent::SearchUpdated {
                    search: search.clone(),
                });
            }
            last_progress = Instant::now();
            since_progress = 0;
        }
    }
    search.matches = matches.into_values().collect();
    search.status = if successful > 0 || search.total == 0 {
        ChangelogStatus::Ready
    } else {
        ChangelogStatus::Failed {
            reason: "none of the patch notes could be read".into(),
        }
    };
    if !cancel.is_cancelled() {
        out.emit(ChangelogEvent::SearchUpdated { search });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn rolling_search_index_expires_but_dated_notes_remain_cached() {
        let mut cache = SearchCache::default();
        let entry = ChangelogEntry {
            id: "test".into(),
            title: String::new(),
            blocks: Vec::new(),
        };
        cache.insert("rolling".into(), IndexedEntry::new(entry.clone(), true));
        cache.insert("dated".into(), IndexedEntry::new(entry, false));
        assert!(cache.get("rolling").is_some());
        tokio::time::advance(ROLLING_SEARCH_TTL + Duration::from_secs(1)).await;
        assert!(cache.get("rolling").is_none());
        assert!(cache.get("dated").is_some());
    }
}
