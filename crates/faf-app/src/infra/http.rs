//! Shared HTTP transport policy for infrastructure adapters.
//!
//! `reqwest::Client` is deliberately cheap to clone: clones retain the same
//! connection pool and TLS state. Keeping one process-wide instance avoids a
//! separate idle pool for every FAF capability while the capability-specific
//! port traits remain small and independently testable.

use std::{sync::OnceLock, time::Duration};

static HTTP: OnceLock<reqwest::Client> = OnceLock::new();

pub(crate) fn shared_http_client() -> reqwest::Client {
    HTTP.get_or_init(|| {
        client_builder()
            // Do not set a whole-request timeout here: the same transport is
            // used for large map/mod downloads and uploads. Individual API
            // operations can impose a tighter timeout when appropriate.
            .build()
            .expect("the shared HTTP client configuration is valid")
    })
    .clone()
}

/// A separate client for downloads whose redirects must be inspected one hop
/// at a time. Using `Policy::none` lets the owning adapter reject an untrusted
/// destination before any request reaches it.
pub(crate) fn no_redirect_http_client() -> reqwest::Client {
    client_builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("the no-redirect HTTP client configuration is valid")
}

fn client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        // FAF's own services see this, so it is the most visible place the old
        // name was still showing. A User-Agent product token cannot contain a
        // space, hence the slug rather than the display name.
        .user_agent(concat!("FAForeverClient/", env!("CARGO_PKG_VERSION")))
}
