//! Whether FAF's channels are live, from Twitch.
//!
//! Twitch's Helix API answers this and nothing else does: there is no
//! unauthenticated endpoint, no RSS feed, and no page a client can read that
//! says it reliably. Helix wants an application's own client id and secret,
//! exchanged for a token under the client-credentials grant, which is a
//! deployment's credential and not something a public repository can hold. So
//! this adapter has two modes, and the one without credentials is not a
//! degraded mode: it is the correct behaviour for a build that has not been
//! given any.
//!
//! * **Configured** (`TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET`): ask Helix
//!   about the configured channels, cache the app token until it expires, and
//!   report what is live.
//! * **Not configured**: [`StreamsPort::can_check`] answers `false`, the
//!   service never starts its ticker, and nothing is ever announced. One log
//!   line at startup says so, because an operator wondering why the feature is
//!   quiet deserves an answer that is not silence.
//!
//! No token is ever read from or written to the user's keyring, and none
//! belongs to the player: this is the *application's* token, it grants access to
//! public information only, and it is held in memory for the few minutes Twitch
//! says it is good for. The player's FAF session has nothing to do with it.
//!
//! YouTube is deliberately absent. Its Data API needs a key of its own and
//! answers a differently shaped question (a channel's live broadcast is a
//! search, not a field), so it is a second adapter behind the same port rather
//! than something to bolt onto this one. [`StreamPlatform`] already has the
//! variant.

use std::sync::Mutex;

use async_trait::async_trait;
use faf_domain::state::{LiveStream, StreamPlatform};
use serde::Deserialize;

use crate::infra::env_or;
use crate::ports::StreamsPort;

/// FAF's own Twitch channel: the one the tournaments are cast on.
///
/// A list, because a deployment may want to add a second official channel, and
/// because the Helix query takes repeated `user_login` parameters anyway.
const DEFAULT_CHANNELS: &str = "faflive";

const TOKEN_URL: &str = "https://id.twitch.tv/oauth2/token";
const STREAMS_URL: &str = "https://api.twitch.tv/helix/streams";

/// An answer about a handful of channels is a few kilobytes. Anything past this
/// is a wrong URL rather than a busy day.
const MAX_RESPONSE_BYTES: usize = 256 * 1024;

/// Seconds of slack taken off a token's stated lifetime.
///
/// A token that expires between the check and the request produces a 401 and a
/// wasted poll, and Twitch's app tokens last sixty days, so losing a minute of
/// one costs nothing.
const TOKEN_SKEW: u32 = 60;

#[derive(Debug, Clone)]
pub struct TwitchConfig {
    /// The application's client id. Empty disables the whole adapter.
    pub client_id: String,
    pub client_secret: String,
    /// Channel logins to ask about.
    pub channels: Vec<String>,
}

/// A credential, from the environment this build was *compiled* in, or the one
/// it is *running* in.
///
/// Both, in that order of preference, because the two answer different
/// questions. A release is run by a player who has never heard of these
/// variables, so the only way credentials can reach them is to have been
/// present when the binary was built: that is what `option_env!` reads, and it
/// is why reading the environment at runtime alone meant FAF Live could never
/// work in a shipped client, only in a developer's shell.
///
/// The runtime value wins where both exist, so setting the variable in a shell
/// still overrides whatever a build was given, which is what makes a local
/// check of somebody else's build possible.
///
/// None of this hides anything. A string compiled into a binary is a string
/// anybody can read out of it, and no amount of encoding changes that while the
/// key to decode it ships alongside. What it does buy is the thing actually
/// worth buying: the secret is not in the repository and not in its history.
/// See `docs/streams.md`.
macro_rules! credential {
    ($key:literal) => {
        match std::env::var($key) {
            Ok(value) if !value.is_empty() => value,
            _ => option_env!($key).unwrap_or("").to_string(),
        }
    };
}

