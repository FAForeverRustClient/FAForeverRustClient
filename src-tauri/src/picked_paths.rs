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
//! Three settings that decide what is started are typed rather than picked:
//! the launch wrapper, the extra game arguments and the companion programs
//! started alongside the game. A change to any of them that would run
//! something new is confirmed by the player in a native dialog, which the
//! page cannot click.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use faf_domain::protocol::map_generator::split_command_line;
use faf_domain::state::settings::{
    CompanionCommand, CompanionProgram, CompanionProgramPatch, GamePreferences,
    GamePreferencesPatch, PathPreferences, PathPreferencesPatch,
};
use faf_domain::state::{GeneratorOptions, SettingsState};
use faf_domain::AppCommand;
use faf_ipc::shell::PickRequest;
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

mod policy;

use policy::{path_rule, PathRule};

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
    admit_with_confirmation(command, picked, settings, |change| {
        confirm_launch_change(window, change)
    })
    .await
}

async fn admit_with_confirmation<F, C>(
    command: &AppCommand,
    picked: &PickedPaths,
    settings: impl FnOnce() -> SettingsState,
    confirm: F,
) -> Result<(), String>
where
    F: FnOnce(LaunchChange) -> C,
    C: std::future::Future<Output = Result<(), String>>,
{
    match path_rule(command) {
        PathRule::NoSelection => Ok(()),
        PathRule::GamePath(path) => admit_path(picked, path, &settings().game_path),
        PathRule::ReplayGamePath(path) => admit_path(picked, path, &settings().replay_game_path),
        PathRule::Paths(patch) => admit_paths(picked, patch, &settings().paths),
        PathRule::Generator(options) => admit_generator(picked, options, &settings().map_generator),
        // Companion programs change one entry at a time, where each change is
        // checked against the entry it was made for; the settings service
        // ignores a list here as well.
        PathRule::Launch(patch) if patch.companions.is_some() => {
            Err("companion programs are changed one entry at a time".into())
        }
        PathRule::Launch(patch) => match launch_change(patch, &settings().game) {
            Some(change) => confirm(change).await,
            None => Ok(()),
        },
        PathRule::AddCompanion(companion) => {
            if companion.has_command() {
                Err("a new companion entry starts without a program".into())
            } else {
                Ok(())
            }
        }
        PathRule::PatchCompanion(id, base, patch) => {
            match companion_patch_change(id, base, patch, &settings().game)? {
                Some(change) => confirm(change).await,
                None => Ok(()),
            }
        }
        PathRule::ReplayFile(path) => admit_local_replay(picked, path).await,
        PathRule::ReplayRead(path) => admit_replay_read(picked, path),
        PathRule::Upload(path) => match path {
            Some(path) => picked.require(path),
            None => Ok(()),
        },
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
    // New path fields must be reviewed here, not silently ignored.
    let PathPreferencesPatch {
        vault_dir,
        maps_dir,
        mods_dir,
        replays_dir,
        game_prefs_path,
        map_generator_dir,
        java_path,
        wine_prefix,
        original_game_dir,
    } = patch;
    let PathPreferences {
        vault_dir: stored_vault_dir,
        maps_dir: stored_maps_dir,
        mods_dir: stored_mods_dir,
        replays_dir: stored_replays_dir,
        game_prefs_path: stored_game_prefs_path,
        map_generator_dir: stored_map_generator_dir,
        java_path: stored_java_path,
        wine_prefix: stored_wine_prefix,
        original_game_dir: stored_original_game_dir,
    } = current;
    let fields = [
        (vault_dir, stored_vault_dir),
        (maps_dir, stored_maps_dir),
        (mods_dir, stored_mods_dir),
        (replays_dir, stored_replays_dir),
        (game_prefs_path, stored_game_prefs_path),
        (map_generator_dir, stored_map_generator_dir),
        (java_path, stored_java_path),
        (wine_prefix, stored_wine_prefix),
        (original_game_dir, stored_original_game_dir),
    ];
    for (changed, current) in fields {
        if let Some(path) = changed {
            admit_path(picked, path, current)?;
        }
    }
    Ok(())
}

/// The map generator's output and preview folders, picked or already
/// stored, and raw arguments with no folder of their own: the generator is a
/// program the client starts, and a folder named there would be written to
/// whatever the page said.
fn admit_generator(
    picked: &PickedPaths,
    options: &GeneratorOptions,
    stored: &GeneratorOptions,
) -> Result<(), String> {
    // A new option must make an explicit path-admission decision too.
    let GeneratorOptions {
        version: _,
        spawn_count: _,
        num_teams: _,
        map_size: _,
        seed: _,
        generation_type: _,
        symmetry: _,
        symmetries: _,
        style: _,
        styles: _,
        terrain_style: _,
        terrain_styles: _,
        texture_style: _,
        texture_styles: _,
        resource_style: _,
        resource_styles: _,
        prop_style: _,
        prop_styles: _,
        reclaim_density: _,
        reclaim_density_min: _,
        reclaim_density_max: _,
        resource_density: _,
        resource_density_min: _,
        resource_density_max: _,
        num_to_generate: _,
        debug: _,
        visualize: _,
        preview_path,
        output_path,
        command_line_args,
    } = options;
    admit_path(picked, output_path, &stored.output_path)?;
    admit_path(picked, preview_path, &stored.preview_path)?;
    match raw_argument_folder_flag(command_line_args) {
        Some(flag) => Err(format!(
            "{flag} is not accepted in the raw arguments: choose the output folder with its button"
        )),
        None => Ok(()),
    }
}

/// A folder flag in the generator's raw arguments, if there is one, in any
/// spelling the generator accepts (`--out-path x` or `--out-path=x`).
///
/// Read with the same splitter the launch uses
/// (`map_generator::split_command_line`), never a simpler one: that splitter
/// drops quotes anywhere in a word, so `--out-"path"` reached the generator
/// as `--out-path` while a whitespace split saw a harmless word. An `@file`
/// argument is refused too: the generator's argument parser (picocli) reads
/// further arguments from that file, where any flag could hide.
fn raw_argument_folder_flag(arguments: &str) -> Option<&'static str> {
    const FLAGS: [&str; 3] = ["--out-path", "--folder-path", "--preview-path"];
    split_command_line(arguments).iter().find_map(|word| {
        if word.starts_with('@') {
            return Some("@file");
        }
        let name = word.split('=').next().unwrap_or(word);
        FLAGS
            .into_iter()
            .find(|flag| name.eq_ignore_ascii_case(flag))
    })
}

