//! Map generator service.
//!
//! Bridges the streaming [`MapGeneratorPort`](crate::ports::MapGeneratorPort)
//! to events: same shape as the chat and lobby services: start a run, then
//! forward each status until the stream ends.
//!
//! Two things it owns beyond forwarding:
//!
//! * **Skipping work that isn't needed.** `GenerateNamed` returns immediately
//!   when the map is already on disk, so joining a lobby you have the map for
//!   costs nothing. The Java client's `generateIfNotInstalled` does the same.
//! * **Refreshing the map list afterwards.** A generated map is a new folder in
//!   the maps directory, so the maps slice is stale until it re-scans: without
//!   this the map you just generated wouldn't appear as installed.

use faf_domain::state::{
    GeneratorOptionQuery, GeneratorStatus, MapGeneratorCommand, MapGeneratorEvent, MapsCommand,
    NotificationKind,
};

use crate::ports::GeneratorUpdate;
use crate::runtime::{EventSink, ServiceCtx};
use crate::services;

pub async fn handle(cmd: MapGeneratorCommand, ctx: &ServiceCtx, out: &EventSink) {
    match cmd {
        MapGeneratorCommand::GenerateNamed { map_name } => {
            let Some(_guard) = ctx.map_generator_active.try_acquire() else {
                return;
            };
            if ctx.ports.map_generator.is_installed(&map_name) {
                // Already reproduced: report success without spawning Java.
                out.emit(MapGeneratorEvent::StatusChanged {
                    status: GeneratorStatus::Generated {
                        maps: vec![map_name],
                    },
                });
                return;
            }
            let updates = ctx.ports.map_generator.generate_named(map_name).await;
            drain(updates, ctx, out).await;
        }
        MapGeneratorCommand::Generate { options } => {
            let Some(_guard) = ctx.map_generator_active.try_acquire() else {
                return;
            };
            out.emit(MapGeneratorEvent::OptionsChanged {
                options: options.clone(),
            });
            let updates = ctx.ports.map_generator.generate(options).await;
            drain(updates, ctx, out).await;
        }
        MapGeneratorCommand::SetOptions { options } => {
            out.emit(MapGeneratorEvent::OptionsChanged { options })
        }
        MapGeneratorCommand::LoadOptions => load_options(ctx, out).await,
        MapGeneratorCommand::CleanUp => {
            let Some(_guard) = ctx.map_generator_active.try_acquire() else {
                return;
            };
            // Read the authoritative persisted setting here rather than
            // trusting the webview to supply the cleanup exclusion list.
            let protected_maps = ctx.ports.settings.load().await.browsing.favorite_maps;
            match ctx.ports.map_generator.clean_up(&protected_maps).await {
                Ok(0) => services::notifications::add(
                    out,
                    NotificationKind::MapGenerated,
                    "Generated maps",
                    "There were no generated maps to remove.",
                    None,
                ),
                Ok(count) => {
                    services::notifications::add(
                        out,
                        NotificationKind::MapGenerated,
                        "Generated maps removed",
                        format!("Removed {count} generated map(s)."),
                        None,
                    );
                    refresh_installed_maps(ctx, out).await;
                }
                Err(reason) => services::notifications::add(
                    out,
                    NotificationKind::Error,
                    "Could not remove generated maps",
                    reason,
                    None,
                ),
            }
        }
    }
}

/// Forward every status, and re-scan installed maps once a run succeeds.
async fn drain(
    mut updates: tokio::sync::mpsc::Receiver<GeneratorUpdate>,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    let mut succeeded = false;
    while let Some(GeneratorUpdate::Status(status)) = updates.recv().await {
        match &status {
            GeneratorStatus::Generated { maps } => {
                succeeded = true;
                services::notifications::add(
                    out,
                    NotificationKind::MapGenerated,
                    "Map ready",
                    match maps.as_slice() {
                        [one] => one.clone(),
                        many => format!("Generated {} maps.", many.len()),
                    },
                    None,
                );
            }
            GeneratorStatus::Failed { reason } => services::notifications::add(
                out,
                NotificationKind::Error,
                "Map generation failed",
                reason.clone(),
                None,
            ),
            _ => {}
        }
        out.emit(MapGeneratorEvent::StatusChanged { status });
    }
    if succeeded {
        refresh_installed_maps(ctx, out).await;
    }
}

/// A generated map is a new folder on disk; the maps slice has to re-scan for
/// it to count as installed anywhere else in the client.
async fn refresh_installed_maps(ctx: &ServiceCtx, out: &EventSink) {
    services::maps::handle(MapsCommand::LoadInstalled, ctx, out).await;
}

/// Fetch every option list the generator reports, plus the release version.
///
/// Best-effort per list: one unavailable list (an older generator without that
/// flag) must not leave the whole dialog empty.
async fn load_options(ctx: &ServiceCtx, out: &EventSink) {
    match ctx.ports.map_generator.latest_version().await {
        Ok(version) => out.emit(MapGeneratorEvent::VersionResolved { version }),
        Err(reason) => {
            services::notifications::add(
                out,
                NotificationKind::Error,
                "Could not find a usable map generator",
                reason,
                None,
            );
            return;
        }
    }

    for query in GeneratorOptionQuery::ALL {
        if let Ok(values) = ctx.ports.map_generator.query_options(query).await {
            out.emit(MapGeneratorEvent::OptionListLoaded { query, values });
        }
    }
}
