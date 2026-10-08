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
        self.vault
            .download_vault_to(uid, cache_dir()?, &|_, _| {})
            .await
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
        in_two_stages(
            move || read_replay_header_and_body(&path).map(|(_, body)| body),
            move |body| crate::infra::replay_analysis::analyse_replay_body(uid, &body),
        )
        .await
    }
}

/// Run `read` and then `analyse` on the blocking pool, as two tasks rather
/// than one.
///
/// A caller that stops waiting (the replay service drops this future when a
/// newer analysis replaces the request) cannot stop a blocking task that has
/// started, but it can keep the next one from starting. Reading and
/// decompressing the file is the first stage; walking the command stream, the
/// longer of the two, is the second, and a read called off during the first
/// never begins it.
async fn in_two_stages<B: Send + 'static, T: Send + 'static>(
    read: impl FnOnce() -> Result<B, String> + Send + 'static,
    analyse: impl FnOnce(B) -> T + Send + 'static,
) -> Result<T, String> {
    let body = tokio::task::spawn_blocking(read)
        .await
        .map_err(|error| format!("could not read the replay: {error}"))??;
    tokio::task::spawn_blocking(move || analyse(body))
        .await
        .map_err(|error| format!("could not read the replay: {error}"))
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    use super::in_two_stages;

    /// A read called off while its file is still being read never walks it.
    /// Both stages used to run in one blocking task, so dropping the read
    /// stopped nothing: the walk ran to its end for an answer nobody kept.
    #[tokio::test]
    async fn an_analysis_called_off_during_its_read_never_starts_the_walk() {
        /// Says when the walk is gone, whether it ran first or not.
        struct Gone(Option<tokio::sync::oneshot::Sender<()>>);
        impl Drop for Gone {
            fn drop(&mut self) {
                if let Some(gone) = self.0.take() {
                    let _ = gone.send(());
                }
            }
        }

        let (reading, read_started) = tokio::sync::oneshot::channel::<()>();
        let (release, held) = std::sync::mpsc::channel::<()>();
        let (gone, walk_gone) = tokio::sync::oneshot::channel::<()>();
        let walked = Arc::new(AtomicBool::new(false));

        let stages = {
            let walked = walked.clone();
            let gone = Gone(Some(gone));
            tokio::spawn(in_two_stages(
                move || {
                    let _ = reading.send(());
                    let _ = held.recv();
                    Ok(vec![1_u8, 2, 3])
                },
                move |body: Vec<u8>| {
                    let _gone = gone;
                    walked.store(true, Ordering::SeqCst);
                    body.len()
                },
            ))
        };
        read_started.await.expect("the read began");
        // The caller stops waiting while the file is being read, and the read
        // then finishes on its own.
        stages.abort();
        assert!(stages.await.unwrap_err().is_cancelled());
        release.send(()).unwrap();

        // The walk is gone either way: run and finished, or dropped unrun.
        walk_gone.await.expect("the walk is dropped");
        assert!(
            !walked.load(Ordering::SeqCst),
            "the walk ran for a read that was called off"
        );
    }

    /// Not called off: both stages run, in order, and the walk gets the body.
    #[tokio::test]
    async fn an_analysis_left_alone_reads_then_walks() {
        let walked = in_two_stages(|| Ok(vec![1_u8, 2, 3]), |body: Vec<u8>| body.len()).await;
        assert_eq!(walked, Ok(3));
        let refused = in_two_stages(
            || Err::<Vec<u8>, _>("truncated".to_string()),
            |body| body.len(),
        )
        .await;
        assert_eq!(refused, Err("truncated".to_string()));
    }
}
