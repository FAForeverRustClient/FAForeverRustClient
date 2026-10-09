//! Matchmaking: starting and stopping a search, the party, a match found and
//! the watchdog for one that never starts, the queues, the vetoes and the map
//! pools seen.

use std::time::Instant;

use faf_domain::state::{
    JoinState, LobbyEvent, MatchmakerQueue, MatchmakingState, NotificationAction, NotificationKind,
    PartyState, PlayerVeto, SettingsEvent,
};

use crate::runtime::{EventSink, LatestRequest, ServiceCtx};
use crate::services::launcher;
use crate::services::notifications;

use super::game_notifications::GameNotificationTracker;
use super::launch::{terminate_game, Background, LaunchSlot};

/// How long a found match may sit there before the client stops believing in
/// it.
///
/// `match_found` says the server has paired you; `game_launch` is the order to
/// actually start, and it follows within seconds when it follows at all. The
/// server gives up on a match that does not come together and stops being
/// willing to start it, but it does not always say so, and this client then
/// waited: the report was fifteen minutes of "preparing for game start" for a
/// game that could not be started any more.
///
/// Two minutes is beyond the server's own patience: it gives the host sixty
/// seconds to start the game and the guests sixty more plus ten each
/// (`LadderService.launch_match`), then cancels. It deliberately does not cover
/// [`MatchmakingState::Launching`], which ends with the process or with the
/// launch failing.
const MATCH_START_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// Start or stop the search in one queue: `LobbyCommand::Matchmake`.
pub(super) fn matchmake(queue_name: String, start: bool, ctx: &ServiceCtx, out: &EventSink) {
    // Stopping a search that is still being prepared stops the
    // preparation from asking for it: `start_search` checks the state
    // before it sends anything. The `stop` still goes out, which the
    // server answers with nothing when it has no such search.
    if !start
        && out.with_state(|state| {
            matches!(state.lobby.matchmaking, MatchmakingState::Preparing { .. })
        })
    {
        out.emit(LobbyEvent::MatchmakingUpdated {
            state: MatchmakingState::Idle,
        });
        // And the updater behind it stops at its next safe point, which lets
        // the launcher's preparation lock go: a join or a search started
        // straight after used to wait for the whole update, unnarrated. After
        // the state, so the preparation finds its search no longer wanted.
        ctx.lobby.search_preparation.cancel(|_| true);
    }
    ctx.ports.lobby.matchmake(queue_name, start)
}

/// Leave the party: `LobbyCommand::LeaveParty`.
pub(super) fn leave_party(ctx: &ServiceCtx, out: &EventSink) {
    ctx.ports.lobby.leave_party();
    // Optimistic, and the same event `kicked_from_party` raises: the
    // server's own answer is a snapshot of the party you are no longer
    // in, which the filter above turns into this anyway. Emitting it
    // here means the seat list empties on the press rather than on the
    // round trip.
    out.emit(LobbyEvent::PartyUpdated {
        party: PartyState::default(),
    });
}

/// Invite a player to the party: `LobbyCommand::InviteToParty`.
pub(super) fn invite_to_party(player_id: i32, ctx: &ServiceCtx, out: &EventSink) {
    // Java's `TeamMatchmakingService.invitePlayer`. The server would
    // accept the invitation and then refuse the invitee with "That
    // party is already in queue", which is the wrong person to tell.
    if out.with_state(|state| state.lobby.matchmaking.is_looking()) {
        notifications::add_required_text(
            out,
            NotificationKind::Error,
            notifications::Text::new("notifications.msg.cannotInvite"),
            "Cannot invite now",
            "Stop the search before inviting somebody to the party.",
            Some(NotificationAction::OpenMatchmaking),
        );
        return;
    }
    ctx.ports.lobby.invite_to_party(player_id)
}

/// Accept a party invitation: `LobbyCommand::AcceptPartyInvite`.
pub(super) fn accept_party_invite(player_id: i32, ctx: &ServiceCtx, out: &EventSink) {
    if let Some(refusal) = out.with_state(|state| party_join_refusal(state, ctx, player_id)) {
        notifications::add_required_text(
            out,
            NotificationKind::Error,
            notifications::Text::new("notifications.msg.cannotJoinParty"),
            "Cannot join the party",
            refusal,
            Some(NotificationAction::OpenMatchmaking),
        );
        return;
    }
    ctx.ports.lobby.accept_party_invite(player_id)
}

