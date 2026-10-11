//! Auth port: abstracts *how* a player is authenticated.
//!
//! The real impl (OAuth2 against FAF's Ory Hydra: browser flow, redirect listener,
//! token exchange, `/me` lookup) and the test/dev fake both implement this trait.
//! The auth service and the `auth` slice are identical for either one.

use async_trait::async_trait;
use faf_domain::state::Player;

/// Error from an auth operation, carrying a user-presentable message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthError {
    pub message: String,
}

impl AuthError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl std::fmt::Display for AuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for AuthError {}

pub type AuthResult<T> = Result<T, AuthError>;

/// The session contract is two-phase. [`AuthPort::login`] and
/// [`AuthPort::restore`] only *stage* the session they obtained: nothing of it
/// is visible to the rest of the client yet. The auth service decides whether
/// the attempt is still wanted (not cancelled, not superseded) and then either
/// commits it with [`AuthPort::commit_session`] or drops it with
/// [`AuthPort::discard_pending_session`]. A sign-in that is called off while
/// its profile request is in flight therefore never leaves an access token,
/// a remembered refresh token or a renewal loop behind a login screen.
#[async_trait]
pub trait AuthPort: Send + Sync {
    /// Run the full interactive login flow, resolving to the authenticated
    /// player and staging the session for [`Self::commit_session`].
    /// `remember` controls whether the refresh token is retained once the
    /// session is committed.
    async fn login(&self, remember: bool) -> AuthResult<Player>;

    /// Restore a previously remembered session without opening a browser,
    /// staging it like [`Self::login`] does. Implementations return
    /// `Ok(None)` when no credentials are stored.
    async fn restore(&self) -> AuthResult<Option<Player>> {
        Ok(None)
    }

    /// Publish the session the last successful login or restore staged: make
    /// its access token current, persist its refresh token when the user asked
    /// to be remembered, and start renewing it. Returns `false` when nothing
    /// is staged, so the caller must not announce a session.
    fn commit_session(&self) -> bool;

    /// Drop a staged session without publishing any of it. Harmless when
    /// nothing is staged.
    fn discard_pending_session(&self);

    /// Tear down the session (revoke tokens, clear stored credentials).
    async fn logout(&self) -> AuthResult<()>;
}
