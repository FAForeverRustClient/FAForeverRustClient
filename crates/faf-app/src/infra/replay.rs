//! Real replay client: live spectating and local `.fafreplay` playback.
//!
//! Mirrors the Python client's `fa/replaylivestreamer.py`/`fa/replay.py`.
//!
//! ## Live-watch protocol
//! 1. `GET {user_api}/replay/access` (bearer token) → `{ accessUrl }` (same
//!    endpoint and response shape as the lobby's `/lobby/access`, see
//!    `infra::fetch_access_url`).
//! 2. Open a WebSocket to `accessUrl`; send one binary frame
//!    `G/{uid}/{player}.scfareplay\0` (the player name is irrelevant to the
//!    server, which merges every participant's stream: any non-empty string
//!    works, per the Python client's own comment).
//! 3. Wait for the first binary frame back before launching FA: otherwise FA
//!    connects to an empty stream (same ordering as the Python client).
//! 4. Launch FA with `/replay gpgnet://127.0.0.1:<port>/...` pointed at a
//!    local TCP proxy (mirrors the Java client's `LiveReplayProxyServer`).
//! 5. Once FA connects, feed it WebSocket frames until the connection closes.
//!
//! **Transport: a local TCP proxy, deliberately, not a named pipe.** FA's
//! engine has a confirmed bug: reading a replay's `ScenarioInfo` (game
//! options, often bloated by unused sim-mod options) through a raw TCP/
//! `gpgnet://` socket crashes it with "Premature EOF" once that data exceeds
//! roughly 2047 bytes (FAF Discord/Zulip, Gatsik, Jan 2026). A Windows named
//! pipe avoids that crash: we shipped that fix briefly: but it introduced a
//! worse regression: FA's named-pipe read is a *blocking* call on (what
//! appears to be) its main/render thread, so catching up to a live game's
//! current tick freezes the entire UI rather than just stalling the
//! simulation the way the TCP path does (confirmed both by community reports
//!: Nomander/Nuggets, FAF Discord, Jan 2026: and by reproducing it
//! ourselves). The actual fix for the root cause is upstream, in the FA
//! engine's lobby code (`FAForever/fa#7057`, stripping disabled mods' game
//! options before launch so `ScenarioInfo` never gets oversized in the first
//! place); once that lands, this TCP transport stops hitting the crash for
//! new games entirely, with none of the pipe's freeze downside. Old replays
//! recorded before that fix may still have oversized `ScenarioInfo` and could
//! in principle still hit this crash live-spectating them: but local *file*
//! playback (see below) was never on this code path to begin with: FA reads
//! those directly from disk via `/replay "<path>"`, with no TCP or pipe
//! involved and no size limit or freeze concern either way.
//!
//! ## File playback
//! A `.fafreplay` is a JSON header line + `\n` + a compressed `.scfareplay`
//! sim-command stream. Two body formats exist, both mirrored from the Python
//! client's `uncompress()`: `compression: "zstd"` for vault-downloaded
//! replays, and everything else (in practice `null`: the format
//! `%ProgramData%\FAForever\replays` locally-recorded replays actually use)
//! falls back to base64 wrapping Qt's `qCompress` container (4-byte
//! big-endian length + raw zlib). The decompressed body is written to the
//! cache dir and FA is launched with `/replay "<path>"`.

use std::collections::{hash_map::DefaultHasher, HashMap};
use std::hash::{Hash as _, Hasher as _};
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use faf_domain::protocol::replay_query;
use faf_domain::state::{
    LiveReplayTarget, LocalReplay, LocalReplayPlayer, LocalReplayStatus, LocalReplayTeam, ModType,
    ReplayPlayer, ReplayQuery, ReplayTeam, VaultReplay,
};
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use crate::infra::jsonapi::{
    fetch_document, meta_page_i32, rel_target, rel_targets, resource_index, value_i32, JsonApiDoc,
    JsonApiResource,
};
use crate::infra::session::TokenStore;
use crate::infra::vault_install::{bounded_body, validate_origin_url, MAX_DOWNLOAD_BYTES};
use crate::infra::{
    cache_dir, env_or, fetch_access_url, free_port, game_updater, validated_ws_url,
};
use crate::ports::replay::VaultSearchResult;
use crate::ports::{ProcessPort, ReplayPort};

type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// How long to wait for the replay server's first byte, or for FA to connect
/// to the local TCP proxy, before giving up.
const READY_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_REPLAY_DOWNLOAD_REDIRECTS: usize = 5;

#[derive(Debug, Clone)]
pub struct ReplayConfig {
    /// FAF *user* API base, which serves `/replay/access` (same host as the
    /// lobby's `/lobby/access`, see `LobbyConfig::user_api_base`).
    pub user_api_base: String,
    /// FAF Data API base, which serves `/data/game` (vault listing). Bearer-
    /// token authenticated, unlike the vault download host below.
    pub api_base: String,
    /// Vault replay-file host: `GET {vault_host}/{uid}` downloads a
    /// `.fafreplay` unauthenticated (mirrors the Python client's
    /// `replay_vault/host` setting).
    pub vault_host: String,
    /// Root of the replay game install the version updater targets: two
    /// directories up from `FAF_REPLAY_GAME_PATH` (…/replaydata/bin/FA.exe →
    /// …/replaydata). `None` if `FAF_REPLAY_GAME_PATH` isn't set; version
    /// updates are then skipped (replay launch still proceeds, matching the
    /// existing "the exe path just isn't configured" posture elsewhere).
    pub replay_target_dir: Option<PathBuf>,
    /// The FA executable's filename within the `bin` group, e.g.
    /// `ForgedAlliance.exe`: the file the version updater hex-patches.
    pub exe_name: String,
    /// Public content CDN: `GET {content_base}/maps/{name}.zip` downloads a
    /// map, unauthenticated (mirrors the Python client's `content/host` /
    /// `vault/map_download_url` settings).
    pub content_base: String,
}

impl ReplayConfig {
    pub fn faf() -> Self {
        Self {
            user_api_base: env_or("FAF_USER_API_BASE", "https://user.faforever.com"),
            api_base: env_or("FAF_API_BASE", "https://api.faforever.com"),
            vault_host: env_or("FAF_REPLAY_VAULT_BASE", "https://replay.faforever.com"),
            replay_target_dir: replay_target_dir_from_env(),
            exe_name: env_or("FAF_GAME_EXE_NAME", "ForgedAlliance.exe"),
            content_base: env_or("FAF_CONTENT_BASE", "https://content.faforever.com"),
        }
    }
}

/// Accept only the three replay routes used by FAF's current redirect chain:
/// the public replay endpoint, the Data API handoff, and the content CDN file.
/// All bases remain configurable for local and test environments.
fn validate_replay_download_url(
    url: &url::Url,
    uid: i32,
    config: &ReplayConfig,
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

/// Derives the version updater's target directory from `FAF_REPLAY_GAME_PATH`
/// (…/replaydata/bin/ForgedAlliance.exe → …/replaydata): two `parent()`
/// calls up from the exe. `FAF_REPLAY_UPDATE_DIR` overrides it directly.
fn replay_target_dir_from_env() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("FAF_REPLAY_UPDATE_DIR") {
        if !dir.is_empty() {
            return Some(PathBuf::from(dir));
        }
    }
    let exe = std::env::var("FAF_REPLAY_GAME_PATH").ok()?;
    if exe.is_empty() {
        return None;
    }
    PathBuf::from(exe).parent()?.parent().map(PathBuf::from)
}

pub struct ReplayClient {
    config: ReplayConfig,
    tokens: TokenStore,
    http: reqwest::Client,
    /// Replay downloads currently redirect across three FAF origins. This
    /// client does not follow automatically, so each hop can be validated
    /// before the next request is made.
    download_http: reqwest::Client,
    process: Arc<dyn ProcessPort>,
    /// Playback preparation writes shared cache and preference files. Keep one
    /// launch pipeline active per client so concurrent UI commands cannot race.
    playback_lock: Mutex<()>,
}

impl ReplayClient {
    pub fn new(config: ReplayConfig, tokens: TokenStore, process: Arc<dyn ProcessPort>) -> Self {
        Self {
            config,
            tokens,
            http: super::http::shared_http_client(),
            download_http: super::http::no_redirect_http_client(),
            process,
            playback_lock: Mutex::new(()),
        }
    }

    pub fn faf(tokens: TokenStore, process: Arc<dyn ProcessPort>) -> Self {
        Self::new(ReplayConfig::faf(), tokens, process)
    }

    async fn fetch_vault_replay(&self, uid: i32) -> Result<Vec<u8>, String> {
        let raw = format!("{}/{}", self.config.vault_host.trim_end_matches('/'), uid);
        let mut url = url::Url::parse(&raw)
            .map_err(|_| "configured FAF replay URL is invalid".to_string())?;

        for redirect_count in 0..=MAX_REPLAY_DOWNLOAD_REDIRECTS {
            validate_replay_download_url(&url, uid, &self.config)?;
            let response = self
                .download_http
                .get(url.clone())
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
            return bounded_body(response, &format!("replay {uid}"), MAX_DOWNLOAD_BYTES).await;
        }
        unreachable!("the bounded redirect loop always returns")
    }

    async fn download_vault_to(&self, uid: i32, directory: PathBuf) -> Result<PathBuf, String> {
        let bytes = self.fetch_vault_replay(uid).await?;
        tokio::fs::create_dir_all(&directory)
            .await
            .map_err(|error| format!("could not create replay directory: {error}"))?;
        let path = directory.join(format!("{uid}.fafreplay"));
        let write_path = path.clone();
        tokio::task::spawn_blocking(move || write_replay_atomically(&write_path, &bytes))
            .await
            .map_err(|error| format!("replay write task failed: {error}"))??;
        Ok(path)
    }
}

fn write_replay_atomically(path: &Path, bytes: &[u8]) -> Result<(), String> {
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
    temporary
        .persist(path)
        .map(|_| ())
        .map_err(|error| format!("could not publish replay: {}", error.error))
}

