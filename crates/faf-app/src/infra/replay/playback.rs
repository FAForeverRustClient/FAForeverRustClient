//! Replay file playback: getting a `.fafreplay` or `.scfareplay` ready for FA
//! and launching it.
//!
//! Separate from the codec because this is where a replay meets the install:
//! the engine build it needs, its map, its sim mods, and the launch itself.
//! The install steps themselves are `preparation`'s, shared with live
//! spectating (`live`); what stays here is the launch they lead up to.
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

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash as _, Hasher as _};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use faf_domain::state::{LiveReplayTarget, ModType};
use serde_json::Value;
use tokio::io::AsyncReadExt;
use tokio::sync::Mutex;

use crate::infra::session::TokenStore;
use crate::infra::vault_install::MAX_DOWNLOAD_BYTES;
use crate::infra::{cache_dir, game_updater};
use crate::ports::{MapGeneratorPort, PreparationSink, ProcessPort, ReplayPlaybackPort};

use super::codec::decode_replay_body_to;
use super::live::LiveStreamer;
use super::names::{guess_mod_from_filename, normalize_mod};
use super::preparation::ReplayPreparation;
use super::vault::ReplayVault;
use super::ReplayConfig;

/// Launches replays: a file, a vault replay, or a live stream.
///
/// Owns the launch itself: the process port, the lock that keeps one launch
/// pipeline running at a time, and the two collaborators a launch goes
/// through, [`ReplayPreparation`] for the install and [`LiveStreamer`] for a
/// game in progress. The vault is held only to fetch a replay before
/// [`ReplayPlaybackPort::watch_vault`] plays it.
pub struct ReplayPlayback {
    tokens: TokenStore,
    process: Arc<dyn ProcessPort>,
    preparation: ReplayPreparation,
    live: LiveStreamer,
    vault: Arc<ReplayVault>,
    /// Playback preparation writes shared cache and preference files. Keep one
    /// launch pipeline active per client so concurrent UI commands cannot race.
    lock: Mutex<()>,
}

impl ReplayPlayback {
    pub fn new(
        config: &ReplayConfig,
        tokens: TokenStore,
        process: Arc<dyn ProcessPort>,
        map_generator: Arc<dyn MapGeneratorPort>,
        vault: Arc<ReplayVault>,
    ) -> Self {
        Self {
            preparation: ReplayPreparation::new(config, map_generator),
            live: LiveStreamer::new(config, tokens.clone()),
            tokens,
            process,
            vault,
            lock: Mutex::new(()),
        }
    }
}

#[async_trait]
impl ReplayPlaybackPort for ReplayPlayback {
    async fn watch_live(
        &self,
        target: LiveReplayTarget,
        player: String,
    ) -> Result<Option<String>, String> {
        let _playback_guard = self.lock.lock().await;
        self.live
            .start(&self.preparation, self.process.as_ref(), target, player)
            .await
    }

    async fn play_file(&self, path: PathBuf) -> Result<Option<String>, String> {
        self.launch_replay_file(path).await
    }

    async fn watch_vault(&self, uid: i32) -> Result<Option<String>, String> {
        let path = self.vault.download_vault_to(uid, cache_dir()?).await?;
        self.play_file(path).await
    }

    fn set_install_dir(&self, dir: Option<PathBuf>) {
        self.preparation.set_install_dir(dir);
    }

    fn set_preparation_progress(&self, sink: Option<PreparationSink>) {
        self.preparation.set_sink(sink);
    }

    fn set_live_replay_pipe(&self, enabled: bool) {
        self.live.set_pipe(enabled);
    }

    fn set_auto_generate_maps(&self, enabled: bool) {
        self.preparation.set_auto_generate_maps(enabled);
    }
}

