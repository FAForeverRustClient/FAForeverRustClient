//! Map generator port: producing Neroxis maps by running the generator JAR.
//!
//! A *streaming* boundary like [`ChatPort`](crate::ports::ChatPort), because a
//! generation run has three slow stages (resolve version, download the JAR,
//! run it) and the UI must be able to say which one it is in. The receiver
//! yields progress until the run finishes.
//!
//! See [`faf_domain::protocol::map_generator`] for the pure half: name
//! grammar, version policy and command-line construction.

use async_trait::async_trait;
use faf_domain::state::{GeneratorOptionQuery, GeneratorOptions, GeneratorStatus};
use tokio::sync::mpsc;

/// One step of a generation run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GeneratorUpdate {
    /// A new stage, or new progress within one.
    Status(GeneratorStatus),
}

#[async_trait]
pub trait MapGeneratorPort: Send + Sync {
    /// Reproduce a specific generated map. The version comes from the name, so
    /// this needs no prior version resolution: it is the path a lobby join
    /// takes and must work even for an old generator this client has never run.
    ///
    /// The receiver closes when the run ends; the final [`GeneratorStatus`] is
    /// either `Generated` or `Failed`.
    async fn generate_named(&self, map_name: String) -> mpsc::Receiver<GeneratorUpdate>;

    /// Generate one or more fresh maps from options.
    async fn generate(&self, options: GeneratorOptions) -> mpsc::Receiver<GeneratorUpdate>;

    /// Ask the generator for one of its option lists (`--styles`, …).
    /// Downloads the specified (or newest supported) release first if necessary.
    async fn query_options(
        &self,
        query: GeneratorOptionQuery,
        version: Option<String>,
    ) -> Result<Vec<String>, String>;

    /// Resolve options through the generator's `--parse`, yielding the map name
    /// they would produce, or the generator's own complaint about them.
    ///
    /// No map is written. This is the authoritative validation: it runs the
    /// rules of the installed release rather than a copy of them, so it does
    /// not drift when the generator adds a constraint.
    async fn preflight(&self, options: GeneratorOptions) -> Result<String, String>;

    /// The generator's `--help` text, for users writing raw arguments.
    async fn help(&self, version: Option<String>) -> Result<String, String>;

    /// Stop the run in flight, if any.
    ///
    /// Synchronous and infallible: it only raises a flag that the running task
    /// observes, so it can be called from a command handler without awaiting
    /// the process it is stopping.
    fn cancel(&self);

    /// The newest generator release this client supports, as `x.y.z`.
    async fn latest_version(&self) -> Result<String, String>;

    /// All available generator releases from GitHub supported by this client.
    async fn available_versions(&self) -> Result<Vec<String>, String>;

    /// Whether a generated map of this name is already on disk.
    ///
    /// Cheap and synchronous so the join path can skip a whole generation run
    /// without awaiting anything: the Java client's `generateIfNotInstalled`
    /// makes the same check.
    fn is_installed(&self, map_name: &str) -> bool;

    /// Delete generated maps not named in `protected_maps`, returning how many went.
    ///
    /// Safe because generated maps are reproducible from their name alone. The
    /// Java client does this on shutdown; here it is user-triggered.
    async fn clean_up(&self, protected_maps: &[String]) -> Result<usize, String>;

    /// Read preview PNGs from disk for generated maps and return as base64 data URLs.
    async fn map_previews(&self, map_names: &[String])
        -> std::collections::HashMap<String, String>;
}
