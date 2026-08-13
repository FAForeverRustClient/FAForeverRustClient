//! Real replay client — live spectating and local `.fafreplay` playback.
//!
//! Mirrors the Python client's `fa/replaylivestreamer.py`/`fa/replay.py`.
//!
//! ## Live-watch protocol
//! 1. `GET {user_api}/replay/access` (bearer token) → `{ accessUrl }` (same
//!    endpoint and response shape as the lobby's `/lobby/access`, see
//!    `infra::fetch_access_url`).
//! 2. Open a WebSocket to `accessUrl`; send one binary frame
//!    `G/{uid}/{player}.scfareplay\0` (the player name is irrelevant to the
//!    server, which merges every participant's stream — any non-empty string
//!    works, per the Python client's own comment).
//! 3. Wait for the first binary frame back before launching FA — otherwise FA
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
//! pipe avoids that crash — we shipped that fix briefly — but it introduced a
//! worse regression: FA's named-pipe read is a *blocking* call on (what
//! appears to be) its main/render thread, so catching up to a live game's
//! current tick freezes the entire UI rather than just stalling the
//! simulation the way the TCP path does (confirmed both by community reports
//! — Nomander/Nuggets, FAF Discord, Jan 2026 — and by reproducing it
//! ourselves). The actual fix for the root cause is upstream, in the FA
//! engine's lobby code (`FAForever/fa#7057`, stripping disabled mods' game
//! options before launch so `ScenarioInfo` never gets oversized in the first
//! place); once that lands, this TCP transport stops hitting the crash for
//! new games entirely, with none of the pipe's freeze downside. Old replays
//! recorded before that fix may still have oversized `ScenarioInfo` and could
//! in principle still hit this crash live-spectating them — but local *file*
//! playback (see below) was never on this code path to begin with: FA reads
//! those directly from disk via `/replay "<path>"`, with no TCP or pipe
//! involved and no size limit or freeze concern either way.
//!
//! ## File playback
//! A `.fafreplay` is a JSON header line + `\n` + a compressed `.scfareplay`
//! sim-command stream. Two body formats exist, both mirrored from the Python
//! client's `uncompress()`: `compression: "zstd"` for vault-downloaded
//! replays, and everything else (in practice `null` — the format
//! `%ProgramData%\FAForever\replays` locally-recorded replays actually use)
//! falls back to base64 wrapping Qt's `qCompress` container (4-byte
//! big-endian length + raw zlib). The decompressed body is written to the
//! cache dir and FA is launched with `/replay "<path>"`.

use std::collections::HashMap;
use std::io::Read as _;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use faf_domain::state::{
    LiveReplayTarget, LocalReplay, ModType, ReplayPlayer, ReplayTeam, VaultReplay,
};
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use crate::infra::session::TokenStore;
use crate::infra::{env_or, ensure_ws_path, fetch_access_url, free_port, game_updater};
use crate::ports::{ProcessPort, ReplayPort};

type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// How long to wait for the replay server's first byte, or for FA to connect
/// to the local TCP proxy, before giving up.
const READY_TIMEOUT: Duration = Duration::from_secs(20);

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
    /// Root of the replay game install the version updater targets — two
    /// directories up from `FAF_REPLAY_GAME_PATH` (…/replaydata/bin/FA.exe →
    /// …/replaydata). `None` if `FAF_REPLAY_GAME_PATH` isn't set; version
    /// updates are then skipped (replay launch still proceeds, matching the
    /// existing "the exe path just isn't configured" posture elsewhere).
    pub replay_target_dir: Option<PathBuf>,
    /// The FA executable's filename within the `bin` group, e.g.
    /// `ForgedAlliance.exe` — the file the version updater hex-patches.
    pub exe_name: String,
    /// Public content CDN — `GET {content_base}/maps/{name}.zip` downloads a
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

/// Derives the version updater's target directory from `FAF_REPLAY_GAME_PATH`
/// (…/replaydata/bin/ForgedAlliance.exe → …/replaydata) — two `parent()`
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
    process: Arc<dyn ProcessPort>,
}

impl ReplayClient {
    pub fn new(config: ReplayConfig, tokens: TokenStore, process: Arc<dyn ProcessPort>) -> Self {
        Self {
            config,
            tokens,
            http: reqwest::Client::new(),
            process,
        }
    }

    pub fn faf(tokens: TokenStore, process: Arc<dyn ProcessPort>) -> Self {
        Self::new(ReplayConfig::faf(), tokens, process)
    }
}