/// Choose the map vetoes: `LobbyCommand::SetPlayerVetoes`.
pub(super) async fn set_player_vetoes(vetoes: Vec<PlayerVeto>, ctx: &ServiceCtx, out: &EventSink) {
    out.emit(LobbyEvent::VetoesUpdated {
        vetoes: vetoes.clone(),
    });
    // Remembered as well as sent. The server holds vetoes on the
    // player's session and nowhere else, so this is the only copy that
    // survives a logout; see `SettingsState::matchmaker_vetoes`.
    let remembered = vetoes.clone();
    ctx.settings.merge_and_emit(out, |_| {
        (
            SettingsEvent::MatchmakerVetoesChanged { vetoes: remembered },
            (),
        )
    });
    ctx.ports.lobby.set_player_vetoes(vetoes);
    crate::services::settings::persist(ctx, out).await;
}

/// Why a party invitation cannot be accepted right now, in Java's order
/// (`TeamMatchmakingService.acceptPartyInvite`).
///
/// The first is the one that matters. The server's `accept_invite` moves the
/// player into the party without ending the search they already had
/// (`PartyService.accept_invite`), so they kept searching on their own, could
/// be matched alone, and as a member could not stop it: Stop is the leader's.
fn party_join_refusal(
    state: &faf_domain::AppState,
    ctx: &ServiceCtx,
    sender_id: i32,
) -> Option<&'static str> {
    if state.lobby.matchmaking.is_looking() {
        return Some("Stop your search before joining a party.");
    }
    if game_is_running(state, ctx) {
        return Some("Close Forged Alliance before joining a party.");
    }
    if ctx.ports.process.game_install_dir().is_none() {
        return Some("Locate ForgedAlliance.exe in Settings → Paths before joining a party.");
    }
    if !state
        .social
        .players
        .iter()
        .any(|player| player.id == sender_id)
    {
        return Some("The player who invited you is no longer online.");
    }
    None
}

/// Whether Forged Alliance is running for this client, or about to be.
fn game_is_running(state: &faf_domain::AppState, ctx: &ServiceCtx) -> bool {
    ctx.lobby.running_game.id().is_some()
        || matches!(
            state.lobby.join,
            JoinState::Launched { .. } | JoinState::InGame
        )
}

