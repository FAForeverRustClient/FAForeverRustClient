//! In-memory session token store: the bridge between auth and the network ports.
//!
//! The OAuth access token must never live in [`AppState`] (it would be serialized
//! to the frontend). Instead the real auth provider writes it here after login and
//! network ports (e.g. the lobby client) read it when they open a connection. It is
//! process-memory only; the long-lived refresh token is what gets persisted (keyring).

use std::sync::{Arc, RwLock};

/// A cheap-to-clone handle to the current access token (all clones share state).
#[derive(Clone, Default)]
pub struct TokenStore {
    inner: Arc<RwLock<Option<String>>>,
}

impl TokenStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Store (or replace) the current access token.
    pub fn set(&self, token: impl Into<String>) {
        *self.inner.write().expect("token store poisoned") = Some(token.into());
    }

    /// The current access token, if logged in.
    pub fn get(&self) -> Option<String> {
        self.inner.read().expect("token store poisoned").clone()
    }

    /// Forget the access token (on logout).
    pub fn clear(&self) {
        *self.inner.write().expect("token store poisoned") = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clones_share_state() {
        let a = TokenStore::new();
        let b = a.clone();
        assert_eq!(b.get(), None);
        a.set("tok");
        assert_eq!(b.get().as_deref(), Some("tok"));
        b.clear();
        assert_eq!(a.get(), None);
    }
}