#[async_trait]
impl ReplayPort for ReplayClient {
    async fn watch_live(
        &self,
        target: LiveReplayTarget,
        player: String,
    ) -> Result<Option<String>, String> {
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
        let ws_url = ensure_ws_path(&access_url);

        // Note: ws_url carries a one-time verify token — never log it verbatim.
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
        // Python client — otherwise FA connects to a proxy with nothing behind it.
        let first = wait_for_first_binary(&mut read).await?;

        let port = free_port().ok_or_else(|| "could not reserve a local port".to_string())?;
        let listener = TcpListener::bind(("127.0.0.1", port))
            .await
            .map_err(|e| format!("could not bind local replay proxy: {e}"))?;

        let mod_name = normalize_mod(&target.mod_name);

        // Same gap `play_file` had before it got `ensure_map_available`:
        // live-spectating never staged the game's map at all, so a custom
        // (non-base) map FA can't already find leaves it stuck the same
        // way — confirmed live (`map /maps/hoey.v0002/Hoey.scmap failed.
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

        let log_dir = cache_dir()?;
        tokio::fs::create_dir_all(&log_dir)
            .await
            .map_err(|e| format!("could not create {}: {e}", log_dir.display()))?;
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
            log_dir.join("live.log").display().to_string(),
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
        let replay = prepare_scfareplay(&path).await?;
        let mod_name = normalize_mod(&replay.mod_name);
        let mut warning = None;

        if let Some(target_dir) = self.config.replay_target_dir.as_deref() {
            // Old replays embed the exact engine build they need; FA refuses
            // to load one that doesn't match what's installed ("Ack! Unable
            // to load game replay"). Update before every launch — cheap when
            // already current, since files are skipped on a matching MD5
            // (see infra/game_updater.rs). Unlike map staging below, there is
            // no "expected to fail" case here — every replay's embedded
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
            // entirely — a real, community-documented bug (see the plan).
            // Stage the map into both before launch. Unlike the version
            // update above, failure here is *not* fatal — official/base-game
            // maps are never found on the vault CDN and that's expected (see
            // `ensure_map_available`'s docs) — but it's surfaced as a
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
        //   (`if sim_mods:` in `check()`) — an unmodded replay leaves the
        //   user's mod setup completely alone.
        // - `keepuimods=True`: the user's currently-active *UI* mods stay
        //   active; only the sim-mod set is replaced by the replay's own.
        //   UI mods don't affect the simulation, so they can't desync
        //   playback — and silently wiping the user's UI setup (hotbuild,
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

        let log_dir = cache_dir()?;
        tokio::fs::create_dir_all(&log_dir)
            .await
            .map_err(|e| format!("could not create {}: {e}", log_dir.display()))?;
        let mut args = vec![
            "/replay".to_string(),
            replay.path.display().to_string(),
            "/init".to_string(),
            format!("init_{mod_name}.lua"),
            "/nobugreport".to_string(),
            // Mirrors the Python client passing `/log "<LOG_FILE_REPLAY>"` —
            // without it FA writes no log at all, so a hang like the one
            // this session spent a long time diagnosing blind is otherwise
            // completely opaque (no crash, no stderr, nothing on disk).
            "/log".to_string(),
            log_dir.join("replay.log").display().to_string(),
        ];
        if let Some(uid) = replay.uid {
            args.push("/replayid".to_string());
            args.push(uid.to_string());
        }
        self.process.launch_replay(args).await?;
        Ok(warning)
    }

    async fn list_vault(&self) -> Result<Vec<VaultReplay>, String> {
        let token = self
            .tokens
            .get()
            .ok_or_else(|| "not logged in".to_string())?;

        // No player filter: the global "newest replays" feed (mirrors the
        // Java client's `getNewestReplaysWithPageCount`/Python's default
        // unfiltered search), not just the logged-in player's own history.
        let mut url = url::Url::parse(&format!("{}/data/game", self.config.api_base))
            .map_err(|e| format!("invalid API base: {e}"))?;
        url.query_pairs_mut()
            .append_pair("sort", "-startTime")
            .append_pair("page[size]", "50")
            .append_pair(
                "include",
                "mapVersion.map,featuredMod,playerStats.player,reviewsSummary",
            );

        let resp = self
            .http
            .get(url)
            .bearer_auth(&token)
            .header(reqwest::header::ACCEPT, "application/vnd.api+json")
            .send()
            .await
            .map_err(|e| format!("request failed: {e}"))?;

        let status = resp.status();
        let body = resp.text().await.map_err(|e| format!("read failed: {e}"))?;
        if !status.is_success() {
            return Err(format!(
                "/data/game returned {status}: {}",
                body.chars().take(200).collect::<String>()
            ));
        }

        let doc: JsonApiDoc =
            serde_json::from_str(&body).map_err(|e| format!("invalid JSON: {e}"))?;
        Ok(parse_vault_replays(&doc))
    }

    async fn watch_vault(&self, uid: i32) -> Result<Option<String>, String> {
        let url = format!("{}/{}", self.config.vault_host, uid);
        let resp = self
            .http
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("could not download replay {uid}: {e}"))?;
        let status = resp.status();
        if !status.is_success() {
            return Err(format!("could not download replay {uid}: {status}"));
        }
        let bytes = resp
            .bytes()
            .await
            .map_err(|e| format!("could not read replay {uid}: {e}"))?;

        let path = cache_dir()?.join(format!("vault_{uid}.fafreplay"));
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("could not create cache dir: {e}"))?;
        }
        tokio::fs::write(&path, &bytes)
            .await
            .map_err(|e| format!("could not write {}: {e}", path.display()))?;

        self.play_file(path).await
    }

    async fn list_local(&self) -> Result<Vec<LocalReplay>, String> {
        list_local_dir(&local_replays_dir()).await
    }
}

