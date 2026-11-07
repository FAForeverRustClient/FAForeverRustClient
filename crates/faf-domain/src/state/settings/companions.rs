//! Companion programs: tools of the player's own that the client starts
//! alongside Forged Alliance, such as a recording tool.
//!
//! Only what the player configured here is ever started. Nothing from a game,
//! a replay or the server names a program, and the shell asks before a page
//! may change what one of these runs (`picked_paths` in src-tauri).

use super::*;

/// The most companion programs the list holds. Far more than anybody needs,
/// and there so a hand-edited settings file cannot start a hundred programs
/// with every game.
pub const MAX_COMPANION_PROGRAMS: usize = 16;

/// Which launches a companion program comes with.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum CompanionLaunches {
    /// Games: online, offline, skirmish, tutorials and lessons.
    #[default]
    Games,
    /// Replays, recorded and live.
    Replays,
    /// Both.
    Both,
}

/// One launch a companion program can come with. Backend only: the launcher
/// asks which entries come with the launch it is starting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompanionLaunchKind {
    Game,
    Replay,
}

impl CompanionLaunches {
    pub fn covers(self, kind: CompanionLaunchKind) -> bool {
        matches!(
            (self, kind),
            (Self::Both, _)
                | (Self::Games, CompanionLaunchKind::Game)
                | (Self::Replays, CompanionLaunchKind::Replay)
        )
    }
}

/// Whether a companion program starts before the game's process or right
/// after it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum CompanionTiming {
    Before,
    /// After, by default: a tool that watches for the game finds it at once,
    /// and one that fails to start cannot hold the game up.
    #[default]
    After,
}

/// A program the client starts alongside Forged Alliance.
///
/// Started with the player's own rights and without a console window, and
/// only when the process the client started for it last time is no longer
/// running, so a launch never stacks a second copy on the first. A program
/// that is missing or fails to start is reported and the game starts anyway.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct CompanionProgram {
    /// Stable for the life of the entry, so the process started for it is
    /// still recognised after the entry is renamed or moved in the list.
    pub id: String,
    pub enabled: bool,
    /// What the settings call it. Shown, never run.
    pub name: String,
    /// The executable: a complete path to an existing file.
    pub program: String,
    /// Its command line after the program. Split the way the launch command
    /// is (quotes group words, nothing else is interpreted), never handed to a
    /// shell.
    pub arguments: String,
    /// Where it runs. Empty is the program's own folder.
    pub working_dir: String,
    pub launches: CompanionLaunches,
    pub timing: CompanionTiming,
    /// Close it when the game it came with exits. Only ever the process the
    /// client started for this entry, never another copy of the program.
    pub close_with_game: bool,
    /// An executable's file name, such as `obs64.exe`. While a process of
    /// that name is running the program is not started again, whoever
    /// started it. Empty checks nothing. Windows only.
    pub skip_if_running: String,
}

impl Default for CompanionProgram {
    fn default() -> Self {
        Self {
            id: String::new(),
            enabled: true,
            name: String::new(),
            program: String::new(),
            arguments: String::new(),
            working_dir: String::new(),
            launches: CompanionLaunches::default(),
            timing: CompanionTiming::default(),
            close_with_game: false,
            skip_if_running: String::new(),
        }
    }
}

impl CompanionProgram {
    /// What the shell confirms before a page may change it: the program, how
    /// it is started and where. Trimmed and unquoted, the way the entry is
    /// stored.
    pub fn command(&self) -> (&str, &str, &str) {
        (
            unquoted(&self.program),
            self.arguments.trim(),
            unquoted(&self.working_dir),
        )
    }
}

impl CompanionProgram {
    /// Whether this entry runs anything at all: a program, or arguments or a
    /// folder waiting for one.
    pub fn has_command(&self) -> bool {
        let (program, arguments, working_dir) = self.command();
        !program.is_empty() || !arguments.is_empty() || !working_dir.is_empty()
    }

    /// Whether this entry still runs `base`, compared the way entries are
    /// stored.
    pub fn runs(&self, base: &CompanionCommand) -> bool {
        self.command()
            == (
                unquoted(&base.program),
                base.arguments.trim(),
                unquoted(&base.working_dir),
            )
    }
}

/// What a companion entry runs: the part a change to has to be confirmed.
///
/// A change to it names the command it was made against
/// (`SettingsCommand::PatchCompanion`), and the settings service applies it
/// only while the entry still runs exactly that. The shell confirms a change
/// against the entry it sees; this is what keeps the entry from being a
/// different one by the time the change arrives.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CompanionCommand {
    pub program: String,
    pub arguments: String,
    pub working_dir: String,
}

/// A path without the pair of quotes around it. Windows' "Copy as path" adds
/// them, and a path pasted with them is not a path to anything.
fn unquoted(path: &str) -> &str {
    let path = path.trim();
    path.strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
        .map(str::trim)
        .unwrap_or(path)
}

preference_patch! {
    /// A change to one [`CompanionProgram`], naming only the fields it
    /// touches. Applied by the settings service to its own copy of the entry
    /// (`SettingsCommand::PatchCompanion`), so a switch flipped while
    /// another change is still on its way cannot carry that change's old
    /// value back. `id` is listed because every field has to be; the
    /// service never changes an entry's id.
    CompanionProgramPatch for CompanionProgram {
        id: String,
        enabled: bool,
        name: String,
        program: String,
        arguments: String,
        working_dir: String,
        launches: CompanionLaunches,
        timing: CompanionTiming,
        close_with_game: bool,
        skip_if_running: String,
    }
}