#[async_trait]
impl ReplayPort for ReplayClient {
    async fn watch_live(
        &self,
        target: LiveReplayTarget,
        player: String,
    ) -> Result<Option<String>, String> {
        let _playback_guard = self.playback_lock.lock().await;
        let token = self
            .tokens
            .get()
            .ok_or_else(|| "not logged in".to_string())?;

        let access_url = fetch_access_url(
            &self.http,
            &self.config.user_api_base,
            "/replay/access",
            &token,
        )
        .await?;
        let ws_url = validated_ws_url(&access_url)?;

        // Note: ws_url carries a one-time verify token: never log it verbatim.
        let (ws, _) = tokio_tungstenite::connect_async(ws_url.as_str())
            .await
            .map_err(|e| format!("could not open replay websocket: {e}"))?;
        let (mut write, mut read) = ws.split();

        let handshake = format!("G/{}/{}.scfareplay\0", target.uid, player).into_bytes();
        write
            .send(Message::Binary(handshake))
            .await
            .map_err(|e| format!("replay handshake failed: {e}"))?;

        // Gate FA's launch on the first byte actually arriving, mirroring the
        // Python client: otherwise FA connects to a proxy with nothing behind it.
        let first = wait_for_first_binary(&mut read).await?;

        let port = free_port().ok_or_else(|| "could not reserve a local port".to_string())?;
        let listener = TcpListener::bind(("127.0.0.1", port))
            .await
            .map_err(|e| format!("could not bind local replay proxy: {e}"))?;

        let mod_name = normalize_mod(&target.mod_name);

        // Same gap `play_file` had before it got `ensure_map_available`:
        // live-spectating never staged the game's map at all, so a custom
        // (non-base) map FA can't already find leaves it stuck the same
        // way: confirmed live (`map /maps/hoey.v0002/Hoey.scmap failed.
        // aborting session.`), silently dumping the user back to the main
        // menu with no crash dialog and no error surfaced here either.
        // `target.map` is the FAF technical map name (e.g. `hoey.v0002`),
        // the same shape `ensure_map_available` expects.
        let mut warning = None;
        if let Some(target_dir) = self.config.replay_target_dir.as_deref() {
            if let Err(e) = game_updater::ensure_map_available(
                &self.http,
                &self.config.content_base,
                target_dir,
                &target.map,
            )
            .await
            {
                warning = Some(format!("could not stage map {}: {e}", target.map));
            }
        }

        let log_path = crate::infra::game_logs::next_path("live-replay", Some(target.uid))?;
        let args = vec![
            "/replay".to_string(),
            format!(
                "gpgnet://127.0.0.1:{port}/{}/{player}.SCFAreplay",
                target.uid
            ),
            "/init".to_string(),
            format!("init_{mod_name}.lua"),
            "/nobugreport".to_string(),
            "/log".to_string(),
            log_path.display().to_string(),
            "/replayid".to_string(),
            target.uid.to_string(),
        ];
        self.process.launch_replay(args).await?;

        let (stream, _) = tokio::time::timeout(READY_TIMEOUT, listener.accept())
            .await
            .map_err(|_| "timed out waiting for the game to connect".to_string())?
            .map_err(|e| format!("accept failed: {e}"))?;

        tokio::spawn(relay_session(stream, write, read, first));
        Ok(warning)
    }

    async fn play_file(&self, path: PathBuf) -> Result<Option<String>, String> {
        let _playback_guard = self.playback_lock.lock().await;
        let replay = prepare_scfareplay(&path).await?;
        let mod_name = normalize_mod(&replay.mod_name);
        let mut warning = None;

        if let Some(target_dir) = self.config.replay_target_dir.as_deref() {
            // Old replays embed the exact engine build they need; FA refuses
            // to load one that doesn't match what's installed ("Ack! Unable
            // to load game replay"). Update before every launch: cheap when
            // already current, since files are skipped on a matching MD5
            // (see infra/game_updater.rs). Unlike map staging below, there is
            // no "expected to fail" case here: every replay's embedded
            // version is exact and required, so a failure here is fatal:
            // launching anyway would just reproduce the exact crash this is
            // supposed to prevent, with no diagnostic for the user.
            if let Some(version) = replay.game_version {
                let token = self
                    .tokens
                    .get()
                    .ok_or_else(|| "not logged in".to_string())?;
                game_updater::ensure_game_version(
                    &self.http,
                    &token,
                    &self.config.api_base,
                    &cache_dir()?.join("game_files"),
                    target_dir,
                    &mod_name,
                    version,
                    &self.config.exe_name,
                )
                .await
                .map_err(|e| format!("could not update game to version {version}: {e}"))?;
            }

            // Old replays' init scripts predate the "custom vault path"
            // feature and always search two hardcoded default directories
            // for maps, ignoring the FAF client's configured vault location
            // entirely: a real, community-documented bug (see the plan).
            // Stage the map into both before launch. Unlike the version
            // update above, failure here is *not* fatal: official/base-game
            // maps are never found on the vault CDN and that's expected (see
            // `ensure_map_available`'s docs): but it's surfaced as a
            // warning rather than silently swallowed, since a genuinely
            // missing custom map is exactly what leaves FA stuck on a blank
            // loading screen with no explanation.
            if let Some(map_folder) = &replay.map_folder {
                if let Err(e) = game_updater::ensure_map_available(
                    &self.http,
                    &self.config.content_base,
                    target_dir,
                    map_folder,
                )
                .await
                {
                    warning = Some(format!("could not stage map {map_folder}: {e}"));
                }
            }
        }

        // A replay recorded with sim mods needs those mods active in
        // `game.prefs` at launch. Mirrors the Python client's exact
        // semantics (`fa/check.py::check` → `fa/mods.py::checkMods` →
        // `setActiveMods(mods, keepuimods=True)`), both of which matter:
        // - Only replays that *have* sim mods touch `game.prefs` at all
        //   (`if sim_mods:` in `check()`): an unmodded replay leaves the
        //   user's mod setup completely alone.
        // - `keepuimods=True`: the user's currently-active *UI* mods stay
        //   active; only the sim-mod set is replaced by the replay's own.
        //   UI mods don't affect the simulation, so they can't desync
        //   playback: and silently wiping the user's UI setup (hotbuild,
        //   eco panels, …) on every modded replay is exactly the kind of
        //   surprise the reference client deliberately avoids.
        // Independent of `replay_target_dir`: mods live in the shared,
        // install-independent mods folder/`game.prefs`, same as
        // `infra::mods`'s own posture.
        if !replay.sim_mods.is_empty() {
            match crate::infra::mods::list_installed_dir(&crate::infra::mods::mods_dir()).await {
                Ok(installed) => {
                    let installed_uids: std::collections::HashSet<&str> =
                        installed.iter().map(|m| m.uid.as_str()).collect();
                    let (present, missing): (Vec<_>, Vec<_>) = replay
                        .sim_mods
                        .iter()
                        .partition(|(uid, _)| installed_uids.contains(uid.as_str()));
                    // keepuimods=True: active UI mods first, then the
                    // replay's sim mods (same order Python builds
                    // `keepTheseMods + mods`).
                    let mut active_uids: Vec<String> = installed
                        .iter()
                        .filter(|m| m.enabled && m.mod_type == ModType::Ui)
                        .map(|m| m.uid.clone())
                        .collect();
                    active_uids.extend(present.into_iter().map(|(uid, _)| uid.clone()));
                    if let Err(e) =
                        crate::infra::mods::write_active_mod_uids_to_disk(&active_uids).await
                    {
                        warning = Some(format!("could not set this replay's active mods: {e}"));
                    } else if !missing.is_empty() {
                        let names: Vec<&str> =
                            missing.iter().map(|(_, name)| name.as_str()).collect();
                        warning = Some(format!("missing mod(s): {}", names.join(", ")));
                    }
                }
                Err(e) => warning = Some(format!("could not check installed mods: {e}")),
            }
        }

        let log_path = crate::infra::game_logs::next_path("replay", replay.uid)?;
        let mut args = vec![
            "/replay".to_string(),
            replay.path.display().to_string(),
            "/init".to_string(),
            format!("init_{mod_name}.lua"),
            "/nobugreport".to_string(),
            // Mirrors the Python client passing `/log "<LOG_FILE_REPLAY>"`,
            // without it FA writes no log at all, so a hang like the one
            // this session spent a long time diagnosing blind is otherwise
            // completely opaque (no crash, no stderr, nothing on disk).
            "/log".to_string(),
            log_path.display().to_string(),
        ];
        if let Some(uid) = replay.uid {
            args.push("/replayid".to_string());
            args.push(uid.to_string());
        }
        self.process.launch_replay(args).await?;
        Ok(warning)
    }

    async fn search_vault(&self, query: ReplayQuery) -> Result<VaultSearchResult, String> {
        let token = self
            .tokens
            .get()
            .ok_or_else(|| "not logged in".to_string())?;

        let mut url = url::Url::parse(&format!("{}/data/game", self.config.api_base))
            .map_err(|e| format!("invalid API base: {e}"))?;
        {
            let mut pairs = url.query_pairs_mut();
            pairs
                .append_pair("sort", &query.sort_param())
                .append_pair("page[size]", &query.page_size.to_string())
                .append_pair("page[number]", &query.page.max(1).to_string())
                .append_pair("page[totals]", "true")
                .append_pair(
                    "include",
                    "mapVersion.map,featuredMod,playerStats.player,playerStats.ratingChanges,reviewsSummary",
                );
            // The date floor that keeps an otherwise unbounded filtered search
            // off the slow path: the rule lives in the query, the clock here.
            let fallback = query.fallback_months().map(months_ago);
            if let Some(filter) = replay_query::build_filter(&query, fallback.as_deref()) {
                pairs.append_pair("filter", &filter);
            }
        }

        let doc = fetch_document(&self.http, url, &token).await?;
        let replays = parse_vault_replays(&doc);
        let total_pages = meta_page_i32(&doc.meta, "totalPages");
        let total_records = meta_page_i32(&doc.meta, "totalRecords");
        Ok(VaultSearchResult {
            replays,
            total_pages,
            total_records,
        })
    }

    async fn list_featured_mods(&self) -> Result<Vec<String>, String> {
        let token = self
            .tokens
            .get()
            .ok_or_else(|| "not logged in".to_string())?;

        let mut url = url::Url::parse(&format!("{}/data/featuredMod", self.config.api_base))
            .map_err(|e| format!("invalid API base: {e}"))?;
        url.query_pairs_mut()
            .append_pair("page[size]", "100")
            .append_pair("sort", "order");

        let doc = fetch_document(&self.http, url, &token).await?;
        Ok(parse_featured_mods(&doc))
    }

