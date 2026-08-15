//! Real Neroxis map generator: downloads the JAR from GitHub and runs it.
//!
//! FAF matchmaker pools contain *generated* maps. The server does not ship
//! them; it names them (`neroxis_map_generator_<version>_<seed>`) and every
//! client reproduces the identical terrain locally by running the matching
//! generator release. Without this, matching into a ladder game on a generated
//! map leaves you unable to start.
//!
//! ## What runs where
//! * Name grammar, version policy and the command line live in
//!   [`faf_domain::protocol::map_generator`]: pure and exhaustively tested.
//! * This module does the IO: resolve a release from the GitHub API, download
//!   the JAR, spawn `java -jar`, and scrape the generated map names off stdout.
//!
//! ## Two flavours, from the two reference clients
//! * `generate_named` reproduces a specific map. The version comes from the
//!   name, so an old lobby works even if this client has never seen that
//!   release. This is the whole of the Python client's `mapGenerator/`.
//! * `generate` builds a fresh map from options using the newest supported
//!   release: the Java client's `GenerateMapController` flow.
//!
//! ## Why stdout scraping
//! With `--num-to-generate` the client cannot predict the seeds, so it cannot
//! predict the folder names. Both reference clients read the names back out of
//! the generator's own output, and so does this.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use async_trait::async_trait;
use faf_domain::protocol::map_generator::{
    self, GeneratorVersion, VersionPolicy, GENERATION_TIMEOUT_SECONDS,
};
use faf_domain::state::{GeneratorOptionQuery, GeneratorOptions, GeneratorStatus};
use serde::Deserialize;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;

use crate::infra::env_or;
use crate::infra::vault_install::MAX_DOWNLOAD_BYTES;
use crate::ports::{GeneratorUpdate, MapGeneratorPort};

/// How long an option query (`--styles` etc.) may take. Much shorter than a
/// generation run: it only prints a list. The Java client uses six seconds.
const OPTION_QUERY_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone)]
pub struct MapGeneratorConfig {
    /// GitHub releases API for the generator repository.
    pub releases_url: String,
    /// `{version}`-templated download URL for the release asset.
    pub download_url_format: String,
    /// `java` executable. Shared convention with the ICE adapter's
    /// `FAF_JAVA_PATH`, since both need a JVM.
    pub java_path: String,
    /// Where downloaded generator JARs are cached.
    pub generator_dir: PathBuf,
    /// Where generated maps are written: FA's user maps folder.
    pub maps_dir: PathBuf,
    /// Which generator major versions this client will drive. Configurable for
    /// the same reason the Java client reads it from `application.yml`: FAF can
    /// move the window without a client release.
    pub version_policy: VersionPolicy,
}

impl MapGeneratorConfig {
    pub fn faf() -> Self {
        Self {
            releases_url: env_or(
                "FAF_MAP_GENERATOR_RELEASES_URL",
                "https://api.github.com/repos/FAForever/Neroxis-Map-Generator/releases",
            ),
            download_url_format: env_or(
                "FAF_MAP_GENERATOR_DOWNLOAD_URL",
                "https://github.com/FAForever/Neroxis-Map-Generator/releases/download/{version}/NeroxisGen_{version}.jar",
            ),
            java_path: super::java_runtime::preferred_java_path(),
            generator_dir: generator_dir(),
            maps_dir: user_maps_dir(),
            version_policy: version_policy_from_env(),
        }
    }
}

/// The supported generator-version window, overridable per deployment.
///
/// A malformed override falls back to the default rather than failing to
/// start: a typo in an env var should not make map generation impossible.
fn version_policy_from_env() -> VersionPolicy {
    let default = VersionPolicy::default();
    let read = |key: &str, fallback: u32| {
        std::env::var(key)
            .ok()
            .and_then(|value| value.parse::<u32>().ok())
            .unwrap_or(fallback)
    };
    let min_major = read("FAF_MAP_GENERATOR_MIN_MAJOR", default.min_major);
    let max_major = read("FAF_MAP_GENERATOR_MAX_MAJOR", default.max_major);
    // An inverted window would reject every version; treat it as unset.
    if min_major > max_major {
        tracing::warn!(
            min_major,
            max_major,
            "ignoring inverted map-generator version window"
        );
        return default;
    }
    VersionPolicy {
        min_major,
        max_major,
    }
}

