//! Training hub service tests.
//!
//! Two things here are worth a test at this level rather than in the domain,
//! because both are about the service reading *other* slices:
//!
//! 1. loading the hub fills the library from FAF's tutorial catalogue as well
//!    as the manifest, and then ranks it against a profile folded out of the
//!    local replay archive;
//! 2. a review request opened by naming a replay comes back filled in from
//!    that replay, including this account's own faction and the rating it had
//!    *in that game*.

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use faf_app::infra::fake_ports;
use faf_app::ports::{ReplayPort, TrainingPort, TutorialsPort, VaultSearchResult};
use faf_app::{App, Ports};
use faf_domain::state::{
    AuthCommand, LiveReplayTarget, LocalReplay, LocalReplayPlayer, LocalReplayStatus,
    LocalReplayTeam, ReplayQuery, TrainingCatalogue, TrainingCommand, TrainingKind, TrainingLinks,
    TrainingResource, TrainingStatus, Tutorial, TutorialCategory, VaultStatus,
};

const ME: &str = "Nuggets";

/// A manifest with one entry aimed squarely at what the replays below say the
/// player has been doing, and one aimed at somebody far stronger.
struct StubCatalogue;

#[async_trait]
impl TrainingPort for StubCatalogue {
    async fn list_catalogue(&self, _refresh: bool) -> Result<TrainingCatalogue, String> {
        let base = TrainingResource {
            kind: TrainingKind::Guide,
            ..TrainingResource::default()
        };
        Ok(TrainingCatalogue {
            resources: vec![
                TrainingResource {
                    id: "setons-eco".into(),
                    title: "Seton's economy".into(),
                    rating_min: Some(800),
                    rating_max: Some(1400),
                    game_modes: vec!["4v4".into()],
                    maps: vec!["Setons Clutch".into()],
                    ..base.clone()
                },
                TrainingResource {
                    id: "top-level".into(),
                    title: "Micro at the top".into(),
                    rating_min: Some(1900),
                    ..base
                },
            ],
            links: TrainingLinks {
                replay_review_category: Some(4),
                // Where a review request actually goes. The channel is the
                // precise destination and the invite the fallback, so the stub
                // states both and the test can tell which one was chosen.
                discord_url: "https://discord.gg/By9tNUAq8B".into(),
                replay_review_channel:
                    "https://discord.com/channels/197033481883222026/1094904988788080641".into(),
                ..TrainingLinks::default()
            },
            ..TrainingCatalogue::default()
        })
    }

    async fn read_guide(&self, url: String) -> Result<String, String> {
        Ok(format!("# Stub\n\nThe guide at {url}.\n"))
    }

    async fn read_recording(&self, _url: String) -> Result<String, String> {
        Err("this stub holds no recordings".into())
    }
}

/// The stub catalogue, slow enough that a second load arrives while the first
/// is still waiting for it, and counting how often it was asked.
struct SlowCatalogue(Arc<AtomicUsize>);

#[async_trait]
impl TrainingPort for SlowCatalogue {
    async fn list_catalogue(&self, refresh: bool) -> Result<TrainingCatalogue, String> {
        self.0.fetch_add(1, Ordering::SeqCst);
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        StubCatalogue.list_catalogue(refresh).await
    }

    async fn read_guide(&self, url: String) -> Result<String, String> {
        StubCatalogue.read_guide(url).await
    }

    async fn read_recording(&self, url: String) -> Result<String, String> {
        StubCatalogue.read_recording(url).await
    }
}

struct StubTutorials;

#[async_trait]
impl TutorialsPort for StubTutorials {
    async fn list_tutorials(&self) -> Result<(Vec<TutorialCategory>, Vec<Tutorial>), String> {
        Ok((
            vec![TutorialCategory {
                id: 1,
                name: "Basics".into(),
            }],
            vec![Tutorial {
                id: 7,
                title: "Economy basics".into(),
                description: "Mass and energy for a new player.".into(),
                link_url: String::new(),
                image_url: String::new(),
                ordinal: 1,
                launchable: true,
                map_folder_name: "scmp_tut_7".into(),
                technical_name: "tut_7".into(),
                category_id: Some(1),
            }],
        ))
    }
}