    async fn watch_vault(&self, uid: i32) -> Result<Option<String>, String> {
        let path = self.download_vault_to(uid, cache_dir()?).await?;
        self.play_file(path).await
    }

    async fn download_vault(&self, uid: i32) -> Result<LocalReplay, String> {
        let path = self.download_vault_to(uid, local_replays_dir()).await?;
        local_metadata_for_path(&path).await
    }

    async fn list_local(&self) -> Result<Vec<LocalReplay>, String> {
        list_local_dir(&local_replays_dir()).await
    }

    async fn delete_local(&self, path: PathBuf) -> Result<(), String> {
        delete_local_file(&local_replays_dir(), &path).await
    }
}

/// Scans `dir` for `.fafreplay` and legacy `.scfareplay` files: the testable body of
/// [`ReplayClient::list_local`], split out so tests don't have to mutate the
/// process-global `FAF_REPLAYS_DIR`/`ALLUSERSPROFILE` env vars.
async fn list_local_dir(dir: &std::path::Path) -> Result<Vec<LocalReplay>, String> {
    let mut entries = match tokio::fs::read_dir(dir).await {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("could not read {}: {e}", dir.display())),
    };

    // Sort by mtime first (cheap: directory metadata only) and cap to the
    // most recent MAX_LOCAL_REPLAYS before reading any file content, so this
    // stays fast regardless of how many replays have piled up.
    let mut files: Vec<(PathBuf, std::time::SystemTime, u64)> = Vec::new();
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|e| format!("could not list {}: {e}", dir.display()))?
    {
        let path = entry.path();
        let is_replay = path.extension().and_then(|e| e.to_str()).is_some_and(|e| {
            e.eq_ignore_ascii_case("fafreplay") || e.eq_ignore_ascii_case("scfareplay")
        });
        if !is_replay {
            continue;
        }
        if let Ok(meta) = entry.metadata().await {
            if let Ok(modified) = meta.modified() {
                files.push((path, modified, meta.len()));
            }
        }
    }
    files.sort_by_key(|f| std::cmp::Reverse(f.1));
    files.truncate(MAX_LOCAL_REPLAYS);

    let mut replays = Vec::with_capacity(files.len());
    for (path, modified, file_size) in files {
        replays.push(read_local_metadata(&path, modified, file_size).await);
    }
    Ok(replays)
}

/// How many of the most-recently-modified local replay files to list (see
/// [`ReplayClient::list_local`]: this bounds the header-read work
/// regardless of how large the shared replay folder has grown).
const MAX_LOCAL_REPLAYS: usize = 100;

/// The shared FAF replay folder every client writes to. Mirrors the Python
/// client's `APPDATA_DIR` (`%ALLUSERSPROFILE%\FAForever` on Windows, falling
/// back to `~/FAForever` elsewhere) plus `/replays`. `FAF_REPLAYS_DIR`
/// overrides it (tests, alternate installs).
pub(crate) fn local_replays_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("FAF_REPLAYS_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    let base = if cfg!(windows) {
        std::env::var("ALLUSERSPROFILE").unwrap_or_else(|_| r"C:\ProgramData".to_string())
    } else {
        std::env::var("HOME").unwrap_or_default()
    };
    PathBuf::from(base).join("FAForever").join("replays")
}

fn unix_seconds(time: std::time::SystemTime) -> u32 {
    time.duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs().min(u32::MAX as u64) as u32)
        .unwrap_or_default()
}

fn replay_uid(header: &Value, file_name: &str) -> Option<i32> {
    header
        .get("uid")
        .and_then(Value::as_i64)
        .and_then(|value| i32::try_from(value).ok())
        .or_else(|| {
            let digits: String = file_name.chars().take_while(char::is_ascii_digit).collect();
            digits.parse().ok()
        })
}

