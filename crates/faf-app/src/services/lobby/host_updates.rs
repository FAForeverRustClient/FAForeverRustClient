//! Bringing a hosted game's map and mods up to date first, when the player
//! asked for that (`GamePreferences::auto_update_map_and_mods`).
//!
//! The Java client's `CreateGameController.hostGameAfterMapAndModUpdate`: the
//! chosen map becomes its newest vault version, and every mod with a newer
//! version is updated before the server is asked for a lobby. Unlike the Java
//! client this is off unless switched on, and the older map version stays on
//! disk: the switch is about hosting on current content, not about tidying
//! folders, and a map somebody kept on purpose is theirs. A mod is updated in
//! place, because its versions share one folder.
//!
//! Nothing here stops the host. A lookup or an update that fails leaves that
//! map or mod as it was, says so for a mod, and the game is hosted with what
//! is there, which is what the Java client does too.
//!
//! A host the player calls off, or a newer join or host, ends this work: no
//! further lookup, download or progress after that. A mod whose folder swap
//! has already begun finishes it (see `ModsPort::update_mod_reporting`), so a
//! call-off never leaves a mod half replaced.

use std::sync::Arc;

use faf_domain::protocol::map_generator::is_generated_map;
use faf_domain::state::{
    official_map_name, HostGameConfig, LobbyEvent, ModsEvent, PreparationPhase,
};
use tokio_util::sync::CancellationToken;

use crate::runtime::{EventSink, LobbyOperation, ServiceCtx};
use crate::services::notifications;

/// The host this work belongs to, and how to tell it is still wanted.
struct Host<'a> {
    ctx: &'a ServiceCtx,
    out: &'a EventSink,
    operation: LobbyOperation,
    called_off: CancellationToken,
}

impl Host<'_> {
    fn live(&self) -> bool {
        !self.called_off.is_cancelled() && self.ctx.lobby.operations.is_live(self.operation)
    }

    /// Progress for this host only: a retired one must not put a preparation
    /// back on screen over whatever replaced it.
    fn progress(&self, phase: PreparationPhase, detail: &str) {
        if self.live() {
            self.out.emit(LobbyEvent::Preparing {
                phase,
                detail: detail.to_owned(),
                progress: None,
            });
        }
    }
}

/// `config` with its map switched to the newest version, after updating the
/// enabled mods, when the preference is on. Otherwise `config` unchanged.
///
/// Run inside `LobbyOperations::run` for `operation`, so the call-off token
/// taken here is that operation's.
pub(super) async fn bring_up_to_date(
    mut config: HostGameConfig,
    operation: LobbyOperation,
    ctx: &ServiceCtx,
    out: &EventSink,
) -> HostGameConfig {
    let wanted = out.with_state(|state| state.settings.game.auto_update_map_and_mods);
    // A co-op mission is a fixed scenario with its own launch surface.
    if !wanted || config.mod_name.eq_ignore_ascii_case("coop") {
        return config;
    }
    let host = Host {
        ctx,
        out,
        operation,
        called_off: ctx.lobby.launch_called_off(),
    };
    if let Some(latest) = newest_map_version(&config.map, &host).await {
        tracing::info!(from = %config.map, to = %latest, "hosting on the map's newest version");
        config.map = latest;
    }
    update_enabled_mods(&host).await;
    config
}

/// The folder of the newest vault version of the map installed as `map`, when
/// that is a different folder. `None` for an official or generated map, a map
/// the vault does not know, one already current, a failed lookup, or a host
/// that was called off meanwhile.
async fn newest_map_version(map: &str, host: &Host<'_>) -> Option<String> {
    if map.is_empty() || is_generated_map(map) || official_map_name(map).is_some() || !host.live() {
        return None;
    }
    host.progress(PreparationPhase::Asking, map);
    let found = match host
        .ctx
        .ports
        .maps
        .find_vault_maps_by_folder(&[map.to_owned()])
        .await
    {
        Ok(found) => found,
        Err(reason) => {
            tracing::warn!(%reason, map, "could not look up the map's newest version");
            return None;
        }
    };
    if !host.live() {
        return None;
    }
    newest_folder(map, found.iter().map(|vault| vault.folder_name.as_str()))
}

/// The first folder that differs from `map`, ignoring case. The lookup asks
/// for the map that owns `map` and answers with that map's latest version, so
/// one answer is the norm.
fn newest_folder<'a>(map: &str, latest: impl IntoIterator<Item = &'a str>) -> Option<String> {
    latest
        .into_iter()
        .next()
        .filter(|folder| !folder.is_empty() && !folder.eq_ignore_ascii_case(map))
        .map(str::to_owned)
}

/// Update every enabled mod whose vault has a newer version, keeping it
/// enabled under that version's uid. Stops at the first sign the host was
/// called off.
async fn update_enabled_mods(host: &Host<'_>) {
    let (ctx, out) = (host.ctx, host.out);
    if !host.live() {
        return;
    }
    let installed = match ctx.ports.mods.list_installed().await {
        Ok(installed) => installed,
        Err(reason) => {
            tracing::warn!(%reason, "could not list installed mods before hosting");
            return;
        }
    };
    for installed_mod in installed.into_iter().filter(|mod_| mod_.enabled) {
        if !host.live() {
            return;
        }
        let latest = match ctx.ports.mods.latest_mod_version(&installed_mod.uid).await {
            // A uid the vault does not know is a copy built locally: left alone.
            Ok(Some(latest)) if latest.uid != installed_mod.uid => latest,
            Ok(_) => continue,
            Err(reason) => {
                tracing::warn!(%reason, uid = %installed_mod.uid, "could not look up a mod's newest version");
                continue;
            }
        };
        if !host.live() {
            return;
        }
        host.progress(PreparationPhase::Downloading, &installed_mod.display_name);
        out.emit(ModsEvent::Installing {
            uid: latest.uid.clone(),
        });
        match ctx
            .ports
            .mods
            .update_mod_reporting(
                latest.uid.clone(),
                installed_mod.folder_name.clone(),
                latest.download_url,
                Arc::new(|_| {}),
                host.called_off.clone(),
            )
            .await
        {
            // Called off before the swap: the installed version is untouched.
            Ok(None) => {
                out.emit(ModsEvent::InstallCancelled { uid: latest.uid });
                return;
            }
            Ok(Some(installed)) => {
                tracing::info!(
                    name = %installed_mod.display_name,
                    from = %installed_mod.version,
                    to = %latest.version,
                    "updated a mod before hosting"
                );
                out.emit(ModsEvent::Installed { installed });
            }
            Err(reason) => {
                out.emit(ModsEvent::InstallFailed {
                    reason: reason.clone(),
                });
                if host.live() {
                    notifications::add_failure(
                        out,
                        notifications::Text::new("notifications.msg.hostModUpdateFailed")
                            .with("name", &installed_mod.display_name),
                        format!(
                            "Could not update {} before hosting",
                            installed_mod.display_name
                        ),
                        reason,
                    );
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_different_latest_folder_replaces_the_chosen_map() {
        assert_eq!(
            newest_folder("dualgap.v0003", ["dualgap.v0005"]),
            Some("dualgap.v0005".into())
        );
        assert_eq!(newest_folder("DualGap.v0005", ["dualgap.v0005"]), None);
        assert_eq!(newest_folder("dualgap.v0005", [""]), None);
        assert_eq!(newest_folder("dualgap.v0005", std::iter::empty()), None);
    }
}
