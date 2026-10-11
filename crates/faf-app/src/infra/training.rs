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
//!
//!    The same goes for values. A topic, kind or level this client has never
//!    heard of (a newer catalogue, or a typo) drops that one value, and an
//!    entry that cannot be read at all drops that one entry, each with a
//!    warning in the log. It used to sink the whole document, so adding a
//!    topic to the catalogue emptied the tab for every older client.
//! 3. **The last good catalogue survives going offline.** Every manifest that
//!    fetches and parses is written to the cache directory together with its
//!    `ETag`. The next load asks with `If-None-Match`, which costs a 304 and no
//!    body when nothing changed, and a load that cannot reach the manifest at
//!    all shows that copy rather than the seed.

use std::path::{Path, PathBuf};

use async_trait::async_trait;
use faf_domain::state::{
    hosted_guide, hosted_recording, video_still, Trainer, TrainingCatalogue, TrainingKind,
    TrainingLevel, TrainingLinks, TrainingResource, TrainingSource, TrainingTopic, GUIDES_REPO,
};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use crate::infra::{env_or, env_or_disabled};
use crate::ports::TrainingPort;

/// The catalogue that ships with the client.
///
/// A snapshot of the published catalogue, so that a client which has never
/// reached the repository still opens to a library. Parsed rather than written
/// out in Rust so it is the same document a remote manifest is, and can be
/// refreshed by copying the published file over it.
const SEED: &str = include_str!("training_catalogue.json");

/// The last good manifest, under the cache directory.
const CACHE_FILE: &str = "catalogue.json";

/// A manifest is a hand-edited document, not a data feed. Anything past this
/// is a wrong URL rather than a large catalogue.
const MAX_MANIFEST_BYTES: usize = 2 * 1024 * 1024;

/// A guide is prose somebody wrote. Anything past this is not one.
const MAX_GUIDE_BYTES: usize = 512 * 1024;

/// A recorded run is a position sample per second per unit, so it is an order
/// of magnitude larger than prose and still small enough to be a document.
const MAX_RECORDING_BYTES: usize = 8 * 1024 * 1024;

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
/// the machine is offline) falls back to the last copy fetched and then to the
/// seed, so pointing at this before it exists costs one failed request per
/// visit and nothing else.
const DEFAULT_MANIFEST: &str =
    "https://raw.githubusercontent.com/FAForeverRustClient/guides/main/catalogue.json";

#[derive(Debug, Clone)]
pub struct TrainingConfig {
    /// Where the manifest lives. Empty means "use only what shipped", which is
    /// what a test or an offline session wants. `FAF_TRAINING_CATALOGUE_URL`
    /// unset means the published catalogue; set to an empty value, it means
    /// this.
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
    /// Where the last good manifest is kept, so the tab is not empty offline.
    /// `None` keeps nothing, which is what a test wants.
    pub cache_dir: Option<PathBuf>,
}

impl TrainingConfig {
    pub fn faf() -> Self {
        Self {
            // Unlike most `FAF_*` overrides, an empty value is a real answer
            // here: it turns the remote catalogue off.
            manifest_url: env_or_disabled("FAF_TRAINING_CATALOGUE_URL", DEFAULT_MANIFEST),
            guides_repo: env_or("FAF_GUIDES_REPO", GUIDES_REPO),
            cache_dir: super::cache_dir().ok().map(|root| root.join("training")),
        }
    }
}