/// The launch settings a patch would change, when it changes them to
/// something other than nothing.
#[derive(Debug, PartialEq)]
struct LaunchChange {
    wrapper: Option<String>,
    arguments: Option<Vec<String>>,
    /// The companion programs that would run something not confirmed before.
    companions: Vec<CompanionProgram>,
}

/// Compared the way `GamePreferences::normalized` stores them, so a field
/// saved again unchanged, or a stray space, asks nothing. Clearing either one
/// asks nothing either: it can only take a program out of the launch.
fn launch_change(patch: &GamePreferencesPatch, current: &GamePreferences) -> Option<LaunchChange> {
    let GamePreferencesPatch {
        additional_arguments,
        launch_wrapper,
        // Refused before this is asked: see `admit_with_confirmation`.
        companions: _,
        auto_generate_maps: _,
        confirm_downloads_before_joining: _,
        show_join_progress: _,
        show_replay_progress: _,
        cache_lifetime_days: _,
        cache_size_alert_gb: _,
        cache_rolling_branches: _,
        pipe_live_replay: _,
        keep_generated_maps: _,
        keep_generated_maps_limit: _,
        map_generator_instances: _,
        steam_presence: _,
        borderless_window: _,
        auto_update_map_and_mods: _,
        force_affinity: _,
    } = patch;
    let wrapper = launch_wrapper
        .as_deref()
        .map(str::trim)
        .filter(|wrapper| !wrapper.is_empty() && *wrapper != current.launch_wrapper.trim())
        .map(str::to_owned);
    let arguments = additional_arguments
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
    (wrapper.is_some() || arguments.is_some()).then_some(LaunchChange {
        wrapper,
        arguments,
        companions: Vec::new(),
    })
}

