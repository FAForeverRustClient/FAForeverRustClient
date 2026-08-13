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

#[async_trait]
pub trait AuthPort: Send + Sync {
    /// Run the full interactive login flow, resolving to the authenticated
    /// player. `remember` controls whether a refresh token is retained.
    async fn login(&self, remember: bool) -> AuthResult<Player>;

    /// Restore a previously remembered session without opening a browser.
    /// Implementations return `Ok(None)` when no credentials are stored.
    async fn restore(&self) -> AuthResult<Option<Player>> {
        Ok(None)
    }

    /// Tear down the session (revoke tokens, clear stored credentials).
    async fn logout(&self) -> AuthResult<()>;
}
