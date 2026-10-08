//! The connectivity check's IO: the adapters on disk, the FAF API's relay
//! list, a STUN binding or a TCP connection per relay URL, and the newest
//! adapter log.
//!
//! # Where the relay addresses come from
//!
//! The FAF API has two ICE routes. `GET /ice/server` needs no game and lists
//! the active relays, but only as an id and a region: nothing in it says where
//! a relay is (the Java client uses it to let a player prefer regions). The
//! addresses come from `GET /ice/session/game/{id}`, which hands out a game's
//! relay session. There is no game-free route to them, and asking for a
//! session of a game this client was never in would be using the API for
//! something it was not offered for.
//!
//! So the check tests the addresses of the last game this client started,
//! which [`IceSessionMemory`] keeps: the Java adapter records the URLs it was
//! given, and Pioneer, which fetches its session itself, records the game so
//! the check can ask for that game's session once. Before the first game of a
//! session there is nothing to test, and the check says so as a line of its
//! own rather than passing silently.
//!
//! Only the URLs are kept, never the TURN credentials beside them: a binding
//! request needs none, and they are short-lived secrets.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use faf_domain::protocol::stun::{self, IceTransport, IceUrl, StunError};
use faf_domain::state::ProbeFailure;
use serde_json::Value;
use tokio::net::{TcpStream, UdpSocket};

use crate::infra::ice_java::{self, IceSessionError};
use crate::infra::session::TokenStore;
use crate::infra::{env_or, ice_pioneer, ice_select, java_runtime};
use crate::ports::{
    AdapterInventory, AdapterLogTail, ConnectivityPort, JavaAdapterJar, JavaRuntimeInfo,
    JavaRuntimeProblem, KnownRelayAddresses, ProbeAnswer, RelayAddresses, RelayListError,
    RelayServer,
};

/// How long a relay name may take to resolve.
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(3);
/// The waits between STUN retransmissions. RFC 5389 starts at 500 ms and
/// doubles; three tries over three seconds is enough to tell a lost datagram
/// from a blocked port without making the check feel stuck.
const STUN_WAITS: [Duration; 3] = [
    Duration::from_millis(500),
    Duration::from_millis(1000),
    Duration::from_millis(1500),
];
const TCP_CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
/// The API answers in well under a second; this only stops a stalled request
/// from holding the check.
const API_TIMEOUT: Duration = Duration::from_secs(10);
/// How much of the newest adapter log the check shows. The Java adapter logs
/// at DEBUG, so this is the last minute or so of a game, which is where a
/// failed connection ends up.
const LOG_TAIL_BYTES: u64 = 16 * 1024;
const LOG_TAIL_LINES: usize = 120;

/// The relay URLs of the last game this client started, shared by the
/// adapters (which write it) and the connectivity check (which reads it).
#[derive(Clone, Default)]
pub struct IceSessionMemory(Arc<Mutex<Option<Remembered>>>);

#[derive(Clone)]
struct Remembered {
    game_id: i32,
    /// `None` while only the game is known: Pioneer's own sessions.
    urls: Option<Vec<String>>,
}

impl IceSessionMemory {
    /// A game started; its URLs, if they were remembered for an earlier game,
    /// no longer describe it.
    pub(crate) fn remember_game(&self, game_id: i32) {
        let mut held = self.0.lock().unwrap();
        if held.as_ref().is_some_and(|held| held.game_id == game_id) {
            return;
        }
        *held = Some(Remembered {
            game_id,
            urls: None,
        });
    }

    /// The ICE servers of `game_id`'s session, as the API sent them.
    pub(crate) fn remember_servers(&self, game_id: i32, servers: &[Value]) {
        *self.0.lock().unwrap() = Some(Remembered {
            game_id,
            urls: Some(urls_of(servers)),
        });
    }

    /// The ICE servers of `game_id`'s session, fetched by the check after
    /// the game started: kept only while `game_id` is still the last game.
    /// The check's request can outlive the start of the next game, and its
    /// answer used to put the earlier game back, so every later check
    /// probed that game's relays and never asked about the new one.
    fn fill_in_servers(&self, game_id: i32, servers: &[Value]) {
        if let Some(held) = self.0.lock().unwrap().as_mut() {
            if held.game_id == game_id {
                held.urls = Some(urls_of(servers));
            }
        }
    }

