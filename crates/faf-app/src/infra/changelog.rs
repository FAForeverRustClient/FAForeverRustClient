//! Changelog: two plain GETs against FAForever/fa's published documents.
//!
//! No authentication and no API. The index is the rendered page on GitHub
//! Pages; a dated note is its Markdown source on `raw.githubusercontent.com`
//! and a rolling branch note is its own rendered page, for the reason the
//! codec's header gives. All three are CDN-served static files, which is what
//! keeps this off GitHub's rate-limited API. All parsing is in
//! [`faf_domain::protocol::changelog`].

use async_trait::async_trait;
use faf_domain::protocol::changelog::{
    historical_balance_source, parse_entry, parse_historical_balance, parse_index,
    parse_rendered_entry, ChangelogEntry, ChangelogRelease,
};

use crate::infra::env_or;
use crate::ports::ChangelogPort;

mod cache;

/// Guards against a redirect to something unbounded. The largest note in the
/// repository is a little over 100 KB; the index and a rendered branch page are
/// around 30 KB each.
const MAX_DOCUMENT_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct ChangelogConfig {
    /// The rendered index. Overridable so a test can point at a local file.
    pub index_url: String,
    /// Disposable public documents, reused across client sessions.
    pub cache_dir: Option<std::path::PathBuf>,
}

impl ChangelogConfig {
    pub fn faf() -> Self {
        Self {
            index_url: env_or(
                "FAF_CHANGELOG_URL",
                "https://faforever.github.io/fa/changelog",
            ),
            cache_dir: super::cache_dir().ok().map(|root| root.join("changelog")),
        }
    }
}

pub struct ChangelogClient {
    config: ChangelogConfig,
    http: reqwest::Client,
    documents: cache::DocumentCache,
}

impl ChangelogClient {
    pub fn new(config: ChangelogConfig) -> Self {
        Self {
            documents: cache::DocumentCache::new(config.cache_dir.clone()),
            config,
            http: super::http::shared_http_client(),
        }
    }

    pub fn faf() -> Self {
        Self::new(ChangelogConfig::faf())
    }

    async fn fetch_text(&self, url: &str) -> Result<String, String> {
        self.fetch_text_with_deadline(url, super::http::REQUEST_DEADLINE)
            .await
    }

    async fn dated_document(
        &self,
        url: &str,
        deadline: std::time::Duration,
    ) -> Result<String, String> {
        if let Some(source) = self.documents.read(url).await {
            return Ok(source);
        }
        let source = self.fetch_text_with_deadline(url, deadline).await?;
        self.documents.store(url, &source).await;
        Ok(source)
    }

    async fn fetch_text_with_deadline(
        &self,
        url: &str,
        deadline: std::time::Duration,
    ) -> Result<String, String> {
        let response = self
            .http
            .get(url)
            .timeout(deadline)
            .send()
            .await
            .map_err(|e| format!("could not reach the changelog: {e}"))?;

        let status = response.status();
        if !status.is_success() {
            return Err(format!("the changelog responded with {status}"));
        }

        let bytes = super::vault_install::bounded_body(
            response,
            "the changelog document",
            MAX_DOCUMENT_BYTES as u64,
        )
        .await?;

        String::from_utf8(bytes).map_err(|_| "the changelog document was not valid UTF-8".into())
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

    async fn load_entry(&self, release: ChangelogRelease) -> Result<ChangelogEntry, String> {
        if release.source_url.is_empty() {
            return Err(format!("release {} has no published source", release.id));
        }
        let document = if release.is_rolling() {
            self.fetch_text(&release.source_url).await?
        } else {
            self.dated_document(&release.source_url, super::http::REQUEST_DEADLINE)
                .await?
        };
        // Parsing takes milliseconds per note in a release build and tens in a
        // debug one, so it runs off the async runtime: an archive search
        // parses every note, and inside its one task each parse held up the
        // downloads running beside it.
        let id = release.id.clone();
        let rolling = release.is_rolling();
        let mut entry = tokio::task::spawn_blocking(move || {
            if rolling {
                // The branch pages carry nothing until the Pages build appends
                // the deployed snippets to them, so the built page is the source.
                parse_rendered_entry(&id, &document)
            } else {
                parse_entry(&id, &document)
            }
        })
        .await
        .map_err(|_| format!("release {} could not be parsed", release.id))?;
        if entry.blocks.is_empty() && !release.is_rolling() {
            self.documents.remove(&release.source_url).await;
        }
        if let Some(source) = historical_balance_source(&entry) {
            let original = self
                .dated_document(&source, std::time::Duration::from_secs(5))
                .await
                .ok();
            let (parsed, block) = tokio::task::spawn_blocking(move || {
                let block = parse_historical_balance(&entry, original.as_deref());
                (entry, block)
            })
            .await
            .map_err(|_| format!("release {} could not be parsed", release.id))?;
            entry = parsed;
            if let Some(block) = block {
                if matches!(
                    &block,
                    faf_domain::protocol::changelog::ChangelogBlock::HistoricalBalance {
                        unavailable: true,
                        ..
                    }
                ) {
                    // An HTTP success can still be an error page. Retry that
                    // source next time instead of persisting an incomplete note.
                    self.documents.remove(&source).await;
                }
                entry.blocks.push(block);
            }
        }
        Ok(entry)
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

    async fn load_entry(&self, _release: ChangelogRelease) -> Result<ChangelogEntry, String> {
        Err("the changelog is unavailable in offline mode".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicU32, Ordering},
        Arc,
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn dated_notes_survive_client_restarts_while_rolling_notes_refresh() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(AtomicU32::new(0));
        let observed = requests.clone();
        let server = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0_u8; 4096];
                let length = socket.read(&mut request).await.unwrap();
                let rolling = String::from_utf8_lossy(&request[..length]).contains("/rolling");
                let number = observed.fetch_add(1, Ordering::AcqRel) + 1;
                let body = if rolling {
                    format!("<h1>Rolling</h1><p>Update {number}</p>")
                } else {
                    "# Patch 3822\n\nPublished Cooper changes.".into()
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                socket.write_all(response.as_bytes()).await.unwrap();
            }
        });
        let cache = tempfile::tempdir().unwrap();
        let config = ChangelogConfig {
            index_url: base.clone(),
            cache_dir: Some(cache.path().to_path_buf()),
        };
        let release = ChangelogRelease {
            id: "3822".into(),
            date: "2025-05-19".into(),
            year: "2025".into(),
            kind: "Game Patch".into(),
            source_url: format!("{base}/dated.md"),
            web_url: String::new(),
        };
        let first = ChangelogClient::new(config.clone())
            .load_entry(release.clone())
            .await
            .unwrap();
        let restarted = ChangelogClient::new(config);
        assert_eq!(restarted.load_entry(release.clone()).await.unwrap(), first);
        assert_eq!(
            requests.load(Ordering::Acquire),
            1,
            "a new client should use its disk cache"
        );
        let rolling = ChangelogRelease {
            id: "fafbeta".into(),
            date: String::new(),
            source_url: format!("{base}/rolling"),
            ..release
        };
        let first = restarted.load_entry(rolling.clone()).await.unwrap();
        let second = restarted.load_entry(rolling).await.unwrap();
        assert_ne!(first, second);
        assert_eq!(requests.load(Ordering::Acquire), 3);
        server.abort();
    }
}
