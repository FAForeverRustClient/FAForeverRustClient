//! Tournaments: FAF's competitive events, hosted on Challonge.
//!
//! The Java client is the reference (`tournament/TournamentService` +
//! `TournamentsController`): one list from the FAF API's Challonge bridge, a
//! status derived from the event's own dates, and a detail pane per event.
//!
//! The Python client's `tourneys/` package is *not* a usable reference. It
//! talks to a legacy "tournament server" on port 11001 that no longer runs,
//! and its own source says the feature "most likely won't return". Its one
//! idea worth keeping: joining the tournament's chat channel: is preserved
//! here as a channel name derived the same way it derived one.

use serde::{Deserialize, Serialize};
use specta::Type;

/// Where an event stands right now.
///
/// Derived rather than stored, exactly as in the Java client's
/// `Tournament.status()`: the API reports dates and a signup flag, and the
/// status is what those mean at the moment you look. Storing it would go stale
/// while the list sits open: a tournament starts without anyone clicking
/// anything.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TournamentStatus {
    /// Announced, but signup is not open (either not yet, or no longer).
    ClosedForRegistration,
    OpenForRegistration,
    Running,
    Finished,
}

impl TournamentStatus {
    /// The label the Java client shows (`tournament.status.*`).
    pub fn label(&self) -> &'static str {
        match self {
            Self::ClosedForRegistration => "Closed for registration",
            Self::OpenForRegistration => "Open for registration",
            Self::Running => "Running",
            Self::Finished => "Finished",
        }
    }
}

/// One tournament, as the FAF API's `/challonge/v1/tournaments.json` bridge
/// reports it.
///
/// Timestamps are Unix seconds rather than the API's ISO strings so the status
/// derivation is a comparison instead of date parsing: this crate is pure and
/// has no clock, no time zone database, and no date library.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Tournament {
    pub id: i32,
    pub name: String,
    /// Free text from the organiser. Challonge stores it as HTML; it arrives
    /// here already reduced to plain text (see `protocol::tournaments`),
    /// because rendering third-party markup would mean trusting an organiser
    /// with script execution inside the client.
    pub description: String,
    /// Challonge's own name for the format: `single elimination`, `swiss`, …
    pub tournament_type: String,
    pub participant_count: i32,
    pub created_at: Option<u32>,
    pub starting_at: Option<u32>,
    pub completed_at: Option<u32>,
    pub challonge_url: String,
    pub live_image_url: String,
    pub sign_up_url: String,
    pub open_for_signup: bool,
}

impl Tournament {
    /// Status as of `now` (Unix seconds). Mirrors the Java client's
    /// `Tournament.status()` decision order exactly: completion wins over
    /// having started, which wins over the signup flag.
    pub fn status(&self, now: u32) -> TournamentStatus {
        if self.completed_at.is_some() {
            TournamentStatus::Finished
        } else if self.starting_at.is_some_and(|start| start < now) {
            TournamentStatus::Running
        } else if self.open_for_signup {
            TournamentStatus::OpenForRegistration
        } else {
            TournamentStatus::ClosedForRegistration
        }
    }

    /// The IRC channel for this tournament, as the Python client derived it
    /// when an event started (`"#" + title.replace(" ", "_")`).
    ///
    /// Only a *name*: this client does not auto-join on the organiser's
    /// schedule the way the Python one did, because a client that silently
    /// joins channels on a timer is the behaviour the chat rework removed.
    /// Offering the name lets the user join deliberately.
    pub fn chat_channel(&self) -> String {
        format!("#{}", self.name.replace(' ', "_"))
    }
}