/// Start a matchmaker search, the way Java's `TeamMatchmakingService.joinQueues`
/// does: refuse what the server would refuse, prepare the install and the pool
/// maps, and only then ask for the queues. See `MatchmakingState::Preparing`.
pub(super) async fn start_search(mut queue_names: Vec<String>, ctx: &ServiceCtx, out: &EventSink) {
    queue_names.sort();
    queue_names.dedup();
    if queue_names.is_empty() {
        return;
    }
    let refusal = out.with_state(|state| {
        if !matches!(
            state.lobby.status,
            faf_domain::state::LobbyStatus::Connected
        ) {
            return Some(Err(
                "Connect to the FAF lobby before searching for a match.",
            ));
        }
        if state.lobby.matchmaking.is_looking()
            || matches!(
                state.lobby.matchmaking,
                MatchmakingState::MatchFound { .. } | MatchmakingState::Launching { .. }
            )
        {
            // A second press while the first is still on its way.
            return Some(Ok(()));
        }
        if game_is_running(state, ctx) {
            return Some(Err("Close Forged Alliance before searching for a match."));
        }
        let me = state.auth.player.as_ref().map(|player| player.id);
        let party = &state.lobby.party;
        if party.members.len() > 1 && party.owner_id != me {
            return Some(Err("Only the party leader can start the search."));
        }
        None
    });
    match refusal {
        Some(Ok(())) => return,
        Some(Err(reason)) => {
            notifications::add_required_text(
                out,
                NotificationKind::Error,
                notifications::Text::new("notifications.msg.searchFailed"),
                "Could not start the search",
                reason,
                Some(NotificationAction::OpenMatchmaking),
            );
            return;
        }
        None => {}
    }

    // Registered before the state says `Preparing`, so a Stop that sees the
    // state also reaches this preparation's updater.
    let preparation = ctx.lobby.search_preparation.begin(());
    out.emit(LobbyEvent::MatchmakingUpdated {
        state: MatchmakingState::Preparing {
            queue_names: queue_names.clone(),
        },
    });
    let prepared = if ctx.ports.process.supports_live_launch() {
        launcher::prepare_search(&queue_names, ctx, out, &preparation.called_off).await
    } else {
        Ok(())
    };
    ctx.lobby.search_preparation.end(&preparation);

    // Stopped, disconnected or replaced while the files came down. Nothing is
    // sent for a search nobody is waiting for any more. The token as well as
    // the state: a stopped search followed at once by a new one for the same
    // queues reads `Preparing` again, and that state is the new search's.
    let still_wanted = !preparation.called_off.is_cancelled()
        && out.with_state(|state| {
            matches!(
                &state.lobby.matchmaking,
                MatchmakingState::Preparing { queue_names: wanted } if *wanted == queue_names
            )
        });
    if !still_wanted {
        tracing::info!("matchmaker: the search was stopped while it was being prepared");
        return;
    }
    if let Err(reason) = prepared {
        out.emit(LobbyEvent::MatchmakingUpdated {
            state: MatchmakingState::Idle,
        });
        // The updater's own reason (the API, the CDN, the disk), marked so
        // the UI words it plainly. The refusals above are not marked: they
        // are sentences written for the screen already.
        notifications::add_required_failure(
            out,
            notifications::Text::new("notifications.msg.searchFailed"),
            "Could not start the search",
            reason,
            Some(NotificationAction::OpenMatchmaking),
        );
        return;
    }

    for queue_name in &queue_names {
        ctx.ports.lobby.matchmake(queue_name.clone(), true);
    }
    watch_for_search_start(queue_names, out);
}

/// How long the client waits for the server to confirm a search it asked for.
///
/// The answer is a `search_info` within a round trip. A refusal is a `notice`
/// instead (a player already in a game, a party member offline), and without
/// this the bar would sit on "Preparing" until somebody pressed Stop.
const SEARCH_START_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

fn watch_for_search_start(queue_names: Vec<String>, out: &EventSink) {
    let out = out.clone();
    tokio::spawn(async move {
        tokio::time::sleep(SEARCH_START_TIMEOUT).await;
        let unanswered = out.with_state(|state| {
            matches!(
                &state.lobby.matchmaking,
                MatchmakingState::Preparing { queue_names: wanted } if *wanted == queue_names
            )
        });
        if unanswered {
            tracing::warn!("matchmaker: the server never confirmed the search");
            out.emit(LobbyEvent::MatchmakingUpdated {
                state: MatchmakingState::Idle,
            });
        }
    });
}

/// Send this player's faction choice to the server, as Java does on every
/// connection (`TeamMatchmakingService`, `sendFactions` on `CONNECTED`).
///
/// The server keeps it on the party member and nowhere else, and starts every
/// member it creates with all four (`PartyMember.__init__`): on login, on
/// joining a party, and on being put back into a party of one. A client that
/// only sent the choice when it changed, or when its own leader pressed
/// Start, left a member playing a faction they had switched off.
pub(super) fn send_party_factions(ctx: &ServiceCtx, out: &EventSink) {
    let factions = out.with_state(|state| state.settings.browsing.matchmaker_factions.clone());
    // The server refuses an empty list, and an empty list means "never chose".
    if !factions.is_empty() {
        ctx.ports.lobby.set_party_factions(factions);
    }
}