/// Scans `dir` for `.fafreplay` files — the testable body of
/// [`ReplayClient::list_local`], split out so tests don't have to mutate the
/// process-global `FAF_REPLAYS_DIR`/`ALLUSERSPROFILE` env vars.
async fn list_local_dir(dir: &std::path::Path) -> Result<Vec<LocalReplay>, String> {
    let mut entries = match tokio::fs::read_dir(dir).await {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("could not read {}: {e}", dir.display())),
    };

    // Sort by mtime first (cheap — directory metadata only) and cap to the
    // most recent MAX_LOCAL_REPLAYS before reading any file content, so this
    // stays fast regardless of how many replays have piled up.
    let mut files: Vec<(PathBuf, std::time::SystemTime)> = Vec::new();
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|e| format!("could not list {}: {e}", dir.display()))?
    {
        let path = entry.path();
        let is_fafreplay = path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("fafreplay"));
        if !is_fafreplay {
            continue;
        }
        if let Ok(meta) = entry.metadata().await {
            if let Ok(modified) = meta.modified() {
                files.push((path, modified));
            }
        }
    }
    files.sort_by_key(|f| std::cmp::Reverse(f.1));
    files.truncate(MAX_LOCAL_REPLAYS);

    let mut replays = Vec::with_capacity(files.len());
    for (path, _) in files {
        if let Some(replay) = read_local_header(&path).await {
            replays.push(replay);
        }
    }
    Ok(replays)
}

/// How many of the most-recently-modified local replay files to list (see
/// [`ReplayClient::list_local`] — this bounds the header-read work
/// regardless of how large the shared replay folder has grown).
const MAX_LOCAL_REPLAYS: usize = 100;

