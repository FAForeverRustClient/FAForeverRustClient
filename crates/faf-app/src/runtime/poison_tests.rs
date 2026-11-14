use std::sync::atomic::{AtomicUsize, Ordering};

use faf_domain::state::{LobbyCommand, NavEvent, ReplayCommand, SessionEvent, Tab};

use super::*;

/// Every test here makes the runtime log a recovery. Tracing can drop an event
/// that one thread logs while another thread is still registering the same log
/// line on its first use, and the once-per-incident test counts those events,
/// so with the default parallel test threads it failed now and then. Taking
/// turns means a log line is registered before any other test reaches it.
static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());

fn take_turn() -> MutexGuard<'static, ()> {
    ONE_AT_A_TIME
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn poison(operation: impl FnOnce() + Send + 'static) {
    assert!(std::thread::spawn(operation).join().is_err());
}

fn poison_reduction(sink: EventSink) {
    poison(move || {
        let _delivery = sink.send_order.lock().unwrap();
        let mut state = sink.state.write().unwrap();
        // The reducers mutate in place. Reproduce a panic after mutation but
        // before emit's revision bump, without introducing a panicking reducer.
        state.session.backend_version = "interrupted".into();
        panic!("simulated reducer panic");
    });
}

#[test]
fn poisoned_reduce_skips_a_revision_and_preserves_the_partial_state() {
    let _turn = take_turn();
    let (app, app_loop) = App::new("test", crate::infra::fake_ports());
    let sink = &app_loop.sink;
    let (mut events, initial) = app.subscribe_versioned_with_snapshot();
    let mut plain = sink.subscribe();
    poison_reduction(sink.clone());
    assert!(sink.state.is_poisoned());
    assert!(sink.send_order.is_poisoned());

    sink.emit(NavEvent::TabSelected { tab: Tab::Play });

    let delivered = events.try_recv().unwrap();
    // revisionedMirror requests a snapshot rather than applying this delta
    // across the missing revision to its unmodified initial state.
    assert_eq!(delivered.revision, initial.revision + 2);
    assert_eq!(plain.try_recv().unwrap(), delivered.event);
    assert!(events.try_recv().is_err());
    assert!(plain.try_recv().is_err());
    let snapshot = app.versioned_snapshot();
    assert_eq!(snapshot.revision, delivered.revision);
    assert_eq!(snapshot.state.session.backend_version, "interrupted");
    assert_eq!(snapshot.state.nav.active_tab, Tab::Play);
    assert!(!sink.state.is_poisoned());
    assert!(!sink.send_order.is_poisoned());
}

#[test]
fn poisoned_state_is_recovered_by_every_snapshot_and_projection_entrypoint() {
    let _turn = take_turn();
    type ReadState = fn(&App, &EventSink) -> AppState;
    let readers: [(&str, ReadState); 7] = [
        ("app snapshot", |app, _| app.snapshot()),
        ("versioned snapshot", |app, _| {
            app.versioned_snapshot().state
        }),
        ("app projection", |app, _| app.with_state(Clone::clone)),
        ("plain subscription", |app, _| {
            app.subscribe_with_snapshot().1
        }),
        ("versioned subscription", |app, _| {
            app.subscribe_versioned_with_snapshot().1.state
        }),
        ("sink snapshot", |_, sink| sink.snapshot()),
        ("sink projection", |_, sink| sink.with_state(Clone::clone)),
    ];
    for (name, read) in readers {
        let (app, app_loop) = App::new("test", crate::infra::fake_ports());
        let sink = &app_loop.sink;
        let mut events = app.subscribe_versioned_with_snapshot().0;
        let state = sink.state.clone();
        poison(move || {
            let mut state = state.write().unwrap();
            state.session.backend_version = "interrupted".into();
            panic!("simulated interrupted state mutation");
        });

        assert_eq!(
            read(&app, sink).session.backend_version,
            "interrupted",
            "{name}"
        );
        assert!(!sink.state.is_poisoned(), "{name}");
        assert_eq!(app.versioned_snapshot().revision, 1, "{name}");
        read(&app, sink);
        assert_eq!(
            app.versioned_snapshot().revision,
            1,
            "no repeated gap: {name}"
        );

        // A newly hydrated mirror has revision 1 and can apply revision 2;
        // the pre-panic subscriber still sees the gap and must resnapshot.
        let (mut new_events, snapshot) = app.subscribe_versioned_with_snapshot();
        assert_eq!(snapshot.revision, 1);
        assert_eq!(snapshot.state.session.backend_version, "interrupted");
        sink.emit(NavEvent::TabSelected { tab: Tab::Play });
        assert_eq!(events.try_recv().unwrap().revision, 2, "{name}");
        assert_eq!(new_events.try_recv().unwrap().revision, 2, "{name}");
    }
}