/// The player's own recent games, as the replay folder would report them.
struct StubReplays(Vec<LocalReplay>);

#[async_trait]
impl ReplayPort for StubReplays {
    async fn watch_live(
        &self,
        _target: LiveReplayTarget,
        _player: String,
    ) -> Result<Option<String>, String> {
        Ok(None)
    }
    async fn play_file(&self, _path: PathBuf) -> Result<Option<String>, String> {
        Ok(None)
    }
    async fn search_vault(&self, _query: ReplayQuery) -> Result<VaultSearchResult, String> {
        Ok(VaultSearchResult::default())
    }
    async fn list_featured_mods(&self) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }
    async fn watch_vault(&self, _uid: i32) -> Result<Option<String>, String> {
        Ok(None)
    }
    async fn download_vault(&self, _uid: i32) -> Result<LocalReplay, String> {
        Err("not in this test".into())
    }
    async fn load_details(
        &self,
        _uid: i32,
        _local_path: Option<PathBuf>,
    ) -> Result<faf_domain::state::ReplayDetails, String> {
        Ok(faf_domain::state::ReplayDetails::default())
    }
    async fn load_analysis(
        &self,
        _uid: i32,
        _local_path: Option<PathBuf>,
    ) -> Result<faf_domain::state::ReplayAnalysis, String> {
        unreachable!()
    }
    async fn list_local(&self, _limit: usize) -> Result<Vec<LocalReplay>, String> {
        Ok(self.0.clone())
    }
    async fn delete_local(&self, _path: PathBuf) -> Result<(), String> {
        Ok(())
    }
    fn set_install_dir(&self, _dir: Option<PathBuf>) {}
}

fn local(uid: i32, map: &str, players: i32, faction: i32, rating: i32) -> LocalReplay {
    LocalReplay {
        path: format!("C:/replays/{uid}.fafreplay"),
        file_name: format!("{uid}.fafreplay"),
        uid: Some(uid),
        map: map.into(),
        mod_name: "faf".into(),
        title: "all welcome".into(),
        recorder: ME.into(),
        start_time: Some(1_800_000_000),
        duration_seconds: Some(900),
        modified_time: 1_800_000_000,
        file_size_bytes: 1,
        num_players: players,
        teams: vec![LocalReplayTeam {
            team: "1".into(),
            players: vec![
                LocalReplayPlayer {
                    name: ME.into(),
                    faction: Some(faction),
                    rating: Some(rating),
                    ai: false,
                    country: None,
                },
                LocalReplayPlayer {
                    name: "Someone else".into(),
                    faction: Some(4),
                    rating: Some(2100),
                    ai: false,
                    country: None,
                },
            ],
        }],
        average_rating: Some(rating),
        sim_mods: Vec::new(),
        status: LocalReplayStatus::Complete,
        watchable: true,
        game_version: None,
    }
}

struct Harness {
    app: App,
}

fn harness(replays: Vec<LocalReplay>) -> Harness {
    harness_with(replays, Arc::new(StubCatalogue))
}

fn harness_with(replays: Vec<LocalReplay>, training: Arc<dyn TrainingPort>) -> Harness {
    let ports = Ports {
        training,
        tutorials: Arc::new(StubTutorials),
        replay: Arc::new(StubReplays(replays)),
        ..fake_ports()
    };
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());
    Harness { app }
}

