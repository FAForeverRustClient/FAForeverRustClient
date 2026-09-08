//! Changelog orchestration: refresh the index on every visit, load a note on
//! demand, and never serve a rolling branch note out of the cache.

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

    // The index is re-read on every visit rather than once per session. It was
    // held for the session on the grounds that it does not change, which is
    // true of an entry that is already in it and false of the list: a patch
    // published while the client was open never appeared, and the two rolling
    // branch entries move several times a week.
    //
    // The reader is not shown a spinner for it. `Loading` blanks the tab, and
    // there is nothing to blank it for when a perfectly good list is already
    // on screen.
    let showing = out.with_state(|state| matches!(state.changelog.status, ChangelogStatus::Ready));
    if !showing {
        out.emit(ChangelogEvent::Loading);
    }

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
        // A refresh that fails leaves what is on screen alone: the list the
        // reader is looking at is still the list, and replacing it with an
        // error page would make a tab switch on a flaky connection destroy a
        // working tab. The failure is only worth reporting when there is
        // nothing to report it in place of.
        Err(reason) => {
            if !showing {
                out.emit(ChangelogEvent::LoadFailed { reason });
            }
        }
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

    let (cached, release) = out.with_state(|state| {
        (
            state.changelog.entries.get(&id).cloned(),
            state.changelog.release(&id).cloned(),
        )
    });

    let Some(release) = release else {
        out.emit(ChangelogEvent::EntryLoadFailed {
            reason: format!("release {id} is not in the index"),
        });
        return;
    };

    // Already read this session: swap the selection without a round trip. Only
    // for a dated post, which is finished the day it is published, so a second
    // read could only return what is already here. A rolling branch page is
    // rewritten every time something is deployed to it, and serving that from
    // a cache pins the reader to whatever it said the first time they opened
    // the tab, which is how "there are new changes in fafbeta and they are not
    // shown" survives even once the note is fetched correctly.
    if let Some(entry) = cached.filter(|_| !release.is_rolling()) {
        out.emit(ChangelogEvent::EntryLoaded { entry });
        return;
    }

    out.emit(ChangelogEvent::EntryLoading { id: id.clone() });
    let loaded = ctx.ports.changelog.load_entry(release).await;
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
