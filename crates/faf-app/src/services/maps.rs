//! Maps service.
//!
//! Thin handler (like `services/replays.rs`): asks the [`MapsPort`] to do the
//! work, then emits the corresponding events. The actual API calls, folder
//! scan and zip extraction live entirely behind the port: see `infra/maps.rs`.

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
                Ok(maps) => {
                    let gen_maps = maps
                        .iter()
                        .filter(|m| {
                            faf_domain::protocol::map_generator::is_generated_map(&m.folder_name)
                        })
                        .map(|m| m.folder_name.clone())
                        .collect::<Vec<_>>();
                    if !gen_maps.is_empty() {
                        let previews = ctx.ports.map_generator.map_previews(&gen_maps).await;
                        if !previews.is_empty() {
                            out.emit(faf_domain::state::MapGeneratorEvent::PreviewsLoaded {
                                previews,
                            });
                        }
                    }
                    out.emit(MapsEvent::InstalledLoaded { maps });
                }
                Err(reason) => out.emit(MapsEvent::InstalledLoadFailed { reason }),
            }
        }
        MapsCommand::LoadMatchmakerPools { queue_name } => {
            out.emit(MapsEvent::MatchmakerPoolsLoading);
            match ctx
                .ports
                .maps
                .list_matchmaker_pools(queue_name.clone())
                .await
            {
                Ok(pools) => out.emit(MapsEvent::MatchmakerPoolsLoaded { queue_name, pools }),
                Err(reason) => out.emit(MapsEvent::MatchmakerPoolsLoadFailed { reason }),
            }
        }
        MapsCommand::InstallMap {
            folder_name,
            download_url,
        } => {
            let _guard = ctx.maps_mutation.acquire().await;
            out.emit(MapsEvent::Installing {
                folder_name: folder_name.clone(),
            });
            match ctx.ports.maps.install_map(folder_name, download_url).await {
                Ok(installed) => out.emit(MapsEvent::Installed { installed }),
                Err(reason) => out.emit(MapsEvent::InstallFailed { reason }),
            }
        }
        MapsCommand::UninstallMap { folder_name } => {
            let _guard = ctx.maps_mutation.acquire().await;
            out.emit(MapsEvent::Installing {
                folder_name: folder_name.clone(),
            });
            match ctx.ports.maps.uninstall_map(folder_name).await {
                Ok(installed) => out.emit(MapsEvent::Uninstalled { installed }),
                Err(reason) => out.emit(MapsEvent::UninstallFailed { reason }),
            }
        }
    }
}
