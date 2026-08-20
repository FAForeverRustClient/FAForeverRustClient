//! Changelog orchestration: load the index once, load a note on demand.

use faf_domain::state::{ChangelogCommand, ChangelogEvent, ChangelogStatus};

use crate::runtime::{EventSink, ServiceCtx};

pub async fn handle(cmd: ChangelogCommand, ctx: &ServiceCtx, out: &EventSink) {
    match cmd {
        ChangelogCommand::Load => load(ctx, out).await,
        ChangelogCommand::Select { id } => select(id, ctx, out).await,
    }
}

async fn load(ctx: &ServiceCtx, out: &EventSink) {
    // The tab re-mounts on every visit, and the index does not change within a
    // session. Reloading it on each visit would be a request per tab switch.
    let already = out.with_state(|state| matches!(state.changelog.status, ChangelogStatus::Ready));
    if already {
        return;
    }

    out.emit(ChangelogEvent::Loading);
    match ctx.ports.changelog.list_releases().await {
        Ok(releases) => {
            // Open on the newest release, so the tab shows a patch note rather
            // than an empty panel next to a list.
            let newest = releases.first().map(|release| release.id.clone());
            out.emit(ChangelogEvent::Loaded { releases });
            if let Some(id) = newest {
                select(id, ctx, out).await;
            }
        }
        Err(reason) => out.emit(ChangelogEvent::LoadFailed { reason }),
    }
}

async fn select(id: String, ctx: &ServiceCtx, out: &EventSink) {
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
    match ctx.ports.changelog.load_entry(id, source_url).await {
        Ok(entry) => out.emit(ChangelogEvent::EntryLoaded { entry }),
        Err(reason) => out.emit(ChangelogEvent::EntryLoadFailed { reason }),
    }
}
