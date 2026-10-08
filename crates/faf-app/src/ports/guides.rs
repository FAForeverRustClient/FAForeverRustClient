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
//! operation here and several requests in the implementation, because reading the
//! catalogue, patching it and closing the issue only make sense together: a
//! commit without the issue closed would leave the submission for a second
//! verdict.

use async_trait::async_trait;
use faf_domain::state::{
    GuideImage, GuideSubmission, GuidesIdentity, RejectReason, TrainingResource,
};

/// What a login that was cancelled fails with, so the service can tell a
/// cancellation (already announced by the cancel itself) from a failure worth
/// showing without matching on the wording of either.
pub const LOGIN_CANCELLED: &str = "signing in was cancelled";

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
    /// or [`Self::cancel_login`] is called. A poll that does not get through is
    /// asked again rather than ending the login. The service runs it under a
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
    ///
    /// The token is dropped only when GitHub says it is dead (a 401), and then
    /// [`Self::take_lost_session`] says so too. Any other failure keeps it, to
    /// be tried again next time: being offline once must not sign anybody out.
    async fn restore_login(&self) -> Result<Option<GuidesIdentity>, String>;

    /// Forget the stored token.
    async fn sign_out(&self);

    /// Why the stored token was dropped since the last call, if it was.
    ///
    /// Any request can be the one that learns GitHub no longer accepts the
    /// token, including a read that then quietly succeeds anonymously. The
    /// service asks after each operation so the tab stops showing a session
    /// that has ended. Taken, so it is said once.
    fn take_lost_session(&self) -> Option<String> {
        None
    }

    /// The open submissions. Needs no token: they are issues and pull requests
    /// on a public repository, so the queue is readable before anybody signs
    /// in. A pull request's guide is read at the commit it was listed at.
    async fn list_submissions(&self) -> Result<Vec<GuideSubmission>, String>;

    /// Publish a submission's entry into the catalogue and close its issue,
    /// or, for a pull request, merge it first (exactly the commit the queue
    /// read, and only when it holds nothing but the guide and its pictures).
    ///
    /// Refused by GitHub for an account that may not commit, and that refusal
    /// is the authorisation: this client's own sense of who may moderate only
    /// decides whether a button was drawn. The entry is published under an id
    /// nobody else holds, with `approved_by` set to the accepting account.
    /// Safe to call again after a failure: steps an earlier call completed are
    /// recognised and skipped, and a submission already declined is refused.
    async fn accept(&self, submission: GuideSubmission) -> Result<(), String>;

    /// Decline a submission, leaving the reason where its author reads it.
    ///
    /// Nothing is written unless the account may close the issue, and, like
    /// accepting, it is safe to call again after a failure.
    async fn reject(&self, number: i32, reason: RejectReason, note: String) -> Result<(), String>;

    /// Open a submission of our own. Returns the issue's or the pull
    /// request's address.
    ///
    /// `guide` is the guide's own text when the author wrote one here rather
    /// than linking to one, and `images` the pictures it shows, already
    /// checked. A guide is proposed as a pull request carrying the file and
    /// its pictures; a link alone, which has no file to carry, is an issue.
    /// There is no covering note beside either: the form asks for a summary
    /// and a guide, and a third free-text field with no place in the catalogue
    /// would be words nobody reads twice.
    async fn submit(
        &self,
        entry: TrainingResource,
        guide: String,
        images: Vec<GuideImage>,
    ) -> Result<String, String>;
}
