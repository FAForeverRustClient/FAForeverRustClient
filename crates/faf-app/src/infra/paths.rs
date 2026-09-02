//! The configured directory overrides, and the resolution every path helper
//! in this crate runs through.
//!
//! Process-global on purpose. The helpers that need this - `maps::maps_dir`,
//! `mods::mods_dir`, `faf_content::vault_dir`, `replay::local_replays_dir` and
//! their neighbours - are free functions called from a dozen places, several
//! of them synchronous and none of them holding a reference to settings.
//! Threading a configuration object through all of them would be a much larger
//! change than the feature warrants, and the value is written twice in a
//! session at most.

use std::path::PathBuf;
use std::sync::{OnceLock, RwLock};

use faf_domain::state::{PathPreferences, ResolvedPaths};

use crate::ports::paths::PathsPort;

fn overrides() -> &'static RwLock<PathPreferences> {
    static OVERRIDES: OnceLock<RwLock<PathPreferences>> = OnceLock::new();
    OVERRIDES.get_or_init(|| RwLock::new(PathPreferences::default()))
}

/// Read one configured path.
///
/// A poisoned lock means a writer panicked while holding it, which would only
/// happen if cloning a `String` panicked. Falling back to "nothing configured"
/// keeps every lookup working instead of taking the client down with it.
fn configured(select: impl Fn(&PathPreferences) -> &String) -> Option<PathBuf> {
    let guard = overrides().read().ok()?;
    let value = select(&guard).trim();
    (!value.is_empty()).then(|| PathBuf::from(value))
}

pub(crate) fn vault_dir() -> Option<PathBuf> {
    configured(|paths| &paths.vault_dir)
}

pub(crate) fn maps_dir() -> Option<PathBuf> {
    configured(|paths| &paths.maps_dir)
}

pub(crate) fn mods_dir() -> Option<PathBuf> {
    configured(|paths| &paths.mods_dir)
}

pub(crate) fn replays_dir() -> Option<PathBuf> {
    configured(|paths| &paths.replays_dir)
}

pub(crate) fn game_prefs_path() -> Option<PathBuf> {
    configured(|paths| &paths.game_prefs_path)
}

pub(crate) fn map_generator_dir() -> Option<PathBuf> {
    configured(|paths| &paths.map_generator_dir)
}

pub(crate) fn java_path() -> Option<PathBuf> {
    configured(|paths| &paths.java_path)
}

/// The adapter behind [`PathsPort`]. Stateless: the state is the global above,
/// which is what every path helper reads.
#[derive(Debug, Clone, Copy, Default)]
pub struct ConfiguredPaths;

impl PathsPort for ConfiguredPaths {
    fn set_overrides(&self, preferences: PathPreferences) {
        if let Ok(mut guard) = overrides().write() {
            *guard = preferences;
        }
    }

    /// Ask each helper what it would use right now, which is the only honest
    /// answer: the fallback chains live in those helpers and differ per
    /// location.
    fn resolved(&self) -> ResolvedPaths {
        let display = |path: PathBuf| path.display().to_string();
        ResolvedPaths {
            vault_dir: display(crate::infra::faf_content::vault_dir()),
            maps_dir: display(crate::infra::maps::maps_dir()),
            mods_dir: display(crate::infra::mods::mods_dir()),
            replays_dir: display(crate::infra::replay::local_replays_dir()),
            game_prefs_path: display(crate::infra::mods::game_prefs_path()),
            map_generator_dir: display(crate::infra::map_generator::generator_dir()),
            java_path: crate::infra::java_runtime::preferred_java_path(),
        }
    }
}

/// Inert path port for tests and the offline shell.
///
/// Deliberately records nothing into the global: the free functions then fall
/// through to the environment and discovery, which is what every test that
/// sets a `FAF_*` variable expects.
#[derive(Debug, Clone, Copy, Default)]
pub struct FakePaths;

impl PathsPort for FakePaths {
    fn set_overrides(&self, _preferences: PathPreferences) {}

    fn resolved(&self) -> ResolvedPaths {
        ResolvedPaths::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unset_field_reads_as_no_override() {
        ConfiguredPaths.set_overrides(PathPreferences::default());
        assert_eq!(maps_dir(), None);
    }

    #[test]
    fn a_configured_field_wins_and_is_trimmed() {
        // A path pasted out of a file manager routinely arrives with a
        // trailing space; resolving that literally would find nothing.
        ConfiguredPaths.set_overrides(PathPreferences {
            maps_dir: "  C:/faf/maps  ".into(),
            ..PathPreferences::default()
        });
        assert_eq!(maps_dir(), Some(PathBuf::from("C:/faf/maps")));
        assert_eq!(mods_dir(), None);
        ConfiguredPaths.set_overrides(PathPreferences::default());
    }
}