impl Harness {
    /// Sign in, because the profile is about a specific account: without one,
    /// the replay rows cannot be attributed to anybody.
    async fn sign_in(&self) {
        self.app
            .dispatch(AuthCommand::Login { remember: false }.into())
            .await
            .unwrap();
        for _ in 0..300 {
            if self.app.snapshot().auth.player.is_some() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("never signed in");
    }

    async fn load(&self) {
        self.app
            .dispatch(TrainingCommand::Load.into())
            .await
            .unwrap();
        // The library is published before the replay scan finishes, so a
        // test that reads the replays waits for the scan as well.
        for _ in 0..400 {
            let state = self.app.snapshot();
            if state.training.status == TrainingStatus::Ready
                && state.replays.local_status == VaultStatus::Ready
            {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!(
            "the catalogue never loaded: {:?}",
            self.app.snapshot().training.status
        );
    }

    /// Wait for the recommendations, which are emitted after the load.
    async fn recommended(&self) -> Vec<String> {
        for _ in 0..400 {
            let training = self.app.snapshot().training;
            if !training.recommended.is_empty() || training.profile.games_seen > 0 {
                return training.recommended;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("no recommendations were ever computed");
    }
}

#[tokio::test]
async fn the_library_is_the_manifest_and_nothing_the_client_added() {
    // It used to be the manifest *plus* FAF's tutorial API, folded together.
    // That API returns entries flagged playable whose maps no longer start
    // anything, and link categories that are neither lessons nor tagged, and
    // none of it could be corrected without a client release. So the library is
    // now exactly what the catalogue says, in the catalogue's order, and
    // anything of FAF's worth keeping is added there in a commit.
    let h = harness(vec![local(1, "Setons Clutch", 8, 1, 1150)]);
    h.sign_in().await;
    h.load().await;

    let ids: Vec<String> = h
        .app
        .snapshot()
        .training
        .resources
        .iter()
        .map(|resource| resource.id.clone())
        .collect();
    assert_eq!(ids, vec!["setons-eco", "top-level"]);
    assert!(
        h.app
            .snapshot()
            .training
            .resource("faf-tutorial-7")
            .is_none(),
        "the tutorial API is not a source for this tab"
    );
}

#[tokio::test]
async fn the_recommendations_follow_the_maps_and_rating_the_replays_report() {
    let h = harness(vec![
        local(1, "Setons Clutch", 8, 1, 1150),
        local(2, "Setons Clutch", 8, 1, 1150),
    ]);
    h.sign_in().await;
    h.load().await;

    let recommended = h.recommended().await;
    assert_eq!(
        recommended.first().map(String::as_str),
        Some("setons-eco"),
        "the entry for this rating and this map leads: {recommended:?}"
    );
    assert!(
        !recommended.iter().any(|id| id == "top-level"),
        "material above this account band is not recommended to it: {recommended:?}"
    );

    let profile = h.app.snapshot().training.profile;
    assert_eq!(profile.player, ME);
    assert_eq!(profile.maps, vec!["Setons Clutch"]);
    assert_eq!(profile.game_modes, vec!["4v4"]);
    assert_eq!(profile.games_seen, 2);

    // The ratings come from the account's leaderboards, which the tab now asks
    // for itself: it used to depend on the play tab having been opened first,
    // and fell back to a median of old replay headers when it had not.
    assert_eq!(profile.rating, Some(1842), "the global rating");
    assert_eq!(
        profile.ratings.get("1v1").copied(),
        Some(1710),
        "and the ladder rating separately, because they disagree"
    );

    // Which is the whole point: a 1v1 entry is judged by 1710, not by 1842.
    let ladder = TrainingResource {
        id: "ladder".into(),
        game_modes: vec!["1v1".into()],
        ..TrainingResource::default()
    };
    assert_eq!(profile.rating_for(&ladder), Some(1710));

    // Fetched into the hub's own slot, not the player card: that slot is
    // shared, and whoever had a card open from chat used to lose it.
    assert!(
        h.app.snapshot().player_card.matchmaker_profile.is_none(),
        "opening training leaves the player card alone"
    );
}

/// A replay of somebody else's game, downloaded to watch.
fn foreign(uid: i32, map: &str) -> LocalReplay {
    let mut replay = local(uid, map, 8, 2, 2000);
    replay.recorder = "Stranger".into();
    replay.teams[0].players[0].name = "Stranger".into();
    replay
}

#[tokio::test]
async fn a_replay_on_an_official_map_is_recognised_by_its_folder() {
    // Replay headers name the folder. `scmp_009` used to fold to "009", which
    // matched none of the catalogue's Seton's entries.
    let h = harness(vec![
        local(1, "SCMP_009", 8, 1, 1150),
        local(2, "SCMP_009", 8, 1, 1150),
    ]);
    h.sign_in().await;
    h.load().await;

    let recommended = h.recommended().await;
    assert_eq!(
        recommended.first().map(String::as_str),
        Some("setons-eco"),
        "{recommended:?}"
    );
    assert_eq!(
        h.app.snapshot().training.profile.maps,
        vec!["Seton's Clutch"]
    );
}

#[tokio::test]
async fn downloaded_games_of_other_players_do_not_count() {
    let h = harness(vec![
        foreign(1, "Gap of Rohan"),
        local(2, "Setons Clutch", 8, 1, 1150),
        foreign(3, "Gap of Rohan"),
    ]);
    h.sign_in().await;
    h.load().await;
    h.recommended().await;

    let profile = h.app.snapshot().training.profile;
    assert_eq!(profile.games_seen, 1);
    assert_eq!(profile.maps, vec!["Setons Clutch"]);
}

#[tokio::test]
async fn a_review_of_someone_else_s_game_does_not_name_the_player_in_it() {
    // The request describes the game, but the player asking was not in it:
    // naming them, with their rating and a faction, would send a reviewer to
    // watch an army nobody in the request played.
    let h = harness(vec![foreign(31, "SCMP_009")]);
    h.sign_in().await;
    // No recommendations to wait for: the only replay is someone else's, so
    // the profile is empty by design. The load already waits for the scan.
    h.load().await;

    h.app
        .dispatch(
            TrainingCommand::OpenReview {
                replay_uid: Some(31),
                local_path: None,
            }
            .into(),
        )
        .await
        .unwrap();
    let draft = wait_for_review(&h).await;
    assert_eq!(draft.replay_id, Some(31));
    assert_eq!(draft.map, "Seton's Clutch", "the name, not the folder");
    assert_eq!(draft.player, "");
    assert_eq!(draft.rating, "");
    assert_eq!(draft.faction, "");
}

#[tokio::test]
async fn signing_in_after_the_tab_loaded_brings_the_recommendations_up_to_date() {
    // They used to be computed once, at the end of the load, and signing in
    // later changed nothing until the player pressed refresh.
    let h = harness(vec![local(1, "Setons Clutch", 8, 1, 1150)]);
    h.load().await;
    assert_eq!(h.app.snapshot().training.profile.games_seen, 0);

    h.sign_in().await;
    for _ in 0..400 {
        let training = h.app.snapshot().training;
        if training.profile.player == ME && training.profile.rating.is_some() {
            assert_eq!(training.profile.games_seen, 1);
            assert_eq!(
                training.recommended.first().map(String::as_str),
                Some("setons-eco")
            );
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!(
        "the profile never followed the sign-in: {:?}",
        h.app.snapshot().training.profile
    );
}

#[tokio::test]
async fn a_second_load_while_one_is_running_is_folded_into_it() {
    // The refresh button is live during a load. Pressing it used to repeat
    // every request and the replay scan.
    let calls = Arc::new(AtomicUsize::new(0));
    let h = harness_with(Vec::new(), Arc::new(SlowCatalogue(calls.clone())));
    h.app.dispatch(TrainingCommand::Load.into()).await.unwrap();
    h.load().await;
    // Long enough for a second load, had one started, to have asked too.
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_review_request_named_by_replay_arrives_filled_in() {
    // The whole point of the feature: the player is asked only for the part
    // nobody else can answer.
    let h = harness(vec![local(27_456_965, "Setons Clutch", 8, 3, 1180)]);
    h.sign_in().await;
    h.load().await;

    h.app
        .dispatch(
            TrainingCommand::OpenReview {
                replay_uid: Some(27_456_965),
                local_path: None,
            }
            .into(),
        )
        .await
        .unwrap();

    let draft = wait_for_review(&h).await;
    assert_eq!(draft.replay_id, Some(27_456_965));
    assert_eq!(draft.replay_link, "https://replay.faforever.com/27456965");
    assert_eq!(draft.replay_file, "27456965.fafreplay");
    assert_eq!(draft.player, ME);
    assert_eq!(draft.map, "Setons Clutch");
    assert_eq!(draft.game_mode, "4v4");
    // This account's own row, not the opponent's: reading the wrong row would
    // describe a different player entirely.
    assert_eq!(draft.faction, "Cybran");
    assert_eq!(draft.rating, "1180");
    assert!(
        draft.goal.is_empty(),
        "the question is the player's to write"
    );
}

#[tokio::test]
async fn a_replay_the_client_cannot_find_still_yields_its_id_and_link() {
    // A vault row can scroll out of the loaded page. Losing the id because of
    // that would be worse than a partly filled form.
    let h = harness(Vec::new());
    h.sign_in().await;
    h.load().await;

    h.app
        .dispatch(
            TrainingCommand::OpenReview {
                replay_uid: Some(42),
                local_path: None,
            }
            .into(),
        )
        .await
        .unwrap();

    let draft = wait_for_review(&h).await;
    assert_eq!(draft.replay_id, Some(42));
    assert_eq!(draft.replay_link, "https://replay.faforever.com/42");
    assert!(draft.map.is_empty());
}

#[tokio::test]
async fn composing_records_the_draft_before_writing_the_post_from_it() {
    // The form owns the draft while it is being typed, and hands it over once.
    // The state has to end up agreeing with the post: a preview that described
    // a different request from the one recorded would be the worst of both.
    let h = harness(vec![local(9, "Astro Crater", 2, 1, 900)]);
    h.sign_in().await;
    h.load().await;

    h.app
        .dispatch(
            TrainingCommand::OpenReview {
                replay_uid: Some(9),
                local_path: None,
            }
            .into(),
        )
        .await
        .unwrap();
    let mut draft = wait_for_review(&h).await;
    draft.goal = "Where did I lose the eco lead?".into();
    h.app
        .dispatch(
            TrainingCommand::ComposeReview {
                draft: Box::new(draft),
            }
            .into(),
        )
        .await
        .unwrap();

    for _ in 0..300 {
        if let Some(post) = h.app.snapshot().training.review_post {
            assert_eq!(
                h.app.snapshot().training.review.map(|draft| draft.goal),
                Some("Where did I lose the eco lead?".to_string()),
                "the state records what was composed"
            );
            assert!(post.title.contains(ME));
            assert!(post.body.contains("Astro Crater"));
            assert!(post.body.contains("Where did I lose the eco lead?"));
            // Discord, not the forum: a review request is answered by people
            // in a channel. No URL can prefill a Discord message, so the
            // client writes the request, copies it, and opens the place it is
            // pasted. The seed states no channel, so this falls back to the
            // invite.
            // Discord, not the forum: a review request is answered by people
            // in a channel. No URL can prefill a Discord message, so the client
            // writes the request, copies it, and opens the place it is pasted.
            // The named channel wins over the invite, because landing in the
            // right channel is the whole difference.
            assert_eq!(
                post.url,
                "https://discord.com/channels/197033481883222026/1094904988788080641"
            );
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("the post was never composed");
}

#[tokio::test]
async fn a_kept_contribution_draft_survives_without_composing_anything() {
    // The form sends the draft as it is written so that leaving the form, for
    // the library or another tab, does not throw away what was typed. Keeping
    // it must not compose a post: that is still the author's own step.
    let h = harness(Vec::new());
    h.app
        .dispatch(TrainingCommand::OpenContribution.into())
        .await
        .unwrap();
    let draft = faf_domain::state::ContributionDraft {
        title: "Half a guide".into(),
        body: "Still being written".into(),
        ..faf_domain::state::ContributionDraft::default()
    };
    h.app
        .dispatch(
            TrainingCommand::ChangeContribution {
                draft: Box::new(draft.clone()),
            }
            .into(),
        )
        .await
        .unwrap();

    for _ in 0..300 {
        let training = h.app.snapshot().training;
        if training.contribution.as_ref() == Some(&draft) {
            assert!(
                training.contribution_post.is_none(),
                "keeping a draft composes nothing"
            );
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("the draft was never kept");
}

async fn wait_for_review(h: &Harness) -> faf_domain::state::ReviewRequestDraft {
    for _ in 0..300 {
        if let Some(draft) = h.app.snapshot().training.review {
            return draft;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("the review form never opened");
}