impl ReplayPlayback {
    /// The body of [`ReplayPlaybackPort::play_file`].
    async fn launch_replay_file(&self, path: PathBuf) -> Result<Option<String>, String> {
        let _playback_guard = self.lock.lock().await;
        // Before anything is staged, not merely before the launch. The version
        // step below writes this replay's exact engine build into the replay
        // install, and doing that to a directory the previous replay's Forged
        // Alliance still has open leaves an install the next launch sits on a
        // loading screen over. See `ProcessPort::stop_replay`.
        self.process.stop_replay().await;
        let replay = prepare_scfareplay(&path).await?;
        let mod_name = normalize_mod(&replay.mod_name);
        let mut warning = None;

        let target = self.preparation.install_dir();
        if target.is_none() {
            // Every step below is skipped without it, and a replay launched
            // against an unmatched engine build opens FA on the main menu with
            // no error of its own. Say so rather than reporting success.
            tracing::warn!(
                "no replay install is configured, so the engine version and map \
                 were not prepared; FA may refuse to load this replay"
            );
        }
        if let Some(target_dir) = target.as_deref() {
            // Old replays embed the exact engine build they need; FA refuses
            // to load one that doesn't match what's installed ("Ack! Unable
            // to load game replay"). Update before every launch: cheap when
            // already current, since files are skipped on a matching MD5
            // (see infra/game_updater.rs). Unlike map staging below, there is
            // no "expected to fail" case here: every replay's embedded
            // version is exact and required, so a failure here is fatal:
            // launching anyway would just reproduce the exact crash this is
            // supposed to prevent, with no diagnostic for the user.
            let token = self
                .tokens
                .get()
                .ok_or_else(|| "not logged in".to_string())?;
            let version_info = game_updater::ReplayVersionInfo {
                mod_name: mod_name.clone(),
                game_version: replay.game_version,
                featured_mod_version: replay.featured_mod_version,
                git_sha: replay.git_sha,
                git_short_sha: replay.git_short_sha,
                build_signature: replay.build_signature,
                version_name: replay.version_name,
                launched_at: replay.launched_at,
            };
            if let Some(warn) = self
                .preparation
                .stage_replay_version(&token, target_dir, &version_info)
                .await
                .map_err(|e| format!("could not prepare game for replay: {e}"))?
            {
                warning = Some(warn);
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
                if let Some(warn) = self
                    .preparation
                    .ensure_replay_map(target_dir, map_folder)
                    .await?
                {
                    warning = Some(warn);
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
        //
        // For the length of the replay only. The player's own set is kept
        // aside and written back when the replay window closes (#343), so a
        // game hosted afterwards is not quietly carrying the replay's mods.
        let mut replay_mods_generation = None;
        if replay.sim_mods.is_empty() {
            crate::infra::mods::restore_own_mods_after_replay(None).await;
        } else {
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
                    let own_uids: Vec<String> = installed
                        .iter()
                        .filter(|m| m.enabled)
                        .map(|m| m.uid.clone())
                        .collect();
                    match crate::infra::mods::activate_replay_mods(own_uids, &active_uids).await {
                        Ok(generation) => replay_mods_generation = Some(generation),
                        Err(e) => {
                            warning = Some(format!("could not set this replay's active mods: {e}"))
                        }
                    }
                    if replay_mods_generation.is_some() && !missing.is_empty() {
                        let names: Vec<&str> =
                            missing.iter().map(|(_, name)| name.as_str()).collect();
                        warning = Some(format!("missing mod(s): {}", names.join(", ")));
                    }
                }
                Err(e) => warning = Some(format!("could not check installed mods: {e}")),
            }
        }

        let log_path = crate::infra::game_logs::next_path("replay", replay.uid)?;
        // Both of these are files on this machine that a Windows executable
        // has to open, so both are spelled the way that executable will see
        // them: identical on Windows, a `Z:` path under Wine.
        let mut args = vec![
            "/replay".to_string(),
            self.process.game_argument_path(&replay.path),
            "/init".to_string(),
            format!("init_{mod_name}.lua"),
            "/nobugreport".to_string(),
            // Mirrors the Python client passing `/log "<LOG_FILE_REPLAY>"`,
            // without it FA writes no log at all, so a hang like the one
            // this session spent a long time diagnosing blind is otherwise
            // completely opaque (no crash, no stderr, nothing on disk).
            "/log".to_string(),
            self.process.game_argument_path(&log_path),
        ];
        if let Some(uid) = replay.uid {
            args.push("/replayid".to_string());
            args.push(uid.to_string());
        }
        if let Err(reason) = self.process.launch_replay(args).await {
            // Nothing is playing the replay, so nothing needs its mods.
            if let Some(generation) = replay_mods_generation {
                crate::infra::mods::restore_own_mods_after_replay(Some(generation)).await;
            }
            return Err(reason);
        }
        if let Some(generation) = replay_mods_generation {
            // Watched by polling, the way `GameProcess` watches the process
            // itself: a replay lasts minutes, and a second or two of delay on
            // the way back to the player's own mods costs nothing.
            let process = self.process.clone();
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    if !process.replay_running() {
                        crate::infra::mods::restore_own_mods_after_replay(Some(generation)).await;
                        return;
                    }
                }
            });
        }
        Ok(warning)
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
    /// An overlay's own revision; see `ReplayVersionInfo::featured_mod_version`.
    featured_mod_version: Option<i32>,
    map_folder: Option<String>,
    sim_mods: Vec<(String, String)>,
    git_sha: Option<String>,
    git_short_sha: Option<String>,
    build_signature: Option<String>,
    version_name: Option<String>,
    launched_at: Option<u64>,
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
                featured_mod_version: None,
                map_folder: game_updater::extract_map_folder(&bytes),
                sim_mods: Vec::new(),
                git_sha: None,
                git_short_sha: None,
                build_signature: None,
                version_name: None,
                launched_at: None,
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
    let git_sha = header
        .get("git_sha")
        .and_then(Value::as_str)
        .map(String::from);
    let git_short_sha = header
        .get("git_short_sha")
        .and_then(Value::as_str)
        .map(String::from);
    let build_signature = header
        .get("build_signature")
        .and_then(Value::as_str)
        .map(String::from);
    let version_name = header
        .get("version_name")
        .and_then(Value::as_str)
        .map(String::from);
    let launched_at = header
        .get("launched_at")
        .and_then(Value::as_f64)
        .map(|f| f as u64);

    Ok(ScfaReplay {
        path: out_path,
        mod_name,
        uid,
        game_version: game_updater::extract_game_version(&decompressed_prefix),
        featured_mod_version: overlay_version_from_header(&header),
        map_folder: game_updater::extract_map_folder(&decompressed_prefix),
        sim_mods,
        git_sha,
        git_short_sha,
        build_signature,
        version_name,
        launched_at,
    })
}