/// Give up on a match the server never started.
///
/// Spawned when `match_found` arrives and resolved by simply looking again
/// later: if the client has moved on -- a launch order came, the search was
/// cancelled, a new match was found, the connection dropped -- the state is no
/// longer the `MatchFound` this was armed for and there is nothing to do.
/// Checking the state rather than cancelling a handle keeps every one of those
/// exits working without any of them having to know this exists.
///
/// The state alone cannot tell two matches on the same queue apart, though:
/// match A cancelled, a requeue, and match B found on that queue looks exactly
/// like A still waiting, and A's timer called B off long before B's own two
/// minutes were up. So each match found also takes a generation, and only the
/// timer armed for the newest one may act.
///
/// It reports the same [`MatchmakingState::Cancelled`] the server sends when
/// it cancels a match itself, so the rest of the client needs no new case: the
/// difference is only who noticed.
fn watch_for_match_start(queue_name: String, ctx: &ServiceCtx, out: &EventSink) {
    let matches = ctx.lobby.match_generation.clone();
    let generation = matches.begin();
    let out = out.clone();
    tokio::spawn(async move {
        tokio::time::sleep(MATCH_START_TIMEOUT).await;

        let still_waiting = out.with_state(|state| {
            match_still_waiting(&matches, generation, &state.lobby.matchmaking, &queue_name)
        });
        if !still_waiting {
            return;
        }

        tracing::warn!(
            queue = %queue_name,
            seconds = MATCH_START_TIMEOUT.as_secs(),
            "no launch order arrived for the match that was found; giving up on it"
        );
        out.emit(LobbyEvent::MatchmakingUpdated {
            state: MatchmakingState::Cancelled {
                queue_name: Some(queue_name.clone()),
            },
        });
        notifications::add_required_text(
            &out,
            NotificationKind::Error,
            notifications::Text::new("notifications.msg.matchDidNotStart")
                .with("queue", &queue_name),
            "Match did not start",
            format!(
                "The {queue_name} match was found but never started. It has been called off; \
                 you can search again."
            ),
            Some(NotificationAction::OpenMatchmaking),
        );
    });
}

/// Whether the match a [`watch_for_match_start`] timer was armed for is still
/// sitting at `MatchFound`: the newest match found, and its queue still the
/// one on screen.
fn match_still_waiting(
    matches: &LatestRequest,
    generation: u64,
    matchmaking: &MatchmakingState,
    queue_name: &str,
) -> bool {
    matches.is_current(generation)
        && matches!(
            matchmaking,
            MatchmakingState::MatchFound { queue_name: found } if found == queue_name
        )
}

/// The matchmaker queues: `LobbyUpdate::MatchmakerQueues`.
pub(super) fn on_queues(
    queues: Vec<MatchmakerQueue>,
    ctx: &ServiceCtx,
    out: &EventSink,
    game_notifications: &mut GameNotificationTracker,
) {
    if !ctx
        .lobby
        .map_pools_checked
        .swap(true, std::sync::atomic::Ordering::AcqRel)
    {
        announce_new_map_pools(
            ctx,
            out,
            queues
                .iter()
                .map(|queue| queue.queue_name.clone())
                .collect(),
        );
    }
    let (watched, ratings, searching) = out.with_state(|state| {
        let own_ratings = state
            .auth
            .player
            .as_ref()
            .and_then(|player| {
                state
                    .social
                    .players
                    .iter()
                    .find(|profile| profile.login.eq_ignore_ascii_case(&player.name))
            })
            .map(|profile| profile.ratings.clone())
            .unwrap_or_default();
        let searching = match &state.lobby.matchmaking {
            MatchmakingState::Searching { queue_names } => queue_names.clone(),
            _ => Vec::new(),
        };
        // Somebody in a match, or on the way into one, is not looking
        // for an opponent, whichever queue a stranger just joined.
        let busy = matches!(
            state.lobby.matchmaking,
            MatchmakingState::MatchFound { .. } | MatchmakingState::Launching { .. }
        ) || matches!(
            state.lobby.join,
            JoinState::Launched { .. } | JoinState::InGame
        );
        let watched = if state.settings.notifications.enabled && !busy {
            state.settings.notifications.queue_opponent_queues.clone()
        } else {
            Vec::new()
        };
        (watched, own_ratings, searching)
    });
    for (queue, count) in game_notifications.queue_opponents.observe(
        &queues,
        &ratings,
        &searching,
        &watched,
        Instant::now(),
    ) {
        notifications::add_text(
            out,
            NotificationKind::QueueOpponent,
            notifications::Text::new("notifications.msg.queueOpponent")
                .with("count", count)
                .with("teamSize", queue.team_size),
            "Opponent in your range",
            format!(
                "{count} {} near your rating {} waiting in {} vs {}.",
                if count == 1 { "player" } else { "players" },
                if count == 1 { "is" } else { "are" },
                queue.team_size,
                queue.team_size,
            ),
            Some(NotificationAction::OpenMatchmaking),
        );
    }
    out.emit(LobbyEvent::MatchmakerQueuesUpdated { queues })
}

