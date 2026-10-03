//! The entry-eligibility notice belongs to the event it was asked about.
//!
//! A check is a network round trip, and the reader can open another event in
//! the meantime. Selecting the other event clears the notice; an answer for the
//! event just left, verdict or refusal, must not then fill it in again.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use faf_app::infra::{fake_ports, FakeTourney};
use faf_app::ports::{RequestError, TourneyPort};
use faf_app::{App, Ports};
use faf_domain::state::{
    Article, BracketConfig, ChatPost, ChatRoom, FfaReport, FormatDraft, HostingStatus, MapDraft,
    MatchReport, PoolDraft, QualifierRule, SeedOrder, SeriesDetail, SeriesDraft, Tourney,
    TourneyCommand, TourneyDraft, TourneyLoadStatus, TourneyPhase, TourneySeries,
};
use faf_domain::state::{CopySource, EntrantRatings, RatingCheck, TourneyPreset};
use faf_domain::state::{FactionVetoConfig, RenameCheck, TourneyAdmin, TourneyFaction};
use faf_domain::state::{SiteDocument, SiteRead, SiteWrite};
use tokio::sync::Semaphore;

/// One held-open eligibility check.
struct Gate {
    entered: AtomicBool,
    open: Semaphore,
}

/// Closed until released: the semaphore starts with no permits.
impl Default for Gate {
    fn default() -> Self {
        Self {
            entered: AtomicBool::new(false),
            open: Semaphore::new(0),
        }
    }
}

/// The offline tournament service, except that each eligibility check waits
/// for the test to let it answer, and answers with a refusal when `refuse` is
/// set.
struct GatedTourney {
    inner: FakeTourney,
    gates: Mutex<HashMap<String, Arc<Gate>>>,
    refuse: bool,
}

impl GatedTourney {
    fn gate(&self, tournament_id: &str) -> Arc<Gate> {
        self.gates
            .lock()
            .expect("gates poisoned")
            .entry(tournament_id.to_string())
            .or_default()
            .clone()
    }
}

#[async_trait]
impl TourneyPort for GatedTourney {
    async fn check_rating(&self, tournament_id: &str) -> Result<RatingCheck, RequestError> {
        let gate = self.gate(tournament_id);
        gate.entered.store(true, Ordering::SeqCst);
        gate.open.acquire().await.expect("gate closed").forget();
        if self.refuse {
            return Err(RequestError::rejected(
                "Checking your rating needs your FAF login.",
            ));
        }
        Ok(RatingCheck {
            rated: true,
            eligible: Some(true),
            ..RatingCheck::default()
        })
    }

