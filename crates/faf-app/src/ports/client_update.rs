//! Client self-update: the release source and the installer handoff.
//!
//! Named `client_update` rather than `updater` because [`crate::ports::updater`]
//! is already taken by the *game* updater, which patches Forged Alliance. The
//! two share nothing: this one replaces the client itself.

use async_trait::async_trait;
use faf_domain::state::{ClientRelease, ReleaseChannel};
use tokio::sync::mpsc;

/// Progress of an installer download.
///
/// Mirrors the shape used by the game updater and the vault uploader: a stream
/// that always ends in a terminal variant, so a consumer that sees the channel
/// close without one knows the producer died rather than succeeded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DownloadProgress {
    Received {
        received_bytes: u32,
        /// Zero when the server did not send a `Content-Length`.
        total_bytes: u32,
    },
    /// The path the installer was written to, or why it could not be.
    Finished(Result<String, String>),
}

#[async_trait]
pub trait ClientUpdatePort: Send + Sync {
    /// The newest release on `channel`, or `None` when the source has none that
    /// this client can read.
    ///
    /// `Ok(None)` and `Err` are different answers on purpose: "there is no
    /// newer release" is a normal result to show as *up to date*, while a
    /// failed request must not be reported as being current.
    async fn latest(&self, channel: ReleaseChannel) -> Result<Option<ClientRelease>, String>;

    /// Fetch the release's installer for this platform.
    async fn download(&self, release: ClientRelease) -> mpsc::Receiver<DownloadProgress>;

    /// Start the downloaded installer.
    ///
    /// Returns once it has been spawned, not once it has finished: the
    /// installer outlives the client that started it.
    async fn install(&self, path: String) -> Result<(), String>;
}