/// Order the list the way the Java client does:
/// closed-for-registration → open → running → finished, newest first within
/// each group.
///
/// That comes out of `comparing(status).thenComparing(createdAt).reversed()`
/// over an enum declared finished-first. It reads oddly until you notice it is
/// chronological by life stage: events that have not begun sit above ones that
/// have, and finished events sink to the bottom where they belong.
///
/// [`TournamentStatus`] is declared in that same reading order here, so the
/// status key sorts ascending and only `created_at` is reversed: reversing
/// both, as the Java expression literally does, would invert the groups.
pub fn sort_tournaments(tournaments: &mut [Tournament], now: u32) {
    tournaments.sort_by(|left, right| {
        left.status(now)
            .cmp(&right.status(now))
            .then_with(|| right.created_at.cmp(&left.created_at))
    });
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum TournamentsStatus {
    #[default]
    Idle,
    Loading,
    Ready,
    Failed {
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TournamentsState {
    pub tournaments: Vec<Tournament>,
    pub status: TournamentsStatus,
    /// Which event's detail pane is open. `None` until the first load picks
    /// one, matching the Java client selecting the first row automatically.
    pub selected_id: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum TournamentsEvent {
    Loading,
    Loaded {
        tournaments: Vec<Tournament>,
    },
    LoadFailed {
        reason: String,
    },
    #[serde(rename_all = "camelCase")]
    Selected {
        tournament_id: i32,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum TournamentsCommand {
    Load,
    #[serde(rename_all = "camelCase")]
    Select {
        tournament_id: i32,
    },
}

pub fn reduce(state: &mut TournamentsState, event: &TournamentsEvent) {
    match event {
        TournamentsEvent::Loading => state.status = TournamentsStatus::Loading,
        TournamentsEvent::Loaded { tournaments } => {
            state.tournaments = tournaments.clone();
            state.status = TournamentsStatus::Ready;
            // Keep the open detail pane if that event is still in the list,
            // a refresh should not throw the user back to the top: but never
            // leave a selection pointing at an event that has gone.
            let still_present = state
                .selected_id
                .is_some_and(|id| tournaments.iter().any(|t| t.id == id));
            if !still_present {
                state.selected_id = tournaments.first().map(|t| t.id);
            }
        }
        TournamentsEvent::LoadFailed { reason } => {
            state.status = TournamentsStatus::Failed {
                reason: reason.clone(),
            }
        }
        TournamentsEvent::Selected { tournament_id } => state.selected_id = Some(*tournament_id),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u32 = 1_800_000_000;
    const HOUR: u32 = 3_600;

    fn tournament(id: i32) -> Tournament {
        Tournament {
            id,
            name: format!("Event {id}"),
            description: String::new(),
            tournament_type: "swiss".into(),
            participant_count: 0,
            created_at: Some(NOW - HOUR),
            starting_at: None,
            completed_at: None,
            challonge_url: format!("https://challonge.com/e{id}"),
            live_image_url: String::new(),
            sign_up_url: String::new(),
            open_for_signup: false,
        }
    }

    #[test]
    fn a_completed_event_is_finished_however_its_other_dates_read() {
        // Completion is checked first in the Java client, and it has to be:
        // a finished tournament still has a start date in the past and may
        // still carry a stale signup flag.
        let event = Tournament {
            completed_at: Some(NOW - HOUR),
            starting_at: Some(NOW - 2 * HOUR),
            open_for_signup: true,
            ..tournament(1)
        };
        assert_eq!(event.status(NOW), TournamentStatus::Finished);
    }

    #[test]
    fn an_event_whose_start_has_passed_is_running() {
        let event = Tournament {
            starting_at: Some(NOW - 1),
            ..tournament(1)
        };
        assert_eq!(event.status(NOW), TournamentStatus::Running);
    }

    #[test]
    fn an_event_starting_exactly_now_has_not_started_yet() {
        // Strictly `<`, as in the Java client's `isBefore`. The boundary is
        // worth pinning: the alternative flips a tournament to Running a
        // second early and hides its signup link.
        let event = Tournament {
            starting_at: Some(NOW),
            open_for_signup: true,
            ..tournament(1)
        };
        assert_eq!(event.status(NOW), TournamentStatus::OpenForRegistration);
    }

    #[test]
    fn a_future_event_reports_whether_you_can_sign_up() {
        let open = Tournament {
            starting_at: Some(NOW + HOUR),
            open_for_signup: true,
            ..tournament(1)
        };
        assert_eq!(open.status(NOW), TournamentStatus::OpenForRegistration);

        let closed = Tournament {
            open_for_signup: false,
            ..open
        };
        assert_eq!(closed.status(NOW), TournamentStatus::ClosedForRegistration);
    }

    #[test]
    fn an_event_with_no_dates_at_all_is_not_running() {
        // Challonge lets an organiser announce without scheduling.
        assert_eq!(
            tournament(1).status(NOW),
            TournamentStatus::ClosedForRegistration
        );
    }

    #[test]
    fn the_list_runs_from_upcoming_to_finished_newest_first() {
        let mut list = vec![
            Tournament {
                id: 1,
                completed_at: Some(NOW - HOUR),
                ..tournament(1)
            },
            Tournament {
                id: 2,
                open_for_signup: true,
                ..tournament(2)
            },
            Tournament {
                id: 3,
                starting_at: Some(NOW - HOUR),
                ..tournament(3)
            },
            Tournament {
                id: 4,
                ..tournament(4)
            },
        ];
        sort_tournaments(&mut list, NOW);
        let order: Vec<i32> = list.iter().map(|t| t.id).collect();
        assert_eq!(
            order,
            vec![4, 2, 3, 1],
            "closed → open → running → finished, as in the Java client"
        );
    }

    #[test]
    fn events_of_the_same_status_are_newest_first() {
        let mut list = vec![
            Tournament {
                id: 1,
                created_at: Some(NOW - 3 * HOUR),
                open_for_signup: true,
                ..tournament(1)
            },
            Tournament {
                id: 2,
                created_at: Some(NOW - HOUR),
                open_for_signup: true,
                ..tournament(2)
            },
        ];
        sort_tournaments(&mut list, NOW);
        assert_eq!(list[0].id, 2);
    }

    #[test]
    fn a_tournaments_chat_channel_is_its_name_with_underscores() {
        let event = Tournament {
            name: "Summer Invitational 2026".into(),
            ..tournament(1)
        };
        assert_eq!(event.chat_channel(), "#Summer_Invitational_2026");
    }

    #[test]
    fn the_first_event_is_selected_on_the_first_load() {
        let mut state = TournamentsState::default();
        reduce(&mut state, &TournamentsEvent::Loading);
        assert_eq!(state.status, TournamentsStatus::Loading);

        reduce(
            &mut state,
            &TournamentsEvent::Loaded {
                tournaments: vec![tournament(7), tournament(8)],
            },
        );
        assert_eq!(state.status, TournamentsStatus::Ready);
        assert_eq!(state.selected_id, Some(7));
    }

    #[test]
    fn refreshing_keeps_the_open_event_open() {
        let mut state = TournamentsState {
            selected_id: Some(8),
            ..TournamentsState::default()
        };
        reduce(
            &mut state,
            &TournamentsEvent::Loaded {
                tournaments: vec![tournament(7), tournament(8)],
            },
        );
        assert_eq!(
            state.selected_id,
            Some(8),
            "a refresh must not throw the user back to the top of the list"
        );
    }

    #[test]
    fn a_selection_that_disappears_falls_back_to_the_first_event() {
        let mut state = TournamentsState {
            selected_id: Some(99),
            ..TournamentsState::default()
        };
        reduce(
            &mut state,
            &TournamentsEvent::Loaded {
                tournaments: vec![tournament(7)],
            },
        );
        assert_eq!(state.selected_id, Some(7));
    }

    #[test]
    fn an_empty_list_selects_nothing() {
        let mut state = TournamentsState {
            selected_id: Some(3),
            ..TournamentsState::default()
        };
        reduce(
            &mut state,
            &TournamentsEvent::Loaded {
                tournaments: Vec::new(),
            },
        );
        assert_eq!(state.selected_id, None);
    }

    #[test]
    fn a_failed_load_keeps_whatever_was_already_listed() {
        // The list stays usable while the reason is shown next to it, rather
        // than blanking on a transient API error.
        let mut state = TournamentsState {
            tournaments: vec![tournament(7)],
            selected_id: Some(7),
            status: TournamentsStatus::Ready,
        };
        reduce(
            &mut state,
            &TournamentsEvent::LoadFailed {
                reason: "503".into(),
            },
        );
        assert_eq!(state.tournaments.len(), 1);
        assert_eq!(state.selected_id, Some(7));
        assert_eq!(
            state.status,
            TournamentsStatus::Failed {
                reason: "503".into()
            }
        );
    }
}
