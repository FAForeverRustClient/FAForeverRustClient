//! Joining and hosting a custom game: the rating gate, preparing the mods and
//! the map before the server is asked, and calling a join off.

use faf_domain::state::{
    with_go_adapter_tag, HostGameConfig, HostGamePreferences, IceAdapter, JoinState, LobbyEvent,
    SettingsEvent,
};

use crate::ports::ModPrepFailure;
use crate::runtime::{EventSink, ServiceCtx};
use crate::services::launcher;
use crate::services::notifications;

use super::launch::terminate_game;

/// Join game `id`: `LobbyCommand::Join`.
pub(super) async fn join(
    id: i32,
    password: Option<String>,
    replace_mods: bool,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    // A new join starts uncancelled, whatever the last one did, under
    // an id of its own: a cancelled join still draining its
    // preparation keeps reading "cancelled" for its own id.
    let operations = &ctx.lobby.operations;
    let Some(operation) = operations.try_begin_join(id) else {
        return;
    };

    if !out.with_state(|state| {
        matches!(
            state.lobby.status,
            faf_domain::state::LobbyStatus::Connected
        )
    }) {
        operations.release_join(operation);
        out.emit(LobbyEvent::JoinFailed {
            id,
            reason: "not connected to the lobby".into(),
        });
        return;
    }

    // A host who enforced a rating range meant it. The server hides
    // such a lobby from out-of-range players, but a game already on
    // the list when the range was set, or reached from a link, still
    // gets this far, and preparing a join for minutes before the
    // server refuses it is the worst of both.
    if let Some(reason) = out.with_state(|state| rating_gate_refusal(state, id)) {
        operations.release_join(operation);
        out.emit(LobbyEvent::JoinFailed { id, reason });
        return;
    }

    out.emit(LobbyEvent::Joining {
        id,
        prepared: false,
    });
    if ctx.ports.process.supports_live_launch() {
        let game =
            out.with_state(|state| state.lobby.games.iter().find(|game| game.id == id).cloned());
        let Some(game) = game else {
            operations.release_join(operation);
            out.emit(LobbyEvent::JoinFailed {
                id,
                reason: "the game is no longer available".into(),
            });
            return;
        };
        let prepared = operations
            .run(
                operation,
                launcher::prepare_custom_join(&game, ctx, out, replace_mods),
            )
            .await;
        // Preparation can take minutes, which is long enough for the
        // user to give up on it, and for them to start another join
        // after that. Nothing below may run for a join that was
        // called off or replaced while its files came down: not its
        // outcome, not its progress, not its request. No event
        // either: `CancelJoin` already said so, and the join state
        // now belongs to whatever replaced this one.
        if !operations.is_live(operation) {
            tracing::info!(
                game_id = id,
                "lobby: the join was called off during preparation; not joining"
            );
            operations.release_join(operation);
            return;
        }
        match prepared {
            Ok(()) => {}
            // Nothing was installed or deleted: the user has to say
            // whether the versions already on disk may be replaced,
            // and the answer comes back as another `Join`.
            Err(ModPrepFailure::Conflicts(conflicts)) => {
                operations.release_join(operation);
                out.emit(LobbyEvent::JoinNeedsModReplacement { id, conflicts });
                return;
            }
            Err(ModPrepFailure::Failed(reason)) => {
                operations.release_join(operation);
                launcher::report_failure(ctx, out, reason);
                return;
            }
        }
        // Return to an explicit joining state while waiting for the
        // server's accept/reject response.
        out.emit(LobbyEvent::Joining { id, prepared: true });
    }
    // Checked again right before the request: the boundary above is
    // only reached on the live-launch path. The check and the "sent"
    // mark are one step, so a cancel cannot slip between them.
    if !operations.try_mark_join_sent(operation) {
        operations.release_join(operation);
        return;
    }
    if !ctx.ports.lobby.join(id, password) {
        operations.release_join(operation);
        out.emit(LobbyEvent::JoinFailed {
            id,
            reason: "the join request could not be sent".into(),
        });
    }
}