impl TwitchConfig {
    pub fn faf() -> Self {
        Self {
            client_id: credential!("TWITCH_CLIENT_ID"),
            client_secret: credential!("TWITCH_CLIENT_SECRET"),
            channels: split_channels(&env_or("FAF_TWITCH_CHANNELS", DEFAULT_CHANNELS)),
        }
    }

    /// Whether this build was given what Twitch requires.
    pub fn usable(&self) -> bool {
        !self.client_id.trim().is_empty()
            && !self.client_secret.trim().is_empty()
            && !self.channels.is_empty()
    }
}

/// Channel logins from one configured string.
///
/// Comma or whitespace separated, lower-cased, deduplicated: a login is
/// case-insensitive on Twitch, and the same channel twice would be the same
/// stream twice in the list.
pub(crate) fn split_channels(configured: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for part in configured.split([',', ' ', '\t', '\n']) {
        let login = part.trim().trim_start_matches('#').to_ascii_lowercase();
        if login.is_empty() || out.contains(&login) {
            continue;
        }
        out.push(login);
    }
    out
}

/// An app token and when it stops being one.
struct CachedToken {
    access_token: String,
    expires_at: u32,
}

pub struct TwitchStreams {
    config: TwitchConfig,
    http: reqwest::Client,
    token: Mutex<Option<CachedToken>>,
}

impl TwitchStreams {
    pub fn new(config: TwitchConfig) -> Self {
        Self {
            config,
            http: super::http::shared_http_client(),
            token: Mutex::new(None),
        }
    }

    pub fn faf() -> Self {
        let config = TwitchConfig::faf();
        if !config.usable() {
            // Said once, at startup, rather than never: "the live announcements
            // do nothing" is otherwise indistinguishable from a bug.
            tracing::info!(
                "no Twitch application credentials configured (TWITCH_CLIENT_ID / \
                 TWITCH_CLIENT_SECRET); FAF live announcements are off. See docs/streams.md",
            );
        }
        Self::new(config)
    }

    /// A valid app token, from the cache or from Twitch.
    async fn token(&self) -> Result<String, String> {
        let now = crate::services::now_seconds();
        if let Some(held) = self.token.lock().ok().and_then(|guard| {
            guard
                .as_ref()
                .filter(|token| token.expires_at > now)
                .map(|token| token.access_token.clone())
        }) {
            return Ok(held);
        }

        let response = self
            .http
            .post(TOKEN_URL)
            .form(&[
                ("client_id", self.config.client_id.as_str()),
                ("client_secret", self.config.client_secret.as_str()),
                ("grant_type", "client_credentials"),
            ])
            .send()
            .await
            .map_err(|error| format!("could not reach Twitch: {error}"))?;
        let status = response.status();
        if !status.is_success() {
            // The body is not quoted: it is a token endpoint's refusal, and the
            // client secret is in the request that produced it.
            return Err(format!(
                "Twitch refused the application credentials ({status})"
            ));
        }
        let body: TokenResponse = response
            .json()
            .await
            .map_err(|error| format!("could not read Twitch's token response: {error}"))?;
        if body.access_token.is_empty() {
            return Err("Twitch returned an empty application token".into());
        }

        let expires_at = now.saturating_add(body.expires_in.saturating_sub(TOKEN_SKEW));
        if let Ok(mut guard) = self.token.lock() {
            *guard = Some(CachedToken {
                access_token: body.access_token.clone(),
                expires_at,
            });
        }
        Ok(body.access_token)
    }

    /// Drop the cached token, so the next attempt asks for a fresh one.
    fn forget_token(&self) {
        if let Ok(mut guard) = self.token.lock() {
            *guard = None;
        }
    }

