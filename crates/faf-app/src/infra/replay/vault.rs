//! The remote replay vault: searching it, paging through it, and downloading
//! from it.
//!
//! Separate from the rest of the client because everything here is a request
//! to the FAF API or the replay host, and the API's own limits (its page size,
//! its join aliases, the replay redirect chain) are the rules this has to work
//! around. Turning the documents that come back into rows is `vault_rows`.

use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};

use async_trait::async_trait;
use faf_domain::protocol::replay_query;
use faf_domain::state::{
    sort_vault_replays, LocalReplay, ReplayQuery, ReplaySortField, VaultReplay,
};
use tokio::sync::Mutex;

use crate::infra::jsonapi::{fetch_document, meta_page_i32, total_pages};
use crate::infra::session::TokenStore;
use crate::infra::vault_install::{
    bounded_body_with_progress, validate_origin_url, CallOff, MAX_DOWNLOAD_BYTES,
};
use crate::ports::replay::VaultSearchResult;
use crate::ports::ReplayVaultPort;

use super::library::{local_metadata_for_path, ReplayLibrary};
use super::scfa_header::{map_name_from_replay_head, REPLAY_HEAD_BYTES};
use super::vault_rows::{parse_featured_mods, parse_vault_replays};
use super::ReplayConfig;

/// The three FAF origins the vault talks to. A replay download is allowed to
/// redirect across all three and nowhere else
/// ([`validate_replay_download_url`]).
#[derive(Debug, Clone)]
struct Endpoints {
    /// FAF Data API base, which serves `/data/game` (bearer-token
    /// authenticated) and the `/game/{uid}/replay` hop of a download.
    api_base: String,
    /// Vault replay-file host: `GET {vault_host}/{uid}` starts a download,
    /// unauthenticated.
    vault_host: String,
    /// Public content CDN, where a download ends up.
    content_base: String,
}

impl Endpoints {
    fn from_config(config: &ReplayConfig) -> Self {
        Self {
            api_base: config.api_base.clone(),
            vault_host: config.vault_host.clone(),
            content_base: config.content_base.clone(),
        }
    }
}

/// The online replay vault: searches, featured mods, and replay files.
///
/// Owns what only the vault uses: the two HTTP clients, the download lock and
/// the two search caches. A download that is meant for the local library is
/// written into [`ReplayLibrary`]'s folder; one meant for playback or a detail
/// read goes to the cache, which is the caller's choice
/// ([`Self::download_vault_to`]).
pub struct ReplayVault {
    endpoints: Endpoints,
    tokens: TokenStore,
    http: reqwest::Client,
    /// Replay downloads currently redirect across three FAF origins. This
    /// client does not follow automatically, so each hop can be validated
    /// before the next request is made.
    download_http: reqwest::Client,
    /// Where [`ReplayVaultPort::download_vault`] puts a replay.
    library: ReplayLibrary,
    /// Held while a vault replay is fetched and written. "Load more info" asks
    /// for the details and the analysis at once, and both used to find no
    /// cached file and download the same one side by side: the second
    /// `persist` then tried to replace a file the first reader already had
    /// open, which Windows refuses with "Access is denied". One download at a
    /// time, and the second caller finds the first one's file.
    downloads: Mutex<()>,
    /// The last shared-games intersection and the search that produced it, so
    /// turning a page does not scan every player's history again. Keyed by the
    /// query with its paging normalised away: page and page size change what is
    /// shown, not which games matched.
    ///
    /// It is a snapshot, deliberately: a game played while the user pages
    /// through the results appears on their next search, not underneath them.
    shared_games: std::sync::Mutex<Option<(ReplayQuery, Vec<i32>)>>,
    /// The rows a locally filtered search matched, and the search that produced
    /// them. Keyed the same way as `shared_games`, and there for the same
    /// reason: that scan reads up to `LOCAL_SCAN_PAGES` pages of vault, and
    /// paying for that again on every page turn is what makes paging feel
    /// broken.
    ///
    /// `scanned` is how far into the vault the rows came from, so a later page
    /// that needs more of them knows whether scanning again could produce any.
    local_filtered: std::sync::Mutex<Option<(ReplayQuery, LocalScan)>>,
}

impl ReplayVault {
    pub fn new(config: &ReplayConfig, tokens: TokenStore, library: ReplayLibrary) -> Self {
        Self {
            endpoints: Endpoints::from_config(config),
            tokens,
            http: crate::infra::http::shared_http_client(),
            download_http: crate::infra::http::no_redirect_http_client(),
            library,
            downloads: Mutex::new(()),
            shared_games: std::sync::Mutex::new(None),
            local_filtered: std::sync::Mutex::new(None),
        }
    }
}

#[async_trait]
impl ReplayVaultPort for ReplayVault {
    async fn search_vault(&self, query: ReplayQuery) -> Result<VaultSearchResult, String> {
        self.query_vault(query).await
    }

    async fn list_featured_mods(&self) -> Result<Vec<String>, String> {
        self.query_featured_mods().await
    }

    async fn download_vault(&self, uid: i32) -> Result<LocalReplay, String> {
        self.download_vault_reporting(uid, std::sync::Arc::new(|_, _| {}))
            .await
    }

    async fn download_vault_reporting(
        &self,
        uid: i32,
        progress: std::sync::Arc<dyn Fn(u64, Option<u64>) + Send + Sync>,
    ) -> Result<LocalReplay, String> {
        let path = self
            .download_vault_to(uid, self.library.directory(), &*progress)
            .await?;
        local_metadata_for_path(&path).await
    }

    async fn replay_map_name(&self, uid: i32) -> Result<Option<String>, String> {
        let head = self
            .fetch_vault_replay_bytes(uid, Some(REPLAY_HEAD_BYTES), &|_, _| {})
            .await?;
        Ok(map_name_from_replay_head(&head))
    }
}