fn local_teams(header: &Value) -> Vec<LocalReplayTeam> {
    header
        .get("teams")
        .and_then(Value::as_object)
        .map(|teams| {
            teams
                .iter()
                .filter_map(|(team, players)| {
                    let players: Vec<LocalReplayPlayer> = players
                        .as_array()?
                        .iter()
                        .filter_map(Value::as_str)
                        .map(|name| LocalReplayPlayer {
                            name: name.to_string(),
                            faction: None,
                            rating: None,
                        })
                        .collect();
                    (!players.is_empty()).then(|| LocalReplayTeam {
                        team: team.clone(),
                        players,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn local_sim_mods(header: &Value) -> Vec<String> {
    header
        .get("sim_mods")
        .and_then(Value::as_object)
        .map(|mods| {
            mods.values()
                .filter_map(|value| {
                    value
                        .as_str()
                        .or_else(|| value.get("name").and_then(Value::as_str))
                })
                .map(String::from)
                .collect()
        })
        .unwrap_or_default()
}

const LOCAL_REPLAY_BODY_PREFIX_BYTES: u64 = 512 * 1024;
const LOCAL_REPLAY_BODY_READ_BYTES: usize = 4 * 1024 * 1024;

/// Read the compact FA replay header from a compressed local replay body. The
/// JSON envelope has player names, but faction and displayed rating are stored
/// in the binary Lua army table that follows it.
fn local_body_player_stats(
    body: &[u8],
    compression: &str,
) -> HashMap<String, (Option<i32>, Option<i32>)> {
    let prefix = if compression.eq_ignore_ascii_case("zstd") {
        zstd::stream::read::Decoder::new(body)
            .map(read_replay_body_prefix)
            .unwrap_or_default()
    } else {
        let mut decoded =
            base64::read::DecoderReader::new(body, &base64::engine::general_purpose::STANDARD);
        let mut uncompressed_size = [0; 4];
        if decoded.read_exact(&mut uncompressed_size).is_err() {
            return HashMap::new();
        }
        read_replay_body_prefix(flate2::read::ZlibDecoder::new(decoded))
    };
    if prefix.is_empty() {
        return HashMap::new();
    }
    parse_local_body_player_stats(&prefix)
}

fn read_replay_body_prefix(mut reader: impl Read) -> Vec<u8> {
    let mut prefix = Vec::new();
    let mut chunk = [0_u8; 16 * 1024];
    while prefix.len() < LOCAL_REPLAY_BODY_PREFIX_BYTES as usize {
        let remaining = LOCAL_REPLAY_BODY_PREFIX_BYTES as usize - prefix.len();
        let size = remaining.min(chunk.len());
        match reader.read(&mut chunk[..size]) {
            Ok(0) | Err(_) => break,
            Ok(read) => prefix.extend_from_slice(&chunk[..read]),
        }
    }
    prefix
}

fn parse_local_body_player_stats(body: &[u8]) -> HashMap<String, (Option<i32>, Option<i32>)> {
    let mut cursor = Cursor::new(body);
    let Some(_) = replay_string(&mut cursor) else {
        return HashMap::new();
    };
    if !skip_replay_bytes(&mut cursor, 3) {
        return HashMap::new();
    }
    let Some(_) = replay_string(&mut cursor) else {
        return HashMap::new();
    };
    if !skip_replay_bytes(&mut cursor, 4) {
        return HashMap::new();
    }
    let Some(_) = replay_u32(&mut cursor) else {
        return HashMap::new();
    };
    if parse_replay_lua(&mut cursor, 0).is_none() {
        return HashMap::new();
    }
    let Some(_) = replay_u32(&mut cursor) else {
        return HashMap::new();
    };
    if parse_replay_lua(&mut cursor, 0).is_none() {
        return HashMap::new();
    }

    let Some(source_count) = replay_u8(&mut cursor) else {
        return HashMap::new();
    };
    let mut sources = Vec::with_capacity(source_count as usize);
    for _ in 0..source_count {
        let Some(name) = replay_string(&mut cursor) else {
            return HashMap::new();
        };
        let Some(_) = replay_u32(&mut cursor) else {
            return HashMap::new();
        };
        sources.push(name);
    }
    if replay_u8(&mut cursor).is_none() {
        return HashMap::new();
    }
    let Some(army_count) = replay_u8(&mut cursor) else {
        return HashMap::new();
    };
    let mut stats = HashMap::new();
    for _ in 0..army_count {
        if replay_u32(&mut cursor).is_none() {
            break;
        }
        let Some(Value::Object(data)) = parse_replay_lua(&mut cursor, 0) else {
            break;
        };
        let Some(source) = replay_u8(&mut cursor) else {
            break;
        };
        if source != u8::MAX {
            let _ = replay_u8(&mut cursor);
        }
        let name = data
            .get("PlayerName")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| sources.get(source as usize).cloned());
        let Some(name) = name else { continue };
        let faction = data.get("Faction").and_then(replay_i32_value);
        let rating = replay_displayed_rating(&data);
        stats.insert(name, (faction, rating));
    }
    stats
}

fn replay_u8(cursor: &mut Cursor<&[u8]>) -> Option<u8> {
    let mut value = [0; 1];
    Read::read_exact(cursor, &mut value).ok()?;
    Some(value[0])
}

fn replay_u32(cursor: &mut Cursor<&[u8]>) -> Option<u32> {
    let mut value = [0; 4];
    Read::read_exact(cursor, &mut value).ok()?;
    Some(u32::from_le_bytes(value))
}

fn skip_replay_bytes(cursor: &mut Cursor<&[u8]>, count: u64) -> bool {
    cursor.set_position(cursor.position().saturating_add(count));
    cursor.position() <= cursor.get_ref().len() as u64
}

fn replay_string(cursor: &mut Cursor<&[u8]>) -> Option<String> {
    let start = cursor.position() as usize;
    let rest = cursor.get_ref().get(start..)?;
    let end = rest.iter().position(|byte| *byte == 0)?;
    cursor.set_position((start + end + 1) as u64);
    Some(String::from_utf8_lossy(&rest[..end]).into_owned())
}

fn parse_replay_lua(cursor: &mut Cursor<&[u8]>, depth: u8) -> Option<Value> {
    if depth > 64 {
        return None;
    }
    match replay_u8(cursor)? {
        0 => {
            let mut bytes = [0; 4];
            Read::read_exact(cursor, &mut bytes).ok()?;
            serde_json::Number::from_f64(f32::from_le_bytes(bytes) as f64).map(Value::Number)
        }
        1 => Some(Value::String(replay_string(cursor)?)),
        2 => {
            replay_u8(cursor)?;
            Some(Value::Null)
        }
        3 => Some(Value::Bool(replay_u8(cursor)? != 0)),
        4 => {
            let mut object = serde_json::Map::new();
            loop {
                let next = *cursor.get_ref().get(cursor.position() as usize)?;
                if next == 5 {
                    cursor.set_position(cursor.position() + 1);
                    break;
                }
                let key = parse_replay_lua_with_type(cursor, depth + 1, next)?;
                let value = parse_replay_lua(cursor, depth + 1)?;
                let key = key
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| key.to_string());
                object.insert(key, value);
            }
            Some(Value::Object(object))
        }
        _ => None,
    }
}

fn parse_replay_lua_with_type(cursor: &mut Cursor<&[u8]>, depth: u8, kind: u8) -> Option<Value> {
    cursor.set_position(cursor.position() + 1);
    match kind {
        0 => {
            let mut bytes = [0; 4];
            Read::read_exact(cursor, &mut bytes).ok()?;
            serde_json::Number::from_f64(f32::from_le_bytes(bytes) as f64).map(Value::Number)
        }
        1 => Some(Value::String(replay_string(cursor)?)),
        2 => {
            replay_u8(cursor)?;
            Some(Value::Null)
        }
        3 => Some(Value::Bool(replay_u8(cursor)? != 0)),
        4 => {
            cursor.set_position(cursor.position() - 1);
            parse_replay_lua(cursor, depth)
        }
        _ => None,
    }
}

fn replay_i32_value(value: &Value) -> Option<i32> {
    value
        .as_f64()
        .and_then(|number| i32::try_from(number.round() as i64).ok())
}

fn replay_displayed_rating(data: &serde_json::Map<String, Value>) -> Option<i32> {
    let mean = data.get("MEAN").and_then(Value::as_f64)?;
    let deviation = data.get("DEV").and_then(Value::as_f64)?;
    let rating = (mean - 3.0 * deviation).round();
    (rating.is_finite() && rating >= f64::from(i32::MIN) && rating <= f64::from(i32::MAX))
        .then_some(rating as i32)
}

fn empty_local_replay(
    path: &std::path::Path,
    modified: std::time::SystemTime,
    file_size: u64,
    status: LocalReplayStatus,
    watchable: bool,
) -> LocalReplay {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("replay")
        .to_string();
    let title = path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("Replay")
        .to_string();
    LocalReplay {
        path: path.display().to_string(),
        file_name,
        uid: None,
        map: String::new(),
        mod_name: guess_mod_from_filename(path),
        title,
        recorder: String::new(),
        start_time: None,
        modified_time: unix_seconds(modified),
        file_size_bytes: file_size.min(u32::MAX as u64) as u32,
        num_players: 0,
        teams: Vec::new(),
        average_rating: None,
        sim_mods: Vec::new(),
        status,
        watchable,
    }
}

/// Read the `.fafreplay` JSON envelope and compact binary body header. Bad and
/// incomplete files remain represented so the UI can explain them rather than
/// silently making files disappear from the archive.
async fn read_local_metadata(
    path: &std::path::Path,
    modified: std::time::SystemTime,
    file_size: u64,
) -> LocalReplay {
    let is_legacy = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("scfareplay"));
    if is_legacy {
        return empty_local_replay(path, modified, file_size, LocalReplayStatus::Legacy, true);
    }

    let mut file = match tokio::fs::File::open(path).await {
        Ok(file) => file,
        Err(_) => {
            return empty_local_replay(path, modified, file_size, LocalReplayStatus::Broken, false)
        }
    };
    let mut buf = vec![0u8; 64 * 1024];
    let n: usize = file.read(&mut buf).await.unwrap_or_default();
    buf.truncate(n);
    let Some(nl) = buf.iter().position(|&byte| byte == b'\n') else {
        return empty_local_replay(path, modified, file_size, LocalReplayStatus::Broken, false);
    };
    let Ok(header) = serde_json::from_slice::<Value>(&buf[..nl]) else {
        return empty_local_replay(path, modified, file_size, LocalReplayStatus::Broken, false);
    };
    let mut body = buf[nl + 1..].to_vec();
    if body.len() < LOCAL_REPLAY_BODY_READ_BYTES {
        let mut remainder = Vec::new();
        let remaining = (LOCAL_REPLAY_BODY_READ_BYTES - body.len()) as u64;
        let _ = file.take(remaining).read_to_end(&mut remainder).await;
        body.extend_from_slice(&remainder);
    }
    let compression = header
        .get("compression")
        .and_then(Value::as_str)
        .unwrap_or("");
    let player_stats = local_body_player_stats(&body, compression);
    let mut teams = local_teams(&header);
    for team in &mut teams {
        for player in &mut team.players {
            if let Some((faction, rating)) = player_stats.get(&player.name) {
                player.faction = *faction;
                player.rating = *rating;
            }
        }
    }
    let ratings: Vec<i32> = teams
        .iter()
        .filter(|team| team.team != "-1" && team.team != "null")
        .flat_map(|team| &team.players)
        .filter_map(|player| player.rating)
        .collect();
    let average_rating =
        (!ratings.is_empty()).then(|| ratings.iter().sum::<i32>() / ratings.len() as i32);
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("replay.fafreplay")
        .to_string();
    let team_player_count = teams
        .iter()
        .filter(|team| team.team != "-1" && team.team != "null")
        .map(|team| team.players.len() as i32)
        .sum();
    let start_time = header
        .get("launched_at")
        .or_else(|| header.get("game_time"))
        .and_then(Value::as_f64)
        .filter(|value| *value > 0.0)
        .map(|value| value.min(u32::MAX as f64).round() as u32);

    LocalReplay {
        path: path.display().to_string(),
        file_name: file_name.clone(),
        uid: replay_uid(&header, &file_name),
        map: header
            .get("mapname")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        mod_name: header
            .get("featured_mod")
            .and_then(Value::as_str)
            .unwrap_or("faf")
            .to_string(),
        title: header
            .get("title")
            .and_then(Value::as_str)
            .filter(|title| !title.is_empty())
            .unwrap_or_else(|| {
                path.file_stem()
                    .and_then(|name| name.to_str())
                    .unwrap_or("Replay")
            })
            .to_string(),
        recorder: header
            .get("recorder")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        start_time,
        modified_time: unix_seconds(modified),
        file_size_bytes: file_size.min(u32::MAX as u64) as u32,
        num_players: header
            .get("num_players")
            .and_then(Value::as_i64)
            .and_then(|value| i32::try_from(value).ok())
            .filter(|value| *value >= 0)
            .unwrap_or(team_player_count),
        teams,
        average_rating,
        sim_mods: local_sim_mods(&header),
        status: if header
            .get("complete")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            LocalReplayStatus::Complete
        } else {
            LocalReplayStatus::Incomplete
        },
        watchable: true,
    }
}

async fn local_metadata_for_path(path: &Path) -> Result<LocalReplay, String> {
    let metadata = tokio::fs::metadata(path)
        .await
        .map_err(|error| format!("could not inspect downloaded replay: {error}"))?;
    let modified = metadata.modified().unwrap_or(std::time::UNIX_EPOCH);
    Ok(read_local_metadata(path, modified, metadata.len()).await)
}

async fn resolve_local_replay_file(dir: &Path, path: &Path) -> Result<PathBuf, String> {
    let canonical_dir = tokio::fs::canonicalize(dir)
        .await
        .map_err(|error| format!("could not resolve replay folder: {error}"))?;
    let canonical_path = tokio::fs::canonicalize(path)
        .await
        .map_err(|error| format!("could not resolve replay file: {error}"))?;
    let valid_extension = canonical_path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("fafreplay")
                || extension.eq_ignore_ascii_case("scfareplay")
        });
    if canonical_path.parent() != Some(canonical_dir.as_path()) || !valid_extension {
        return Err("refusing to access a file outside the replay folder".to_string());
    }
    Ok(canonical_path)
}

/// Resolve a local-library replay for a narrowly scoped desktop-shell action.
/// The canonical parent and extension checks are shared with deletion so the
/// webview cannot use "Show in folder" as a generic filesystem browser.
pub async fn validated_local_replay_path(path: &Path) -> Result<PathBuf, String> {
    resolve_local_replay_file(&local_replays_dir(), path).await
}

async fn delete_local_file(dir: &std::path::Path, path: &std::path::Path) -> Result<(), String> {
    let canonical_path = resolve_local_replay_file(dir, path).await?;
    tokio::fs::remove_file(&canonical_path)
        .await
        .map_err(|e| format!("could not delete replay: {e}"))
}

/// `game.relationships.mapVersion -> mapVersion.relationships.map -> map.attributes.displayName`.
fn resolve_map_name(
    relationships: &Value,
    index: &HashMap<(String, String), &JsonApiResource>,
) -> String {
    rel_target(relationships, "mapVersion")
        .and_then(|k| index.get(&k))
        .and_then(|mv| rel_target(&mv.relationships, "map"))
        .and_then(|k| index.get(&k))
        .and_then(|m| m.attributes.get("displayName"))
        .and_then(Value::as_str)
        .unwrap_or("unknown map")
        .to_string()
}

/// `game.relationships.featuredMod -> featuredMod.attributes.technicalName`.
fn resolve_mod_name(
    relationships: &Value,
    index: &HashMap<(String, String), &JsonApiResource>,
) -> String {
    rel_target(relationships, "featuredMod")
        .and_then(|k| index.get(&k))
        .and_then(|m| m.attributes.get("technicalName"))
        .and_then(Value::as_str)
        .unwrap_or("faf")
        .to_string()
}

/// `game.relationships.mapVersion -> mapVersion.attributes.thumbnailUrlSmall`.
/// Same relationship chain as [`resolve_map_name`], but reads straight off
/// the `mapVersion` resource rather than following into `map`: mirrors
/// `infra::maps`'s exact attribute name for map thumbnails.
fn resolve_map_thumbnail(
    relationships: &Value,
    index: &HashMap<(String, String), &JsonApiResource>,
) -> String {
    rel_target(relationships, "mapVersion")
        .and_then(|k| index.get(&k))
        .and_then(|mv| mv.attributes.get("thumbnailUrlSmall"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

/// `game.relationships.playerStats[] -> playerStats.relationships.player ->
/// player.attributes.login`, grouped by `playerStats.attributes.team`.
///
fn resolve_teams(
    relationships: &Value,
    index: &HashMap<(String, String), &JsonApiResource>,
) -> Vec<ReplayTeam> {
    let mut by_team: HashMap<i32, Vec<ReplayPlayer>> = HashMap::new();
    for key in rel_targets(relationships, "playerStats") {
        let Some(stat) = index.get(&key) else {
            continue;
        };
        let team = stat
            .attributes
            .get("team")
            .and_then(team_value)
            .unwrap_or(0);
        let name = rel_target(&stat.relationships, "player")
            .and_then(|k| index.get(&k))
            .and_then(|p| p.attributes.get("login"))
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        let faction = stat.attributes.get("faction").and_then(faction_value);
        let rating = rel_targets(&stat.relationships, "ratingChanges")
            .into_iter()
            .filter_map(|key| index.get(&key))
            .find_map(|journal| displayed_rating_before(&journal.attributes));
        by_team.entry(team).or_default().push(ReplayPlayer {
            name,
            faction,
            rating,
            outcome: stat
                .attributes
                .get("result")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            score: value_i32(&stat.attributes, "score"),
        });
    }
    let mut teams: Vec<ReplayTeam> = by_team
        .into_iter()
        .map(|(team, players)| ReplayTeam { team, players })
        .collect();
    // Observers use the negative team bucket. Keep them visible but after the
    // competitive lineup, matching the reference clients' scoreboards.
    teams.sort_by_key(|team| (team.team < 0, team.team));
    teams
}

fn faction_value(value: &Value) -> Option<i32> {
    if let Some(number) = value.as_i64() {
        return i32::try_from(number).ok();
    }
    let value = value.as_str()?.trim();
    value
        .parse()
        .ok()
        .or_else(|| match value.to_ascii_uppercase().as_str() {
            "UEF" => Some(1),
            "AEON" => Some(2),
            "CYBRAN" => Some(3),
            "SERAPHIM" => Some(4),
            "RANDOM" => Some(5),
            _ => None,
        })
}

fn team_value(value: &Value) -> Option<i32> {
    if let Some(number) = value.as_i64() {
        return i32::try_from(number).ok();
    }
    match value {
        Value::Null => Some(-1),
        Value::String(value) if value.trim().eq_ignore_ascii_case("null") => Some(-1),
        Value::String(value) => value.trim().parse().ok(),
        _ => None,
    }
}

fn displayed_rating_before(attributes: &Value) -> Option<i32> {
    let numeric = |name: &str| {
        attributes.get(name).and_then(|value| {
            value
                .as_f64()
                .or_else(|| value.as_str().and_then(|text| text.trim().parse().ok()))
        })
    };
    let rating = numeric("meanBefore")? - 3.0 * numeric("deviationBefore")?;
    (rating.is_finite() && rating >= f64::from(i32::MIN) && rating <= f64::from(i32::MAX))
        .then_some(rating.round() as i32)
}

/// `game.relationships.reviewsSummary -> reviewsSummary.attributes`.
fn resolve_reviews(
    relationships: &Value,
    index: &HashMap<(String, String), &JsonApiResource>,
) -> (Option<f32>, Option<i32>) {
    let Some(summary) = rel_target(relationships, "reviewsSummary").and_then(|k| index.get(&k))
    else {
        return (None, None);
    };
    let average = summary
        .attributes
        .get("averageScore")
        .and_then(Value::as_f64)
        .map(|v| v as f32);
    let count = summary
        .attributes
        .get("numReviews")
        .and_then(Value::as_i64)
        .map(|v| v as i32);
    (average, count)
}

/// Seconds between two RFC3339 timestamps, or `None` if either is missing or
/// unparseable (e.g. a still-in-progress game has no `endTime`).
fn duration_between(start: &str, end: Option<&str>) -> Option<i32> {
    let start = chrono::DateTime::parse_from_rfc3339(start).ok()?;
    let end = chrono::DateTime::parse_from_rfc3339(end?).ok()?;
    i32::try_from((end - start).num_seconds()).ok()
}

/// An RFC 3339 instant `months` months in the past: the clock half of the
/// query's [`ReplayQuery::fallback_months`] cost guard.
fn months_ago(months: u32) -> String {
    (chrono::Utc::now() - chrono::Months::new(months)).to_rfc3339()
}

/// Technical names from a `/data/featuredMod` document, in the order the API
/// returned them (which `sort=order` makes the mods' own display order).
fn parse_featured_mods(doc: &JsonApiDoc) -> Vec<String> {
    doc.data
        .iter()
        .filter_map(|entry| {
            entry
                .attributes
                .get("technicalName")
                .and_then(Value::as_str)
                .filter(|name| !name.is_empty())
                .map(str::to_string)
        })
        .collect()
}

fn parse_vault_replays(doc: &JsonApiDoc) -> Vec<VaultReplay> {
    let index = resource_index(&doc.included);
    doc.data
        .iter()
        .filter_map(|game| {
            let uid: i32 = game.id.parse().ok()?;
            let start_time = game
                .attributes
                .get("startTime")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let end_time = game.attributes.get("endTime").and_then(Value::as_str);
            let teams = resolve_teams(&game.relationships, &index);
            let average_rating = {
                let ratings: Vec<i32> = teams
                    .iter()
                    .filter(|team| team.team >= 0)
                    .flat_map(|t| &t.players)
                    .filter_map(|p| p.rating)
                    .collect();
                if ratings.is_empty() {
                    None
                } else {
                    Some(ratings.iter().sum::<i32>() / ratings.len() as i32)
                }
            };
            let (reviews_average, reviews_count) = resolve_reviews(&game.relationships, &index);
            let title = game
                .attributes
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            Some(VaultReplay {
                uid,
                title,
                map: resolve_map_name(&game.relationships, &index),
                map_thumbnail_url: resolve_map_thumbnail(&game.relationships, &index),
                mod_name: resolve_mod_name(&game.relationships, &index),
                duration_seconds: duration_between(&start_time, end_time),
                game_duration_seconds: value_i32(&game.attributes, "replayTicks")
                    .and_then(|ticks| (ticks >= 0).then_some(ticks / 10)),
                start_time,
                // Missing/non-bool defaults to "not available": safer than
                // assuming a replay exists when we can't tell.
                replay_available: game
                    .attributes
                    .get("replayAvailable")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                teams,
                average_rating,
                reviews_average,
                reviews_count,
            })
        })
        .collect()
}

/// Wait for the first binary WebSocket frame, ignoring ping/pong/text frames.
async fn wait_for_first_binary(read: &mut SplitStream<WsStream>) -> Result<Vec<u8>, String> {
    let wait = async {
        loop {
            match read.next().await {
                Some(Ok(Message::Binary(data))) => return Some(data),
                Some(Ok(_)) => continue,
                Some(Err(_)) | None => return None,
            }
        }
    };
    match tokio::time::timeout(READY_TIMEOUT, wait).await {
        Ok(Some(data)) => Ok(data),
        Ok(None) => Err("replay server closed the connection before sending data".to_string()),
        Err(_) => Err("timed out waiting for the replay server".to_string()),
    }
}

/// Bidirectionally pipe bytes between FA's local proxy socket and the replay
/// WebSocket (mirrors the Java client's `LiveReplayProxyServer`), starting
/// with the already-buffered first frame.
///
/// The WebSocket side runs in its own task, decoupled from the TCP write via
/// an mpsc queue: mirroring the Python client's `StreamWriter`, which pushes
/// server bytes onto a `Queue` from the Qt event loop and drains it on a
/// separate writer thread. FA is single-threaded and doesn't read from the
/// proxy socket while it's busy loading assets (tens of seconds at startup);
/// without this decoupling, `tcp.write_all` blocking on that meant we also
/// stopped polling the WebSocket, missed its keepalive pings, and the server
/// dropped the connection: the game then hit "Premature EOF" once it finally
/// got around to reading. TCP→WS (the game talking back) doesn't have the
/// same problem since replay playback is receive-only, but it's decoupled the
/// same way for symmetry and to keep this task cheap to reason about.
async fn relay_session(
    tcp: TcpStream,
    mut ws_write: SplitSink<WsStream, Message>,
    mut ws_read: SplitStream<WsStream>,
    first: Vec<u8>,
) {
    let (mut tcp_read, mut tcp_write) = tcp.into_split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
    if tx.send(first).is_err() {
        return;
    }

    // WS → queue. Never blocks on the (possibly slow-to-drain) TCP side, so
    // the server's keepalive pings always get answered promptly.
    let ws_to_queue = tokio::spawn(async move {
        while let Some(msg) = ws_read.next().await {
            match msg {
                Ok(Message::Binary(data)) => {
                    if tx.send(data).is_err() {
                        break;
                    }
                }
                Ok(Message::Close(_)) | Err(_) => break,
                _ => {} // ping/pong/text: ignore
            }
        }
    });

    // Queue → TCP. Can block on FA being busy without affecting the above.
    let queue_to_tcp = tokio::spawn(async move {
        while let Some(data) = rx.recv().await {
            if tcp_write.write_all(&data).await.is_err() {
                break;
            }
        }
    });

    // TCP → WS: the game talking back (rare during pure playback, but the
    // wire protocol is nominally bidirectional: see the module docs).
    let tcp_to_ws = tokio::spawn(async move {
        let mut buf = [0u8; 8192];
        loop {
            match tcp_read.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if ws_write
                        .send(Message::Binary(buf[..n].to_vec()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }
    });

    // The session ends as soon as any leg does: the other two are aborted.
    tokio::select! {
        _ = ws_to_queue => {}
        _ = queue_to_tcp => {}
        _ = tcp_to_ws => {}
    }
}

/// `ladder1v1` isn't a real mod: the Python client folds it to `faf` when
/// building `/init`.
fn normalize_mod(mod_name: &str) -> String {
    if mod_name == "ladder1v1" {
        "faf".to_string()
    } else {
        mod_name.to_string()
    }
}

/// Everything extracted from a `.fafreplay`/`.scfareplay` source needed to
/// launch it and get it right for old replays: the playable `.scfareplay`
/// path, its featured mod, replay id, engine version, required map folder,
/// and required sim mods (all `Option`/empty beyond `path`/`mod_name` since
/// older or malformed files may not carry every field).
struct ScfaReplay {
    path: PathBuf,
    mod_name: String,
    uid: Option<i32>,
    game_version: Option<i32>,
    map_folder: Option<String>,
    /// `(uid, display name)` pairs: mirrors the Python client's
    /// `fa.check.check`'s `sim_mods` param, which it feeds to
    /// `checkMods()`. A replay recorded with sim mods active desyncs (or,
    /// confirmed live, just hangs indefinitely past the loading screen with
    /// no error) if those mods aren't the *active* set in `game.prefs` at
    /// launch: installed alone isn't enough. Read straight from the
    /// `.fafreplay` envelope's own `sim_mods` field (present on every real
    /// vault/local file inspected) rather than re-deriving it from the
    /// compressed body's embedded Lua table the way `fa/replayparser.py`
    /// does: the envelope already carries the same `{uid: name}` map as
    /// plain JSON, so there's no need to reimplement Lua binary table
    /// parsing to get it. Always empty for the legacy bare-`.scfareplay`
    /// path, which has no JSON envelope at all.
    sim_mods: Vec<(String, String)>,
}

/// Resolve a `.fafreplay`/`.scfareplay` source to a playable `.scfareplay`
/// file plus its launch/update metadata.
async fn prepare_scfareplay(path: &std::path::Path) -> Result<ScfaReplay, String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    match ext.as_str() {
        "fafreplay" => decode_fafreplay(path).await,
        "scfareplay" => {
            let mod_name = guess_mod_from_filename(path);
            let bytes = read_replay_prefix(path).await?;
            Ok(ScfaReplay {
                path: path.to_path_buf(),
                mod_name,
                uid: None,
                game_version: game_updater::extract_game_version(&bytes),
                map_folder: game_updater::extract_map_folder(&bytes),
                sim_mods: Vec::new(),
            })
        }
        other => Err(format!(
            "don't know how to play '{}': unrecognised extension '{other}'",
            path.display()
        )),
    }
}

/// `.fafreplay` = one JSON header line + `\n` + a compressed `.scfareplay`
/// body. Writes the decompressed body to the cache dir and returns its
/// launch/update metadata.
async fn decode_fafreplay(path: &std::path::Path) -> Result<ScfaReplay, String> {
    decode_fafreplay_to(path, &cache_dir()?).await
}

async fn decode_fafreplay_to(
    path: &std::path::Path,
    output_dir: &std::path::Path,
) -> Result<ScfaReplay, String> {
    let file_size = tokio::fs::metadata(path)
        .await
        .map_err(|e| format!("could not inspect {}: {e}", path.display()))?
        .len();
    if file_size > MAX_DOWNLOAD_BYTES {
        return Err("replay file is larger than the allowed size".into());
    }
    let mut bytes = tokio::fs::read(path)
        .await
        .map_err(|e| format!("could not read {}: {e}", path.display()))?;
    let nl = bytes
        .iter()
        .position(|&b| b == b'\n')
        .ok_or_else(|| "replay file has no header line".to_string())?;
    let header: Value =
        serde_json::from_slice(&bytes[..nl]).map_err(|e| format!("invalid replay header: {e}"))?;

    // Mirrors the Python client's `uncompress()`: `compression == "zstd"` for
    // vault-downloaded replays, anything else (including the `null` locally
    // recorded replays under `%ProgramData%\FAForever\replays` actually carry)
    // falls back to the legacy Qt `qCompress` format.
    let compression = header
        .get("compression")
        .and_then(Value::as_str)
        .unwrap_or("");
    let compressed_body = bytes.split_off(nl + 1);
    let is_zstd = compression == "zstd";
    let mut source_hash = DefaultHasher::new();
    path.hash(&mut source_hash);
    let out_path = output_dir.join(format!("replay_{:016x}.scfareplay", source_hash.finish()));
    if let Some(parent) = out_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("could not create cache dir: {e}"))?;
    }
    let blocking_path = out_path.clone();
    tokio::task::spawn_blocking(move || {
        decode_replay_body_to(&compressed_body, is_zstd, &blocking_path)
    })
    .await
    .map_err(|e| format!("replay decompression task failed: {e}"))??;
    let decompressed_prefix = read_replay_prefix(&out_path).await?;

    let mod_name = header
        .get("featured_mod")
        .and_then(Value::as_str)
        .unwrap_or("faf")
        .to_string();
    let uid = header
        .get("uid")
        .and_then(Value::as_i64)
        .and_then(|value| i32::try_from(value).ok());
    let sim_mods = header
        .get("sim_mods")
        .and_then(Value::as_object)
        .map(|obj| {
            obj.iter()
                .filter_map(|(uid, name)| Some((uid.clone(), name.as_str()?.to_string())))
                .collect()
        })
        .unwrap_or_default();
    Ok(ScfaReplay {
        path: out_path,
        mod_name,
        uid,
        game_version: game_updater::extract_game_version(&decompressed_prefix),
        map_folder: game_updater::extract_map_folder(&decompressed_prefix),
        sim_mods,
    })
}

const REPLAY_METADATA_PREFIX_BYTES: usize = 64 * 1024;
const MAX_DECOMPRESSED_REPLAY_BYTES: u64 = 1024 * 1024 * 1024;

async fn read_replay_prefix(path: &Path) -> Result<Vec<u8>, String> {
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|error| format!("could not read {}: {error}", path.display()))?;
    let mut bytes = vec![0_u8; REPLAY_METADATA_PREFIX_BYTES];
    let read = file
        .read(&mut bytes)
        .await
        .map_err(|error| format!("could not read {}: {error}", path.display()))?;
    bytes.truncate(read);
    Ok(bytes)
}

/// Stream a replay body into a private file and publish it only after the full
/// decode succeeds. This bounds both zstd and legacy qCompress expansion and
/// avoids holding the expanded command stream in memory.
fn decode_replay_body_to(body: &[u8], is_zstd: bool, output: &Path) -> Result<(), String> {
    let parent = output
        .parent()
        .ok_or_else(|| "replay cache path has no parent".to_string())?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("could not create replay cache file: {error}"))?;

    let written = if is_zstd {
        let decoder = zstd::stream::read::Decoder::new(body)
            .map_err(|error| format!("could not decompress replay: {error}"))?;
        copy_bounded(decoder, &mut temporary)?
    } else {
        decode_legacy_qcompress_to(body, &mut temporary)?
    };
    if written > MAX_DECOMPRESSED_REPLAY_BYTES {
        return Err("replay expands beyond the allowed size".into());
    }
    temporary
        .flush()
        .map_err(|error| format!("could not finish replay cache file: {error}"))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| format!("could not sync replay cache file: {error}"))?;
    temporary
        .persist(output)
        .map(|_| ())
        .map_err(|error| format!("could not publish replay cache file: {}", error.error))
}

