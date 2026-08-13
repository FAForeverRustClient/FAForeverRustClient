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