const MAX_REPLAY_DOWNLOAD_REDIRECTS: usize = 5;

/// The relationships a vault row needs to render: map, mod, the roster with
/// avatars, the rating changes and the review summary.
const VAULT_INCLUDE: &str = "mapVersion,mapVersion.map,featuredMod,playerStats.player,playerStats.player.avatarAssignments.avatar,playerStats.ratingChanges,reviewsSummary";

/// The largest page the API will actually give an ordinary client.
///
/// `elide.max-page-size` is 10 000 and that is the number the docs show, but
/// the API only lets the scraper role near it: every other request is passed
/// through `ElidePageSizeUtil`, which **rewrites** a larger `page[size]` down
/// to `elide.default-page-size`, currently 100. It is rewritten silently: the
/// response carries no hint that it was, and a page that came back with 100
/// rows on it looks exactly like a page that ran out of vault after 100 rows.
///
/// So this is not a tuning knob. Asking for more than 100 is asking for 100,
/// and any scan that reads "fewer rows than I asked for" as "the end" stops
/// after its first request. That is the bug this constant exists to prevent,
/// and it had already happened once elsewhere in the client: see the same note
/// in `infra::player_card`.
const API_PAGE_SIZE: u32 = 100;

/// The order a locally filtered scan reads the vault in.
///
/// Fixed, and deliberately not the order the results are displayed in. These
/// scans decide *which* games are examined at all, so taking the display order
/// from the user made the sort pick the answer rather than arrange it: ordered
/// by date it examined the newest games and matched some, ordered by review
/// score it examined the best-reviewed ones and matched others. Newest-first is
/// the vault's own order, the one the unfiltered feed already uses, and the
/// only one that means the same thing for every search.
const SCAN_ORDER: &str = "-startTime";

/// How far a locally filtered search reads ahead.
///
/// One of the vault's filters has no clause the API can answer (see
/// `ReplayQuery::accepts_locally`), so rows are dropped after they arrive. One
/// API page therefore does not fill one page of results, and asking for fifty
/// used to hand back however many of those fifty happened to match: six, four,
/// none. This reads further pages until it has enough, which is what anybody
/// expects a page size to mean.
///
/// Bounded, because a filter almost nothing matches would otherwise walk the
/// whole vault one request at a time. Sixteen hundred games is more than enough
/// for a filtered search anybody actually runs, and the ceiling only costs
/// requests when it is reached: a search whose matches turn up early stops at
/// the first page.
const LOCAL_SCAN_PAGES: u32 = 16;

/// The point at which a shared-games scan stops and says so.
///
/// A page budget, because a page is what a request costs and [`API_PAGE_SIZE`]
/// is all the API will put on one: 200 requests, so 20 000 games per account,
/// which is above the busiest account on the server. It bounds a filter that
/// went wrong (a one-letter substring matching thousands of players) rather
/// than trimming a real search, and when it is reached the result says so.
const ID_SCAN_PAGES: usize = 200;

/// How many accounts one shared-games search will look up. A substring name can
/// legitimately match a handful of logins; a two-letter one matches thousands,
/// and scanning all of their histories is not what the user meant.
///
/// One API page, because [`API_PAGE_SIZE`] is as many as one request can return
/// however many are asked for.
const MAX_RESOLVED_PLAYERS: u32 = API_PAGE_SIZE;

/// How large an intersection can be and still be reordered by a sort the scans
/// did not fetch. One request's worth ([`API_PAGE_SIZE`]): beyond it the result
/// stays newest-first, which is what the scans produce anyway.
const MAX_SORTABLE_SHARED_GAMES: usize = API_PAGE_SIZE as usize;

/// Accept only the three replay routes used by FAF's current redirect chain:
/// the public replay endpoint, the Data API handoff, and the content CDN file.
/// All bases remain configurable for local and test environments.
fn validate_replay_download_url(
    url: &url::Url,
    uid: i32,
    config: &Endpoints,
) -> Result<(), String> {
    let uid = uid.to_string();
    let vault_path = format!("/{}", uid);
    let api_path = format!("/game/{uid}/replay");
    let content_file = format!("{uid}.fafreplay");

    let vault = matches_configured_route(url, &config.vault_host, &vault_path, false);
    let api = matches_configured_route(url, &config.api_base, &api_path, false);
    let content = matches_configured_route(
        url,
        &config.content_base,
        &format!("/replays/{content_file}"),
        true,
    );
    if vault || api || content {
        Ok(())
    } else {
        Err("refusing a replay download outside the configured FAF replay endpoints".into())
    }
}

fn matches_configured_route(
    url: &url::Url,
    configured_base: &str,
    route: &str,
    allow_sharded_path: bool,
) -> bool {
    if validate_origin_url(url.as_str(), configured_base).is_err() {
        return false;
    }
    let Ok(base) = url::Url::parse(configured_base) else {
        return false;
    };
    let base_path = base.path().trim_end_matches('/');
    let expected = format!("{base_path}{route}");
    if !allow_sharded_path {
        return url.path() == expected;
    }

    let Some((prefix, file)) = expected.rsplit_once('/') else {
        return false;
    };
    url.path()
        .strip_prefix(&format!("{prefix}/"))
        .is_some_and(|remainder| {
            !remainder.is_empty()
                && remainder.split('/').all(|component| !component.is_empty())
                && remainder.rsplit('/').next() == Some(file)
        })
}

/// The cache key for a shared-games search: everything except which slice of
/// the answer is being displayed.
/// One locally filtered scan: what it matched and how far it got.
#[derive(Clone)]
struct LocalScan {
    matched: Vec<VaultReplay>,
    /// How many API pages were read. Equal to [`LOCAL_SCAN_PAGES`] means there
    /// is no more to be had without raising the ceiling.
    scanned: u32,
    /// The vault ran out before the ceiling did, so `matched` is every match
    /// there is and the totals derived from it are exact.
    exhausted: bool,
}

