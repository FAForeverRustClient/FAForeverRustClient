//! Getting the replay install ready for one replay: the engine build it needs
//! and its map.
//!
//! Shared by file playback and live spectating, which prepare the same
//! install in the same two steps and differ only in which build they ask for:
//! a file names its exact build, a live stream is always the current one. Kept
//! apart from both so the preparation can be built and tested without a
//! process to launch or a vault to download from.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::infra::{cache_dir, game_updater};
use crate::ports::{MapGeneratorPort, PreparationSink, PreparationStep};

use super::ReplayConfig;

/// The replay install and what may be done to it before a launch.
pub(super) struct ReplayPreparation {
    http: reqwest::Client,
    /// FAF Data API base, which serves the featured-mod file lists.
    api_base: String,
    /// Public content CDN that vault maps are staged from.
    content_base: String,
    /// The FA executable's filename within the `bin` group, e.g.
    /// `ForgedAlliance.exe`: the file the version updater hex-patches.
    exe_name: String,
    /// The replay install every preparation step targets, behind a lock
    /// because Settings can repoint it at runtime
    /// (`ReplayPlaybackPort::set_install_dir`). Seeded from the environment so
    /// a launch before the first settings sync still works, then overwritten
    /// by the configured path.
    install_dir: Mutex<Option<PathBuf>>,
    /// Where preparation steps are reported while a launch is being prepared.
    /// See `ReplayPlaybackPort::set_preparation_progress`.
    sink: Mutex<Option<PreparationSink>>,
    /// Rebuilds a replay's map when it was made by the Neroxis generator.
    /// Generated maps exist in no vault, so staging cannot find them and the
    /// only way to put one on disk is to run the generator again.
    map_generator: Arc<dyn MapGeneratorPort>,
    /// The `auto_generate_maps` setting, pushed in by the settings service.
    /// Starts enabled to match the setting's own default.
    auto_generate_maps: AtomicBool,
}

impl ReplayPreparation {
    pub(super) fn new(config: &ReplayConfig, map_generator: Arc<dyn MapGeneratorPort>) -> Self {
        Self {
            http: crate::infra::http::shared_http_client(),
            api_base: config.api_base.clone(),
            content_base: config.content_base.clone(),
            exe_name: config.exe_name.clone(),
            install_dir: Mutex::new(config.replay_target_dir.clone()),
            sink: Mutex::new(None),
            map_generator,
            auto_generate_maps: AtomicBool::new(true),
        }
    }

    /// Where the engine update and map staging go for the next launch.
    pub(super) fn install_dir(&self) -> Option<PathBuf> {
        self.install_dir.lock().unwrap().clone()
    }

    pub(super) fn set_install_dir(&self, dir: Option<PathBuf>) {
        // An explicit `FAF_REPLAY_UPDATE_DIR` is a deliberate override and
        // outranks the configured install, matching how it outranks
        // `FAF_REPLAY_GAME_PATH` when the directory is first derived.
        if std::env::var("FAF_REPLAY_UPDATE_DIR").is_ok_and(|value| !value.is_empty()) {
            return;
        }
        *self.install_dir.lock().unwrap() = dir;
    }

    pub(super) fn set_sink(&self, sink: Option<PreparationSink>) {
        *self.sink.lock().unwrap() = sink;
    }

    pub(super) fn set_auto_generate_maps(&self, enabled: bool) {
        self.auto_generate_maps.store(enabled, Ordering::Relaxed);
    }

    /// Pass one preparation step on to whoever is listening. See
    /// `ReplayPlaybackPort::set_preparation_progress`.
    pub(super) fn report(&self, step: PreparationStep) {
        let sink = self.sink.lock().unwrap().clone();
        if let Some(sink) = sink {
            sink(step);
        }
    }

