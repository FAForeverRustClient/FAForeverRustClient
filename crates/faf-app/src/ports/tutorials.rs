//! Tutorials API boundary.

use async_trait::async_trait;
use faf_domain::state::{Tutorial, TutorialCategory};

#[async_trait]
pub trait TutorialsPort: Send + Sync {
    /// Every category and the lessons in them.
    ///
    /// One call for both: the API nests tutorials inside their categories, so
    /// splitting this would mean fetching the same document twice.
    async fn list_tutorials(&self) -> Result<(Vec<TutorialCategory>, Vec<Tutorial>), String>;
}
