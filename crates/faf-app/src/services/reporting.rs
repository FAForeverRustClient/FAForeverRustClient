use faf_domain::protocol::report_log::{
    compose_description, MAX_DESCRIPTION_BYTES, MAX_LOG_BLOCK_CHARS, MAX_REPORT_TEXT_CHARS,
};
use faf_domain::state::{NotificationKind, ReportLogAttachment, ReportingCommand, ReportingEvent};

use crate::ports::{GameParticipation, ReportPlayerRequest};
use crate::runtime::{EventSink, LatestRequest, ServiceCtx};
use crate::services::notifications;

/// The reporting service's request generations. Owned by this service.
#[derive(Default)]
pub struct ReportingContext {
    /// Only the newest open, history load or submission may land. Closing the
    /// dialog or opening it for another player must not let a slower answer
    /// about the previous one fill it.
    generation: LatestRequest,
    /// Only the newest log excerpt may land. Kept apart from `generation` so
    /// ticking the box while the history loads does not drop the history,
    /// and taken by every open and close too, so an excerpt read for one
    /// report never appears in the next.
    log_generation: LatestRequest,
}

pub async fn handle(cmd: ReportingCommand, ctx: &ServiceCtx, out: &EventSink) {
    match cmd {
        ReportingCommand::Open { player_id, login } => {
            let generation = next_generation(ctx);
            ctx.reporting.log_generation.invalidate();
            out.emit(ReportingEvent::Opened { player_id, login });
            load_history(ctx, out, generation).await;
        }
        ReportingCommand::OpenByLogin { login } => {
            let wanted = login.trim().to_string();
            if wanted.is_empty() {
                return;
            }
            // Claimed before the lookup rather than after it. The lookup is a
            // network round trip, and in that time the user can close the
            // dialog or open a report about somebody else; both bump the
            // generation, and a lookup that answers afterwards must not reopen
            // the form or swap the person it is about. A superseded failure is
            // dropped too: a notification about a report nobody is filing any
            // more is noise.
            let generation = next_generation(ctx);
            let found = ctx
                .ports
                .player_card
                .players_by_login(std::slice::from_ref(&wanted))
                .await;
            if !is_current(ctx, generation) {
                return;
            }
            match found {
                Ok(players) => match players
                    .into_iter()
                    .find(|player| player.login.eq_ignore_ascii_case(&wanted))
                {
                    Some(player) => {
                        ctx.reporting.log_generation.invalidate();
                        out.emit(ReportingEvent::Opened {
                            player_id: player.id,
                            login: player.login,
                        });
                        load_history(ctx, out, generation).await;
                    }
                    None => notifications::add_text(
                        out,
                        NotificationKind::Error,
                        notifications::Text::new("notifications.msg.reportNoAccount")
                            .with("login", &wanted),
                        "Cannot report player",
                        format!("No FAF account is called {wanted}."),
                        None,
                    ),
                },
                Err(error) => notifications::add_text(
                    out,
                    NotificationKind::Error,
                    notifications::Text::new("notifications.msg.reportLookupFailed")
                        .with("login", &wanted)
                        .with("reason", &error),
                    "Cannot report player",
                    format!("Could not look up {wanted}: {error}"),
                    None,
                ),
            }
        }
        ReportingCommand::Close => {
            next_generation(ctx);
            ctx.reporting.log_generation.invalidate();
            out.emit(ReportingEvent::Closed);
        }
        ReportingCommand::LoadHistory => {
            let generation = next_generation(ctx);
            load_history(ctx, out, generation).await;
        }
        ReportingCommand::AttachLog { game_id } => attach_log(ctx, out, game_id).await,
        ReportingCommand::DetachLog => {
            // A read still running for the box just unticked must not tick
            // it again when it answers.
            ctx.reporting.log_generation.invalidate();
            out.emit(ReportingEvent::LogDetached);
        }
        ReportingCommand::Submit {
            player_id,
            login,
            description,
            game_id,
            incident_time,
            attach_log,
        } => {
            let generation = next_generation(ctx);
            let description = description.trim().to_owned();
            let incident_time = incident_time.trim().to_owned();
            let Some(reporter) = out.with_state(|state| state.auth.player.clone()) else {
                out.emit(ReportingEvent::Failed {
                    reason: "You must be logged in to report a player.".into(),
                });
                return;
            };
            // Characters, not bytes: the dialog counts characters, and a
            // report in Russian or Polish used to be refused here at about
            // half the length the dialog allowed.
            let length = description.chars().count();
            let validation = if reporter.id == player_id {
                Some("You cannot report yourself.")
            } else if length < 10 {
                Some("Describe the incident in at least 10 characters.")
            } else if length > MAX_REPORT_TEXT_CHARS {
                Some("The report description is limited to 4,000 characters.")
            } else if game_id.is_some() && incident_time.is_empty() {
                Some("Add the approximate in-game time when reporting a game incident.")
            } else {
                None
            };
            if let Some(reason) = validation {
                out.emit(ReportingEvent::Failed {
                    reason: reason.into(),
                });
                return;
            }
            let block = if attach_log {
                match attached_block(out, game_id) {
                    Ok(block) => Some(block),
                    Err(reason) => {
                        out.emit(ReportingEvent::Failed {
                            reason: reason.into(),
                        });
                        return;
                    }
                }
            } else {
                None
            };
            let description = compose_description(&description, block.as_deref());
            if description.len() > MAX_DESCRIPTION_BYTES {
                // The limits are chosen so this cannot happen (see
                // `report_log`); refusing beats letting the API cut the
                // report or reject it with a database error.
                out.emit(ReportingEvent::Failed {
                    reason: "The report is too long to send.".into(),
                });
                return;
            }

            out.emit(ReportingEvent::Submitting);
            if let Some(game_id) = game_id {
                let participation = ctx
                    .ports
                    .reporting
                    .game_participation(game_id, player_id)
                    .await;
                // A refusal is said only to the dialog that asked. Closing it
                // and opening a report about somebody else during the check
                // used to put this one's "did not participate" into the new
                // dialog. A check that passed still submits, as before: the
                // report was sent from a dialog the user has since closed.
                let superseded = !is_current(ctx, generation);
                match participation {
                    Ok(GameParticipation::GameNotFound) => {
                        if !superseded {
                            out.emit(ReportingEvent::Failed {
                                reason: format!("Game #{game_id} was not found."),
                            });
                        }
                        return;
                    }
                    Ok(GameParticipation::PlayerAbsent) => {
                        if !superseded {
                            out.emit(ReportingEvent::Failed {
                                reason: format!("{login} did not participate in game #{game_id}."),
                            });
                        }
                        return;
                    }
                    Ok(GameParticipation::PlayerPresent) => {}
                    Err(reason) => {
                        // Guidance only: a temporary read failure must not make
                        // the moderation write path unavailable. The API remains
                        // authoritative when the report is submitted.
                        tracing::warn!(%reason, game_id, player_id, "could not pre-validate report game");
                    }
                }
            }
            let result = ctx
                .ports
                .reporting
                .submit(ReportPlayerRequest {
                    reporter_id: reporter.id,
                    reported_player_id: player_id,
                    description,
                    game_id,
                    incident_time,
                })
                .await;
            if !is_current(ctx, generation) {
                return;
            }
            match result {
                Ok(()) => {
                    out.emit(ReportingEvent::Submitted);
                    notifications::add_text(
                        out,
                        NotificationKind::ReportSubmitted,
                        notifications::Text::new("notifications.msg.reportSubmitted")
                            .with("login", &login),
                        "Report submitted",
                        format!("Your report about {login} was sent to the moderation team."),
                        None,
                    );
                    load_history(ctx, out, generation).await;
                }
                Err(reason) => out.emit(ReportingEvent::Failed { reason }),
            }
        }
    }
}