/// Cache directory for generator JARs. Kept out of the maps folder so a
/// "delete generated maps" sweep never removes the generators themselves.
fn generator_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("FAF_MAP_GENERATOR_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    directories::ProjectDirs::from("com", "forgeclient", "forge-client")
        .map(|dirs| dirs.data_dir().join("map_generator"))
        .unwrap_or_else(|| PathBuf::from("map_generator"))
}

/// FA's user maps folder: where the generator writes and where FA looks.
///
/// Deliberately the *same* resolver the maps port scans with, honouring the
/// same `FAF_MAPS_DIR` override. A second implementation here would let a
/// custom install point the generator at a folder the installed-map list never
/// reads, so a generated map would silently never appear.
fn user_maps_dir() -> PathBuf {
    crate::infra::maps::maps_dir()
}

pub struct NeroxisMapGenerator {
    config: MapGeneratorConfig,
    http: reqwest::Client,
}

impl NeroxisMapGenerator {
    pub fn new(config: MapGeneratorConfig) -> Self {
        Self {
            config,
            // The shared transport supplies the User-Agent GitHub requires.
            http: super::http::shared_http_client(),
        }
    }

    pub fn faf() -> Self {
        Self::new(MapGeneratorConfig::faf())
    }

    fn jar_path(&self, version: GeneratorVersion) -> PathBuf {
        self.config.generator_dir.join(version.cached_jar_name())
    }

    /// Download the generator JAR if it isn't cached, reporting progress.
    ///
    /// Writes to a temporary file and renames on completion, so an interrupted
    /// download can never leave a truncated JAR that later "exists" and fails
    /// to run.
    async fn ensure_jar(
        &self,
        version: GeneratorVersion,
        progress: &mpsc::Sender<GeneratorUpdate>,
    ) -> Result<PathBuf, String> {
        let target = self.jar_path(version);
        if target.is_file() {
            return Ok(target);
        }

        let url = self
            .config
            .download_url_format
            .replace("{version}", &version.to_string());
        let _ = progress
            .send(GeneratorUpdate::Status(GeneratorStatus::Downloading {
                version: version.to_string(),
                downloaded_bytes: 0,
                total_bytes: None,
            }))
            .await;

        let response = self
            .http
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("could not reach the map generator download: {e}"))?;
        if !response.status().is_success() {
            return Err(format!(
                "map generator {version} download returned {}",
                response.status()
            ));
        }
        if response
            .content_length()
            .is_some_and(|size| size > MAX_DOWNLOAD_BYTES)
        {
            return Err("map generator download is larger than the allowed size".into());
        }
        // Clamped to `u32` for the IPC boundary; see `GeneratorStatus::Downloading`.
        let total_bytes = response
            .content_length()
            .map(|n| u32::try_from(n).unwrap_or(u32::MAX));

        tokio::fs::create_dir_all(&self.config.generator_dir)
            .await
            .map_err(|e| format!("could not create the generator directory: {e}"))?;
        let temp = target.with_extension("partial");
        if tokio::fs::try_exists(&temp).await.unwrap_or(false) {
            tokio::fs::remove_file(&temp)
                .await
                .map_err(|e| format!("could not clear the partial generator: {e}"))?;
        }
        let mut file = tokio::fs::File::create(&temp)
            .await
            .map_err(|e| format!("could not write the generator: {e}"))?;

