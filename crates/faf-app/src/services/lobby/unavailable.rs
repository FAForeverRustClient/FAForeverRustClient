//! A client without a lobby (`LobbyPort::unavailable`): its answer to every
//! lobby command.
//!
//! The Android client's whole lobby service, since none of the other modules
//! is built there. On the desktop a port that has no lobby is answered here
//! as well, every command of it, so the tests that wire `infra::NoLobby` run
//! what the Android client runs.
//!
//! A request that needs the lobby is refused before anything is prepared or
//! downloaded for it, and in one place, so whoever sends it gets the same
//! answer: the reason, in the words the page already uses for a request that
//! did not go out. The port refuses them as well; this is where the player is
//! told.

use faf_domain::state::{LobbyCommand, LobbyEvent, LobbyUnavailable, NotificationAction};

use crate::ports::LobbySendError;
use crate::runtime::{EventSink, ServiceCtx};
use crate::services::notifications;

/// Say why there is no lobby: in the state, where the page reads it, and with
/// the reconnect watchdog disarmed as after a ban, so nothing retries.
pub(super) fn announce(reason: LobbyUnavailable, ctx: &ServiceCtx, out: &EventSink) {
    ctx.lifecycle.stop_lobby();
    out.emit(LobbyEvent::Unavailable { reason });
}

/// Answer `cmd` in a client that has no lobby, for `reason`.
pub(super) fn handle(
    cmd: LobbyCommand,
    reason: LobbyUnavailable,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    let refusal = LobbySendError::Unavailable(reason);
    let (key, title, action) = match cmd {
        LobbyCommand::Connect => {
            announce(reason, ctx, out);
            return;
        }
        // A join is answered on its own state, as every other refusal of one.
        LobbyCommand::Join { id, .. } => {
            out.emit(LobbyEvent::JoinFailed {
                id,
                reason: refusal.reason().into(),
            });
            return;
        }
        LobbyCommand::LoadAvatars => {
            out.emit(LobbyEvent::AvatarsLoadFailed {
                reason: refusal.reason().into(),
            });
            return;
        }
        LobbyCommand::SelectAvatar { .. } => {
            out.emit(LobbyEvent::AvatarSelectionFailed {
                reason: refusal.reason().into(),
            });
            return;
        }
        // The host dialog waits for the launch to fail, as when a host
        // request could not be sent.
        LobbyCommand::Host { .. } => {
            out.emit(LobbyEvent::LaunchFailed {
                reason: refusal.reason().into(),
            });
            ("notifications.msg.hostFailed", "Could not host game", None)
        }
        // Another tab asking for the host dialog, for a tournament match: a
        // dialog that could only end in the refusal above.
        LobbyCommand::PrepareHost { .. } => {
            ("notifications.msg.hostFailed", "Could not host game", None)
        }
        LobbyCommand::StartSearch { .. } | LobbyCommand::Matchmake { start: true, .. } => (
            "notifications.msg.searchFailed",
            "Could not start the search",
            Some(NotificationAction::OpenMatchmaking),
        ),
        LobbyCommand::AcceptPartyInvite { .. } => (
            "notifications.msg.cannotJoinParty",
            "Cannot join the party",
            Some(NotificationAction::OpenMatchmaking),
        ),
        LobbyCommand::InviteToParty { .. } => (
            "notifications.msg.inviteFailed",
            "Could not invite to the party",
            None,
        ),
        // The page's own, with no lobby in them.
        LobbyCommand::ClearHostPrefill => {
            out.emit(LobbyEvent::HostPrefillCleared);
            return;
        }
        LobbyCommand::SetPlayMode { mode } => {
            out.emit(LobbyEvent::PlayModeChanged { mode });
            return;
        }
        // The tray's "Terminate game". A game here is an offline one, with no
        // adapter to stop and no seat to give back.
        LobbyCommand::TerminateGame => {
            ctx.ports.process.kill();
            out.emit(LobbyEvent::GameTerminated);
            return;
        }
        // Nothing to do: without a lobby there is no search to stop, no party
        // to leave, kick from or pick factions for, no queue whose maps to
        // veto, no join to cancel or decline mods for, and no connection to
        // hang up.
        LobbyCommand::Matchmake { start: false, .. }
        | LobbyCommand::LeaveParty
        | LobbyCommand::KickPartyMember { .. }
        | LobbyCommand::SetPartyFactions { .. }
        | LobbyCommand::SetPlayerVetoes { .. }
        | LobbyCommand::DeclineModReplacement
        | LobbyCommand::CancelJoin
        | LobbyCommand::Disconnect => return,
    };
    notifications::add_required_failure(
        out,
        notifications::Text::new(key).with_cause(refusal.cause()),
        title,
        refusal.reason(),
        action,
    );
}