/// A URL with a value on it that changes, so the request is not answered from
/// a CDN cache.
///
/// `raw.githubusercontent.com` sends `Cache-Control: max-age=300`, so for five
/// minutes after a commit it keeps serving the previous document. That is
/// invisible and maddening in exactly the case that matters: a maintainer
/// accepts a submission, watches the two commits land, opens the library, and
/// the guide is not there.
///
/// Used for the catalogue only when the player presses refresh: an ordinary
/// visit asks with the cached copy's `ETag` instead, which costs nothing when
/// nothing changed and at most five minutes of staleness when something did.
/// Busting the CDN on every open made every visit download the whole document.
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

    /// Ask for the manifest, conditionally when a cached copy names an `ETag`.
    async fn fetch(
        &self,
        refresh: bool,
        cached: Option<&CachedManifest>,
    ) -> Result<Fetched, String> {
        let url = &self.config.manifest_url;
        let mut request = self
            .http
            .get(if refresh { uncached(url) } else { url.clone() });
        if let Some(etag) = cached
            .map(|cached| cached.etag.as_str())
            .filter(|etag| !etag.is_empty())
        {
            request = request.header(reqwest::header::IF_NONE_MATCH, etag);
        }
        let response = request
            .send()
            .await
            .map_err(|error| format!("could not reach the training catalogue: {error}"))?;
        let status = response.status();
        if status == reqwest::StatusCode::NOT_MODIFIED && cached.is_some() {
            return Ok(Fetched::NotModified);
        }
        if !status.is_success() {
            return Err(format!("the training catalogue responded with {status}"));
        }
        let etag = response
            .headers()
            .get(reqwest::header::ETAG)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_string();
        let bytes = response
            .bytes()
            .await
            .map_err(|error| format!("could not read the training catalogue: {error}"))?;
        if bytes.len() > MAX_MANIFEST_BYTES {
            return Err("the training catalogue document was unexpectedly large".into());
        }
        let manifest = String::from_utf8(bytes.to_vec())
            .map_err(|_| "the training catalogue is not text".to_string())?;
        Ok(Fetched::Body { manifest, etag })
    }

    /// The catalogue a manifest describes, with the shipped destinations
    /// filling in whatever it left out.
    fn catalogue_from(
        &self,
        manifest: &str,
        source: TrainingSource,
    ) -> Result<TrainingCatalogue, String> {
        let mut catalogue = parse_manifest(manifest.as_bytes(), &self.config.guides_repo)?;
        catalogue.source = source;
        // A manifest that omits a destination inherits the shipped one rather
        // than blanking it: the forum categories are the same either way, and
        // losing them would remove the review request the tab exists for.
        fill_missing_links(&mut catalogue, seed_catalogue());
        Ok(catalogue)
    }

    /// The cached copy as a catalogue, or the seed when there is none.
    fn offline_catalogue(&self, cached: Option<&CachedManifest>) -> TrainingCatalogue {
        cached
            .and_then(|cached| {
                match self.catalogue_from(&cached.manifest, TrainingSource::Cached) {
                    Ok(catalogue) => Some(catalogue),
                    Err(reason) => {
                        tracing::warn!(%reason, "the cached training catalogue does not parse");
                        None
                    }
                }
            })
            .unwrap_or_else(seed_catalogue)
    }

    fn cache_path(&self) -> Option<PathBuf> {
        self.config
            .cache_dir
            .as_ref()
            .map(|dir| dir.join(CACHE_FILE))
    }
}

/// What a manifest request came back with.
enum Fetched {
    /// The cached copy is still current.
    NotModified,
    Body {
        manifest: String,
        etag: String,
    },
}

/// The last manifest that fetched and parsed, as kept on disk.
///
/// Keyed by the URL it came from, so pointing the client at another catalogue
/// never shows the old one's entries offline, and never sends one document's
/// `ETag` to another.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct CachedManifest {
    url: String,
    etag: String,
    /// The document verbatim, so a newer client reads it with its own rules.
    manifest: String,
}

/// Read the cached manifest for `url`, if there is a readable one.
fn read_cache(path: &Path, url: &str) -> Option<CachedManifest> {
    let bytes = std::fs::read(path).ok()?;
    match serde_json::from_slice::<CachedManifest>(&bytes) {
        Ok(cached) if cached.url == url => Some(cached),
        Ok(_) => None,
        Err(error) => {
            tracing::warn!(%error, ?path, "ignoring an unreadable training catalogue cache");
            None
        }
    }
}

/// Replace the cached manifest in one filesystem operation, so a crash midway
/// leaves the previous copy rather than half of a new one.
fn write_cache(path: &Path, cached: &CachedManifest) -> Result<(), String> {
    use std::io::Write as _;
    let dir = path
        .parent()
        .ok_or_else(|| "the cache path has no directory".to_string())?;
    std::fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    let bytes = serde_json::to_vec(cached).map_err(|error| error.to_string())?;
    let mut temporary = tempfile::NamedTempFile::new_in(dir).map_err(|error| error.to_string())?;
    temporary
        .write_all(&bytes)
        .map_err(|error| error.to_string())?;
    temporary
        .persist(path)
        .map(|_| ())
        .map_err(|error| error.error.to_string())
}