/// How many pages a locally filtered scan may promise.
///
/// This is the bug that was reported as "many empty pages". The count used to
/// be `max(pages we have, current page + 1)`, on the theory that more matches
/// might be waiting further into the vault. For a filter that matches sparsely
/// they are not: every click added one more page, every one of them empty, and
/// the pager grew for as long as somebody kept clicking.
///
/// A further page is now promised only when the scan stopped **because it had
/// enough**, which is the one case where more is known to be there. Having run
/// into the scan ceiling is not that case: nothing more will be fetched, so
/// nothing more may be offered. Neither is having read the vault to the end.
fn local_filter_total_pages(scan: &LocalScan, page: usize, page_size: usize) -> i32 {
    let full_pages =
        i32::try_from(scan.matched.len().div_ceil(page_size.max(1))).unwrap_or(i32::MAX);
    let stopped_because_it_had_enough = !scan.exhausted
        && scan.scanned < LOCAL_SCAN_PAGES
        && scan.matched.len() >= page * page_size;
    if stopped_because_it_had_enough {
        full_pages.max(i32::try_from(page + 1).unwrap_or(i32::MAX))
    } else {
        full_pages.max(1)
    }
}

fn shared_games_key(query: &ReplayQuery) -> ReplayQuery {
    ReplayQuery {
        page: 1,
        page_size: 0,
        ..query.clone()
    }
}

/// The cache key for a locally filtered scan: everything except which slice of
/// the answer is being displayed **and in what order**.
///
/// The sort is not part of it, because the scan no longer depends on the sort:
/// it always reads the vault newest-first and the chosen order is applied to
/// the rows that matched (`sort_vault_replays`). So changing the sort reuses
/// the scan that is already in hand, which is both instant and the proof that
/// it really is the same set of replays being read two ways.
fn local_filter_key(query: &ReplayQuery) -> ReplayQuery {
    ReplayQuery {
        sort_by: ReplaySortField::default(),
        sort_descending: true,
        ..shared_games_key(query)
    }
}

impl ReplayVault {
    async fn fetch_vault_replay(
        &self,
        uid: i32,
        on_bytes: &(dyn Fn(u64, Option<u64>) + Sync),
    ) -> Result<Vec<u8>, String> {
        self.fetch_vault_replay_bytes(uid, None, on_bytes).await
    }

    /// A vault replay, whole or only its first `head` bytes.
    ///
    /// The vault answers ranges with `206 Partial Content`, and a replay runs
    /// to megabytes of which the head is a few kilobytes: the JSON envelope,
    /// and enough of the compressed stream to decode the strings it opens
    /// with. A server that ignores the range answers `200` with the whole
    /// file, which the same cap bounds, so asking is free either way.
    async fn fetch_vault_replay_bytes(
        &self,
        uid: i32,
        head: Option<u64>,
        on_bytes: &(dyn Fn(u64, Option<u64>) + Sync),
    ) -> Result<Vec<u8>, String> {
        let raw = format!(
            "{}/{}",
            self.endpoints.vault_host.trim_end_matches('/'),
            uid
        );
        let mut url = url::Url::parse(&raw)
            .map_err(|_| "configured FAF replay URL is invalid".to_string())?;

        for redirect_count in 0..=MAX_REPLAY_DOWNLOAD_REDIRECTS {
            validate_replay_download_url(&url, uid, &self.endpoints)?;
            let mut request = self.download_http.get(url.clone());
            if let Some(bytes) = head {
                request = request.header(reqwest::header::RANGE, format!("bytes=0-{}", bytes - 1));
            }
            let response = request
                .send()
                .await
                .map_err(|error| format!("could not download replay {uid}: {error}"))?;
            let status = response.status();
            if status.is_redirection() {
                if redirect_count == MAX_REPLAY_DOWNLOAD_REDIRECTS {
                    return Err(format!(
                        "could not download replay {uid}: too many redirects"
                    ));
                }
                let location = response
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .ok_or_else(|| {
                        format!("could not download replay {uid}: redirect has no location")
                    })?
                    .to_str()
                    .map_err(|_| {
                        format!("could not download replay {uid}: redirect location is invalid")
                    })?;
                url = url.join(location).map_err(|_| {
                    format!("could not download replay {uid}: redirect location is invalid")
                })?;
                continue;
            }
            if !status.is_success() {
                return Err(format!("could not download replay {uid}: {status}"));
            }
            let cap = head.unwrap_or(MAX_DOWNLOAD_BYTES);
            return bounded_body_with_progress(response, &format!("replay {uid}"), cap, on_bytes)
                .await;
        }
        unreachable!("the bounded redirect loop always returns")
    }

