//! Training catalogue: a JSON manifest, with the shipped seed as the floor.
//!
//! There is no FAF endpoint for this. The tutorials API carries FAF's guided
//! lessons and nothing else, so the metadata the training hub filters and
//! recommends on (rating bands, maps, topics, levels) has to come from
//! somewhere the training team can edit without a client release. A plain JSON
//! document at a configured URL is that somewhere.
//!
//! Two properties matter more than the fetch itself:
//!
//! 1. **The tab works with no manifest at all.** No URL configured, or the URL
//!    unreachable, and the seed below is used. The catalogue reports which of
//!    the two happened so the UI can say so rather than looking thin for no
//!    stated reason.
//! 2. **A partial manifest is valid.** The document is read through the DTOs at
//!    the bottom of this file, where every field defaults, so a manifest that
//!    states only titles and links loads and one that gains a field this client
//!    does not know about still loads. A manifest is edited by hand, and a
//!    strict parser would turn a typo into an empty tab. The domain type stays
//!    complete: leniency lives at the boundary, not in the state.

use async_trait::async_trait;
use faf_domain::state::{
    hosted_guide, video_still, Trainer, TrainingCatalogue, TrainingKind, TrainingLevel,
    TrainingLinks, TrainingResource, TrainingSource, TrainingTopic, GUIDES_REPO,
};
use serde::Deserialize;

use crate::infra::env_or;
use crate::ports::TrainingPort;

/// The catalogue that ships with the client.
///
/// Parsed rather than written out in Rust so the training team can read and
/// extend it without touching the crate, and so it is the same document shape
/// a remote manifest uses.
const SEED: &str = include_str!("training_catalogue.json");

/// A manifest is a hand-edited document, not a data feed. Anything past this
/// is a wrong URL rather than a large catalogue.
const MAX_MANIFEST_BYTES: usize = 2 * 1024 * 1024;

/// A guide is prose somebody wrote. Anything past this is not one.
const MAX_GUIDE_BYTES: usize = 512 * 1024;

/// The published catalogue.
///
/// The branch is named rather than written as `HEAD`, which was the first
/// choice here and was wrong. `raw.githubusercontent.com` caches its
/// resolution of `HEAD` separately from the file, and that resolution is not
/// bypassed by a changing query parameter, so a `HEAD` URL kept serving a
/// document from before the last commit with no way to ask for a newer one.
/// `main` answers with what the branch actually points at. Surviving a rename
/// of the default branch is worth less than being correct: a rename happens
/// once and is a one-line fix, staleness happens on every commit.
///
/// A request that fails (the repository is empty, the file is not there yet,
/// the machine is offline) falls back to the seed, so pointing at this before
/// it exists costs one failed request per visit and nothing else.
const DEFAULT_MANIFEST: &str =
    "https://raw.githubusercontent.com/FAForeverRustClient/guides/main/catalogue.json";

#[derive(Debug, Clone)]
pub struct TrainingConfig {
    /// Where the manifest lives. Empty means "use only what shipped", which is
    /// what a test or an offline session wants.
    pub manifest_url: String,
    /// The repository whose guides this build will read and render itself,
    /// as `owner/name`.
    ///
    /// The same repository the submission queue commits to, and for the same
    /// reason it is named rather than inferred: a manifest is remote content,
    /// so the addresses in it decide what is *offered*, never what the client
    /// is willing to fetch. Empty turns the reader off, and every entry then
    /// opens in a browser.
    pub guides_repo: String,
}

impl TrainingConfig {
    pub fn faf() -> Self {
        Self {
            manifest_url: env_or("FAF_TRAINING_CATALOGUE_URL", DEFAULT_MANIFEST),
            guides_repo: env_or("FAF_GUIDES_REPO", GUIDES_REPO),
        }
    }
}

/// The manifest URL with a value on it that changes, so the request is not
/// answered from a cache.
///
/// `raw.githubusercontent.com` sends `Cache-Control: max-age=300`, so for five
/// minutes after a commit it keeps serving the previous document. That is
/// invisible and maddening in exactly the case that matters: a maintainer
/// accepts a submission, watches the two commits land, opens the library, and
/// the guide is not there. Nothing is broken and there is nothing to do but
/// wait, which is not something a client should ask of anybody.
///
/// A changing query parameter is a different cache key, so the request reaches
/// the origin. It costs one uncached document of a few kilobytes per load of
/// the tab, which is a fair price for the catalogue being what the repository
/// actually says.
fn uncached(url: &str) -> String {
    if url.is_empty() {
        return String::new();
    }
    let separator = if url.contains('?') { '&' } else { '?' };
    format!("{url}{separator}t={}", crate::services::now_seconds())
}

