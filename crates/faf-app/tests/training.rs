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
use std::sync::Arc;

use async_trait::async_trait;
use faf_app::infra::fake_ports;
use faf_app::ports::{ReplayPort, TrainingPort, TutorialsPort, VaultSearchResult};
use faf_app::{App, Ports};
use faf_domain::state::{
    AuthCommand, LiveReplayTarget, LocalReplay, LocalReplayPlayer, LocalReplayStatus,
    LocalReplayTeam, ReplayQuery, TrainingCatalogue, TrainingCommand, TrainingKind, TrainingLinks,
    TrainingResource, TrainingStatus, Tutorial, TutorialCategory,
};

const ME: &str = "Nuggets";

/// A manifest with one entry aimed squarely at what the replays below say the
/// player has been doing, and one aimed at somebody far stronger.
struct StubCatalogue;

#[async_trait]
impl TrainingPort for StubCatalogue {
    async fn list_catalogue(&self) -> Result<TrainingCatalogue, String> {
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
                },
                LocalReplayPlayer {
                    name: "Someone else".into(),
                    faction: Some(4),
                    rating: Some(2100),
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
    let ports = Ports {
        training: Arc::new(StubCatalogue),
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
        for _ in 0..400 {
            if self.app.snapshot().training.status == TrainingStatus::Ready {
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

async fn wait_for_review(h: &Harness) -> faf_domain::state::ReviewRequestDraft {
    for _ in 0..300 {
        if let Some(draft) = h.app.snapshot().training.review {
            return draft;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("the review form never opened");
}
