//! Wire protocol codecs: pure encode/decode, no IO (ARCHITECTURE.md §2).
//!
//! These translate between Rust types and the on-the-wire byte/JSON forms of the
//! external protocols. They live in `faf-domain` because they are pure and
//! exhaustively unit-testable with zero setup; `infra` does the actual IO and
//! calls into these.

pub mod chat_input;
pub mod discord;
pub mod galactic_war;
pub mod gpgnet;
pub mod irc;
pub mod map_generator;
pub mod replay_query;
pub mod tournaments;
