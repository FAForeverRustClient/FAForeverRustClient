//! Maps slice: browsing the map vault and managing locally installed maps.
//!
//! Mirrors the Python client's `vaults/mapvault/` + `fa/maps.py`: the vault
//! list comes from the FAF Data API (`GET /data/map`, `include=latestVersion`),
//! installing downloads the version's zip and extracts it into the user's
//! maps folder (`fa/maps.py::_doDownloadMap` -> `ZipDownloadExtract`), and the
//! "installed" list mirrors the Python client's `MapsManagerDialog`, which
//! scans that same folder. Vault entries carry the discovery, rating and
//! version metadata used by the richer Python and Java vault views.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use specta::Type;

/// One map version, as listed from the FAF Data API (`GET /data/map`,
/// `include=latestVersion,author`). Mirrors the Python client's `Map` +
/// `MapVersion` models (`src/api/models/Map.py`, `MapVersion.py`): the
/// client always looks at `map.latestVersion`, never older versions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VaultMap {
    pub map_id: i32,
    pub version_id: i32,
    pub display_name: String,
    /// `None` for maps without an uploader on record (mirrors `Map.author`
    /// being optional in the Python model).
    pub author: Option<String>,
    /// The directory name this version installs as, e.g. `scmp_009.v0001`,
    /// the install/uninstall/"is this installed" key everywhere (mirrors
    /// `MapVersion.folder_name`).
    pub folder_name: String,
    pub version: String,
    pub description: String,
    pub map_type: String,
    pub max_players: i32,
    pub width: i32,
    pub height: i32,
    pub games_played: i32,
    pub version_games_played: i32,
    pub ranked: bool,
    pub recommended: bool,
    /// Average community review score in tenths (for example, `43` = 4.3).
    pub rating_tenths: i32,
    pub reviews: i32,
    /// ISO-8601 creation timestamp from the latest map version.
    pub created_at: String,
    pub download_url: String,
    pub thumbnail_url: String,
    pub thumbnail_url_large: String,
}

/// A map folder already present in the user's maps folder (mirrors the
/// Python client's `MapsManagerDialog`/`fa.maps.getUserMaps`). Just the
/// folder name and a display name derived from it: the Python client's
/// `getDisplayName` fallback for non-official maps, not a full scenario.lua
/// parse (that's `InstalledMapsCache`, a later-phase nicety).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct InstalledMap {
    pub folder_name: String,
    pub display_name: String,
    #[serde(default)]
    pub max_players: i32,
    #[serde(default)]
    pub width: i32,
    #[serde(default)]
    pub height: i32,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MatchmakerPoolMap {
    pub assignment_id: i32,
    pub display_name: String,
    pub folder_name: String,
    pub max_players: i32,
    pub width: i32,
    pub height: i32,
    pub thumbnail_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MatchmakerMapPool {
    pub id: i32,
    pub name: String,
    pub min_rating: Option<i32>,
    pub max_rating: Option<i32>,
    pub veto_tokens_per_player: i32,
    pub max_tokens_per_map: i32,
    pub minimum_maps_after_veto: i32,
    pub maps: Vec<MatchmakerPoolMap>,
}

/// Status of a list fetch (vault or installed): separate from
/// [`InstallStatus`], since browsing and installing are independent
/// (mirrors [`crate::state::VaultStatus`] for replays, kept local to avoid
/// coupling the two slices).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum MapListStatus {
    #[default]
    Idle,
    Loading,
    Ready,
    Failed {
        reason: String,
    },
}