/// The search's state: `LobbyUpdate::Matchmaking`.
pub(super) fn on_matchmaking<'a>(
    state: MatchmakingState,
    ctx: &'a ServiceCtx,
    out: &'a EventSink,
    launch_enabled: bool,
    launch: &mut LaunchSlot,
    background: &mut Background<'a>,
) {
    let (was_launching, was_preparing) = out.with_state(|current| {
        (
            matches!(
                current.lobby.matchmaking,
                MatchmakingState::Launching { .. }
            ),
            matches!(
                current.lobby.matchmaking,
                MatchmakingState::Preparing { .. } | MatchmakingState::Searching { .. }
            ),
        )
    });
    let cancelled = matches!(&state, MatchmakingState::Cancelled { .. });
    // A match the server cancelled while its launch was still being
    // prepared is stopped before it becomes a game, which is what
    // Java's `stopSearchMatchmaker` does by cancelling the launch
    // future. The launch checks the flag at its step boundaries.
    if cancelled && was_launching && background.launch.is_some() {
        ctx.lobby.operations.cancel();
        launch.called_off = true;
    }
    let terminate_cancelled_game = cancelled
        && was_launching
        && background.launch.is_none()
        && out.with_state(|current| {
            matches!(
                current.lobby.join,
                faf_domain::state::JoinState::Launched { .. }
                    | faf_domain::state::JoinState::InGame
            )
        });
    // Every client in a party searches once its leader starts, and
    // Java brings each one's featured mod up to date at that moment
    // (`TeamMatchmakingService.onInQueueChange` into
    // `GameRunner.startSearchMatchmaker`), so that a member is not the
    // one still patching when the match is made. The leader's own
    // client did that before it asked (`MatchmakingState::Preparing`).
    if matches!(state, MatchmakingState::Searching { .. })
        && !was_preparing
        && launch_enabled
        && background.warm_up.is_none()
    {
        let called_off = tokio_util::sync::CancellationToken::new();
        background.warm_up_called_off = Some(called_off.clone().drop_guard());
        background.warm_up = Some(Box::pin(async move {
            let warmed = launcher::prepare_featured_mod(
                launcher::MATCHMAKER_FEATURED_MOD,
                ctx,
                out,
                &called_off,
            )
            .await;
            if let Err(reason) = warmed {
                if !called_off.is_cancelled() {
                    tracing::warn!(%reason, "could not update the game while the party searched");
                }
            }
        }));
    }
    // The leader stopped the search: the member's update was for that search,
    // and it stops at its next safe point rather than holding the launcher's
    // preparation lock to the end. A match found keeps it going, since the
    // launch needs the same files.
    if matches!(state, MatchmakingState::Idle) {
        background.warm_up_called_off = None;
    }
    let (already_found, notify_match_found) = out.with_state(|current| {
        (
            matches!(
                current.lobby.matchmaking,
                MatchmakingState::MatchFound { .. }
            ),
            current.settings.notifications.match_found,
        )
    });
    if matches!(state, MatchmakingState::MatchFound { .. }) && !already_found {
        let queue = state.matched_queue().unwrap_or("matchmaker");
        if notify_match_found {
            notifications::add_text(
                out,
                NotificationKind::MatchFound,
                notifications::Text::new("notifications.msg.matchFound").with("queue", queue),
                "Match found",
                format!("Your {queue} match is ready."),
                Some(NotificationAction::OpenMatchmaking),
            );
        }
        watch_for_match_start(queue.to_string(), ctx, out);
    }
    out.emit(LobbyEvent::MatchmakingUpdated { state });
    if terminate_cancelled_game {
        terminate_game(ctx, out);
        launch.session = None;
        notifications::add_required_text(
            out,
            NotificationKind::Error,
            notifications::Text::new("notifications.msg.matchCancelled"),
            "Match cancelled",
            "The server cancelled the match after launch, so Forged Alliance was stopped.",
            Some(NotificationAction::OpenMatchmaking),
        );
    }
}

