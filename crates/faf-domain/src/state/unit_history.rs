//! Unit history slice: the Changelog tab's third section, one unit's values
//! over the game releases.
//!
//! Two loads. The unit list is read from the installed game once per visit;
//! a unit's history is built when it is chosen, from blueprints that are
//! downloaded once and kept on disk for good (a release tag never changes).
//! Only the selected units' histories are held. One that is put away is
//! dropped, and comes back from the disk cache when it is picked again.
//!
//! The rules that turn blueprints into a history are in
//! [`crate::protocol::unit_history`]; this slice holds what has been loaded.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use specta::Type;

#[cfg(test)]
use crate::protocol::unit_history::UnitKind;
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
    /// Boxed: a history is a few kilobytes of series, and the other two
    /// states are a pair of numbers and a string. Transparent on the wire.
    Ready {
        history: Box<UnitHistory>,
    },
    Failed {
        reason: String,
    },
}

/// The most units compared at once: one line each, and the chart's palette
/// keeps lines apart for every kind of colour vision only up to about this
/// many on screen together.
pub const MAX_SELECTED: usize = 6;

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UnitHistoryState {
    pub list_status: UnitListStatus,
    /// Every unit a player can build, from the installed game files.
    pub units: Vec<UnitSummary>,
    /// The units compared, by upper-case blueprint id, in the order they were
    /// picked. One shows all of its values; several are compared value by
    /// value.
    pub selected: Vec<String>,
    /// By blueprint id; only the selected units are kept.
    pub histories: BTreeMap<String, UnitHistoryStatus>,
}

impl UnitHistoryState {
    pub fn unit(&self, id: &str) -> Option<&UnitSummary> {
        self.units.iter().find(|unit| unit.id == id)
    }

    fn is_selected(&self, id: &str) -> bool {
        self.selected.iter().any(|selected| selected == id)
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
    SelectionChanged {
        ids: Vec<String>,
    },
    #[serde(rename_all = "camelCase")]
    HistoryProgress {
        id: String,
        fetched: u32,
        total: u32,
    },
    HistoryLoaded {
        /// Boxed: a history is many times the size of every other event.
        history: Box<UnitHistory>,
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
    /// Show this one unit and nothing else: what a link opens. The id is the
    /// blueprint id in any case.
    Select { id: String },
    /// Compare these units, in this order, building every history not held
    /// yet. More than [`MAX_SELECTED`] are cut to the first ones.
    SetSelection { ids: Vec<String> },
}

/// A selection as the slice keeps it: upper case, each unit once, at most
/// [`MAX_SELECTED`].
pub fn normalized_selection(ids: &[String]) -> Vec<String> {
    let mut selection: Vec<String> = Vec::new();
    for id in ids {
        let id = id.trim().to_ascii_uppercase();
        if !id.is_empty() && !selection.contains(&id) && selection.len() < MAX_SELECTED {
            selection.push(id);
        }
    }
    selection
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
        UnitHistoryEvent::SelectionChanged { ids } => {
            state.selected = normalized_selection(ids);
            let selected = state.selected.clone();
            state
                .histories
                .retain(|id, _| selected.iter().any(|kept| kept == id));
        }
        UnitHistoryEvent::HistoryProgress { id, fetched, total } => {
            if state.is_selected(id) {
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
            // A history that arrives after its unit was put away is not kept:
            // it would only be dropped at the next change.
            if state.is_selected(&history.unit.id) {
                state.histories.insert(
                    history.unit.id.clone(),
                    UnitHistoryStatus::Ready {
                        history: history.clone(),
                    },
                );
            }
        }
        UnitHistoryEvent::HistoryFailed { id, reason } => {
            if state.is_selected(id) {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(id: &str) -> UnitSummary {
        UnitSummary {
            id: id.into(),
            path: format!("units/{id}/{id}_unit.bp"),
            icon_url: String::new(),
            name: None,
            description: None,
            faction: Some("UEF".into()),
            tech: Some(1),
            kind: UnitKind::Land,
            strategic_icon: None,
            role: None,
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

    fn select(ids: &[&str]) -> UnitHistoryEvent {
        UnitHistoryEvent::SelectionChanged {
            ids: ids.iter().map(|id| id.to_string()).collect(),
        }
    }

    #[test]
    fn only_the_selected_units_keep_their_history() {
        let mut state = UnitHistoryState::default();
        reduce(&mut state, &select(&["UEL0201", "URL0107"]));
        reduce(
            &mut state,
            &UnitHistoryEvent::HistoryLoaded {
                history: Box::new(history("UEL0201")),
            },
        );
        reduce(
            &mut state,
            &UnitHistoryEvent::HistoryLoaded {
                history: Box::new(history("URL0107")),
            },
        );
        assert_eq!(state.histories.len(), 2);

        reduce(&mut state, &select(&["URL0107", "UAL0201"]));
        assert_eq!(
            state.histories.keys().collect::<Vec<_>>(),
            ["URL0107"],
            "the unit put away is dropped, the one kept stays"
        );
        reduce(
            &mut state,
            &UnitHistoryEvent::HistoryLoaded {
                history: Box::new(history("UEL0201")),
            },
        );
        assert!(
            !state.histories.contains_key("UEL0201"),
            "a late answer for a unit no longer selected is not kept"
        );
    }

    #[test]
    fn a_selection_is_upper_case_unique_and_capped() {
        let ids: Vec<String> = [
            "uel0201",
            "UEL0201",
            " url0107 ",
            "",
            "A",
            "B",
            "C",
            "D",
            "E",
            "F",
        ]
        .iter()
        .map(|id| id.to_string())
        .collect();
        let selection = normalized_selection(&ids);
        assert_eq!(selection.len(), MAX_SELECTED);
        assert_eq!(selection[..3], ["UEL0201", "URL0107", "A"]);
    }

    #[test]
    fn progress_and_failure_land_on_a_selected_unit() {
        let mut state = UnitHistoryState::default();
        reduce(&mut state, &select(&["UEL0201"]));
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
        reduce(
            &mut state,
            &UnitHistoryEvent::HistoryProgress {
                id: "URL0107".into(),
                fetched: 1,
                total: 2,
            },
        );
        assert!(!state.histories.contains_key("URL0107"));
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
