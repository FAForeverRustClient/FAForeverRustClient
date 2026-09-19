//! The faf-tournaments model: FAF's own tournament service.
//!
//! Replaces the Challonge bridge in `state::tournaments`, which stays in place
//! until this path is complete. Challonge modelled a tournament, its entrants
//! and its matches, and nothing else; everything FAF events actually need had
//! to be smuggled into free-text fields or left out. This service models it
//! properly: teams of 1–6, map pools per round with their own map database,
//! vetoes, drafts, divisions, check-in windows and rating gates.
//!
//! Two differences from the Challonge types drive most of the work here:
//!
//! 1. **Ids are strings** (`p1a2b`, `m1a2b`), not database serials. Nothing may
//!    parse them or assume ordering: they are opaque handles.
//! 2. **The bracket is an explicit graph.** A match names where its winner and
//!    loser go ([`TourneyMatch::winner_to`]), so the tree is read rather than
//!    inferred from round numbers. Challonge left that to be guessed at, which
//!    is why drawing connectors was ever a geometry problem.

use serde::{Deserialize, Serialize};
use specta::Type;

use super::{PlayerSummary, RequestFailureKind};

// One file per concern, re-exported flat so `state::tourney::Tourney` and
// `state::Tourney` keep resolving: the split is for the reader, not for the
// paths. Each file starts with `use super::*`, which is how they see the two
// imports above and one another.
mod bracket;
mod chat;
mod details;
mod draft;
mod messages;
mod people;
mod pool;
mod reducer;
mod series;
mod state;
mod tournament;
mod veto;

pub use bracket::*;
pub use chat::*;
pub use details::*;
pub use draft::*;
pub use messages::*;
pub use people::*;
pub use pool::*;
pub use reducer::*;
pub use series::*;
pub use state::*;
pub use tournament::*;
pub use veto::*;

#[cfg(test)]
mod tests;
