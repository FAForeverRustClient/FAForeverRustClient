//! Changelog service concurrency.
//!
//! Commands are dispatched onto their own tasks, so two visits to the tab and
//! two clicks in the release list are concurrent by default. Both of the
//! guards this pins were missing: the index was fetched twice on a quick
//! revisit, and a slow note landing after a newer one silently moved the
//! reader back to the release they had just left.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use faf_app::infra::fake_ports;
use faf_app::ports::ChangelogPort;
use faf_app::{App, Ports};
use faf_domain::protocol::changelog::{ChangelogEntry, ChangelogRelease};
use faf_domain::state::{ChangelogCommand, ChangelogEntryStatus, ChangelogStatus};

/// A changelog source with a scripted delay per note, so a response can be
/// made to overtake one requested before it.
struct ScriptedChangelog {
    releases: Vec<ChangelogRelease>,
    /// How long each note takes to answer, by release id. Absent means instant.
    delays: HashMap<String, Duration>,
    index_delay: Duration,
    index_calls: Arc<AtomicU32>,
    /// How many times each note has been fetched, by release id.
    entry_calls: Arc<Mutex<HashMap<String, u32>>>,
}

#[async_trait]
impl ChangelogPort for ScriptedChangelog {
    async fn list_releases(&self) -> Result<Vec<ChangelogRelease>, String> {
        self.index_calls.fetch_add(1, Ordering::AcqRel);
        tokio::time::sleep(self.index_delay).await;
        Ok(self.releases.clone())
    }

    async fn load_entry(&self, release: ChangelogRelease) -> Result<ChangelogEntry, String> {
        let id = release.id;
        if let Some(delay) = self.delays.get(&id) {
            tokio::time::sleep(*delay).await;
        }
        let reads = *self
            .entry_calls
            .lock()
            .expect("the call counter is never poisoned")
            .entry(id.clone())
            .and_modify(|count| *count += 1)
            .or_insert(1);
        Ok(ChangelogEntry {
            // Numbered so a second read of the same release is distinguishable
            // from the first one being handed back out of the cache.
            title: format!("{id} - read {reads}"),
            id,
            blocks: Vec::new(),
        })
    }
}

fn release(id: &str, date: &str) -> ChangelogRelease {
    ChangelogRelease {
        id: id.into(),
        kind: "Game Patch".into(),
        date: date.into(),
        year: date.get(0..4).unwrap_or_default().into(),
        source_url: format!("https://example.invalid/{id}.md"),
        web_url: format!("https://example.invalid/{id}"),
    }
}

/// One of the two branch entries. Carries no date, which is what makes it
/// rolling: the page behind it is rewritten on every deploy to that branch.
fn rolling(id: &str) -> ChangelogRelease {
    ChangelogRelease {
        date: String::new(),
        year: String::new(),
        kind: "FAF Beta Balance".into(),
        ..release(id, "")
    }
}

struct Harness {
    app: App,
    index_calls: Arc<AtomicU32>,
    entry_calls: Arc<Mutex<HashMap<String, u32>>>,
}

/// Three dated releases, newest last, and the rolling beta entry above them.
/// `3800` is the slow one throughout: it is always the request that must lose.
fn harness(index_delay: Duration) -> Harness {
    let index_calls = Arc::new(AtomicU32::new(0));
    let entry_calls = Arc::new(Mutex::new(HashMap::new()));
    let ports = Ports {
        changelog: Arc::new(ScriptedChangelog {
            releases: vec![
                rolling("fafbeta"),
                release("3800", "2024-01-01"),
                release("3801", "2024-02-01"),
                release("3802", "2024-03-01"),
            ],
            delays: HashMap::from([("3800".to_string(), Duration::from_millis(300))]),
            index_delay,
            index_calls: index_calls.clone(),
            entry_calls: entry_calls.clone(),
        }),
        ..fake_ports()
    };
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());
    Harness {
        app,
        index_calls,
        entry_calls,
    }
}

impl Harness {
    /// Dispatch `Load` and wait until the index and its auto-selected note have
    /// both settled.
    async fn load(&self) {
        self.app
            .dispatch(ChangelogCommand::Load.into())
            .await
            .unwrap();
        self.until("the index never became ready", |app| {
            let changelog = app.snapshot().changelog;
            changelog.status == ChangelogStatus::Ready
                && changelog.entry_status == ChangelogEntryStatus::Ready
        })
        .await;
    }

    async fn select(&self, id: &str) {
        self.app
            .dispatch(ChangelogCommand::Select { id: id.into() }.into())
            .await
            .unwrap();
    }

    /// Dispatch a selection and wait until the service has actually started it,
    /// so a later selection is ordered after this one rather than racing it.
    async fn select_and_await_start(&self, id: &str) {
        self.select(id).await;
        let expected = ChangelogEntryStatus::Loading { id: id.into() };
        self.until("the selection never started loading", move |app| {
            app.snapshot().changelog.entry_status == expected
        })
        .await;
    }