    /// Every game the query's players were all in, as one page of results.
    ///
    /// The API cannot answer "A *and* B were in this game" in a single filter:
    /// Elide derives a join alias from the property path alone, so two clauses
    /// on `playerStats.player.login` share one join and match nothing (see
    /// `replay_query`'s module docs). So we ask it one player at a time and
    /// intersect the game ids ourselves.
    ///
    /// Completeness is the point of the feature, so the per-player scans read
    /// *every* page rather than stopping once the current page could be filled:
    /// two players who last met years ago must still show up, and the exact
    /// intersection is what lets the pager offer real page numbers and a real
    /// total. That costs a handful of round trips per search, which is the
    /// trade this was designed around: the intersection is then cached
    /// (`shared_games`) so paging through the results costs one request each,
    /// like any other search.
    ///
    /// The implicit date floor is dropped here for the same reason
    /// ([`ReplayQuery::fallback_months`] exists to keep *unbounded* searches
    /// off the slow path; a login is already a narrow index lookup). Explicit
    /// `after`/`before` bounds still apply.
    async fn search_shared_games(
        &self,
        query: &ReplayQuery,
        token: &str,
    ) -> Result<VaultSearchResult, String> {
        let key = shared_games_key(query);
        let cached = self
            .shared_games
            .lock()
            .expect("shared games cache poisoned")
            .as_ref()
            .filter(|(cached_key, _)| *cached_key == key)
            .map(|(_, ids)| ids.clone());

        let shared = match cached {
            Some(ids) => ids,
            None => {
                let names = query.player_names();
                // Timed at info level, per phase: this search is the one place
                // in the client that can legitimately take seconds, and "which
                // part" is otherwise unanswerable from a bug report.
                let started = std::time::Instant::now();
                let resolved = self
                    .resolve_player_ids(&names, query.exact_player, token)
                    .await?;
                tracing::info!(
                    names = names.len(),
                    exact = query.exact_player,
                    accounts = resolved
                        .as_ref()
                        .map(|r| r.iter().map(Vec::len).sum::<usize>()),
                    elapsed_ms = started.elapsed().as_millis() as u64,
                    "shared games: resolved player names"
                );
                let ids = match resolved {
                    // A name nobody answers to cannot share a game with anyone.
                    None => Vec::new(),
                    Some(per_name) => {
                        let mut per_player = Vec::with_capacity(per_name.len());
                        for player_ids in &per_name {
                            let scan = std::time::Instant::now();
                            let games = self.collect_game_ids(query, player_ids, token).await?;
                            tracing::info!(
                                accounts = player_ids.len(),
                                games = games.len(),
                                elapsed_ms = scan.elapsed().as_millis() as u64,
                                "shared games: scanned one player"
                            );
                            per_player.push(games);
                        }
                        let shared = replay_query::intersect_game_ids(&per_player);
                        let ordered = self.sort_shared_games(query, shared, token).await?;
                        tracing::info!(
                            shared = ordered.len(),
                            elapsed_ms = started.elapsed().as_millis() as u64,
                            "shared games: search complete"
                        );
                        ordered
                    }
                };
                *self
                    .shared_games
                    .lock()
                    .expect("shared games cache poisoned") = Some((key, ids.clone()));
                ids
            }
        };

        let total_records = i32::try_from(shared.len()).unwrap_or(i32::MAX);
        let page_size = query.page_size.max(1);
        let total_pages = i32::try_from(shared.len().div_ceil(page_size as usize))
            .unwrap_or(i32::MAX)
            .max(1);
        let page_ids = replay_query::page_slice(&shared, query.page, page_size);
        let Some(filter) = replay_query::ids_filter(page_ids) else {
            return Ok(VaultSearchResult {
                replays: Vec::new(),
                total_pages: Some(total_pages),
                total_records: Some(total_records),
            });
        };

        // The ids are already the answer; this call only fetches the rows and
        // their relationships. Same `sort` as the scans, so the page arrives in
        // the order the intersection is in.
        let mut url = url::Url::parse(&format!("{}/data/game", self.endpoints.api_base))
            .map_err(|e| format!("invalid API base: {e}"))?;
        url.query_pairs_mut()
            .append_pair("sort", &query.sort_param())
            .append_pair("page[size]", &page_size.to_string())
            .append_pair("include", VAULT_INCLUDE)
            .append_pair("filter", &filter);

        let doc = fetch_document(&self.http, url, token).await?;
        let mut replays = retain_locally_matching(query, parse_vault_replays(&doc));
        if query.sort_by.sorts_locally() {
            sort_vault_replays(&mut replays, query.sort_by, query.sort_descending);
        }
        Ok(VaultSearchResult {
            replays,
            total_pages: Some(total_pages),
            total_records: Some(total_records),
        })
    }

    /// A search whose filters the API cannot express, paged the way a reader
    /// expects.
    ///
    /// Reads API pages from the first one, keeping the rows that survive
    /// `accepts_locally`, until it has enough of them for the page that was
    /// asked for or it runs out of vault or of ceiling
    /// (`LOCAL_SCAN_PAGES` x `API_PAGE_SIZE` games).
    ///
    /// **The page count is the part worth reading twice.** It may only promise
    /// a page this can actually fill. Advertising one more page than there are
    /// matches, on the grounds that more might exist further into the vault,
    /// produces exactly what was reported: a pager that grows by one empty page
    /// every time it is clicked. So a further page is offered only when this
    /// scan stopped because it had enough, which is the one case where more is
    /// known to be waiting.
    ///
    /// Scanning from page one is unavoidable, because the API knows nothing
    /// about these filters and there is no cursor it could resume from. It is
    /// therefore done once per search and cached, the same way the shared-games
    /// intersection next to it is.
    async fn search_locally_filtered(
        &self,
        query: &ReplayQuery,
        token: &str,
    ) -> Result<VaultSearchResult, String> {
        let page_size = query.page_size.max(1) as usize;
        let page = query.page.max(1) as usize;
        let needed = page * page_size;

        let key = local_filter_key(query);
        let cached = self
            .local_filtered
            .lock()
            .expect("local filter cache poisoned")
            .as_ref()
            .filter(|(cached_key, _)| *cached_key == key)
            // Usable when it already holds enough for this page, or when
            // scanning again could not add to it. An order the client applies
            // needs everything the scan can read: the highest rated game can
            // be on its last page.
            .filter(|(_, scan)| {
                scan.exhausted
                    || scan.scanned >= LOCAL_SCAN_PAGES
                    || (!query.sort_by.sorts_locally() && scan.matched.len() >= needed)
            })
            .map(|(_, scan)| scan.clone());

        let scan = match cached {
            Some(scan) => scan,
            None => {
                let scan = self.scan_locally_filtered(query, token, needed).await?;
                *self
                    .local_filtered
                    .lock()
                    .expect("local filter cache poisoned") = Some((key, scan.clone()));
                scan
            }
        };

        let total = i32::try_from(scan.matched.len()).unwrap_or(i32::MAX);
        let total_pages = local_filter_total_pages(&scan, page, page_size);
        let start = (page - 1) * page_size;
        // The scan read them newest-first; this is where the user's own order
        // is applied, to the matches rather than to the vault.
        let mut matched = scan.matched;
        sort_vault_replays(&mut matched, query.sort_by, query.sort_descending);
        let replays = matched
            .into_iter()
            .skip(start)
            .take(page_size)
            .collect::<Vec<_>>();

        Ok(VaultSearchResult {
            replays,
            total_pages: Some(total_pages),
            // Only when it is a real total. A count that means "at least this
            // many" printed as "N replays" is a wrong number, and the view has
            // a shape for not knowing.
            total_records: scan.exhausted.then_some(total),
        })
    }

