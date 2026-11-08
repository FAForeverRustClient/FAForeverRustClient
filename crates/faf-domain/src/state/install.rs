//! Install slice: whether the client can actually find Forged Alliance.
//!
//! Separate from [`settings`](crate::state::settings) on purpose: the settings
//! slice is a *configuration record* that round-trips to `settings.json`, while
//! this is a *derived runtime fact* re-checked on every startup and on every
//! path change. Persisting "the install was there last time" would be stale the
//! moment the user moved or uninstalled the game: which is precisely the case
//! the missing-install banner exists to catch.
//!
//! Both reference clients gate the same way: the Python client's
//! `validate_game_path` refuses to proceed without a real install, and the Java
//! client's first-run wizard asks for one before anything can be launched.

use serde::{Deserialize, Serialize};
use specta::Type;

/// How many companion results the slice keeps: one per entry the list can
/// hold, and as many again for entries removed since their last start.
pub const MAX_COMPANION_RUNS: usize = 32;

/// What the last attempt to start one companion program came to.
///
/// Runtime state like the rest of this slice: a start reported before the
/// client was restarted says nothing about the program now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CompanionRun {
    /// The entry's id in Settings, Game.
    pub id: String,
    /// The entry's name when it was started, for a report that outlives it.
    pub name: String,
    pub outcome: CompanionOutcome,
    /// Unix seconds.
    pub at: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    content = "payload",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CompanionOutcome {
    /// Started, as this process.
    Started { pid: u32 },
    /// Not started: the process the client started for it last time is
    /// still running.
    AlreadyRunning { pid: u32 },
    /// Not started: a process with the file name the entry names is running.
    SkippedRunningImage { image: String },
    /// Could not be started, and why. The game started anyway.
    Failed { reason: String },
    /// Closed because the game it came with exited.
    Closed { pid: u32 },
}

impl CompanionOutcome {
    pub fn is_failure(&self) -> bool {
        matches!(self, Self::Failed { .. })
    }
}

/// Where each configurable location currently resolves to.
///
/// Reported by the backend rather than worked out in the interface: the
/// fallbacks live in the adapters - a Java client's vault, FAF's Documents
/// convention, a platform data directory - and the settings tab would
/// otherwise have nothing to show for a path nobody has set, which is most of
/// them for most people.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedPaths {
    pub vault_dir: String,
    pub maps_dir: String,
    pub mods_dir: String,
    pub replays_dir: String,
    pub game_prefs_path: String,
    pub map_generator_dir: String,
    pub java_path: String,
    /// The Wine prefix a launch would use, or empty on Windows, where the game
    /// runs without one.
    pub wine_prefix: String,
    /// The original Supreme Commander: Forged Alliance the client found, the
    /// folder holding `gamedata/lua.scd`, or empty when it found none.
    ///
    /// Unlike the locations above this one has no fallback, and empty is the
    /// state to warn about: FAF takes the game's movies, sounds, fonts and
    /// libraries from it, and a game started without it is broken. The
    /// missing-install banner says so before the first game, and on Windows
    /// a launch that finds no original game either is refused.
    pub original_game_dir: String,
}

