//! Training catalogue boundary.
//!
//! One read, no writes. The two write-shaped things the training hub does
//! (requesting a replay review, submitting content) do not cross a port at
//! all: they compose a forum post the player sends themselves, because FAF has
//! no endpoint that would accept either and posting in someone's name is not
//! something this client does. See `faf_domain::state::training`.

use async_trait::async_trait;
use faf_domain::state::TrainingCatalogue;

#[async_trait]
pub trait TrainingPort: Send + Sync {
    /// The catalogue of training material and the community destinations.
    ///
    /// Infallible in practice: an implementation that cannot reach its manifest
    /// falls back to what shipped with the client and says so through
    /// [`TrainingCatalogue::source`]. The `Result` is here for the case where
    /// even that is unusable, which is a packaging bug rather than a runtime
    /// condition.
    async fn list_catalogue(&self) -> Result<TrainingCatalogue, String>;
}