    /// Read the vault until `needed` rows have matched, or there is no more to
    /// read. See [`Self::search_locally_filtered`] for what the result means.
    async fn scan_locally_filtered(
        &self,
        query: &ReplayQuery,
        token: &str,
        needed: usize,
    ) -> Result<LocalScan, String> {
        let fallback = query.fallback_months().map(months_ago);
        let started = std::time::Instant::now();
        let mut matched: Vec<VaultReplay> = Vec::new();
        // The vault is live and this scan pages by offset, so a game that
        // finishes between two of these requests pushes every later page down
        // by one row and the row on the seam arrives twice. Rare, seconds-wide,
        // and it would show as the same replay listed twice: cheap enough to
        // rule out that anybody has to wonder about it.
        let mut seen: HashSet<i32> = HashSet::new();
        let mut scanned = 0;
        let mut exhausted = false;

        for scan_page in 1..=LOCAL_SCAN_PAGES {
            let mut url = url::Url::parse(&format!("{}/data/game", self.endpoints.api_base))
                .map_err(|e| format!("invalid API base: {e}"))?;
            {
                let mut pairs = url.query_pairs_mut();
                pairs
                    // Newest first, whatever the results are to be *shown*
                    // in. The scan decides which games are examined, and
                    // letting the display order decide that made the sort
                    // change the answer instead of the arrangement: see
                    // `sort_vault_replays`.
                    .append_pair("sort", SCAN_ORDER)
                    .append_pair("page[size]", &API_PAGE_SIZE.to_string())
                    .append_pair("page[number]", &scan_page.to_string())
                    .append_pair("include", VAULT_INCLUDE);
                if let Some(filter) = replay_query::build_filter(query, fallback.as_deref(), None) {
                    pairs.append_pair("filter", &filter);
                }
            }

            let doc = fetch_document(&self.http, url, token).await?;
            let rows = parse_vault_replays(&doc);
            let received = rows.len();
            matched.extend(
                retain_locally_matching(query, rows)
                    .into_iter()
                    .filter(|replay| seen.insert(replay.uid)),
            );
            scanned = scan_page;

            // Only an *empty* page is the end of the results. A short one is
            // not: the API clamps `page[size]` to its own limit without saying
            // so, so "fewer than I asked for" is what every full page looks
            // like. See `API_PAGE_SIZE`.
            if received == 0 {
                exhausted = true;
                break;
            }
            // Enough for the page, unless the order is the client's own: then
            // a row further in can still belong at the top.
            if matched.len() >= needed && !query.sort_by.sorts_locally() {
                break;
            }
        }

        // At info level for the same reason the shared-games scan is: this is
        // one of the two searches in the client that can legitimately take
        // seconds, and "how much vault for how many rows" is otherwise
        // unanswerable from a bug report.
        tracing::info!(
            pages = scanned,
            games = scanned as usize * API_PAGE_SIZE as usize,
            matched = matched.len(),
            exhausted,
            elapsed_ms = started.elapsed().as_millis() as u64,
            "locally filtered vault scan"
        );

        Ok(LocalScan {
            matched,
            scanned,
            exhausted,
        })
    }

    /// The player ids behind each typed name, in the order they were typed.
    ///
    /// One request for all of them. This is what lets the scans filter on
    /// `playerStats.player.id` instead of a login wildcard: see
    /// [`replay_query::build_scan_filter`] for why that is the difference
    /// between seconds and minutes. A substring name can resolve to several
    /// accounts, so each name keeps a *set* of ids.
    ///
    /// `None` means one of the names matches no account at all, which makes the
    /// intersection empty without scanning anything.
    async fn resolve_player_ids(
        &self,
        names: &[&str],
        exact: bool,
        token: &str,
    ) -> Result<Option<Vec<Vec<i32>>>, String> {
        let Some(filter) = replay_query::logins_filter(names, exact) else {
            return Ok(None);
        };
        let mut url = url::Url::parse(&format!("{}/data/player", self.endpoints.api_base))
            .map_err(|e| format!("invalid API base: {e}"))?;
        url.query_pairs_mut()
            .append_pair("filter", &filter)
            .append_pair("fields[player]", "login")
            .append_pair("page[size]", &MAX_RESOLVED_PLAYERS.to_string());

        let doc = fetch_document(&self.http, url, token).await?;
        if doc.data.len() >= MAX_RESOLVED_PLAYERS as usize {
            tracing::warn!(
                resolved = doc.data.len(),
                "a player name matched more accounts than one search resolves;                  narrow it or tick the exact-name box"
            );
        }
        let resolved: Vec<(i32, String)> = doc
            .data
            .iter()
            .filter_map(|player| {
                let id = player.id.parse::<i32>().ok()?;
                let login = player.attributes.get("login")?.as_str()?.to_string();
                Some((id, login))
            })
            .collect();

        let mut per_name = Vec::with_capacity(names.len());
        for name in names {
            let ids: Vec<i32> = resolved
                .iter()
                .filter(|(_, login)| replay_query::login_matches(login, name, exact))
                .map(|(id, _)| *id)
                .collect();
            if ids.is_empty() {
                return Ok(None);
            }
            per_name.push(ids);
        }
        Ok(Some(per_name))
    }

