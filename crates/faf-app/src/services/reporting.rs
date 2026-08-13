use faf_domain::state::{NotificationKind, ReportingCommand, ReportingEvent};

use crate::ports::{GameParticipation, ReportPlayerRequest};
use crate::runtime::{EventSink, ServiceCtx};
use crate::services::notifications;

pub async fn handle(cmd: ReportingCommand, ctx: &ServiceCtx, out: &EventSink) {
    match cmd {
        ReportingCommand::Open { player_id, login } => {
            let generation = next_generation(ctx);
            out.emit(ReportingEvent::Opened { player_id, login });
            load_history(ctx, out, generation).await;
        }
        ReportingCommand::Close => {
            next_generation(ctx);
            out.emit(ReportingEvent::Closed);
        }
        ReportingCommand::LoadHistory => {
            let generation = next_generation(ctx);
            load_history(ctx, out, generation).await;
        }
        ReportingCommand::Submit {
            player_id,
            login,
            description,
            game_id,
            incident_time,
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
            let validation = if reporter.id == player_id {
                Some("You cannot report yourself.")
            } else if description.len() < 10 {
                Some("Describe the incident in at least 10 characters.")
            } else if description.len() > 4_000 {
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

            out.emit(ReportingEvent::Submitting);
            if let Some(game_id) = game_id {
                match ctx
                    .ports
                    .reporting
                    .game_participation(game_id, player_id)
                    .await
                {
                    Ok(GameParticipation::GameNotFound) => {
                        out.emit(ReportingEvent::Failed {
                            reason: format!("Game #{game_id} was not found."),
                        });
                        return;
                    }
                    Ok(GameParticipation::PlayerAbsent) => {
                        out.emit(ReportingEvent::Failed {
                            reason: format!("{login} did not participate in game #{game_id}."),
                        });
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
                    notifications::add(
                        out,
                        NotificationKind::ReportSubmitted,
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
    ctx.reporting_generation.begin()
}

fn is_current(ctx: &ServiceCtx, generation: u64) -> bool {
    ctx.reporting_generation.is_current(generation)
}
