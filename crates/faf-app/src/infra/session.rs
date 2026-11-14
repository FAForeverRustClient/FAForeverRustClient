//! In-memory session token store: the bridge between auth and the network ports.
//!
//! The OAuth access token must never live in [`AppState`] (it would be serialized
//! to the frontend). Instead the real auth provider writes it here after login and
//! network ports (e.g. the lobby client) read it when they open a connection. It is
//! process-memory only; the long-lived refresh token is what gets persisted (keyring).
//!
//! The OIDC ID token sits beside it, renewed with it. It proves who is signed in
//! and nothing more (it is not accepted by the API or the lobby), which is all
//! the web link needs to send anyone.

use std::sync::{Arc, RwLock};

/// A cheap-to-clone handle to the current access token (all clones share state).
#[derive(Clone, Default)]
pub struct TokenStore {
    inner: Arc<RwLock<Option<String>>>,
    id: Arc<RwLock<Option<String>>>,
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

    /// Store (or replace) the current ID token. A renewal that brings none
    /// keeps the previous one, which then simply runs out.
    pub fn set_id_token(&self, token: Option<&str>) {
        if let Some(token) = token {
            *self.id.write().expect("token store poisoned") = Some(token.to_owned());
        }
    }

    /// A new session's ID token, replacing whatever an earlier one left.
    pub fn start_id_token(&self, token: Option<&str>) {
        *self.id.write().expect("token store poisoned") = token.map(str::to_owned);
    }

    /// The current ID token, if logged in and Hydra issued one.
    pub fn id_token(&self) -> Option<String> {
        self.id.read().expect("token store poisoned").clone()
    }

    /// Forget both tokens (on logout).
    pub fn clear(&self) {
        *self.inner.write().expect("token store poisoned") = None;
        *self.id.write().expect("token store poisoned") = None;
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

    #[test]
    fn the_id_token_is_kept_beside_the_access_token_and_cleared_with_it() {
        let store = TokenStore::new();
        store.set("access");
        store.set_id_token(Some("id-1"));
        store.set_id_token(None);
        assert_eq!(
            store.id_token().as_deref(),
            Some("id-1"),
            "a renewal without one keeps the last"
        );
        store.set_id_token(Some("id-2"));
        assert_eq!(store.id_token().as_deref(), Some("id-2"));
        store.start_id_token(None);
        assert_eq!(
            store.id_token(),
            None,
            "a new session does not inherit the last one's"
        );
        store.set_id_token(Some("id-3"));
        store.clear();
        assert_eq!(store.id_token(), None);
        assert_eq!(store.get(), None);
    }
}
