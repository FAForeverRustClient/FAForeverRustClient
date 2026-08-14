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
                let previews = ctx
                    .ports
                    .map_generator
                    .map_previews(std::slice::from_ref(&map_name))
                    .await;
                if !previews.is_empty() {
                    out.emit(MapGeneratorEvent::PreviewsLoaded { previews });
                }
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
        MapGeneratorCommand::LoadOptions { version } => load_options(version, ctx, out).await,
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
    let mut succeeded_maps: Vec<String> = Vec::new();
    while let Some(GeneratorUpdate::Status(status)) = updates.recv().await {
        match &status {
            GeneratorStatus::Generated { maps } => {
                succeeded_maps = maps.clone();
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
    if !succeeded_maps.is_empty() {
        let previews = ctx.ports.map_generator.map_previews(&succeeded_maps).await;
        if !previews.is_empty() {
            out.emit(MapGeneratorEvent::PreviewsLoaded { previews });
        }
        refresh_installed_maps(ctx, out).await;
    }
}

/// A generated map is a new folder on disk; the maps slice has to re-scan for
/// it to count as installed anywhere else in the client.
async fn refresh_installed_maps(ctx: &ServiceCtx, out: &EventSink) {
    services::maps::handle(MapsCommand::LoadInstalled, ctx, out).await;
}

/// Fetch available versions and option lists the generator reports.
async fn load_options(explicit_version: Option<String>, ctx: &ServiceCtx, out: &EventSink) {
    if let Ok(versions) = ctx.ports.map_generator.available_versions().await {
        out.emit(MapGeneratorEvent::VersionsLoaded { versions });
    }

    let resolved_version = if let Some(v) = explicit_version.clone() {
        out.emit(MapGeneratorEvent::VersionResolved { version: v.clone() });
        Some(v)
    } else {
        match ctx.ports.map_generator.latest_version().await {
            Ok(version) => {
                out.emit(MapGeneratorEvent::VersionResolved {
                    version: version.clone(),
                });
                Some(version)
            }
            Err(reason) => {
                services::notifications::add(
                    out,
                    NotificationKind::Error,
                    "Could not find a usable map generator",
                    reason,
                    None,
                );
                None
            }
        }
    };

    for query in GeneratorOptionQuery::ALL {
        if let Ok(values) = ctx
            .ports
            .map_generator
            .query_options(query, resolved_version.clone())
            .await
        {
            out.emit(MapGeneratorEvent::OptionListLoaded { query, values });
        }
    }
}
