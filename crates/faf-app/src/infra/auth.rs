//! Fake auth provider — simulates the login flow without any network.
//!
//! Stands in for the real OAuth2 provider during Phase 3 and in tests. Configure
//! it to succeed (default) or fail, with an optional delay to mimic latency.

use std::time::Duration;

use async_trait::async_trait;
use faf_domain::state::Player;

use crate::ports::{AuthError, AuthPort, AuthResult};

#[derive(Debug, Clone)]
pub struct FakeAuth {
    /// Player returned on a successful login.
    pub player: Player,
    /// Simulated latency of the login flow.
    pub delay: Duration,
    /// If set, `login` fails with this message instead of succeeding.
    pub fail_with: Option<String>,
}

impl Default for FakeAuth {
    fn default() -> Self {
        Self {
            player: Player {
                id: 42,
                name: "TestCommander".into(),
            },
            delay: Duration::from_millis(400),
            fail_with: None,
        }
    }
}

#[async_trait]
impl AuthPort for FakeAuth {
    async fn login(&self) -> AuthResult<Player> {
        if !self.delay.is_zero() {
            tokio::time::sleep(self.delay).await;
        }
        match &self.fail_with {
            Some(message) => Err(AuthError::new(message.clone())),
            None => Ok(self.player.clone()),
        }
    }

    async fn logout(&self) -> AuthResult<()> {
        Ok(())
    }
}
