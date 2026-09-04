//! Runtime choice between the two connectivity backends.
//!
//! FAF has two ICE adapters: the long-standing Java `faf-ice-adapter`, which is
//! the production default, and the experimental Go faf-pioneer backend.
//!
//! Until now it was reachable only through `FAF_ICE_ADAPTER_KIND`, which meant
//! that in practice nobody knew the second adapter existed. This holds *both*
//! and dispatches per launch, so the Settings toggle takes effect on the next
//! game instead of requiring a restart.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use faf_domain::state::IceAdapter;

use crate::infra::env_or;
use crate::ports::{ConnectivitySession, IceDebugWindows, IceParams, IcePort};

/// Development override. When set, it wins over the stored preference: a
/// developer testing one backend should not have it silently swapped when
/// settings load.
const OVERRIDE_ENV: &str = "FAF_ICE_ADAPTER_KIND";

/// Read the override, if one is set. `None` means "use the preference".
pub(crate) fn adapter_override() -> Option<IceAdapter> {
    let raw = env_or(OVERRIDE_ENV, "");
    (!raw.is_empty()).then(|| parse_adapter(&raw))
}

/// Map the override's spelling onto a backend.
///
/// Anything unrecognised uses the production Java adapter. An explicit Go
/// spelling is required to select the experimental backend.
pub(crate) fn parse_adapter(raw: &str) -> IceAdapter {
    match raw.trim().to_ascii_lowercase().as_str() {
        "go" | "pioneer" | "faf-pioneer" => IceAdapter::Go,
        _ => IceAdapter::Java,
    }
}

pub struct SelectableIce {
    java: Arc<dyn IcePort>,
    go: Arc<dyn IcePort>,
    /// The user's choice. Ignored while [`adapter_override`] returns a value.
    preferred: Mutex<IceAdapter>,
    /// Which backend was last started, so [`IcePort::stop`] reaches the one
    /// that is actually running even if the preference changed meanwhile.
    running: Mutex<Option<IceAdapter>>,
}

impl SelectableIce {
    pub fn new(java: Arc<dyn IcePort>, go: Arc<dyn IcePort>) -> Self {
        Self {
            java,
            go,
            preferred: Mutex::new(IceAdapter::default()),
            running: Mutex::new(None),
        }
    }

    /// The backend the next launch will use.
    fn selected(&self) -> IceAdapter {
        adapter_override().unwrap_or_else(|| *self.preferred.lock().unwrap())
    }

    fn backend(&self, adapter: IceAdapter) -> &Arc<dyn IcePort> {
        match adapter {
            IceAdapter::Java => &self.java,
            IceAdapter::Go => &self.go,
        }
    }
}

#[async_trait]
impl IcePort for SelectableIce {
    async fn start(&self, params: IceParams) -> Result<ConnectivitySession, String> {
        let adapter = self.selected();
        tracing::info!(backend = adapter.label(), "starting selected ICE backend");
        let session = self.backend(adapter).start(params).await.map_err(|error| {
            format!(
                "{} could not start: {error}. Pioneer is experimental and is never selected as an automatic fallback",
                adapter.label()
            )
        })?;
        // Only recorded on success: a failed start leaves nothing to stop, and
        // claiming otherwise would send a later `stop` to the wrong backend.
        *self.running.lock().unwrap() = Some(adapter);
        Ok(session)
    }

    fn stop(&self) {
        // Stop whichever one is up, not whichever one is currently preferred,
        // the user may have switched between starting a game and leaving it.
        match self.running.lock().unwrap().take() {
            Some(adapter) => self.backend(adapter).stop(),
            // Nothing recorded: a start that failed part-way may still have
            // left a process behind, so stop both rather than guess.
            None => {
                self.java.stop();
                self.go.stop();
            }
        }
    }

    fn set_backend(&self, adapter: IceAdapter) {
        *self.preferred.lock().unwrap() = adapter;
    }

