//! Updating an installed mod in one step.
//!
//! The client used to offer an "Update" button that called `install`, and an
//! install refuses a folder that already exists, so the button could only fail
//! and the user had to uninstall the mod by hand first. The command exists so
//! that the removal and the install are one decision, taken behind the port,
//! in an order that cannot lose the installed copy to a failed download.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use faf_app::infra::fake_ports;
use faf_app::ports::{ModPrepFailure, ModSearchPage, ModsPort};
use faf_app::{App, Ports};
use faf_domain::protocol::vault_query::ModVaultQuery;
use faf_domain::state::{InstalledMod, ModInstallStatus, ModType, ModsCommand, VaultMod};
use std::collections::BTreeMap;

/// Records what it was asked to update, and answers with a scripted outcome.
struct StubMods {
    seen: Arc<Mutex<Vec<(String, String, String)>>>,
    outcome: Result<Vec<InstalledMod>, String>,
}

#[async_trait]
impl ModsPort for StubMods {
    async fn list_vault(&self) -> Result<Vec<VaultMod>, String> {
        Ok(Vec::new())
    }

    async fn search_vault(&self, _query: ModVaultQuery) -> Result<ModSearchPage, String> {
        Ok(ModSearchPage::default())
    }

    async fn list_installed(&self) -> Result<Vec<InstalledMod>, String> {
        Ok(vec![installed("11")])
    }

    async fn install_mod(
        &self,
        _uid: String,
        _download_url: String,
    ) -> Result<Vec<InstalledMod>, String> {
        unreachable!("an update must not go through install: the folder is occupied")
    }

    async fn update_mod(
        &self,
        uid: String,
        folder_name: String,
        download_url: String,
    ) -> Result<Vec<InstalledMod>, String> {
        self.seen
            .lock()
            .unwrap()
            .push((uid, folder_name, download_url));
        self.outcome.clone()
    }

    async fn uninstall_mod(&self, _folder_name: String) -> Result<Vec<InstalledMod>, String> {
        unreachable!("an update must not reach the client as two separate commands")
    }

    async fn toggle_mod(&self, _uid: String, _enabled: bool) -> Result<Vec<InstalledMod>, String> {
        unreachable!()
    }

    async fn set_active_mods(&self, _uids: Vec<String>) -> Result<Vec<InstalledMod>, String> {
        unreachable!()
    }

    async fn ensure_game_mods(
        &self,
        _mods: &BTreeMap<String, String>,
        _replace_conflicts: bool,
    ) -> Result<(), ModPrepFailure> {
        Ok(())
    }
}

fn installed(version: &str) -> InstalledMod {
    InstalledMod {
        folder_name: "totalmayhem".into(),
        uid: format!("uid-{version}"),
        display_name: "Total Mayhem".into(),
        version: version.into(),
        author: "Some Author".into(),
        description: String::new(),
        mod_type: ModType::Sim,
        enabled: true,
    }
}

#[allow(clippy::type_complexity)]
async fn app_with(
    outcome: Result<Vec<InstalledMod>, String>,
) -> (App, Arc<Mutex<Vec<(String, String, String)>>>) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let ports = Ports {
        mods: Arc::new(StubMods {
            seen: seen.clone(),
            outcome,
        }),
        ..fake_ports()
    };
    let (app, app_loop) = App::new("test", ports);
    tokio::spawn(app_loop.run());
    (app, seen)
}

#[tokio::test]
async fn an_update_replaces_the_installed_version_in_one_command() {
    let (app, seen) = app_with(Ok(vec![installed("12")])).await;

    app.dispatch_and_wait(
        ModsCommand::UpdateMod {
            uid: "uid-12".into(),
            folder_name: "totalmayhem".into(),
            download_url: "https://content.faforever.com/mods/totalmayhem.v12.zip".into(),
        }
        .into(),
    )
    .await
    .unwrap();

    assert_eq!(
        seen.lock().unwrap().as_slice(),
        [(
            "uid-12".to_string(),
            "totalmayhem".to_string(),
            "https://content.faforever.com/mods/totalmayhem.v12.zip".to_string(),
        )],
        "the port is handed the new version and the folder it goes into"
    );

    let state = app.snapshot();
    assert_eq!(state.mods.installed.len(), 1);
    assert_eq!(
        state.mods.installed[0].version, "12",
        "the refreshed scan is what the list shows"
    );
}

#[tokio::test]
async fn a_failed_update_says_so_rather_than_leaving_the_row_working() {
    let (app, _seen) = app_with(Err("could not download mod: connection reset".into())).await;

    app.dispatch_and_wait(
        ModsCommand::UpdateMod {
            uid: "uid-12".into(),
            folder_name: "totalmayhem".into(),
            download_url: "https://content.faforever.com/mods/totalmayhem.v12.zip".into(),
        }
        .into(),
    )
    .await
    .unwrap();

    let ModInstallStatus::Failed { reason } = app.snapshot().mods.install_status else {
        panic!("a refused update has to reach the user as a failure");
    };
    assert!(reason.contains("connection reset"), "reason was {reason:?}");
}
