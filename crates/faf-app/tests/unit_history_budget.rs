//! Unit comparisons share a download budget and stop discarded builds.
use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use faf_app::infra::fake_ports;
use faf_app::ports::{ChangelogPort, UnitHistoryPort};
use faf_app::{App, Ports};
use faf_domain::protocol::blueprint::parse_blueprint;
use faf_domain::protocol::changelog::{ChangelogEntry, ChangelogRelease};
use faf_domain::protocol::unit_history::{
    summarize, BaseGameBlueprint, ReleaseBlueprint, UnitSummary,
};
use faf_domain::state::UnitHistoryCommand;

#[derive(Default)]
struct History {
    active: Arc<Mutex<HashMap<String, usize>>>,
    maximum: AtomicUsize,
}

struct Active {
    id: String,
    active: Arc<Mutex<HashMap<String, usize>>>,
}
impl Drop for Active {
    fn drop(&mut self) {
        let mut active = self.active.lock().unwrap();
        let count = active.get_mut(&self.id).unwrap();
        *count -= 1;
        if *count == 0 {
            active.remove(&self.id);
        }
    }
}

#[async_trait]
impl UnitHistoryPort for History {
    async fn list_units(&self, _: Option<PathBuf>) -> Result<Vec<UnitSummary>, String> {
        let blueprint =
            parse_blueprint("UnitBlueprint { General = { FactionName = 'UEF' } }").unwrap();
        Ok((1..=6)
            .map(|id| {
                summarize(&format!("units/UEL000{id}/UEL000{id}_unit.bp"), &blueprint).unwrap()
            })
            .collect())
    }
    async fn release_tags(&self) -> Result<BTreeSet<String>, String> {
        Ok((3800..3830).map(|id| id.to_string()).collect())
    }
    async fn release_blueprint(&self, _: &str, paths: &[String]) -> ReleaseBlueprint {
        let id = paths[0].split('/').nth(1).unwrap().to_owned();
        {
            let mut active = self.active.lock().unwrap();
            *active.entry(id.clone()).or_default() += 1;
            self.maximum
                .fetch_max(active.values().sum(), Ordering::SeqCst);
        }
        let _active = Active {
            id,
            active: self.active.clone(),
        };
        std::future::pending().await
    }
    async fn base_game(&self, _: &UnitSummary) -> BaseGameBlueprint {
        BaseGameBlueprint::Missing
    }
    async fn fragmenting_projectiles(&self, _: Option<PathBuf>) -> BTreeSet<String> {
        BTreeSet::new()
    }
}

struct Archive;
#[async_trait]
impl ChangelogPort for Archive {
    async fn list_releases(&self) -> Result<Vec<ChangelogRelease>, String> {
        Ok((3800..3830)
            .map(|id| ChangelogRelease {
                id: id.to_string(),
                kind: "Game Patch".into(),
                date: "2026-01-01".into(),
                year: "2026".into(),
                source_url: format!("https://example.invalid/{id}"),
                web_url: format!("https://example.invalid/{id}"),
            })
            .collect())
    }
    async fn load_entry(&self, _: ChangelogRelease) -> Result<ChangelogEntry, String> {
        unreachable!()
    }
}

async fn until(test: impl Fn() -> bool) {
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while !test() {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("unit history work settled");
}

#[tokio::test]
async fn selected_units_share_twelve_reads_and_deselection_drops_their_futures() {
    let history = Arc::new(History::default());
    let (app, app_loop) = App::new(
        "test",
        Ports {
            unit_history: history.clone(),
            changelog: Arc::new(Archive),
            ..fake_ports()
        },
    );
    let running = tokio::spawn(app_loop.run());
    app.dispatch_and_wait(UnitHistoryCommand::LoadList.into())
        .await
        .unwrap();
    app.dispatch(
        UnitHistoryCommand::SetSelection {
            ids: (1..=6).map(|id| format!("UEL000{id}")).collect(),
        }
        .into(),
    )
    .await
    .unwrap();
    until(|| history.active.lock().unwrap().values().sum::<usize>() == 12).await;
    assert_eq!(history.maximum.load(Ordering::SeqCst), 12);
    app.dispatch_and_wait(
        UnitHistoryCommand::SetSelection {
            ids: vec!["UEL0006".into()],
        }
        .into(),
    )
    .await
    .unwrap();
    until(|| {
        let active = history.active.lock().unwrap();
        active.len() == 1 && active.contains_key("UEL0006") && active.values().sum::<usize>() == 12
    })
    .await;
    app.dispatch_and_wait(UnitHistoryCommand::SetSelection { ids: vec![] }.into())
        .await
        .unwrap();
    until(|| history.active.lock().unwrap().is_empty()).await;
    assert_eq!(history.maximum.load(Ordering::SeqCst), 12);
    assert!(app.snapshot().unit_history.histories.is_empty());
    running.abort();
}
