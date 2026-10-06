//! The Live tab asks the vault about the games on screen, once each.
//!
//! A page of cards used to send dozens of overlapping lookups: every game was
//! asked about as many times as it was named, and the requests filled every
//! command slot the backend has, so a click on another tab waited behind them.
//! The service now drops ids that are already claimed or answered.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use faf_app::infra::fake_ports;
use faf_app::ports::{ReplayVaultPort, VaultSearchResult};
use faf_app::{App, Ports};
use faf_domain::state::{LocalReplay, ReplayCommand, ReplayQuery};

/// Records which game ids each vault search asked about, and answers none.
#[derive(Default)]
struct CountingLookups {
    asked: Arc<Mutex<Vec<Vec<String>>>>,
}

#[async_trait]
impl ReplayVaultPort for CountingLookups {
    async fn search_vault(&self, query: ReplayQuery) -> Result<VaultSearchResult, String> {
        self.asked.lock().unwrap().push(query.replay_ids.clone());
        Ok(VaultSearchResult {
            replays: Vec::new(),
            total_pages: None,
            total_records: None,
        })
    }

    async fn list_featured_mods(&self) -> Result<Vec<String>, String> {
        unreachable!()
    }

    async fn download_vault(&self, _uid: i32) -> Result<LocalReplay, String> {
        unreachable!()
    }
}

#[tokio::test]
async fn a_game_already_looked_up_is_not_asked_about_again() {
    let asked = Arc::new(Mutex::new(Vec::new()));
    let ports = Ports {
        replay_vault: Arc::new(CountingLookups {
            asked: asked.clone(),
        }),
        ..fake_ports()
    };
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());

    app.dispatch_and_wait(
        ReplayCommand::LookUpOnlineMany {
            uids: vec![1, 2, 3],
        }
        .into(),
    )
    .await
    .unwrap();
    // The overlapping request a card grid used to send next.
    app.dispatch_and_wait(
        ReplayCommand::LookUpOnlineMany {
            uids: vec![2, 3, 4],
        }
        .into(),
    )
    .await
    .unwrap();
    // And one that names nothing new.
    app.dispatch_and_wait(ReplayCommand::LookUpOnlineMany { uids: vec![1, 4] }.into())
        .await
        .unwrap();

    assert_eq!(
        *asked.lock().unwrap(),
        vec![
            vec!["1".to_string(), "2".to_string(), "3".to_string()],
            vec!["4".to_string()],
        ],
        "each game is asked about once"
    );
}
