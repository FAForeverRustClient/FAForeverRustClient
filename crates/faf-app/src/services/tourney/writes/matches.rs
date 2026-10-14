//! Playing the event: moving it through its phases, and its results. A player
//! submits a score for the other side to answer; an organiser decides one
//! outright or records a free-for-all lobby.

use faf_domain::state::{BracketConfig, FfaReport, MatchReport, TourneyAction, TourneyPhase};

use crate::runtime::{EventSink, ServiceCtx};

use super::write;

pub(super) async fn advance(
    tournament_id: String,
    phase: TourneyPhase,
    config: Option<BracketConfig>,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    write(TourneyAction::Advancing { phase }, ctx, out, {
        let tournament_id = tournament_id.clone();
        let config = config.clone();
        async move {
            ctx.ports
                .tourney_match
                .advance(&tournament_id, phase, config.as_ref())
                .await
        }
    })
    .await;
}

pub(super) async fn answer_report(
    tournament_id: String,
    match_id: String,
    accept: bool,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    let action = TourneyAction::AnsweringReport {
        match_id: match_id.clone(),
    };
    write(action, ctx, out, {
        let tournament_id = tournament_id.clone();
        async move {
            ctx.ports
                .tourney_match
                .confirm_report(&tournament_id, &match_id, accept)
                .await
        }
    })
    .await;
}

pub(super) async fn decide_report(
    tournament_id: String,
    report: MatchReport,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    let action = TourneyAction::DecidingReport {
        match_id: report.match_id.clone(),
    };
    write(action, ctx, out, {
        let tournament_id = tournament_id.clone();
        let report = clean(report);
        async move {
            ctx.ports
                .tourney_match
                .decide_report(&tournament_id, &report)
                .await
        }
    })
    .await;
}

pub(super) async fn submit_report(
    tournament_id: String,
    report: MatchReport,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    let action = TourneyAction::SubmittingReport {
        match_id: report.match_id.clone(),
    };
    write(action, ctx, out, {
        let tournament_id = tournament_id.clone();
        // The player path takes no winner and no forfeit; clearing them
        // here keeps a stray one from ever reaching the body.
        let report = MatchReport {
            winner: None,
            forfeit: None,
            ..clean(report)
        };
        async move {
            ctx.ports
                .tourney_match
                .submit_report(&tournament_id, &report)
                .await
        }
    })
    .await;
}

pub(super) async fn report_ffa(
    tournament_id: String,
    report: FfaReport,
    ctx: &ServiceCtx,
    out: &EventSink,
) {
    let action = TourneyAction::ReportingFfa {
        match_id: report.match_id.clone(),
    };
    write(action, ctx, out, {
        let tournament_id = tournament_id.clone();
        async move {
            ctx.ports
                .tourney_match
                .report_ffa(&tournament_id, &report)
                .await
        }
    })
    .await;
}

/// Drop the blank replay ids a form leaves behind.
///
/// The server counts them and refuses a report whose count does not match the
/// number of new games, so an empty row the player tabbed past would cost them
/// the submission for a reason they cannot see.
///
/// The winner and the forfeit are kept. They are the organiser's to send, and
/// this used to blank them as well, so every walkover and every declared
/// winner entered in the client reached the server as a bare match id.
fn clean(report: MatchReport) -> MatchReport {
    MatchReport {
        replay_ids: usable(report.replay_ids),
        draw_replay_ids: usable(report.draw_replay_ids),
        ..report
    }
}

fn usable(ids: Vec<String>) -> Vec<String> {
    ids.into_iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_phase_step_is_only_offered_where_the_server_takes_it() {
        use faf_domain::state::{TourneyPhase, TourneyStatus};
        assert!(TourneyPhase::FormTeams.is_legal_from(TourneyStatus::Signup));
        assert!(!TourneyPhase::FormTeams.is_legal_from(TourneyStatus::Drafted));
        assert!(TourneyPhase::StartBracket.is_legal_from(TourneyStatus::Drafted));
        assert!(!TourneyPhase::StartBracket.is_legal_from(TourneyStatus::Running));
        // Reopening is the undo, and it stops working once anything was played.
        assert!(TourneyPhase::ReopenSignups.is_legal_from(TourneyStatus::Drafted));
        assert!(!TourneyPhase::ReopenSignups.is_legal_from(TourneyStatus::Running));
    }

    #[test]
    fn blank_replay_rows_never_reach_the_server() {
        // The server counts these against the number of new games, so an empty
        // row the player tabbed past would cost them the submission for a
        // reason the form never showed them.
        let cleaned = clean(MatchReport {
            match_id: "m1".into(),
            score1: 2,
            score2: 0,
            replay_ids: vec!["  22334455 ".into(), String::new(), "   ".into()],
            draw_replay_ids: vec!["".into()],
            winner: None,
            forfeit: None,
        });
        assert_eq!(cleaned.replay_ids, vec!["22334455".to_string()]);
        assert!(cleaned.draw_replay_ids.is_empty());
    }
}