        let mut downloaded = 0u64;
        let mut stream = response.bytes_stream();
        use futures_util::StreamExt as _;
        use tokio::io::AsyncWriteExt as _;
        let write_result: Result<(), String> = async {
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|e| format!("map generator download failed: {e}"))?;
                downloaded = downloaded
                    .checked_add(chunk.len() as u64)
                    .ok_or_else(|| "map generator download is too large".to_string())?;
                if downloaded > MAX_DOWNLOAD_BYTES {
                    return Err("map generator download is larger than the allowed size".into());
                }
                file.write_all(&chunk)
                    .await
                    .map_err(|e| format!("could not write the generator: {e}"))?;
                let _ = progress
                    .send(GeneratorUpdate::Status(GeneratorStatus::Downloading {
                        version: version.to_string(),
                        downloaded_bytes: u32::try_from(downloaded).unwrap_or(u32::MAX),
                        total_bytes,
                    }))
                    .await;
            }
            file.flush()
                .await
                .map_err(|e| format!("could not finish writing the generator: {e}"))
        }
        .await;
        drop(file);
        if let Err(error) = write_result {
            let _ = tokio::fs::remove_file(&temp).await;
            return Err(error);
        }

        if let Err(error) = tokio::fs::rename(&temp, &target).await {
            let _ = tokio::fs::remove_file(&temp).await;
            return Err(format!("could not install the generator: {error}"));
        }
        Ok(target)
    }

    /// Give up on a run that has exceeded its deadline, and return the error.
    ///
    /// Kills *and reaps*: `start_kill` only signals, so without the follow-up
    /// wait the JVM would linger as a zombie for the rest of the session: and
    /// a user retrying after a timeout would accumulate one per attempt.
    async fn abandon(&self, child: &mut tokio::process::Child, untimed: bool) -> String {
        debug_assert!(!untimed, "an untimed run should never reach the deadline");
        let _ = child.start_kill();
        // Bounded: if the JVM ignores the signal, don't trade one hang for
        // another. The OS cleans up on client exit either way.
        let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
        format!("map generation timed out after {GENERATION_TIMEOUT_SECONDS}s")
    }

    /// Run the generator and collect the map names it reports.
    async fn run_generator(
        &self,
        version: GeneratorVersion,
        jar: &Path,
        args: Vec<String>,
        progress: &mpsc::Sender<GeneratorUpdate>,
    ) -> Result<Vec<String>, String> {
        tokio::fs::create_dir_all(&self.config.maps_dir)
            .await
            .map_err(|e| format!("could not create the maps directory: {e}"))?;

        let mut child = Command::new(&self.config.java_path)
            .arg("-jar")
            .arg(jar)
            .args(&args)
            // The generator writes into its working directory.
            .current_dir(&self.config.maps_dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| {
                format!(
                    "could not start the map generator ({}): {e}. Java is required to generate maps.",
                    self.config.java_path
                )
            })?;

        let stdout = child.stdout.take().ok_or("no generator output")?;
        let stderr = child.stderr.take().ok_or("no generator error output")?;

        let mut names: Vec<String> = Vec::new();
        let mut lines = BufReader::new(stdout).lines();

        // Drain stderr concurrently. The generator prints usage help there on a
        // bad option combination, and a full pipe would deadlock the child.
        let stderr_task = tokio::spawn(async move {
            let mut collected = String::new();
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::debug!("map generator emitted an error-output line");
                if collected.len() < 2000 {
                    collected.push_str(&line);
                    collected.push('\n');
                }
            }
            collected
        });

        // A `--visualize` run opens a viewer window and stays alive on purpose,
        // so it is exempt from the timeout: the Java client's `GenerateMapTask`
        // makes the same exception. Everything else gets three minutes.
        let untimed = map_generator::runs_without_timeout(&args);
        let deadline =
            tokio::time::Instant::now() + Duration::from_secs(GENERATION_TIMEOUT_SECONDS);
        // `None` disables every deadline below without duplicating the loop.
        let remaining = || -> Option<Duration> {
            (!untimed).then(|| deadline.saturating_duration_since(tokio::time::Instant::now()))
        };

        loop {
            let wait_for = remaining();
            if wait_for.is_some_and(|d| d.is_zero()) {
                return Err(self.abandon(&mut child, untimed).await);
            }
            let next = match wait_for {
                Some(limit) => tokio::time::timeout(limit, lines.next_line()).await,
                None => Ok(lines.next_line().await),
            };
            match next {
                Err(_) => {
                    return Err(self.abandon(&mut child, untimed).await);
                }
                Ok(Ok(Some(line))) => {
                    tracing::debug!("map generator emitted an output line");
                    for name in map_generator::scrape_map_names(&line) {
                        if !names.contains(&name) {
                            names.push(name);
                        }
                    }
                    // The generator's own output is the only progress signal.
                    let _ = progress
                        .send(GeneratorUpdate::Status(GeneratorStatus::Generating {
                            version: version.to_string(),
                            detail: line.chars().take(90).collect(),
                        }))
                        .await;
                }
                Ok(Ok(None)) => break,
                Ok(Err(e)) => return Err(format!("could not read generator output: {e}")),
            }
        }

        // Stdout closing is not the same as exiting: a generator that closes
        // its pipes but never terminates would hang here forever without the
        // same deadline the read loop uses.
        let status = match remaining() {
            Some(limit) => match tokio::time::timeout(limit, child.wait()).await {
                Ok(status) => {
                    status.map_err(|e| format!("map generator did not exit cleanly: {e}"))?
                }
                Err(_) => return Err(self.abandon(&mut child, untimed).await),
            },
            None => child
                .wait()
                .await
                .map_err(|e| format!("map generator did not exit cleanly: {e}"))?,
        };
        let errors = stderr_task.await.unwrap_or_default();

        if !status.success() {
            let detail = errors.lines().next().unwrap_or("no detail").to_string();
            return Err(format!("the map generator failed: {detail}"));
        }
        if names.is_empty() {
            return Err(
                "the map generator produced no map: the option combination may be invalid"
                    .to_string(),
            );
        }

        // Trust the folder, not the log: a name in the output that didn't
        // result in a directory means the run half-failed.
        for name in &names {
            if !self.config.maps_dir.join(name).is_dir() {
                return Err(format!("the generator reported {name} but wrote no folder"));
            }
        }
        Ok(names)
    }

    async fn fetch_releases(&self) -> Result<Vec<GitHubRelease>, String> {
        let response = self
            .http
            .get(&self.config.releases_url)
            .header(reqwest::header::ACCEPT, "application/vnd.github.v3+json")
            .send()
            .await
            .map_err(|e| format!("could not reach the map generator releases: {e}"))?;
        if !response.status().is_success() {
            return Err(format!(
                "map generator releases returned {}",
                response.status()
            ));
        }
        response
            .json()
            .await
            .map_err(|e| format!("could not read the map generator releases: {e}"))
    }

    /// The newest release whose major version this client supports.
    async fn resolve_latest(&self) -> Result<GeneratorVersion, String> {
        let releases = self.fetch_releases().await?;
        releases
            .iter()
            .filter_map(|release| GeneratorVersion::parse(release.tag_name.trim_start_matches('v')))
            .filter(|version| self.config.version_policy.allows_major(version.major))
            .max()
            .ok_or_else(|| {
                format!(
                    "no map generator release between major {} and {}: this client may be out of date",
                    self.config.version_policy.min_major, self.config.version_policy.max_major
                )
            })
    }

    async fn resolve_version(&self, explicit: Option<&str>) -> Result<GeneratorVersion, String> {
        if let Some(v_str) = explicit {
            let parsed = GeneratorVersion::parse(v_str.trim_start_matches('v'))
                .ok_or_else(|| format!("invalid generator version: {v_str}"))?;
            if !self.config.version_policy.allows_major(parsed.major) {
                return Err(format!(
                    "generator version {v_str} is outside the supported range"
                ));
            }
            return Ok(parsed);
        }
        self.resolve_latest().await
    }

    async fn available_versions(&self) -> Result<Vec<String>, String> {
        let releases = self.fetch_releases().await?;
        let mut versions: Vec<GeneratorVersion> = releases
            .into_iter()
            .filter_map(|r| GeneratorVersion::parse(r.tag_name.trim_start_matches('v')))
            .filter(|v| self.config.version_policy.allows_major(v.major))
            .collect();
        versions.sort();
        versions.dedup();
        versions.reverse();
        Ok(versions.into_iter().map(|v| v.to_string()).collect())
    }

    async fn read_map_preview(&self, map_name: &str) -> Option<String> {
        use base64::Engine as _;
        let folder = self.config.maps_dir.join(map_name);
        let candidates = [
            folder.join(format!("{map_name}.png")),
            folder.join(format!("{map_name}_preview.png")),
            folder.join("preview.png"),
        ];
        for path in candidates {
            if let Ok(bytes) = tokio::fs::read(&path).await {
                if !bytes.is_empty() {
                    return Some(format!(
                        "data:image/png;base64,{}",
                        base64::engine::general_purpose::STANDARD.encode(&bytes)
                    ));
                }
            }
        }
        None
    }

    /// Prepare and run, funnelling every failure into one `Failed` status.
    async fn run(
        &self,
        map_name: Option<String>,
        options: GeneratorOptions,
        tx: mpsc::Sender<GeneratorUpdate>,
    ) {
        let outcome = self.run_inner(map_name, options, &tx).await;
        let status = match outcome {
            Ok(maps) => GeneratorStatus::Generated { maps },
            Err(reason) => GeneratorStatus::Failed { reason },
        };
        let _ = tx.send(GeneratorUpdate::Status(status)).await;
    }

    async fn run_inner(
        &self,
        map_name: Option<String>,
        options: GeneratorOptions,
        tx: &mpsc::Sender<GeneratorUpdate>,
    ) -> Result<Vec<String>, String> {
        // Reproducing a map takes its version from the name; a fresh map uses
        // either the explicitly selected version or resolves the newest supported release.
        let version = match &map_name {
            Some(name) => {
                map_generator::parse_generated_map_name(name)
                    .ok_or_else(|| format!("{name} is not a generated map"))?
                    .version
            }
            None => {
                if let Some(explicit) = &options.version {
                    self.resolve_version(Some(explicit)).await?
                } else {
                    let _ = tx
                        .send(GeneratorUpdate::Status(GeneratorStatus::ResolvingVersion))
                        .await;
                    self.resolve_latest().await?
                }
            }
        };

        let args = map_generator::build_arguments(
            version,
            map_name.as_deref(),
            &options,
            self.config.version_policy,
        )
        .map_err(|e| e.to_string())?;
        let jar = self.ensure_jar(version, tx).await?;
        self.run_generator(version, &jar, args, tx).await
    }
}