    async fn fetch(&self, token: &str) -> Result<Vec<LiveStream>, String> {
        let query: Vec<(&str, &str)> = self
            .config
            .channels
            .iter()
            .map(|login| ("user_login", login.as_str()))
            .collect();
        let response = self
            .http
            .get(STREAMS_URL)
            .header("Client-Id", self.config.client_id.as_str())
            .bearer_auth(token)
            .query(&query)
            .send()
            .await
            .map_err(|error| format!("could not reach Twitch: {error}"))?;

        let status = response.status();
        if status == reqwest::StatusCode::UNAUTHORIZED {
            // The cached token was rejected. Dropping it means the next poll
            // starts over rather than repeating a request that cannot work.
            self.forget_token();
            return Err("Twitch rejected the application token".into());
        }
        if !status.is_success() {
            return Err(format!("Twitch responded with {status}"));
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|error| format!("could not read Twitch's answer: {error}"))?;
        if bytes.len() > MAX_RESPONSE_BYTES {
            return Err("Twitch's answer was unexpectedly large".into());
        }
        parse_streams(&bytes)
    }
}

#[async_trait]
impl StreamsPort for TwitchStreams {
    async fn list_live(&self) -> Result<Vec<LiveStream>, String> {
        if !self.config.usable() {
            return Ok(Vec::new());
        }
        let token = self.token().await?;
        self.fetch(&token).await
    }

    fn can_check(&self) -> bool {
        self.config.usable()
    }
}

/// Nothing is ever live. Used offline and in tests.
pub struct FakeStreams;

#[async_trait]
impl StreamsPort for FakeStreams {
    async fn list_live(&self) -> Result<Vec<LiveStream>, String> {
        Ok(Vec::new())
    }

    fn can_check(&self) -> bool {
        false
    }
}

#[derive(Deserialize)]
struct TokenResponse {
    #[serde(default)]
    access_token: String,
    #[serde(default)]
    expires_in: u32,
}