    // Everything else is the ordinary offline service.
    fn asset_base(&self) -> String {
        self.inner.asset_base()
    }
    async fn hosting(&self) -> Result<HostingStatus, RequestError> {
        self.inner.hosting().await
    }
    async fn profile(&self) -> Result<String, RequestError> {
        self.inner.profile().await
    }
    async fn set_discord(&self, handle: &str) -> Result<String, RequestError> {
        self.inner.set_discord(handle).await
    }
    async fn create(&self, draft: &TourneyDraft) -> Result<String, RequestError> {
        self.inner.create(draft).await
    }
    async fn edit_info(
        &self,
        tournament_id: &str,
        draft: &TourneyDraft,
    ) -> Result<(), RequestError> {
        self.inner.edit_info(tournament_id, draft).await
    }
    async fn publish(&self, tournament_id: &str) -> Result<(), RequestError> {
        self.inner.publish(tournament_id).await
    }
    async fn advance(
        &self,
        tournament_id: &str,
        phase: TourneyPhase,
        config: Option<&BracketConfig>,
    ) -> Result<(), RequestError> {
        self.inner.advance(tournament_id, phase, config).await
    }
    async fn archive(&self, tournament_id: &str) -> Result<(), RequestError> {
        self.inner.archive(tournament_id).await
    }
    async fn list(&self) -> Result<Vec<Tourney>, RequestError> {
        self.inner.list().await
    }
    async fn detail(&self, tournament_id: &str) -> Result<Tourney, RequestError> {
        self.inner.detail(tournament_id).await
    }
    async fn sign_up(&self, tournament_id: &str, rating: Option<i32>) -> Result<(), RequestError> {
        self.inner.sign_up(tournament_id, rating).await
    }
    async fn decline_invite(&self, tournament_id: &str) -> Result<(), RequestError> {
        self.inner.decline_invite(tournament_id).await
    }
    async fn player_ratings(
        &self,
        tournament_id: &str,
        player_id: &str,
        refresh: bool,
    ) -> Result<EntrantRatings, RequestError> {
        self.inner
            .player_ratings(tournament_id, player_id, refresh)
            .await
    }
    async fn copy_sources(&self) -> Result<Vec<CopySource>, RequestError> {
        self.inner.copy_sources().await
    }
    async fn upload_desc_image(
        &self,
        tournament_id: &str,
        data_url: &str,
    ) -> Result<String, RequestError> {
        self.inner.upload_desc_image(tournament_id, data_url).await
    }
    async fn presets(&self) -> Result<Vec<TourneyPreset>, RequestError> {
        self.inner.presets().await
    }
    async fn site_read(&self, read: SiteRead) -> Result<SiteDocument, RequestError> {
        self.inner.site_read(read).await
    }
    async fn site_write(
        &self,
        write: &SiteWrite,
    ) -> Result<(Option<String>, Option<String>), RequestError> {
        self.inner.site_write(write).await
    }
    async fn withdraw(&self, tournament_id: &str, player_id: &str) -> Result<(), RequestError> {
        self.inner.withdraw(tournament_id, player_id).await
    }
    async fn create_team(&self, tournament_id: &str, name: &str) -> Result<(), RequestError> {
        self.inner.create_team(tournament_id, name).await
    }
    async fn request_join(&self, tournament_id: &str, team_id: &str) -> Result<(), RequestError> {
        self.inner.request_join(tournament_id, team_id).await
    }
    async fn cancel_join(&self, tournament_id: &str, team_id: &str) -> Result<(), RequestError> {
        self.inner.cancel_join(tournament_id, team_id).await
    }
    async fn respond_join(
        &self,
        tournament_id: &str,
        team_id: &str,
        player_id: &str,
        accept: bool,
    ) -> Result<(), RequestError> {
        self.inner
            .respond_join(tournament_id, team_id, player_id, accept)
            .await
    }
    async fn invite_to_team(
        &self,
        tournament_id: &str,
        team_id: &str,
        player_id: &str,
    ) -> Result<(), RequestError> {
        self.inner
            .invite_to_team(tournament_id, team_id, player_id)
            .await
    }
    async fn respond_invite(
        &self,
        tournament_id: &str,
        team_id: &str,
        accept: bool,
    ) -> Result<(), RequestError> {
        self.inner
            .respond_invite(tournament_id, team_id, accept)
            .await
    }
    async fn leave_team(&self, tournament_id: &str) -> Result<(), RequestError> {
        self.inner.leave_team(tournament_id).await
    }
    async fn disband_team(&self, tournament_id: &str, team_id: &str) -> Result<(), RequestError> {
        self.inner.disband_team(tournament_id, team_id).await
    }
    async fn rename_team(
        &self,
        tournament_id: &str,
        team_id: &str,
        name: &str,
    ) -> Result<(), RequestError> {
        self.inner.rename_team(tournament_id, team_id, name).await
    }
    async fn add_player(
        &self,
        tournament_id: &str,
        name: &str,
        rating: Option<i32>,
    ) -> Result<(), RequestError> {
        self.inner.add_player(tournament_id, name, rating).await
    }
    async fn set_captain(
        &self,
        tournament_id: &str,
        team_id: &str,
        player_id: &str,
    ) -> Result<(), RequestError> {
        self.inner
            .set_captain(tournament_id, team_id, player_id)
            .await
    }
    async fn move_player(
        &self,
        tournament_id: &str,
        player_id: &str,
        team_id: Option<&str>,
    ) -> Result<(), RequestError> {
        self.inner
            .move_player(tournament_id, player_id, team_id)
            .await
    }
    async fn edit_player(
        &self,
        tournament_id: &str,
        player_id: &str,
        note: &str,
        rating: Option<i32>,
    ) -> Result<(), RequestError> {
        self.inner
            .edit_player(tournament_id, player_id, note, rating)
            .await
    }
    async fn respond_signup(
        &self,
        tournament_id: &str,
        player_id: &str,
        accept: bool,
    ) -> Result<(), RequestError> {
        self.inner
            .respond_signup(tournament_id, player_id, accept)
            .await
    }
    async fn invite_player(&self, tournament_id: &str, name: &str) -> Result<(), RequestError> {
        self.inner.invite_player(tournament_id, name).await
    }
    async fn uninvite(&self, tournament_id: &str, faf_id: i32) -> Result<(), RequestError> {
        self.inner.uninvite(tournament_id, faf_id).await
    }
    async fn reseed(&self, tournament_id: &str, order: &SeedOrder) -> Result<(), RequestError> {
        self.inner.reseed(tournament_id, order).await
    }
    async fn split_divisions(
        &self,
        tournament_id: &str,
        divisions: i32,
    ) -> Result<(), RequestError> {
        self.inner.split_divisions(tournament_id, divisions).await
    }
    async fn set_division(
        &self,
        tournament_id: &str,
        team_id: &str,
        division: i32,
    ) -> Result<(), RequestError> {
        self.inner
            .set_division(tournament_id, team_id, division)
            .await
    }
    async fn post_news(
        &self,
        tournament_id: &str,
        body: &str,
        important: bool,
    ) -> Result<(), RequestError> {
        self.inner.post_news(tournament_id, body, important).await
    }
    async fn delete_news(&self, tournament_id: &str, news_id: &str) -> Result<(), RequestError> {
        self.inner.delete_news(tournament_id, news_id).await
    }
    async fn check_in(&self, tournament_id: &str, checked_in: bool) -> Result<(), RequestError> {
        self.inner.check_in(tournament_id, checked_in).await
    }
    async fn confirm_report(
        &self,
        tournament_id: &str,
        match_id: &str,
        accept: bool,
    ) -> Result<(), RequestError> {
        self.inner
            .confirm_report(tournament_id, match_id, accept)
            .await
    }
    async fn decide_report(
        &self,
        tournament_id: &str,
        report: &MatchReport,
    ) -> Result<(), RequestError> {
        self.inner.decide_report(tournament_id, report).await
    }
    async fn submit_report(
        &self,
        tournament_id: &str,
        report: &MatchReport,
    ) -> Result<(), RequestError> {
        self.inner.submit_report(tournament_id, report).await
    }
    async fn chat_rooms(&self, tournament_id: &str) -> Result<Vec<ChatRoom>, RequestError> {
        self.inner.chat_rooms(tournament_id).await
    }
    async fn chat_read(
        &self,
        tournament_id: &str,
        room_id: &str,
    ) -> Result<Vec<ChatPost>, RequestError> {
        self.inner.chat_read(tournament_id, room_id).await
    }
    async fn chat_post(
        &self,
        tournament_id: &str,
        room_id: &str,
        body: &str,
        reply_to: Option<&str>,
    ) -> Result<(), RequestError> {
        self.inner
            .chat_post(tournament_id, room_id, body, reply_to)
            .await
    }
    async fn articles(&self) -> Result<Vec<Article>, RequestError> {
        self.inner.articles().await
    }
    async fn assign_pool(
        &self,
        tournament_id: &str,
        round_key: &str,
        pool_id: &str,
    ) -> Result<(), RequestError> {
        self.inner
            .assign_pool(tournament_id, round_key, pool_id)
            .await
    }
    async fn draft_pick(&self, tournament_id: &str, player_id: &str) -> Result<(), RequestError> {
        self.inner.draft_pick(tournament_id, player_id).await
    }
    async fn draft_undo(&self, tournament_id: &str) -> Result<(), RequestError> {
        self.inner.draft_undo(tournament_id).await
    }
    async fn set_captains(
        &self,
        tournament_id: &str,
        player_ids: &[String],
    ) -> Result<(), RequestError> {
        self.inner.set_captains(tournament_id, player_ids).await
    }
    async fn report_ffa(
        &self,
        tournament_id: &str,
        report: &FfaReport,
    ) -> Result<(), RequestError> {
        self.inner.report_ffa(tournament_id, report).await
    }
    async fn veto_act(
        &self,
        tournament_id: &str,
        match_id: &str,
        map_id: &str,
    ) -> Result<(), RequestError> {
        self.inner.veto_act(tournament_id, match_id, map_id).await
    }
    async fn veto_set_sides(
        &self,
        tournament_id: &str,
        match_id: &str,
        team_a: &str,
    ) -> Result<(), RequestError> {
        self.inner
            .veto_set_sides(tournament_id, match_id, team_a)
            .await
    }
    async fn veto_undo(&self, tournament_id: &str, match_id: &str) -> Result<(), RequestError> {
        self.inner.veto_undo(tournament_id, match_id).await
    }
    async fn faction_veto(
        &self,
        tournament_id: &str,
        match_id: &str,
        game: i32,
        faction: TourneyFaction,
    ) -> Result<(), RequestError> {
        self.inner
            .faction_veto(tournament_id, match_id, game, faction)
            .await
    }
    async fn set_faction_veto(
        &self,
        tournament_id: &str,
        config: &FactionVetoConfig,
    ) -> Result<(), RequestError> {
        self.inner.set_faction_veto(tournament_id, config).await
    }
    async fn check_renames(&self, tournament_id: &str) -> Result<RenameCheck, RequestError> {
        self.inner.check_renames(tournament_id).await
    }
    async fn administer(
        &self,
        tournament_id: &str,
        change: &TourneyAdmin,
    ) -> Result<(), RequestError> {
        self.inner.administer(tournament_id, change).await
    }
    async fn save_map(&self, tournament_id: &str, map: &MapDraft) -> Result<(), RequestError> {
        self.inner.save_map(tournament_id, map).await
    }
    async fn publish_map(
        &self,
        tournament_id: &str,
        map_id: &str,
        published: bool,
    ) -> Result<(), RequestError> {
        self.inner
            .publish_map(tournament_id, map_id, published)
            .await
    }
    async fn delete_map(&self, tournament_id: &str, map_id: &str) -> Result<(), RequestError> {
        self.inner.delete_map(tournament_id, map_id).await
    }
    async fn publish_pool(
        &self,
        tournament_id: &str,
        pool_id: &str,
        published: bool,
    ) -> Result<(), RequestError> {
        self.inner
            .publish_pool(tournament_id, pool_id, published)
            .await
    }
    async fn delete_pool(&self, tournament_id: &str, pool_id: &str) -> Result<(), RequestError> {
        self.inner.delete_pool(tournament_id, pool_id).await
    }
    async fn save_pool(&self, tournament_id: &str, pool: &PoolDraft) -> Result<(), RequestError> {
        self.inner.save_pool(tournament_id, pool).await
    }
    async fn series(&self) -> Result<Vec<TourneySeries>, RequestError> {
        self.inner.series().await
    }
    async fn series_detail(&self, series_id: &str) -> Result<SeriesDetail, RequestError> {
        self.inner.series_detail(series_id).await
    }
    async fn save_series(&self, draft: &SeriesDraft) -> Result<(), RequestError> {
        self.inner.save_series(draft).await
    }
    async fn delete_series(&self, series_id: &str) -> Result<(), RequestError> {
        self.inner.delete_series(series_id).await
    }
    async fn set_series(
        &self,
        tournament_id: &str,
        series_id: Option<&str>,
    ) -> Result<(), RequestError> {
        self.inner.set_series(tournament_id, series_id).await
    }
    async fn add_qualifier(
        &self,
        tournament_id: &str,
        qualifier_id: &str,
        rule: QualifierRule,
    ) -> Result<(), RequestError> {
        self.inner
            .add_qualifier(tournament_id, qualifier_id, rule)
            .await
    }
    async fn remove_qualifier(
        &self,
        tournament_id: &str,
        link_id: &str,
    ) -> Result<(), RequestError> {
        self.inner.remove_qualifier(tournament_id, link_id).await
    }
    async fn edit_format(
        &self,
        tournament_id: &str,
        format: &FormatDraft,
        structural: bool,
    ) -> Result<(), RequestError> {
        self.inner
            .edit_format(tournament_id, format, structural)
            .await
    }
    async fn mute_chat(
        &self,
        tournament_id: &str,
        faf_id: i32,
        name: &str,
        muted: bool,
    ) -> Result<(), RequestError> {
        self.inner
            .mute_chat(tournament_id, faf_id, name, muted)
            .await
    }
    async fn delete_chat_post(
        &self,
        tournament_id: &str,
        room_id: &str,
        post_id: &str,
    ) -> Result<(), RequestError> {
        self.inner
            .delete_chat_post(tournament_id, room_id, post_id)
            .await
    }
    async fn add_organiser(
        &self,
        tournament_id: &str,
        faf_id: i32,
        name: &str,
    ) -> Result<(), RequestError> {
        self.inner.add_organiser(tournament_id, faf_id, name).await
    }
    async fn set_organiser_visibility(
        &self,
        tournament_id: &str,
        faf_id: i32,
        hidden: bool,
    ) -> Result<(), RequestError> {
        self.inner
            .set_organiser_visibility(tournament_id, faf_id, hidden)
            .await
    }
    async fn abandon(&self, tournament_id: &str, abandoned: bool) -> Result<(), RequestError> {
        self.inner.abandon(tournament_id, abandoned).await
    }
    async fn edit_news(
        &self,
        tournament_id: &str,
        news_id: &str,
        body: &str,
        important: bool,
    ) -> Result<(), RequestError> {
        self.inner
            .edit_news(tournament_id, news_id, body, important)
            .await
    }
    async fn mark_news_read(&self, tournament_id: &str) -> Result<(), RequestError> {
        self.inner.mark_news_read(tournament_id).await
    }
    async fn set_caster(
        &self,
        tournament_id: &str,
        faf_id: i32,
        name: &str,
        casting: bool,
    ) -> Result<(), RequestError> {
        self.inner
            .set_caster(tournament_id, faf_id, name, casting)
            .await
    }
}

