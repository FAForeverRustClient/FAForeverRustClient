//! Linux runtime boundary: what the system offers, what is installed, and
//! installing the rest.
//!
//! One port for the three because they decide each other: a system without a
//! working `bwrap` must not be sent half a gigabyte of Proton, and what is
//! installed decides how a game is started. See `infra::linux_runtime` for
//! what "the runtime" is.

use async_trait::async_trait;
use faf_domain::state::{
    LinuxDistribution, LinuxPrerequisite, LinuxRuntimeComponent, LinuxRuntimeStep,
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// The answer of [`LinuxRuntimePort::check`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimeCheck {
    /// This platform runs the game without one: Windows.
    NotNeeded,
    /// The system lacks something only the player can install.
    Missing {
        prerequisites: Vec<LinuxPrerequisite>,
        distribution: LinuxDistribution,
    },
    /// Everything at the versions this build pins. Games can start.
    Installed,
    /// The system is fine; some or all of the runtime still has to be
    /// downloaded or set up.
    Incomplete,
}

/// One step of an install run. Always ends in [`RuntimeProgress::Finished`];
/// a receiver that sees the channel close without one knows the worker died.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimeProgress {
    Downloading {
        component: LinuxRuntimeComponent,
        received_bytes: u32,
        /// Zero when the server sent no `Content-Length`.
        total_bytes: u32,
    },
    Installing(LinuxRuntimeStep),
    Finished(Result<(), String>),
}

#[async_trait]
pub trait LinuxRuntimePort: Send + Sync {
    /// Look at the system and at what is installed. Downloads nothing.
    async fn check(&self) -> RuntimeCheck;

    /// Download and set up whatever [`check`](Self::check) found incomplete.
    /// Finished parts are kept, so a cancelled or failed run picks up where
    /// it stopped.
    fn install(&self, called_off: CancellationToken) -> mpsc::Receiver<RuntimeProgress>;

    /// Start games through the installed runtime (`true`) or not at all
    /// (`false`). Only a complete runtime is ever switched on.
    fn activate(&self, active: bool);
}

/// The port for platforms and tests that have nothing to set up.
#[derive(Debug, Clone, Default)]
pub struct NoLinuxRuntime;

#[async_trait]
impl LinuxRuntimePort for NoLinuxRuntime {
    async fn check(&self) -> RuntimeCheck {
        RuntimeCheck::NotNeeded
    }

    fn install(&self, _called_off: CancellationToken) -> mpsc::Receiver<RuntimeProgress> {
        let (tx, rx) = mpsc::channel(1);
        let _ = tx.try_send(RuntimeProgress::Finished(Err(
            "this build has no Linux runtime to install".into(),
        )));
        rx
    }

    fn activate(&self, _active: bool) {}
}