/// The confirmation a change to one companion entry needs.
///
/// Nothing to confirm for a patch that leaves what the entry runs alone (a
/// switch, a name, when it starts). One that touches it has to name the
/// command it was made against, the entry has to be there and still run it,
/// and only a different resulting command is asked about. The settings
/// service checks the same `base` again when it applies the patch, so the
/// entry cannot become a different one between this question and the
/// change.
fn companion_patch_change(
    id: &str,
    base: Option<&CompanionCommand>,
    patch: &CompanionProgramPatch,
    current: &GamePreferences,
) -> Result<Option<LaunchChange>, String> {
    if !patch.changes_command() {
        return Ok(None);
    }
    let entry = current
        .companions
        .iter()
        .find(|entry| entry.id == id)
        .ok_or_else(|| "there is no companion entry with that id".to_string())?;
    if !base.is_some_and(|base| entry.runs(base)) {
        return Err("the companion entry changed meanwhile; try again".into());
    }
    let merged = CompanionProgramPatch {
        id: None,
        ..patch.clone()
    }
    .apply_to(entry.clone());
    Ok((merged.command() != entry.command()).then(|| LaunchChange {
        wrapper: None,
        arguments: None,
        companions: vec![merged],
    }))
}

/// What the confirmation says. Built from the command lines alone: an
/// entry's name comes from the page, which is exactly what this must not
/// take its words from, and a program is what it runs, not what it is called.
fn confirmation_message(change: &LaunchChange) -> String {
    let mut message = String::new();
    if change.wrapper.is_some() || change.arguments.is_some() {
        message.push_str("Forged Alliance will be started ");
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
    }
    if !change.companions.is_empty() {
        message.push_str(if message.is_empty() {
            "These programs will be started alongside Forged Alliance:\n\n"
        } else {
            "These programs will be started alongside it:\n\n"
        });
        for companion in &change.companions {
            let (program, arguments, folder) = companion.command();
            message.push_str(program);
            if !arguments.is_empty() {
                message.push(' ');
                message.push_str(arguments);
            }
            if !folder.is_empty() {
                message.push_str(&format!("\n(in {folder})"));
            }
            message.push_str("\n\n");
        }
    }
    message.push_str("Allow this only if you entered it yourself in Settings.");
    message
}