/// Read the game log for the report and show the excerpt it would carry.
///
/// Nothing is sent here: this only prepares what the dialog shows, so the
/// user decides with the excerpt in front of them.
async fn attach_log(ctx: &ServiceCtx, out: &EventSink, game_id: Option<i32>) {
    let generation = ctx.reporting.log_generation.begin();
    // A tick that arrives after the dialog closed has no report to go with.
    if !out.with_state(|state| state.reporting.open) {
        return;
    }
    out.emit(ReportingEvent::LogPreparing { game_id });
    let read = ctx.ports.game_logs.report_excerpt(game_id).await;
    if !ctx.reporting.log_generation.is_current(generation) {
        return;
    }
    match read {
        Ok(Some(excerpt)) => out.emit(ReportingEvent::LogPrepared { excerpt }),
        Ok(None) => out.emit(ReportingEvent::LogUnavailable { game_id }),
        Err(reason) => out.emit(ReportingEvent::LogFailed { game_id, reason }),
    }
}

/// The block the user was shown, if it may go with a report about `game_id`.
///
/// Taken from the state rather than read again: a fresh read could hold lines
/// written since the preview, and the user agreed to what they saw.
fn attached_block(out: &EventSink, game_id: Option<i32>) -> Result<String, &'static str> {
    match out.with_state(|state| state.reporting.log_attachment.clone()) {
        ReportLogAttachment::Ready { excerpt } if excerpt.requested_game_id != game_id => {
            Err("The attached game log was prepared for a different game ID. Check it again before sending.")
        }
        // The adapter builds the block within the limit; one that is not is
        // refused rather than cut, since a cut block is not what was shown.
        ReportLogAttachment::Ready { excerpt }
            if excerpt.block.chars().count() > MAX_LOG_BLOCK_CHARS =>
        {
            Err("The attached game log is too long to send.")
        }
        ReportLogAttachment::Ready { excerpt } => Ok(excerpt.block),
        _ => Err("The game log is not ready to attach. Wait for its preview, or untick it."),
    }
}

async fn load_history(ctx: &ServiceCtx, out: &EventSink, generation: u64) {
    let Some(reporter_id) = out.with_state(|state| state.auth.player.as_ref().map(|p| p.id)) else {
        out.emit(ReportingEvent::HistoryFailed {
            reason: "You must be logged in to view report history.".into(),
        });
        return;
    };
    out.emit(ReportingEvent::HistoryLoading);
    let result = ctx.ports.reporting.history(reporter_id).await;
    if !is_current(ctx, generation) {
        return;
    }
    match result {
        Ok(reports) => out.emit(ReportingEvent::HistoryLoaded { reports }),
        Err(reason) => out.emit(ReportingEvent::HistoryFailed { reason }),
    }
}

fn next_generation(ctx: &ServiceCtx) -> u64 {
    ctx.reporting.generation.begin()
}

fn is_current(ctx: &ServiceCtx, generation: u64) -> bool {
    ctx.reporting.generation.is_current(generation)
}
