//! Real replay adapters: the vault, the local library, detail reads, file
//! playback and live spectating.
//!
//! Mirrors the Python client's `fa/replaylivestreamer.py`/`fa/replay.py`.
//!
//! This file holds the shared configuration and [`ReplayAdapters`], which
//! builds one collaborator per replay port from it. Each collaborator owns
//! only the state it uses and can be built on its own in a test:
//!
//! - [`ReplayVault`] (`vault`): the remote vault: searches, paging, downloads,
//!   featured mods. Rows from the API's documents are `vault_rows`.
//! - [`ReplayLibrary`] (`library`): the local replay folder: listing,
//!   metadata, deletion.
//! - [`ReplayReader`] (`reader`): finding one replay's file for the detail and
//!   analysis reads; `details` parses game options, chat and command counts
//!   from a whole body.
//! - [`ReplayPlayback`] (`playback`): preparing a replay file and launching FA
//!   on it, with `preparation` (the replay install: engine build and map) and
//!   `live` (spectating a game in progress through the replay server).
//!
//! Below them, with no state of their own: `codec` (the `.fafreplay`
//! container), `scfa_header` (the `.scfareplay` stream's header), and `names`
//! (what a replay's file and mod names say). `fake` is the offline stand-in
//! for all four ports.

use std::path::PathBuf;
use std::sync::Arc;

use crate::infra::env_or;
use crate::infra::session::TokenStore;
use crate::ports::{MapGeneratorPort, ProcessPort};

mod codec;
mod details;
mod fake;
mod library;
mod live;
mod names;
mod playback;
mod preparation;
mod reader;
mod scfa_header;
#[cfg(test)]
mod test_support;
mod vault;
mod vault_rows;

pub use details::parse_detailed_info_from_body;
pub use fake::FakeReplay;
pub(crate) use library::local_replays_dir;
pub use library::{validated_local_replay_path, ReplayLibrary, LOCAL_REPLAY_PAGE_LIMIT};
pub use playback::ReplayPlayback;
pub use reader::ReplayReader;
pub(crate) use scfa_header::{parse_replay_lua, replay_string, replay_u32, replay_u8};
pub use vault::ReplayVault;

/// The endpoints and install every replay collaborator is built from. Each
/// takes the fields it needs and keeps no reference to the rest.
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

/// The four replay collaborators, wired the way the real client uses them:
/// one library, and one vault that the reader and playback fetch through, so
/// the vault's download lock covers every caller.
pub struct ReplayAdapters {
    pub vault: Arc<ReplayVault>,
    pub library: Arc<ReplayLibrary>,
    pub reader: Arc<ReplayReader>,
    pub playback: Arc<ReplayPlayback>,
}

impl ReplayAdapters {
    pub fn new(
        config: &ReplayConfig,
        tokens: TokenStore,
        process: Arc<dyn ProcessPort>,
        map_generator: Arc<dyn MapGeneratorPort>,
    ) -> Self {
        let library = ReplayLibrary::shared();
        let vault = Arc::new(ReplayVault::new(config, tokens.clone(), library.clone()));
        Self {
            reader: Arc::new(ReplayReader::new(library.clone(), vault.clone())),
            playback: Arc::new(ReplayPlayback::new(
                config,
                tokens,
                process,
                map_generator,
                vault.clone(),
            )),
            library: Arc::new(library),
            vault,
        }
    }

    pub fn faf(
        tokens: TokenStore,
        process: Arc<dyn ProcessPort>,
        map_generator: Arc<dyn MapGeneratorPort>,
    ) -> Self {
        Self::new(&ReplayConfig::faf(), tokens, process, map_generator)
    }
}