    fn recall(&self) -> Option<Remembered> {
        self.0.lock().unwrap().clone()
    }
}

/// The URLs in a list of WebRTC-style ICE servers: each carries `urls`, a
/// string or a list of them (`url` in older documents). Duplicates are
/// dropped and the order kept.
pub(crate) fn urls_of(servers: &[Value]) -> Vec<String> {
    let mut urls: Vec<String> = Vec::new();
    for server in servers {
        let listed = server.get("urls").or_else(|| server.get("url"));
        let found: Vec<&str> = match listed {
            Some(Value::String(url)) => vec![url.as_str()],
            Some(Value::Array(list)) => list.iter().filter_map(Value::as_str).collect(),
            _ => Vec::new(),
        };
        for url in found {
            let url = url.trim();
            if !url.is_empty() && !urls.iter().any(|held| held == url) {
                urls.push(url.to_string());
            }
        }
    }
    urls
}

/// The real check.
pub struct ConnectivityProbe {
    tokens: TokenStore,
    http: reqwest::Client,
    api_base: String,
    memory: IceSessionMemory,
    log_dir: PathBuf,
}

impl ConnectivityProbe {
    pub fn new(
        tokens: TokenStore,
        memory: IceSessionMemory,
        api_base: impl Into<String>,
        log_dir: PathBuf,
    ) -> Self {
        Self {
            tokens,
            http: super::http::shared_http_client(),
            api_base: api_base.into(),
            memory,
            log_dir,
        }
    }

    pub fn faf(tokens: TokenStore, memory: IceSessionMemory) -> Self {
        Self::new(
            tokens,
            memory,
            env_or("FAF_API_BASE", "https://api.faforever.com"),
            ice_java::log_directory(),
        )
    }
}

#[async_trait]
impl ConnectivityPort for ConnectivityProbe {
    async fn adapter_inventory(&self) -> AdapterInventory {
        // The same resolution the launch uses, so the check cannot vouch for
        // a runtime or an adapter the launch would not find.
        let java_path = java_runtime::preferred_java_path();
        let java_runtime = match java_runtime::query_java_version(&java_path).await {
            Ok((version, major)) => Ok(JavaRuntimeInfo {
                path: java_path,
                version,
                major,
            }),
            Err(reason) => Err(JavaRuntimeProblem {
                path: java_path,
                reason,
            }),
        };

        let jar = ice_java::default_jar_path();
        let java_adapter = if jar.is_empty() || !Path::new(&jar).is_file() {
            None
        } else {
            let read = PathBuf::from(&jar);
            let required_java =
                tokio::task::spawn_blocking(move || java_runtime::jar_required_java(&read))
                    .await
                    .ok()
                    .flatten();
            Some(JavaAdapterJar {
                path: jar,
                required_java,
            })
        };

        let pioneer = ice_pioneer::IceConfig::faf().adapter_path;
        let pioneer = Path::new(&pioneer).is_file().then_some(pioneer);

        AdapterInventory {
            forced: ice_select::adapter_override(),
            java_runtime,
            java_adapter,
            pioneer,
        }
    }