    /// Pushed to both backends rather than only the selected one: the
    /// preference can change between this call and the next launch.
    fn set_debug_windows(&self, windows: IceDebugWindows) {
        self.java.set_debug_windows(windows);
        self.go.set_debug_windows(windows);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ports::RelayMsg;
    use std::sync::atomic::{AtomicU32, Ordering};
    use tokio::sync::mpsc;

    #[derive(Default)]
    struct Counting {
        started: AtomicU32,
        stopped: AtomicU32,
        fail: bool,
    }

    #[async_trait]
    impl IcePort for Counting {
        async fn start(&self, _params: IceParams) -> Result<ConnectivitySession, String> {
            self.started.fetch_add(1, Ordering::SeqCst);
            if self.fail {
                return Err("no adapter".into());
            }
            let (_to_lobby_tx, to_lobby) = mpsc::channel::<RelayMsg>(1);
            let (from_lobby, _from_lobby_rx) = mpsc::channel::<RelayMsg>(1);
            Ok(ConnectivitySession {
                game_port: 1,
                to_lobby,
                from_lobby,
            })
        }
        fn stop(&self) {
            self.stopped.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn params() -> IceParams {
        IceParams {
            player_id: 7,
            player_login: "Ada".into(),
            game_id: 1,
            init_mode: 0,
        }
    }

    fn pair() -> (Arc<Counting>, Arc<Counting>, SelectableIce) {
        let java = Arc::new(Counting::default());
        let go = Arc::new(Counting::default());
        let ice = SelectableIce::new(java.clone(), go.clone());
        (java, go, ice)
    }

    #[tokio::test]
    async fn java_is_the_default_backend() {
        let (java, go, ice) = pair();
        ice.start(params()).await.unwrap();
        assert_eq!(java.started.load(Ordering::SeqCst), 1);
        assert_eq!(go.started.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn choosing_java_takes_effect_on_the_next_launch() {
        // The point of holding both: no restart.
        let (java, go, ice) = pair();
        ice.set_backend(IceAdapter::Java);
        ice.start(params()).await.unwrap();
        assert_eq!(java.started.load(Ordering::SeqCst), 1);
        assert_eq!(go.started.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn stop_reaches_the_backend_that_is_actually_running() {
        // Switching the preference mid-game must not leave the started
        // adapter alive while stopping an idle one.
        let (java, go, ice) = pair();
        ice.start(params()).await.unwrap();
        ice.set_backend(IceAdapter::Go);
        ice.stop();

        assert_eq!(java.stopped.load(Ordering::SeqCst), 1, "the running one");
        assert_eq!(go.stopped.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn stopping_without_a_started_backend_stops_both() {
        // A start that failed part-way may still have left a process behind.
        let (java, go, ice) = pair();
        ice.stop();
        assert_eq!(java.stopped.load(Ordering::SeqCst), 1);
        assert_eq!(go.stopped.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_failed_default_start_does_not_fall_back_to_experimental_pioneer() {
        let java = Arc::new(Counting {
            fail: true,
            ..Counting::default()
        });
        let go = Arc::new(Counting::default());
        let ice = SelectableIce::new(java.clone(), go.clone());

        let error = match ice.start(params()).await {
            Ok(_) => panic!("experimental fallback unexpectedly started"),
            Err(error) => error,
        };
        ice.stop();
        assert_eq!(java.started.load(Ordering::SeqCst), 1);
        assert_eq!(go.started.load(Ordering::SeqCst), 0);
        assert_eq!(java.stopped.load(Ordering::SeqCst), 1);
        assert_eq!(go.stopped.load(Ordering::SeqCst), 1);
        assert!(error.contains("never selected as an automatic fallback"));
    }

    #[test]
    fn the_override_spelling_is_forgiving() {
        assert_eq!(parse_adapter("go"), IceAdapter::Go);
        assert_eq!(parse_adapter("  GO "), IceAdapter::Go);
        assert_eq!(parse_adapter("pioneer"), IceAdapter::Go);
        assert_eq!(parse_adapter("faf-pioneer"), IceAdapter::Go);
        assert_eq!(parse_adapter("java"), IceAdapter::Java);
    }

    #[test]
    fn an_unrecognised_override_uses_the_production_backend() {
        for raw in ["", "golang", "rust", "  "] {
            assert_eq!(parse_adapter(raw), IceAdapter::Java, "{raw:?}");
        }
    }
}