/// Host a game: `LobbyCommand::Host`.
pub(super) async fn host(config: HostGameConfig, ctx: &ServiceCtx, out: &EventSink) {
    match config.validated() {
        Ok(config) => {
            // A new host starts uncancelled, whatever the last join did,
            // under an id of its own; see the same note on `Join`.
            let operations = &ctx.lobby.operations;
            let operation = operations.begin();
            // The map has to be on disk before the server is asked for a
            // lobby, because its reply will not mention one: see
            // `launcher::prepare_host`. Guarded the way the join path is,
            // so an offline shell still exercises the request itself.
            if ctx.ports.process.supports_live_launch() {
                let prepared = operations
                    .run(operation, launcher::prepare_host(&config, ctx, out))
                    .await;
                // Cancelled while the files came down, which for a co-op
                // mission is a long download, or replaced by a newer join
                // or host. The join path has always stopped here; the host
                // path sent its request anyway, the server answered with a
                // launch order, and the game Cancel had just been pressed
                // on started regardless. The dialog already closed on
                // `CancelJoin`, so there is nothing to emit, not even a
                // failure: that would land on the newer operation's state.
                if !operations.is_live(operation) {
                    tracing::info!(
                        "lobby: the host was called off during preparation; not hosting"
                    );
                    return;
                }
                if let Err(reason) = prepared {
                    launcher::report_failure(ctx, out, reason);
                    return;
                }
            }
            // Co-op owns a separate launch surface in both references, so
            // it remembers into its own slot: one mission must not replace
            // the custom-game form somebody set up for skirmishes.
            let remembered = HostGamePreferences {
                title: config.title.clone(),
                featured_mod: config.mod_name.clone(),
                visibility: config.visibility.clone(),
                map: config.map.clone(),
                password_enabled: config.password.is_some(),
                password: config.password.clone().unwrap_or_default(),
                enforce_rating_range: config.enforce_rating_range,
                // An open end stays open: see `HostGamePreferences::rating_min`.
                rating_min: config.rating_min,
                rating_max: config.rating_max,
            };
            // The browsing group is the one the UI patches most (filters,
            // columns, views), so it is read and written back under the
            // settings merge lock: a patch landing in between used to be put
            // back to its old value by this write.
            let coop = config.mod_name == "coop";
            ctx.settings.merge_and_emit(out, |settings| {
                let mut browsing = settings.browsing.clone();
                if coop {
                    browsing.host_coop = remembered;
                } else {
                    browsing.host_game = remembered;
                }
                (
                    SettingsEvent::BrowsingChanged {
                        preferences: Box::new(browsing),
                    },
                    (),
                )
            });
            // Hosted on Go, the title says so, for everybody on Dynamic to
            // join on Go as well; see `GO_ADAPTER_TITLE_TAG`. After the
            // remembered form above, which keeps the title as typed.
            let config = if ctx.ports.ice.hosting_adapter() == IceAdapter::Go {
                HostGameConfig {
                    title: with_go_adapter_tag(&config.title),
                    ..config
                }
            } else {
                config
            };
            *ctx.lobby.hosted_title.lock().unwrap() = Some(config.title.clone());
            ctx.ports.lobby.host(config);
            crate::services::settings::persist(ctx, out).await;
        }
        Err(reason) => {
            tracing::warn!(reason, "invalid host-game request rejected");
            notifications::add_failure(
                out,
                notifications::Text::new("notifications.msg.hostFailed"),
                "Could not host game",
                reason,
            );
        }
    }
}

/// Call the join in flight off: `LobbyCommand::CancelJoin`.
pub(super) fn cancel_join(ctx: &ServiceCtx, out: &EventSink) {
    // Past the point where the game process is up, "cancel" means the
    // same thing as leaving: there is a running FA and an ICE session
    // to take down, and no join left to call off.
    let launched = out.with_state(|state| {
        matches!(
            state.lobby.join,
            JoinState::Launched { .. } | JoinState::InGame
        )
    });
    if launched {
        terminate_game(ctx, out);
        return;
    }
    // Before that, calling the operation off is what stops the work:
    // its token reaches the updater, which stops at its next safe point
    // (between two files, or mid-download), preparation checks its own
    // operation at its next step boundary, and the join request is not
    // sent. The slot is freed now, so the user can pick another game
    // while the cancelled preparation finishes the file it is on; that
    // preparation can no longer touch the new join, because it is
    // checking a different id. A join whose request already went out is
    // remembered, so the launch order the server still sends for it is
    // turned away.
    ctx.lobby.operations.cancel();
    ctx.lobby.operations.call_off_join();
    out.emit(LobbyEvent::JoinCancelled);
}

/// Why this account may not join game `id`, or `None` when nothing stops it.
///
/// Reads the same three facts the lobby server reads in
/// `Game.is_visible_to_player`: the host's flag, the host's bounds, and this
/// player's displayed rating on the board the game is played for.
fn rating_gate_refusal(state: &faf_domain::AppState, id: i32) -> Option<String> {
    let game = state.lobby.games.iter().find(|game| game.id == id)?;
    if !game.enforce_rating_range {
        return None;
    }
    let player = state.auth.player.as_ref()?;
    let profile = state
        .social
        .players
        .iter()
        .find(|profile| profile.login.eq_ignore_ascii_case(&player.name))?;
    let rating = faf_domain::state::rating_for_game(profile, game)?;
    if !faf_domain::state::rating_gate_blocks(game, Some(rating)) {
        return None;
    }
    Some(match (game.rating_min, game.rating_max) {
        (Some(minimum), Some(maximum)) => format!(
            "this lobby is limited to ratings {minimum} to {maximum}, and yours is {rating}"
        ),
        (Some(minimum), None) => {
            format!("this lobby is limited to ratings {minimum} and above, and yours is {rating}")
        }
        (None, Some(maximum)) => {
            format!("this lobby is limited to ratings {maximum} and below, and yours is {rating}")
        }
        (None, None) => "this lobby enforces a rating range you are outside of".to_string(),
    })
}
