//! Vault publishing boundary.
//!
//! A *streaming* port like [`MapGeneratorPort`](crate::ports::MapGeneratorPort):
//! zipping a large map and pushing it over a slow connection takes long enough
//! that the UI has to be able to say which stage it is in.

use async_trait::async_trait;
use faf_domain::state::{UploadRequest, UploadStatus};
use tokio::sync::mpsc;

#[async_trait]
pub trait UploadsPort: Send + Sync {
    /// Zip the named folder and publish it.
    ///
    /// The receiver closes when the run ends; the final [`UploadStatus`] is
    /// either `Succeeded` or `Failed`. The temporary archive is always removed,
    /// including on failure: both reference clients delete it in a `finally`.
    async fn publish(&self, request: UploadRequest) -> mpsc::Receiver<UploadStatus>;
}