/// Helix's `GET /streams` payload, read leniently.
///
/// Every field defaults, because the client's job is not to police Twitch's
/// schema: a stream with no title is a stream, and a field this client has never
/// heard of must not make a live channel look off air.
#[derive(Deserialize)]
struct StreamsResponse {
    #[serde(default)]
    data: Vec<StreamEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
struct StreamEntry {
    #[serde(default)]
    id: String,
    #[serde(default)]
    user_login: String,
    #[serde(default)]
    user_name: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    viewer_count: Option<i32>,
    #[serde(default)]
    started_at: String,
    /// `"live"` for a broadcast, `"vodcast"` for a rerun. Helix only returns
    /// live channels, but it has historically said so in this field, and a rerun
    /// announced as somebody going live would be wrong.
    #[serde(default, rename = "type")]
    kind: String,
}

fn parse_streams(bytes: &[u8]) -> Result<Vec<LiveStream>, String> {
    let response: StreamsResponse = serde_json::from_slice(bytes)
        .map_err(|error| format!("could not read Twitch's answer: {error}"))?;
    Ok(response
        .data
        .into_iter()
        .filter(|entry| entry.kind.is_empty() || entry.kind.eq_ignore_ascii_case("live"))
        .filter(|entry| !entry.user_login.trim().is_empty())
        .map(|entry| {
            let channel = entry.user_login.to_ascii_lowercase();
            LiveStream {
                // Falling back to the channel rather than leaving it empty: the
                // id is what decides whether an announcement has been made, and
                // two empty ids would be the same broadcast.
                id: if entry.id.is_empty() {
                    format!("twitch:{channel}")
                } else {
                    format!("twitch:{}", entry.id)
                },
                platform: StreamPlatform::Twitch,
                url: format!("https://www.twitch.tv/{channel}"),
                display_name: if entry.user_name.trim().is_empty() {
                    channel.clone()
                } else {
                    entry.user_name
                },
                channel,
                title: entry.title,
                viewers: entry.viewer_count,
                started_at: entry.started_at,
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channels_are_a_set_of_lower_case_logins() {
        assert_eq!(split_channels("faflive"), vec!["faflive"]);
        assert_eq!(
            split_channels("FAFLive, someoneelse"),
            vec!["faflive", "someoneelse"],
        );
        // A hash is how people write a channel in chat, and a duplicate is a
        // typo rather than two channels.
        assert_eq!(split_channels("#faflive faflive"), vec!["faflive"]);
        assert!(split_channels("   ").is_empty());
        assert!(split_channels("").is_empty());
    }

    #[test]
    fn a_build_without_credentials_cannot_check() {
        let config = TwitchConfig {
            client_id: String::new(),
            client_secret: "secret".into(),
            channels: vec!["faflive".into()],
        };
        assert!(!config.usable());
        assert!(!TwitchStreams::new(config).can_check());

        let complete = TwitchConfig {
            client_id: "id".into(),
            client_secret: "secret".into(),
            channels: vec!["faflive".into()],
        };
        assert!(complete.usable());
        assert!(TwitchStreams::new(complete).can_check());
    }

    #[test]
    fn a_configured_build_with_no_channels_cannot_check_either() {
        let config = TwitchConfig {
            client_id: "id".into(),
            client_secret: "secret".into(),
            channels: Vec::new(),
        };
        assert!(!config.usable());
    }

    #[tokio::test]
    async fn an_unconfigured_adapter_reports_nothing_rather_than_failing() {
        // The whole point of the inert mode: no credentials is not an error
        // anybody needs to read.
        let streams = TwitchStreams::new(TwitchConfig {
            client_id: String::new(),
            client_secret: String::new(),
            channels: vec!["faflive".into()],
        });
        assert_eq!(streams.list_live().await.unwrap(), Vec::new());
    }

    #[test]
    fn a_live_channel_becomes_a_stream() {
        let body = br#"{"data":[{
            "id":"40952121085",
            "user_login":"FAFLive",
            "user_name":"FAFLive",
            "title":"Setons Summer Slam: Grand Final",
            "viewer_count":412,
            "started_at":"2026-09-11T18:02:00Z",
            "type":"live"
        }],"pagination":{}}"#;

        let streams = parse_streams(body).unwrap();
        assert_eq!(streams.len(), 1);
        let stream = &streams[0];
        assert_eq!(stream.id, "twitch:40952121085");
        assert_eq!(stream.channel, "faflive", "the login is the match key");
        assert_eq!(stream.display_name, "FAFLive");
        assert_eq!(stream.url, "https://www.twitch.tv/faflive");
        assert_eq!(stream.viewers, Some(412));
        assert_eq!(stream.platform, StreamPlatform::Twitch);
    }

    #[test]
    fn an_empty_list_is_nothing_live_rather_than_an_error() {
        assert!(parse_streams(br#"{"data":[],"pagination":{}}"#)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn a_rerun_is_not_somebody_going_live() {
        let body = br#"{"data":[{"id":"1","user_login":"faflive","type":"vodcast"}]}"#;
        assert!(parse_streams(body).unwrap().is_empty());
    }

    #[test]
    fn a_sparse_entry_still_loads() {
        // Leniency belongs at the wire boundary: a stream with no title is a
        // stream, and refusing it would take the badge off a live channel.
        let body = br#"{"data":[{"id":"1","user_login":"faflive"}]}"#;
        let streams = parse_streams(body).unwrap();
        assert_eq!(streams.len(), 1);
        assert_eq!(streams[0].title, "");
        assert_eq!(streams[0].viewers, None);
        assert_eq!(
            streams[0].display_name, "faflive",
            "the login stands in for a missing display name",
        );
    }

    #[test]
    fn an_entry_with_no_channel_is_dropped() {
        // Without a login there is nothing to match against the links list and
        // nowhere to send a viewer.
        let body = br#"{"data":[{"id":"1","user_login":"  "}]}"#;
        assert!(parse_streams(body).unwrap().is_empty());
    }

    #[test]
    fn an_entry_with_no_id_is_still_announceable_once() {
        let body = br#"{"data":[{"user_login":"faflive"}]}"#;
        let streams = parse_streams(body).unwrap();
        assert_eq!(
            streams[0].id, "twitch:faflive",
            "two empty ids would read as the same broadcast",
        );
    }

    #[test]
    fn a_body_that_is_not_twitchs_is_an_error() {
        assert!(parse_streams(b"<html>nope</html>").is_err());
    }
}