    async fn until(&self, complaint: &str, ready: impl Fn(&App) -> bool) {
        for _ in 0..400 {
            if ready(&self.app) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("{complaint}: {:?}", self.app.snapshot().changelog);
    }

    fn selected(&self) -> String {
        self.app.snapshot().changelog.selected
    }

    fn title(&self) -> String {
        self.app
            .snapshot()
            .changelog
            .selected_entry()
            .map(|entry| entry.title.clone())
            .unwrap_or_default()
    }

    fn reads_of(&self, id: &str) -> u32 {
        self.entry_calls
            .lock()
            .expect("the call counter is never poisoned")
            .get(id)
            .copied()
            .unwrap_or(0)
    }
}

/// Long enough for the slow note (300 ms) to have answered if it were going to.
async fn settle() {
    tokio::time::sleep(Duration::from_millis(500)).await;
}

#[tokio::test]
async fn a_revisit_while_the_index_is_in_flight_does_not_fetch_it_twice() {
    let harness = harness(Duration::from_millis(200));

    // Two visits in quick succession. Both observe a status that is not yet
    // `Ready`, because the first has not answered: the check the service makes
    // is a check-then-act, and only the single-flight guard closes it.
    harness
        .app
        .dispatch(ChangelogCommand::Load.into())
        .await
        .unwrap();
    harness
        .app
        .dispatch(ChangelogCommand::Load.into())
        .await
        .unwrap();

    harness
        .until("the index never became ready", |app| {
            app.snapshot().changelog.status == ChangelogStatus::Ready
        })
        .await;
    settle().await;

    assert_eq!(
        harness.index_calls.load(Ordering::Acquire),
        1,
        "the redundant visit fetched the index again"
    );
}

#[tokio::test]
async fn every_visit_reads_the_index_again() {
    let harness = harness(Duration::ZERO);
    harness.load().await;

    // A release published while the client is open can only appear if the list
    // is read again, which is the half of "the tab does not auto update" that
    // is about the list rather than about one note.
    harness
        .app
        .dispatch(ChangelogCommand::Load.into())
        .await
        .unwrap();
    settle().await;

    assert_eq!(harness.index_calls.load(Ordering::Acquire), 2);
    assert_eq!(
        harness.selected(),
        "3802",
        "and it still opens on the newest"
    );
}

#[tokio::test]
async fn a_dated_note_is_read_once_and_a_rolling_one_every_time() {
    let harness = harness(Duration::ZERO);
    harness.load().await;

    // A dated patch is finished the day it is published, so coming back to it
    // is served from the cache and the title stays on the first read.
    harness.select("3801").await;
    harness
        .until("the dated note never landed", |app| {
            app.snapshot().changelog.selected == "3801"
        })
        .await;
    harness.select("3802").await;
    harness.select("3801").await;
    settle().await;
    assert_eq!(harness.reads_of("3801"), 1, "a finished post was refetched");
    assert_eq!(harness.title(), "3801 - read 1");

    // A rolling branch is rewritten on every deploy, so a cached copy is a
    // stale copy: this is the reported bug, and it outlives fetching the note
    // from the right place in the first instance.
    harness.select("fafbeta").await;
    harness
        .until("the branch note never landed", |app| {
            app.snapshot().changelog.selected == "fafbeta"
        })
        .await;
    harness.select("3802").await;
    harness.select("fafbeta").await;
    settle().await;

    assert_eq!(harness.reads_of("fafbeta"), 2, "the branch note was cached");
    assert_eq!(harness.title(), "fafbeta - read 2");
}

#[tokio::test]
async fn a_slow_note_never_replaces_the_newer_one_that_overtook_it() {
    let harness = harness(Duration::ZERO);
    harness.load().await;
    assert_eq!(harness.selected(), "3802", "the newest dated patch opens");

    // 3800 takes 300 ms; 3801 answers immediately and is asked for second.
    harness.select_and_await_start("3800").await;
    harness.select("3801").await;

    harness
        .until("the newer note never landed", |app| {
            app.snapshot().changelog.selected == "3801"
        })
        .await;
    settle().await;

    assert_eq!(
        harness.selected(),
        "3801",
        "the slower earlier note moved the reader back"
    );
}

#[tokio::test]
async fn a_slow_note_never_replaces_a_cached_selection() {
    let harness = harness(Duration::ZERO);
    harness.load().await;

    // 3802 was cached by the auto-selection, so it answers with no round trip
    // at all. The generation still has to be claimed before the cache is read,
    // or the note already in flight lands afterwards and wins.
    harness.select_and_await_start("3800").await;
    harness.select("3802").await;

    harness
        .until("the cached note was never re-selected", |app| {
            app.snapshot().changelog.selected == "3802"
        })
        .await;
    settle().await;

    assert_eq!(
        harness.selected(),
        "3802",
        "the slower earlier note replaced the cached selection"
    );
    assert_eq!(
        harness.app.snapshot().changelog.entry_status,
        ChangelogEntryStatus::Ready
    );
}