#[test]
fn poisoned_state_has_one_recovery_revision_with_competing_readers() {
    let _turn = take_turn();
    let (app, app_loop) = App::new("test", crate::infra::fake_ports());
    let app = Arc::new(app);
    poison_reduction(app_loop.sink.clone());
    let barrier = Arc::new(std::sync::Barrier::new(8));
    let readers: Vec<_> = (0..8)
        .map(|_| {
            let app = app.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                let (_, snapshot) = app.subscribe_versioned_with_snapshot();
                assert_eq!(snapshot.revision, 1);
                assert_eq!(snapshot.state.session.backend_version, "interrupted");
            })
        })
        .collect();
    for reader in readers {
        reader.join().unwrap();
    }
    app_loop.sink.emit(NavEvent::TabSelected { tab: Tab::Play });
    assert_eq!(app.versioned_snapshot().revision, 2);
}

#[test]
fn poisoned_delivery_and_state_keep_concurrent_events_in_revision_order() {
    let _turn = take_turn();
    let (app, app_loop) = App::new("test", crate::infra::fake_ports());
    let sink = &app_loop.sink;
    let mut events = app.subscribe_versioned_with_snapshot().0;
    let mut plain = sink.subscribe();
    poison_reduction(sink.clone());
    let barrier = Arc::new(std::sync::Barrier::new(16));
    let emitters: Vec<_> = (0..16)
        .map(|index| {
            let sink = sink.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                sink.emit(SessionEvent::BackendReady {
                    version: format!("worker-{index}"),
                    offline_auth: false,
                });
            })
        })
        .collect();
    for emitter in emitters {
        emitter.join().unwrap();
    }
    let mut last_version = String::new();
    for expected in 2..=17 {
        let delivered = events.try_recv().unwrap();
        assert_eq!(delivered.revision, expected);
        assert_eq!(plain.try_recv().unwrap(), delivered.event);
        let AppEvent::Session(SessionEvent::BackendReady { version, .. }) = delivered.event else {
            panic!("unexpected event");
        };
        last_version = version;
    }
    let snapshot = app.versioned_snapshot();
    assert_eq!(snapshot.revision, 17);
    assert_eq!(snapshot.state.session.backend_version, last_version);
    assert!(events.try_recv().is_err());
    assert!(plain.try_recv().is_err());
}

#[test]
fn poisoned_delivery_recovers_before_and_after_the_normal_revision_bump() {
    let _turn = take_turn();
    for before_broadcast in [false, true] {
        let (app, app_loop) = App::new("test", crate::infra::fake_ports());
        let sink = &app_loop.sink;
        let mut events = app.subscribe_versioned_with_snapshot().0;
        let interrupted = sink.clone();
        poison(move || {
            let _delivery = interrupted.send_order.lock().unwrap();
            if before_broadcast {
                // The state lock has already been released when broadcasting.
                let mut guard = interrupted.state.write().unwrap();
                guard.session.backend_version = "interrupted".into();
                interrupted.revision.fetch_add(1, Ordering::Relaxed);
                drop(guard);
            }
            panic!("simulated delivery panic");
        });
        assert!(!sink.state.is_poisoned());
        sink.emit(NavEvent::TabSelected { tab: Tab::Play });
        assert!(!sink.send_order.is_poisoned());
        let revision = if before_broadcast { 2 } else { 1 };
        assert_eq!(events.try_recv().unwrap().revision, revision);
        assert_eq!(app.versioned_snapshot().revision, revision);
    }
}

#[test]
fn poisoned_release_order_locks_preserve_cancellation_and_read_ownership() {
    let _turn = take_turn();
    let order = Arc::new(ReleaseOrder::default());
    let join: AppCommand = LobbyCommand::Join {
        id: 7,
        password: None,
        replace_mods: false,
    }
    .into();
    let seq = order.stamp(&join);
    let poisoned = order.clone();
    poison(move || {
        let _guard = poisoned.released.lock().unwrap();
        panic!("simulated release bookkeeping panic");
    });
    assert!(!order.superseded(&join, seq));
    order.stamp(&LobbyCommand::CancelJoin.into());
    assert!(order.superseded(&join, seq));
    assert!(!order.released.is_poisoned());

    for analysis in [true, false] {
        let load = |owner| {
            AppCommand::Replays(if analysis {
                ReplayCommand::LoadAnalysis {
                    uid: 7,
                    local_path: None,
                    request_id: Some(owner),
                }
            } else {
                ReplayCommand::LoadDetails {
                    uid: 7,
                    local_path: None,
                    request_id: Some(owner),
                }
            })
        };
        let first = load(1);
        let seq = order.stamp(&first);
        let poisoned = order.clone();
        poison(move || {
            poisoned.reads.poison_for_test();
        });
        // Both the admission read and a later cancellation still operate on
        // the retained owner, rather than erasing unrelated pending work.
        assert!(!order.superseded(&first, seq));
        order.stamp(
            &ReplayCommand::CancelReads {
                uid: 7,
                local_path: None,
                request_id: Some(1),
            }
            .into(),
        );
        assert!(order.superseded(&first, seq));
        let second = load(2);
        let seq = order.stamp(&second);
        assert!(!order.superseded(&second, seq));
        assert!(!order.reads.is_poisoned_for_test());
    }
}