/// Ask the player, natively, whether the game may be started this way.
/// English, like the tray and the exit warning: the page's language lives in
/// the page, and the page is exactly what this must not take its words from.
async fn confirm_launch_change(window: &tauri::Window, change: LaunchChange) -> Result<(), String> {
    let message = confirmation_message(&change);

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
        // What changed, not what it changed to: these are programs of the
        // player's own, and the client log is shared with bug reports.
        tracing::info!(
            launch_command = change.wrapper.is_some(),
            extra_arguments = change.arguments.as_ref().map_or(0, Vec::len),
            companion_programs = change.companions.len(),
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
    use faf_domain::state::{MapGeneratorCommand, ReplayCommand, SettingsCommand, UploadsCommand};

    async fn check(
        command: &AppCommand,
        picked: &PickedPaths,
        settings: SettingsState,
    ) -> Result<(), String> {
        admit_with_confirmation(
            command,
            picked,
            || settings,
            |_| std::future::ready(Err("unexpected launch confirmation".into())),
        )
        .await
    }

    #[test]
    fn the_path_policy_has_no_default_rest_or_unexamined_command_patterns() {
        let source = include_str!("picked_paths/policy.rs");
        let source = source
            .split_once("pub(super) fn path_rule(")
            .unwrap()
            .1
            .split_once("fn upload_path(")
            .unwrap()
            .0;
        let source: String = source
            .lines()
            .map(|line| line.split("//").next().unwrap())
            .collect::<String>()
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect();
        assert!(
            !source.contains("_=>"),
            "A catch-all would let new commands bypass admission"
        );
        assert!(
            !source.contains(".."),
            "Rest patterns would silently ignore new payload fields"
        );
        for namespace in ["AppCommand::", "TourneyCommand::"] {
            for command in source.split(namespace).skip(1) {
                let arguments = command.split_once('(').unwrap().1;
                assert!(
                    !arguments.starts_with('_'),
                    "Every nested command needs a decision: {namespace}{command}"
                );
            }
        }
    }

    #[tokio::test]
    async fn all_generator_execution_and_persistence_commands_admit_the_same_paths() {
        let options = GeneratorOptions {
            output_path: "selected-output".into(),
            preview_path: "selected-preview".into(),
            ..Default::default()
        };
        let commands: Vec<AppCommand> = vec![
            SettingsCommand::SetMapGenerator {
                preferences: Box::new(options.clone()),
            }
            .into(),
            MapGeneratorCommand::Generate {
                options: options.clone(),
            }
            .into(),
            MapGeneratorCommand::SetOptions {
                options: options.clone(),
            }
            .into(),
            MapGeneratorCommand::Preflight {
                options: options.clone(),
            }
            .into(),
            MapGeneratorCommand::SavePreset {
                name: "example".into(),
                options: options.clone(),
                request_id: 7,
            }
            .into(),
        ];
        let picked = PickedPaths::default();
        for command in &commands {
            assert_eq!(path_rule(command), PathRule::Generator(&options));
            assert!(check(command, &picked, SettingsState::default())
                .await
                .is_err());
        }
        picked.remember(&options.output_path);
        for command in &commands {
            assert!(check(command, &picked, SettingsState::default())
                .await
                .is_err());
        }
        picked.remember(&options.preview_path);
        for command in &commands {
            assert!(check(command, &picked, SettingsState::default())
                .await
                .is_ok());
        }
        let stored = SettingsState {
            map_generator: options,
            ..Default::default()
        };
        for command in &commands {
            assert!(check(command, &PickedPaths::default(), stored.clone())
                .await
                .is_ok());
        }
    }

    #[tokio::test]
    async fn saving_a_preset_cannot_smuggle_folder_flags_or_argument_files_into_settings() {
        for arguments in [
            "--out-\"path\" unpicked",
            "--folder-path=unpicked",
            "--PREVIEW-PATH unpicked",
            "@unpicked-arguments",
        ] {
            let command = MapGeneratorCommand::SavePreset {
                name: "example".into(),
                options: GeneratorOptions {
                    command_line_args: arguments.into(),
                    ..Default::default()
                },
                request_id: 0,
            }
            .into();
            assert!(
                check(&command, &PickedPaths::default(), SettingsState::default())
                    .await
                    .is_err(),
                "{arguments}"
            );
        }
    }

    #[tokio::test]
    async fn replay_deletion_checks_remote_paths_before_the_backend_can_resolve_them() {
        let picked = PickedPaths::default();
        for path in [
            r"\\unpicked.invalid\share\example.fafreplay",
            "//unpicked.invalid/share/example.fafreplay",
            r"\\?\UNC\unpicked.invalid\share\example.fafreplay",
        ] {
            let command = ReplayCommand::DeleteLocal { path: path.into() }.into();
            assert_eq!(path_rule(&command), PathRule::ReplayRead(path));
            assert_eq!(
                check(&command, &picked, SettingsState::default())
                    .await
                    .is_err(),
                cfg!(windows)
            );
            picked.remember(path);
            assert!(check(&command, &picked, SettingsState::default())
                .await
                .is_ok());
        }
        let local = ReplayCommand::DeleteLocal {
            path: "local-library/example.fafreplay".into(),
        }
        .into();
        // The backend still enforces the canonical replay-library boundary.
        assert!(check(&local, &picked, SettingsState::default())
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn upload_sources_still_require_a_pick_and_empty_requests_need_none() {
        let picked = PickedPaths::default();
        let request = faf_domain::state::UploadRequest {
            kind: faf_domain::state::UploadKind::Map,
            folder_name: "example.v0001".into(),
            display_name: "Example".into(),
            ranked: false,
            source_path: Some("selected-map".into()),
            rename_to: String::new(),
        };
        let command = UploadsCommand::Open {
            request: request.clone(),
        }
        .into();
        assert!(check(&command, &picked, SettingsState::default())
            .await
            .is_err());
        picked.remember("selected-map");
        assert!(check(&command, &picked, SettingsState::default())
            .await
            .is_ok());
        let command = UploadsCommand::Open {
            request: faf_domain::state::UploadRequest {
                source_path: None,
                ..request
            },
        }
        .into();
        assert!(
            check(&command, &PickedPaths::default(), SettingsState::default())
                .await
                .is_ok()
        );
    }

    #[tokio::test]
    async fn launch_changes_still_need_confirmation_and_declining_is_propagated() {
        let command = SettingsCommand::PatchGame {
            patch: Box::new(GamePreferencesPatch {
                launch_wrapper: Some("example-wrapper".into()),
                additional_arguments: Some(vec!["/nomovie".into()]),
                ..Default::default()
            }),
        }
        .into();
        let confirmed = std::cell::Cell::new(false);
        let result = admit_with_confirmation(
            &command,
            &PickedPaths::default(),
            SettingsState::default,
            |change| {
                confirmed.set(true);
                assert_eq!(change.wrapper.as_deref(), Some("example-wrapper"));
                assert_eq!(change.arguments, Some(vec!["/nomovie".into()]));
                std::future::ready(Err("declined".into()))
            },
        )
        .await;
        assert!(confirmed.get());
        assert_eq!(result, Err("declined".into()));
        let reset = SettingsCommand::PatchGame {
            patch: Box::new(GamePreferencesPatch {
                launch_wrapper: Some(String::new()),
                additional_arguments: Some(Vec::new()),
                ..Default::default()
            }),
        }
        .into();
        assert!(
            check(&reset, &PickedPaths::default(), SettingsState::default())
                .await
                .is_ok()
        );
    }

    #[tokio::test]
    async fn pure_validation_and_replay_metadata_do_not_trigger_filesystem_admission() {
        let commands: Vec<AppCommand> = vec![
            MapGeneratorCommand::Validate {
                options: GeneratorOptions {
                    output_path: "unpicked".into(),
                    ..Default::default()
                },
            }
            .into(),
            ReplayCommand::CancelReads {
                uid: 0,
                local_path: Some("unpicked".into()),
                request_id: None,
            }
            .into(),
            SettingsCommand::SetReplayNote {
                replay_id: 0,
                local_path: Some("unpicked".into()),
                comment: "Example".into(),
                tags: Vec::new(),
            }
            .into(),
            faf_domain::state::TrainingCommand::OpenReview {
                replay_uid: None,
                local_path: Some("unpicked".into()),
            }
            .into(),
            ReplayCommand::LoadDetails {
                uid: 7,
                local_path: None,
                request_id: None,
            }
            .into(),
            ReplayCommand::LoadAnalysis {
                uid: 7,
                local_path: None,
                request_id: None,
            }
            .into(),
        ];
        for command in commands {
            assert_eq!(path_rule(&command), PathRule::NoSelection);
            assert!(admit_with_confirmation(
                &command,
                &PickedPaths::default(),
                || panic!("metadata needs no settings"),
                |_| std::future::ready(Err("unexpected confirmation".into()))
            )
            .await
            .is_ok());
        }
    }

    #[test]
    fn generator_raw_arguments_may_not_name_a_folder() {
        for refused in [
            "--map-size 512 --out-path C:/x",
            "--folder-path=C:/x",
            "--PREVIEW-PATH C:/x",
            "\"--out-path\" C:/x",
            // Quotes inside a word vanish when the launch splits it.
            "--out-\"path\" C:/x",
            "--'folder'-path=C:/x",
            "--map-size 512 \"--preview-\"path C:/x",
            // picocli reads more arguments from the named file.
            "@C:/args.txt",
            "--map-size 512 \"@args\"",
        ] {
            assert!(raw_argument_folder_flag(refused).is_some(), "{refused}");
        }
        for allowed in [
            "",
            "--map-size 512 --spawn-count 4",
            "--seed path",
            "--seed \"a@b\"",
        ] {
            assert!(raw_argument_folder_flag(allowed).is_none(), "{allowed}");
        }
    }

    #[test]
    fn a_generator_folder_must_be_picked_or_already_stored() {
        let picked = PickedPaths::default();
        let stored = GeneratorOptions {
            output_path: "D:/maps".into(),
            ..GeneratorOptions::default()
        };
        let with = |output: &str| GeneratorOptions {
            output_path: output.into(),
            ..GeneratorOptions::default()
        };
        assert!(admit_generator(&picked, &with(""), &stored).is_ok());
        assert!(admit_generator(&picked, &with("D:/maps"), &stored).is_ok());
        assert!(admit_generator(&picked, &with("C:/Windows"), &stored).is_err());
    }

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
                arguments: None,
                companions: Vec::new(),
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
                companions: Vec::new(),
            })
        );
    }

    fn companion(id: &str, program: &str) -> CompanionProgram {
        CompanionProgram {
            id: id.into(),
            name: format!("{id} tool"),
            program: program.into(),
            arguments: "\"C:/Settings/helper.ini\"".into(),
            ..CompanionProgram::default()
        }
    }

    fn base_of(entry: &CompanionProgram) -> CompanionCommand {
        CompanionCommand {
            program: entry.program.clone(),
            arguments: entry.arguments.clone(),
            working_dir: entry.working_dir.clone(),
        }
    }

    fn stored_with(companions: Vec<CompanionProgram>) -> SettingsState {
        SettingsState {
            game: GamePreferences {
                companions,
                ..Default::default()
            },
            ..Default::default()
        }
    }

    /// Admit `command` against `settings`, answering any question with "no",
    /// and say what was asked.
    async fn admit_declining(
        command: AppCommand,
        settings: SettingsState,
    ) -> (Result<(), String>, Vec<Vec<CompanionProgram>>) {
        let asked = std::cell::RefCell::new(Vec::new());
        let result = admit_with_confirmation(
            &command,
            &PickedPaths::default(),
            || settings,
            |change| {
                asked.borrow_mut().push(change.companions);
                std::future::ready(Err("declined".into()))
            },
        )
        .await;
        (result, asked.into_inner())
    }

    fn patch_command(
        id: &str,
        base: Option<CompanionCommand>,
        patch: CompanionProgramPatch,
    ) -> AppCommand {
        SettingsCommand::PatchCompanion {
            id: id.into(),
            base,
            patch,
        }
        .into()
    }

    #[tokio::test]
    async fn a_whole_companion_list_is_refused() {
        let command: AppCommand = SettingsCommand::PatchGame {
            patch: Box::new(GamePreferencesPatch {
                companions: Some(vec![companion("helper", "C:/Tools/helper.exe")]),
                ..Default::default()
            }),
        }
        .into();
        let (result, asked) = admit_declining(command, SettingsState::default()).await;
        assert!(result.is_err());
        assert!(asked.is_empty(), "refused outright, not asked about");
    }

    #[tokio::test]
    async fn one_entry_changed_on_its_own_asks_only_when_its_command_changes() {
        let stored = companion("helper", "C:/Tools/helper.exe");
        let settings = || stored_with(vec![stored.clone()]);
        let base = Some(base_of(&stored));

        // A switch, a rename, a removal: nothing new runs, and none of them
        // needs to say what the entry ran.
        for quiet in [
            patch_command(
                "helper",
                None,
                CompanionProgramPatch {
                    enabled: Some(false),
                    ..Default::default()
                },
            ),
            patch_command(
                "helper",
                None,
                CompanionProgramPatch {
                    close_with_game: Some(true),
                    ..Default::default()
                },
            ),
            patch_command(
                "helper",
                None,
                CompanionProgramPatch {
                    name: Some("renamed".into()),
                    ..Default::default()
                },
            ),
            SettingsCommand::RemoveCompanion {
                id: "helper".into(),
            }
            .into(),
        ] {
            let (result, asked) = admit_declining(quiet, settings()).await;
            assert!(result.is_ok() && asked.is_empty());
        }
        // The command saved again unchanged asks nothing either.
        let same = patch_command(
            "helper",
            base.clone(),
            CompanionProgramPatch {
                program: Some(stored.program.clone()),
                ..Default::default()
            },
        );
        let (result, asked) = admit_declining(same, settings()).await;
        assert!(result.is_ok() && asked.is_empty());

        // New arguments on the stored entry ask, about the entry as it will
        // be stored, and declining refuses the change.
        let changed = patch_command(
            "helper",
            base,
            CompanionProgramPatch {
                arguments: Some("/c calc".into()),
                ..Default::default()
            },
        );
        let (result, asked) = admit_declining(changed, settings()).await;
        assert_eq!(result, Err("declined".into()));
        assert_eq!(asked.len(), 1);
        assert_eq!(asked[0][0].arguments, "/c calc");
        assert_eq!(asked[0][0].program, "C:/Tools/helper.exe");
    }

    #[tokio::test]
    async fn a_command_change_for_a_missing_or_different_entry_is_refused_without_asking() {
        let stored = companion("helper", "C:/Tools/helper.exe");
        let program = CompanionProgramPatch {
            program: Some("C:/Windows/System32/cmd.exe".into()),
            ..Default::default()
        };
        for refused in [
            // No entry with that id yet: one added meanwhile is not the one
            // this was meant for.
            patch_command("other", Some(CompanionCommand::default()), program.clone()),
            // No base at all.
            patch_command("helper", None, program.clone()),
            // A base the entry no longer runs.
            patch_command("helper", Some(CompanionCommand::default()), program.clone()),
            // A new entry that comes with a program.
            SettingsCommand::AddCompanion {
                companion: companion("new", "C:/Tools/obs64.exe"),
            }
            .into(),
        ] {
            let (result, asked) = admit_declining(refused, stored_with(vec![stored.clone()])).await;
            assert!(result.is_err());
            assert!(asked.is_empty());
        }
        // A new entry starts empty and needs nothing.
        let empty = CompanionProgram {
            id: "empty".into(),
            ..CompanionProgram::default()
        };
        let (result, _) = admit_declining(
            SettingsCommand::AddCompanion { companion: empty }.into(),
            SettingsState::default(),
        )
        .await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn a_test_start_names_a_stored_entry_and_needs_no_confirmation() {
        let command = SettingsCommand::TestCompanion {
            id: "helper".into(),
            expected: None,
        }
        .into();
        assert_eq!(path_rule(&command), PathRule::NoSelection);
        assert!(
            check(&command, &PickedPaths::default(), SettingsState::default())
                .await
                .is_ok()
        );
    }

    #[test]
    fn the_confirmation_shows_the_command_lines_and_not_the_names() {
        let message = confirmation_message(&LaunchChange {
            wrapper: None,
            arguments: None,
            companions: vec![CompanionProgram {
                name: "Official FAF helper".into(),
                working_dir: "C:/Scripts".into(),
                ..companion("helper", "C:/Tools/helper.exe")
            }],
        });
        assert!(message.starts_with("These programs will be started alongside Forged Alliance"));
        assert!(message.contains("C:/Tools/helper.exe \"C:/Settings/helper.ini\"\n(in C:/Scripts)"));
        assert!(!message.contains("Official FAF helper"), "{message}");

        let both = confirmation_message(&LaunchChange {
            wrapper: Some("gamemoderun".into()),
            arguments: None,
            companions: vec![companion("helper", "C:/Tools/helper.exe")],
        });
        assert!(both.starts_with("Forged Alliance will be started through:\n\ngamemoderun"));
        assert!(both.contains("These programs will be started alongside it:"));
    }
}