    /// The ids of every game these player ids appear in, newest first.
    ///
    /// Seeks by id rather than asking for page after page: each request carries
    /// the lowest id of the last one, so every page is the same bounded index
    /// range instead of an ever-growing `OFFSET`. Sorted by `-id`, which is the
    /// seek key; game ids and start times run in the same direction, so this is
    /// also the newest-first order the intersection is presented in.
    ///
    /// A sparse fieldset keeps the payload to ids: `startTime` is named only
    /// because a fieldset wants a field, and `infra::player_card` narrows the
    /// same type the same way.
    ///
    /// [`ID_SCAN_PAGES`] is a runaway guard: it sits well above the busiest
    /// account on the server, so a real scan ends when a page comes back empty.
    async fn collect_game_ids(
        &self,
        query: &ReplayQuery,
        player_ids: &[i32],
        token: &str,
    ) -> Result<Vec<i32>, String> {
        let mut ids: Vec<i32> = Vec::new();
        let mut before_id: Option<i32> = None;
        for page_number in 1..=ID_SCAN_PAGES {
            let mut url = url::Url::parse(&format!("{}/data/game", self.endpoints.api_base))
                .map_err(|e| format!("invalid API base: {e}"))?;
            {
                let mut pairs = url.query_pairs_mut();
                pairs
                    .append_pair("sort", "-id")
                    .append_pair("page[size]", &API_PAGE_SIZE.to_string())
                    .append_pair("fields[game]", "startTime");
                if let Some(filter) = replay_query::build_scan_filter(query, player_ids, before_id)
                {
                    pairs.append_pair("filter", &filter);
                }
            }

            let doc = fetch_document(&self.http, url, token).await?;
            let page: Vec<i32> = doc
                .data
                .iter()
                .filter_map(|game| game.id.parse::<i32>().ok())
                .collect();
            let lowest = page.iter().copied().min();
            ids.extend(page);
            match lowest {
                // An empty page is the end; so is a page whose ids cannot be
                // parsed, which would otherwise seek from the same place
                // forever. A *short* page is neither: the API clamps
                // `page[size]` to its own limit and never says it did, so this
                // scan used to stop after one request and hand back the newest
                // hundred games as if they were the player's whole history.
                Some(lowest) => {
                    if page_number == ID_SCAN_PAGES {
                        tracing::warn!(
                            collected = ids.len(),
                            "replay id scan hit its cap; the shared-games result may be incomplete"
                        );
                    }
                    before_id = Some(lowest);
                }
                _ => return Ok(ids),
            }
        }
        Ok(ids)
    }

    /// The intersection in the order the user asked for.
    ///
    /// The scans run newest-first by id, which is already the answer for the
    /// default sort and its reverse. Any other ordering lives in columns the
    /// scan never fetched (duration, title, review score), so the server is
    /// asked to sort the ids it has just been handed: one extra request, and
    /// only when the intersection is small enough to order in a single one.
    async fn sort_shared_games(
        &self,
        query: &ReplayQuery,
        shared: Vec<i32>,
        token: &str,
    ) -> Result<Vec<i32>, String> {
        // An average rating order has nothing the server can sort by: the
        // intersection stays newest first and each page is ordered once its
        // rows are in, which for the few games two players share is usually
        // all of them.
        if query.sort_by.sorts_locally() {
            return Ok(shared);
        }
        let by_id = matches!(
            query.sort_by,
            replay_query::ReplaySortField::StartTime | replay_query::ReplaySortField::Id
        );
        if by_id {
            let mut ordered = shared;
            if !query.sort_descending {
                ordered.reverse();
            }
            return Ok(ordered);
        }
        if shared.len() > MAX_SORTABLE_SHARED_GAMES {
            tracing::warn!(
                shared = shared.len(),
                "too many shared games to reorder in one request; keeping newest first"
            );
            return Ok(shared);
        }
        let Some(filter) = replay_query::ids_filter(&shared) else {
            return Ok(shared);
        };

        let mut url = url::Url::parse(&format!("{}/data/game", self.endpoints.api_base))
            .map_err(|e| format!("invalid API base: {e}"))?;
        url.query_pairs_mut()
            .append_pair("sort", &query.sort_param())
            .append_pair("page[size]", &MAX_SORTABLE_SHARED_GAMES.to_string())
            .append_pair("fields[game]", "startTime")
            .append_pair("filter", &filter);

        let doc = fetch_document(&self.http, url, token).await?;
        let ordered: Vec<i32> = doc
            .data
            .iter()
            .filter_map(|game| game.id.parse::<i32>().ok())
            .collect();
        // Trust the server's order only if it returned the same set; anything
        // else (a dropped row, a page cap) would silently lose results.
        if ordered.len() == shared.len() {
            Ok(ordered)
        } else {
            Ok(shared)
        }
    }