#[test]
fn poisoned_running_registry_still_tracks_and_finishes_commands() {
    let _turn = take_turn();
    let running = Running::default();
    let first = running.start("Maps::LoadVault".into());
    let poisoned = running.clone();
    poison(move || {
        let _guard = poisoned.0.lock().unwrap();
        panic!("simulated running registry panic");
    });
    assert_eq!(running.longest(1).0, 1);
    assert!(!running.0.is_poisoned());
    let second = running.start("Mods::LoadVault".into());
    assert!(second > first);
    assert_eq!(running.longest(2).0, 2);
    running.finish(first);
    running.finish(second);
    assert_eq!(running.longest(1), (0, vec![]));
}

#[test]
fn poisoned_dispatch_sequence_retains_monotonic_read_cancellation() {
    let _turn = take_turn();
    let order = Arc::new(ReleaseOrder::default());
    let command = ReplayCommand::LoadAnalysis {
        uid: 7,
        local_path: None,
        request_id: Some(1),
    }
    .into();
    let first = order.stamp(&command);
    let poisoned = order.clone();
    poison(move || {
        let _guard = poisoned.next.lock().unwrap();
        panic!("simulated dispatch bookkeeping panic");
    });
    let cancelled = order.stamp(
        &ReplayCommand::CancelReads {
            uid: 7,
            local_path: None,
            request_id: Some(1),
        }
        .into(),
    );
    assert!(cancelled > first);
    assert!(order.superseded(&command, first));
    let replacement = order.stamp(&command);
    assert!(replacement > cancelled);
    assert!(!order.superseded(&command, replacement));
    assert!(!order.next.is_poisoned());
}

struct ErrorCount(Arc<AtomicUsize>);

impl tracing::Subscriber for ErrorCount {
    fn enabled(&self, _: &tracing::Metadata<'_>) -> bool {
        true
    }
    fn new_span(&self, _: &tracing::span::Attributes<'_>) -> tracing::span::Id {
        tracing::span::Id::from_u64(1)
    }
    fn record(&self, _: &tracing::span::Id, _: &tracing::span::Record<'_>) {}
    fn record_follows_from(&self, _: &tracing::span::Id, _: &tracing::span::Id) {}
    fn event(&self, event: &tracing::Event<'_>) {
        assert_eq!(*event.metadata().level(), tracing::Level::ERROR);
        self.0.fetch_add(1, Ordering::Relaxed);
    }
    fn enter(&self, _: &tracing::span::Id) {}
    fn exit(&self, _: &tracing::span::Id) {}
}

#[test]
fn poisoned_locks_log_once_per_incident_without_repeated_revision_gaps() {
    let _turn = take_turn();
    let errors = Arc::new(AtomicUsize::new(0));
    let lock = Arc::new(Mutex::new(()));
    tracing::subscriber::with_default(ErrorCount(errors.clone()), || {
        for expected in 1..=2 {
            let poisoned = lock.clone();
            poison(move || {
                let _guard = poisoned.lock().unwrap();
                panic!("simulated mutex panic");
            });
            drop(lock_runtime(&lock, "test lock"));
            drop(lock_runtime(&lock, "test lock"));
            assert_eq!(errors.load(Ordering::Relaxed), expected);
        }
        let state = Arc::new(RwLock::new(AppState::default()));
        let revision = AtomicU64::new(0);
        for expected in 1..=2 {
            let poisoned = state.clone();
            poison(move || {
                let _guard = poisoned.write().unwrap();
                panic!("simulated state panic");
            });
            drop(read_state(&state, &revision));
            drop(read_state(&state, &revision));
            drop(write_state(&state, &revision));
            assert_eq!(revision.load(Ordering::Relaxed), expected);
            assert_eq!(errors.load(Ordering::Relaxed), expected as usize + 2);
        }
    });
}