/// The party: `LobbyUpdate::Party`.
pub(super) fn on_party(party: PartyState, ctx: &ServiceCtx, out: &EventSink) {
    // Filtered through the account this client is signed in as: the
    // server tells the member who just left what the party looks like
    // without them, and that is not a party this client is in. See
    // `PartyState::for_player`.
    let player_id = out.with_state(|state| state.auth.player.as_ref().map(|p| p.id));
    let party = party.for_player(player_id);
    // A party the server just made for us carries its default of all
    // four factions, whatever was chosen: see `send_party_factions`.
    // The answer to the correction is another snapshot that agrees.
    let wanted = out.with_state(|state| state.settings.browsing.matchmaker_factions.clone());
    let ours = party
        .members
        .iter()
        .find(|member| Some(member.player_id) == player_id)
        .map(|member| member.factions.clone());
    // The server names factions in lower case, settings as shown.
    let normalised = |factions: &[String]| {
        let mut factions: Vec<String> = factions
            .iter()
            .map(|faction| faction.to_ascii_lowercase())
            .collect();
        factions.sort();
        factions
    };
    let differs = ours.is_some_and(|ours| normalised(&ours) != normalised(&wanted));
    out.emit(LobbyEvent::PartyUpdated { party });
    if differs && !wanted.is_empty() {
        ctx.ports.lobby.set_party_factions(wanted);
    }
}

/// The vetoes the server put in force: `LobbyUpdate::Vetoes`.
pub(super) async fn on_vetoes(
    vetoes: Vec<PlayerVeto>,
    forced: bool,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    out.emit(LobbyEvent::VetoesUpdated {
        vetoes: vetoes.clone(),
    });
    ctx.settings.merge_and_emit(out, |_| {
        (SettingsEvent::MatchmakerVetoesChanged { vetoes }, ())
    });
    crate::services::settings::persist(ctx, out).await;
    // Java's two strings, `teammatchmaking.vetoes.forced.*`.
    if forced {
        notifications::add_required_text(
            out,
            NotificationKind::ServerNotice,
            notifications::Text::new("notifications.msg.mapBansChanged"),
            "Map bans were changed",
            "The matchmaker team changed the map pools, so some of your map bans were \
             adjusted. Set them again if needed.",
            Some(NotificationAction::OpenMatchmaking),
        );
    }
}

/// Compare every queue's map pools with the ones seen last time, announce the
/// queues that changed, and remember what was seen (#406).
///
/// Off the lobby loop: it is one API request per queue, and the lists the
/// server sends at login should not wait on them. Nothing is written before
/// the settings file has been read, for the reason `settings::persist` gives.
fn announce_new_map_pools(ctx: &ServiceCtx, out: &EventSink, queue_names: Vec<String>) {
    let maps = ctx.ports.maps.clone();
    let settings = ctx.ports.settings.clone();
    let serial = ctx.settings.write_order();
    let merger = ctx.settings.merger();
    let loaded = ctx.settings.has_loaded();
    let out = out.clone();
    tokio::spawn(async move {
        let mut current = Vec::new();
        for queue_name in queue_names {
            // A queue that cannot be read this time is left as it was seen, so
            // a failed request is never mistaken for a new pool next time.
            let Ok(pools) = maps.list_matchmaker_pools(queue_name.clone()).await else {
                continue;
            };
            let mut assignments: Vec<i32> = pools
                .iter()
                .flat_map(|pool| pool.maps.iter().map(|map| map.assignment_id))
                .collect();
            if assignments.is_empty() {
                continue;
            }
            assignments.sort_unstable();
            assignments.dedup();
            current.push(faf_domain::state::settings::MapPoolsSeen {
                queue_name,
                assignments,
            });
        }
        if current.is_empty() {
            return;
        }
        let (seen, muted) = out.with_state(|state| {
            (
                state.settings.map_pools_seen.clone(),
                state.settings.notifications.map_pool_muted_queues.clone(),
            )
        });
        for queue_name in faf_domain::state::settings::changed_map_pools(&seen, &current) {
            if muted.contains(&queue_name) {
                continue;
            }
            let label = queue_display_name(&queue_name);
            notifications::add_text(
                &out,
                NotificationKind::MapPoolReleased,
                notifications::Text::new("notifications.msg.newMapPool").with("queue", &label),
                "New map pool",
                format!("{label} has a new map pool."),
                Some(NotificationAction::OpenMatchmaking),
            );
        }
        // Merged into what is remembered at the moment of writing, under the
        // settings lock, rather than into the copy read for the announcement:
        // the requests above can take seconds.
        merger.merge_and_emit(&out, |settings| {
            let mut remembered = settings.map_pools_seen.clone();
            for entry in current {
                remembered.retain(|old| old.queue_name != entry.queue_name);
                remembered.push(entry);
            }
            (SettingsEvent::MapPoolsSeen { seen: remembered }, ())
        });
        if loaded {
            let _guard = serial.acquire().await;
            let snapshot = out.with_state(|state| state.settings.clone());
            if let Err(reason) = settings.save(&snapshot).await {
                tracing::warn!(%reason, "the map pools seen were not saved");
            }
        }
    });
}