#[async_trait]
impl TrainingPort for TrainingCatalogueClient {
    async fn list_catalogue(&self, refresh: bool) -> Result<TrainingCatalogue, String> {
        if self.config.manifest_url.trim().is_empty() {
            return Ok(seed_catalogue());
        }
        let cache_path = self.cache_path();
        let cached = cache_path
            .as_deref()
            .and_then(|path| read_cache(path, &self.config.manifest_url));

        match self.fetch(refresh, cached.as_ref()).await {
            // The copy on disk is what the repository says right now. `fetch`
            // only reports this when there is a copy, so the seed is a
            // formality.
            Ok(Fetched::NotModified) => Ok(cached
                .and_then(|cached| {
                    self.catalogue_from(&cached.manifest, TrainingSource::Remote)
                        .ok()
                })
                .unwrap_or_else(seed_catalogue)),
            Ok(Fetched::Body { manifest, etag }) => {
                match self.catalogue_from(&manifest, TrainingSource::Remote) {
                    Ok(catalogue) => {
                        // Only a document that parsed replaces the last good
                        // one: a broken commit must not cost the offline copy.
                        if let Some(path) = cache_path.as_deref() {
                            let fresh = CachedManifest {
                                url: self.config.manifest_url.clone(),
                                etag,
                                manifest,
                            };
                            if let Err(reason) = write_cache(path, &fresh) {
                                tracing::warn!(%reason, "could not cache the training catalogue");
                            }
                        }
                        Ok(catalogue)
                    }
                    Err(reason) => {
                        tracing::warn!(%reason, "the published training catalogue does not parse");
                        Ok(self.offline_catalogue(cached.as_ref()))
                    }
                }
            }
            Err(reason) => {
                // Not an error the player sees. The tab is a discovery surface;
                // the last good copy, or failing that the seed, is strictly
                // better than showing a failure, and `source` already tells the
                // UI which one it got.
                tracing::warn!(%reason, "falling back to the cached or bundled training catalogue");
                Ok(self.offline_catalogue(cached.as_ref()))
            }
        }
    }

    async fn read_guide(&self, url: String) -> Result<String, String> {
        self.fetch_document(&url, hosted_guide(&url), MAX_GUIDE_BYTES, "guide")
            .await
    }

    async fn read_recording(&self, url: String) -> Result<String, String> {
        self.fetch_document(
            &url,
            hosted_recording(&url),
            MAX_RECORDING_BYTES,
            "recording",
        )
        .await
    }
}

impl TrainingCatalogueClient {
    /// Fetch one document out of the repository this build trusts.
    ///
    /// The address came out of a manifest, so it is checked before it is used
    /// and not after: `found` is the caller's already-applied shape test, and
    /// this insists the repository is the configured one. Anything else is a
    /// link to be opened, never a request to be made.
    async fn fetch_document(
        &self,
        url: &str,
        found: Option<faf_domain::state::HostedGuide<'_>>,
        max_bytes: usize,
        what: &str,
    ) -> Result<String, String> {
        let repo = self.config.guides_repo.trim();
        if repo.is_empty() {
            return Err(format!("this build reads no {what}s of its own"));
        }
        let Some(document) = found else {
            return Err(format!(
                "that {what} is not a document this client can read"
            ));
        };
        if !document.repository().eq_ignore_ascii_case(repo) {
            return Err(format!(
                "that {what} lives in {}, and this client only reads {repo}",
                document.repository()
            ));
        }

        let response = self
            .http
            .get(uncached(url))
            .send()
            .await
            .map_err(|error| format!("could not reach the {what}: {error}"))?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!("the {what} responded with {status}"));
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|error| format!("could not read the {what}: {error}"))?;
        if bytes.len() > max_bytes {
            return Err(format!("that {what} was unexpectedly large"));
        }
        String::from_utf8(bytes.to_vec()).map_err(|_| format!("that {what} is not text"))
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