/// The overlay revision a `.fafreplay` header names: the highest of its
/// `featured_mod_versions`, as the Python client's `FilesObtainer` takes it.
/// Values are numbers in current replays; numeric strings are read too.
fn overlay_version_from_header(header: &Value) -> Option<i32> {
    header
        .get("featured_mod_versions")?
        .as_object()?
        .values()
        .filter_map(|value| match value {
            Value::Number(number) => number.as_i64(),
            Value::String(text) => text.trim().parse().ok(),
            _ => None,
        })
        .filter_map(|version| i32::try_from(version).ok())
        .max()
}

const REPLAY_METADATA_PREFIX_BYTES: usize = 64 * 1024;

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_overlay_revision_is_the_highest_featured_mod_version() {
        let header = serde_json::json!({
            "featured_mod": "nomads",
            "featured_mod_versions": { "1": 50, "2": "52", "3": null },
        });
        assert_eq!(overlay_version_from_header(&header), Some(52));
        assert_eq!(
            overlay_version_from_header(&serde_json::json!({ "featured_mod": "faf" })),
            None
        );
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
        let mut file = br#"{"compression":null,"featured_mod":"faf","featured_mod_version":123,"uid":777,"sim_mods":{"abc-123":"Economy Unit Logger"}}"#.to_vec();
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