fn copy_bounded(
    mut reader: impl std::io::Read,
    writer: &mut impl std::io::Write,
) -> Result<u64, String> {
    let mut limited = reader.by_ref().take(MAX_DECOMPRESSED_REPLAY_BYTES + 1);
    let written = std::io::copy(&mut limited, writer)
        .map_err(|error| format!("could not decompress replay: {error}"))?;
    if written > MAX_DECOMPRESSED_REPLAY_BYTES {
        return Err("replay expands beyond the allowed size".into());
    }
    Ok(written)
}

/// Legacy `.fafreplay` body format: standard base64, decoding to Qt's
/// `qCompress` container: a 4-byte big-endian uncompressed-length prefix
/// followed by a raw zlib stream. Mirrors `qUncompress(QByteArray.fromBase64(..))`
/// in the Python client's `fa/replay.py`.
fn decode_legacy_qcompress_to(
    body: &[u8],
    writer: &mut impl std::io::Write,
) -> Result<u64, String> {
    use std::io::Read as _;

    let mut decoded =
        base64::read::DecoderReader::new(body, &base64::engine::general_purpose::STANDARD);
    let mut prefix = [0_u8; 4];
    decoded
        .read_exact(&mut prefix)
        .map_err(|error| format!("could not read legacy qCompress header: {error}"))?;
    let expected = u32::from_be_bytes(prefix);
    if u64::from(expected) > MAX_DECOMPRESSED_REPLAY_BYTES {
        return Err("replay expands beyond the allowed size".into());
    }
    let written = copy_bounded(flate2::read::ZlibDecoder::new(decoded), writer)?;
    if written != u64::from(expected) {
        return Err("legacy replay size does not match its qCompress header".into());
    }
    Ok(written)
}

