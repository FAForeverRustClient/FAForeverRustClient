//! Unit history slice: the Changelog tab's third section, one unit's values
//! over the game releases.
//!
//! Two loads. The unit list is read from the installed game once per visit;
//! a unit's history is built when it is chosen, from blueprints that are
//! downloaded once and kept on disk for good (a release tag never changes).
//! Two histories at most are held: the unit on screen and the one it is
//! compared with. Any other is dropped when the choice moves on, and comes
//! back from the disk cache when it is chosen again.
//!
//! The rules that turn blueprints into a history are in
//! [`crate::protocol::unit_history`]; this slice holds what has been loaded.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::protocol::unit_history::{UnitHistory, UnitSummary};

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum UnitListStatus {
    #[default]
    Idle,
    Loading,
    Ready,
    Failed {
        reason: String,
    },
}

/// One unit's history, while it loads and once it has.
// No `Eq`: a history carries `f64` values.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum UnitHistoryStatus {
    /// `fetched` of `total` releases are read; the first open of a unit
    /// downloads one small file per release, later opens read the disk.
    Loading {
        fetched: u32,
        total: u32,
    },
    Ready {
        history: UnitHistory,
    },
    Failed {
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UnitHistoryState {
    pub list_status: UnitListStatus,
    /// Every unit a player can build, from the installed game files.
    pub units: Vec<UnitSummary>,
    /// The unit on screen, by upper-case blueprint id.
    pub selected: Option<String>,
    /// A second unit drawn into the same graph.
    pub compared: Option<String>,
    /// By blueprint id; only `selected` and `compared` are kept.
    pub histories: BTreeMap<String, UnitHistoryStatus>,
}

impl UnitHistoryState {
    pub fn unit(&self, id: &str) -> Option<&UnitSummary> {
        self.units.iter().find(|unit| unit.id == id)
    }

    fn keep_only_shown(&mut self) {
        let (selected, compared) = (self.selected.clone(), self.compared.clone());
        self.histories.retain(|id, _| {
            selected.as_deref() == Some(id.as_str()) || compared.as_deref() == Some(id.as_str())
        });
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum UnitHistoryEvent {
    ListLoading,
    ListLoaded {
        units: Vec<UnitSummary>,
    },
    ListFailed {
        reason: String,
    },
    Selected {
        id: String,
    },
    Compared {
        id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    HistoryProgress {
        id: String,
        fetched: u32,
        total: u32,
    },
    HistoryLoaded {
        history: UnitHistory,
    },
    HistoryFailed {
        id: String,
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum UnitHistoryCommand {
    /// Read the unit list from the installed game. Sent on every visit to the
    /// section, so a game update shows its new units.
    LoadList,
    /// Show one unit's history, building it unless it is already held. The
    /// id is the blueprint id in any case.
    Select { id: String },
    /// Draw a second unit into the graph, or stop comparing with `None`.
    Compare { id: Option<String> },
}

pub fn reduce(state: &mut UnitHistoryState, event: &UnitHistoryEvent) {
    match event {
        UnitHistoryEvent::ListLoading => state.list_status = UnitListStatus::Loading,
        UnitHistoryEvent::ListLoaded { units } => {
            state.units = units.clone();
            state.list_status = UnitListStatus::Ready;
        }
        UnitHistoryEvent::ListFailed { reason } => {
            state.list_status = UnitListStatus::Failed {
                reason: reason.clone(),
            }
        }
        UnitHistoryEvent::Selected { id } => {
            state.selected = Some(id.clone());
            if state.compared.as_deref() == Some(id.as_str()) {
                state.compared = None;
            }
            state.keep_only_shown();
        }
        UnitHistoryEvent::Compared { id } => {
            state.compared = id
                .clone()
                .filter(|id| state.selected.as_deref() != Some(id));
            state.keep_only_shown();
        }
        UnitHistoryEvent::HistoryProgress { id, fetched, total } => {
            if is_shown(state, id) {
                state.histories.insert(
                    id.clone(),
                    UnitHistoryStatus::Loading {
                        fetched: *fetched,
                        total: *total,
                    },
                );
            }
        }
        UnitHistoryEvent::HistoryLoaded { history } => {
            // A history that arrives after the choice has moved on is not
            // kept: it would only be dropped at the next choice.
            if is_shown(state, &history.unit.id) {
                state.histories.insert(
                    history.unit.id.clone(),
                    UnitHistoryStatus::Ready {
                        history: history.clone(),
                    },
                );
            }
        }
        UnitHistoryEvent::HistoryFailed { id, reason } => {
            if is_shown(state, id) {
                state.histories.insert(
                    id.clone(),
                    UnitHistoryStatus::Failed {
                        reason: reason.clone(),
                    },
                );
            }
        }
    }
}

fn is_shown(state: &UnitHistoryState, id: &str) -> bool {
    state.selected.as_deref() == Some(id) || state.compared.as_deref() == Some(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(id: &str) -> UnitSummary {
        UnitSummary {
            id: id.into(),
            path: format!("units/{id}/{id}_unit.bp"),
            name: None,
            description: None,
            faction: Some("UEF".into()),
            tech: Some(1),
        }
    }

    fn history(id: &str) -> UnitHistory {
        UnitHistory {
            unit: summary(id),
            releases: Vec::new(),
            weapons: Vec::new(),
            series: Vec::new(),
            changes: Vec::new(),
        }
    }

    #[test]
    fn only_the_shown_units_keep_their_history() {
        let mut state = UnitHistoryState::default();
        reduce(
            &mut state,
            &UnitHistoryEvent::Selected {
                id: "UEL0201".into(),
            },
        );
        reduce(
            &mut state,
            &UnitHistoryEvent::HistoryLoaded {
                history: history("UEL0201"),
            },
        );
        reduce(
            &mut state,
            &UnitHistoryEvent::Compared {
                id: Some("URL0107".into()),
            },
        );
        reduce(
            &mut state,
            &UnitHistoryEvent::HistoryLoaded {
                history: history("URL0107"),
            },
        );
        assert_eq!(state.histories.len(), 2);

        reduce(
            &mut state,
            &UnitHistoryEvent::Selected {
                id: "UAL0201".into(),
            },
        );
        assert_eq!(
            state.histories.keys().collect::<Vec<_>>(),
            ["URL0107"],
            "the compared unit stays, the one left is dropped"
        );
        reduce(
            &mut state,
            &UnitHistoryEvent::HistoryLoaded {
                history: history("UEL0201"),
            },
        );
        assert!(
            !state.histories.contains_key("UEL0201"),
            "a late answer for a unit no longer shown is not kept"
        );
    }

    #[test]
    fn a_unit_is_not_compared_with_itself() {
        let mut state = UnitHistoryState::default();
        reduce(
            &mut state,
            &UnitHistoryEvent::Selected {
                id: "UEL0201".into(),
            },
        );
        reduce(
            &mut state,
            &UnitHistoryEvent::Compared {
                id: Some("UEL0201".into()),
            },
        );
        assert_eq!(state.compared, None);

        reduce(
            &mut state,
            &UnitHistoryEvent::Compared {
                id: Some("URL0107".into()),
            },
        );
        reduce(
            &mut state,
            &UnitHistoryEvent::Selected {
                id: "URL0107".into(),
            },
        );
        assert_eq!(state.selected.as_deref(), Some("URL0107"));
        assert_eq!(
            state.compared, None,
            "choosing the compared unit ends the comparison"
        );
    }

    #[test]
    fn progress_and_failure_land_on_the_shown_unit() {
        let mut state = UnitHistoryState::default();
        reduce(
            &mut state,
            &UnitHistoryEvent::Selected {
                id: "UEL0201".into(),
            },
        );
        reduce(
            &mut state,
            &UnitHistoryEvent::HistoryProgress {
                id: "UEL0201".into(),
                fetched: 3,
                total: 160,
            },
        );
        assert_eq!(
            state.histories.get("UEL0201"),
            Some(&UnitHistoryStatus::Loading {
                fetched: 3,
                total: 160
            })
        );
        reduce(
            &mut state,
            &UnitHistoryEvent::HistoryFailed {
                id: "UEL0201".into(),
                reason: "offline".into(),
            },
        );
        assert!(matches!(
            state.histories.get("UEL0201"),
            Some(UnitHistoryStatus::Failed { .. })
        ));
    }

    #[test]
    fn the_list_replaces_wholesale() {
        let mut state = UnitHistoryState::default();
        reduce(&mut state, &UnitHistoryEvent::ListLoading);
        assert_eq!(state.list_status, UnitListStatus::Loading);
        reduce(
            &mut state,
            &UnitHistoryEvent::ListLoaded {
                units: vec![summary("UEL0201")],
            },
        );
        assert_eq!(state.list_status, UnitListStatus::Ready);
        assert!(state.unit("UEL0201").is_some());
        reduce(
            &mut state,
            &UnitHistoryEvent::ListFailed {
                reason: "no game".into(),
            },
        );
        assert_eq!(state.units.len(), 1, "a failed reload keeps the list");
    }
}
