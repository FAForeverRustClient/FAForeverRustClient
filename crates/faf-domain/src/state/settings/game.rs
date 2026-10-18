//! Running the game: where its files and the player's content are, how it
//! is launched, and what the client keeps on disk for it.

use super::*;

/// Where the client looks for the game's files and the user's content.
///
/// Every field is a complete path and an empty one means "work it out": the
/// discovery the client did before any of this was configurable, and the
/// matching `FAF_*` environment variable still overrides that discovery for a
/// field nobody has set here. A value set here wins over both, because it is
/// the only one of the three a player chose deliberately.
///
/// `vault_dir` is the root the Java client keeps `maps/` and `mods/` under;
/// the two specific directories override it when they are set, so pointing the
/// vault somewhere new is one edit rather than three.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", default)]
pub struct PathPreferences {
    pub vault_dir: String,
    pub maps_dir: String,
    pub mods_dir: String,
    pub replays_dir: String,
    pub game_prefs_path: String,
    pub map_generator_dir: String,
    /// The JVM the map generator and the Java ICE adapter run on.
    pub java_path: String,
    /// The Wine prefix Forged Alliance runs in, on the platforms where it has
    /// to run in one.
    ///
    /// Ignored on Windows. Everywhere else the game is a Windows executable
    /// under Wine or Proton, and the prefix is the answer to a question the
    /// client cannot otherwise ask: FA writes `game.prefs` to
    /// `%LOCALAPPDATA%`, which lives *inside* the prefix, so without this the
    /// client reads and writes a `game.prefs` at the Linux equivalent of that
    /// path, which is a file the game has never seen. Enabling a mod then does
    /// nothing, silently.
    ///
    /// Empty falls back to `$WINEPREFIX` and then to `~/.wine`, which is where
    /// a default `winecfg` prefix is.
    pub wine_prefix: String,
    /// The original Supreme Commander: Forged Alliance install, from Steam or
    /// a disc: the folder holding `gamedata/lua.scd`. The Java client's
    /// `forgedAlliance.installationPath`.
    ///
    /// Nothing is launched from it and nothing is written into it. It is
    /// where a FAF install gets what is not FAF's to ship: the engine's
    /// runtime libraries (`BugSplat.dll` and the rest, copied into FAF's
    /// `bin`) and the base game's movies, sounds and fonts.
    ///
    /// Remembered when the original game's executable is picked as an
    /// install, which is the only executable a new player has to point at
    /// (#474). Unlike the fields above it is checked before use, since an
    /// install can be moved or uninstalled after it was picked: empty, or no
    /// longer an install, falls back to what the other FAF clients have
    /// configured and to the usual Steam and retail locations. And unlike
    /// them it does not outrank its environment variable:
    /// `FAF_GAME_INSTALL_DIR` is a developer's switch that has always been
    /// taken as given, ahead of everything else.
    pub original_game_dir: String,
}