/// Legacy `.scfareplay` files carry their mod in the filename, `<name>.<mod>.scfareplay`.
fn guess_mod_from_filename(path: &std::path::Path) -> String {
    path.file_stem()
        .and_then(|s| s.to_str())
        .and_then(|stem| stem.rsplit_once('.'))
        .map(|(_, mod_name)| mod_name.to_string())
        .unwrap_or_else(|| "faf".to_string())
}

/// Inert replay client: used offline and in tests. Every call fails cleanly
/// (mirrors [`crate::infra::FakeGame`]'s posture: no game installed, no IO).
#[derive(Debug, Clone, Default)]
pub struct FakeReplay;

#[async_trait]
impl ReplayPort for FakeReplay {
    async fn watch_live(
        &self,
        _target: LiveReplayTarget,
        _player: String,
    ) -> Result<Option<String>, String> {
        Err("replay watching is unavailable in offline mode".to_string())
    }

    async fn play_file(&self, _path: PathBuf) -> Result<Option<String>, String> {
        Err("replay playback is unavailable in offline mode".to_string())
    }

    async fn search_vault(&self, _query: ReplayQuery) -> Result<VaultSearchResult, String> {
        Ok(VaultSearchResult::default())
    }

    async fn list_featured_mods(&self) -> Result<Vec<String>, String> {
        // The well-known set, so the offline path still exercises the filter.
        Ok(["faf", "ladder1v1", "coop", "fafbeta", "nomads"]
            .map(String::from)
            .to_vec())
    }

    async fn watch_vault(&self, _uid: i32) -> Result<Option<String>, String> {
        Err("no game install configured: set it in Settings → Paths".to_string())
    }

    async fn download_vault(&self, _uid: i32) -> Result<LocalReplay, String> {
        Err("replay downloading is unavailable in offline mode".to_string())
    }

    async fn list_local(&self) -> Result<Vec<LocalReplay>, String> {
        Ok(Vec::new())
    }

