//! The player's own annotations: private notes on players, and notes and
//! tags on replays, with the bounds every write to them goes through.

use super::*;

pub const PLAYER_NOTE_CHARACTER_LIMIT: usize = 150;
const PLAYER_NOTE_LIMIT: usize = 1_000;

/// A private, local annotation attached to one FAF account.
///
/// Player ids are stable across renames, while `login` makes the persisted JSON
/// understandable and gives a future notes-management screen something useful
/// to show without an API lookup.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlayerNote {
    pub player_id: i32,
    pub login: String,
    pub note: String,
}

pub const REPLAY_NOTE_CHARACTER_LIMIT: usize = 500;
pub const REPLAY_TAG_CHARACTER_LIMIT: usize = 32;
pub const REPLAY_TAGS_PER_REPLAY: usize = 10;
const REPLAY_NOTE_LIMIT: usize = 5_000;

/// A private, local comment and set of tags on one replay (#324).
///
/// Keyed by the game id, which the vault and a downloaded file share, so a
/// note written on the Online tab is there on the Local tab too. A file whose
/// header names no game (a skirmish, an old recording) has no id to key by,
/// so its note is keyed by the file instead: `replay_id` is 0 and `path` says
/// which file. Nothing here leaves this machine: it is a personal index ("Lots
/// finals"), not a review.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReplayNote {
    pub replay_id: i32,
    /// The file the note is on, for a replay without a game id, as
    /// [`normalize_replay_path`] spells it so that every way of writing the
    /// path finds it. `None` for a game, which its id names wherever its file
    /// is. Defaulted, so the notes in a settings file from before this field
    /// load as the game notes they are.
    #[serde(default)]
    pub path: Option<String>,
    pub comment: String,
    pub tags: Vec<String>,
}

/// What a replay note is filed under: its game, or for a replay without a
/// game id, its file.
///
/// Ordered games first, by id, which is the order the notes have always been
/// persisted in; the files follow by path.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum ReplayNoteKey {
    Game(i32),
    File(String),
}

impl ReplayNoteKey {
    /// `None` for a replay with neither a game id nor a file, which a note
    /// could never be found on again.
    fn of(replay_id: i32, path: Option<&str>) -> Option<Self> {
        if replay_id > 0 {
            return Some(Self::Game(replay_id));
        }
        path.filter(|path| !path.is_empty())
            .map(|path| Self::File(normalize_replay_path(path)))
    }

    fn of_note(note: &ReplayNote) -> Option<Self> {
        Self::of(note.replay_id, note.path.as_deref())
    }

    fn note(self, comment: String, tags: Vec<String>) -> ReplayNote {
        let (replay_id, path) = match self {
            Self::Game(replay_id) => (replay_id, None),
            Self::File(path) => (0, Some(path)),
        };
        ReplayNote {
            replay_id,
            path,
            comment,
            tags,
        }
    }
}

/// The player's own annotations: notes on players and on replays.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SocialPreferences {
    pub player_notes: Vec<PlayerNote>,
    pub replay_notes: Vec<ReplayNote>,
}

// Through a defaulting twin, so a settings file from before replay notes
// loads, while the generated TypeScript keeps both fields required.
impl<'de> Deserialize<'de> for SocialPreferences {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize, Default)]
        #[serde(rename_all = "camelCase", default)]
        struct Wire {
            player_notes: Vec<PlayerNote>,
            replay_notes: Vec<ReplayNote>,
        }
        let wire = Wire::deserialize(deserializer)?;
        Ok(Self {
            player_notes: wire.player_notes,
            replay_notes: wire.replay_notes,
        })
    }
}

impl SocialPreferences {
    pub fn note_for(&self, player_id: i32) -> Option<&PlayerNote> {
        self.player_notes
            .iter()
            .find(|entry| entry.player_id == player_id)
    }

    /// Set or clear one note, applying the same bounds on every write path.
    pub fn set_player_note(&mut self, player_id: i32, login: String, note: String) {
        if player_id <= 0 {
            return;
        }

        let login = login.trim();
        if login.is_empty() || login.chars().count() > 64 {
            return;
        }

        self.player_notes
            .retain(|entry| entry.player_id != player_id);
        let note: String = note
            .trim()
            .chars()
            .take(PLAYER_NOTE_CHARACTER_LIMIT)
            .collect();
        if !note.is_empty() {
            self.player_notes.push(PlayerNote {
                player_id,
                login: login.to_owned(),
                note,
            });
        }
        *self = std::mem::take(self).normalized();
    }

