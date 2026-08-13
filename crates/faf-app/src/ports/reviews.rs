//! Vault review boundary: the client's only read/write API surface.

use async_trait::async_trait;
use faf_domain::state::{Review, ReviewKind};

/// A subject's reviews, plus where a new one would be posted.
pub struct ReviewPage {
    pub reviews: Vec<Review>,
    /// The newest version's id. A review belongs to a *version*, not to the
    /// map or mod, and a new one always goes on the latest: reviewing an old
    /// version is possible in the data model but neither reference client
    /// offers it. `None` when the subject has no versions, which makes it
    /// unreviewable.
    pub latest_version_id: Option<i32>,
}

#[async_trait]
pub trait ReviewsPort: Send + Sync {
    /// Every review across every version of one map or mod.
    async fn list(&self, kind: ReviewKind, subject_id: i32) -> Result<ReviewPage, String>;

    /// Post a new review against a version. Returns the created review.
    async fn create(
        &self,
        kind: ReviewKind,
        version_id: i32,
        score: i32,
        text: String,
    ) -> Result<Review, String>;

    /// Replace the score and text of an existing review.
    async fn update(
        &self,
        kind: ReviewKind,
        review_id: i32,
        score: i32,
        text: String,
    ) -> Result<(), String>;

    /// Withdraw a review.
    async fn delete(&self, kind: ReviewKind, review_id: i32) -> Result<(), String>;
}
