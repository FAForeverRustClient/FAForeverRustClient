//! Replay port: watching a live game or a local replay file.
//!
//! The impl fetches the replay-access relay (live) or decompresses a file,
//! then launches the game via [`crate::ports::ProcessPort::launch_replay`].
//! See `infra/replay.rs` for the real implementation and its protocol notes.

use std::path::PathBuf;

use async_trait::async_trait;
use faf_domain::state::{LiveReplayTarget, LocalReplay, ReplayQuery, VaultReplay};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultSearchResult {
    pub replays: Vec<VaultReplay>,
    pub total_pages: Option<i32>,
    pub total_records: Option<i32>,
}

#[async_trait]
pub trait ReplayPort: Send + Sync {
    /// Watch a game currently in progress. `player` is the identifier sent in
    /// the replay-server handshake: the server merges all players' streams,
    /// so any non-empty string works (mirrors the Python client's comment in
    /// `replaylivestreamer.py`). Same `Ok(Some(warning))`/`Err` meaning as
    /// [`Self::play_file`] (e.g. a custom map that couldn't be staged).
    async fn watch_live(
        &self,
        target: LiveReplayTarget,
        player: String,
    ) -> Result<Option<String>, String>;

    /// Play back a local `.fafreplay` (or legacy `.scfareplay`) file.
    ///
    /// `Ok(Some(warning))` means playback was launched but a non-fatal prep
    /// step failed (e.g. the replay's map couldn't be staged): FA may still
    /// misbehave (stuck loading screen) even though this call "succeeded".
    /// `Err` means playback did not launch at all (e.g. the engine version
    /// couldn't be matched, which FA always refuses to load).
    async fn play_file(&self, path: PathBuf) -> Result<Option<String>, String>;

    /// Search the vault (FAF Data API `/data/game`). A default [`ReplayQuery`]
    /// is the unfiltered newest-first feed: the Java client's `NEWEST`
    /// category: so this covers browsing and searching alike.
    async fn search_vault(&self, query: ReplayQuery) -> Result<VaultSearchResult, String>;

    /// Featured mod technical names (`/data/featuredMod`), for the search
    /// form's mod filter. Both reference clients populate the same dropdown
    /// from the same endpoint rather than hardcoding the list.
    async fn list_featured_mods(&self) -> Result<Vec<String>, String>;

    /// Download a vault replay by game id and play it (delegates to
    /// [`Self::play_file`] once downloaded: same `Ok(Some(warning))`/`Err`
    /// meaning).
    async fn watch_vault(&self, uid: i32) -> Result<Option<String>, String>;

    /// Download a vault replay into the shared local replay directory without
    /// launching the game, returning its lightweight library metadata.
    async fn download_vault(&self, uid: i32) -> Result<LocalReplay, String>;

    /// List `.fafreplay` files in the shared FAF replay folder (mirrors the
    /// Java client's `LocalReplayVaultController`).
    /// `limit` bounds how many of the newest files have their headers read.
    /// Every replay is still listed; the ones past the limit carry only what
    /// the directory entry gave, which is why the caller can ask for more.
    async fn list_local(&self, limit: usize) -> Result<Vec<LocalReplay>, String>;

    /// Delete a replay previously returned by [`Self::list_local`].
    async fn delete_local(&self, path: PathBuf) -> Result<(), String>;

    /// Point the replay preparation steps at the install that will actually be
    /// launched. `None` when no replay install is configured.
    ///
    /// Called by the settings service whenever the paths change, for the same
    /// reason [`crate::ports::ProcessPort::game_install_dir`] exists: before
    /// this, the directory came from `FAF_REPLAY_GAME_PATH` read once at
    /// startup, so a user who chose their replay install in Settings (the only
    /// way the UI offers) left it `None`. Every preparation step, the engine
    /// version match included, is skipped when it is `None`, and FA then opens
    /// a replay it cannot load and drops the user on the main menu with no
    /// error anywhere.
    fn set_install_dir(&self, dir: Option<PathBuf>);
}