pub struct TrainingCatalogueClient {
    config: TrainingConfig,
    http: reqwest::Client,
}

impl TrainingCatalogueClient {
    pub fn new(config: TrainingConfig) -> Self {
        Self {
            config,
            http: super::http::shared_http_client(),
        }
    }

    pub fn faf() -> Self {
        Self::new(TrainingConfig::faf())
    }

    async fn fetch(&self) -> Result<TrainingCatalogue, String> {
        let response = self
            .http
            .get(uncached(&self.config.manifest_url))
            .send()
            .await
            .map_err(|error| format!("could not reach the training catalogue: {error}"))?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!("the training catalogue responded with {status}"));
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|error| format!("could not read the training catalogue: {error}"))?;
        if bytes.len() > MAX_MANIFEST_BYTES {
            return Err("the training catalogue document was unexpectedly large".into());
        }
        let mut catalogue = parse_manifest(&bytes, &self.config.guides_repo)?;
        catalogue.source = TrainingSource::Remote;
        // A manifest that omits a destination inherits the shipped one rather
        // than blanking it: the forum categories are the same either way, and
        // losing them would remove the review request the tab exists for.
        fill_missing_links(&mut catalogue, seed_catalogue());
        Ok(catalogue)
    }
}

#[async_trait]
impl TrainingPort for TrainingCatalogueClient {
    async fn list_catalogue(&self) -> Result<TrainingCatalogue, String> {
        if self.config.manifest_url.trim().is_empty() {
            return Ok(seed_catalogue());
        }
        match self.fetch().await {
            Ok(catalogue) => Ok(catalogue),
            Err(reason) => {
                // Not an error the player sees. The tab is a discovery surface;
                // showing the seed is strictly better than showing a failure,
                // and `source` already tells the UI which one it got.
                tracing::warn!(%reason, "falling back to the bundled training catalogue");
                Ok(seed_catalogue())
            }
        }
    }

    async fn read_guide(&self, url: String) -> Result<String, String> {
        let repo = self.config.guides_repo.trim();
        if repo.is_empty() {
            return Err("this build reads no guides of its own".into());
        }
        // The address came out of a manifest, so it is checked before it is
        // used and not after. Anything that is not Markdown in the trusted
        // repository is a link to be opened, never a request to be made.
        let Some(guide) = hosted_guide(&url) else {
            return Err("that guide is not a document this client can read".into());
        };
        if !guide.repository().eq_ignore_ascii_case(repo) {
            return Err(format!(
                "that guide lives in {}, and this client only reads {repo}",
                guide.repository()
            ));
        }

        let response = self
            .http
            .get(uncached(&url))
            .send()
            .await
            .map_err(|error| format!("could not reach the guide: {error}"))?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!("the guide responded with {status}"));
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|error| format!("could not read the guide: {error}"))?;
        if bytes.len() > MAX_GUIDE_BYTES {
            return Err("that guide was unexpectedly large".into());
        }
        String::from_utf8(bytes.to_vec()).map_err(|_| "that guide is not text".into())
    }
}

/// The seed, parsed. A broken seed is a packaging bug, so it fails loudly in
/// tests and degrades to an empty catalogue at runtime rather than panicking in
/// a user's client.
pub fn seed_catalogue() -> TrainingCatalogue {
    match parse_manifest(SEED.as_bytes(), GUIDES_REPO) {
        Ok(mut catalogue) => {
            catalogue.source = TrainingSource::Bundled;
            catalogue
        }
        Err(reason) => {
            tracing::error!(%reason, "the bundled training catalogue does not parse");
            TrainingCatalogue::default()
        }
    }
}

fn parse_manifest(bytes: &[u8], guides_repo: &str) -> Result<TrainingCatalogue, String> {
    let document: ManifestDoc = serde_json::from_slice(bytes)
        .map_err(|error| format!("the training catalogue is not valid JSON: {error}"))?;
    Ok(document.into_catalogue(guides_repo))
}

// -- the manifest document -------------------------------------------------
//
// A separate shape from the domain's, and deliberately so. Everything here is
// optional, unknown keys are ignored, and an entry missing an id is dropped
// rather than sinking the document. Doing that with `#[serde(default)]` on the
// domain type would have made every field of `TrainingResource` optional in the
// generated TypeScript, pushing a hand-edited file's leniency into every
// component that reads a resource.

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct ManifestDoc {
    resources: Vec<ResourceDoc>,
    trainers: Vec<TrainerDoc>,
    links: LinksDoc,
}