/// Status of an install/uninstall action for one map folder.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum MapInstallStatus {
    #[default]
    Idle,
    #[serde(rename_all = "camelCase")]
    Installing {
        folder_name: String,
    },
    Failed {
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MapsState {
    pub vault: Vec<VaultMap>,
    pub vault_status: MapListStatus,
    pub installed: Vec<InstalledMap>,
    pub installed_status: MapListStatus,
    pub install_status: MapInstallStatus,
    pub matchmaker_pools: BTreeMap<String, Vec<MatchmakerMapPool>>,
    pub matchmaker_pools_status: MapListStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum MapsEvent {
    VaultLoading,
    VaultLoaded {
        maps: Vec<VaultMap>,
    },
    VaultLoadFailed {
        reason: String,
    },
    InstalledLoading,
    InstalledLoaded {
        maps: Vec<InstalledMap>,
    },
    InstalledLoadFailed {
        reason: String,
    },
    MatchmakerPoolsLoading,
    #[serde(rename_all = "camelCase")]
    MatchmakerPoolsLoaded {
        queue_name: String,
        pools: Vec<MatchmakerMapPool>,
    },
    MatchmakerPoolsLoadFailed {
        reason: String,
    },
    // `rename_all` on the enum only renames variant tags, not the fields of
    // struct-like variants (a serde/specta quirk): so multi-word fields need
    // their own per-variant `rename_all` to stay camelCase on the wire.
    #[serde(rename_all = "camelCase")]
    Installing {
        folder_name: String,
    },
    /// Install succeeded: carries the freshly-scanned installed list so the
    /// UI doesn't need a separate `LoadInstalled` round-trip (mirrors the
    /// Python client's `MapsManagerDialog` re-scanning after every change).
    Installed {
        installed: Vec<InstalledMap>,
    },
    InstallFailed {
        reason: String,
    },
    Uninstalled {
        installed: Vec<InstalledMap>,
    },
    UninstallFailed {
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum MapsCommand {
    /// Fetch the map vault (mirrors `MapVault`'s default "All" browse query).
    LoadVault,
    /// Scan the user's maps folder (mirrors `MapsManagerDialog::setup_maplist`).
    LoadInstalled,
    #[serde(rename_all = "camelCase")]
    LoadMatchmakerPools { queue_name: String },
    /// Download and extract a map version's zip (mirrors `maps._doDownloadMap`).
    #[serde(rename_all = "camelCase")]
    InstallMap {
        folder_name: String,
        download_url: String,
    },
    /// Delete a map folder (mirrors `MapsManagerDialog::delete_map`).
    #[serde(rename_all = "camelCase")]
    UninstallMap { folder_name: String },
}

pub fn reduce(state: &mut MapsState, event: &MapsEvent) {
    match event {
        MapsEvent::VaultLoading => state.vault_status = MapListStatus::Loading,
        MapsEvent::VaultLoaded { maps } => {
            state.vault = maps.clone();
            state.vault_status = MapListStatus::Ready;
        }
        MapsEvent::VaultLoadFailed { reason } => {
            state.vault_status = MapListStatus::Failed {
                reason: reason.clone(),
            }
        }
        MapsEvent::InstalledLoading => state.installed_status = MapListStatus::Loading,
        MapsEvent::InstalledLoaded { maps } => {
            state.installed = maps.clone();
            state.installed_status = MapListStatus::Ready;
        }
        MapsEvent::InstalledLoadFailed { reason } => {
            state.installed_status = MapListStatus::Failed {
                reason: reason.clone(),
            }
        }
        MapsEvent::MatchmakerPoolsLoading => state.matchmaker_pools_status = MapListStatus::Loading,
        MapsEvent::MatchmakerPoolsLoaded { queue_name, pools } => {
            state
                .matchmaker_pools
                .insert(queue_name.clone(), pools.clone());
            state.matchmaker_pools_status = MapListStatus::Ready;
        }
        MapsEvent::MatchmakerPoolsLoadFailed { reason } => {
            state.matchmaker_pools_status = MapListStatus::Failed {
                reason: reason.clone(),
            }
        }
        MapsEvent::Installing { folder_name } => {
            state.install_status = MapInstallStatus::Installing {
                folder_name: folder_name.clone(),
            }
        }
        MapsEvent::Installed { installed } => {
            state.install_status = MapInstallStatus::Idle;
            state.installed = installed.clone();
            state.installed_status = MapListStatus::Ready;
        }
        MapsEvent::InstallFailed { reason } => {
            state.install_status = MapInstallStatus::Failed {
                reason: reason.clone(),
            }
        }
        MapsEvent::Uninstalled { installed } => {
            state.install_status = MapInstallStatus::Idle;
            state.installed = installed.clone();
            state.installed_status = MapListStatus::Ready;
        }
        MapsEvent::UninstallFailed { reason } => {
            state.install_status = MapInstallStatus::Failed {
                reason: reason.clone(),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault_map(folder_name: &str) -> VaultMap {
        VaultMap {
            map_id: 1,
            version_id: 1,
            display_name: "Seton's Clutch".into(),
            author: Some("Rackover".into()),
            folder_name: folder_name.into(),
            version: "1".into(),
            description: "A classic team map.".into(),
            map_type: "skirmish".into(),
            max_players: 8,
            width: 1024,
            height: 1024,
            games_played: 42,
            version_games_played: 40,
            ranked: true,
            recommended: false,
            rating_tenths: 45,
            reviews: 12,
            created_at: "2026-01-01T00:00:00Z".into(),
            download_url: "https://content.faforever.com/maps/setons_clutch.zip".into(),
            thumbnail_url: "https://content.faforever.com/maps/setons_clutch.small.png".into(),
            thumbnail_url_large: "https://content.faforever.com/maps/setons_clutch.large.png"
                .into(),
        }
    }

    fn installed_map(folder_name: &str) -> InstalledMap {
        InstalledMap {
            folder_name: folder_name.into(),
            display_name: "Setons Clutch".into(),
            max_players: 8,
            width: 1024,
            height: 1024,
            version: Some("1".into()),
            description: None,
        }
    }

    #[test]
    fn vault_loading_then_loaded() {
        let mut s = MapsState::default();
        assert_eq!(s.vault_status, MapListStatus::Idle);
        reduce(&mut s, &MapsEvent::VaultLoading);
        assert_eq!(s.vault_status, MapListStatus::Loading);
        reduce(
            &mut s,
            &MapsEvent::VaultLoaded {
                maps: vec![vault_map("scmp_009.v0001")],
            },
        );
        assert_eq!(s.vault_status, MapListStatus::Ready);
        assert_eq!(s.vault.len(), 1);
    }

    #[test]
    fn vault_load_failure_records_reason() {
        let mut s = MapsState::default();
        reduce(
            &mut s,
            &MapsEvent::VaultLoadFailed {
                reason: "offline".into(),
            },
        );
        assert_eq!(
            s.vault_status,
            MapListStatus::Failed {
                reason: "offline".into()
            }
        );
    }

    #[test]
    fn installed_loading_then_loaded() {
        let mut s = MapsState::default();
        reduce(&mut s, &MapsEvent::InstalledLoading);
        assert_eq!(s.installed_status, MapListStatus::Loading);
        reduce(
            &mut s,
            &MapsEvent::InstalledLoaded {
                maps: vec![installed_map("scmp_009.v0001")],
            },
        );
        assert_eq!(s.installed_status, MapListStatus::Ready);
        assert_eq!(s.installed.len(), 1);
    }

    #[test]
    fn install_flow_updates_installed_list_and_resets_status() {
        let mut s = MapsState::default();
        reduce(
            &mut s,
            &MapsEvent::Installing {
                folder_name: "scmp_009.v0001".into(),
            },
        );
        assert_eq!(
            s.install_status,
            MapInstallStatus::Installing {
                folder_name: "scmp_009.v0001".into()
            }
        );
        reduce(
            &mut s,
            &MapsEvent::Installed {
                installed: vec![installed_map("scmp_009.v0001")],
            },
        );
        assert_eq!(s.install_status, MapInstallStatus::Idle);
        assert_eq!(s.installed.len(), 1);
        assert_eq!(s.installed_status, MapListStatus::Ready);
    }

    #[test]
    fn install_failure_records_reason() {
        let mut s = MapsState::default();
        reduce(
            &mut s,
            &MapsEvent::InstallFailed {
                reason: "download failed".into(),
            },
        );
        assert_eq!(
            s.install_status,
            MapInstallStatus::Failed {
                reason: "download failed".into()
            }
        );
    }

    #[test]
    fn uninstall_updates_installed_list() {
        let mut s = MapsState {
            installed: vec![installed_map("scmp_009.v0001")],
            installed_status: MapListStatus::Ready,
            ..Default::default()
        };
        reduce(&mut s, &MapsEvent::Uninstalled { installed: vec![] });
        assert_eq!(s.install_status, MapInstallStatus::Idle);
        assert!(s.installed.is_empty());
    }
}
