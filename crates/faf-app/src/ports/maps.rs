//! Maps port: browsing the map vault and managing locally installed maps.
//!
//! The impl fetches vault listings from the FAF Data API, and installs by
//! downloading + extracting a version's zip into the user's maps folder
//! (mirrors the Python client's `fa/maps.py::_doDownloadMap` ->
//! `ZipDownloadExtract`). See `infra/maps.rs` for the real implementation.

use std::collections::BTreeMap;

use async_trait::async_trait;
use faf_domain::protocol::vault_query::MapVaultQuery;
use faf_domain::state::{InstalledMap, LocalMapPreview, MatchmakerMapPool, VaultMap};

/// One step of a vault install, as the adapter reaches it.
///
/// Shared by the map and mod vaults, whose installs are the same two halves: a
/// download whose size the server may or may not declare, then an unpacking
/// with nothing to measure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VaultInstallStep {
    /// Bytes received so far, and the size the server declared, if it did.
    Downloading {
        received_bytes: u64,
        total_bytes: Option<u64>,
    },
    /// The archive is whole and being unpacked.
    Unpacking,
}

/// Where a vault install reports its steps. Called on whatever task the
/// adapter runs on, once per chunk received: a caller that turns a step into
/// an event throttles it itself.
pub type VaultInstallProgress = std::sync::Arc<dyn Fn(VaultInstallStep) + Send + Sync>;

/// One page of a vault search, plus what the server said about the rest.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MapSearchPage {
    pub maps: Vec<VaultMap>,
    pub total_pages: Option<i32>,
    pub total_records: Option<i32>,
}

#[async_trait]
pub trait MapsPort: Send + Sync {
    /// List the map vault (FAF Data API `/data/map`, `include=latestVersion`
    ///: mirrors the Python client's `MapApiConnector`'s default "All" browse
    /// query, newest first).
    async fn list_vault(&self) -> Result<Vec<VaultMap>, String>;

    /// One page of a server-side vault search. This is what the Maps tab
    /// browses; [`Self::list_vault`] only feeds the folder-name lookup index.
    async fn search_vault(&self, query: MapVaultQuery) -> Result<MapSearchPage, String>;

    /// Scan the user's maps folder (mirrors `MapsManagerDialog::setup_maplist`
    /// / `fa.maps.getUserMaps`).
    async fn list_installed(&self) -> Result<Vec<InstalledMap>, String>;

    /// Read preview art out of the named installed map folders, as data URLs.
    ///
    /// The last resort behind the remote thumbnails: for the co-op campaign it
    /// is the only copy that exists (see [`LocalMapPreview`]). Folders are
    /// matched on their base name, so `scca_coop_a01` finds
    /// `scca_coop_a01.v0017` on disk. Never fails: a folder that cannot be read
    /// simply comes back empty, which is also how "we looked" is recorded.
    async fn local_previews(&self, _folder_names: &[String]) -> BTreeMap<String, LocalMapPreview> {
        BTreeMap::new()
    }

    /// The vault's record for each named map folder, hidden versions included.
    ///
    /// For folders [`Self::list_vault`] does not cover, which leaves out every
    /// map whose latest version was withdrawn. The record is the map's, with its
    /// latest version, the same shape the catalogue holds, so the lookups that
    /// match on a base folder name treat both alike. Defaults to finding
    /// nothing, which is what a stub needs.
    async fn find_vault_maps_by_folder(
        &self,
        _folder_names: &[String],
    ) -> Result<Vec<VaultMap>, String> {
        Ok(Vec::new())
    }

    /// Load the rating-bracket map pools and veto limits for one queue.
    async fn list_matchmaker_pools(
        &self,
        queue_name: String,
    ) -> Result<Vec<MatchmakerMapPool>, String>;

    /// Download and extract a map version's zip (mirrors
    /// `fa.maps._doDownloadMap`). Returns the refreshed installed list so the
    /// caller doesn't need a separate rescan.
    async fn install_map(
        &self,
        folder_name: String,
        download_url: String,
    ) -> Result<Vec<InstalledMap>, String>;

    /// [`Self::install_map`], reporting each step to `progress`, and stopping
    /// when `called_off` is cancelled while it still can.
    ///
    /// Not cancelled by dropping the future: only the implementation knows
    /// whether the map is already in place when the call-off comes, and the
    /// caller has to be told the truth either way. A cancel used to drop the
    /// install even while it listed the maps folder after the rename, and the
    /// map was then on disk while the vault said the install was called off
    /// and the installed list did not have it.
    ///
    /// `Ok(None)` means it was called off in time and the maps folder is as
    /// it was: the download's file is gone, and an archive being unpacked
    /// was not renamed into place. Past that rename the call-off is too late,
    /// and the answer is the installed list, as for any install. Defaults to
    /// the plain install, which cannot be called off.
    async fn install_map_reporting(
        &self,
        folder_name: String,
        download_url: String,
        progress: VaultInstallProgress,
        called_off: tokio_util::sync::CancellationToken,
    ) -> Result<Option<Vec<InstalledMap>>, String> {
        let _ = (progress, called_off);
        self.install_map(folder_name, download_url).await.map(Some)
    }

    /// Delete a map folder (mirrors `MapsManagerDialog::delete_map`). Returns
    /// the refreshed installed list.
    ///
    /// Holds the map's folder against a replay or a live game staging the
    /// same map while it deletes, the way an install does.
    async fn uninstall_map(&self, folder_name: String) -> Result<Vec<InstalledMap>, String>;

    /// Withdraw a map version from the vault, or put it back (mirrors
    /// `MapService.hideMapVersion`, a `PATCH` of the version's `hidden` flag).
    ///
    /// The server authorises this, and it does not authorise the two directions
    /// alike: an author may hide, and only a map administrator may unhide.
    async fn set_map_version_hidden(&self, version_id: i32, hidden: bool) -> Result<(), String>;
}
