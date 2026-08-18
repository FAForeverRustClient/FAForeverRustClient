//! Mods port: browsing the mod vault, managing locally installed mods,
//! and enabling/disabling them.
//!
//! The impl fetches vault listings from the FAF Data API, installs by
//! downloading + extracting a version's zip into the user's mods folder
//! (mirrors the Python client's `fa/mods.py`/`vaults/modvault/utils.py`),
//! and toggles by reading/rewriting FA's own `game.prefs` file's
//! `active_mods` table. See `infra/mods.rs` for the real implementation.

use async_trait::async_trait;
use faf_domain::protocol::vault_query::ModVaultQuery;
use faf_domain::state::{InstalledMod, VaultMod};

/// One page of a mod vault search. Mirrors `MapSearchPage`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ModSearchPage {
    pub mods: Vec<VaultMod>,
    pub total_pages: Option<i32>,
    pub total_records: Option<i32>,
}

#[async_trait]
pub trait ModsPort: Send + Sync {
    /// List the mod vault (FAF Data API `/data/mod`, `include=latestVersion`
    ///: mirrors the current default "newest first" posture of
    /// `MapsPort::list_vault`).
    async fn list_vault(&self) -> Result<Vec<VaultMod>, String>;

    /// One page of a server-side vault search, as `MapsPort::search_vault`.
    async fn search_vault(&self, query: ModVaultQuery) -> Result<ModSearchPage, String>;

    /// Scan the user's mods folder, cross-referenced against `game.prefs`'s
    /// `active_mods` table for each mod's `enabled` state.
    async fn list_installed(&self) -> Result<Vec<InstalledMod>, String>;

    /// Download and extract a mod version's zip. Returns the refreshed
    /// installed list so the caller doesn't need a separate rescan.
    async fn install_mod(
        &self,
        uid: String,
        download_url: String,
    ) -> Result<Vec<InstalledMod>, String>;

    /// Delete a mod folder and remove its uid from `game.prefs`'s active
    /// set if present. Returns the refreshed installed list.
    async fn uninstall_mod(&self, folder_name: String) -> Result<Vec<InstalledMod>, String>;

    /// Enable or disable an installed mod without uninstalling it. Returns
    /// the refreshed installed list.
    async fn toggle_mod(&self, uid: String, enabled: bool) -> Result<Vec<InstalledMod>, String>;

    /// Install missing simulation mods required by a game and enable them.
    /// Already-installed versions are retained: this is compatibility
    /// preparation, not the intentionally excluded automatic mod updater.
    async fn ensure_game_mods(&self, uids: &[String]) -> Result<(), String>;
}
