//! Maps service.
//!
//! Thin handler (like `services/replays.rs`): asks the [`MapsPort`] to do the
//! work, then emits the corresponding events. The actual API calls, folder
//! scan and zip extraction live entirely behind the port: see `infra/maps.rs`.

use faf_domain::state::{MapListStatus, MapsCommand, MapsEvent};

use crate::runtime::{EventSink, ServiceCtx};

pub async fn handle(cmd: MapsCommand, ctx: &ServiceCtx, out: &EventSink) {
    match cmd {
        MapsCommand::LoadVault => {
            // Crawling the whole catalogue is the most expensive thing this
            // client does, so it happens once. Seven of the nine callers
            // checked `vaultStatus` themselves before sending this; the two on
            // the Play tab did not, so opening Play, and the host dialog, threw
            // a finished crawl away and started it again on every mount. The
            // check belongs here, where a new caller cannot forget it.
            //
            // A previous failure is still retried: only "already loaded" and
            // "already in flight" are reasons to do nothing.
            if out.with_state(|state| {
                matches!(
                    state.maps.vault_status,
                    MapListStatus::Loading | MapListStatus::Ready
                )
            }) {
                return;
            }
            out.emit(MapsEvent::VaultLoading);
            match ctx.ports.maps.list_vault().await {
                Ok(maps) => out.emit(MapsEvent::VaultLoaded { maps }),
                Err(reason) => out.emit(MapsEvent::VaultLoadFailed { reason }),
            }
        }
        MapsCommand::SearchVault { query } => {
            // No guard and no dedupe beyond the generation check: this is a
            // user-driven search, and asking again is exactly what the search
            // button means.
            out.emit(MapsEvent::VaultSearching);
            match ctx.ports.maps.search_vault(query.clone()).await {
                Ok(page) => out.emit(MapsEvent::VaultSearched {
                    maps: page.maps,
                    query,
                    total_pages: page.total_pages,
                    total_records: page.total_records,
                }),
                Err(reason) => out.emit(MapsEvent::VaultSearchFailed { reason }),
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
        MapsCommand::SetMapVersionHidden { version_id, hidden } => {
            // One at a time: a second click while the first `PATCH` is in
            // flight would race the reducer's in-place correction, and the two
            // could settle on opposite flags.
            if out.with_state(|state| state.maps.visibility_status.working_on().is_some()) {
                return;
            }
            out.emit(MapsEvent::MapVisibilityChanging { version_id });
            match ctx
                .ports
                .maps
                .set_map_version_hidden(version_id, hidden)
                .await
            {
                Ok(()) => out.emit(MapsEvent::MapVisibilityChanged { version_id, hidden }),
                Err(reason) => out.emit(MapsEvent::MapVisibilityFailed { reason }),
            }
        }
    }
}
