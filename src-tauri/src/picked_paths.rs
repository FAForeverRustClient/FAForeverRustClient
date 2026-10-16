//! Paths the player picked in a native dialog, and the check that a path the
//! page hands back is one of them.
//!
//! The page used to open the file dialogs itself and pass whatever came back
//! to the backend as a plain string: the game executable, the Java runtime,
//! the content folders, a replay, a folder to upload, a sound or a picture.
//! "A path the player chose" and "any path the page names" were therefore the
//! same thing, so script running in the page (an XSS that got past the CSP)
//! could point the client at any program to start or any file to copy in.
//! Found by the security review of develop at 22862b3 and left open in #515.
//!
//! The dialog now opens here. What the player picks is remembered for a while
//! and still returned to the page, which shows it and sends it back; a command
//! that takes a path then accepts only one that was picked, the one already
//! stored, or an empty one (a reset). The page learning the path is no secret:
//! it is what the settings show anyway.
//!
//! Two settings that decide what is started have no dialog, because they are
//! typed: the launch wrapper and the extra game arguments. A change to either
//! is confirmed by the player in a native dialog, which the page cannot click.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use faf_domain::state::settings::{
    GamePreferences, GamePreferencesPatch, PathPreferences, PathPreferencesPatch,
};
use faf_domain::state::{ReplayCommand, SettingsCommand, SettingsState, UploadsCommand};
use faf_domain::AppCommand;
use serde::Deserialize;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

/// How long a pick stays good for. Long enough for an upload dialog left open
/// over a coffee, short enough that a path picked this morning is not a
/// standing licence.
const PICK_LIFETIME: Duration = Duration::from_secs(30 * 60);

/// What the player picked, and when.
#[derive(Default)]
pub(crate) struct PickedPaths(Mutex<HashMap<String, Instant>>);

impl PickedPaths {
    fn remember(&self, path: &str) {
        let mut picked = self.0.lock().unwrap();
        let now = Instant::now();
        picked.retain(|_, at| now.duration_since(*at) < PICK_LIFETIME);
        picked.insert(path.trim().to_owned(), now);
    }

    fn was_picked(&self, path: &str) -> bool {
        self.0
            .lock()
            .unwrap()
            .get(path.trim())
            .is_some_and(|at| at.elapsed() < PICK_LIFETIME)
    }

    /// `path` may be used where `current` is stored: it was picked, it is what
    /// is stored already, or it is empty and so a reset to the default.
    fn admits(&self, path: &str, current: &str) -> bool {
        let path = path.trim();
        path.is_empty() || path == current.trim() || self.was_picked(path)
    }

    /// The same, for a command that only reads a file and has nothing stored.
    pub(crate) fn require(&self, path: &str) -> Result<(), String> {
        if self.was_picked(path) {
            Ok(())
        } else {
            Err(refusal(path))
        }
    }
}

fn refusal(path: &str) -> String {
    format!("{path} was not chosen in a file dialog of this client")
}

/// One filter of the dialog, as the page describes it.
#[derive(Deserialize)]
pub(crate) struct PickFilter {
    name: String,
    extensions: Vec<String>,
}

/// What the page asks the dialog to look like. Nothing in it decides what may
/// be picked: that is the player, in the dialog.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PickRequest {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    filters: Vec<PickFilter>,
    #[serde(default)]
    directory: bool,
    #[serde(default)]
    default_path: Option<String>,
}