async fn wait_entered(port: &GatedTourney, tournament_id: &str) {
    let gate = port.gate(tournament_id);
    for _ in 0..400 {
        if gate.entered.load(Ordering::SeqCst) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("no eligibility check for {tournament_id} arrived");
}

/// Open event A, ask about it, move to event B, then let A's answer arrive.
async fn answer_after_moving_on(refuse: bool) {
    let port = Arc::new(GatedTourney {
        inner: FakeTourney::default(),
        gates: Mutex::new(HashMap::new()),
        refuse,
    });
    let (app, app_loop) = App::new(
        "test",
        Ports {
            tourney: port.clone(),
            ..fake_ports()
        },
    );
    tokio::spawn(app_loop.run());
    let app = Arc::new(app);

    app.dispatch_and_wait(TourneyCommand::Load.into())
        .await
        .unwrap();
    let events = app.snapshot().tourney.events;
    let (left, opened) = (events[0].id.clone(), events[1].id.clone());

    app.dispatch_and_wait(
        TourneyCommand::Select {
            tournament_id: left.clone(),
        }
        .into(),
    )
    .await
    .unwrap();
    let check = {
        let app = app.clone();
        let tournament_id = left.clone();
        tokio::spawn(async move {
            app.dispatch_and_wait(TourneyCommand::CheckRating { tournament_id }.into())
                .await
                .unwrap();
        })
    };
    wait_entered(&port, &left).await;
    assert_eq!(
        app.snapshot().tourney.rating_check_status,
        TourneyLoadStatus::Loading
    );

    app.dispatch_and_wait(
        TourneyCommand::Select {
            tournament_id: opened.clone(),
        }
        .into(),
    )
    .await
    .unwrap();
    port.gate(&left).open.add_permits(1);
    check.await.unwrap();

    let tourney = app.snapshot().tourney;
    assert_eq!(tourney.selected_id.as_deref(), Some(opened.as_str()));
    assert_eq!(
        tourney.rating_check, None,
        "a verdict about {left} landed on {opened}"
    );
    assert_eq!(tourney.rating_check_status, TourneyLoadStatus::Idle);
}

#[tokio::test]
async fn a_late_eligibility_verdict_does_not_land_on_the_next_event() {
    answer_after_moving_on(false).await;
}

#[tokio::test]
async fn a_late_eligibility_refusal_does_not_land_on_the_next_event() {
    answer_after_moving_on(true).await;
}

/// Re-selecting the event already open is not moving on: its check still
/// answers, or the notice would be left loading for good.
#[tokio::test]
async fn reselecting_the_open_event_keeps_its_check() {
    let port = Arc::new(GatedTourney {
        inner: FakeTourney::default(),
        gates: Mutex::new(HashMap::new()),
        refuse: false,
    });
    let (app, app_loop) = App::new(
        "test",
        Ports {
            tourney: port.clone(),
            ..fake_ports()
        },
    );
    tokio::spawn(app_loop.run());
    let app = Arc::new(app);

    app.dispatch_and_wait(TourneyCommand::Load.into())
        .await
        .unwrap();
    let open = app.snapshot().tourney.events[0].id.clone();
    let select = || -> faf_domain::AppCommand {
        TourneyCommand::Select {
            tournament_id: open.clone(),
        }
        .into()
    };
    app.dispatch_and_wait(select()).await.unwrap();
    let check = {
        let app = app.clone();
        let tournament_id = open.clone();
        tokio::spawn(async move {
            app.dispatch_and_wait(TourneyCommand::CheckRating { tournament_id }.into())
                .await
                .unwrap();
        })
    };
    wait_entered(&port, &open).await;
    app.dispatch_and_wait(select()).await.unwrap();
    port.gate(&open).open.add_permits(1);
    check.await.unwrap();

    let tourney = app.snapshot().tourney;
    assert_eq!(tourney.rating_check_status, TourneyLoadStatus::Ready);
    assert_eq!(
        tourney.rating_check.and_then(|check| check.eligible),
        Some(true)
    );
}
