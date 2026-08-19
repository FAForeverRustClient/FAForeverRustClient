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

use faf_domain::protocol::{map_generator, map_generator_name};
use faf_domain::state::{
    GeneratorOptionQuery, GeneratorStatus, MapGeneratorCommand, MapGeneratorEvent, MapsCommand,
    NotificationKind, SettingsEvent,
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
            // Announce the run before doing anything, so the status can never
            // still be reporting the *previous* run's result while this one is
            // under way. See `GeneratorStatus::Preparing`.
            out.emit(MapGeneratorEvent::StatusChanged {
                status: GeneratorStatus::Preparing,
            });
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
            out.emit(MapGeneratorEvent::StatusChanged {
                status: GeneratorStatus::Preparing,
            });
            out.emit(MapGeneratorEvent::OptionsChanged {
                options: options.clone(),
            });
            // Ask the generator to resolve the options before committing to a
            // run. It costs one JVM start and turns "the map generator failed"
            // after three minutes into the generator's own precise complaint
            // before anything has begun. Raw arguments skip it: they are the
            // documented escape hatch, and `--parse` would reject flags we
            // deliberately do not understand.
            if options.command_line_args.is_empty() {
                match ctx.ports.map_generator.preflight(options.clone()).await {
                    Ok(map_name) => out.emit(MapGeneratorEvent::NamePredicted { map_name }),
                    Err(reason) => {
                        out.emit(MapGeneratorEvent::StatusChanged {
                            status: GeneratorStatus::Failed {
                                reason: reason.clone(),
                            },
                        });
                        services::notifications::add(
                            out,
                            NotificationKind::Error,
                            "Those options will not generate",
                            reason,
                            None,
                        );
                        return;
                    }
                }
            }
            let updates = ctx.ports.map_generator.generate(options).await;
            drain(updates, ctx, out).await;
        }
        MapGeneratorCommand::SetOptions { options } => {
            out.emit(MapGeneratorEvent::ValidationChanged {
                issues: map_generator::validate_options(&options),
            });
            // Written through to the settings file, not just to the in-memory
            // slice: "save settings" that lasts until the next restart is
            // indistinguishable from a button that does nothing.
            out.emit(SettingsEvent::MapGeneratorChanged {
                preferences: Box::new(options.clone()),
            });
            out.emit(MapGeneratorEvent::OptionsChanged { options });
            services::settings::persist(ctx, out).await;
        }
        MapGeneratorCommand::Validate { options } => {
            // Pure arithmetic, so the dialog can call this on every keystroke.
            out.emit(MapGeneratorEvent::ValidationChanged {
                issues: map_generator::validate_options(&options),
            });
        }
        MapGeneratorCommand::Preflight { options } => {
            match ctx.ports.map_generator.preflight(options).await {
                Ok(map_name) => out.emit(MapGeneratorEvent::NamePredicted { map_name }),
                Err(reason) => {
                    // Not a generation failure: nothing was started. Clearing
                    // the prediction and reporting the reason keeps a stale
                    // name from looking like it still applies.
                    out.emit(MapGeneratorEvent::NamePredicted {
                        map_name: String::new(),
                    });
                    services::notifications::add(
                        out,
                        NotificationKind::Error,
                        "Those options will not generate",
                        reason,
                        None,
                    );
                }
            }
        }
        MapGeneratorCommand::DecodeNames { map_names } => {
            // No IO at all: a generated map name carries its own parameters,
            // so a whole lobby list can be expanded in one pass.
            let decoded: std::collections::HashMap<_, _> = map_names
                .iter()
                .filter_map(|name| {
                    map_generator_name::decode(name).map(|parsed| (name.clone(), parsed))
                })
                .collect();
            if !decoded.is_empty() {
                out.emit(MapGeneratorEvent::NamesDecoded { decoded });
            }
        }
        MapGeneratorCommand::LoadHelp { version } => {
            match ctx.ports.map_generator.help(version).await {
                Ok(text) => out.emit(MapGeneratorEvent::HelpLoaded { text }),
                Err(reason) => services::notifications::add(
                    out,
                    NotificationKind::Error,
                    "Could not read the generator help",
                    reason,
                    None,
                ),
            }
        }
        MapGeneratorCommand::Cancel => ctx.ports.map_generator.cancel(),
        MapGeneratorCommand::SavePreset { name, options } => {
            match ctx.ports.map_generator.save_preset(&name, &options).await {
                Ok(()) => {
                    // Saving a preset is also "these are my current options",
                    // so the dialog reopens on them without a second click.
                    out.emit(MapGeneratorEvent::OptionsChanged {
                        options: options.clone(),
                    });
                    out.emit(SettingsEvent::MapGeneratorChanged {
                        preferences: Box::new(options),
                    });
                    services::settings::persist(ctx, out).await;
                    reload_presets(ctx, out).await;
                }
                Err(reason) => services::notifications::add(
                    out,
                    NotificationKind::Error,
                    "Could not save the preset",
                    reason,
                    None,
                ),
            }
        }
        MapGeneratorCommand::LoadPresets => reload_presets(ctx, out).await,
        MapGeneratorCommand::DeletePreset { name } => {
            if let Err(reason) = ctx.ports.map_generator.delete_preset(&name).await {
                services::notifications::add(
                    out,
                    NotificationKind::Error,
                    "Could not delete the preset",
                    reason,
                    None,
                );
            }
            reload_presets(ctx, out).await;
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
            // A cancellation is the user's own doing; telling them about it
            // would be reporting their own click back to them.
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

/// Re-read the whole preset library and publish it.
///
/// Called after every change rather than mutating a cached list, so the state
/// always reflects the folder, including presets added or removed by hand.
async fn reload_presets(ctx: &ServiceCtx, out: &EventSink) {
    let presets = ctx.ports.map_generator.list_presets().await;
    out.emit(MapGeneratorEvent::PresetsLoaded { presets });
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

    // Without a version there is nothing to query: every list would resolve
    // the version again, fail the same way, and spend six more GitHub requests
    // against an hourly budget of sixty per address. The error is already
    // reported above.
    let Some(_) = resolved_version.as_ref() else {
        return;
    };

    // A failed list is not skipped silently. Every one of these needs a JAR
    // download and a JVM, so on a machine without a usable Java the dialog
    // would otherwise open with six empty pickers and no explanation: the
    // shape of the bug this reporting exists for.
    let mut failure: Option<String> = None;
    for query in GeneratorOptionQuery::ALL {
        match ctx
            .ports
            .map_generator
            .query_options(query, resolved_version.clone())
            .await
        {
            Ok(values) => out.emit(MapGeneratorEvent::OptionListLoaded { query, values }),
            Err(reason) => {
                tracing::warn!(flag = query.flag(), %reason, "map generator option list failed");
                // The first reason is the informative one: the rest are the
                // same failure repeated once per list.
                failure.get_or_insert(reason);
            }
        }
    }
    if let Some(reason) = failure {
        services::notifications::add(
            out,
            NotificationKind::Error,
            "Could not read the map generator options",
            reason,
            None,
        );
    }
}
