//! Maps port — browsing the map vault and managing locally installed maps.
//!
//! The impl fetches vault listings from the FAF Data API, and installs by
//! downloading + extracting a version's zip into the user's maps folder
//! (mirrors the Python client's `fa/maps.py::_doDownloadMap` ->
//! `ZipDownloadExtract`). See `infra/maps.rs` for the real implementation.

use async_trait::async_trait;
use faf_domain::state::{InstalledMap, VaultMap};

#[async_trait]
pub trait MapsPort: Send + Sync {
    /// List the map vault (FAF Data API `/data/map`, `include=latestVersion`
    /// — mirrors the Python client's `MapApiConnector`'s default "All" browse
    /// query, newest first).
    async fn list_vault(&self) -> Result<Vec<VaultMap>, String>;

    /// Scan the user's maps folder (mirrors `MapsManagerDialog::setup_maplist`
    /// / `fa.maps.getUserMaps`).
    async fn list_installed(&self) -> Result<Vec<InstalledMap>, String>;

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
