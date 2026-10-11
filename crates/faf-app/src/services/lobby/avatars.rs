//! Avatars: asking which ones this account may wear, choosing one, and putting
//! the previous one back when the one chosen last has lapsed.

use faf_domain::state::{
    reconcile_avatar, remember_avatar, AvatarListStatus, AvatarReconciliation, LobbyEvent,
    NotificationKind, PlayerCardEvent, SettingsEvent, SocialEvent,
};

use crate::runtime::{EventSink, ServiceCtx};
use crate::services::notifications;

/// Ask the server which avatars this account may wear.
///
/// The picker asks when it opens. Login asks too, because the avatar fallback
/// below cannot tell a lapsed avatar from a cleared one without the list.
pub(super) fn load_avatars(ctx: &ServiceCtx, out: &EventSink) {
    out.emit(LobbyEvent::AvatarsLoading);
    if !ctx.ports.lobby.request_avatars() {
        out.emit(LobbyEvent::AvatarsLoadFailed {
            reason: "Connect to the FAF lobby before loading avatars.".into(),
        });
    }
}

/// Send an avatar choice, `None` for no avatar, and mirror it into the player
/// card and the player directory.
///
/// Shared by the picker and the fallback. Returns whether the choice was sent;
/// a refusal has already been reported on the selection status.
pub(super) fn select_avatar(ctx: &ServiceCtx, out: &EventSink, url: Option<String>) -> bool {
    out.emit(LobbyEvent::AvatarSelectionStarted);
    let (available, player, profile) = out.with_state(|state| {
        let available = url.as_deref().and_then(|url| {
            state
                .lobby
                .available_avatars
                .iter()
                .find(|avatar| avatar.url == url)
                .cloned()
        });
        let player = state.auth.player.clone();
        let profile = player.as_ref().and_then(|player| {
            state
                .social
                .players
                .iter()
                .find(|profile| profile.id == player.id)
                .cloned()
        });
        (available, player, profile)
    });
    let choice = match url.as_deref() {
        Some(_) => match available {
            Some(avatar) => Some(avatar),
            None => {
                out.emit(LobbyEvent::AvatarSelectionFailed {
                    reason: "That avatar is not in the server-provided list.".into(),
                });
                return false;
            }
        },
        None => None,
    };

    if !ctx.ports.lobby.select_avatar(url.clone()) {
        out.emit(LobbyEvent::AvatarSelectionFailed {
            reason: "The avatar could not be sent because the lobby is disconnected.".into(),
        });
        return false;
    }

    out.emit(LobbyEvent::AvatarSelectionSucceeded);
    if let Some(player) = player {
        let tooltip = choice
            .as_ref()
            .map(|avatar| avatar.tooltip.clone())
            .unwrap_or_default();
        out.emit(PlayerCardEvent::AvatarSelected {
            player_id: player.id,
            url: url.clone(),
            tooltip: tooltip.clone(),
        });

        if let Some(mut profile) = profile {
            profile.avatar_url = url.unwrap_or_default();
            profile.avatar_tooltip = tooltip;
            out.emit(SocialEvent::PlayersSeen {
                players: vec![profile],
            });
        }
    }
    true
}

/// Record `url` (empty for no avatar) as the newest avatar choice, and save it
/// when that changed anything.
pub(super) async fn remember_own_avatar(ctx: &ServiceCtx, out: &EventSink, url: &str) {
    let history = out.with_state(|state| state.settings.avatar_history.clone());
    let next = remember_avatar(&history, url);
    if next == history {
        return;
    }
    out.emit(SettingsEvent::AvatarHistoryChanged { history: next });
    crate::services::settings::persist(ctx, out).await;
}

/// Put the previous avatar back when the one chosen last has stopped being
/// the player's, typically a rotational tournament avatar that went to the
/// next winner; see `faf_domain::state::reconcile_avatar` for the rules.
///
/// Needs two things the server sends separately and in no fixed order, the
/// list of avatars this account may wear and our own `player_info`, so it is
/// called when either arrives and does nothing until both have. Running it
/// again is harmless: once the choice is remembered, the next pass keeps it.
pub(super) async fn reconcile_own_avatar(ctx: &ServiceCtx, out: &EventSink) {
    let inputs = out.with_state(|state| {
        if state.lobby.avatar_list_status != AvatarListStatus::Ready {
            return None;
        }
        let me = state.auth.player.as_ref()?;
        let current = state
            .social
            .players
            .iter()
            .find(|profile| profile.id == me.id)?
            .avatar_url
            .clone();
        Some((
            state.settings.avatar_history.clone(),
            current,
            state.lobby.available_avatars.clone(),
        ))
    });
    let Some((history, current, available)) = inputs else {
        return;
    };
    match reconcile_avatar(&history, &current, &available) {
        AvatarReconciliation::Keep => {}
        AvatarReconciliation::Remember(url) => remember_own_avatar(ctx, out, &url).await,
        AvatarReconciliation::Restore(url) => {
            if !select_avatar(ctx, out, Some(url.clone())) {
                return;
            }
            remember_own_avatar(ctx, out, &url).await;
            let name = available
                .iter()
                .find(|avatar| avatar.url == url)
                .map(|avatar| avatar.tooltip.trim().to_string())
                .filter(|tooltip| !tooltip.is_empty())
                .unwrap_or_else(|| "the one you wore before".into());
            notifications::add_text(
                out,
                NotificationKind::AvatarRestored,
                notifications::Text::new("notifications.msg.avatarRestored").with("name", &name),
                "Avatar restored",
                format!("Your last avatar is no longer available. Switched back to {name}."),
                None,
            );
        }
    }
}