impl PathPreferences {
    pub(super) fn normalized(mut self) -> Self {
        // Trimmed, because a path pasted from a file manager routinely arrives
        // with a trailing space and would then resolve to nothing.
        for field in [
            &mut self.vault_dir,
            &mut self.maps_dir,
            &mut self.mods_dir,
            &mut self.replays_dir,
            &mut self.game_prefs_path,
            &mut self.map_generator_dir,
            &mut self.java_path,
            &mut self.wine_prefix,
            &mut self.original_game_dir,
        ] {
            *field = field.trim().to_owned();
        }
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GamePreferences {
    /// Additional literal arguments prepended to both live-game and replay
    /// launches. Each entry is one process argument; no shell is involved.
    #[serde(default)]
    pub additional_arguments: Vec<String>,
    /// A command that runs Forged Alliance instead of the client running it
    /// directly, with the executable and its arguments appended.
    ///
    /// This is what makes the client usable on Linux: FA is a Windows binary
    /// and FAF ships no native build of it, so the launch has to go through
    /// Wine or Proton. `wine` is the whole answer for anybody with a working
    /// prefix; a Proton launcher or a script wanting `flatpak run` needs more
    /// words, so this is a command line rather than a path.
    ///
    /// It is split into arguments here, not handed to a shell: quotes group
    /// words that belong together and nothing else is interpreted, so a `;` or
    /// a `$HOME` in this field is an argument, not an instruction. Empty, the
    /// default, launches the executable directly, which is what Windows wants.
    #[serde(default)]
    pub launch_wrapper: String,
    /// Automatically generate missing Neroxis maps when joining a lobby.
    #[serde(default = "default_true")]
    pub auto_generate_maps: bool,
    /// Ask before a join or a replay downloads simulation mods you do not have.
    ///
    /// On by default, which is a deliberate change of behaviour: the client
    /// used to fetch whatever a lobby required the moment you double-clicked
    /// it, so joining the wrong game could leave twenty mods on disk. The
    /// request was to be in the driver's seat, and the dialog carries its own
    /// "do not ask again", which is what turns this off. It is a prompt about
    /// *new* downloads only: a lobby whose mods you already have never raises
    /// it, whatever this is set to.
    #[serde(default = "default_true")]
    pub confirm_downloads_before_joining: bool,
    /// Show the dialog that narrates a join, from the file check to the game
    /// window appearing.
    ///
    /// Off, the status bar narrates the same alone. The dialog carries its
    /// own "do not show again", which is what turns this off; the settings
    /// row is how it comes back.
    #[serde(default = "default_true")]
    pub show_join_progress: bool,
    /// The same for starting a replay: the file coming down, the engine build
    /// being checked, Forged Alliance opening.
    #[serde(default = "default_true")]
    pub show_replay_progress: bool,
    /// Maximum lifetime in days for cached game data and replay binaries.
    /// `None` or `0` means cache retention is indefinite / automatic purging is disabled.
    #[serde(default = "default_cache_lifetime_days")]
    pub cache_lifetime_days: Option<u32>,
    /// Size threshold in gigabytes to warn the user about game cache usage.
    /// `None` or `0` means alert is disabled.
    #[serde(default = "default_cache_size_alert_gb")]
    pub cache_size_alert_gb: Option<u32>,
    /// Whether to cache rolling development branches (FAF Develop and Beta).
    /// Defaults to `false` so the client always checks for fresh commits from the server.
    #[serde(default)]
    pub cache_rolling_branches: bool,
    /// Stream live replays through a Windows named pipe instead of the local
    /// TCP proxy (the Python client's `game/pipe_live_replay`, labelled
    /// "Live Replays Workaround" there).
    ///
    /// Off by default because the pipe has a real cost: FA reads it on its
    /// main thread, so catching up to a live game's current tick freezes the
    /// whole window rather than only stalling the simulation, and the replay
    /// ends abruptly with no army selection or post-game statistics. It exists
    /// because the TCP path hits an engine bug on oversized `ScenarioInfo`
    /// ("Premature EOF" / "unable to load replay from gpgnet"), and the pipe
    /// does not. See `infra::replay` for the full history.
    #[serde(default)]
    pub pipe_live_replay: bool,
    /// Keep every map the generator produces, so clearing generated maps
    /// spares them.
    ///
    /// This used to be a checkbox inside the Generate map dialog, decided per
    /// run on the theory that "generate one to keep, then three throwaways" is
    /// how people work. It is not: a run is started to look at maps, and
    /// whether they are worth keeping is known afterwards, by which point the
    /// dialog is closed. One switch that holds for every run is the decision
    /// people were actually making.
    ///
    /// Off by default, which is what the per-run checkbox defaulted to: a
    /// generated map is disposable until somebody says otherwise. Names are
    /// still recorded run by run into [`SettingsState::kept_generated_maps`],
    /// so turning the switch off later does not retroactively condemn what was
    /// kept while it was on.
    #[serde(default)]
    pub keep_generated_maps: bool,
    /// How many generated maps the keep list may hold, or `0` for no limit.
    ///
    /// The switch above answers "keep them"; this answers "how many". Without
    /// it the two choices are keep nothing and keep everything, and the thread
    /// that asked for this had watched the second one fill a system drive: a
    /// generated map is kept because it was good, and the hundred before it
    /// are still on the disk saying nothing.
    ///
    /// Oldest first when the cap is reached, which is what makes this a cache
    /// rather than a quota that refuses new maps once it is full.
    #[serde(default)]
    pub keep_generated_maps_limit: u32,
    /// How many map generators may run at the same time, or `0` to let the
    /// client decide from the computer's cores and free memory.
    ///
    /// Only a run of several maps that each need their own generator uses
    /// this: one where several styles, symmetries or a density range were
    /// selected, so every map gets its own pick. A single map, and a batch the
    /// generator makes in one go, stay one process either way.
    ///
    /// A setting rather than a fixed number because the right one is the
    /// computer's: one generator keeps about one and a half cores busy and
    /// needs up to two and a half gigabytes for a 20 km map, so two at once
    /// were a third faster on a four-core machine with 12 GB and four at once
    /// ran out of memory and took four times as long.
    #[serde(default)]
    pub map_generator_instances: u32,
    /// Show Forged Alliance as being played on Steam while a game runs, and
    /// only then (issue 364).
    ///
    /// The Java client does this from the moment it opens until it closes,
    /// so Steam records the client's hours rather than the game's. Here it
    /// covers the game process and nothing else.
    ///
    /// Off by default, and a switch rather than a given: it tells Steam, and
    /// through it your friends list, when you play. It also needs Valve's own
    /// library, Steam running, and Forged Alliance in the signed-in account's
    /// library; without any of those it does nothing. Windows and Linux.
    #[serde(default)]
    pub steam_presence: bool,
    /// Take the frame off Forged Alliance's window and stretch it over its
    /// monitor, for as long as the game runs (#445): the "borderless
    /// windowed" mode players used to get from a third-party script. Needs the
    /// game itself set to windowed. Off by default. Windows only.
    #[serde(default)]
    pub borderless_window: bool,
}

/// The most generated maps a keep list may hold. Far past what anybody sets,
/// and there so a hand-edited settings file cannot make the list unbounded by
/// a different route than `0` does deliberately.
pub const MAX_KEPT_GENERATED_MAPS: u32 = 500;

/// The most map generators a player may ask to run at once. Above any core
/// count this client is likely to meet, and there so a hand-edited settings
/// file cannot ask for a thousand JVMs.
pub const MAX_MAP_GENERATOR_INSTANCES: u32 = 16;

fn default_cache_lifetime_days() -> Option<u32> {
    Some(30)
}

fn default_cache_size_alert_gb() -> Option<u32> {
    Some(10)
}

impl Default for GamePreferences {
    fn default() -> Self {
        Self {
            additional_arguments: Vec::new(),
            launch_wrapper: String::new(),
            auto_generate_maps: true,
            confirm_downloads_before_joining: true,
            show_join_progress: true,
            show_replay_progress: true,
            cache_lifetime_days: default_cache_lifetime_days(),
            cache_size_alert_gb: default_cache_size_alert_gb(),
            cache_rolling_branches: false,
            pipe_live_replay: false,
            keep_generated_maps: false,
            keep_generated_maps_limit: 0,
            map_generator_instances: 0,
            steam_presence: false,
            borderless_window: false,
        }
    }
}

impl GamePreferences {
    pub(super) fn normalized(mut self) -> Self {
        self.additional_arguments = self
            .additional_arguments
            .into_iter()
            .map(|argument| argument.trim().to_owned())
            .filter(|argument| !argument.is_empty())
            .take(32)
            .collect();
        self.launch_wrapper = self.launch_wrapper.trim().to_owned();
        self.keep_generated_maps_limit =
            self.keep_generated_maps_limit.min(MAX_KEPT_GENERATED_MAPS);
        self.map_generator_instances = self
            .map_generator_instances
            .min(MAX_MAP_GENERATOR_INSTANCES);
        self
    }
}

preference_patch! {
    /// A change to [`PathPreferences`].
    PathPreferencesPatch for PathPreferences {
        vault_dir: String,
        maps_dir: String,
        mods_dir: String,
        replays_dir: String,
        game_prefs_path: String,
        map_generator_dir: String,
        java_path: String,
        wine_prefix: String,
        original_game_dir: String,
    }
}

preference_patch! {
    /// A change to [`GamePreferences`]. The two cache limits are optional
    /// preferences, so `null` for either is "no limit", not "unchanged".
    GamePreferencesPatch for GamePreferences {
        additional_arguments: Vec<String>,
        launch_wrapper: String,
        auto_generate_maps: bool,
        confirm_downloads_before_joining: bool,
        show_join_progress: bool,
        show_replay_progress: bool,
        cache_lifetime_days: Option<u32>,
        cache_size_alert_gb: Option<u32>,
        cache_rolling_branches: bool,
        pipe_live_replay: bool,
        keep_generated_maps: bool,
        keep_generated_maps_limit: u32,
        map_generator_instances: u32,
        steam_presence: bool,
        borderless_window: bool,
    }
}
