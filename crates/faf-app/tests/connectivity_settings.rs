//! The connectivity preference must actually reach the ICE port.
//!
//! `SelectableIce` has its own unit tests for dispatching between the two
//! backends; what those cannot show is that the Settings toggle is wired to
//! it at all. A preference that persists but never reaches the port would look
//! entirely correct in the UI and change nothing about which adapter starts.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use faf_app::infra::fake_ports;
use faf_app::ports::{ConnectivitySession, IceParams, IcePort};
use faf_app::{App, Ports};
use faf_domain::state::{ConnectivityPreferences, IceAdapter, SettingsCommand};

/// Records every backend selection it is told about.
struct RecordingIce {
    chosen: Arc<Mutex<Vec<IceAdapter>>>,
}

#[async_trait]
impl IcePort for RecordingIce {
    async fn start(&self, _params: IceParams) -> Result<ConnectivitySession, String> {
        Err("not used in this test".into())
    }
    fn stop(&self) {}
    fn set_backend(&self, adapter: IceAdapter) {
        self.chosen.lock().unwrap().push(adapter);
    }
}

fn app_with(chosen: Arc<Mutex<Vec<IceAdapter>>>) -> App {
    let ports = Ports {
        ice: Arc::new(RecordingIce { chosen }),
        ..fake_ports()
    };
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());
    app
}

async fn settle(chosen: &Arc<Mutex<Vec<IceAdapter>>>, count: usize) {
    for _ in 0..300 {
        if chosen.lock().unwrap().len() >= count {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!(
        "expected {count} selections, saw {:?}",
        chosen.lock().unwrap()
    );
}

#[tokio::test]
async fn choosing_an_adapter_reaches_the_port_and_is_stored() {
    let chosen = Arc::new(Mutex::new(Vec::new()));
    let app = app_with(chosen.clone());

    app.dispatch(
        SettingsCommand::SetConnectivity {
            preferences: ConnectivityPreferences {
                adapter: IceAdapter::Go,
                selection_version: 1,
            },
        }
        .into(),
    )
    .await
    .unwrap();

    settle(&chosen, 1).await;
    assert_eq!(*chosen.lock().unwrap(), vec![IceAdapter::Go]);
    assert_eq!(
        app.snapshot().settings.connectivity.adapter,
        IceAdapter::Go,
        "and it is in the state the UI renders from"
    );
}

#[tokio::test]
async fn a_stored_preference_is_applied_on_load() {
    // Otherwise a choice made in a previous session would be ignored until the
    // user opened Settings and re-picked it.
    let chosen = Arc::new(Mutex::new(Vec::new()));
    let app = app_with(chosen.clone());

    app.dispatch(SettingsCommand::Load.into()).await.unwrap();
    settle(&chosen, 1).await;

    // The fake settings port loads defaults, so the established Java adapter
    // is expected here. Loading must push the persisted/default choice into the
    // live selector rather than leaving its startup value implicit.
    assert_eq!(*chosen.lock().unwrap(), vec![IceAdapter::Java]);
}

#[tokio::test]
async fn both_backends_remain_selectable() {
    // Neither adapter is going away; a change in either direction must stick.
    let chosen = Arc::new(Mutex::new(Vec::new()));
    let app = app_with(chosen.clone());

    for adapter in [IceAdapter::Go, IceAdapter::Java, IceAdapter::Go] {
        app.dispatch(
            SettingsCommand::SetConnectivity {
                preferences: ConnectivityPreferences {
                    adapter,
                    selection_version: 1,
                },
            }
            .into(),
        )
        .await
        .unwrap();
    }

    settle(&chosen, 3).await;
    assert_eq!(
        *chosen.lock().unwrap(),
        vec![IceAdapter::Go, IceAdapter::Java, IceAdapter::Go]
    );
}
