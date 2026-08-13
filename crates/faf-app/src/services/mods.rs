//! Mods service.
//!
//! Thin handler (like `services/maps.rs`): asks the [`crate::ports::
//! ModsPort`] to do the work, then emits the corresponding events. The
//! actual API calls, folder scan, zip extraction, and `game.prefs`
//! read/write live entirely behind the port — see `infra/mods.rs`.

use faf_domain::state::{ModsCommand, ModsEvent};

use crate::runtime::{EventSink, ServiceCtx};

pub async fn handle(cmd: ModsCommand, ctx: &ServiceCtx, out: &EventSink) {
    match cmd {
        ModsCommand::LoadVault => {
            out.emit(ModsEvent::VaultLoading);
            match ctx.ports.mods.list_vault().await {
                Ok(mods) => out.emit(ModsEvent::VaultLoaded { mods }),
                Err(reason) => out.emit(ModsEvent::VaultLoadFailed { reason }),
            }
        }
        ModsCommand::LoadInstalled => {
            out.emit(ModsEvent::InstalledLoading);
            match ctx.ports.mods.list_installed().await {
                Ok(mods) => out.emit(ModsEvent::InstalledLoaded { mods }),
                Err(reason) => out.emit(ModsEvent::InstalledLoadFailed { reason }),
            }
        }
        ModsCommand::InstallMod { uid, download_url } => {
            out.emit(ModsEvent::Installing { uid: uid.clone() });
            match ctx.ports.mods.install_mod(uid, download_url).await {
                Ok(installed) => out.emit(ModsEvent::Installed { installed }),
                Err(reason) => out.emit(ModsEvent::InstallFailed { reason }),
            }
        }
        ModsCommand::UninstallMod { folder_name } => {
            match ctx.ports.mods.uninstall_mod(folder_name).await {
                Ok(installed) => out.emit(ModsEvent::Uninstalled { installed }),
                Err(reason) => out.emit(ModsEvent::UninstallFailed { reason }),
            }
        }
        ModsCommand::ToggleMod { uid, enabled } => {
            out.emit(ModsEvent::Toggling { uid: uid.clone() });
            match ctx.ports.mods.toggle_mod(uid, enabled).await {
                Ok(installed) => out.emit(ModsEvent::Toggled { installed }),
                Err(reason) => out.emit(ModsEvent::ToggleFailed { reason }),
            }
        }
    }
}
