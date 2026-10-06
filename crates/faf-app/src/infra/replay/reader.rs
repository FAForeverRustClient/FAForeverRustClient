//! Reading one replay in depth, on request: finding its file and handing it to
//! the detail parser or the analyser.
//!
//! Separate from the library because the file may not be in the library at
//! all: the caller's own path, the two caches and the vault are all places it
//! can come from, in that order. Parsing what is in it is `details` and
//! `crate::infra::replay_analysis`.

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use faf_domain::state::{ReplayAnalysis, ReplayDetails};

use crate::infra::cache_dir;
use crate::ports::ReplayDetailsPort;

use super::codec::read_replay_header_and_body;
use super::details::read_detailed_info;
use super::library::ReplayLibrary;
use super::names::is_replay_file_name;
use super::vault::ReplayVault;

/// Finds a replay's file and reads it past the header.
pub struct ReplayReader {
    /// Checked before the vault, so a replay the user already has is not
    /// fetched again.
    library: ReplayLibrary,
    /// The last resort, for a replay that is on disk nowhere.
    vault: Arc<ReplayVault>,
}

impl ReplayReader {
    pub fn new(library: ReplayLibrary, vault: Arc<ReplayVault>) -> Self {
        Self { library, vault }
    }

    /// The file to read for one replay: the caller's own path when it named
    /// one, then the two caches, then the vault.
    ///
    /// The webview supplies that path, and it reached the parser unchecked:
    /// any readable file could be handed in and read as a replay. `OpenFile`
    /// is already narrowed by `prepare_scfareplay`, which refuses an
    /// unrecognised extension; this is the same gate for the other door.
    ///
    /// Extension rather than directory, because a replay opened from the file
    /// picker is legitimately outside the library, and the picking is the
    /// user's own authorisation.
    async fn replay_file_for(
        &self,
        uid: i32,
        local_path: Option<PathBuf>,
    ) -> Result<PathBuf, String> {
        if let Some(path) = local_path.filter(|p| p.exists() && is_replay_file_name(p)) {
            return Ok(path);
        }
        let cached_scfa = cache_dir()?.join(format!("{uid}.scfareplay"));
        if cached_scfa.exists() {
            return Ok(cached_scfa);
        }
        let local_faf = self.library.directory().join(format!("{uid}.fafreplay"));
        if local_faf.exists() {
            return Ok(local_faf);
        }
        let cached_faf = cache_dir()?.join(format!("{uid}.fafreplay"));
        if cached_faf.exists() {
            return Ok(cached_faf);
        }
        self.vault.download_vault_to(uid, cache_dir()?).await
    }
}

#[async_trait]
impl ReplayDetailsPort for ReplayReader {
    async fn load_details(
        &self,
        uid: i32,
        local_path: Option<PathBuf>,
    ) -> Result<ReplayDetails, String> {
        let path = self.replay_file_for(uid, local_path).await?;

        // Detail loading is intentionally deferred until the user asks for it,
        // but once requested it must expose the complete replay metadata: game
        // options, in-game chat, and the FAF version.
        read_detailed_info(&path).await
    }

    async fn load_analysis(
        &self,
        uid: i32,
        local_path: Option<PathBuf>,
    ) -> Result<ReplayAnalysis, String> {
        let path = self.replay_file_for(uid, local_path).await?;
        tokio::task::spawn_blocking(move || {
            let (_, body) = read_replay_header_and_body(&path)?;
            Ok(crate::infra::replay_analysis::analyse_replay_body(
                uid, &body,
            ))
        })
        .await
        .map_err(|error| format!("could not read the replay: {error}"))?
    }
}