#[derive(Debug, Deserialize)]
struct GitHubRelease {
    tag_name: String,
}

#[async_trait]
impl MapGeneratorPort for NeroxisMapGenerator {
    async fn generate_named(&self, map_name: String) -> mpsc::Receiver<GeneratorUpdate> {
        let (tx, rx) = mpsc::channel(32);
        let config = self.config.clone();
        tokio::spawn(async move {
            NeroxisMapGenerator::new(config)
                .run(Some(map_name), GeneratorOptions::default(), tx)
                .await;
        });
        rx
    }

    async fn generate(&self, options: GeneratorOptions) -> mpsc::Receiver<GeneratorUpdate> {
        let (tx, rx) = mpsc::channel(32);
        let config = self.config.clone();
        tokio::spawn(async move {
            NeroxisMapGenerator::new(config)
                .run(None, options, tx)
                .await;
        });
        rx
    }

    async fn query_options(
        &self,
        query: GeneratorOptionQuery,
        version: Option<String>,
    ) -> Result<Vec<String>, String> {
        let ver = self.resolve_version(version.as_deref()).await?;
        // The download reporter is discarded: an option query is a background
        // detail of opening a dialog, not something to narrate.
        let (tx, _rx) = mpsc::channel(8);
        let jar = self.ensure_jar(ver, &tx).await?;

        let output = tokio::time::timeout(
            OPTION_QUERY_TIMEOUT,
            Command::new(&self.config.java_path)
                .arg("-jar")
                .arg(&jar)
                .arg(query.flag())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .output(),
        )
        .await
        .map_err(|_| "the map generator did not answer in time".to_string())?
        .map_err(|e| format!("could not run the map generator: {e}"))?;

        Ok(map_generator::parse_option_list(&String::from_utf8_lossy(
            &output.stdout,
        )))
    }

