//! Changelog boundary: FAForever/fa's published patch notes.

use async_trait::async_trait;
use faf_domain::protocol::changelog::{ChangelogEntry, ChangelogRelease};

#[async_trait]
pub trait ChangelogPort: Send + Sync {
    /// Every release the project lists, newest first.
    async fn list_releases(&self) -> Result<Vec<ChangelogRelease>, String>;

    /// One release's note.
    ///
    /// Takes the source URL rather than deriving it from `id`, because the
    /// index is what knows where a release's Markdown lives: dated posts and
    /// the two rolling branches sit in different directories.
    async fn load_entry(&self, id: String, source_url: String) -> Result<ChangelogEntry, String>;
}
