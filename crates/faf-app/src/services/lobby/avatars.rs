//! Avatars: asking which ones this account may wear, choosing one, and putting
//! the previous one back when the one chosen last has lapsed.

use faf_domain::state::{
    reconcile_avatar, remember_avatar, AvailableAvatar, AvatarListStatus, AvatarReconciliation,
    LobbyEvent, NotificationKind, PlayerCardEvent, SettingsEvent, SocialEvent,
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

/// The part of an avatar address both of FAF's spellings agree on: the file
/// name, percent-decoded and lower-cased.
///
/// The lobby server lists and accepts avatars by `avatars_list.url`, a string
/// stored in its database. The FAF API builds its own `avatar.url` from the
/// file name and the content host, path-encoded. The player card reads the
/// API, so a click there carried the API's spelling, and wherever the two
/// differ (an older host, `http`, a space against `%20`) the exact comparison
/// below refused it without a word: two of one player's avatars could not be
/// worn at all (#597).
fn avatar_key(url: &str) -> String {
    let path = url.split(['?', '#']).next().unwrap_or_default();
    let file = path.rsplit('/').next().unwrap_or_default();
    percent_decode(file).to_lowercase()
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let hex = bytes
            .get(index + 1..index + 3)
            .and_then(|pair| std::str::from_utf8(pair).ok())
            .and_then(|pair| u8::from_str_radix(pair, 16).ok());
        match (bytes[index], hex) {
            (b'%', Some(byte)) => {
                decoded.push(byte);
                index += 3;
            }
            (byte, _) => {
                decoded.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

/// The server's own entry for an avatar address in either spelling: the
/// exact one first, then by file name.
fn find_available<'a>(available: &'a [AvailableAvatar], url: &str) -> Option<&'a AvailableAvatar> {
    available
        .iter()
        .find(|avatar| avatar.url == url)
        .or_else(|| {
            let key = avatar_key(url);
            available
                .iter()
                .find(|avatar| avatar_key(&avatar.url) == key)
        })
}

/// Send an avatar choice, `None` for no avatar, and mirror it into the player
/// card and the player directory.
///
/// Shared by the picker and the fallback. Returns the address the server was
/// sent, in its own spelling (empty for no avatar), or `None` when nothing was
/// sent; a refusal has already been reported on the selection status.
pub(super) fn select_avatar(
    ctx: &ServiceCtx,
    out: &EventSink,
    url: Option<String>,
) -> Option<String> {
    out.emit(LobbyEvent::AvatarSelectionStarted);
    let (available, player, profile) = out.with_state(|state| {
        let available = url
            .as_deref()
            .and_then(|url| find_available(&state.lobby.available_avatars, url).cloned());
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
                return None;
            }
        },
        None => None,
    };
    // What the server compares against, whichever spelling was clicked.
    let sent = choice.as_ref().map(|avatar| avatar.url.clone());

    if !ctx.ports.lobby.select_avatar(sent.clone()) {
        out.emit(LobbyEvent::AvatarSelectionFailed {
            reason: "The avatar could not be sent because the lobby is disconnected.".into(),
        });
        return None;
    }

    out.emit(LobbyEvent::AvatarSelectionSucceeded);
    if let Some(player) = player {
        let tooltip = choice
            .as_ref()
            .map(|avatar| avatar.tooltip.clone())
            .unwrap_or_default();
        // The card in the spelling it was drawn with, so the tile clicked is
        // the one marked; everyone else sees the server's.
        out.emit(PlayerCardEvent::AvatarSelected {
            player_id: player.id,
            url: url.clone(),
            tooltip: tooltip.clone(),
        });

        if let Some(mut profile) = profile {
            profile.avatar_url = sent.clone().unwrap_or_default();
            profile.avatar_tooltip = tooltip;
            out.emit(SocialEvent::PlayersSeen {
                players: vec![profile],
            });
        }
    }
    Some(sent.unwrap_or_default())
}

/// Record `url` (empty for no avatar) as the newest avatar choice, and save it
/// when that changed anything.
///
/// Read and written under the settings merge lock, like every other write of
/// a settings field from outside the settings service: two avatar choices in
/// quick succession could otherwise each build on the history before either.
pub(super) async fn remember_own_avatar(ctx: &ServiceCtx, out: &EventSink, url: &str) {
    let changed = ctx.settings.merge_and_emit(out, |settings| {
        let next = remember_avatar(&settings.avatar_history, url);
        if next == settings.avatar_history {
            return (None, false);
        }
        (
            Some(SettingsEvent::AvatarHistoryChanged { history: next }),
            true,
        )
    });
    if changed {
        crate::services::settings::persist(ctx, out).await;
    }
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
            let Some(sent) = select_avatar(ctx, out, Some(url.clone())) else {
                return;
            };
            remember_own_avatar(ctx, out, &sent).await;
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

#[cfg(test)]
mod tests {
    use super::*;

    fn avatar(url: &str) -> AvailableAvatar {
        AvailableAvatar {
            url: url.into(),
            tooltip: String::new(),
        }
    }

    #[test]
    fn an_avatar_is_found_in_either_spelling_of_its_address() {
        // #597: the lobby lists its database string, the player card shows
        // the API's address built from the file name.
        let available = [
            avatar("http://content.faforever.com/faf/avatars/Lightning Bolt.png"),
            avatar("https://content.faforever.com/faf/avatars/aeon.png"),
        ];
        let found = find_available(
            &available,
            "https://content.faforever.com/faf/avatars/Lightning%20Bolt.png",
        )
        .unwrap();
        assert_eq!(found.url, available[0].url);
        assert_eq!(
            find_available(
                &available,
                "https://content.faforever.com/faf/avatars/aeon.png"
            )
            .unwrap()
            .url,
            available[1].url
        );
        assert!(find_available(
            &available,
            "https://content.faforever.com/faf/avatars/uef.png"
        )
        .is_none());
    }

    #[test]
    fn the_key_is_the_decoded_file_name() {
        assert_eq!(avatar_key("https://a.b/x/Pearl%203.PNG?v=2"), "pearl 3.png");
        assert_eq!(avatar_key("Pearl3.png"), "pearl3.png");
        // A stray percent sign is kept, not dropped.
        assert_eq!(avatar_key("https://a.b/100%.png"), "100%.png");
    }
}