/// Open the native file or folder dialog and return what the player picked,
/// or `None` when they cancelled.
///
/// The same dialog the page used to open through the dialog plugin, built the
/// way that plugin's own `open` builds it, except where it starts: see
/// [`start_of`].
#[tauri::command]
pub(crate) async fn pick_path(
    request: PickRequest,
    window: tauri::Window,
    picked: tauri::State<'_, PickedPaths>,
) -> Result<Option<String>, String> {
    let mut dialog = window.dialog().file();
    #[cfg(any(windows, target_os = "macos"))]
    {
        dialog = dialog.set_parent(&window);
    }
    if let Some(title) = request.title {
        dialog = dialog.set_title(title);
    }
    for filter in &request.filters {
        let extensions: Vec<&str> = filter.extensions.iter().map(String::as_str).collect();
        dialog = dialog.add_filter(&filter.name, &extensions);
    }
    // A start on another machine is not looked at: checking it is how
    // Windows signs in to that host with the player's credentials.
    if let Some(start) = request
        .default_path
        .as_deref()
        .filter(|start| !names_another_machine(start))
    {
        let (folder, name) = start_of(start);
        if let Some(folder) = folder {
            dialog = dialog.set_directory(folder);
        }
        if let Some(name) = name {
            dialog = dialog.set_file_name(name);
        }
    }
    // On a blocking thread, as `confirm_launch_change` does: the dialog
    // waits for the player, and an async worker held that long slowed the
    // lobby connection, ICE and event forwarding until it closed.
    let directory = request.directory;
    let chosen = tauri::async_runtime::spawn_blocking(move || {
        if directory {
            dialog.blocking_pick_folder()
        } else {
            dialog.blocking_pick_file()
        }
    })
    .await
    .map_err(|error| format!("the file dialog stopped: {error}"))?;
    let Some(chosen) = chosen else {
        return Ok(None);
    };
    let path = chosen
        .simplified()
        .into_path()
        .map_err(|error| format!("the dialog returned no usable path: {error}"))?
        .to_string_lossy()
        .into_owned();
    picked.remember(&path);
    Ok(Some(path))
}

/// Where a dialog asked to start at `start` should open, and which file name it
/// should preselect.
///
/// A folder opens itself. A file opens its folder with the file selected. A
/// path that does not exist yet (a default folder nobody has created, an
/// install still to be downloaded) opens the nearest folder above it that
/// does: Windows silently ignores a start folder that is missing and opens
/// wherever it was last, which is the one place that is never right.
fn start_of(start: &str) -> (Option<PathBuf>, Option<String>) {
    let start = start.trim();
    if start.is_empty() {
        return (None, None);
    }
    // Windows wants its own separator here (tauri-apps/tauri#8074).
    let start: PathBuf = Path::new(start).components().collect();
    if start.is_dir() {
        return (Some(start), None);
    }
    if start.is_file() {
        let name = start
            .file_name()
            .map(|name| name.to_string_lossy().into_owned());
        let folder = start
            .parent()
            .filter(|parent| parent.components().count() > 0);
        return (folder.map(Path::to_path_buf), name);
    }
    let existing = start
        .ancestors()
        .skip(1)
        .find(|folder| folder.components().count() > 0 && folder.is_dir());
    (existing.map(Path::to_path_buf), None)
}

/// Refuse a command that names a path the player did not pick, and ask before
/// one that changes what the game is started through.
///
/// Called by `dispatch` before the command reaches the backend. Everything
/// else passes untouched. A command handed over by the shell itself, a
/// `.fafreplay` double-clicked in Explorer, does not come through here: it is
/// the operating system's word, not the page's.
pub(crate) async fn admit(
    command: &AppCommand,
    picked: &PickedPaths,
    settings: impl FnOnce() -> SettingsState,
    window: &tauri::Window,
) -> Result<(), String> {
    match command {
        AppCommand::Settings(SettingsCommand::SetGamePath { path }) => {
            admit_path(picked, path, &settings().game_path)
        }
        AppCommand::Settings(SettingsCommand::SetReplayGamePath { path }) => {
            admit_path(picked, path, &settings().replay_game_path)
        }
        AppCommand::Settings(SettingsCommand::PatchPaths { patch }) => {
            admit_paths(picked, patch, &settings().paths)
        }
        AppCommand::Settings(SettingsCommand::PatchGame { patch }) => {
            match launch_change(patch, &settings().game) {
                Some(change) => confirm_launch_change(window, change).await,
                None => Ok(()),
            }
        }
        AppCommand::Replays(ReplayCommand::OpenFile { path }) => {
            admit_local_replay(picked, path).await
        }
        AppCommand::Replays(
            ReplayCommand::LoadDetails {
                local_path: Some(path),
                ..
            }
            | ReplayCommand::LoadAnalysis {
                local_path: Some(path),
                ..
            },
        ) => admit_replay_read(picked, path),
        AppCommand::Uploads(UploadsCommand::Open { request }) => match &request.source_path {
            Some(path) => picked.require(path),
            None => Ok(()),
        },
        _ => Ok(()),
    }
}

