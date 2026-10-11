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
    /// The reporter's own words, without a game log excerpt the client
    /// appended (see [`crate::protocol::report_log`]).
    pub description: String,
    /// The game log excerpt this client appended to the description, when it
    /// did. Split off so the history can fold it away instead of showing a
    /// hundred lines of engine trace in every card.
    pub attached_log: Option<String>,
    pub moderator: String,
    pub moderator_notice: String,
    pub status: String,
}

/// A game log excerpt prepared for a report, shown to the user before it is
/// sent (see [`crate::protocol::report_log`] for why it is text at all).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReportLogExcerpt {
    /// The game id the dialog asked for, `None` when it named none. A
    /// submission attaches the excerpt only for that same game id, so a log
    /// read for one game cannot ride along with a report about another.
    pub requested_game_id: Option<i32>,
    /// The game the log belongs to, read from its file name. It differs from
    /// `requested_game_id` when no log of that game is kept and the most
    /// recent one was taken instead, which the dialog says.
    pub log_game_id: Option<i32>,
    /// The log's file name, for the preview. Never a path.
    pub file_name: String,
    /// Exactly the text the report will carry, header and footer included.
    /// The preview shows this string and the submission appends this string,
    /// so what the user read is what the moderators get.
    pub block: String,
    /// Lines in the log, and how many of them the excerpt kept.
    pub total_lines: u32,
    pub kept_lines: u32,
    /// How many paths, names and addresses were replaced in what is kept.
    pub redactions: u32,
}

/// Whether the report will carry a game log excerpt, and how far along it is.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    content = "payload",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ReportLogAttachment {
    /// Nothing attached: the default, and what unticking the box returns to.
    #[default]
    Off,
    Preparing {
        game_id: Option<i32>,
    },
    Ready {
        excerpt: ReportLogExcerpt,
    },
    /// The client keeps no log of any online game.
    Unavailable {
        game_id: Option<i32>,
    },
    Failed {
        game_id: Option<i32>,
        reason: String,
    },
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
    pub log_attachment: ReportLogAttachment,
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
    LogPreparing {
        game_id: Option<i32>,
    },
    LogPrepared {
        excerpt: ReportLogExcerpt,
    },
    LogUnavailable {
        game_id: Option<i32>,
    },
    LogFailed {
        game_id: Option<i32>,
        reason: String,
    },
    LogDetached,
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
    /// Open the report form for a player known only by name (#321).
    ///
    /// The menus open on a name, and the account id the report needs comes
    /// from the lobby's player list, which only holds players who are online.
    /// A replay's lineup is mostly people who are not, so the backend looks
    /// the name up and then opens the form exactly as [`Self::Open`] does.
    OpenByLogin {
        login: String,
    },
    Close,
    LoadHistory,
    /// Read the game log of `game_id`, or the most recent one when none is
    /// kept for it, and prepare the excerpt the report would carry, so the
    /// user can read it before deciding to send it. Sent again when the game
    /// id changes while the box is ticked.
    AttachLog {
        game_id: Option<i32>,
    },
    /// Take the excerpt off the report again.
    DetachLog,
    Submit {
        player_id: i32,
        login: String,
        description: String,
        game_id: Option<i32>,
        incident_time: String,
        /// Append the prepared excerpt the user was shown. Only an excerpt
        /// that is ready and was prepared for this `game_id` is attached; the
        /// submission refuses rather than read the log again unseen.
        attach_log: bool,
    },
}

pub fn reduce(state: &mut ReportingState, event: &ReportingEvent) {
    match event {
        ReportingEvent::Opened { player_id, login } => {
            state.open = true;
            state.player_id = Some(*player_id);
            state.login = login.clone();
            state.status = ReportStatus::Idle;
            // A new report starts without a log: the excerpt was read for the
            // previous one, and attaching it is the user's decision each time.
            state.log_attachment = ReportLogAttachment::Off;
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
        ReportingEvent::LogPreparing { game_id } => {
            state.log_attachment = ReportLogAttachment::Preparing { game_id: *game_id }
        }
        ReportingEvent::LogPrepared { excerpt } => {
            state.log_attachment = ReportLogAttachment::Ready {
                excerpt: excerpt.clone(),
            }
        }
        ReportingEvent::LogUnavailable { game_id } => {
            state.log_attachment = ReportLogAttachment::Unavailable { game_id: *game_id }
        }
        ReportingEvent::LogFailed { game_id, reason } => {
            state.log_attachment = ReportLogAttachment::Failed {
                game_id: *game_id,
                reason: reason.clone(),
            }
        }
        ReportingEvent::LogDetached => state.log_attachment = ReportLogAttachment::Off,
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
                    attached_log: None,
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

    fn excerpt(requested_game_id: Option<i32>) -> ReportLogExcerpt {
        ReportLogExcerpt {
            requested_game_id,
            log_game_id: requested_game_id,
            file_name: "game-42-1-1.log".into(),
            block: "excerpt".into(),
            total_lines: 10,
            kept_lines: 2,
            redactions: 0,
        }
    }

    #[test]
    fn a_report_about_someone_new_starts_without_the_last_log() {
        let mut state = ReportingState::default();
        reduce(
            &mut state,
            &ReportingEvent::LogPrepared {
                excerpt: excerpt(Some(42)),
            },
        );
        reduce(
            &mut state,
            &ReportingEvent::Opened {
                player_id: 9,
                login: "Vex".into(),
            },
        );
        assert_eq!(state.log_attachment, ReportLogAttachment::Off);
    }

    #[test]
    fn the_log_attachment_follows_its_own_events_and_leaves_the_status_alone() {
        let mut state = ReportingState::default();
        reduce(&mut state, &ReportingEvent::Submitting);
        reduce(
            &mut state,
            &ReportingEvent::LogPreparing { game_id: Some(42) },
        );
        assert_eq!(
            state.log_attachment,
            ReportLogAttachment::Preparing { game_id: Some(42) }
        );
        reduce(
            &mut state,
            &ReportingEvent::LogFailed {
                game_id: Some(42),
                reason: "denied".into(),
            },
        );
        assert!(matches!(
            state.log_attachment,
            ReportLogAttachment::Failed { .. }
        ));
        reduce(&mut state, &ReportingEvent::LogDetached);
        assert_eq!(state.log_attachment, ReportLogAttachment::Off);
        assert_eq!(state.status, ReportStatus::Submitting);
    }
}
