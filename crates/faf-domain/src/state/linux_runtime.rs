//! Linux runtime slice: the Wine environment Forged Alliance runs in on Linux.
//!
//! Forged Alliance is a Windows game. On Linux it runs under Wine, and running
//! it well takes more than `wine`: FAForever/faf-linux, the scripts Linux
//! players have set up by hand for years, runs it with GE-Proton's Wine inside
//! Valve's Steam Linux Runtime container, with DXVK for Direct3D and Microsoft's
//! June 2010 DirectX redistributable in a prefix of its own. The client now
//! does the same on its own the first time it starts on Linux.
//!
//! This slice only says where that stands. It owns no paths and no versions:
//! those are the infra layer's, and nothing in the UI needs them.
//!
//! A player who already starts the game through a launch command of their own
//! (Settings, Game) is never touched: the slice stays at
//! [`LinuxRuntimeStatus::NotNeeded`] for them, exactly as it does on Windows.

use serde::{Deserialize, Serialize};
use specta::Type;

/// Something the system has to provide that the client cannot install itself:
/// each of these needs the distribution's package manager, or root.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum LinuxPrerequisite {
    /// `bwrap` is not installed. The Steam Linux Runtime container is built on
    /// it.
    Bubblewrap,
    /// `bwrap` is installed but may not create a sandbox: recent Ubuntu
    /// releases forbid unprivileged user namespaces through AppArmor unless
    /// the administrator allows them.
    UserNamespaces,
    /// The 64-bit Vulkan loader, `libvulkan.so.1`. DXVK draws through it.
    Vulkan64,
    /// The 32-bit Vulkan loader. Forged Alliance is a 32-bit program, so it
    /// needs this one as well as the 64-bit one.
    Vulkan32,
    /// `xz`, which `tar` needs to unpack the Steam Linux Runtime.
    Xz,
    /// No Forged Alliance install was found: not in any Steam library, and not
    /// at a path set under Settings, Paths.
    ForgedAlliance,
}

/// Which family of package managers to phrase install commands for.
///
/// Read from `/etc/os-release`. The UI uses it only to show the right command;
/// `Other` gets the list of what to install instead.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum LinuxDistribution {
    /// Debian, Ubuntu, Linux Mint, Pop!_OS: `apt`.
    Debian,
    /// Fedora, Bazzite, Nobara: `dnf`.
    Fedora,
    /// Arch, Manjaro, EndeavourOS, CachyOS: `pacman`.
    Arch,
    #[default]
    Other,
}

/// The pieces the client downloads.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum LinuxRuntimeComponent {
    /// GE-Proton, whose Wine runs the game.
    Proton,
    /// Valve's Steam Linux Runtime 4 container.
    SteamRuntime,
    /// DXVK, Direct3D 9 to 11 over Vulkan.
    Dxvk,
    /// Microsoft's DirectX June 2010 redistributable: the D3DX9 and XACT
    /// libraries Forged Alliance was built against.
    DirectX,
}

/// One stage of turning the downloads into a working prefix.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    content = "payload",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum LinuxRuntimeStep {
    Unpacking {
        component: LinuxRuntimeComponent,
    },
    /// `wineboot`: Wine creating the prefix's Windows directory.
    CreatingPrefix,
    InstallingDirectX,
    InstallingDxvk,
}

/// Where the Linux runtime stands.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    content = "payload",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum LinuxRuntimeStatus {
    /// Nothing to do: not Linux, or the player starts the game through a
    /// launch command of their own.
    #[default]
    NotNeeded,
    /// Looking at what the system has and what is already installed.
    Checking,
    /// The system lacks something the client cannot install. Nothing was
    /// downloaded; the check runs again on the next start, or on retry.
    Missing {
        prerequisites: Vec<LinuxPrerequisite>,
        distribution: LinuxDistribution,
    },
    /// Byte counts are `u32` like everywhere else on this boundary: specta
    /// rejects 64-bit integers, and the largest download is about 520 MB.
    Downloading {
        component: LinuxRuntimeComponent,
        downloaded_bytes: u32,
        /// Zero when the server sent no `Content-Length`.
        total_bytes: u32,
    },
    Installing {
        step: LinuxRuntimeStep,
    },
    /// Games start through the runtime.
    Ready,
    Failed {
        reason: String,
    },
}

impl LinuxRuntimeStatus {
    /// Whether a check or an installation is in flight.
    pub fn is_busy(&self) -> bool {
        matches!(
            self,
            LinuxRuntimeStatus::Checking
                | LinuxRuntimeStatus::Downloading { .. }
                | LinuxRuntimeStatus::Installing { .. }
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LinuxRuntimeState {
    pub status: LinuxRuntimeStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    content = "payload",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum LinuxRuntimeEvent {
    StatusChanged { status: LinuxRuntimeStatus },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    content = "payload",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum LinuxRuntimeCommand {
    /// Check the system and install whatever is missing or out of date. Sent
    /// once at every start, and again by the retry action; a runtime that is
    /// already complete makes it a quick check.
    Prepare,
    /// Stop a download or installation in progress. What was finished stays;
    /// the next `Prepare` picks up from there.
    Cancel,
}

pub fn reduce(state: &mut LinuxRuntimeState, event: &LinuxRuntimeEvent) {
    match event {
        LinuxRuntimeEvent::StatusChanged { status } => state.status = status.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_checking_downloading_and_installing_are_busy() {
        assert!(LinuxRuntimeStatus::Checking.is_busy());
        assert!(LinuxRuntimeStatus::Downloading {
            component: LinuxRuntimeComponent::Proton,
            downloaded_bytes: 1,
            total_bytes: 2,
        }
        .is_busy());
        assert!(LinuxRuntimeStatus::Installing {
            step: LinuxRuntimeStep::CreatingPrefix,
        }
        .is_busy());
        assert!(!LinuxRuntimeStatus::NotNeeded.is_busy());
        assert!(!LinuxRuntimeStatus::Ready.is_busy());
        assert!(!LinuxRuntimeStatus::Missing {
            prerequisites: vec![LinuxPrerequisite::Vulkan32],
            distribution: LinuxDistribution::Debian,
        }
        .is_busy());
        assert!(!LinuxRuntimeStatus::Failed { reason: "x".into() }.is_busy());
    }

    #[test]
    fn a_status_change_replaces_the_status() {
        let mut state = LinuxRuntimeState::default();
        reduce(
            &mut state,
            &LinuxRuntimeEvent::StatusChanged {
                status: LinuxRuntimeStatus::Ready,
            },
        );
        assert_eq!(state.status, LinuxRuntimeStatus::Ready);
    }
}
