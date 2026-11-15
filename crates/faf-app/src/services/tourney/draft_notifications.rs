//! Opt-in draft alerts continue while another client tab or a game is open.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use faf_domain::state::{
    AuthStatus, NotificationAction, NotificationEvent, NotificationKind, SiteDocument, SiteRead,
};
use faf_domain::{AppEvent, AppState};
use tokio::sync::broadcast::error::RecvError;

use crate::ports::RequestError;
use crate::runtime::{EventSink, ServiceCtx};
use crate::services::notifications;

use super::site::is_my_draft_turn;

const POLL: Duration = Duration::from_secs(5);

fn wanted(state: &AppState) -> Option<i32> {
    if !state.settings.notifications.enabled
        || !state.settings.notifications.draft_turn
        || state.auth.status != AuthStatus::LoggedIn
    {
        return None;
    }
    state.auth.player.as_ref().map(|player| player.id)
}

pub(crate) fn spawn(ctx: Arc<ServiceCtx>, sink: EventSink) {
    let mut events = sink.subscribe();
    tokio::spawn(async move {
        let mut clock = tokio::time::interval(POLL);
        clock.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut seen = HashMap::new();
        let mut account = None;
        let mut previous_session: Option<tokio_util::sync::CancellationToken> = None;
        loop {
            let tick = tokio::select! {
                _ = clock.tick() => true,
                event = events.recv() => match event {
                    Ok(AppEvent::Auth(_) | AppEvent::Settings(_)) | Err(RecvError::Lagged(_)) => false,
                    Err(RecvError::Closed) => return,
                    _ => continue,
                },
            };
            let current = sink.with_state(wanted);
            let new_session = previous_session
                .as_ref()
                .is_some_and(|held| held.is_cancelled());
            if !tick && account == current && !new_session {
                continue;
            }
            if account != current || new_session {
                seen.clear();
            }
            account = current;
            let Some(player_id) = current else {
                retire(&sink.scoped_to_account(), &HashMap::new());
                previous_session = None;
                continue;
            };
            let scoped = sink.scoped_to_account();
            let session = scoped.account_token();
            previous_session = Some(session.clone());
            let checking = turns(&ctx, player_id);
            tokio::pin!(checking);
            let result = loop {
                tokio::select! {
                    _ = session.cancelled() => break None,
                    result = &mut checking => break Some(result),
                    event = events.recv() => {
                        if matches!(event, Err(RecvError::Closed)) { return; }
                        if sink.with_state(wanted) != Some(player_id) { break None; }
                    }
                }
            };
            let Some(result) = result else {
                retire(&scoped, &HashMap::new());
                seen.clear();
                account = None;
                continue;
            };
            if session.is_cancelled() || sink.with_state(wanted) != Some(player_id) {
                continue;
            }
            match result {
                Ok(current) => announce(&scoped, &mut seen, current),
                Err(error) => tracing::debug!(%error, "could not check tournament draft turns"),
            }
        }
    });
}

struct Turn {
    name: String,
    stamp: String,
}

async fn turns(ctx: &ServiceCtx, player_id: i32) -> Result<HashMap<String, Turn>, RequestError> {
    let SiteDocument::Pending(pending) =
        ctx.ports.tourney_site.site_read(SiteRead::Pending).await?
    else {
        return Err(RequestError::unexpected(
            "expected tournament pending items",
        ));
    };
    let mut found = HashMap::new();
    let mut checked = HashSet::new();
    for item in pending.items.iter().filter(|item| item.kind == "draft") {
        if !checked.insert(item.tournament_id.clone()) {
            continue;
        }
        // An unavailable read is not evidence that a turn ended. Keep the
        // previous check intact so recovery cannot announce the same pick twice.
        let event = ctx.ports.tourney_read.detail(&item.tournament_id).await?;
        if event.id != item.tournament_id
            || event.viewer.faf_id != Some(player_id)
            || !is_my_draft_turn(&event)
        {
            continue;
        }
        if let Some(draft) = &event.draft {
            found.insert(
                event.id,
                Turn {
                    name: event.name,
                    stamp: serde_json::json!([draft.order, draft.current]).to_string(),
                },
            );
        }
    }
    Ok(found)
}

fn retire(sink: &EventSink, current: &HashMap<String, Turn>) {
    let stale = sink.with_state(|state| {
        state
            .notifications
            .items
            .iter()
            .filter_map(|item| {
                let Some(NotificationAction::OpenTournamentDraft { tournament_id }) = &item.action
                else {
                    return None;
                };
                let active = current.get(tournament_id).is_some_and(|turn| {
                    item.text.as_ref().and_then(|text| text.params.get("turn")) == Some(&turn.stamp)
                });
                (!active && item.kind == NotificationKind::DraftTurn).then(|| item.id.clone())
            })
            .collect::<Vec<_>>()
    });
    for id in stale {
        sink.emit(NotificationEvent::Dismissed { id });
    }
}

fn announce(sink: &EventSink, seen: &mut HashMap<String, String>, current: HashMap<String, Turn>) {
    retire(sink, &current);
    seen.retain(|id, _| current.contains_key(id));
    for (id, turn) in current {
        if seen.get(&id) == Some(&turn.stamp) {
            continue;
        }
        notifications::add_text(
            sink,
            NotificationKind::DraftTurn,
            notifications::Text::new("notifications.msg.draftTurn")
                .with("tournament", &turn.name)
                .with("turn", &turn.stamp),
            "Your draft pick",
            format!("{}: choose a player for your team.", turn.name),
            Some(NotificationAction::OpenTournamentDraft {
                tournament_id: id.clone(),
            }),
        );
        seen.insert(id, turn.stamp);
    }
}
