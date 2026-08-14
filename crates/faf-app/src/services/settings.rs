//! Settings service.
//!
//! Loads persisted settings at startup and persists changes. Note the persistence
//! pattern: the service emits the event first (so the single reduce chokepoint
//! updates the authoritative state), then reads the *post-reduce* settings back
//! from the sink and hands the whole slice to the port. This keeps services free
//! of any direct state mutation while still persisting the resulting state.
//!
//! It also owns the install check. Any path change ends in [`sync_installs`],
//! which pushes the new paths into the process port (so a freshly picked
//! install works immediately instead of at the next restart) and then stats
//! them, emitting an [`InstallEvent`] for the missing-install banner. Doing it
//! here rather than behind a separate command means there is no way to change a
//! path without the check running.

use faf_domain::state::{ChatEvent, InstallEvent, NavEvent, SettingsCommand, SettingsEvent};

use crate::runtime::{EventSink, ServiceCtx};

pub async fn handle(cmd: SettingsCommand, ctx: &ServiceCtx, out: &EventSink) {
    match cmd {
        SettingsCommand::Load => {
            let mut settings = ctx.ports.settings.load().await.normalized();
            let discovered = ctx.ports.process.discover_install_paths();
            let mut imported_reference_install = false;
            if !ctx
                .ports
                .process
                .install_path_is_present(&settings.game_path)
            {
                if let Some(path) = discovered.game {
                    settings.game_path = path;
                    imported_reference_install = true;
                }
            }
            if !ctx
                .ports
                .process
                .install_path_is_present(&settings.replay_game_path)
            {
                if let Some(path) = discovered.replay {
                    settings.replay_game_path = path;
                    imported_reference_install = true;
                }
            }
            // Persist the migration once. Explicit user choices always win, so
            // subsequent starts do not need to inspect the reference configs.
            if imported_reference_install {
                ctx.ports.settings.save(&settings).await;
            }
            let start_page = settings.general.start_page;
            let show_joins_parts = settings.chat.show_joins_parts;
            out.emit(SettingsEvent::Loaded {
                settings: Box::new(settings),
            });
            out.emit(ChatEvent::JoinsPartsToggled {
                enabled: show_joins_parts,
            });
            out.emit(NavEvent::TabSelected { tab: start_page });
            sync_runtime_preferences(ctx, out);
            // Last, and deliberately here rather than in the session handshake:
            // the release channel is a preference, so a check that ran any
            // earlier would always use the stable default no matter what the
            // user picked. `Load` runs once at startup, which is exactly the
            // moment the Java client checks too.
            crate::services::client_update::check_on_startup(ctx, out).await;
        }
        SettingsCommand::SetTheme { theme } => {
            out.emit(SettingsEvent::ThemeChanged { theme });
            persist(ctx, out).await;
        }
        SettingsCommand::SetGamePath { path } => {
            out.emit(SettingsEvent::GamePathChanged { path });
            persist(ctx, out).await;
            sync_installs(ctx, out);
        }
        SettingsCommand::SetReplayGamePath { path } => {
            out.emit(SettingsEvent::ReplayGamePathChanged { path });
            persist(ctx, out).await;
            sync_installs(ctx, out);
        }
        SettingsCommand::SetGeneral { preferences } => {
            out.emit(SettingsEvent::GeneralChanged { preferences });
            persist(ctx, out).await;
        }
        SettingsCommand::SetAppearance { preferences } => {
            out.emit(SettingsEvent::AppearanceChanged { preferences });
            persist(ctx, out).await;
        }
        SettingsCommand::SetPlayerNote {
            player_id,
            login,
            note,
        } => {
            let mut preferences = out.with_state(|state| state.settings.social.clone());
            preferences.set_player_note(player_id, login, note);
            out.emit(SettingsEvent::SocialChanged { preferences });
            persist(ctx, out).await;
        }
        SettingsCommand::SetNotifications { preferences } => {
            let mut next = out.with_state(|state| state.settings.clone());
            next.notifications = preferences;
            out.emit(SettingsEvent::NotificationsChanged {
                preferences: next.normalized().notifications,
            });
            persist(ctx, out).await;
        }
        SettingsCommand::SetChat { preferences } => {
            let mut next = out.with_state(|state| state.settings.clone());
            next.chat = preferences;
            let preferences = next.normalized().chat;
            let show_joins_parts = preferences.show_joins_parts;
            out.emit(SettingsEvent::ChatChanged { preferences });
            out.emit(ChatEvent::JoinsPartsToggled {
                enabled: show_joins_parts,
            });
            persist(ctx, out).await;
        }
        SettingsCommand::SetConnectivity { preferences } => {
            out.emit(SettingsEvent::ConnectivityChanged { preferences });
            persist(ctx, out).await;
            sync_connectivity(ctx, out);
        }
        SettingsCommand::SetUpdates { preferences } => {
            // No re-check on change: switching to the prerelease channel should
            // not fire a network request the user did not ask for. The Settings
            // section has an explicit "Check now" for that.
            out.emit(SettingsEvent::UpdatesChanged { preferences });
            persist(ctx, out).await;
        }
        SettingsCommand::SetBrowsing { preferences } => {
            let mut next = out.with_state(|state| state.settings.clone());
            next.browsing = *preferences;
            out.emit(SettingsEvent::BrowsingChanged {
                preferences: Box::new(next.normalized().browsing),
            });
            persist(ctx, out).await;
        }
        SettingsCommand::SetDiscord { preferences } => {
            // No `sync_*` call: the presence watcher observes this event like
            // any other and republishes (or clears) from the new state, so
            // turning presence off takes the status down immediately.
            out.emit(SettingsEvent::DiscordChanged { preferences });
            persist(ctx, out).await;
        }
        SettingsCommand::SetGame { preferences } => {
            let mut next = out.with_state(|state| state.settings.clone());
            next.game = preferences;
            out.emit(SettingsEvent::GameChanged {
                preferences: next.normalized().game,
            });
            persist(ctx, out).await;
            sync_launch_preferences(ctx, out);
        }
        // Re-stat without changing anything: for the banner's "Check again"
        // after the user installs or restores the game outside the client.
        SettingsCommand::CheckInstalls => sync_installs(ctx, out),
    }
}