    /// The note on a replay: on its game when it has an id, otherwise on its
    /// file, however that file's path is spelt. Twin of `noteForReplay` in
    /// `ui/src/shared/rules/replayNotes.ts`.
    ///
    /// Only the path asked about is normalised: the notes held are already
    /// (see `normalized_replay_notes`), and the twin is asked once per file
    /// the local list filters, which is thousands of times per keystroke.
    pub fn replay_note_for(&self, replay_id: i32, local_path: Option<&str>) -> Option<&ReplayNote> {
        match ReplayNoteKey::of(replay_id, local_path)? {
            ReplayNoteKey::Game(replay_id) => self
                .replay_notes
                .iter()
                .find(|entry| entry.replay_id == replay_id),
            ReplayNoteKey::File(path) => self
                .replay_notes
                .iter()
                .find(|entry| entry.replay_id <= 0 && entry.path.as_deref() == Some(path.as_str())),
        }
    }

    /// Rename a tag on every replay that carries it, or remove it from all of
    /// them when `to` is empty (#324). Matched case-insensitively, the way
    /// tags are kept once per replay. A note left with neither comment nor
    /// tag goes, and a rename onto a tag a replay already has merges the two.
    pub fn rename_replay_tag(&mut self, from: &str, to: &str) {
        let from = from.trim().to_lowercase();
        if from.is_empty() {
            return;
        }
        let to = to.trim();
        for note in &mut self.replay_notes {
            let mut renamed = Vec::with_capacity(note.tags.len());
            for tag in std::mem::take(&mut note.tags) {
                if tag.to_lowercase() != from {
                    renamed.push(tag);
                } else if !to.is_empty() {
                    renamed.push(to.to_string());
                }
            }
            note.tags = renamed;
        }
        *self = std::mem::take(self).normalized();
    }

    /// Set or clear one replay's note. Empty comment and no tags clears it.
    ///
    /// `local_path` is what a replay without a game id is known by, and is
    /// ignored for one with an id: the game's note is the same note whichever
    /// copy of it is open. A replay with neither cannot keep a note.
    pub fn set_replay_note(
        &mut self,
        replay_id: i32,
        local_path: Option<&str>,
        comment: String,
        tags: Vec<String>,
    ) {
        let Some(key) = ReplayNoteKey::of(replay_id, local_path) else {
            return;
        };
        self.replay_notes
            .retain(|entry| ReplayNoteKey::of_note(entry).as_ref() != Some(&key));
        self.replay_notes.push(key.note(comment, tags));
        *self = std::mem::take(self).normalized();
    }

    pub(super) fn normalized(mut self) -> Self {
        self.replay_notes = normalized_replay_notes(std::mem::take(&mut self.replay_notes));
        let mut notes = BTreeMap::new();
        for entry in self.player_notes {
            if entry.player_id <= 0 {
                continue;
            }
            let login = entry.login.trim();
            let note: String = entry
                .note
                .trim()
                .chars()
                .take(PLAYER_NOTE_CHARACTER_LIMIT)
                .collect();
            if login.is_empty() || login.chars().count() > 64 || note.is_empty() {
                continue;
            }
            notes.insert(
                entry.player_id,
                PlayerNote {
                    player_id: entry.player_id,
                    login: login.to_owned(),
                    note,
                },
            );
        }
        self.player_notes = notes.into_values().take(PLAYER_NOTE_LIMIT).collect();
        self
    }
}

