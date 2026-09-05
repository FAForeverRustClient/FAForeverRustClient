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

    /// The Markdown of a guide this build hosts, by its catalogue url.
    ///
    /// Fallible where [`Self::list_catalogue`] is not: there is no shipped copy
    /// of somebody's guide to fall back to, and a reader who is told the fetch
    /// failed can still press the button that opens it in a browser.
    ///
    /// The url is checked against the repository this build trusts before any
    /// request is made. It arrives from a manifest, and a manifest is remote
    /// content: without that check an entry could name any address it liked and
    /// have the client fetch it.
    async fn read_guide(&self, url: String) -> Result<String, String>;
}