impl CompanionProgramPatch {
    /// Whether the patch touches what the entry runs.
    pub fn changes_command(&self) -> bool {
        self.program.is_some() || self.arguments.is_some() || self.working_dir.is_some()
    }
}

/// Trim and bound every entry, and give each a distinct id.
///
/// An id is normally made by the settings page when it adds an entry. A
/// missing or repeated one (a hand-edited file) gets `companion-<n>`, with
/// `n` past every number already in use, so it can never be mistaken for the
/// entry a running process was started for.
pub(super) fn normalize_companions(companions: Vec<CompanionProgram>) -> Vec<CompanionProgram> {
    let mut companions: Vec<CompanionProgram> = companions
        .into_iter()
        .take(MAX_COMPANION_PROGRAMS)
        .map(|companion| CompanionProgram {
            id: truncate_trimmed(companion.id, 64),
            name: truncate_trimmed(companion.name, 64),
            program: truncate_trimmed(unquoted(&companion.program).to_owned(), 1024),
            arguments: truncate_trimmed(companion.arguments, 2048),
            working_dir: truncate_trimmed(unquoted(&companion.working_dir).to_owned(), 1024),
            skip_if_running: truncate_trimmed(companion.skip_if_running, 260),
            ..companion
        })
        .collect();
    let mut next = companions
        .iter()
        .filter_map(|companion| companion.id.strip_prefix("companion-")?.parse::<u32>().ok())
        .max()
        .unwrap_or(0);
    let mut seen: Vec<String> = Vec::new();
    for companion in &mut companions {
        if companion.id.is_empty() || seen.contains(&companion.id) {
            next += 1;
            companion.id = format!("companion-{next}");
        }
        seen.push(companion.id.clone());
    }
    companions
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_entry_is_enabled_starts_after_the_game_and_is_left_running() {
        let companion = CompanionProgram::default();
        assert!(companion.enabled);
        assert_eq!(companion.launches, CompanionLaunches::Games);
        assert_eq!(companion.timing, CompanionTiming::After);
        assert!(!companion.close_with_game);
        assert!(GamePreferences::default().companions.is_empty());
    }

    #[test]
    fn an_entry_from_an_older_file_takes_the_defaults_for_what_it_lacks() {
        let companion: CompanionProgram =
            serde_json::from_str(r#"{"id":"a","program":"C:/Tools/x.exe"}"#).unwrap();
        assert_eq!(
            companion,
            CompanionProgram {
                id: "a".into(),
                program: "C:/Tools/x.exe".into(),
                ..CompanionProgram::default()
            }
        );
        // And a file from before the list existed has none.
        let game: GamePreferences = serde_json::from_str("{}").unwrap();
        assert!(game.companions.is_empty());
    }

    #[test]
    fn which_launches_an_entry_comes_with() {
        use CompanionLaunchKind::{Game, Replay};
        assert!(CompanionLaunches::Games.covers(Game));
        assert!(!CompanionLaunches::Games.covers(Replay));
        assert!(CompanionLaunches::Replays.covers(Replay));
        assert!(!CompanionLaunches::Replays.covers(Game));
        assert!(CompanionLaunches::Both.covers(Game) && CompanionLaunches::Both.covers(Replay));
    }

    #[test]
    fn entries_are_trimmed_bounded_and_given_distinct_ids() {
        let entry = |id: &str| CompanionProgram {
            id: id.into(),
            program: "  C:/Tools/x.exe ".into(),
            ..CompanionProgram::default()
        };
        let normalized = normalize_companions(vec![
            entry("companion-4"),
            entry(""),
            entry("companion-4"),
            entry(" kept "),
        ]);
        let ids: Vec<&str> = normalized.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, ["companion-4", "companion-5", "companion-6", "kept"]);
        assert!(normalized.iter().all(|c| c.program == "C:/Tools/x.exe"));

        let pasted = normalize_companions(vec![CompanionProgram {
            program: " \"C:/My Tools/x.exe\" ".into(),
            working_dir: "\"C:/My Tools\"".into(),
            arguments: "\"quoted argument\"".into(),
            ..entry("pasted")
        }]);
        assert_eq!(pasted[0].program, "C:/My Tools/x.exe");
        assert_eq!(pasted[0].working_dir, "C:/My Tools");
        assert_eq!(
            pasted[0].arguments, "\"quoted argument\"",
            "arguments keep their quotes"
        );

        let many = normalize_companions(vec![entry(""); MAX_COMPANION_PROGRAMS + 4]);
        assert_eq!(many.len(), MAX_COMPANION_PROGRAMS);
    }

    #[test]
    fn an_entry_is_compared_with_a_command_the_way_it_is_stored() {
        let stored = CompanionProgram {
            program: "C:/Tools/x.exe".into(),
            arguments: "--quiet".into(),
            ..CompanionProgram::default()
        };
        let base = |program: &str, arguments: &str| CompanionCommand {
            program: program.into(),
            arguments: arguments.into(),
            working_dir: String::new(),
        };
        assert!(stored.runs(&base(" \"C:/Tools/x.exe\" ", " --quiet ")));
        assert!(!stored.runs(&base("C:/Tools/x.exe", "")));
        assert!(!stored.runs(&CompanionCommand::default()));
        assert!(stored.has_command());
        assert!(!CompanionProgram::default().has_command());

        assert!(CompanionProgramPatch {
            arguments: Some(String::new()),
            ..Default::default()
        }
        .changes_command());
        assert!(!CompanionProgramPatch {
            enabled: Some(true),
            name: Some("x".into()),
            ..Default::default()
        }
        .changes_command());
    }
}