    /// Stage the exact engine build a replay file names into `target_dir`,
    /// reporting each step. `Ok(Some(warning))` when the build could only be
    /// approximated (a rolling development build that was not cached).
    pub(super) async fn stage_replay_version(
        &self,
        token: &str,
        target_dir: &Path,
        version: &game_updater::ReplayVersionInfo,
    ) -> Result<Option<String>, String> {
        game_updater::resolve_and_stage_replay_version(
            &self.http,
            token,
            &self.api_base,
            &cache_dir()?.join("game_files"),
            target_dir,
            version,
            &self.exe_name,
            &|step| self.report(step),
        )
        .await
    }

    /// Bring `target_dir` up to the current build of `mod_name`, for a stream
    /// that carries no version of its own. Not reported: live spectating has
    /// never shown preparation steps.
    pub(super) async fn update_to_latest(
        &self,
        token: &str,
        target_dir: &Path,
        mod_name: &str,
    ) -> Result<i32, String> {
        game_updater::ensure_latest_game_version(
            &self.http,
            token,
            &self.api_base,
            &cache_dir()?.join("game_files"),
            target_dir,
            mod_name,
            &self.exe_name,
            false,
            &|_| {},
            // A replay's preparation is called off by dropping it, so it is
            // handed no token of its own.
            &tokio_util::sync::CancellationToken::new(),
        )
        .await
    }

    /// Put `map_folder` on disk before FA is asked to load it.
    ///
    /// Two different mechanisms behind one call, because the replay does not
    /// say which kind of map it was played on:
    ///
    /// - A generated map exists in no vault and can only be rebuilt by running
    ///   the Neroxis generator again, exactly as the live launcher's
    ///   `ensure_generated_map` does for a game the server has already seated
    ///   the player in.
    /// - Anything else is staged from the vault CDN by
    ///   [`game_updater::ensure_map_available`], which is a no-op for the
    ///   base-game maps that ship inside the install.
    ///
    /// `Err` is reserved for a generated map that could not be produced. That
    /// is not the same posture as vault staging, whose failure is only a
    /// warning: a missing vault map may still be a base map FA can find on its
    /// own, whereas a generated map that is not on disk is a guaranteed
    /// `aborting session` a few seconds later, with nothing in the UI to
    /// explain it. Saying so up front beats launching into that.
    pub(super) async fn ensure_replay_map(
        &self,
        target_dir: &Path,
        map_folder: &str,
    ) -> Result<Option<String>, String> {
        use faf_domain::protocol::map_generator::is_generated_map;

        if is_generated_map(map_folder) {
            self.ensure_generated_map(map_folder).await?;
            return Ok(None);
        }

        if let Err(e) = game_updater::ensure_map_available(
            &self.http,
            &self.content_base,
            target_dir,
            map_folder,
        )
        .await
        {
            return Ok(Some(format!("could not stage map {map_folder}: {e}")));
        }
        Ok(None)
    }

