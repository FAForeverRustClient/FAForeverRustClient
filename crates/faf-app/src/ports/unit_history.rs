//! Unit history boundary: unit blueprints as each game release had them.

use std::collections::BTreeSet;
use std::path::PathBuf;

use async_trait::async_trait;
use faf_domain::protocol::unit_history::{BaseGameBlueprint, ReleaseBlueprint, UnitSummary};

#[async_trait]
pub trait UnitHistoryPort: Send + Sync {
    /// Every unit a player can build, read from the FAF install at
    /// `install_dir` (the folder holding `gamedata/units.nx2`).
    async fn list_units(&self, install_dir: Option<PathBuf>) -> Result<Vec<UnitSummary>, String>;

    /// The FA repository's release tags. A release without one has no
    /// blueprints to read.
    async fn release_tags(&self) -> Result<BTreeSet<String>, String>;

    /// The blueprint at one tag, trying `paths` in order. Answered from disk
    /// once it has been read, including a file that is not there: a tag never
    /// changes.
    async fn release_blueprint(&self, tag: &str, paths: &[String]) -> ReleaseBlueprint;

    /// The base game's copy of the unit, from the original game's `units.scd`.
    async fn base_game(&self, unit: &UnitSummary) -> BaseGameBlueprint;

    /// The projectiles that split into fragments, by lower-case blueprint
    /// path, from the installed game and the base game.
    async fn fragmenting_projectiles(&self, install_dir: Option<PathBuf>) -> BTreeSet<String>;
}
