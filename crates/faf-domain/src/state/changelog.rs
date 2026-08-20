//! Changelog slice: FAForever/fa's patch notes, read inside the client.
//!
//! Two-step on purpose. The index is one document listing every release, while
//! each note is its own document averaging a few kilobytes; fetching all 168 up
//! front would move megabytes to show a list. So the index loads with the tab
//! and a note loads when it is opened, then stays cached for the session.
//!
//! Parsing lives in [`crate::protocol::changelog`]; this slice only holds what
//! has been loaded and which release is selected.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::protocol::changelog::{ChangelogEntry, ChangelogRelease};

/// Status of the index fetch. Mirrors the other list statuses in this crate.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum ChangelogStatus {
    #[default]
    Idle,
    Loading,
    Ready,
    Failed {
        reason: String,
    },
}

/// Status of the currently selected note, kept apart from the index status so a
/// failed note never makes the list look broken.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum ChangelogEntryStatus {
    #[default]
    Idle,
    #[serde(rename_all = "camelCase")]
    Loading {
        id: String,
    },
    Ready,
    Failed {
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ChangelogState {
    pub releases: Vec<ChangelogRelease>,
    pub status: ChangelogStatus,
    /// Release id currently shown, empty before the first selection.
    pub selected: String,
    /// Notes fetched this session, by release id. Kept rather than replaced so
    /// moving back and forth through the list costs nothing after the first read.
    pub entries: BTreeMap<String, ChangelogEntry>,
    pub entry_status: ChangelogEntryStatus,
}

impl ChangelogState {
    /// The note for the current selection, if it has been fetched.
    pub fn selected_entry(&self) -> Option<&ChangelogEntry> {
        self.entries.get(&self.selected)
    }

    pub fn release(&self, id: &str) -> Option<&ChangelogRelease> {
        self.releases.iter().find(|release| release.id == id)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum ChangelogEvent {
    Loading,
    Loaded {
        releases: Vec<ChangelogRelease>,
    },
    LoadFailed {
        reason: String,
    },
    #[serde(rename_all = "camelCase")]
    EntryLoading {
        id: String,
    },
    EntryLoaded {
        entry: ChangelogEntry,
    },
    EntryLoadFailed {
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum ChangelogCommand {
    /// Fetch the release index. The service ignores this once it is `Ready`.
    Load,
    /// Show a release, fetching its note unless it is already cached.
    #[serde(rename_all = "camelCase")]
    Select { id: String },
}

pub fn reduce(state: &mut ChangelogState, event: &ChangelogEvent) {
    match event {
        ChangelogEvent::Loading => state.status = ChangelogStatus::Loading,
        ChangelogEvent::Loaded { releases } => {
            state.releases = releases.clone();
            state.status = ChangelogStatus::Ready;
        }
        ChangelogEvent::LoadFailed { reason } => {
            state.status = ChangelogStatus::Failed {
                reason: reason.clone(),
            }
        }
        ChangelogEvent::EntryLoading { id } => {
            // The selection moves immediately, so the header and the highlighted
            // row track the click rather than the download.
            state.selected = id.clone();
            state.entry_status = ChangelogEntryStatus::Loading { id: id.clone() };
        }
        ChangelogEvent::EntryLoaded { entry } => {
            state.selected = entry.id.clone();
            state.entries.insert(entry.id.clone(), entry.clone());
            state.entry_status = ChangelogEntryStatus::Ready;
        }
        ChangelogEvent::EntryLoadFailed { reason } => {
            state.entry_status = ChangelogEntryStatus::Failed {
                reason: reason.clone(),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::changelog::ChangelogBlock;

    fn release(id: &str) -> ChangelogRelease {
        ChangelogRelease {
            id: id.into(),
            kind: "Game Patch".into(),
            date: "2026-08-14".into(),
            year: "2026".into(),
            source_url: "https://example.invalid/post.md".into(),
            web_url: "https://example.invalid/3837".into(),
        }
    }

    fn entry(id: &str) -> ChangelogEntry {
        ChangelogEntry {
            id: id.into(),
            title: format!("{id} - Game Patch"),
            blocks: vec![ChangelogBlock::Heading {
                level: 1,
                text: "Game version".into(),
            }],
        }
    }

    #[test]
    fn loading_the_index_replaces_it_wholesale() {
        let mut state = ChangelogState::default();
        reduce(&mut state, &ChangelogEvent::Loading);
        assert_eq!(state.status, ChangelogStatus::Loading);

        reduce(
            &mut state,
            &ChangelogEvent::Loaded {
                releases: vec![release("3837")],
            },
        );
        assert_eq!(state.status, ChangelogStatus::Ready);
        assert_eq!(state.releases.len(), 1);
        assert_eq!(state.release("3837").unwrap().kind, "Game Patch");
        assert!(state.release("3836").is_none());
    }

    #[test]
    fn the_selection_moves_before_the_note_arrives() {
        let mut state = ChangelogState::default();
        reduce(
            &mut state,
            &ChangelogEvent::EntryLoading { id: "3837".into() },
        );

        assert_eq!(state.selected, "3837", "the row highlights on click");
        assert!(
            state.selected_entry().is_none(),
            "but there is nothing to render yet"
        );
        assert_eq!(
            state.entry_status,
            ChangelogEntryStatus::Loading { id: "3837".into() }
        );
    }

    #[test]
    fn notes_accumulate_so_revisiting_one_costs_nothing() {
        let mut state = ChangelogState::default();
        reduce(
            &mut state,
            &ChangelogEvent::EntryLoaded {
                entry: entry("3837"),
            },
        );
        reduce(
            &mut state,
            &ChangelogEvent::EntryLoaded {
                entry: entry("3836"),
            },
        );

        assert_eq!(state.entries.len(), 2, "the earlier note is kept");
        assert_eq!(state.selected, "3836");
        assert_eq!(state.selected_entry().unwrap().title, "3836 - Game Patch");
    }

    #[test]
    fn a_failed_note_leaves_the_index_and_the_cache_alone() {
        let mut state = ChangelogState::default();
        reduce(
            &mut state,
            &ChangelogEvent::Loaded {
                releases: vec![release("3837")],
            },
        );
        reduce(
            &mut state,
            &ChangelogEvent::EntryLoaded {
                entry: entry("3837"),
            },
        );
        reduce(
            &mut state,
            &ChangelogEvent::EntryLoadFailed {
                reason: "offline".into(),
            },
        );

        assert_eq!(
            state.status,
            ChangelogStatus::Ready,
            "the list still stands"
        );
        assert_eq!(state.entries.len(), 1, "the cached note survives");
        assert_eq!(
            state.entry_status,
            ChangelogEntryStatus::Failed {
                reason: "offline".into()
            }
        );
    }
}