    async fn latest_version(&self) -> Result<String, String> {
        self.resolve_latest().await.map(|v| v.to_string())
    }

    async fn available_versions(&self) -> Result<Vec<String>, String> {
        NeroxisMapGenerator::available_versions(self).await
    }

    fn is_installed(&self, map_name: &str) -> bool {
        !map_name.is_empty() && self.config.maps_dir.join(map_name).is_dir()
    }

    async fn clean_up(&self, protected_maps: &[String]) -> Result<usize, String> {
        let protected: std::collections::HashSet<String> = protected_maps
            .iter()
            .map(|name| name.trim().to_ascii_lowercase())
            .collect();
        let mut removed = 0;
        let mut entries = match tokio::fs::read_dir(&self.config.maps_dir).await {
            Ok(entries) => entries,
            // No maps folder means nothing to clean, not a failure.
            Err(_) => return Ok(0),
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name().to_string_lossy().to_string();
            if !map_generator::is_generated_map(&name) {
                continue;
            }
            if protected.contains(&name.to_ascii_lowercase()) {
                continue;
            }
            if entry.path().is_dir() && tokio::fs::remove_dir_all(entry.path()).await.is_ok() {
                removed += 1;
            }
        }
        Ok(removed)
    }

    async fn map_previews(
        &self,
        map_names: &[String],
    ) -> std::collections::HashMap<String, String> {
        let mut map = std::collections::HashMap::new();
        for name in map_names {
            if let Some(data_url) = self.read_map_preview(name).await {
                map.insert(name.clone(), data_url);
            }
        }
        map
    }
}