    async fn relay_list(&self) -> Result<Vec<RelayServer>, RelayListError> {
        let Some(token) = self.tokens.get() else {
            return Err(RelayListError::NeedsSignIn);
        };
        let url = format!("{}/ice/server", self.api_base.trim_end_matches('/'));
        let response = self
            .http
            .get(&url)
            .bearer_auth(token)
            .header(reqwest::header::ACCEPT, "application/json")
            .timeout(API_TIMEOUT)
            .send()
            .await
            .map_err(|error| RelayListError::Unavailable(format!("request failed: {error}")))?;
        let status = response.status();
        if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
            return Err(RelayListError::NeedsSignIn);
        }
        if !status.is_success() {
            return Err(RelayListError::Unavailable(format!(
                "the API answered {status}"
            )));
        }
        let body: Value = response.json().await.map_err(|error| {
            RelayListError::Unavailable(format!("the answer was not JSON: {error}"))
        })?;
        Ok(parse_relay_list(&body))
    }

    async fn relay_addresses(&self) -> KnownRelayAddresses {
        let Some(remembered) = self.memory.recall() else {
            return KnownRelayAddresses::None;
        };
        let game_id = remembered.game_id;
        if let Some(urls) = remembered.urls {
            return KnownRelayAddresses::Known(RelayAddresses { game_id, urls });
        }
        let Some(token) = self.tokens.get() else {
            return KnownRelayAddresses::Unavailable {
                game_id,
                reason: "not signed in".into(),
            };
        };
        // Once, without the launch's retries: a check that waits twenty
        // seconds on a busy API answers nothing the error does not.
        let fetched = tokio::time::timeout(
            API_TIMEOUT,
            ice_java::fetch_ice_servers(&self.http, &self.api_base, &token, game_id),
        )
        .await;
        match fetched {
            Ok(Ok(session)) => {
                self.memory.fill_in_servers(game_id, &session.servers);
                KnownRelayAddresses::Known(RelayAddresses {
                    game_id,
                    urls: urls_of(&session.servers),
                })
            }
            Ok(Err(IceSessionError::Busy(reason) | IceSessionError::Failed(reason))) => {
                KnownRelayAddresses::Unavailable { game_id, reason }
            }
            Err(_) => KnownRelayAddresses::Unavailable {
                game_id,
                reason: "the API did not answer in time".into(),
            },
        }
    }

    async fn probe(&self, url: &IceUrl) -> Result<ProbeAnswer, ProbeFailure> {
        let address = resolve(&url.host, url.port).await?;
        match url.transport {
            IceTransport::Udp => stun_binding(address).await,
            IceTransport::Tcp | IceTransport::Tls => tcp_connect(address).await,
        }
    }

    async fn adapter_log(&self) -> Option<AdapterLogTail> {
        let directory = self.log_dir.clone();
        tokio::task::spawn_blocking(move || newest_log_tail(&directory))
            .await
            .ok()
            .flatten()
    }
}

