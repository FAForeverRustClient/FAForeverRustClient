//! The game logs the client keeps, as a moderation report needs them.
//!
//! A port so the reporting service never builds a path into the log folder or
//! reads the environment for the user's names itself, and so a test can hand
//! it a log without one being on disk.

use async_trait::async_trait;
use faf_domain::state::ReportLogExcerpt;

#[async_trait]
pub trait GameLogsPort: Send + Sync {
    /// A bounded, sanitised excerpt of the log of `game_id`, or of the most
    /// recent online game when no log of that game is kept (also when
    /// `game_id` is `None`). `Ok(None)` when no online game's log is kept at
    /// all, which is the normal state before the first game.
    ///
    /// Built by [`faf_domain::protocol::report_log::build_excerpt`], so every
    /// adapter takes the same things out and keeps to the same limits.
    async fn report_excerpt(
        &self,
        game_id: Option<i32>,
    ) -> Result<Option<ReportLogExcerpt>, String>;
}
