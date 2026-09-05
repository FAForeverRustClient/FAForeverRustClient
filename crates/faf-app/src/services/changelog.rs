//! Changelog orchestration: load the index once, load a note on demand.

use faf_domain::protocol::changelog::ChangelogRelease;
use faf_domain::state::{ChangelogCommand, ChangelogEvent, ChangelogStatus};

use crate::runtime::{EventSink, ServiceCtx};

pub async fn handle(cmd: ChangelogCommand, ctx: &ServiceCtx, out: &EventSink) {
    match cmd {
        ChangelogCommand::Load => load(ctx, out).await,
        ChangelogCommand::Select { id } => select(id, ctx, out).await,
    }
}

async fn load(ctx: &ServiceCtx, out: &EventSink) {
    // Held across the whole load, including the status read below: that read is
    // a check-then-act, and commands are dispatched concurrently, so without
    // this two visits in quick succession both see "not ready" and both fetch
    // the index. A dropped `Load` loses nothing, because the run already in
    // flight ends by selecting the newest patch itself.
    let Some(_guard) = ctx.changelog_active.try_acquire() else {
        return;
    };

    // The tab re-mounts on every visit, and the index does not change within a
    // session. Reloading it on each visit would be a request per tab switch,
    // but the selection should still reset to the newest dated patch.
    let already = out.with_state(|state| matches!(state.changelog.status, ChangelogStatus::Ready));
    if already {
        let newest = out.with_state(|state| newest_patch_id(&state.changelog.releases));
        if let Some(id) = newest {
            select(id, ctx, out).await;
        }
        return;
    }

    out.emit(ChangelogEvent::Loading);
    match ctx.ports.changelog.list_releases().await {
        Ok(releases) => {
            // Open on the newest dated patch, not one of the rolling branch
            // entries that are displayed above the release history.
            let newest = newest_patch_id(&releases);
            out.emit(ChangelogEvent::Loaded { releases });
            if let Some(id) = newest {
                select(id, ctx, out).await;
            }
        }
        Err(reason) => out.emit(ChangelogEvent::LoadFailed { reason }),
    }
}

fn newest_patch_id(releases: &[ChangelogRelease]) -> Option<String> {
    releases
        .iter()
        .filter(|release| !release.date.is_empty())
        .max_by(|left, right| left.date.cmp(&right.date))
        .map(|release| release.id.clone())
}

async fn select(id: String, ctx: &ServiceCtx, out: &EventSink) {
    // Claimed before the cache is read, not just around the fetch. A cached
    // release answers with no round trip at all, and it must still invalidate
    // an older note that is still in flight: otherwise the slow one lands last
    // and silently replaces the selection the user just made.
    let generation = ctx.changelog_entry_generation.begin();

    let (cached, source_url) = out.with_state(|state| {
        (
            state.changelog.entries.get(&id).cloned(),
            state
                .changelog
                .release(&id)
                .map(|release| release.source_url.clone()),
        )
    });

    // Already read this session: swap the selection without a round trip.
    if let Some(entry) = cached {
        out.emit(ChangelogEvent::EntryLoaded { entry });
        return;
    }

    let Some(source_url) = source_url else {
        out.emit(ChangelogEvent::EntryLoadFailed {
            reason: format!("release {id} is not in the index"),
        });
        return;
    };

    out.emit(ChangelogEvent::EntryLoading { id: id.clone() });
    let loaded = ctx.ports.changelog.load_entry(id, source_url).await;
    if !ctx.changelog_entry_generation.is_current(generation) {
        // A newer selection is already in flight or has already landed;
        // emitting now would move the reader back to the release they left.
        return;
    }
    match loaded {
        Ok(entry) => out.emit(ChangelogEvent::EntryLoaded { entry }),
        Err(reason) => out.emit(ChangelogEvent::EntryLoadFailed { reason }),
    }
}