/// Bound and tidy replay notes. Twin of `normalizeReplayNotes` in
/// `ui/src/shared/rules/replayNotes.ts`.
///
/// A tag is trimmed, kept to one line and a bounded length, and kept once per
/// replay however it is capitalised, the first spelling winning. The last note
/// written for a replay wins, and a note left with neither a comment nor a tag
/// is dropped, which is how a note is cleared.
///
/// A note is filed under its game, or under its normalised path for a replay
/// without a game id (see [`ReplayNoteKey`]), so two spellings of one file are
/// one note and a game note never carries a path. Over the limit, the file
/// notes go before any game note, since they sort after them.
fn normalized_replay_notes(notes: Vec<ReplayNote>) -> Vec<ReplayNote> {
    let mut by_key = BTreeMap::new();
    for entry in notes {
        let Some(key) = ReplayNoteKey::of_note(&entry) else {
            continue;
        };
        let comment: String = entry
            .comment
            .trim()
            .chars()
            .take(REPLAY_NOTE_CHARACTER_LIMIT)
            .collect();
        let mut tags: Vec<String> = Vec::new();
        for tag in entry.tags {
            let tag: String = tag
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .chars()
                .take(REPLAY_TAG_CHARACTER_LIMIT)
                .collect();
            let tag = tag.trim().to_string();
            if tag.is_empty()
                || tags
                    .iter()
                    .any(|known| known.to_lowercase() == tag.to_lowercase())
            {
                continue;
            }
            tags.push(tag);
            if tags.len() == REPLAY_TAGS_PER_REPLAY {
                break;
            }
        }
        if comment.is_empty() && tags.is_empty() {
            by_key.remove(&key);
            continue;
        }
        by_key.insert(key.clone(), key.note(comment, tags));
    }
    by_key.into_values().take(REPLAY_NOTE_LIMIT).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn player_notes_are_keyed_by_id_bounded_and_clearable() {
        let mut preferences = SocialPreferences::default();
        preferences.set_player_note(42, " OldName ".into(), " first note ".into());
        preferences.set_player_note(
            42,
            "NewName".into(),
            "é".repeat(PLAYER_NOTE_CHARACTER_LIMIT + 20),
        );
        preferences.set_player_note(7, "EarlierId".into(), "keep me".into());

        assert_eq!(preferences.player_notes[0].player_id, 7);
        let note = preferences.note_for(42).unwrap();
        assert_eq!(note.login, "NewName");
        assert_eq!(note.note.chars().count(), PLAYER_NOTE_CHARACTER_LIMIT);

        preferences.set_player_note(42, "NewName".into(), "   ".into());
        assert!(preferences.note_for(42).is_none());
        assert_eq!(preferences.player_notes.len(), 1);
    }

    #[test]
    fn malformed_persisted_player_notes_are_normalized_away() {
        let settings = SettingsState {
            social: SocialPreferences {
                replay_notes: Vec::new(),
                player_notes: vec![
                    PlayerNote {
                        player_id: -1,
                        login: "Invalid".into(),
                        note: "ignored".into(),
                    },
                    PlayerNote {
                        player_id: 3,
                        login: " Aurora ".into(),
                        note: " useful ".into(),
                    },
                ],
            },
            ..SettingsState::default()
        }
        .normalized();

        assert_eq!(settings.social.player_notes.len(), 1);
        assert_eq!(settings.social.player_notes[0].login, "Aurora");
        assert_eq!(settings.social.player_notes[0].note, "useful");
    }

    #[test]
    fn replay_notes_are_tidied_bounded_and_cleared_by_emptying() {
        let mut preferences = SocialPreferences::default();
        preferences.set_replay_note(
            42,
            None,
            "  great comeback  ".into(),
            vec![
                " Lots  finals ".into(),
                "lots finals".into(),
                String::new(),
                "casts".into(),
            ],
        );
        let note = preferences.replay_note_for(42, None).unwrap();
        assert_eq!(note.comment, "great comeback");
        assert_eq!(note.tags, ["Lots finals", "casts"]);

        preferences.set_replay_note(42, None, " ".into(), Vec::new());
        assert!(preferences.replay_note_for(42, None).is_none());

        // Neither a game nor a file: nothing a note could be found on again.
        preferences.set_replay_note(0, None, "no game".into(), Vec::new());
        preferences.set_replay_note(0, Some(""), "no file".into(), Vec::new());
        assert!(preferences.replay_notes.is_empty());
    }

    const SKIRMISH: &str = "C:\\Replays\\Skirmish.fafreplay";

    #[test]
    fn a_replay_without_a_game_id_keeps_its_note_on_its_file() {
        let mut preferences = SocialPreferences::default();
        preferences.set_replay_note(0, Some(SKIRMISH), " vs two hard AIs ".into(), Vec::new());

        let note = preferences.replay_note_for(0, Some(SKIRMISH)).unwrap();
        assert_eq!(note.comment, "vs two hard AIs");
        assert_eq!(note.replay_id, 0);
        assert_eq!(note.path.as_deref(), Some("c:/replays/skirmish.fafreplay"));
        // The same file however its path is written, and no other file.
        assert!(preferences
            .replay_note_for(0, Some("c:/replays/./skirmish.fafreplay"))
            .is_some());
        assert!(preferences
            .replay_note_for(0, Some("C:/Replays/Other.fafreplay"))
            .is_none());
        assert!(preferences.replay_note_for(0, None).is_none());

        // Written again through another spelling, it is the same note.
        preferences.set_replay_note(
            0,
            Some("c:/replays/skirmish.fafreplay"),
            "rematch".into(),
            vec!["ai".into()],
        );
        assert_eq!(preferences.replay_notes.len(), 1);
        assert_eq!(
            preferences
                .replay_note_for(0, Some(SKIRMISH))
                .unwrap()
                .comment,
            "rematch"
        );

        // Cleared by emptying, like a game's.
        preferences.set_replay_note(0, Some(SKIRMISH), String::new(), Vec::new());
        assert!(preferences.replay_notes.is_empty());
    }

    #[test]
    fn a_game_note_is_the_games_whichever_file_is_open() {
        let mut preferences = SocialPreferences::default();
        preferences.set_replay_note(7, Some(SKIRMISH), "ladder".into(), Vec::new());
        let note = preferences.replay_note_for(7, None).unwrap();
        assert_eq!(note.path, None, "a game note carries no path");
        assert_eq!(
            preferences
                .replay_note_for(7, Some("D:/elsewhere/7.fafreplay"))
                .unwrap()
                .comment,
            "ladder"
        );
        // And it is not the file's note: that file has no game id of its own.
        assert!(preferences.replay_note_for(0, Some(SKIRMISH)).is_none());
    }

    #[test]
    fn game_notes_come_first_and_file_notes_follow_by_path() {
        let notes = normalized_replay_notes(vec![
            ReplayNote {
                replay_id: 0,
                path: Some("C:/b.fafreplay".into()),
                comment: "b".into(),
                tags: Vec::new(),
            },
            ReplayNote {
                replay_id: 12,
                path: None,
                comment: "game".into(),
                tags: Vec::new(),
            },
            ReplayNote {
                replay_id: -3,
                path: Some("C:\\A.fafreplay".into()),
                comment: "a".into(),
                tags: Vec::new(),
            },
            // The same file as the first note, written later: it wins.
            ReplayNote {
                replay_id: 0,
                path: Some("c:/B.fafreplay".into()),
                comment: "b again".into(),
                tags: Vec::new(),
            },
        ]);
        let keys: Vec<(i32, Option<&str>, &str)> = notes
            .iter()
            .map(|note| (note.replay_id, note.path.as_deref(), note.comment.as_str()))
            .collect();
        assert_eq!(
            keys,
            [
                (12, None, "game"),
                (0, Some("c:/a.fafreplay"), "a"),
                (0, Some("c:/b.fafreplay"), "b again"),
            ]
        );
    }

    #[test]
    fn a_tag_is_renamed_or_removed_on_every_replay() {
        let mut preferences = SocialPreferences::default();
        preferences.set_replay_note(
            1,
            None,
            String::new(),
            vec!["Lots finals".into(), "casts".into()],
        );
        preferences.set_replay_note(2, None, String::new(), vec!["lots finals".into()]);
        preferences.set_replay_note(3, None, "keep me".into(), vec!["LOTS FINALS".into()]);
        preferences.set_replay_note(0, Some(SKIRMISH), String::new(), vec!["Lots Finals".into()]);

        preferences.rename_replay_tag("lots FINALS", "Lots 2026");
        assert_eq!(
            preferences.replay_note_for(1, None).unwrap().tags,
            ["Lots 2026", "casts"]
        );
        assert_eq!(
            preferences.replay_note_for(2, None).unwrap().tags,
            ["Lots 2026"]
        );
        assert_eq!(
            preferences.replay_note_for(0, Some(SKIRMISH)).unwrap().tags,
            ["Lots 2026"]
        );

        // Renaming onto a tag the replay already has merges the two.
        preferences.rename_replay_tag("casts", "lots 2026");
        assert_eq!(
            preferences.replay_note_for(1, None).unwrap().tags,
            ["Lots 2026"]
        );

        // Deleting drops a note that is left with nothing, keeps one with a comment.
        preferences.rename_replay_tag("Lots 2026", "");
        assert!(preferences.replay_note_for(1, None).is_none());
        assert!(preferences.replay_note_for(2, None).is_none());
        assert!(preferences.replay_note_for(0, Some(SKIRMISH)).is_none());
        assert_eq!(
            preferences.replay_note_for(3, None).unwrap().comment,
            "keep me"
        );
        assert!(preferences
            .replay_note_for(3, None)
            .unwrap()
            .tags
            .is_empty());
    }

    #[test]
    fn a_settings_file_from_before_replay_notes_still_loads() {
        let social: SocialPreferences = serde_json::from_str(r#"{"playerNotes":[]}"#).unwrap();
        assert!(social.replay_notes.is_empty());
    }

    #[test]
    fn replay_notes_saved_before_file_notes_still_load_as_game_notes() {
        // A note as the settings file has held them since #324: no path.
        let settings: SettingsState = serde_json::from_str(
            r#"{"theme":"forgeDark","social":{"playerNotes":[],"replayNotes":[{"replayId":42,"comment":"finals","tags":["Lots"]}]}}"#,
        )
        .unwrap();
        let settings = settings.normalized();
        let note = settings.social.replay_note_for(42, None).cloned();
        assert_eq!(
            note,
            Some(ReplayNote {
                replay_id: 42,
                path: None,
                comment: "finals".into(),
                tags: vec!["Lots".into()],
            })
        );
    }
}
