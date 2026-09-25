//! The leaderboard catalogue is fetched once, not once per mount.
//!
//! The leaderboard tab and the online replay vault both ask for it on mount,
//! and the replay vault asks again whenever its search effect re-runs. The
//! views used to check `catalogStatus` before sending; the guard now lives in
//! the service, where a new caller cannot forget it, and this pins it there.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use faf_app::infra::fake_ports;
use faf_app::ports::LeaderboardPort;
use faf_app::{App, Ports};
use faf_domain::state::{
    LeaderboardCommand, LeaderboardStatus, League, LeagueSeason, PlayerRatings, RatingLeaderboard,
    RatingPage, RatingQuery, SeasonLeaderboard,
};

/// Counts catalogue fetches. The two catalogue methods are the ones under
/// test; the rest are never reached.
struct CountingLeaderboard {
    fetches: Arc<AtomicUsize>,
    fail: bool,
}

#[async_trait]
impl LeaderboardPort for CountingLeaderboard {
    async fn list_rating_leaderboards(&self) -> Result<Vec<RatingLeaderboard>, String> {
        self.fetches.fetch_add(1, Ordering::SeqCst);
        if self.fail {
            return Err("offline".into());
        }
        Ok(vec![RatingLeaderboard {
            id: 1,
            technical_name: "global".into(),
            name: "Global".into(),
            description: String::new(),
        }])
    }
    async fn list_leagues(&self) -> Result<Vec<League>, String> {
        Ok(Vec::new())
    }
    async fn list_ratings(&self, _query: &RatingQuery) -> Result<RatingPage, String> {
        Err("not under test".into())
    }
    async fn list_player_ratings(&self, _ids: &[i32]) -> Result<Vec<PlayerRatings>, String> {
        Ok(Vec::new())
    }
    async fn list_seasons(&self, _league_id: i32) -> Result<Vec<LeagueSeason>, String> {
        Ok(Vec::new())
    }
    async fn list_season_leaderboard(&self, _season_id: i32) -> Result<SeasonLeaderboard, String> {
        Err("not under test".into())
    }
}

fn app_with(fail: bool) -> (App, Arc<AtomicUsize>) {
    let fetches = Arc::new(AtomicUsize::new(0));
    let ports = Ports {
        leaderboard: Arc::new(CountingLeaderboard {
            fetches: fetches.clone(),
            fail,
        }),
        ..fake_ports()
    };
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());
    (app, fetches)
}

#[tokio::test]
async fn a_loaded_catalogue_is_not_fetched_again() {
    let (app, fetches) = app_with(false);

    app.dispatch_and_wait(LeaderboardCommand::LoadCatalog.into())
        .await
        .unwrap();
    assert_eq!(
        app.snapshot().leaderboard.catalog_status,
        LeaderboardStatus::Ready
    );

    // The leaderboard tab, then the replay vault, then the vault's effect
    // re-running on a search.
    for _ in 0..3 {
        app.dispatch_and_wait(LeaderboardCommand::LoadCatalog.into())
            .await
            .unwrap();
    }

    assert_eq!(
        fetches.load(Ordering::SeqCst),
        1,
        "the catalogue must be fetched once, however many views ask for it"
    );
}

/// A catalogue that failed because the user was offline for the first attempt
/// has to be retryable, or the tab stays empty for the rest of the session.
#[tokio::test]
async fn a_failed_catalogue_is_retried() {
    let (app, fetches) = app_with(true);

    app.dispatch_and_wait(LeaderboardCommand::LoadCatalog.into())
        .await
        .unwrap();
    assert!(matches!(
        app.snapshot().leaderboard.catalog_status,
        LeaderboardStatus::Failed { .. }
    ));

    app.dispatch_and_wait(LeaderboardCommand::LoadCatalog.into())
        .await
        .unwrap();

    assert_eq!(
        fetches.load(Ordering::SeqCst),
        2,
        "a failure must be retryable"
    );
}
