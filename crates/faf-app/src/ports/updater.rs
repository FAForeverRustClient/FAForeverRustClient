//! Game updater port: getting the install ready for a specific game.
//!
//! A live game is not launchable just because FA is installed: the server
//! expects the client to be on the current featured-mod build, and to already
//! have the map. Both reference clients do this work before every game (Java's
//! `GameRunner::prepareAndLaunchGameWhenReady`, the Python client's
//! `fa.check.check`), and both treat a failure as a launch failure rather than
//! trying to start anyway.
//!
//! A *streaming* boundary like [`MapGeneratorPort`](crate::ports::MapGeneratorPort)
//! for the same reason: a balance patch is hundreds of files over a slow CDN,
//! and a client that just freezes for two minutes looks broken.

use async_trait::async_trait;
use tokio::sync::mpsc;

/// What a pending launch needs on disk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GamePreparation {
    /// The featured mod to patch to the newest published build (`faf`,
    /// `nomads`, …). Overlay mods pull their base install in themselves.
    pub featured_mod: String,
    /// The map the game will load, if the launch order named one. Generated
    /// maps are handled separately (see `infra::map_generator`): this is the
    /// vault-download path.
    pub map_folder: Option<String>,
}

/// One user-visible preparation step. `progress` is absent for work whose
/// length the transport cannot know (API lookup, map archive download) and a
/// measured percentage for featured-mod file sets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparationStep {
    pub detail: String,
    pub progress: Option<u8>,
}

impl PreparationStep {
    pub fn indeterminate(detail: impl Into<String>) -> Self {
        Self {
            detail: detail.into(),
            progress: None,
        }
    }

    pub fn counted(detail: impl Into<String>, completed: usize, total: usize) -> Self {
        Self {
            detail: detail.into(),
            progress: (total > 0).then(|| ((completed.min(total) * 100) / total) as u8),
        }
    }
}

/// One step of a preparation run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateProgress {
    /// A user-facing description of what is happening now. Replaces the
    /// previous one; this is a status line, not a log.
    Step(PreparationStep),
    /// The run ended. Sent exactly once, last, and always: including when
    /// nothing needed doing.
    Finished(Result<(), String>),
}

#[async_trait]
pub trait GameUpdaterPort: Send + Sync {
    /// Patch the featured mod and stage the map, streaming progress.
    ///
    /// The receiver closes after [`UpdateProgress::Finished`]. Idempotent and
    /// cheap when the install is already current: files matching by MD5 are
    /// skipped and a present map is not re-downloaded: so the launch path
    /// calls it unconditionally rather than trying to guess whether an update
    /// is due, exactly as both reference clients do.
    async fn prepare(&self, request: GamePreparation) -> mpsc::Receiver<UpdateProgress>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counted_progress_is_bounded_and_handles_unknown_totals() {
        assert_eq!(PreparationStep::counted("start", 0, 4).progress, Some(0));
        assert_eq!(PreparationStep::counted("half", 2, 4).progress, Some(50));
        assert_eq!(PreparationStep::counted("done", 9, 4).progress, Some(100));
        assert_eq!(PreparationStep::counted("unknown", 0, 0).progress, None);
    }
}
