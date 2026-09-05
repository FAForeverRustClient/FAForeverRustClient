//! The training catalogue's repository boundary.
//!
//! Unlike every other read port here, this one also writes, and the write is
//! authorised by an identity that is **not** the FAF account: the catalogue
//! lives in a Git repository, so committing to it is a GitHub operation. That
//! is the whole reason this is its own port rather than part of
//! [`TrainingPort`](crate::ports::TrainingPort), which only reads the published
//! document and needs no credentials at all.
//!
//! The trait is shaped in operations a trainer would recognise (accept this,
//! reject this with a reason) rather than in HTTP calls. Accepting is one
//! operation here and three requests in the implementation, because reading the
//! catalogue, patching it and closing the issue only make sense together: a
//! commit without the issue closed would leave the submission for a second
//! verdict.

use async_trait::async_trait;
use faf_domain::state::{GuideSubmission, GuidesIdentity, RejectReason, TrainingResource};

/// A device-flow login GitHub has just issued.
///
/// `device_code` is the client's half and never reaches the screen; the user
/// code and URL are what the player is shown.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceCode {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    /// Seconds until the code stops working.
    pub expires_in: u32,
    /// Seconds GitHub asks us to wait between polls. Honoured rather than
    /// guessed: polling faster is answered with `slow_down` and a penalty.
    pub interval: u32,
}

#[async_trait]
pub trait GuidesPort: Send + Sync {
    /// The repository being maintained, `owner/name`.
    fn repo(&self) -> String;

    /// Whether an OAuth client id is configured, and therefore whether signing
    /// in can be offered at all.
    ///
    /// Reported rather than inferred from a failed login: a maintainer looking
    /// for the accept button should learn that this client was never told which
    /// app to use, which is a deployment fact.
    fn configured(&self) -> bool;

    /// Ask GitHub for a device code.
    async fn begin_login(&self) -> Result<DeviceCode, String>;

    /// Wait for the player to authorise the code, then resolve who they are.
    ///
    /// Long-running by nature: it polls until GitHub answers, the code expires,
    /// or [`Self::cancel_login`] is called. The service runs it under a
    /// single-flight guard so two logins cannot poll at once.
    async fn complete_login(&self, code: DeviceCode) -> Result<GuidesIdentity, String>;

    /// Abandon a login in progress. Nothing is revoked because nothing was
    /// granted; this only stops the polling.
    fn cancel_login(&self);

    /// Whoever a stored token belongs to.
    ///
    /// `Ok(None)` when there was no stored token at all, which is the ordinary
    /// case and not worth a word on screen. `Err` when there was one and it
    /// could not be used: that is worth saying, because otherwise a session
    /// that expired overnight looks exactly like never having signed in, and
    /// the maintainer wonders why the tab forgot them.
    async fn restore_login(&self) -> Result<Option<GuidesIdentity>, String>;

    /// Forget the stored token.
    async fn sign_out(&self);

    /// The open submissions. Needs no token: they are issues on a public
    /// repository, so the queue is readable before anybody signs in.
    async fn list_submissions(&self) -> Result<Vec<GuideSubmission>, String>;

    /// Publish a submission's entry into the catalogue and close its issue.
    ///
    /// Refused by GitHub for an account that may not commit, and that refusal
    /// is the authorisation: this client's own sense of who may moderate only
    /// decides whether a button was drawn.
    async fn accept(&self, submission: GuideSubmission) -> Result<(), String>;

    /// Decline a submission, leaving the reason where its author reads it.
    async fn reject(&self, number: i32, reason: RejectReason, note: String) -> Result<(), String>;

    /// Open a submission of our own. Returns the issue's address.
    ///
    /// `guide` is the guide's own text when the author wrote one here rather
    /// than linking to one; accepting commits it as a file and points the
    /// catalogue entry at it. There is no covering note beside it: the form
    /// asks for a summary and a guide, and a third free-text field with no
    /// place in the catalogue would be words nobody reads twice.
    async fn submit(&self, entry: TrainingResource, guide: String) -> Result<String, String>;
}