/// Read a manifest, losing as little of it as possible.
///
/// Only a document that is not a JSON object at all is an error. Below that,
/// each section and each entry is read on its own, so one entry this client
/// cannot read costs that entry and nothing else.
fn parse_manifest(bytes: &[u8], guides_repo: &str) -> Result<TrainingCatalogue, String> {
    let document: Value = serde_json::from_slice(bytes)
        .map_err(|error| format!("the training catalogue is not valid JSON: {error}"))?;
    let Value::Object(document) = document else {
        return Err("the training catalogue is not a JSON object".into());
    };
    let links = match document.get("links") {
        None | Some(Value::Null) => LinksDoc::default(),
        Some(value) => LinksDoc::deserialize(value).unwrap_or_else(|error| {
            tracing::warn!(%error, "ignoring the training catalogue's links");
            LinksDoc::default()
        }),
    };
    let document = ManifestDoc {
        resources: entries(document.get("resources"), "resource"),
        trainers: entries(document.get("trainers"), "trainer"),
        links,
    };
    Ok(document.into_catalogue(guides_repo))
}

/// Every entry of a list section this client can read.
///
/// An entry that does not deserialize (a number where a list belongs, a list
/// where a name belongs) is skipped with a warning rather than failing the
/// list, and a section that is not a list at all reads as empty.
fn entries<T: DeserializeOwned>(section: Option<&Value>, what: &str) -> Vec<T> {
    match section {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => items
            .iter()
            .enumerate()
            .filter_map(|(index, item)| match T::deserialize(item) {
                Ok(entry) => Some(entry),
                Err(error) => {
                    tracing::warn!(
                        index,
                        %error,
                        "skipping a training catalogue {what} this client cannot read"
                    );
                    None
                }
            })
            .collect(),
        Some(_) => {
            tracing::warn!("the training catalogue's {what} list is not a list");
            Vec::new()
        }
    }
}

/// A value from a closed set this client may not know all of.
///
/// The catalogue is newer than some of the clients reading it, so a topic,
/// kind or level added after this build is the ordinary case, not an error.
/// Anything that is not one of the values this build knows reads as `None`
/// and is logged, and the entry around it still loads.
#[derive(Debug)]
struct Lenient<T>(Option<T>);

impl<T> Default for Lenient<T> {
    fn default() -> Self {
        Self(None)
    }
}

impl<'de, T: DeserializeOwned> Deserialize<'de> for Lenient<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = Value::deserialize(deserializer)?;
        if value.is_null() {
            return Ok(Self(None));
        }
        match serde_json::from_value(value.clone()) {
            Ok(known) => Ok(Self(Some(known))),
            Err(_) => {
                tracing::warn!(%value, "ignoring a training catalogue value this client does not know");
                Ok(Self(None))
            }
        }
    }
}

/// The values of a list this client knows, in the order they were written.
fn known<T>(values: Vec<Lenient<T>>) -> Vec<T> {
    values.into_iter().filter_map(|value| value.0).collect()
}

// -- the manifest document -------------------------------------------------
//
// A separate shape from the domain's, and deliberately so. Everything here is
// optional, unknown keys are ignored, and an entry missing an id is dropped
// rather than sinking the document. Doing that with `#[serde(default)]` on the
// domain type would have made every field of `TrainingResource` optional in the
// generated TypeScript, pushing a hand-edited file's leniency into every
// component that reads a resource.

