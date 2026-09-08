//! Changelog boundary: FAForever/fa's published patch notes.

use async_trait::async_trait;
use faf_domain::protocol::changelog::{ChangelogEntry, ChangelogRelease};

#[async_trait]
pub trait ChangelogPort: Send + Sync {
    /// Every release the project lists, newest first.
    async fn list_releases(&self) -> Result<Vec<ChangelogRelease>, String>;

    /// One release's note.
    ///
    /// Takes the whole release rather than an id, because the index is what
    /// knows both where the document lives and which of the two it is: a dated
    /// post is Markdown under `_posts`, while a rolling branch is only complete
    /// in its built page. Handing over an id and a URL left the adapter to
    /// guess the second from the shape of the first.
    async fn load_entry(&self, release: ChangelogRelease) -> Result<ChangelogEntry, String>;
}