/// A replay file the client may read: picked in the dialog, or a row of the
/// local replay list, which is a file the client listed itself out of its own
/// replay folder. A path on another machine that was not picked is refused
/// before anything looks at it.
async fn admit_local_replay(picked: &PickedPaths, path: &str) -> Result<(), String> {
    if picked.was_picked(path) {
        return Ok(());
    }
    if names_another_machine(path) {
        return Err(refusal(path));
    }
    faf_app::infra::replay::validated_local_replay_path(Path::new(path))
        .await
        .map(|_| ())
        .map_err(|_| refusal(path))
}

/// A replay the details or analysis panel reads. Any local file may be read,
/// as before (a replay opened from anywhere through the dialog stays readable
/// after its pick has expired); only a path on another machine is refused
/// unless it was picked, because looking at one signs in to that machine.
fn admit_replay_read(picked: &PickedPaths, path: &str) -> Result<(), String> {
    if names_another_machine(path) && !picked.was_picked(path) {
        Err(refusal(path))
    } else {
        Ok(())
    }
}

/// Whether `path` names another machine (`\servershare`, `\?UNC...`).
///
/// On Windows, merely checking such a path (`is_dir`, `exists`,
/// `canonicalize`) makes the system sign in to that host with the player's
/// credentials. A path from the page that the player did not pick must never
/// be looked at, so these are refused before any check. Extended-length local
/// paths (`\?C:...`) are local and pass.
pub(crate) fn names_another_machine(path: &str) -> bool {
    if !cfg!(windows) {
        return false;
    }
    let path = path.trim().replace('/', "\\");
    match path
        .strip_prefix(r"\\?\")
        .or_else(|| path.strip_prefix(r"\\.\"))
    {
        Some(rest) => rest
            .get(..4)
            .is_some_and(|unc| unc.eq_ignore_ascii_case("UNC\\")),
        None => path.starts_with("\\\\"),
    }
}

fn admit_path(picked: &PickedPaths, path: &str, current: &str) -> Result<(), String> {
    if picked.admits(path, current) {
        Ok(())
    } else {
        Err(refusal(path))
    }
}

fn admit_paths(
    picked: &PickedPaths,
    patch: &PathPreferencesPatch,
    current: &PathPreferences,
) -> Result<(), String> {
    let fields = [
        (&patch.vault_dir, &current.vault_dir),
        (&patch.maps_dir, &current.maps_dir),
        (&patch.mods_dir, &current.mods_dir),
        (&patch.replays_dir, &current.replays_dir),
        (&patch.game_prefs_path, &current.game_prefs_path),
        (&patch.map_generator_dir, &current.map_generator_dir),
        (&patch.java_path, &current.java_path),
        (&patch.wine_prefix, &current.wine_prefix),
        (&patch.original_game_dir, &current.original_game_dir),
    ];
    for (changed, current) in fields {
        if let Some(path) = changed {
            admit_path(picked, path, current)?;
        }
    }
    Ok(())
}

/// The launch settings a patch would change, when it changes them to
/// something other than nothing.
#[derive(Debug, PartialEq)]
struct LaunchChange {
    wrapper: Option<String>,
    arguments: Option<Vec<String>>,
}

/// Compared the way `GamePreferences::normalized` stores them, so a field
/// saved again unchanged, or a stray space, asks nothing. Clearing either one
/// asks nothing either: it can only take a program out of the launch.
fn launch_change(patch: &GamePreferencesPatch, current: &GamePreferences) -> Option<LaunchChange> {
    let wrapper = patch
        .launch_wrapper
        .as_deref()
        .map(str::trim)
        .filter(|wrapper| !wrapper.is_empty() && *wrapper != current.launch_wrapper.trim())
        .map(str::to_owned);
    let arguments = patch
        .additional_arguments
        .as_ref()
        .map(|arguments| {
            arguments
                .iter()
                .map(|argument| argument.trim().to_owned())
                .filter(|argument| !argument.is_empty())
                .collect::<Vec<_>>()
        })
        .filter(|arguments| {
            let stored: Vec<&str> = current
                .additional_arguments
                .iter()
                .map(|argument| argument.trim())
                .filter(|argument| !argument.is_empty())
                .collect();
            !arguments.is_empty() && arguments.iter().map(String::as_str).ne(stored)
        });
    (wrapper.is_some() || arguments.is_some()).then_some(LaunchChange { wrapper, arguments })
}

/// Ask the player, natively, whether the game may be started this way.
/// English, like the tray and the exit warning: the page's language lives in
/// the page, and the page is exactly what this must not take its words from.
async fn confirm_launch_change(window: &tauri::Window, change: LaunchChange) -> Result<(), String> {
    let mut message = String::from("Forged Alliance will be started ");
    if let Some(wrapper) = &change.wrapper {
        message.push_str(&format!("through:\n\n{wrapper}\n\n"));
    }
    if let Some(arguments) = &change.arguments {
        if change.wrapper.is_some() {
            message.push_str("and ");
        }
        message.push_str(&format!(
            "with these extra arguments:\n\n{}\n\n",
            arguments.join(" ")
        ));
    }
    message.push_str("Allow this only if you entered it yourself in Settings.");

    let dialog = window
        .dialog()
        .message(message)
        .title("Change how the game is started?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Allow".to_string(),
            "Keep the old setting".to_string(),
        ));
    // Shadowed rather than `mut`: on Linux there is no parent to set, and an
    // unused `mut` fails the build there.
    #[cfg(any(windows, target_os = "macos"))]
    let dialog = dialog.parent(window);
    let allowed = tauri::async_runtime::spawn_blocking(move || dialog.blocking_show())
        .await
        .map_err(|error| format!("the confirmation could not be shown: {error}"))?;
    if allowed {
        tracing::info!(
            ?change,
            "launch settings changed, confirmed in the native dialog"
        );
        Ok(())
    } else {
        Err("the change to how the game is started was not confirmed".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn a_path_on_another_machine_is_recognised_and_a_local_one_is_not() {
        for remote in [
            r"\\attacker\share\x.fafreplay",
            "//attacker/share/x.fafreplay",
            r"\\?\UNC\attacker\share\x.fafreplay",
            r"\\.\unc\attacker\share",
        ] {
            assert!(names_another_machine(remote), "{remote}");
        }
        for local in [
            r"C:\Users\x\replays\a.fafreplay",
            r"\\?\C:\Users\x\replays\a.fafreplay",
            "relative/a.fafreplay",
        ] {
            assert!(!names_another_machine(local), "{local}");
        }
    }

    #[tokio::test]
    async fn a_replay_path_from_the_page_is_read_only_when_picked_or_listed() {
        let picked = PickedPaths::default();
        let elsewhere = r"\\attacker\share\x.fafreplay";
        assert!(admit_local_replay(&picked, elsewhere).await.is_err());
        assert!(
            admit_local_replay(&picked, "C:/not/a/replay/folder/x.fafreplay")
                .await
                .is_err()
        );
        picked.remember(elsewhere);
        assert!(admit_local_replay(&picked, elsewhere).await.is_ok());
    }

    #[test]
    fn details_read_any_local_replay_but_not_an_unpicked_one_elsewhere() {
        let picked = PickedPaths::default();
        assert!(admit_replay_read(&picked, "C:/Downloads/old.fafreplay").is_ok());
        let elsewhere = r"\\attacker\share\x.fafreplay";
        assert_eq!(
            admit_replay_read(&picked, elsewhere).is_err(),
            cfg!(windows)
        );
        picked.remember(elsewhere);
        assert!(admit_replay_read(&picked, elsewhere).is_ok());
    }

    #[test]
    fn a_path_passes_when_picked_stored_or_empty() {
        let picked = PickedPaths::default();
        picked.remember("C:/Games/FA/bin/ForgedAlliance.exe");

        assert!(picked.admits("C:/Games/FA/bin/ForgedAlliance.exe", ""));
        assert!(picked.admits(" C:/Games/FA/bin/ForgedAlliance.exe ", ""));
        assert!(picked.admits("D:/stored.exe", "D:/stored.exe"));
        assert!(picked.admits("", "D:/stored.exe"));
        assert!(!picked.admits("C:/Windows/System32/cmd.exe", "D:/stored.exe"));
        assert!(picked.require("C:/Windows/System32/cmd.exe").is_err());
    }

    #[test]
    fn a_dialog_starts_in_the_nearest_folder_that_exists() {
        let root = std::env::temp_dir().join(format!("picked-start-{}", std::process::id()));
        let folder = root.join("bin");
        std::fs::create_dir_all(&folder).unwrap();
        let exe = folder.join("ForgedAlliance.exe");
        std::fs::write(&exe, b"").unwrap();

        assert_eq!(
            start_of(&folder.to_string_lossy()),
            (Some(folder.clone()), None)
        );
        assert_eq!(
            start_of(&exe.to_string_lossy()),
            (Some(folder.clone()), Some("ForgedAlliance.exe".into()))
        );
        // Not created yet, two levels deep: the folder that is there.
        let missing = folder.join("maps").join("generated");
        assert_eq!(
            start_of(&missing.to_string_lossy()),
            (Some(folder.clone()), None)
        );
        assert_eq!(start_of("  "), (None, None));

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_path_patch_is_refused_whole_when_one_field_was_not_picked() {
        let picked = PickedPaths::default();
        picked.remember("D:/maps");
        let current = PathPreferences::default();
        let patch = |maps: &str, java: Option<&str>| PathPreferencesPatch {
            maps_dir: Some(maps.into()),
            java_path: java.map(Into::into),
            ..Default::default()
        };

        assert!(admit_paths(&picked, &patch("D:/maps", None), &current).is_ok());
        assert!(admit_paths(&picked, &patch("D:/maps", Some("")), &current).is_ok());
        assert!(admit_paths(&picked, &patch("D:/maps", Some("C:/evil.exe")), &current).is_err());
    }

    #[test]
    fn only_a_new_wrapper_or_new_arguments_ask() {
        let current = GamePreferences {
            launch_wrapper: "gamemoderun".into(),
            additional_arguments: vec!["/nomovie".into()],
            ..Default::default()
        };
        let patch = |wrapper: Option<&str>, arguments: Option<&[&str]>| GamePreferencesPatch {
            launch_wrapper: wrapper.map(Into::into),
            additional_arguments: arguments.map(|all| all.iter().map(|a| a.to_string()).collect()),
            ..Default::default()
        };

        assert_eq!(launch_change(&patch(None, None), &current), None);
        assert_eq!(
            launch_change(&patch(Some(" gamemoderun "), None), &current),
            None
        );
        assert_eq!(launch_change(&patch(Some(""), Some(&[])), &current), None);
        assert_eq!(
            launch_change(&patch(None, Some(&["/nomovie", " "])), &current),
            None
        );
        assert_eq!(
            launch_change(&patch(Some("cmd /c calc"), None), &current),
            Some(LaunchChange {
                wrapper: Some("cmd /c calc".into()),
                arguments: None
            })
        );
        assert_eq!(
            launch_change(
                &patch(None, Some(&["/nomovie", "/init", "x.lua"])),
                &current
            ),
            Some(LaunchChange {
                wrapper: None,
                arguments: Some(vec!["/nomovie".into(), "/init".into(), "x.lua".into()]),
            })
        );
    }
}