/// `{ "servers": [{ "id": ..., "region": ... }] }`. Ids are numbers in some
/// API versions and strings in others, so both are read.
fn parse_relay_list(body: &Value) -> Vec<RelayServer> {
    body.get("servers")
        .and_then(Value::as_array)
        .map(|servers| {
            servers
                .iter()
                .map(|server| RelayServer {
                    id: match server.get("id") {
                        Some(Value::String(id)) => id.clone(),
                        Some(Value::Number(id)) => id.to_string(),
                        _ => String::new(),
                    },
                    region: server
                        .get("region")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// One address for the relay, IPv4 first: the adapters and most home
/// connections reach the relays over IPv4, so that is the path worth testing.
async fn resolve(host: &str, port: u16) -> Result<SocketAddr, ProbeFailure> {
    let found = tokio::time::timeout(RESOLVE_TIMEOUT, tokio::net::lookup_host((host, port)))
        .await
        .map_err(|_| ProbeFailure::Timeout {
            waited_ms: millis(RESOLVE_TIMEOUT),
        })?
        .map_err(|_| ProbeFailure::UnknownHost)?;
    let addresses: Vec<SocketAddr> = found.collect();
    addresses
        .iter()
        .find(|address| address.is_ipv4())
        .or_else(|| addresses.first())
        .copied()
        .ok_or(ProbeFailure::UnknownHost)
}

fn millis(duration: Duration) -> u32 {
    u32::try_from(duration.as_millis()).unwrap_or(u32::MAX)
}

/// The OS reports "nothing listens on that UDP port" (an ICMP port
/// unreachable) as a reset or a refusal on the next receive.
fn refused(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::ConnectionReset
    )
}

async fn stun_binding(address: SocketAddr) -> Result<ProbeAnswer, ProbeFailure> {
    let local = if address.is_ipv4() {
        "0.0.0.0:0"
    } else {
        "[::]:0"
    };
    let network = |error: std::io::Error| ProbeFailure::Network {
        reason: error.to_string(),
    };
    let socket = UdpSocket::bind(local).await.map_err(network)?;
    // Connected, so only the relay's datagrams are read.
    socket.connect(address).await.map_err(network)?;
    let transaction: stun::TransactionId = rand::random();
    let request = stun::binding_request(&transaction);
    let mut buffer = [0u8; 1500];

    for wait in STUN_WAITS {
        let sent_at = Instant::now();
        if let Err(error) = socket.send(&request).await {
            return Err(if refused(&error) {
                ProbeFailure::Refused
            } else {
                network(error)
            });
        }
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            let received = match tokio::time::timeout_at(deadline, socket.recv(&mut buffer)).await {
                // Retransmit.
                Err(_) => break,
                Ok(Err(error)) if refused(&error) => return Err(ProbeFailure::Refused),
                Ok(Err(error)) => return Err(network(error)),
                Ok(Ok(received)) => received,
            };
            match stun::parse_binding_response(&buffer[..received], &transaction) {
                Ok(success) => {
                    return Ok(ProbeAnswer::Binding {
                        round_trip_ms: millis(sent_at.elapsed()),
                        public_address: success.mapped,
                    })
                }
                // A stray datagram: keep listening for the real answer.
                Err(StunError::NotStun | StunError::WrongTransaction) => continue,
                Err(other) => {
                    return Err(ProbeFailure::BadAnswer {
                        reason: other.to_string(),
                    })
                }
            }
        }
    }
    Err(ProbeFailure::Timeout {
        waited_ms: millis(STUN_WAITS.iter().sum()),
    })
}

async fn tcp_connect(address: SocketAddr) -> Result<ProbeAnswer, ProbeFailure> {
    let started = Instant::now();
    match tokio::time::timeout(TCP_CONNECT_TIMEOUT, TcpStream::connect(address)).await {
        Ok(Ok(_stream)) => Ok(ProbeAnswer::Connected {
            round_trip_ms: millis(started.elapsed()),
        }),
        Ok(Err(error)) if error.kind() == std::io::ErrorKind::ConnectionRefused => {
            Err(ProbeFailure::Refused)
        }
        Ok(Err(error)) => Err(ProbeFailure::Network {
            reason: error.to_string(),
        }),
        Err(_) => Err(ProbeFailure::Timeout {
            waited_ms: millis(TCP_CONNECT_TIMEOUT),
        }),
    }
}

/// The end of the newest `.log` file in `directory`.
fn newest_log_tail(directory: &Path) -> Option<AdapterLogTail> {
    use std::io::{Read, Seek, SeekFrom};

    let (path, modified) = std::fs::read_dir(directory)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|extension| extension == "log"))
        .filter_map(|path| {
            let modified = path.metadata().ok()?.modified().ok()?;
            Some((path, modified))
        })
        .max_by_key(|(_, modified)| *modified)?;

    let mut file = std::fs::File::open(&path).ok()?;
    let length = file.metadata().ok()?.len();
    let start = length.saturating_sub(LOG_TAIL_BYTES);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    let (tail, truncated) = tail_lines(&bytes, start > 0, LOG_TAIL_LINES);

    Some(AdapterLogTail {
        file_name: path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("ice-adapter.log")
            .to_string(),
        modified_at: chrono::DateTime::<chrono::Utc>::from(modified).to_rfc3339(),
        tail,
        truncated,
    })
}

/// The last `max_lines` lines of `bytes`. When the bytes start mid-file their
/// first line is a fragment and is dropped. Says whether anything was left
/// out.
fn tail_lines(bytes: &[u8], mid_file: bool, max_lines: usize) -> (String, bool) {
    let text = String::from_utf8_lossy(bytes);
    let mut text = text.as_ref();
    let mut truncated = mid_file;
    if mid_file {
        text = text.split_once('\n').map_or("", |(_, rest)| rest);
    }
    let lines: Vec<&str> = text.lines().collect();
    if lines.len() > max_lines {
        truncated = true;
    }
    let kept = &lines[lines.len().saturating_sub(max_lines)..];
    (kept.join("\n"), truncated)
}

/// The offline check: every adapter present, two relays listed, both
/// answering. What `FAF_FAKE_AUTH=1` shows, so the view can be worked on
/// without a network; the addresses are from the documentation ranges.
pub struct FakeConnectivity;

#[async_trait]
impl ConnectivityPort for FakeConnectivity {
    async fn adapter_inventory(&self) -> AdapterInventory {
        AdapterInventory {
            forced: None,
            java_runtime: Ok(JavaRuntimeInfo {
                path: "natives/jre/bin/java".into(),
                version: Some("25.0.3".into()),
                major: Some(25),
            }),
            java_adapter: Some(JavaAdapterJar {
                path: "natives/java-ice-adapter/faf-ice-adapter.jar".into(),
                required_java: Some(21),
            }),
            pioneer: Some("natives/faf-pioneer".into()),
        }
    }

    async fn relay_list(&self) -> Result<Vec<RelayServer>, RelayListError> {
        Ok(vec![
            RelayServer {
                id: "1".into(),
                region: "Europe".into(),
            },
            RelayServer {
                id: "2".into(),
                region: "North America".into(),
            },
        ])
    }

    async fn relay_addresses(&self) -> KnownRelayAddresses {
        KnownRelayAddresses::Known(RelayAddresses {
            game_id: 1,
            urls: vec![
                "stun:relay.example.org".into(),
                "turn:relay.example.org?transport=tcp".into(),
            ],
        })
    }

    async fn probe(&self, url: &IceUrl) -> Result<ProbeAnswer, ProbeFailure> {
        Ok(match url.transport {
            IceTransport::Udp => ProbeAnswer::Binding {
                round_trip_ms: 24,
                public_address: Some(SocketAddr::from(([203, 0, 113, 7], 51_234))),
            },
            IceTransport::Tcp | IceTransport::Tls => ProbeAnswer::Connected { round_trip_ms: 31 },
        })
    }

    async fn adapter_log(&self) -> Option<AdapterLogTail> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_the_urls_out_of_a_session_and_drops_duplicates() {
        let servers = [
            json!({ "id": "eu", "urls": ["turn:eu.example.org?transport=tcp", "turn:eu.example.org?transport=udp", "stun:eu.example.org"], "username": "u", "credential": "c" }),
            json!({ "url": "stun:eu.example.org" }),
            json!({ "urls": "turn:us.example.org" }),
            json!({ "credential": "no urls at all" }),
        ];
        assert_eq!(
            urls_of(&servers),
            vec![
                "turn:eu.example.org?transport=tcp",
                "turn:eu.example.org?transport=udp",
                "stun:eu.example.org",
                "turn:us.example.org",
            ]
        );
    }

    #[test]
    fn the_memory_forgets_urls_that_belong_to_another_game() {
        let memory = IceSessionMemory::default();
        assert!(memory.recall().is_none());
        memory.remember_servers(5, &[json!({ "urls": ["stun:a.example.org"] })]);
        memory.remember_game(5);
        assert_eq!(
            memory.recall().unwrap().urls,
            Some(vec!["stun:a.example.org".to_string()]),
            "the same game keeps its URLs"
        );
        memory.remember_game(6);
        let recalled = memory.recall().unwrap();
        assert_eq!((recalled.game_id, recalled.urls), (6, None));
    }

    /// The check asked for game 5's session, and game 6 started before the
    /// answer came. The answer was remembered as the last game's, so every
    /// later check probed game 5's relays and never asked about game 6.
    #[tokio::test]
    async fn a_session_answer_that_lands_after_the_next_game_started_is_not_kept() {
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let api_base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let (asked_for, asked) = tokio::sync::oneshot::channel::<String>();
        let (answer, answer_held) = tokio::sync::oneshot::channel::<()>();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut head = Vec::new();
            let mut chunk = [0_u8; 1024];
            while !head.windows(4).any(|window| window == b"\r\n\r\n") {
                match stream.read(&mut chunk).await {
                    Ok(0) | Err(_) => return,
                    Ok(read) => head.extend_from_slice(&chunk[..read]),
                }
            }
            let path = String::from_utf8_lossy(&head)
                .split(' ')
                .nth(1)
                .unwrap_or_default()
                .to_string();
            let _ = asked_for.send(path);
            let _ = answer_held.await;
            let body = r#"{"servers":[{"urls":["stun:old.example.org"]}]}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes()).await;
            let _ = stream.shutdown().await;
        });

        let tokens = TokenStore::new();
        tokens.set("token");
        let memory = IceSessionMemory::default();
        // Pioneer's game: only the game is known.
        memory.remember_game(5);
        let probe = Arc::new(ConnectivityProbe {
            tokens,
            // A loopback test is not routed through a developer's proxy.
            http: reqwest::Client::builder().no_proxy().build().unwrap(),
            api_base,
            memory: memory.clone(),
            log_dir: PathBuf::new(),
        });
        let check = {
            let probe = probe.clone();
            tokio::spawn(async move { probe.relay_addresses().await })
        };
        assert_eq!(asked.await.unwrap(), "/ice/session/game/5");

        memory.remember_game(6);
        answer.send(()).unwrap();

        // This check reports the game it asked about...
        assert_eq!(
            check.await.unwrap(),
            KnownRelayAddresses::Known(RelayAddresses {
                game_id: 5,
                urls: vec!["stun:old.example.org".to_string()],
            })
        );
        // ...and the next one asks about game 6.
        let recalled = memory.recall().unwrap();
        assert_eq!((recalled.game_id, recalled.urls), (6, None));
    }

    #[test]
    fn reads_the_relay_list_whichever_way_the_ids_are_written() {
        let body = json!({ "servers": [{ "id": 1, "region": "Europe" }, { "id": "us-1", "region": "North America" }] });
        assert_eq!(
            parse_relay_list(&body),
            vec![
                RelayServer {
                    id: "1".into(),
                    region: "Europe".into()
                },
                RelayServer {
                    id: "us-1".into(),
                    region: "North America".into()
                },
            ]
        );
        assert!(parse_relay_list(&json!({})).is_empty());
    }

    #[test]
    fn a_log_tail_drops_the_fragment_it_starts_in() {
        let (tail, truncated) = tail_lines(b"ment of a line\nfirst\nsecond\n", true, 10);
        assert_eq!(tail, "first\nsecond");
        assert!(truncated);

        let (tail, truncated) = tail_lines(b"one\ntwo\nthree", false, 2);
        assert_eq!(tail, "two\nthree");
        assert!(truncated, "a line was left out");

        let (tail, truncated) = tail_lines(b"one\ntwo", false, 5);
        assert_eq!(tail, "one\ntwo");
        assert!(!truncated);
    }

    #[test]
    fn finds_the_newest_log_in_the_directory() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("notes.txt"), "not a log").unwrap();
        let old = directory.path().join("ice-adapter.2026-10-07.log");
        std::fs::write(&old, "yesterday").unwrap();
        let file = std::fs::File::options().write(true).open(&old).unwrap();
        file.set_modified(std::time::SystemTime::now() - Duration::from_secs(86_400))
            .unwrap();
        std::fs::write(
            directory.path().join("ice-adapter.log"),
            "line one\nline two\n",
        )
        .unwrap();

        let tail = newest_log_tail(directory.path()).expect("a log");
        assert_eq!(tail.file_name, "ice-adapter.log");
        assert_eq!(tail.tail, "line one\nline two");
        assert!(!tail.truncated);
        assert!(newest_log_tail(&directory.path().join("missing")).is_none());
    }

    /// A loopback STUN server answering one binding, so the UDP path is
    /// exercised without leaving the machine.
    #[tokio::test]
    async fn a_binding_to_a_loopback_server_reads_the_mapped_address() {
        let server = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let address = server.local_addr().unwrap();
        tokio::spawn(async move {
            let mut buffer = [0u8; 1500];
            let (received, from) = server.recv_from(&mut buffer).await.unwrap();
            let request = &buffer[..received];
            let mut answer = vec![0x01, 0x01, 0x00, 0x0c];
            answer.extend_from_slice(&request[4..20]);
            let SocketAddr::V4(from) = from else {
                unreachable!("bound to IPv4")
            };
            let port = from.port() ^ 0x2112;
            answer.extend_from_slice(&[0x00, 0x20, 0x00, 0x08, 0x00, 0x01]);
            answer.extend_from_slice(&port.to_be_bytes());
            for (index, octet) in from.ip().octets().iter().enumerate() {
                answer.push(octet ^ stun::MAGIC_COOKIE.to_be_bytes()[index]);
            }
            server.send_to(&answer, from).await.unwrap();
        });

        match stun_binding(address).await {
            Ok(ProbeAnswer::Binding { public_address, .. }) => {
                assert_eq!(public_address.map(|a| a.ip()), Some([127, 0, 0, 1].into()));
            }
            other => panic!("expected a binding, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_closed_tcp_port_is_refused_or_unreachable() {
        // Bound and dropped, so nothing listens on it.
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let result = tcp_connect(SocketAddr::from(([127, 0, 0, 1], port))).await;
        assert!(
            matches!(
                result,
                Err(ProbeFailure::Refused | ProbeFailure::Timeout { .. })
            ),
            "{result:?}"
        );
    }
}
