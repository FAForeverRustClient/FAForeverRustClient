//! Typed failures shared by request/response ports.

use std::fmt;

use faf_domain::state::RequestFailureKind;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RequestError {
    Unauthorized(String),
    Offline(String),
    NotFound(String),
    Rejected(String),
    Unexpected(String),
}

impl RequestError {
    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self::Unauthorized(message.into())
    }

    pub fn offline(message: impl Into<String>) -> Self {
        Self::Offline(message.into())
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::NotFound(message.into())
    }

    pub fn rejected(message: impl Into<String>) -> Self {
        Self::Rejected(message.into())
    }

    pub fn unexpected(message: impl Into<String>) -> Self {
        Self::Unexpected(message.into())
    }

    pub fn kind(&self) -> RequestFailureKind {
        match self {
            Self::Unauthorized(_) => RequestFailureKind::Unauthorized,
            Self::Offline(_) => RequestFailureKind::Offline,
            Self::NotFound(_) => RequestFailureKind::NotFound,
            Self::Rejected(_) => RequestFailureKind::Rejected,
            Self::Unexpected(_) => RequestFailureKind::Unexpected,
        }
    }

    pub fn message(&self) -> &str {
        match self {
            Self::Unauthorized(message)
            | Self::Offline(message)
            | Self::NotFound(message)
            | Self::Rejected(message)
            | Self::Unexpected(message) => message,
        }
    }
}

impl fmt::Display for RequestError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.message())
    }
}

impl std::error::Error for RequestError {}