/// `ladder1v1` and `tmm2v2` as players say them, for a notification's text.
fn queue_display_name(queue_name: &str) -> String {
    match queue_name {
        "ladder1v1" => "1v1".into(),
        other => other
            .strip_prefix("tmm")
            .map(|rest| rest.split('_').next().unwrap_or(rest).to_string())
            .unwrap_or_else(|| other.to_string()),
    }
}

/// Send the remembered matchmaker vetoes back to the server, once the lobby
/// has authenticated.
///
/// The server keeps a player's vetoes on their session object and nowhere
/// else: no table behind them, and no command to ask for them. Logging out
/// discards them, and a client that only ever listens for `vetoes_info` starts
/// every session with none, whatever the player saved last time. That is the
/// whole of "not persistent after logging in and out even after saving".
///
/// Replaying them is safe rather than optimistic. `set_player_vetoes` is
/// validated and capped against the current pools on arrival, exactly as a
/// selection made by hand is, and the server answers with `vetoes_info` when
/// it had to change anything, which is handled above and writes the corrected
/// set back. A pool that shrank between sessions therefore corrects itself on
/// the first login after it did.
///
/// Also emits `VetoesUpdated`, because `Disconnected` clears the lobby's copy:
/// without it the Play tab would show an empty selection while the server held
/// the real one.
pub(super) fn restore_player_vetoes(ctx: &ServiceCtx, out: &EventSink) {
    let vetoes = out.with_state(|state| state.settings.matchmaker_vetoes.clone());
    if vetoes.is_empty() {
        return;
    }
    out.emit(LobbyEvent::VetoesUpdated {
        vetoes: vetoes.clone(),
    });
    ctx.ports.lobby.set_player_vetoes(vetoes);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Match A found, cancelled, a requeue, match B found on the same queue.
    /// When A's two minutes are up the state is `MatchFound` on that queue
    /// again, which on its own reads as A still waiting: A's timer must not
    /// call B off. B's own timer still can.
    #[test]
    fn an_older_match_timer_does_not_cancel_a_newer_match_on_the_same_queue() {
        let matches = LatestRequest::default();
        let found = MatchmakingState::MatchFound {
            queue_name: "ladder1v1".into(),
        };

        let first = matches.begin();
        assert!(match_still_waiting(&matches, first, &found, "ladder1v1"));

        let second = matches.begin();
        assert!(!match_still_waiting(&matches, first, &found, "ladder1v1"));
        assert!(match_still_waiting(&matches, second, &found, "ladder1v1"));

        // The state checks that were always there still hold for the newest.
        let launching = MatchmakingState::Launching {
            queue_name: "ladder1v1".into(),
        };
        assert!(!match_still_waiting(
            &matches,
            second,
            &launching,
            "ladder1v1"
        ));
        assert!(!match_still_waiting(&matches, second, &found, "tmm2v2"));
    }
}
