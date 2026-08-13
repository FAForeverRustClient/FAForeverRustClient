//! Orchestration layer.
//!
//! Wires the pure domain ([`faf_domain`]) to the outside world:
//! - [`runtime`] — the command dispatcher, event bus and reduce loop.
//! - [`services`] — business logic; consumes commands, drives ports, emits events.
//! - [`ports`] — trait definitions for every external boundary.
//! - [`infra`] — the *only* place that performs real IO (concrete port impls).
//!
//! See `docs/ARCHITECTURE.md` §2–§3.

pub mod infra;
pub mod ports;
pub mod runtime;
pub mod services;

pub use ports::Ports;
pub use runtime::{App, AppLoop, EventSink, ServiceCtx};