#[derive(Debug, Default)]
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
    topics: Vec<Lenient<TrainingTopic>>,
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
            topics: known(self.topics),
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
    kind: Lenient<TrainingKind>,
    level: Lenient<TrainingLevel>,
    url: String,
    recording_url: String,
    tutorial_id: Option<i32>,
    author: String,
    rating_min: Option<i32>,
    rating_max: Option<i32>,
    game_modes: Vec<String>,
    topics: Vec<Lenient<TrainingTopic>>,
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
        let trusted = |found: Option<faf_domain::state::HostedGuide<'_>>| {
            !guides_repo.trim().is_empty()
                && found
                    .is_some_and(|doc| doc.repository().eq_ignore_ascii_case(guides_repo.trim()))
        };
        let readable = trusted(hosted_guide(&self.url));
        // Kept only if this build would actually fetch it, so what reaches the
        // UI is either an address the client will read or nothing. A view that
        // has to ask "and is this one allowed" is a view that will forget to.
        let recording_url = if trusted(hosted_recording(&self.recording_url)) {
            self.recording_url
        } else {
            String::new()
        };
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
            // A kind this client does not know reads as the default, which is
            // what an untagged entry is too.
            kind: self.kind.0.unwrap_or_default(),
            level: self.level.0,
            image_url,
            url: self.url,
            tutorial_id: self.tutorial_id,
            author: self.author,
            rating_min: self.rating_min,
            rating_max: self.rating_max,
            game_modes: self.game_modes,
            topics: known(self.topics),
            maps: self.maps,
            factions: self.factions,
            duration_minutes: self.duration_minutes,
            related: self.related,
            approved_by: self.approved_by,
            updated_at: self.updated_at,
            recording_url,
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
    async fn list_catalogue(&self, _refresh: bool) -> Result<TrainingCatalogue, String> {
        Ok(seed_catalogue())
    }

    async fn read_guide(&self, _url: String) -> Result<String, String> {
        Err("this build fetches nothing".into())
    }

    async fn read_recording(&self, _url: String) -> Result<String, String> {
        Err("this build fetches nothing".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use faf_domain::state::TrainingLinks;

    #[test]
    fn the_bundled_catalogue_is_a_snapshot_of_the_published_one() {
        // A first start without a network used to open to an empty library:
        // the seed carried destinations only, and nothing had been cached yet.
        // It is now a copy of the repository's catalogue, so the material in
        // it is still chosen by the people who curate the repository.
        let seed = seed_catalogue();
        assert_eq!(seed.source, TrainingSource::Bundled);
        assert!(
            seed.resources.len() >= 50,
            "the snapshot loads in full: {} entries",
            seed.resources.len()
        );
        // Every entry survived parsing, rather than being skipped as unreadable.
        let document: Value = serde_json::from_str(SEED).unwrap();
        assert_eq!(
            seed.resources.len(),
            document["resources"].as_array().unwrap().len()
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
    fn a_refresh_is_fetched_past_the_cdn_cache() {
        // Without this a maintainer accepts a submission, sees the commits
        // land, presses refresh, and the library does not change for five
        // minutes.
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

    #[test]
    fn a_topic_this_client_does_not_know_drops_that_topic_and_nothing_else() {
        // A newer catalogue adds a topic, or somebody misspells one. Either
        // used to fail the whole document and empty the tab for every client
        // that did not know the word.
        let catalogue = parse_manifest(
            br#"{"resources":[
                {"id":"a","title":"A","topics":["economy","cheese","micro"]},
                {"id":"b","title":"B","kind":"podcast","level":"grandmaster"},
                {"id":"c","title":"C","kind":"video","level":"beginner"}
            ],"trainers":[
                {"name":"Coach","topics":["mindset","scouting"]}
            ]}"#,
            GUIDES_REPO,
        )
        .expect("the document loads");

        assert_eq!(
            catalogue.resources[0].topics,
            vec![TrainingTopic::Economy, TrainingTopic::Micro]
        );
        // An unknown kind is what an untagged entry is; an unknown level is
        // no level.
        assert_eq!(catalogue.resources[1].kind, TrainingKind::Guide);
        assert_eq!(catalogue.resources[1].level, None);
        assert_eq!(catalogue.resources[2].kind, TrainingKind::Video);
        assert_eq!(catalogue.resources[2].level, Some(TrainingLevel::Beginner));
        assert_eq!(catalogue.trainers[0].topics, vec![TrainingTopic::Scouting]);
    }

    #[test]
    fn an_entry_that_cannot_be_read_is_skipped_and_the_rest_still_loads() {
        let catalogue = parse_manifest(
            br#"{"resources":[
                {"id":"bad-band","title":"Bad","ratingMin":"high"},
                {"id":"bad-maps","title":"Bad","maps":"Setons"},
                "not an entry",
                {"id":"fine","title":"Fine"}
            ],"trainers":[{"name":["not","a","name"]},{"name":"Coach"}]}"#,
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
        assert_eq!(catalogue.trainers.len(), 1);
    }

    #[test]
    fn a_malformed_section_reads_as_empty_rather_than_failing_the_document() {
        let catalogue = parse_manifest(
            br#"{"resources":[{"id":"a","title":"A"}],"trainers":{"oops":true},"links":[1,2]}"#,
            GUIDES_REPO,
        )
        .expect("the document loads");
        assert_eq!(catalogue.resources.len(), 1);
        assert!(catalogue.trainers.is_empty());
        assert_eq!(catalogue.links, TrainingLinks::default());
    }

    #[test]
    fn a_document_that_is_not_an_object_is_an_error() {
        assert!(parse_manifest(b"[1,2,3]", GUIDES_REPO).is_err());
    }

    #[test]
    fn an_empty_catalogue_variable_disables_the_remote_catalogue() {
        // Unset is the published catalogue, set to nothing is off, and
        // anything else is where to look.
        assert_eq!(
            super::super::or_disabled(None, DEFAULT_MANIFEST),
            DEFAULT_MANIFEST
        );
        assert_eq!(
            super::super::or_disabled(Some(String::new()), DEFAULT_MANIFEST),
            ""
        );
        assert_eq!(
            super::super::or_disabled(Some("  ".into()), DEFAULT_MANIFEST),
            ""
        );
        assert_eq!(
            super::super::or_disabled(
                Some("https://example.invalid/c.json".into()),
                DEFAULT_MANIFEST
            ),
            "https://example.invalid/c.json"
        );
    }

    fn client(manifest_url: &str, cache_dir: Option<PathBuf>) -> TrainingCatalogueClient {
        TrainingCatalogueClient::new(TrainingConfig {
            manifest_url: manifest_url.into(),
            guides_repo: GUIDES_REPO.into(),
            cache_dir,
        })
    }

    const UNREACHABLE: &str = "https://catalogue.invalid/training.json";

    #[tokio::test]
    async fn without_a_configured_manifest_the_port_answers_from_the_seed() {
        let catalogue = client("", None).list_catalogue(false).await.unwrap();
        assert_eq!(catalogue.source, TrainingSource::Bundled);
    }

    #[tokio::test]
    async fn an_unreachable_manifest_degrades_to_the_seed_rather_than_failing() {
        let catalogue = client(UNREACHABLE, None)
            .list_catalogue(false)
            .await
            .unwrap();
        assert_eq!(catalogue.source, TrainingSource::Bundled);
    }

    #[tokio::test]
    async fn offline_the_last_good_catalogue_is_shown_instead_of_the_seed() {
        let dir = tempfile::tempdir().expect("temporary cache directory");
        let path = dir.path().join(CACHE_FILE);
        write_cache(
            &path,
            &CachedManifest {
                url: UNREACHABLE.into(),
                etag: "\"abc\"".into(),
                manifest: r#"{"resources":[{"id":"kept","title":"Kept"}]}"#.into(),
            },
        )
        .expect("the cache is written");

        let catalogue = client(UNREACHABLE, Some(dir.path().to_path_buf()))
            .list_catalogue(false)
            .await
            .unwrap();
        assert_eq!(catalogue.source, TrainingSource::Cached);
        assert_eq!(catalogue.resources[0].id, "kept");
        // The destinations it did not state still come from the seed.
        assert!(catalogue.links.replay_review_category.is_some());
    }

    #[tokio::test]
    async fn a_cache_from_another_catalogue_is_not_shown() {
        // Pointing the client somewhere else must not show the old
        // catalogue's entries as though they were the new one's.
        let dir = tempfile::tempdir().expect("temporary cache directory");
        write_cache(
            &dir.path().join(CACHE_FILE),
            &CachedManifest {
                url: "https://elsewhere.invalid/catalogue.json".into(),
                etag: String::new(),
                manifest: r#"{"resources":[{"id":"other","title":"Other"}]}"#.into(),
            },
        )
        .expect("the cache is written");

        let catalogue = client(UNREACHABLE, Some(dir.path().to_path_buf()))
            .list_catalogue(false)
            .await
            .unwrap();
        assert_eq!(catalogue.source, TrainingSource::Bundled);
    }

    #[test]
    fn the_cache_round_trips_and_a_damaged_one_is_ignored() {
        let dir = tempfile::tempdir().expect("temporary cache directory");
        let path = dir.path().join("nested").join(CACHE_FILE);
        let cached = CachedManifest {
            url: UNREACHABLE.into(),
            etag: "\"abc\"".into(),
            manifest: "{}".into(),
        };
        write_cache(&path, &cached).expect("the directory is created and the file written");
        assert_eq!(read_cache(&path, UNREACHABLE), Some(cached));

        std::fs::write(&path, b"{half a file").unwrap();
        assert_eq!(read_cache(&path, UNREACHABLE), None);
        assert_eq!(
            read_cache(&dir.path().join("absent.json"), UNREACHABLE),
            None
        );
    }

    #[tokio::test]
    async fn the_fake_answers_from_the_seed() {
        assert_eq!(
            FakeTraining.list_catalogue(false).await.unwrap().source,
            TrainingSource::Bundled
        );
    }
}
