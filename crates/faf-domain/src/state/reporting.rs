//! Player moderation-report workflow.

use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum ReportStatus {
    #[default]
    Idle,
    Submitting,
    Submitted,
    Failed {
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum ReportHistoryStatus {
    #[default]
    Idle,
    Loading,
    Ready,
    Failed {
        reason: String,
    },
}

/// One report previously filed by the authenticated player.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ModerationReportSummary {
    pub id: i32,
    pub create_time: String,
    pub offenders: Vec<String>,
    pub game_id: Option<i32>,
    pub description: String,
    pub moderator: String,
    pub moderator_notice: String,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReportingState {
    pub open: bool,
    pub player_id: Option<i32>,
    pub login: String,
    pub status: ReportStatus,
    pub history: Vec<ModerationReportSummary>,
    pub history_status: ReportHistoryStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    content = "payload",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ReportingEvent {
    Opened {
        player_id: i32,
        login: String,
    },
    Closed,
    Submitting,
    Submitted,
    Failed {
        reason: String,
    },
    HistoryLoading,
    HistoryLoaded {
        reports: Vec<ModerationReportSummary>,
    },
    HistoryFailed {
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    content = "payload",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ReportingCommand {
    Open {
        player_id: i32,
        login: String,
    },
    Close,
    LoadHistory,
    Submit {
        player_id: i32,
        login: String,
        description: String,
        game_id: Option<i32>,
        incident_time: String,
    },
}

pub fn reduce(state: &mut ReportingState, event: &ReportingEvent) {
    match event {
        ReportingEvent::Opened { player_id, login } => {
            state.open = true;
            state.player_id = Some(*player_id);
            state.login = login.clone();
            state.status = ReportStatus::Idle;
        }
        ReportingEvent::Closed => *state = ReportingState::default(),
        ReportingEvent::Submitting => state.status = ReportStatus::Submitting,
        ReportingEvent::Submitted => state.status = ReportStatus::Submitted,
        ReportingEvent::Failed { reason } => {
            state.status = ReportStatus::Failed {
                reason: reason.clone(),
            }
        }
        ReportingEvent::HistoryLoading => state.history_status = ReportHistoryStatus::Loading,
        ReportingEvent::HistoryLoaded { reports } => {
            state.history = reports.clone();
            state.history_status = ReportHistoryStatus::Ready;
        }
        ReportingEvent::HistoryFailed { reason } => {
            state.history_status = ReportHistoryStatus::Failed {
                reason: reason.clone(),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opening_a_report_clears_previous_failure() {
        let mut state = ReportingState {
            status: ReportStatus::Failed {
                reason: "old".into(),
            },
            ..ReportingState::default()
        };
        reduce(
            &mut state,
            &ReportingEvent::Opened {
                player_id: 7,
                login: "Aurora".into(),
            },
        );
        assert!(state.open);
        assert_eq!(state.player_id, Some(7));
        assert_eq!(state.status, ReportStatus::Idle);
    }

    #[test]
    fn history_refresh_does_not_disturb_submission_status() {
        let mut state = ReportingState::default();
        reduce(&mut state, &ReportingEvent::Submitted);
        reduce(&mut state, &ReportingEvent::HistoryLoading);
        reduce(
            &mut state,
            &ReportingEvent::HistoryLoaded {
                reports: vec![ModerationReportSummary {
                    id: 8,
                    create_time: "2026-08-10T18:30:00Z".into(),
                    offenders: vec!["Player".into()],
                    game_id: None,
                    description: "Abusive chat".into(),
                    moderator: String::new(),
                    moderator_notice: String::new(),
                    status: "OPEN".into(),
                }],
            },
        );
        assert_eq!(state.status, ReportStatus::Submitted);
        assert_eq!(state.history_status, ReportHistoryStatus::Ready);
        assert_eq!(state.history.len(), 1);
    }
}