    async fn delete_local(&self, _path: PathBuf) -> Result<(), String> {
        Err("local replay deletion is disabled".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn replay_config() -> ReplayConfig {
        ReplayConfig {
            user_api_base: "https://user.faforever.com".into(),
            api_base: "https://api.faforever.com".into(),
            vault_host: "https://replay.faforever.com".into(),
            replay_target_dir: None,
            exe_name: "ForgedAlliance.exe".into(),
            content_base: "https://content.faforever.com".into(),
        }
    }

    #[test]
    fn replay_redirect_chain_accepts_only_the_requested_replay_on_faf_origins() {
        let config = replay_config();
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

    fn lua_string(value: &str) -> Vec<u8> {
        let mut bytes = vec![1];
        bytes.extend_from_slice(value.as_bytes());
        bytes.push(0);
        bytes
    }

    fn lua_number(value: f32) -> Vec<u8> {
        let mut bytes = vec![0];
        bytes.extend_from_slice(&value.to_le_bytes());
        bytes
    }

    fn lua_army() -> Vec<u8> {
        let mut bytes = vec![4];
        bytes.extend(lua_string("PlayerName"));
        bytes.extend(lua_string("TestPlayer"));
        bytes.extend(lua_string("Faction"));
        bytes.extend(lua_number(1.0));
        bytes.extend(lua_string("MEAN"));
        bytes.extend(lua_number(1500.0));
        bytes.extend(lua_string("DEV"));
        bytes.extend(lua_number(100.0));
        bytes.push(5);
        bytes
    }

    fn local_body_with_army() -> Vec<u8> {
        let mut body = Vec::new();
        body.extend_from_slice(b"Supreme Commander v1.50.3764\0");
        body.extend_from_slice(&[0; 3]);
        body.extend_from_slice(b"Replay v1.9\r\n/maps/SCMP_009/SCMP_009.scmap\0");
        body.extend_from_slice(&[0; 4]);
        body.extend_from_slice(&0_u32.to_le_bytes());
        body.extend_from_slice(&[4, 5]);
        body.extend_from_slice(&0_u32.to_le_bytes());
        body.extend_from_slice(&[4, 5]);
        body.push(1);
        body.extend_from_slice(b"TestPlayer\0");
        body.extend_from_slice(&u32::MAX.to_le_bytes());
        body.push(0);
        body.push(1);
        body.extend_from_slice(&1_u32.to_le_bytes());
        body.extend(lua_army());
        body.extend_from_slice(&[0, 0]);
        body
    }

    #[test]
    fn local_body_parser_extracts_faction_and_displayed_rating() {
        use base64::Engine as _;
        use std::io::Write as _;

        let body = local_body_with_army();
        let mut encoder =
            flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&body).unwrap();
        let mut qcompressed = (body.len() as u32).to_be_bytes().to_vec();
        qcompressed.extend(encoder.finish().unwrap());
        let encoded = base64::engine::general_purpose::STANDARD.encode(qcompressed);
        let stats = local_body_player_stats(encoded.as_bytes(), "");
        assert_eq!(stats.get("TestPlayer"), Some(&(Some(1), Some(1200))));
    }

    #[tokio::test]
    async fn list_local_dir_reads_metadata_and_keeps_problem_files_visible() {
        let dir = std::env::temp_dir().join(format!("forge-local-replays-{}", std::process::id()));
        tokio::fs::create_dir_all(&dir).await.unwrap();

        let header = |uid: i32, complete: bool| {
            format!(
                r#"{{"uid":{uid},"complete":{complete},"mapname":"scmp_009","featured_mod":"faf","title":"t{uid}","recorder":"host","launched_at":1700000000,"num_players":2,"teams":{{"1":["host"],"2":["guest"]}},"sim_mods":{{"mod-1":"UI Party"}}}}"#
            )
        };
        tokio::fs::write(
            dir.join("older.fafreplay"),
            format!("{}\nbody", header(1, true)),
        )
        .await
        .unwrap();
        // Ensure a distinct, later mtime than the first file.
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        tokio::fs::write(
            dir.join("newer.fafreplay"),
            format!("{}\nbody", header(2, false)),
        )
        .await
        .unwrap();
        tokio::fs::write(dir.join("corrupt.fafreplay"), b"not even json\nbody")
            .await
            .unwrap();
        tokio::fs::write(dir.join("legacy.faf.scfareplay"), b"legacy replay body")
            .await
            .unwrap();

        let replays = list_local_dir(&dir).await.expect("should list");
        assert_eq!(replays.len(), 4, "every replay-shaped file stays visible");
        let complete = replays.iter().find(|replay| replay.uid == Some(1)).unwrap();
        assert_eq!(complete.status, LocalReplayStatus::Complete);
        assert_eq!(complete.map, "scmp_009");
        assert_eq!(complete.recorder, "host");
        assert_eq!(complete.num_players, 2);
        assert_eq!(complete.teams.len(), 2);
        assert_eq!(complete.sim_mods, vec!["UI Party"]);
        assert_eq!(complete.start_time, Some(1_700_000_000));

        let incomplete = replays.iter().find(|replay| replay.uid == Some(2)).unwrap();
        assert_eq!(incomplete.status, LocalReplayStatus::Incomplete);
        assert!(incomplete.watchable);

        let broken = replays
            .iter()
            .find(|replay| replay.file_name == "corrupt.fafreplay")
            .unwrap();
        assert_eq!(broken.status, LocalReplayStatus::Broken);
        assert!(!broken.watchable);

        let legacy = replays
            .iter()
            .find(|replay| replay.file_name == "legacy.faf.scfareplay")
            .unwrap();
        assert_eq!(legacy.status, LocalReplayStatus::Legacy);
        assert!(legacy.watchable);
        assert_eq!(legacy.mod_name, "faf");

        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn list_local_dir_missing_folder_returns_empty() {
        let dir = std::env::temp_dir().join("forge-local-replays-does-not-exist");
        let replays = list_local_dir(&dir)
            .await
            .expect("missing dir is not an error");
        assert!(replays.is_empty());
    }

    /// The contract between the two halves of "record a game locally": what
    /// [`crate::infra::replay_recorder`] writes has to be what this module's
    /// archive listing can read. They were written against the same format and
    /// were still incompatible, because the recorder emitted the bare stream and
    /// everything the list shows comes from the JSON header the stream has none
    /// of. Asserting the pair together is the only thing that catches that.
    #[tokio::test]
    async fn a_recorded_replay_lists_with_its_game_details() {
        let dir = std::env::temp_dir().join(format!("forge-recorded-{}", std::process::id()));
        tokio::fs::create_dir_all(&dir).await.unwrap();

        let metadata = crate::ports::ReplayMetadata {
            uid: 27_619_486,
            recorder: "Nory".into(),
            featured_mod: "faf".into(),
            title: "Turtle bowl".into(),
            map_name: "scmp_009".into(),
            game_type: "custom".into(),
            host: "Nory".into(),
            launched_at: Some(1_700_000_000),
            num_players: 2,
            teams: [
                ("1".to_string(), vec!["Nory".to_string()]),
                ("2".to_string(), vec!["Someone".to_string()]),
            ]
            .into_iter()
            .collect(),
            sim_mods: Default::default(),
        };
        let file =
            crate::infra::replay_recorder::build_fafreplay(&metadata, b"body".to_vec(), true)
                .unwrap();
        let path = dir.join("27619486-Nory.fafreplay");
        tokio::fs::write(&path, &file).await.unwrap();

        let replays = list_local_dir(&dir).await.unwrap();
        let replay = replays.first().expect("the recording should be listed");
        assert_eq!(replay.uid, Some(27_619_486));
        assert_eq!(replay.title, "Turtle bowl");
        assert_eq!(replay.map, "scmp_009");
        assert_eq!(replay.mod_name, "faf");
        assert_eq!(replay.recorder, "Nory");
        assert_eq!(replay.start_time, Some(1_700_000_000));
        assert_eq!(replay.num_players, 2);
        assert_eq!(replay.teams.len(), 2);
        assert_eq!(replay.status, LocalReplayStatus::Complete);

        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn delete_local_file_is_scoped_to_the_replay_folder() {
        let root = std::env::temp_dir().join(format!("forge-local-delete-{}", std::process::id()));
        let replay_dir = root.join("replays");
        tokio::fs::create_dir_all(&replay_dir).await.unwrap();
        let replay = replay_dir.join("42.fafreplay");
        let outside = root.join("keep.fafreplay");
        tokio::fs::write(&replay, b"replay").await.unwrap();
        tokio::fs::write(&outside, b"keep").await.unwrap();

        assert!(delete_local_file(&replay_dir, &outside).await.is_err());
        assert!(outside.exists());
        delete_local_file(&replay_dir, &replay).await.unwrap();
        assert!(!replay.exists());

        let _ = tokio::fs::remove_dir_all(&root).await;
    }

    #[test]
    fn replay_downloads_are_published_atomically_and_can_be_replaced() {
        let directory = tempfile::tempdir().expect("temporary replay directory");
        let path = directory.path().join("42.fafreplay");

        write_replay_atomically(&path, b"first").unwrap();
        write_replay_atomically(&path, b"second").unwrap();

        assert_eq!(std::fs::read(&path).unwrap(), b"second");
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[tokio::test]
    async fn local_replay_resolution_returns_only_direct_replay_children() {
        let directory = tempfile::tempdir().expect("temporary replay directory");
        let replay_dir = directory.path().join("replays");
        let nested_dir = replay_dir.join("nested");
        tokio::fs::create_dir_all(&nested_dir).await.unwrap();
        let replay = replay_dir.join("42.fafreplay");
        let nested = nested_dir.join("43.fafreplay");
        let text = replay_dir.join("notes.txt");
        tokio::fs::write(&replay, b"replay").await.unwrap();
        tokio::fs::write(&nested, b"nested").await.unwrap();
        tokio::fs::write(&text, b"notes").await.unwrap();

        assert_eq!(
            resolve_local_replay_file(&replay_dir, &replay)
                .await
                .unwrap(),
            tokio::fs::canonicalize(&replay).await.unwrap()
        );
        assert!(resolve_local_replay_file(&replay_dir, &nested)
            .await
            .is_err());
        assert!(resolve_local_replay_file(&replay_dir, &text).await.is_err());
    }

    #[test]
    fn parses_vault_replays_resolving_map_and_mod_through_included() {
        let doc: JsonApiDoc = serde_json::from_value(json!({
            "data": [
                {
                    "type": "game",
                    "id": "12345",
                    "attributes": {
                        "name": "all welcome",
                        "startTime": "2026-01-01T12:00:00Z",
                        "endTime": "2026-01-01T12:30:00Z",
                        "replayTicks": 12345,
                        "replayAvailable": true,
                    },
                    "relationships": {
                        "mapVersion": { "data": { "type": "mapVersion", "id": "9" } },
                        "featuredMod": { "data": { "type": "featuredMod", "id": "1" } },
                        "playerStats": { "data": [
                            { "type": "gamePlayerStats", "id": "100" },
                            { "type": "gamePlayerStats", "id": "101" },
                            { "type": "gamePlayerStats", "id": "102" },
                        ] },
                        "reviewsSummary": { "data": { "type": "gameReviewsSummary", "id": "12345" } },
                    },
                },
            ],
            "included": [
                {
                    "type": "mapVersion",
                    "id": "9",
                    "attributes": { "thumbnailUrlSmall": "https://content.faforever.com/maps/scmp_009.small.png" },
                    "relationships": {
                        "map": { "data": { "type": "map", "id": "77" } },
                    },
                },
                {
                    "type": "map",
                    "id": "77",
                    "attributes": { "displayName": "Seton's Clutch" },
                },
                {
                    "type": "featuredMod",
                    "id": "1",
                    "attributes": { "technicalName": "faf" },
                },
                {
                    "type": "gamePlayerStats",
                    "id": "100",
                    "attributes": { "team": 2, "faction": 1, "result": "VICTORY", "score": 3210 },
                    "relationships": {
                        "player": { "data": { "type": "player", "id": "500" } },
                        "ratingChanges": { "data": [{ "type": "leaderboardRatingJournal", "id": "700" }] }
                    },
                },
                {
                    "type": "gamePlayerStats",
                    "id": "101",
                    "attributes": { "team": 3, "faction": "RANDOM" },
                    "relationships": { "player": { "data": { "type": "player", "id": "501" } } },
                },
                {
                    "type": "gamePlayerStats",
                    "id": "102",
                    "attributes": { "team": "null", "faction": "SERAPHIM" },
                    "relationships": { "player": { "data": { "type": "player", "id": "502" } } },
                },
                { "type": "player", "id": "500", "attributes": { "login": "Seraphim-Noob" } },
                { "type": "player", "id": "501", "attributes": { "login": "Nomander" } },
                { "type": "player", "id": "502", "attributes": { "login": "Watcher" } },
                {
                    "type": "leaderboardRatingJournal",
                    "id": "700",
                    "attributes": { "meanBefore": 1600.0, "deviationBefore": 100.0 }
                },
                {
                    "type": "gameReviewsSummary",
                    "id": "12345",
                    "attributes": { "averageScore": 4.5, "numReviews": 2 },
                },
            ],
        }))
        .unwrap();

        let replays = parse_vault_replays(&doc);
        assert_eq!(replays.len(), 1);
        let replay = &replays[0];
        assert_eq!(replay.uid, 12345);
        assert_eq!(replay.title, "all welcome");
        assert_eq!(replay.map, "Seton's Clutch");
        assert_eq!(
            replay.map_thumbnail_url,
            "https://content.faforever.com/maps/scmp_009.small.png"
        );
        assert_eq!(replay.mod_name, "faf");
        assert_eq!(replay.start_time, "2026-01-01T12:00:00Z");
        assert!(replay.replay_available);
        assert_eq!(replay.duration_seconds, Some(1800));
        assert_eq!(replay.game_duration_seconds, Some(1234));
        assert_eq!(replay.reviews_average, Some(4.5));
        assert_eq!(replay.reviews_count, Some(2));
        assert_eq!(replay.teams.len(), 3);
        assert_eq!(replay.teams[0].team, 2);
        assert_eq!(replay.teams[0].players[0].name, "Seraphim-Noob");
        assert_eq!(replay.teams[0].players[0].faction, Some(1));
        assert_eq!(replay.teams[0].players[0].rating, Some(1300));
        assert_eq!(replay.teams[0].players[0].outcome, "VICTORY");
        assert_eq!(replay.teams[0].players[0].score, Some(3210));
        assert_eq!(replay.average_rating, Some(1300));
        assert_eq!(replay.teams[1].team, 3);
        assert_eq!(replay.teams[1].players[0].name, "Nomander");
        assert_eq!(replay.teams[1].players[0].faction, Some(5));
        assert_eq!(replay.teams[2].team, -1);
        assert_eq!(replay.teams[2].players[0].name, "Watcher");
    }

    #[test]
    fn parse_vault_replays_defaults_gracefully_without_included() {
        let doc: JsonApiDoc = serde_json::from_value(json!({
            "data": [{ "type": "game", "id": "1", "attributes": {}, "relationships": {} }],
        }))
        .unwrap();

        let replays = parse_vault_replays(&doc);
        assert_eq!(replays.len(), 1);
        let replay = &replays[0];
        assert_eq!(replay.title, "");
        assert_eq!(replay.map, "unknown map");
        assert_eq!(replay.map_thumbnail_url, "");
        assert_eq!(replay.mod_name, "faf");
        assert_eq!(replay.start_time, "");
        assert!(
            !replay.replay_available,
            "missing attribute defaults to unavailable"
        );
        assert_eq!(replay.duration_seconds, None);
        assert!(replay.teams.is_empty());
        assert_eq!(replay.average_rating, None);
        assert_eq!(replay.reviews_average, None);
        assert_eq!(replay.reviews_count, None);
    }

    #[test]
    fn normalizes_ladder1v1_to_faf() {
        assert_eq!(normalize_mod("ladder1v1"), "faf");
        assert_eq!(normalize_mod("faf"), "faf");
        assert_eq!(normalize_mod("murderparty"), "murderparty");
    }

    #[test]
    fn guesses_mod_from_legacy_filename() {
        assert_eq!(
            guess_mod_from_filename(std::path::Path::new("12345.faf.scfareplay")),
            "faf"
        );
        // No embedded mod segment: falls back to "faf".
        assert_eq!(
            guess_mod_from_filename(std::path::Path::new("12345.scfareplay")),
            "faf"
        );
    }

    #[tokio::test]
    async fn fake_replay_fails_cleanly() {
        let fake = FakeReplay;
        let target = LiveReplayTarget {
            uid: 1,
            mod_name: "faf".into(),
            map: "scmp_007".into(),
        };
        assert!(fake.watch_live(target, "spectator".into()).await.is_err());
        assert!(fake.play_file(PathBuf::from("x.fafreplay")).await.is_err());
    }

    #[test]
    fn legacy_replay_rejects_an_oversized_advertised_expansion() {
        use base64::Engine as _;

        let dir = tempfile::tempdir().expect("temporary replay directory");
        let output = dir.path().join("expanded.scfareplay");
        let body = base64::engine::general_purpose::STANDARD
            .encode(((MAX_DECOMPRESSED_REPLAY_BYTES + 1) as u32).to_be_bytes());

        let error = decode_replay_body_to(body.as_bytes(), false, &output)
            .expect_err("oversized replay must fail");

        assert!(error.contains("expands beyond"));
        assert!(!output.exists(), "a rejected replay must not be published");
    }

    #[tokio::test]
    async fn decode_fafreplay_handles_legacy_and_zstd_bodies() {
        use base64::Engine as _;
        use std::io::Write as _;

        // qCompress = 4-byte big-endian uncompressed length + raw zlib stream,
        // then the whole thing is base64-wrapped for the `.fafreplay` body.
        let payload = b"fake-scfareplay-legacy-bytes";
        let mut zlib = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        zlib.write_all(payload).unwrap();
        let compressed = zlib.finish().unwrap();
        let mut qcompressed = (payload.len() as u32).to_be_bytes().to_vec();
        qcompressed.extend_from_slice(&compressed);
        let body = base64::engine::general_purpose::STANDARD.encode(&qcompressed);

        let dir = std::env::temp_dir().join(format!("forge-replay-test-{}", std::process::id()));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let path = dir.join("legacy.fafreplay");
        let mut file = br#"{"compression":null,"featured_mod":"faf","uid":777,"sim_mods":{"abc-123":"Economy Unit Logger"}}"#.to_vec();
        file.push(b'\n');
        file.extend_from_slice(body.as_bytes());
        tokio::fs::write(&path, &file).await.unwrap();

        let replay = decode_fafreplay_to(&path, &dir.join("cache"))
            .await
            .expect("should decode");
        assert_eq!(replay.mod_name, "faf");
        assert_eq!(replay.uid, Some(777));
        assert_eq!(
            replay.game_version, None,
            "test payload has no SupCom version string"
        );
        assert_eq!(
            replay.sim_mods,
            vec![("abc-123".to_string(), "Economy Unit Logger".to_string())]
        );
        let written = tokio::fs::read(&replay.path).await.unwrap();
        assert_eq!(written, payload);
        let legacy_cache_path = replay.path.clone();

        let _ = tokio::fs::remove_dir_all(&dir).await;

        // A second source gets a distinct deterministic cache path.
        let dir =
            std::env::temp_dir().join(format!("forge-replay-test-{}", std::process::id() + 1));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let path = dir.join("real.fafreplay");

        let scfa_body = [
            b"Supreme Commander v1.50.3828\0".as_slice(),
            b"\0",
            b"Replay v1.9\r\n/maps/adaptive_gadostb.v0002/adaptive_gadostb.scmap\0",
            b"garbage\0fake-scfareplay-bytes",
        ]
        .concat();
        let zbody = zstd::stream::encode_all(&scfa_body[..], 0).unwrap();
        let mut file = Vec::new();
        file.extend_from_slice(br#"{"compression":"zstd","featured_mod":"faf","uid":12345}"#);
        file.push(b'\n');
        file.extend_from_slice(&zbody);
        tokio::fs::write(&path, &file).await.unwrap();

        let replay = decode_fafreplay_to(&path, &dir.join("cache"))
            .await
            .expect("should decode");
        assert_eq!(replay.mod_name, "faf");
        assert_eq!(replay.uid, Some(12345));
        assert_eq!(replay.game_version, Some(3828));
        assert_eq!(replay.map_folder.as_deref(), Some("adaptive_gadostb.v0002"));
        assert_ne!(replay.path, legacy_cache_path);
        let written = tokio::fs::read(&replay.path).await.unwrap();
        assert_eq!(written, scfa_body);

        let _ = tokio::fs::remove_dir_all(&dir).await;
    }
}
