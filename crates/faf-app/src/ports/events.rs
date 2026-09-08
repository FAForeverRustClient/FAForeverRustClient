//! Community calendar boundary.
//!
//! One read, no writes. The calendar's own write-shaped path (suggesting an
//! event) does not cross a port: it opens the catalogue repository's issue form
//! in the player's browser, the same way the training hub composes a forum post
//! rather than posting in somebody's name. See `faf_domain::state::events`.

use async_trait::async_trait;
use faf_domain::state::EventCatalogue;

#[async_trait]
pub trait EventsPort: Send + Sync {
    /// The community events catalogue.
    ///
    /// Infallible in practice: an implementation that cannot reach its manifest
    /// falls back to what shipped with the client and says so through
    /// [`EventCatalogue::source`], exactly as the training catalogue does. The
    /// `Result` is here for the case where even that is unusable, which is a
    /// packaging bug rather than a runtime condition.
    async fn list_catalogue(&self) -> Result<EventCatalogue, String>;
}
