//! Changelog: two plain GETs against FAForever/fa's published documents.
//!
//! No authentication and no API. The index is the rendered page on GitHub
//! Pages and a note is its Markdown source on `raw.githubusercontent.com`;
//! both are CDN-served static files, which is what keeps this off GitHub's
//! rate-limited API. All parsing is in [`faf_domain::protocol::changelog`].

use async_trait::async_trait;
use faf_domain::protocol::changelog::{parse_entry, parse_index, ChangelogEntry, ChangelogRelease};

use crate::infra::env_or;
use crate::ports::ChangelogPort;

/// Guards against a redirect to something unbounded. The largest note in the
/// repository is a little over 100 KB; the index is around 30 KB.
const MAX_DOCUMENT_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct ChangelogConfig {
    /// The rendered index. Overridable so a test can point at a local file.
    pub index_url: String,
}

impl ChangelogConfig {
    pub fn faf() -> Self {
        Self {
            index_url: env_or(
                "FAF_CHANGELOG_URL",
                "https://faforever.github.io/fa/changelog",
            ),
        }
    }
}

pub struct ChangelogClient {
    config: ChangelogConfig,
    http: reqwest::Client,
}

impl ChangelogClient {
    pub fn new(config: ChangelogConfig) -> Self {
        Self {
            config,
            http: super::http::shared_http_client(),
        }
    }

    pub fn faf() -> Self {
        Self::new(ChangelogConfig::faf())
    }

    async fn fetch_text(&self, url: &str) -> Result<String, String> {
        let response = self
            .http
            .get(url)
            .send()
            .await
            .map_err(|e| format!("could not reach the changelog: {e}"))?;

        let status = response.status();
        if !status.is_success() {
            return Err(format!("the changelog responded with {status}"));
        }

        let bytes = response
            .bytes()
            .await
            .map_err(|e| format!("could not read the changelog: {e}"))?;
        if bytes.len() > MAX_DOCUMENT_BYTES {
            return Err("the changelog document was unexpectedly large".into());
        }

        String::from_utf8(bytes.to_vec())
            .map_err(|_| "the changelog document was not valid UTF-8".into())
    }
}

#[async_trait]
impl ChangelogPort for ChangelogClient {
    async fn list_releases(&self) -> Result<Vec<ChangelogRelease>, String> {
        let html = self.fetch_text(&self.config.index_url).await?;
        let releases = parse_index(&html);
        if releases.is_empty() {
            // Distinguished from a transport failure on purpose: the fetch
            // worked and the page simply did not look like the changelog any
            // more, which is a different thing to investigate.
            return Err("the changelog index listed no releases".into());
        }
        Ok(releases)
    }

    async fn load_entry(&self, id: String, source_url: String) -> Result<ChangelogEntry, String> {
        if source_url.is_empty() {
            return Err(format!("release {id} has no published source"));
        }
        let markdown = self.fetch_text(&source_url).await?;
        Ok(parse_entry(&id, &markdown))
    }
}

/// Offline stand-in. Reports rather than inventing patch notes: a fabricated
/// changelog would be worse than an empty tab.
pub struct FakeChangelog;

#[async_trait]
impl ChangelogPort for FakeChangelog {
    async fn list_releases(&self) -> Result<Vec<ChangelogRelease>, String> {
        Err("the changelog is unavailable in offline mode".into())
    }

    async fn load_entry(&self, _id: String, _source_url: String) -> Result<ChangelogEntry, String> {
        Err("the changelog is unavailable in offline mode".into())
    }
}