pub(crate) async fn persist(ctx: &ServiceCtx, out: &EventSink) {
    let _guard = ctx.settings_persist.acquire().await;
    let settings = out.with_state(|state| state.settings.clone());
    ctx.ports.settings.save(&settings).await;
}

fn sync_runtime_preferences(ctx: &ServiceCtx, out: &EventSink) {
    sync_installs(ctx, out);
    sync_launch_preferences(ctx, out);
    sync_connectivity(ctx, out);
}

/// Tell the connectivity port which backend to start next.
///
/// Applied on load as well as on change, so a preference chosen in a previous
/// session is honoured from the first game rather than the second.
fn sync_connectivity(ctx: &ServiceCtx, out: &EventSink) {
    ctx.ports
        .ice
        .set_backend(out.with_state(|state| state.settings.connectivity.adapter));
}

fn sync_launch_preferences(ctx: &ServiceCtx, out: &EventSink) {
    ctx.ports.process.set_additional_arguments(
        out.with_state(|state| state.settings.game.additional_arguments.clone()),
    );
}

/// Push the current paths into the launcher and report what actually exists.
fn sync_installs(ctx: &ServiceCtx, out: &EventSink) {
    let settings = out.with_state(|state| state.settings.clone());
    ctx.ports
        .process
        .set_paths(settings.game_path, settings.replay_game_path);
    let present = ctx.ports.process.installs_present();
    out.emit(InstallEvent::Checked {
        game_ready: present.game,
        replay_ready: present.replay,
    });
}
