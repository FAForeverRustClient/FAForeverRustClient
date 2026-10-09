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

    /// Call off the publish that is running, if it can still be stopped.
    ///
    /// Only raises a flag; the run decides. While the archive is packed or
    /// its bytes are still going out, the run stops, drops the request
    /// mid-transfer, deletes the temporary archive, and ends its stream with
    /// [`UploadStatus::Idle`] instead of an outcome. Once the server can have
    /// the whole archive (every byte of a map sent, or a mod's storage upload
    /// being confirmed), stopping could no longer keep it out of the vault,
    /// so the run ignores the flag and ends as it would have. Defaults to
    /// doing nothing, which a stub that publishes nothing needs.
    fn cancel_publish(&self) {}

    /// The preview image inside the map folder this request names, as a data
    /// URL, or an empty string when there is none to read.
    ///
    /// A map being uploaded for the first time has no vault entry, so it has no
    /// vault thumbnail either: the only picture of it in existence is the one
    /// inside its own `.scmap`. Never an error: a dialog without a picture is
    /// still a working dialog, and a map with an unreadable preview is not a
    /// map that cannot be published.
    async fn map_preview(&self, request: UploadRequest) -> String;

    /// The name the vault will file this upload under, read from the folder:
    /// `name` in a mod's `mod_info.lua`, or in a map's `_scenario.lua`.
    ///
    /// The vault reads the name out of the archive, not out of the folder it
    /// was zipped from, so a folder picked from disk is only known by the
    /// wrong name until this has been asked. `None` when there is nothing to
    /// read, and the caller keeps what it had.
    async fn subject_name(&self, _request: UploadRequest) -> Option<String> {
        None
    }
}