/// Inert generator: used offline and in tests.
#[derive(Debug, Clone, Default)]
pub struct FakeMapGenerator;

#[async_trait]
impl MapGeneratorPort for FakeMapGenerator {
    async fn generate_named(&self, map_name: String) -> mpsc::Receiver<GeneratorUpdate> {
        let (tx, rx) = mpsc::channel(4);
        // Report success so the offline path exercises the happy flow.
        let _ = tx
            .send(GeneratorUpdate::Status(GeneratorStatus::Generated {
                maps: vec![map_name],
            }))
            .await;
        rx
    }

    async fn generate(&self, _options: GeneratorOptions) -> mpsc::Receiver<GeneratorUpdate> {
        let (tx, rx) = mpsc::channel(4);
        let _ = tx
            .send(GeneratorUpdate::Status(GeneratorStatus::Generated {
                maps: vec!["neroxis_map_generator_1.7.7_offline".into()],
            }))
            .await;
        rx
    }

    async fn query_options(
        &self,
        query: GeneratorOptionQuery,
        _version: Option<String>,
    ) -> Result<Vec<String>, String> {
        // Representative values so the host dialog's pickers aren't empty offline.
        Ok(match query {
            GeneratorOptionQuery::Symmetries => vec!["POINT2".into(), "POINT4".into(), "XZ".into()],
            GeneratorOptionQuery::Styles => {
                vec!["BIG_ISLANDS".into(), "LAND".into(), "LOW_MEX".into()]
            }
            GeneratorOptionQuery::TerrainStyles => vec!["BASIC".into(), "MOUNTAIN_RANGE".into()],
            GeneratorOptionQuery::TextureStyles => vec!["BRIMSTONE".into(), "DESERT".into()],
            GeneratorOptionQuery::ResourceStyles => vec!["BASIC".into(), "LOW_MEX".into()],
            GeneratorOptionQuery::PropStyles => vec!["BASIC".into(), "ROCK_FIELD".into()],
        })
    }

    async fn latest_version(&self) -> Result<String, String> {
        Ok("1.7.7".into())
    }

    async fn available_versions(&self) -> Result<Vec<String>, String> {
        Ok(vec!["1.7.7".into(), "1.6.0".into(), "1.5.0".into()])
    }

    fn is_installed(&self, _map_name: &str) -> bool {
        false
    }

    async fn clean_up(&self, _protected_maps: &[String]) -> Result<usize, String> {
        Ok(0)
    }