    /// The vault replay `uid` as a file in `directory`, fetched unless it is
    /// already there.
    ///
    /// A vault replay never changes once uploaded, and the file only ever
    /// appears whole (`write_replay_atomically`), so one that exists is the
    /// finished download. Fetching it again would not only waste the
    /// transfer, it would replace a file another command may be reading.
    ///
    /// `on_bytes` hears the bytes received so far and the size the server
    /// declared, once per chunk. Dropping the future calls the download off:
    /// the transfer stops, and a write already on the blocking pool asks
    /// [`CallOff`] before it publishes the file, so a called-off download
    /// leaves no file under the replay's name.
    pub(super) async fn download_vault_to(
        &self,
        uid: i32,
        directory: PathBuf,
        on_bytes: &(dyn Fn(u64, Option<u64>) + Sync),
    ) -> Result<PathBuf, String> {
        let path = directory.join(format!("{uid}.fafreplay"));
        let _download_guard = self.downloads.lock().await;
        if tokio::fs::try_exists(&path).await.unwrap_or(false) {
            return Ok(path);
        }
        let bytes = self.fetch_vault_replay(uid, on_bytes).await?;
        tokio::fs::create_dir_all(&directory)
            .await
            .map_err(|error| format!("could not create replay directory: {error}"))?;
        let write_path = path.clone();
        let call_off = CallOff::default();
        let armed = call_off.arm();
        tokio::task::spawn_blocking(move || {
            write_replay_atomically(&write_path, &bytes, &call_off)
        })
        .await
        .map_err(|error| format!("replay write task failed: {error}"))??;
        armed.disarm();
        Ok(path)
    }

    /// The body of [`ReplayVaultPort::search_vault`].
    async fn query_vault(&self, query: ReplayQuery) -> Result<VaultSearchResult, String> {
        let token = self
            .tokens
            .get()
            .ok_or_else(|| "not logged in".to_string())?;

        // Clamped once, here, so the page arithmetic below and in both scans
        // agrees with what the API will actually send. A larger page size is
        // rewritten server side (see `API_PAGE_SIZE`), so a request for 200
        // returns 100 while the pager still counts in 200s, and half of every
        // result set becomes unreachable.
        let query = ReplayQuery {
            page_size: query.page_size.clamp(1, API_PAGE_SIZE),
            ..query
        };

        // Two or more names is a different question ("games they shared") and
        // needs a different shape of request: see `search_shared_games`.
        if query.player_names().len() > 1 {
            return self.search_shared_games(&query, &token).await;
        }

        // A filter the API cannot express has to be applied to rows that have
        // already arrived, which means one API page is not one page of
        // results: see `search_locally_filtered`.
        if query.needs_local_scan() {
            return self.search_locally_filtered(&query, &token).await;
        }

        let mut url = url::Url::parse(&format!("{}/data/game", self.endpoints.api_base))
            .map_err(|e| format!("invalid API base: {e}"))?;
        {
            let mut pairs = url.query_pairs_mut();
            pairs
                .append_pair("sort", &query.sort_param())
                .append_pair("page[size]", &query.page_size.to_string())
                .append_pair("page[number]", &query.page.max(1).to_string())
                .append_key_only("page[totals]")
                .append_pair("include", VAULT_INCLUDE);
            // The date floor that keeps an otherwise unbounded filtered search
            // off the slow path: the rule lives in the query, the clock here.
            let fallback = query.fallback_months().map(months_ago);
            if let Some(filter) = replay_query::build_filter(&query, fallback.as_deref(), None) {
                pairs.append_pair("filter", &filter);
            }
        }

        let doc = fetch_document(&self.http, url, &token).await?;
        let replays = parse_vault_replays(&doc);
        let total_pages = total_pages(&doc.meta, query.page_size);
        let total_records = meta_page_i32(&doc.meta, "totalRecords");
        Ok(VaultSearchResult {
            replays,
            total_pages,
            total_records,
        })
    }

    /// The body of [`ReplayVaultPort::list_featured_mods`].
    async fn query_featured_mods(&self) -> Result<Vec<String>, String> {
        let token = self
            .tokens
            .get()
            .ok_or_else(|| "not logged in".to_string())?;

        let mut url = url::Url::parse(&format!("{}/data/featuredMod", self.endpoints.api_base))
            .map_err(|e| format!("invalid API base: {e}"))?;
        url.query_pairs_mut()
            .append_pair("page[size]", "100")
            .append_pair("sort", "order");

        let doc = fetch_document(&self.http, url, &token).await?;
        Ok(parse_featured_mods(&doc))
    }
}

/// Write `bytes` under a temporary name beside `path`, then publish it as
/// `path`, unless the download was called off by then: the temporary file is
/// deleted with its handle instead, so the folder never gains the replay.
fn write_replay_atomically(path: &Path, bytes: &[u8], call_off: &CallOff) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "replay path has no parent directory".to_string())?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("could not create temporary replay: {error}"))?;
    temporary
        .write_all(bytes)
        .map_err(|error| format!("could not write replay: {error}"))?;
    temporary
        .flush()
        .map_err(|error| format!("could not flush replay: {error}"))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| format!("could not sync replay: {error}"))?;
    call_off.refuse_if_called_off()?;
    temporary
        .persist(path)
        .map(|_| ())
        .map_err(|error| format!("could not publish replay: {}", error.error))
}

/// An RFC 3339 instant `months` months in the past: the clock half of the
/// query's [`ReplayQuery::fallback_months`] cost guard.
fn months_ago(months: u32) -> String {
    (chrono::Utc::now() - chrono::Months::new(months)).to_rfc3339()
}