impl ManifestDoc {
    fn into_catalogue(self, guides_repo: &str) -> TrainingCatalogue {
        TrainingCatalogue {
            resources: self
                .resources
                .into_iter()
                .filter_map(|resource| resource.into_resource(guides_repo))
                .collect(),
            trainers: self
                .trainers
                .into_iter()
                .filter_map(TrainerDoc::into_trainer)
                .collect(),
            links: self.links.into_links(),
            source: TrainingSource::Bundled,
        }
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct TrainerDoc {
    id: String,
    name: String,
    faf_id: Option<i32>,
    role: String,
    focus: String,
    topics: Vec<TrainingTopic>,
    game_modes: Vec<String>,
    rating_min: Option<i32>,
    rating_max: Option<i32>,
    languages: Vec<String>,
    discord: String,
    note: String,
    avatar_url: String,
    /// Absent means yes. A trainer listed at all is presumed to be coaching;
    /// stepping back is the thing worth writing down.
    #[serde(default = "yes")]
    accepting: bool,
}

fn yes() -> bool {
    true
}

impl TrainerDoc {
    /// A tile needs a name to be worth drawing and an id to be keyed by. The
    /// name doubles as the id when only one was given, because for most
    /// trainers they are the same string anyway.
    fn into_trainer(self) -> Option<Trainer> {
        let name = self.name.trim().to_string();
        let id = if self.id.trim().is_empty() {
            name.to_lowercase()
        } else {
            self.id
        };
        if name.is_empty() || id.is_empty() {
            return None;
        }
        Some(Trainer {
            id,
            name,
            faf_id: self.faf_id,
            role: self.role,
            focus: self.focus,
            topics: self.topics,
            game_modes: self.game_modes,
            rating_min: self.rating_min,
            rating_max: self.rating_max,
            languages: self.languages,
            discord: self.discord,
            note: self.note,
            avatar_url: self.avatar_url,
            accepting: self.accepting,
        })
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct LinksDoc {
    discord_url: String,
    replay_review_channel: String,
    replay_review_url: String,
    replay_review_category: Option<i32>,
    contribute_url: String,
    contribute_category: Option<i32>,
    wiki_url: String,
}

impl LinksDoc {
    fn into_links(self) -> TrainingLinks {
        TrainingLinks {
            discord_url: self.discord_url,
            replay_review_channel: self.replay_review_channel,
            replay_review_url: self.replay_review_url,
            replay_review_category: self.replay_review_category,
            contribute_url: self.contribute_url,
            contribute_category: self.contribute_category,
            wiki_url: self.wiki_url,
        }
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct ResourceDoc {
    id: String,
    image_url: String,
    title: String,
    summary: String,
    kind: Option<TrainingKind>,
    level: Option<TrainingLevel>,
    url: String,
    tutorial_id: Option<i32>,
    author: String,
    rating_min: Option<i32>,
    rating_max: Option<i32>,
    game_modes: Vec<String>,
    topics: Vec<TrainingTopic>,
    maps: Vec<String>,
    factions: Vec<String>,
    duration_minutes: Option<i32>,
    related: Vec<String>,
    approved_by: String,
    updated_at: String,
}

impl ResourceDoc {
    /// An entry with no id or no title is dropped: the id is what `related`
    /// and the recommendation list address it by, and a nameless row is not
    /// something a reader can act on.
    fn into_resource(self, guides_repo: &str) -> Option<TrainingResource> {
        if self.id.trim().is_empty() || self.title.trim().is_empty() {
            return None;
        }
        // Readable here only if the document is Markdown in the repository this
        // build trusts. The manifest does not get a say: it names addresses,
        // and what the client is willing to fetch is the client's decision.
        let readable = !guides_repo.trim().is_empty()
            && hosted_guide(&self.url)
                .is_some_and(|guide| guide.repository().eq_ignore_ascii_case(guides_repo.trim()));
        // A stated picture wins; otherwise a video link implies its own still,
        // which is what turns a catalogue of YouTube guides into a grid worth
        // scanning rather than ten identical marks.
        let image_url = if self.image_url.trim().is_empty() {
            video_still(&self.url)
        } else {
            self.image_url
        };
        Some(TrainingResource {
            id: self.id,
            title: self.title,
            summary: self.summary,
            kind: self.kind.unwrap_or_default(),
            level: self.level,
            image_url,
            url: self.url,
            tutorial_id: self.tutorial_id,
            author: self.author,
            rating_min: self.rating_min,
            rating_max: self.rating_max,
            game_modes: self.game_modes,
            topics: self.topics,
            maps: self.maps,
            factions: self.factions,
            duration_minutes: self.duration_minutes,
            related: self.related,
            approved_by: self.approved_by,
            updated_at: self.updated_at,
            readable,
        })
    }
}

fn fill_missing_links(catalogue: &mut TrainingCatalogue, seed: TrainingCatalogue) {
    let links = &mut catalogue.links;
    if links.replay_review_url.is_empty() {
        links.replay_review_url = seed.links.replay_review_url;
    }
    if links.replay_review_category.is_none() {
        links.replay_review_category = seed.links.replay_review_category;
    }
    if links.contribute_url.is_empty() {
        links.contribute_url = seed.links.contribute_url;
    }
    if links.contribute_category.is_none() {
        links.contribute_category = seed.links.contribute_category;
    }
    if links.wiki_url.is_empty() {
        links.wiki_url = seed.links.wiki_url;
    }
    if links.discord_url.is_empty() {
        links.discord_url = seed.links.discord_url;
    }
    if links.replay_review_channel.is_empty() {
        links.replay_review_channel = seed.links.replay_review_channel;
    }
}

/// Offline and test catalogue: the seed, with nothing fetched.
#[derive(Debug, Clone, Default)]
pub struct FakeTraining;

#[async_trait]
impl TrainingPort for FakeTraining {
    async fn list_catalogue(&self) -> Result<TrainingCatalogue, String> {
        Ok(seed_catalogue())
    }

    async fn read_guide(&self, _url: String) -> Result<String, String> {
        Err("this build fetches nothing".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use faf_domain::state::TrainingLinks;

    #[test]
    fn the_bundled_catalogue_ships_destinations_and_no_content() {
        // What ships is where to go when the manifest cannot be reached: the
        // Discord invite, the forum categories, the wiki. Not guides.
        //
        // It used to carry three resources of its own, and they turned up in
        // the library as though somebody had chosen them. Nobody had: they were
        // the client's own idea of useful links, and no commit to the catalogue
        // could remove them. Everything a player reads now comes from the
        // repository, which is the only place a person decides what belongs.
        let seed = seed_catalogue();
        assert_eq!(seed.source, TrainingSource::Bundled);
        assert!(
            seed.resources.is_empty(),
            "the client ships no training material of its own"
        );
        assert!(!seed.links.discord_url.is_empty());
        assert!(!seed.links.wiki_url.is_empty());
        // The category id is what turns "request a review" into a prefilled
        // post rather than a link to a category page.
        assert!(seed.links.replay_review_category.is_some());
    }

    #[test]
    fn a_trainer_needs_only_a_name_and_is_presumed_to_be_coaching() {
        // The manifest is hand-edited by the training team. Requiring an id
        // and an explicit `accepting` for every tile would be three fields of
        // ceremony per person.
        let catalogue = parse_manifest(
            br#"{"trainers":[
                {"name":"Seraphim-Noob","fafId":101,"ratingMin":1000,"ratingMax":1800},
                {"name":"Stepped back","accepting":false},
                {"role":"has no name"}
            ]}"#,
            GUIDES_REPO,
        )
        .expect("the document loads");

        assert_eq!(
            catalogue
                .trainers
                .iter()
                .map(|trainer| trainer.id.as_str())
                .collect::<Vec<_>>(),
            vec!["seraphim-noob", "stepped back"]
        );
        assert!(catalogue.trainers[0].accepting);
        assert!(catalogue.trainers[0].covers_rating(1200));
        assert!(!catalogue.trainers[1].accepting);
    }

    #[test]
    fn a_manifest_that_states_only_a_title_and_a_link_is_valid() {
        // Manifests are hand-edited. A parser that demanded every field would
        // reject the first thing anyone wrote.
        let catalogue = parse_manifest(
            br#"{"resources":[{"id":"a","title":"T","url":"https://example.invalid/a"}]}"#,
            GUIDES_REPO,
        )
        .expect("a partial manifest loads");
        assert_eq!(catalogue.resources.len(), 1);
        assert_eq!(catalogue.resources[0].kind, TrainingKind::Guide);
        assert!(catalogue.resources[0].topics.is_empty());
        assert_eq!(catalogue.resources[0].summary, "");
    }

    #[test]
    fn a_field_this_client_does_not_know_about_does_not_reject_the_document() {
        let catalogue = parse_manifest(
            br#"{"resources":[{"id":"a","title":"T","futureField":42}],"somethingElse":true}"#,
            GUIDES_REPO,
        )
        .expect("an unknown field is ignored");
        assert_eq!(catalogue.resources.len(), 1);
    }

    #[test]
    fn broken_json_is_reported_rather_than_silently_emptying_the_catalogue() {
        assert!(parse_manifest(b"{not json", GUIDES_REPO).is_err());
    }

    #[test]
    fn an_entry_without_an_id_or_a_title_is_dropped_and_the_rest_still_loads() {
        // One mistyped entry in a hand-edited manifest must not cost the whole
        // catalogue, and an entry nothing can address is not usable anyway.
        let catalogue = parse_manifest(
            br#"{"resources":[
                {"title":"No id"},
                {"id":"no-title"},
                {"id":"fine","title":"Fine"}
            ]}"#,
            GUIDES_REPO,
        )
        .expect("the document loads");
        assert_eq!(
            catalogue
                .resources
                .iter()
                .map(|resource| resource.id.as_str())
                .collect::<Vec<_>>(),
            vec!["fine"]
        );
    }

    #[test]
    fn a_manifest_inherits_the_destinations_it_does_not_state() {
        // A manifest published to add resources should not have to restate the
        // forum categories, and forgetting them must not remove the review
        // request from the tab.
        let mut catalogue = TrainingCatalogue {
            links: TrainingLinks {
                discord_url: "https://discord.example.invalid/faf".into(),
                ..TrainingLinks::default()
            },
            ..TrainingCatalogue::default()
        };
        fill_missing_links(&mut catalogue, seed_catalogue());

        assert_eq!(
            catalogue.links.discord_url,
            "https://discord.example.invalid/faf"
        );
        assert!(catalogue.links.replay_review_category.is_some());
        assert!(!catalogue.links.wiki_url.is_empty());
    }

    #[test]
    fn the_manifest_is_fetched_past_the_cdn_cache() {
        // Without this a maintainer accepts a submission, sees the commits
        // land, and the library does not change for five minutes.
        let url = uncached("https://example.invalid/catalogue.json");
        assert!(url.starts_with("https://example.invalid/catalogue.json?t="));

        // A URL that already carries a query keeps it.
        assert!(uncached("https://example.invalid/c.json?ref=main").contains("?ref=main&t="));

        // Nothing to fetch stays nothing to fetch.
        assert_eq!(uncached(""), "");
    }

    #[test]
    fn the_shipped_manifest_url_points_at_the_catalogue_repository() {
        // Wrong here means every client silently runs on the seed and nobody
        // finds out until somebody asks why the library is short.
        assert_eq!(
            DEFAULT_MANIFEST,
            "https://raw.githubusercontent.com/FAForeverRustClient/guides/main/catalogue.json"
        );
    }

    #[test]
    fn the_seed_names_the_training_community_s_invite() {
        // Hidden rather than guessed when it is absent: the hero draws no
        // Discord button for an empty invite. A manifest may replace it, and
        // inherits this one when it says nothing.
        assert_eq!(
            seed_catalogue().links.discord_url,
            "https://discord.gg/By9tNUAq8B"
        );
    }

    #[tokio::test]
    async fn without_a_configured_manifest_the_port_answers_from_the_seed() {
        let client = TrainingCatalogueClient::new(TrainingConfig {
            manifest_url: String::new(),
            guides_repo: GUIDES_REPO.into(),
        });
        let catalogue = client.list_catalogue().await.unwrap();
        assert_eq!(catalogue.source, TrainingSource::Bundled);
    }

    #[tokio::test]
    async fn an_unreachable_manifest_degrades_to_the_seed_rather_than_failing() {
        let client = TrainingCatalogueClient::new(TrainingConfig {
            manifest_url: "https://catalogue.invalid/training.json".into(),
            guides_repo: GUIDES_REPO.into(),
        });
        let catalogue = client.list_catalogue().await.unwrap();
        assert_eq!(catalogue.source, TrainingSource::Bundled);
    }

    #[tokio::test]
    async fn the_fake_answers_from_the_seed() {
        assert_eq!(
            FakeTraining.list_catalogue().await.unwrap().source,
            TrainingSource::Bundled
        );
    }
}
