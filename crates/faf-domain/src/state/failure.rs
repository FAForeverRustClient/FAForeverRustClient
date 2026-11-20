//! Stable failure categories that cross the backend/frontend boundary.
//!
//! The transport-specific error stays in `faf-app::ports`; state carries only
//! the category the UI needs to choose a useful recovery action.

use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum RequestFailureKind {
    /// The access token is absent, expired, or rejected by the service.
    Unauthorized,
    /// The service cannot currently be reached, including server-side 5xx.
    Offline,
    /// The requested endpoint or resource does not exist.
    NotFound,
    /// The service understood the request but refused it.
    Rejected,
    /// Configuration, decoding, or another client-side invariant failed.
    Unexpected,
}

/// Why something the client tried did not happen, where the client knows the
/// cause for certain rather than guessing it from an error's wording.
///
/// The UI says each one in a sentence of its own, in the reader's language.
/// It used to recognise these by matching the English sentence the backend
/// wrote, which broke the moment either side reworded it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum FailureCause {
    /// The lobby connection is down, so the request was never sent.
    LobbyDisconnected,
    /// The lobby connection's outgoing queue is full; the request was not
    /// sent, and may be retried in a moment.
    LobbySendBusy,
}
