//! Maps service.
//!
//! Thin handler (like `services/replays.rs`): asks the [`MapsPort`] to do the
//! work, then emits the corresponding events. The actual API calls, folder
//! scan and zip extraction live entirely behind the port — see `infra/maps.rs`.

use faf_domain::state::{MapsCommand, MapsEvent};

use crate::runtime::{EventSink, ServiceCtx};

pub async fn handle(cmd: MapsCommand, ctx: &ServiceCtx, out: &EventSink) {
    match cmd {
        MapsCommand::LoadVault => {
            out.emit(MapsEvent::VaultLoading);
            match ctx.ports.maps.list_vault().await {
                Ok(maps) => out.emit(MapsEvent::VaultLoaded { maps }),
                Err(reason) => out.emit(MapsEvent::VaultLoadFailed { reason }),
            }
        }
        MapsCommand::LoadInstalled => {
            out.emit(MapsEvent::InstalledLoading);
            match ctx.ports.maps.list_installed().await {
                Ok(maps) => out.emit(MapsEvent::InstalledLoaded { maps }),
                Err(reason) => out.emit(MapsEvent::InstalledLoadFailed { reason }),
            }
        }
        MapsCommand::InstallMap {
            folder_name,
            download_url,
        } => {
            out.emit(MapsEvent::Installing {
                folder_name: folder_name.clone(),
            });
            match ctx.ports.maps.install_map(folder_name, download_url).await {
                Ok(installed) => out.emit(MapsEvent::Installed { installed }),
                Err(reason) => out.emit(MapsEvent::InstallFailed { reason }),
            }
        }
        MapsCommand::UninstallMap { folder_name } => {
            out.emit(MapsEvent::Installing { folder_name: folder_name.clone() });
            match ctx.ports.maps.uninstall_map(folder_name).await {
                Ok(installed) => out.emit(MapsEvent::Uninstalled { installed }),
                Err(reason) => out.emit(MapsEvent::UninstallFailed { reason }),
            }
        }
    }
}