/// Drop the rows the API was never asked to exclude.
///
/// One of the vault's filters has no clause the game resource can answer: the
/// number of players who actually took part. It is decided here, on the page
/// that came back, and the rule itself lives in the domain so it is testable
/// without a network.
///
/// This makes a page shorter than the page size, and the view says so. See
/// `ReplayQuery::accepts_locally`.
fn retain_locally_matching(query: &ReplayQuery, replays: Vec<VaultReplay>) -> Vec<VaultReplay> {
    if !query.has_local_filter() {
        return replays;
    }
    replays
        .into_iter()
        .filter(|replay| {
            let players: i32 = replay
                .teams
                .iter()
                .map(|team| i32::try_from(team.players.len()).unwrap_or(i32::MAX))
                .sum();
            query.accepts_locally(players)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::infra::replay::test_support::replay_config;

    fn scan(matched: usize, scanned: u32, exhausted: bool) -> LocalScan {
        LocalScan {
            matched: vec![
                VaultReplay {
                    uid: 1,
                    title: String::new(),
                    map: String::new(),
                    map_thumbnail_url: String::new(),
                    mod_name: String::new(),
                    start_time: String::new(),
                    end_time: String::new(),
                    replay_available: true,
                    duration_seconds: None,
                    game_duration_seconds: None,
                    teams: Vec::new(),
                    average_rating: None,
                    quality: None,
                    reviews_average: None,
                    reviews_count: None,
                    game_version: None,
                    validity: String::new(),
                    victory_condition: String::new(),
                };
                matched
            ],
            scanned,
            exhausted,
        }
    }

    #[test]
    fn a_sparse_filter_never_promises_a_page_it_cannot_fill() {
        // The reported bug. Thirty matches in a scan that hit the ceiling: one
        // page, and clicking it must not conjure a second. The old rule
        // promised `page + 1` unconditionally, so the pager grew by one empty
        // page for as long as somebody kept clicking.
        for page in 1..=3 {
            assert_eq!(
                local_filter_total_pages(&scan(30, LOCAL_SCAN_PAGES, false), page, 50),
                1,
                "page {page}"
            );
        }
    }

    #[test]
    fn a_scan_that_had_enough_offers_the_next_page() {
        // Stopped early because it filled page one, and well short of the
        // ceiling: there is demonstrably more vault to read, so the pager may
        // say so even though only one page of matches is in hand.
        assert_eq!(local_filter_total_pages(&scan(60, 1, false), 1, 50), 2);
        // And once it holds three pages' worth it says three, not two.
        assert_eq!(local_filter_total_pages(&scan(160, 2, false), 1, 50), 4);
    }

    #[test]
    fn an_exhausted_scan_reports_exactly_what_it_found() {
        // The vault ran out, so the count is exact and there is no next page
        // whatever the current one is.
        assert_eq!(local_filter_total_pages(&scan(120, 3, true), 1, 50), 3);
        assert_eq!(local_filter_total_pages(&scan(120, 3, true), 3, 50), 3);
    }

    #[test]
    fn no_matches_at_all_is_still_one_page() {
        // An empty result is one empty page, not zero pages: the pager has to
        // have something to be on.
        assert_eq!(local_filter_total_pages(&scan(0, 4, true), 1, 50), 1);
    }

    #[test]
    fn replay_redirect_chain_accepts_only_the_requested_replay_on_faf_origins() {
        let config = Endpoints::from_config(&replay_config());
        for accepted in [
            "https://replay.faforever.com/27457062",
            "https://api.faforever.com/game/27457062/replay",
            "https://content.faforever.com/replays/27457062.fafreplay",
            "https://content.faforever.com/replays/0/27/45/70/27457062.fafreplay",
        ] {
            let url = url::Url::parse(accepted).unwrap();
            assert!(
                validate_replay_download_url(&url, 27_457_062, &config).is_ok(),
                "expected {accepted} to be accepted"
            );
        }

        for rejected in [
            "https://evil.invalid/replays/27457062.fafreplay",
            "http://replay.faforever.com/27457062",
            "https://user@replay.faforever.com/27457062",
            "https://api.faforever.com/game/1/replay",
            "https://content.faforever.com/maps/27457062.fafreplay",
            "https://content.faforever.com/replays/1.fafreplay",
            "https://content.faforever.com/replays/27457062.fafreplay/extra",
        ] {
            let url = url::Url::parse(rejected).unwrap();
            assert!(
                validate_replay_download_url(&url, 27_457_062, &config).is_err(),
                "expected {rejected} to be rejected"
            );
        }
    }

    #[test]
    fn replay_downloads_are_published_atomically_and_can_be_replaced() {
        let directory = tempfile::tempdir().expect("temporary replay directory");
        let path = directory.path().join("42.fafreplay");

        write_replay_atomically(&path, b"first", &CallOff::default()).unwrap();
        write_replay_atomically(&path, b"second", &CallOff::default()).unwrap();

        assert_eq!(std::fs::read(&path).unwrap(), b"second");
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    /// A download called off while its file was being written: the write on
    /// the blocking pool runs on, and used to publish the replay into the
    /// library regardless. It stops short of publishing now, and its
    /// temporary file goes with it.
    #[test]
    fn a_called_off_download_publishes_nothing() {
        let directory = tempfile::tempdir().expect("temporary replay directory");
        let path = directory.path().join("42.fafreplay");
        let call_off = CallOff::default();
        drop(call_off.arm());

        assert!(write_replay_atomically(&path, b"whole replay", &call_off).is_err());
        assert_eq!(
            std::fs::read_dir(directory.path()).unwrap().count(),
            0,
            "neither the replay nor its temporary file stays"
        );
    }

    /// The reported error: "Load more info" sends the details and the analysis
    /// together, both fetched the same replay, and the second write replaced a
    /// file the first reader held open. A replay already on disk is the
    /// download; nothing is fetched. The client here has no token, so a fetch
    /// would fail the test rather than reach the network.
    #[tokio::test]
    async fn a_vault_replay_on_disk_is_reused_by_every_caller_at_once() {
        let directory = tempfile::tempdir().expect("temporary replay directory");
        let path = directory.path().join("42.fafreplay");
        std::fs::write(&path, b"already here").unwrap();
        let client = ReplayVault::new(
            &replay_config(),
            TokenStore::new(),
            ReplayLibrary::at(directory.path().to_path_buf()),
        );

        let (details, analysis) = tokio::join!(
            client.download_vault_to(42, directory.path().to_path_buf(), &|_, _| {}),
            client.download_vault_to(42, directory.path().to_path_buf(), &|_, _| {}),
        );

        assert_eq!(details.expect("reused"), path);
        assert_eq!(analysis.expect("reused"), path);
        assert_eq!(std::fs::read(&path).unwrap(), b"already here");
    }
}