/// The shared FAF replay folder every client writes to. Mirrors the Python
/// client's `APPDATA_DIR` (`%ALLUSERSPROFILE%\FAForever` on Windows, falling
/// back to `~/FAForever` elsewhere) plus `/replays`. `FAF_REPLAYS_DIR`
/// overrides it (tests, alternate installs).
fn local_replays_dir() -> PathBuf {
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

/// Read just enough of a local `.fafreplay` file (the JSON header line) to
/// list it — never decompresses the body, so this is cheap even for a folder
/// with thousands of replays.
async fn read_local_header(path: &std::path::Path) -> Option<LocalReplay> {
    let mut file = tokio::fs::File::open(path).await.ok()?;
    let mut buf = vec![0u8; 4096];
    let n = file.read(&mut buf).await.ok()?;
    buf.truncate(n);
    let nl = buf.iter().position(|&b| b == b'\n')?;
    let header: Value = serde_json::from_slice(&buf[..nl]).ok()?;

    Some(LocalReplay {
        path: path.display().to_string(),
        uid: header.get("uid").and_then(Value::as_i64).map(|v| v as i32),
        map: header
            .get("mapname")
            .and_then(Value::as_str)
            .unwrap_or("unknown map")
            .to_string(),
        mod_name: header
            .get("featured_mod")
            .and_then(Value::as_str)
            .unwrap_or("faf")
            .to_string(),
        title: header
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
    })
}

/// A JSON:API document: the top-level resources plus everything the `include`
/// query param pulled in, so relationships can be resolved locally.
#[derive(Debug, Default, Deserialize)]
struct JsonApiDoc {
    #[serde(default)]
    data: Vec<JsonApiResource>,
    #[serde(default)]
    included: Vec<JsonApiResource>,
}

#[derive(Debug, Clone, Deserialize)]
struct JsonApiResource {
    #[serde(rename = "type")]
    kind: String,
    id: String,
    #[serde(default)]
    attributes: Value,
    #[serde(default)]
    relationships: Value,
}

/// `(type, id)` → the target resource, built from `included` so relationships
/// on `data` (and on other `included` resources, for the `mapVersion.map`
/// chain) resolve without a second request.
fn resource_index(included: &[JsonApiResource]) -> HashMap<(String, String), &JsonApiResource> {
    included
        .iter()
        .map(|r| ((r.kind.clone(), r.id.clone()), r))
        .collect()
}

/// Follow a to-one relationship (`relationships.<name>.data`) to its `(type, id)`.
fn rel_target(relationships: &Value, name: &str) -> Option<(String, String)> {
    let data = relationships.get(name)?.get("data")?;
    Some((
        data.get("type")?.as_str()?.to_string(),
        data.get("id")?.as_str()?.to_string(),
    ))
}

/// Follow a to-many relationship (`relationships.<name>.data`, a JSON array)
/// to its `(type, id)` pairs.
fn rel_targets(relationships: &Value, name: &str) -> Vec<(String, String)> {
    relationships
        .get(name)
        .and_then(|r| r.get("data"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    Some((
                        item.get("type")?.as_str()?.to_string(),
                        item.get("id")?.as_str()?.to_string(),
                    ))
                })
                .collect()
        })
        .unwrap_or_default()
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
/// the `mapVersion` resource rather than following into `map` — mirrors
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
/// Ratings are deliberately left `None` for now: resolving them needs a
/// further `playerStats.leaderboardRatingJournals` include we're not adding
/// this phase (see the module's replay-vault plan) — this is the one spot
/// to wire that up once it's worth the extra request weight.
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
            .and_then(Value::as_i64)
            .unwrap_or(0) as i32;
        let name = rel_target(&stat.relationships, "player")
            .and_then(|k| index.get(&k))
            .and_then(|p| p.attributes.get("login"))
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        let faction = stat
            .attributes
            .get("faction")
            .and_then(Value::as_i64)
            .map(|f| f as i32);
        by_team.entry(team).or_default().push(ReplayPlayer {
            name,
            faction,
            rating: None,
        });
    }
    let mut teams: Vec<ReplayTeam> = by_team
        .into_iter()
        .map(|(team, players)| ReplayTeam { team, players })
        .collect();
    teams.sort_by_key(|t| t.team);
    teams
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
                start_time,
                // Missing/non-bool defaults to "not available" — safer than
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
/// an mpsc queue — mirroring the Python client's `StreamWriter`, which pushes
/// server bytes onto a `Queue` from the Qt event loop and drains it on a
/// separate writer thread. FA is single-threaded and doesn't read from the
/// proxy socket while it's busy loading assets (tens of seconds at startup);
/// without this decoupling, `tcp.write_all` blocking on that meant we also
/// stopped polling the WebSocket, missed its keepalive pings, and the server
/// dropped the connection — the game then hit "Premature EOF" once it finally
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
                _ => {} // ping/pong/text — ignore
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
    // wire protocol is nominally bidirectional — see the module docs).
    let tcp_to_ws = tokio::spawn(async move {
        let mut buf = [0u8; 8192];
        loop {
            match tcp_read.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if ws_write.send(Message::Binary(buf[..n].to_vec())).await.is_err() {
                        break;
                    }
                }
            }
        }
    });

    // The session ends as soon as any leg does — the other two are aborted.
    tokio::select! {
        _ = ws_to_queue => {}
        _ = queue_to_tcp => {}
        _ = tcp_to_ws => {}
    }
}