    /// Rebuild a generated map, unless it is already installed.
    ///
    /// Mirrors `services::launcher::ensure_generated_map`, minus the progress
    /// events: this side of the boundary has no event sink. The run is logged
    /// instead, since it routinely takes tens of seconds and a silent wait is
    /// otherwise indistinguishable from a hang.
    async fn ensure_generated_map(&self, map_name: &str) -> Result<(), String> {
        use faf_domain::state::GeneratorStatus;

        if self.map_generator.is_installed(map_name) {
            return Ok(());
        }
        if !self.auto_generate_maps.load(Ordering::Relaxed) {
            return Err(format!(
                "this replay was played on the generated map {map_name}, which is not \
                 installed, and automatic map generation is disabled in settings"
            ));
        }

        tracing::info!(map_name, "generating map required by replay playback");
        let mut updates = self
            .map_generator
            .generate_named(map_name.to_string())
            .await;
        let mut outcome = Err("the map generator produced no result".to_string());
        while let Some(crate::ports::GeneratorUpdate::Status(status)) = updates.recv().await {
            match status {
                GeneratorStatus::Generated { .. } => outcome = Ok(()),
                GeneratorStatus::Failed { reason } => {
                    outcome = Err(format!("could not generate {map_name}: {reason}"))
                }
                _ => {}
            }
        }
        outcome
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use faf_domain::state::GeneratorStatus;

    use crate::infra::replay::test_support::{preparation_with, StubGenerator};

    /// A real generated-map folder name, as it appears in a replay header.
    const GENERATED_MAP: &str = "neroxis_map_generator_1.21.0_ualhhyfgnqw4u_cagaeaakbyaaaqd2";

    /// The reported bug: a generated map has no `.vNNNN` suffix, so the vault
    /// staging path classes it as a base-game map and does nothing at all. FA
    /// then aborts the session on a map that was never written to disk.
    #[tokio::test]
    async fn a_replay_on_a_generated_map_rebuilds_it_before_launch() {
        let generator = Arc::new(StubGenerator::new(
            false,
            GeneratorStatus::Generated {
                maps: vec![GENERATED_MAP.to_string()],
            },
        ));
        let preparation = preparation_with(generator.clone());

        let warning = preparation
            .ensure_replay_map(Path::new("unused"), GENERATED_MAP)
            .await
            .expect("generation succeeded, so playback must proceed");

        assert_eq!(warning, None);
        assert_eq!(
            generator.asked_for.lock().unwrap().as_slice(),
            [GENERATED_MAP.to_string()],
            "the generator is the only source for this map; nothing else can supply it"
        );
    }

    #[tokio::test]
    async fn an_installed_generated_map_is_not_regenerated() {
        let generator = Arc::new(StubGenerator::new(
            true,
            GeneratorStatus::Failed {
                reason: "must not run".into(),
            },
        ));
        let preparation = preparation_with(generator.clone());

        preparation
            .ensure_replay_map(Path::new("unused"), GENERATED_MAP)
            .await
            .expect("an installed map needs no work");
        assert!(generator.asked_for.lock().unwrap().is_empty());
    }

    /// Unlike a failed vault download, this cannot be downgraded to a warning:
    /// launching anyway is a guaranteed `aborting session` with nothing on
    /// screen to explain it.
    #[tokio::test]
    async fn a_generated_map_that_cannot_be_produced_stops_the_launch() {
        let generator = Arc::new(StubGenerator::new(
            false,
            GeneratorStatus::Failed {
                reason: "no java".into(),
            },
        ));
        let preparation = preparation_with(generator);

        let error = preparation
            .ensure_replay_map(Path::new("unused"), GENERATED_MAP)
            .await
            .expect_err("an unloadable map must not reach FA");
        assert!(error.contains("no java"), "{error}");
    }

    #[tokio::test]
    async fn generation_disabled_in_settings_is_reported_rather_than_ignored() {
        let generator = Arc::new(StubGenerator::new(
            false,
            GeneratorStatus::Failed {
                reason: "must not run".into(),
            },
        ));
        let preparation = preparation_with(generator.clone());
        preparation.set_auto_generate_maps(false);

        let error = preparation
            .ensure_replay_map(Path::new("unused"), GENERATED_MAP)
            .await
            .expect_err("the setting forbids the only way to get this map");
        assert!(error.contains("disabled in settings"), "{error}");
        assert!(generator.asked_for.lock().unwrap().is_empty());
    }

    /// A base-game map is neither generated nor in the vault, so it must reach
    /// FA untouched: no generator run, and no CDN request to 404 on.
    #[tokio::test]
    async fn a_base_game_map_needs_neither_the_generator_nor_the_vault() {
        let generator = Arc::new(StubGenerator::new(
            false,
            GeneratorStatus::Failed {
                reason: "must not run".into(),
            },
        ));
        let preparation = preparation_with(generator.clone());

        let warning = preparation
            .ensure_replay_map(Path::new("unused"), "SCMP_009")
            .await
            .expect("a base map is always available");
        assert_eq!(warning, None);
        assert!(generator.asked_for.lock().unwrap().is_empty());
    }
}
