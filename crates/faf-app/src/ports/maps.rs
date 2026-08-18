//! Maps port: browsing the map vault and managing locally installed maps.
//!
//! The impl fetches vault listings from the FAF Data API, and installs by
//! downloading + extracting a version's zip into the user's maps folder
//! (mirrors the Python client's `fa/maps.py::_doDownloadMap` ->
//! `ZipDownloadExtract`). See `infra/maps.rs` for the real implementation.

use async_trait::async_trait;
use faf_domain::protocol::vault_query::MapVaultQuery;
use faf_domain::state::{InstalledMap, MatchmakerMapPool, VaultMap};

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

    /// Delete a map folder (mirrors `MapsManagerDialog::delete_map`). Returns
    /// the refreshed installed list.
    async fn uninstall_map(&self, folder_name: String) -> Result<Vec<InstalledMap>, String>;
}