/// `ladder1v1` isn't a real mod — the Python client folds it to `faf` when
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
    /// `(uid, display name)` pairs — mirrors the Python client's
    /// `fa.check.check`'s `sim_mods` param, which it feeds to
    /// `checkMods()`. A replay recorded with sim mods active desyncs (or,
    /// confirmed live, just hangs indefinitely past the loading screen with
    /// no error) if those mods aren't the *active* set in `game.prefs` at
    /// launch — installed alone isn't enough. Read straight from the
    /// `.fafreplay` envelope's own `sim_mods` field (present on every real
    /// vault/local file inspected) rather than re-deriving it from the
    /// compressed body's embedded Lua table the way `fa/replayparser.py`
    /// does — the envelope already carries the same `{uid: name}` map as
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
            let bytes = tokio::fs::read(path)
                .await
                .map_err(|e| format!("could not read {}: {e}", path.display()))?;
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
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|e| format!("could not read {}: {e}", path.display()))?;
    let nl = bytes
        .iter()
        .position(|&b| b == b'\n')
        .ok_or_else(|| "replay file has no header line".to_string())?;
    let header: Value = serde_json::from_slice(&bytes[..nl])
        .map_err(|e| format!("invalid replay header: {e}"))?;

    // Mirrors the Python client's `uncompress()`: `compression == "zstd"` for
    // vault-downloaded replays, anything else (including the `null` locally
    // recorded replays under `%ProgramData%\FAForever\replays` actually carry)
    // falls back to the legacy Qt `qCompress` format.
    let compression = header.get("compression").and_then(Value::as_str).unwrap_or("");
    let decompressed = if compression == "zstd" {
        zstd::stream::decode_all(&bytes[nl + 1..])
            .map_err(|e| format!("could not decompress replay: {e}"))?
    } else {
        decode_legacy_qcompress(&bytes[nl + 1..])?
    };

    let out_path = cache_dir()?.join("temp.scfareplay");
    if let Some(parent) = out_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("could not create cache dir: {e}"))?;
    }
    tokio::fs::write(&out_path, &decompressed)
        .await
        .map_err(|e| format!("could not write {}: {e}", out_path.display()))?;

    let mod_name = header
        .get("featured_mod")
        .and_then(Value::as_str)
        .unwrap_or("faf")
        .to_string();
    let uid = header.get("uid").and_then(Value::as_i64).map(|v| v as i32);
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
        game_version: game_updater::extract_game_version(&decompressed),
        map_folder: game_updater::extract_map_folder(&decompressed),
        sim_mods,
    })
}

/// Legacy `.fafreplay` body format: standard base64, decoding to Qt's
/// `qCompress` container — a 4-byte big-endian uncompressed-length prefix
/// followed by a raw zlib stream. Mirrors `qUncompress(QByteArray.fromBase64(..))`
/// in the Python client's `fa/replay.py`.
fn decode_legacy_qcompress(body: &[u8]) -> Result<Vec<u8>, String> {
    use base64::Engine as _;
    let raw = base64::engine::general_purpose::STANDARD
        .decode(body)
        .map_err(|e| format!("could not base64-decode legacy replay body: {e}"))?;
    let zdata = raw
        .get(4..)
        .ok_or_else(|| "legacy replay body is too short for a qCompress header".to_string())?;
    let mut out = Vec::new();
    flate2::read::ZlibDecoder::new(zdata)
        .read_to_end(&mut out)
        .map_err(|e| format!("could not inflate legacy replay body: {e}"))?;
    Ok(out)
}

/// Legacy `.scfareplay` files carry their mod in the filename, `<name>.<mod>.scfareplay`.
fn guess_mod_from_filename(path: &std::path::Path) -> String {
    path.file_stem()
        .and_then(|s| s.to_str())
        .and_then(|stem| stem.rsplit_once('.'))
        .map(|(_, mod_name)| mod_name.to_string())
        .unwrap_or_else(|| "faf".to_string())
}

fn cache_dir() -> Result<PathBuf, String> {
    directories::ProjectDirs::from("com", "forgeclient", "forge-client")
        .map(|dirs| dirs.cache_dir().to_path_buf())
        .ok_or_else(|| "could not resolve a cache directory".to_string())
}