    async fn map_previews(
        &self,
        _map_names: &[String],
    ) -> std::collections::HashMap<String, String> {
        std::collections::HashMap::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(dir: &Path) -> MapGeneratorConfig {
        MapGeneratorConfig {
            releases_url: "http://localhost/releases".into(),
            download_url_format: "http://localhost/{version}.jar".into(),
            java_path: "java".into(),
            generator_dir: dir.join("generators"),
            maps_dir: dir.join("maps"),
            version_policy: VersionPolicy::default(),
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("faf-mapgen-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn jar_paths_are_version_stamped_so_releases_coexist() {
        let dir = temp_dir("jar-paths");
        let generator = NeroxisMapGenerator::new(config(&dir));
        let old = generator.jar_path(GeneratorVersion::parse("1.7.7").unwrap());
        let new = generator.jar_path(GeneratorVersion::parse("1.8.0").unwrap());
        assert_ne!(old, new);
        assert!(old.ends_with("MapGenerator_1.7.7.jar"));
    }

    #[test]
    fn is_installed_only_matches_an_existing_folder() {
        let dir = temp_dir("installed");
        let generator = NeroxisMapGenerator::new(config(&dir));
        let name = "neroxis_map_generator_1.7.7_abc";
        assert!(!generator.is_installed(name));
        std::fs::create_dir_all(dir.join("maps").join(name)).unwrap();
        assert!(generator.is_installed(name));
        assert!(!generator.is_installed(""));
    }

    #[tokio::test]
    async fn clean_up_removes_generated_maps_and_spares_the_rest() {
        let dir = temp_dir("cleanup");
        let maps = dir.join("maps");
        for name in [
            "neroxis_map_generator_1.7.7_aaa",
            "neroxis_map_generator_1.7.7_bbb",
            "scmp_009",
            "adaptive_gadostb.v0002",
        ] {
            std::fs::create_dir_all(maps.join(name)).unwrap();
        }
        let generator = NeroxisMapGenerator::new(config(&dir));
        assert_eq!(
            generator
                .clean_up(&["Neroxis_Map_Generator_1.7.7_AAA".into()])
                .await
                .unwrap(),
            1
        );
        assert!(maps.join("neroxis_map_generator_1.7.7_aaa").exists());
        assert!(!maps.join("neroxis_map_generator_1.7.7_bbb").exists());
        assert!(maps.join("scmp_009").exists());
        assert!(maps.join("adaptive_gadostb.v0002").exists());
    }

    #[tokio::test]
    async fn clean_up_is_fine_without_a_maps_folder() {
        let dir = temp_dir("cleanup-missing");
        let generator = NeroxisMapGenerator::new(config(&dir));
        assert_eq!(generator.clean_up(&[]).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn a_version_outside_the_window_is_refused_before_downloading_anything() {
        // The download URL points at a dead host, so reaching it would fail
        // with a network error instead: the version message proves the policy
        // check ran first.
        let dir = temp_dir("unsupported-version");
        let generator = NeroxisMapGenerator::new(MapGeneratorConfig {
            version_policy: VersionPolicy {
                min_major: 1,
                max_major: 1,
            },
            ..config(&dir)
        });
        let mut rx = generator
            .generate_named("neroxis_map_generator_0.9.0_abc".into())
            .await;
        let GeneratorUpdate::Status(status) = rx.recv().await.unwrap();
        let GeneratorStatus::Failed { reason } = status else {
            panic!("expected a failure, got {status:?}");
        };
        assert!(reason.contains("older"), "{reason}");
        assert!(
            !dir.join("generators").exists(),
            "nothing should have been downloaded"
        );
    }

    #[tokio::test]
    async fn a_too_new_version_is_refused_with_update_advice() {
        let dir = temp_dir("too-new-version");
        let generator = NeroxisMapGenerator::new(config(&dir));
        let mut rx = generator
            .generate_named("neroxis_map_generator_9.0.0_abc".into())
            .await;
        let GeneratorUpdate::Status(status) = rx.recv().await.unwrap();
        let GeneratorStatus::Failed { reason } = status else {
            panic!("expected a failure, got {status:?}");
        };
        assert!(reason.contains("update the client"), "{reason}");
    }

    #[test]
    fn an_inverted_version_window_falls_back_to_the_default() {
        // Guards against a typo'd deployment override silently rejecting every
        // generator version.
        let inverted = VersionPolicy {
            min_major: 5,
            max_major: 1,
        };
        assert!(!inverted.allows_major(1));
        assert!(!inverted.allows_major(5));
        // `version_policy_from_env` refuses to build one; see its fallback.
        assert!(VersionPolicy::default().allows_major(1));
    }

    #[tokio::test]
    async fn generating_a_non_generated_name_fails_before_touching_the_network() {
        let dir = temp_dir("bad-name");
        let generator = NeroxisMapGenerator::new(config(&dir));
        let mut rx = generator.generate_named("scmp_009".into()).await;
        let GeneratorUpdate::Status(status) = rx.recv().await.unwrap();
        assert!(
            matches!(status, GeneratorStatus::Failed { reason } if reason.contains("not a generated map")),
        );
    }
}
