//! The server-update dispatch: each [`LobbyUpdate`] the connect loop reads is
//! turned into events here, or handed to the lifecycle that owns it.

use faf_domain::state::{
    ChatEvent, ChatStatus, LobbyEvent, NotificationAction, NotificationKind, SocialEvent,
};

use crate::ports::{LobbyUpdate, ServerNoticeStyle};
use crate::runtime::{EventSink, ServiceCtx};
use crate::services::notifications;

use super::avatars::{load_avatars, reconcile_own_avatar};
use super::connection::restore_game_session;
use super::game_notifications::{notify_game_signal, GameNotificationTracker};
use super::launch::{on_game_relay, on_launch_order, terminate_game, Background, LaunchSlot};
use super::matchmaking::{
    on_matchmaking, on_party, on_queues, on_vetoes, restore_player_vetoes, send_party_factions,
};

pub(super) async fn handle_update<'a>(
    update: LobbyUpdate,
    ctx: &'a ServiceCtx,
    out: &'a EventSink,
    launch_enabled: bool,
    launch: &mut LaunchSlot,
    background: &mut Background<'a>,
    game_notifications: &mut GameNotificationTracker,
) {
    match update {
        LobbyUpdate::Authenticated => {
            game_notifications.mark_authenticated();
            out.emit(LobbyEvent::Connected);
            send_party_factions(ctx, out);
            restore_player_vetoes(ctx, out);
            restore_game_session(ctx);
            load_avatars(ctx, out);
        }
        // Back to the state the first attempt starts in. Deliberately not
        // `Disconnected`, which clears every list the lobby has sent: the
        // server resends all of it on the replacement connection within
        // seconds, and emptying the Play tab in the meantime would turn a blip
        // nobody needed to see into a visible one.
        LobbyUpdate::Reconnecting => out.emit(LobbyEvent::Connecting),
        LobbyUpdate::Games(games) => {
            let (preferences, player_name) = out.with_state(|state| {
                (
                    state.settings.notifications.clone(),
                    state.auth.player.as_ref().map(|player| player.name.clone()),
                )
            });
            for signal in game_notifications.observe_open(&games, player_name.as_deref()) {
                notify_game_signal(out, &preferences, signal);
            }
            out.emit(LobbyEvent::GamesUpdated { games });
        }
        LobbyUpdate::LiveGames(games) => {
            let (preferences, friends, player_name) = out.with_state(|state| {
                (
                    state.settings.notifications.clone(),
                    state.social.friends.clone(),
                    state.auth.player.as_ref().map(|player| player.name.clone()),
                )
            });
            for signal in game_notifications.observe_live(&games, &friends, player_name.as_deref())
            {
                notify_game_signal(out, &preferences, signal);
            }
            out.emit(LobbyEvent::LiveGamesUpdated { games })
        }
        LobbyUpdate::GamesChanged { upserted, removed } => {
            // Only the two fields the signals need, and only when there is a
            // signal to work out: this runs on the lobby's hottest frame.
            if !upserted.is_empty() || !removed.is_empty() {
                let (preferences, player_name) = out.with_state(|state| {
                    (
                        state.settings.notifications.clone(),
                        state.auth.player.as_ref().map(|player| player.name.clone()),
                    )
                });
                for signal in game_notifications.observe_open_delta(
                    &upserted,
                    &removed,
                    player_name.as_deref(),
                ) {
                    notify_game_signal(out, &preferences, signal);
                }
            }
            out.emit(LobbyEvent::GamesChanged { upserted, removed });
        }
        LobbyUpdate::LiveGamesChanged { upserted, removed } => {
            if !upserted.is_empty() || !removed.is_empty() {
                let (preferences, friends, player_name) = out.with_state(|state| {
                    (
                        state.settings.notifications.clone(),
                        state.social.friends.clone(),
                        state.auth.player.as_ref().map(|player| player.name.clone()),
                    )
                });
                for signal in game_notifications.observe_live_delta(
                    &upserted,
                    &removed,
                    &friends,
                    player_name.as_deref(),
                ) {
                    notify_game_signal(out, &preferences, signal);
                }
            }
            out.emit(LobbyEvent::LiveGamesChanged { upserted, removed });
        }
        LobbyUpdate::MatchmakerQueues(queues) => on_queues(queues, ctx, out, game_notifications),
        LobbyUpdate::Matchmaking(state) => {
            on_matchmaking(state, ctx, out, launch_enabled, launch, background)
        }
        LobbyUpdate::Party(party) => on_party(party, ctx, out),
        LobbyUpdate::PartyInvite { player_id, login } => {
            if out.with_state(|state| state.settings.notifications.party_invites) {
                notifications::add_text(
                    out,
                    NotificationKind::PartyInvite,
                    notifications::Text::new("notifications.msg.partyInvite").with("login", &login),
                    "Party invitation",
                    format!("{login} invited you to their matchmaker party."),
                    Some(NotificationAction::AcceptPartyInvite { player_id }),
                );
            }
        }
        // The server only sends this when it has *changed* the selection:
        // pools move between releases, and a veto on a map that left the pool,
        // or one token too many for a pool that shrank, is capped rather than
        // rejected. What it hands back is what is actually in force, so it
        // replaces what we remembered instead of being merged with it.
        LobbyUpdate::Vetoes { vetoes, forced } => on_vetoes(vetoes, forced, ctx, out).await,
        LobbyUpdate::Launch(launch_order) => {
            on_launch_order(launch_order, ctx, out, launch_enabled, launch, background)
        }
        LobbyUpdate::JoinFailed { id, reason } => {
            // A refusal for a join the user has since called off arrives late
            // and names the old game. It used to free the newer join's slot and
            // replace its progress with "failed" for a game nobody is joining.
            if ctx.lobby.operations.release_join_for_game(id) {
                out.emit(LobbyEvent::JoinFailed { id, reason })
            } else {
                tracing::info!(game_id = id, %reason, "ignored a join refusal for a join no longer pending");
            }
        }
        LobbyUpdate::Relations { friends, foes } => {
            out.emit(SocialEvent::RelationsUpdated { friends, foes })
        }
        LobbyUpdate::AutoJoinChannels(channels) => {
            // Recorded first: the reducer normalizes the names, and if chat is
            // not connected yet the chat service picks the list up from state
            // the moment it is. If chat *is* already up, this message is the
            // only announcement we get, so act on it now.
            out.emit(ChatEvent::AutoJoinAnnounced { channels });
            join_auto_channels(ctx, out);
        }
        LobbyUpdate::PlayersSeen(players) => {
            let newly_online = out.with_state(|state| {
                if !state.settings.notifications.friend_online {
                    return Vec::new();
                }
                players
                    .iter()
                    .filter(|player| {
                        state.social.player(&player.login).is_none()
                            && state.social.is_friend(&player.login)
                    })
                    .map(|player| player.login.clone())
                    .collect::<Vec<_>>()
            });
            for login in newly_online {
                notifications::add_text(
                    out,
                    NotificationKind::FriendOnline,
                    notifications::Text::new("notifications.msg.friendOnline")
                        .with("login", &login),
                    "Friend online",
                    format!("{login} is now online."),
                    None,
                );
            }
            let names_us = out.with_state(|state| {
                state
                    .auth
                    .player
                    .as_ref()
                    .is_some_and(|me| players.iter().any(|player| player.login == me.name))
            });
            out.emit(SocialEvent::PlayersSeen { players });
            // Our own `player_info` is what carries our country, and the
            // language channel is derived from it. It routinely arrives after
            // chat has connected, so this is the second half of that race.
            if names_us {
                join_auto_channels(ctx, out);
                // The other half of the avatar fallback's input; the list is
                // the first half, asked for at login.
                reconcile_own_avatar(ctx, out).await;
            }
        }
        LobbyUpdate::PlayersRemoved(players) => {
            let offline_friends = out.with_state(|state| {
                if !state.settings.notifications.friend_offline {
                    return Vec::new();
                }
                players
                    .iter()
                    .filter(|player| state.social.is_friend(&player.login))
                    .map(|player| player.login.clone())
                    .collect::<Vec<_>>()
            });
            for login in offline_friends {
                notifications::add_text(
                    out,
                    NotificationKind::FriendOffline,
                    notifications::Text::new("notifications.msg.friendOffline")
                        .with("login", &login),
                    "Friend offline",
                    format!("{login} is now offline."),
                    None,
                );
            }
            out.emit(SocialEvent::PlayersRemoved {
                logins: players.into_iter().map(|player| player.login).collect(),
            });
        }
        LobbyUpdate::Avatars(avatars) => {
            out.emit(LobbyEvent::AvatarsLoaded { avatars });
            reconcile_own_avatar(ctx, out).await;
        }
        LobbyUpdate::Notice { style, text } => {
            let (kind, key, title) = match style {
                ServerNoticeStyle::Info => (
                    NotificationKind::ServerNotice,
                    "serverInfo",
                    "Message from server",
                ),
                ServerNoticeStyle::Warning => (
                    NotificationKind::ServerWarning,
                    "serverWarning",
                    "Warning from server",
                ),
                ServerNoticeStyle::Error => {
                    (NotificationKind::Error, "serverError", "Error from server")
                }
                ServerNoticeStyle::Kill => (
                    NotificationKind::Error,
                    "serverKill",
                    "Game stopped by server",
                ),
                ServerNoticeStyle::Kick => (
                    NotificationKind::Error,
                    "serverKick",
                    "Disconnected by server",
                ),
            };
            // The body is the server's own words, so only the title has an entry.
            notifications::add_required_text(
                out,
                kind,
                notifications::Text::new(format!("notifications.msg.{key}")),
                title,
                text,
                None,
            );
            if style == ServerNoticeStyle::Kill {
                if background.launch.is_some() {
                    launch.called_off = true;
                }
                terminate_game(ctx, out);
                launch.session = None;
            } else if style == ServerNoticeStyle::Kick {
                // The server ended this session on purpose, which is not a
                // drop to recover from. Reconnecting would also fight
                // whatever caused the kick: signed in from another client,
                // the two would take the session from each other every few
                // seconds. A later explicit Connect arms the watchdog again.
                ctx.lobby.auto_reconnect.disarm();
                ctx.ports.lobby.disconnect();
            }
        }
        LobbyUpdate::ConnectionRejected { reason } => {
            notifications::add_required_text(
                out,
                NotificationKind::Error,
                notifications::Text::new("notifications.msg.connectionRejected"),
                "Lobby connection rejected",
                reason,
                None,
            );
        }
        LobbyUpdate::GameRelay { command, args } => {
            on_game_relay(command, args, launch, background).await
        }
    }
}

/// Join whatever this account should now be in, if chat is up to receive it.
///
/// Called from the lobby side because both inputs to the list arrive here: the
/// server's `social` announcement, and our own `player_info` (which carries the
/// country the language channel is derived from). When chat is not connected
/// yet, nothing is needed: `services::chat` runs the same computation the
/// moment it is.
fn join_auto_channels(ctx: &ServiceCtx, out: &EventSink) {
    let channels = out.with_state(|state| {
        if state.chat.status == ChatStatus::Connected {
            faf_domain::state::auto_join_channels(state, &ctx.ports.os_language)
        } else {
            Vec::new()
        }
    });
    for channel in channels {
        ctx.ports.chat.join_channel(channel);
    }
}