/// Inert replay client — used offline and in tests. Every call fails cleanly
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
        Err("replay watching is disabled (FAF_REAL_LAUNCH not set)".to_string())
    }

    async fn play_file(&self, _path: PathBuf) -> Result<Option<String>, String> {
        Err("replay playback is disabled (FAF_REAL_LAUNCH not set)".to_string())
    }

    async fn list_vault(&self) -> Result<Vec<VaultReplay>, String> {
        Err("replay vault is disabled (FAF_REAL_LAUNCH not set)".to_string())
    }

    async fn watch_vault(&self, _uid: i32) -> Result<Option<String>, String> {
        Err("replay vault is disabled (FAF_REAL_LAUNCH not set)".to_string())
    }

    async fn list_local(&self) -> Result<Vec<LocalReplay>, String> {
        Err("local replay listing is disabled (FAF_REAL_LAUNCH not set)".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn list_local_dir_reads_headers_newest_first_and_skips_corrupt_files() {
        let dir = std::env::temp_dir().join(format!("forge-local-replays-{}", std::process::id()));
        tokio::fs::create_dir_all(&dir).await.unwrap();

        let header = |uid: i32| {
            format!(r#"{{"uid":{uid},"mapname":"scmp_009","featured_mod":"faf","title":"t{uid}"}}"#)
        };
        tokio::fs::write(dir.join("older.fafreplay"), format!("{}\nbody", header(1)))
            .await
            .unwrap();
        // Ensure a distinct, later mtime than the first file.
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        tokio::fs::write(dir.join("newer.fafreplay"), format!("{}\nbody", header(2)))
            .await
            .unwrap();
        tokio::fs::write(dir.join("corrupt.fafreplay"), b"not even json\nbody")
            .await
            .unwrap();
        tokio::fs::write(dir.join("ignored.scfareplay"), b"irrelevant extension")
            .await
            .unwrap();

        let replays = list_local_dir(&dir).await.expect("should list");
        assert_eq!(replays.len(), 2, "corrupt/wrong-extension files are skipped");
        assert_eq!(replays[0].uid, Some(2), "newest file first");
        assert_eq!(replays[0].map, "scmp_009");
        assert_eq!(replays[1].uid, Some(1));

        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn list_local_dir_missing_folder_returns_empty() {
        let dir = std::env::temp_dir().join("forge-local-replays-does-not-exist");
        let replays = list_local_dir(&dir).await.expect("missing dir is not an error");
        assert!(replays.is_empty());
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
                        "replayAvailable": true,
                    },
                    "relationships": {
                        "mapVersion": { "data": { "type": "mapVersion", "id": "9" } },
                        "featuredMod": { "data": { "type": "featuredMod", "id": "1" } },
                        "playerStats": { "data": [
                            { "type": "gamePlayerStats", "id": "100" },
                            { "type": "gamePlayerStats", "id": "101" },
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
                    "attributes": { "team": 2, "faction": 1 },
                    "relationships": { "player": { "data": { "type": "player", "id": "500" } } },
                },
                {
                    "type": "gamePlayerStats",
                    "id": "101",
                    "attributes": { "team": 3, "faction": 3 },
                    "relationships": { "player": { "data": { "type": "player", "id": "501" } } },
                },
                { "type": "player", "id": "500", "attributes": { "login": "Seraphim-Noob" } },
                { "type": "player", "id": "501", "attributes": { "login": "Nomander" } },
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
        assert_eq!(replay.reviews_average, Some(4.5));
        assert_eq!(replay.reviews_count, Some(2));
        assert_eq!(replay.teams.len(), 2);
        assert_eq!(replay.teams[0].team, 2);
        assert_eq!(replay.teams[0].players[0].name, "Seraphim-Noob");
        assert_eq!(replay.teams[0].players[0].faction, Some(1));
        assert_eq!(replay.teams[1].team, 3);
        assert_eq!(replay.teams[1].players[0].name, "Nomander");
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
        assert!(!replay.replay_available, "missing attribute defaults to unavailable");
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
        // No embedded mod segment — falls back to "faf".
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

        let replay = decode_fafreplay(&path).await.expect("should decode");
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

        let _ = tokio::fs::remove_dir_all(&dir).await;

        // Run sequentially in the same test (not a separate #[tokio::test]):
        // decode_fafreplay always writes to the same fixed cache-dir path
        // (mirroring the Python client's single fixed `temp.scfareplay`), so
        // two decodes running concurrently on the real OS cache dir would race.
        let dir = std::env::temp_dir().join(format!("forge-replay-test-{}", std::process::id() + 1));
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

        let replay = decode_fafreplay(&path).await.expect("should decode");
        assert_eq!(replay.mod_name, "faf");
        assert_eq!(replay.uid, Some(12345));
        assert_eq!(replay.game_version, Some(3828));
        assert_eq!(replay.map_folder.as_deref(), Some("adaptive_gadostb.v0002"));
        let written = tokio::fs::read(&replay.path).await.unwrap();
        assert_eq!(written, scfa_body);

        let _ = tokio::fs::remove_dir_all(&dir).await;
    }
}