impl ResolvedPaths {
    /// Whether the original game was found. See [`Self::original_game_dir`].
    pub fn original_game_found(&self) -> bool {
        !self.original_game_dir.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct InstallState {
    /// The configured live-game executable exists on disk.
    pub game_ready: bool,
    /// The configured replay-playback executable exists on disk.
    pub replay_ready: bool,
    /// The live executable is not there yet, but the path names an install this
    /// client owns, so the updater downloads the engine into it before the
    /// first game.
    ///
    /// A fresh machine is in exactly this state, and it needs its own name: it
    /// stats identically to a broken setting, and telling somebody their
    /// install is missing sends them looking for a folder that has never
    /// existed on that computer. The reference clients reach the same place by
    /// downloading it on first run.
    pub game_pending: bool,
    /// The same for replay playback.
    pub replay_pending: bool,
    /// Whether the paths have been checked at all yet.
    ///
    /// Without this the UI cannot tell "no install" from "not looked yet", and
    /// would flash a missing-install warning during the startup window before
    /// the first check completes.
    pub checked: bool,
    /// Where the configurable locations point right now. See [`ResolvedPaths`].
    ///
    /// No `#[serde(default)]`: this slice is runtime state, never read back
    /// from a file written by an older build, and the attribute would only
    /// make the field optional in the generated TypeScript for nothing.
    pub resolved: ResolvedPaths,
    /// The last start of each companion program, by entry, oldest first.
    pub companions: Vec<CompanionRun>,
}

impl InstallState {
    /// Nothing can be launched: neither a live game nor a replay.
    pub fn nothing_ready(&self) -> bool {
        !self.game_ready && !self.replay_ready
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    content = "payload",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum InstallEvent {
    /// The configured paths were stat'd. Emitted at startup and after every
    /// change to either path.
    Checked {
        game_ready: bool,
        replay_ready: bool,
        /// See [`InstallState::game_pending`].
        game_pending: bool,
        replay_pending: bool,
        resolved: ResolvedPaths,
    },
    /// A companion program was started, skipped, closed or failed to start.
    CompanionReported { run: CompanionRun },
}

pub fn reduce(state: &mut InstallState, event: &InstallEvent) {
    match event {
        InstallEvent::Checked {
            game_ready,
            replay_ready,
            game_pending,
            replay_pending,
            resolved,
        } => {
            state.game_ready = *game_ready;
            state.replay_ready = *replay_ready;
            state.game_pending = *game_pending;
            state.replay_pending = *replay_pending;
            state.resolved = resolved.clone();
            state.checked = true;
        }
        InstallEvent::CompanionReported { run } => {
            // Replaces the entry's previous report and moves it to the end,
            // so the oldest are the ones that go once the list is full.
            state.companions.retain(|existing| existing.id != run.id);
            state.companions.push(run.clone());
            let excess = state.companions.len().saturating_sub(MAX_COMPANION_RUNS);
            state.companions.drain(..excess);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_unchecked_so_the_ui_stays_quiet_at_startup() {
        let s = InstallState::default();
        assert!(!s.checked);
        assert!(s.nothing_ready());
    }

    #[test]
    fn checked_records_both_paths_and_flips_checked() {
        let mut s = InstallState::default();
        reduce(
            &mut s,
            &InstallEvent::Checked {
                game_ready: true,
                replay_ready: false,
                game_pending: false,
                replay_pending: true,
                resolved: ResolvedPaths::default(),
            },
        );
        assert!(s.checked);
        assert!(s.game_ready);
        assert!(!s.replay_ready);
        assert!(s.replay_pending, "a replay install the updater will create");
        assert!(!s.nothing_ready());
    }

    #[test]
    fn a_later_check_can_report_an_install_that_went_away() {
        let mut s = InstallState {
            game_ready: true,
            replay_ready: true,
            game_pending: false,
            replay_pending: false,
            checked: true,
            resolved: ResolvedPaths {
                maps_dir: "D:/old/maps".into(),
                original_game_dir: "D:/Games/Supreme Commander Forged Alliance".into(),
                ..ResolvedPaths::default()
            },
            companions: Vec::new(),
        };
        assert!(s.resolved.original_game_found());
        reduce(
            &mut s,
            &InstallEvent::Checked {
                game_ready: false,
                replay_ready: false,
                game_pending: false,
                replay_pending: false,
                resolved: ResolvedPaths {
                    maps_dir: "D:/new/maps".into(),
                    ..ResolvedPaths::default()
                },
            },
        );
        assert!(s.checked, "still checked: we looked and found nothing");
        assert!(s.nothing_ready());
        // The check reports where things resolve now, not where they used to.
        assert_eq!(s.resolved.maps_dir, "D:/new/maps");
        // Including an original game that has gone: nothing to fall back on.
        assert!(!s.resolved.original_game_found());
    }

    #[test]
    fn a_companion_report_replaces_the_entry_before_and_the_list_stays_bounded() {
        let run = |id: &str, outcome: CompanionOutcome| CompanionRun {
            id: id.into(),
            name: id.into(),
            outcome,
            at: 1,
        };
        let mut s = InstallState::default();
        let report = |s: &mut InstallState, run: CompanionRun| {
            reduce(s, &InstallEvent::CompanionReported { run })
        };
        report(&mut s, run("a", CompanionOutcome::Started { pid: 7 }));
        report(
            &mut s,
            run(
                "b",
                CompanionOutcome::Failed {
                    reason: "gone".into(),
                },
            ),
        );
        report(&mut s, run("a", CompanionOutcome::Closed { pid: 7 }));
        let ids: Vec<&str> = s.companions.iter().map(|run| run.id.as_str()).collect();
        assert_eq!(ids, ["b", "a"]);
        assert_eq!(s.companions[1].outcome, CompanionOutcome::Closed { pid: 7 });
        assert!(s.companions[0].outcome.is_failure());

        for n in 0..MAX_COMPANION_RUNS + 3 {
            report(
                &mut s,
                run(&format!("c{n}"), CompanionOutcome::Started { pid: 1 }),
            );
        }
        assert_eq!(s.companions.len(), MAX_COMPANION_RUNS);
        assert_eq!(s.companions[0].id, "c3", "the oldest reports go first");
    }
}
