//! Client self-update: the release source and the installer handoff.
//!
//! Named `client_update` rather than `updater` because [`crate::ports::updater`]
//! is already taken by the *game* updater, which patches Forged Alliance. The
//! two share nothing: this one replaces the client itself.

use async_trait::async_trait;
use faf_domain::state::{ClientRelease, ClientReleaseNotes, ReleaseChannel};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

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

    /// Every published release's notes, newest first, whatever the channel.
    ///
    /// The releases [`Self::latest`] read are the same list, so an adapter
    /// keeps the last one it read and answers from it; only a source that has
    /// read nothing yet asks again. GitHub allows an address sixty
    /// unauthenticated API requests an hour, and this is what keeps the
    /// changelog from spending a second one on what the update check already
    /// fetched.
    ///
    /// The default is an error, so a fake port does not have to care.
    async fn release_notes(&self) -> Result<Vec<ClientReleaseNotes>, String> {
        Err("this build does not read the client's release notes".into())
    }

    /// The notes the last successful read left behind, without asking anyone:
    /// `None` when nothing has been read yet. What a check hands on after it
    /// has fetched the release list, so that answering the changelog as well
    /// can never cost a request of its own.
    fn cached_release_notes(&self) -> Option<Vec<ClientReleaseNotes>> {
        None
    }

    /// Fetch the release's installer for this platform.
    ///
    /// `called_off` stops the download at its next await. The implementation
    /// then removes what it had written, and only after that drops its sender:
    /// the receiver running dry is how the caller knows the work is over, and
    /// it waits for that before another download may write the same file.
    async fn download(
        &self,
        release: ClientRelease,
        called_off: CancellationToken,
    ) -> mpsc::Receiver<DownloadProgress>;

    /// Start the downloaded installer.
    ///
    /// Returns once it has been spawned, not once it has finished: the
    /// installer outlives the client that started it.
    async fn install(&self, path: String) -> Result<(), String>;
}
