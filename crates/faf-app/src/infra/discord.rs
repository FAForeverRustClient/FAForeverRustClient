//! Discord Rich Presence over the local IPC socket.
//!
//! Discord exposes a socket on the machine and speaks length-prefixed JSON over
//! it (framing and payloads: [`faf_domain::protocol::discord`]). The socket is
//! a named pipe on Windows and a Unix domain socket elsewhere; Discord numbers
//! them `discord-ipc-0` through `discord-ipc-9` and uses the first free one, so
//! a client tries each in turn.
//!
//! The connection is *expected* to be absent. Most users do not have Discord
//! running, and the ones who do will quit and restart it while the client is
//! open. So there is one long-lived task that reconnects on a timer and
//! republishes whatever the latest presence was; nothing else in the client
//! ever waits on it or learns that it failed.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use faf_domain::protocol::discord::{self, Activity, Decoded, Inbound, Opcode};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, Notify};

use crate::ports::{DiscordPort, DiscordRequest};

/// How long to wait before looking for Discord again. Long enough that a
/// machine without Discord is not probing ten socket paths in a tight loop,
/// short enough that starting Discord mid-session is noticed promptly.
const RECONNECT_DELAY: Duration = Duration::from_secs(15);

/// Discord uses the first free socket, so a client has to try each.
const SOCKET_COUNT: u8 = 10;

#[derive(Debug, Clone)]
pub struct DiscordConfig {
    /// Discord application id: selects the app name and art in the status.
    pub application_id: String,
}

impl DiscordConfig {
    pub fn faf() -> Self {
        Self {
            application_id: crate::infra::env_or(
                "FAF_DISCORD_APPLICATION_ID",
                discord::APPLICATION_ID,
            ),
        }
    }
}

/// The presence to publish, and a revision so a reconnect can tell whether it
/// has already sent the current one.
#[derive(Debug, Default)]
struct Presence {
    activity: Option<Activity>,
    revision: u64,
}

pub struct DiscordClient {
    config: DiscordConfig,
    presence: Arc<Mutex<Presence>>,
    /// Woken when [`Self::set_presence`] stores something new.
    changed: Arc<Notify>,
    nonce: Arc<AtomicU64>,
}

impl DiscordClient {
    pub fn new(config: DiscordConfig) -> Self {
        Self {
            config,
            presence: Arc::new(Mutex::new(Presence::default())),
            changed: Arc::new(Notify::new()),
            nonce: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn faf() -> Self {
        Self::new(DiscordConfig::faf())
    }
}

#[async_trait]
impl DiscordPort for DiscordClient {
    fn set_presence(&self, activity: Option<Activity>) {
        let mut presence = self
            .presence
            .lock()
            .expect("discord presence lock poisoned");
        if presence.activity == activity {
            return; // Nothing changed; don't wake the connection.
        }
        presence.activity = activity;
        presence.revision += 1;
        drop(presence);
        self.changed.notify_one();
    }

    async fn requests(&self) -> mpsc::Receiver<DiscordRequest> {
        let (tx, rx) = mpsc::channel(8);
        let config = self.config.clone();
        let presence = self.presence.clone();
        let changed = self.changed.clone();
        let nonce = self.nonce.clone();

        tokio::spawn(async move {
            loop {
                // A session ends on any transport error, which includes the
                // ordinary case of the user quitting Discord.
                if let Err(reason) = session(&config, &presence, &changed, &nonce, &tx).await {
                    tracing::warn!(%reason, "Discord rich presence disconnected");
                }
                if tx.is_closed() {
                    return; // The client is shutting down.
                }
                tokio::time::sleep(RECONNECT_DELAY).await;
            }
        });

        rx
    }
}

/// One connection, from handshake to failure.
async fn session(
    config: &DiscordConfig,
    presence: &Arc<Mutex<Presence>>,
    changed: &Arc<Notify>,
    nonce: &AtomicU64,
    requests: &mpsc::Sender<DiscordRequest>,
) -> Result<(), String> {
    let stream = connect().await?;
    let (mut reader, mut writer) = tokio::io::split(stream);

    let next_nonce = || format!("faf-{}", nonce.fetch_add(1, Ordering::Relaxed));

    let handshake = discord::encode(
        Opcode::Handshake,
        &discord::handshake(&config.application_id),
    );
    writer
        .write_all(&handshake)
        .await
        .map_err(|e| format!("handshake failed: {e}"))?;

    // Without these, secrets are published but clicking them does nothing.
    for event in [
        discord::EVENT_JOIN,
        discord::EVENT_SPECTATE,
        discord::EVENT_JOIN_REQUEST,
    ] {
        let frame = discord::encode(Opcode::Frame, &discord::subscribe(event, &next_nonce()));
        writer
            .write_all(&frame)
            .await
            .map_err(|e| format!("could not subscribe to {event}: {e}"))?;
    }

    // Republish immediately: a reconnect must restore the status the user
    // already has, not wait for their next game.
    let mut published = publish(&mut writer, presence, &next_nonce()).await?;

    let mut buffer = Vec::with_capacity(discord::MAX_FRAME_BYTES);
    let mut chunk = [0u8; 4096];
    loop {
        tokio::select! {
            read = reader.read(&mut chunk) => {
                let read = read.map_err(|e| format!("read failed: {e}"))?;
                if read == 0 {
                    return Err("Discord closed the connection".into());
                }
                buffer.extend_from_slice(&chunk[..read]);
                handle_frames(&mut buffer, requests).await?;
            }
            _ = changed.notified() => {
                let revision = presence.lock().expect("discord presence lock poisoned").revision;
                if revision != published {
                    published = publish(&mut writer, presence, &next_nonce()).await?;
                }
            }
        }
    }
}

/// Send the current presence, returning the revision that was sent.
async fn publish<W: tokio::io::AsyncWrite + Unpin>(
    writer: &mut W,
    presence: &Arc<Mutex<Presence>>,
    nonce: &str,
) -> Result<u64, String> {
    let (activity, revision) = {
        let presence = presence.lock().expect("discord presence lock poisoned");
        (presence.activity.clone(), presence.revision)
    };
    let payload = discord::set_activity(std::process::id(), activity.as_ref(), nonce);
    writer
        .write_all(&discord::encode(Opcode::Frame, &payload))
        .await
        .map_err(|e| format!("could not publish presence: {e}"))?;
    Ok(revision)
}

/// Drain every complete frame from `buffer`, forwarding the ones that matter.
async fn handle_frames(
    buffer: &mut Vec<u8>,
    requests: &mpsc::Sender<DiscordRequest>,
) -> Result<(), String> {
    loop {
        match discord::decode(buffer) {
            Decoded::Incomplete => return Ok(()),
            // Unrecoverable by construction: a bad length leaves no way to
            // find where the next header starts, so the stream is finished.
            Decoded::Invalid(reason) => return Err(reason.to_string()),
            Decoded::Frame {
                opcode,
                payload,
                consumed,
            } => {
                buffer.drain(..consumed);
                if opcode == Opcode::Close {
                    return Err("Discord sent a close frame".into());
                }
                if let Some(request) = interpret(&payload) {
                    // The consumer is the presence watcher, which handles each
                    // request promptly. A full channel means it is wedged;
                    // dropping beats blocking the socket read loop.
                    let _ = requests.try_send(request);
                }
            }
        }
    }
}

/// Turn one payload into a request, if it is one we act on.
fn interpret(payload: &str) -> Option<DiscordRequest> {
    match discord::parse_inbound(payload)? {
        Inbound::Join { secret } => Some(DiscordRequest::Join {
            game_id: discord::parse_game_secret(&secret)?,
        }),
        Inbound::Spectate { secret } => Some(DiscordRequest::Spectate {
            game_id: discord::parse_game_secret(&secret)?,
        }),
        // Deliberately not answered. The Java client auto-accepts every join
        // request, which is defensible there because it also always publishes
        // a join secret: but accepting on the user's behalf, silently, is a
        // decision this client does not make for them. A friend who has the
        // secret can still join directly; this only skips the "ask first"
        // flow, which without a UI to surface it would be answered by nobody.
        Inbound::JoinRequest { .. } => None,
        Inbound::Ready { user: _ } => {
            tracing::info!("Discord rich presence connected");
            None
        }
        Inbound::Error { code, message } => {
            tracing::warn!(code, %message, "Discord returned an error");
            None
        }
    }
}

#[cfg(windows)]
async fn connect() -> Result<tokio::net::windows::named_pipe::NamedPipeClient, String> {
    use tokio::net::windows::named_pipe::ClientOptions;

    for index in 0..SOCKET_COUNT {
        let path = format!(r"\\.\pipe\discord-ipc-{index}");
        if let Ok(client) = ClientOptions::new().open(&path) {
            return Ok(client);
        }
    }
    Err("Discord is not running".into())
}

#[cfg(unix)]
async fn connect() -> Result<tokio::net::UnixStream, String> {
    use std::path::PathBuf;

    // Discord's socket lives in the runtime dir, but Flatpak and Snap installs
    // nest it one level deeper: the same set the reference implementations
    // probe.
    let base = ["XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP"]
        .iter()
        .find_map(|key| std::env::var(key).ok().filter(|value| !value.is_empty()))
        .unwrap_or_else(|| "/tmp".to_string());
    let bases = [
        PathBuf::from(&base),
        PathBuf::from(&base).join("app/com.discordapp.Discord"),
        PathBuf::from(&base).join("snap.discord"),
    ];

    for dir in &bases {
        for index in 0..SOCKET_COUNT {
            let path = dir.join(format!("discord-ipc-{index}"));
            if let Ok(stream) = tokio::net::UnixStream::connect(&path).await {
                return Ok(stream);
            }
        }
    }
    Err("Discord is not running".into())
}

/// Inert Discord client: used offline and in tests. Publishes nothing and
/// never reports a request, so no presence leaves the machine.
#[derive(Debug, Clone, Default)]
pub struct FakeDiscord;

#[async_trait]
impl DiscordPort for FakeDiscord {
    fn set_presence(&self, _activity: Option<Activity>) {}

    async fn requests(&self) -> mpsc::Receiver<DiscordRequest> {
        let (_tx, rx) = mpsc::channel(1);
        rx
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_join_secret_becomes_a_join_request() {
        assert_eq!(
            interpret(r#"{"evt":"ACTIVITY_JOIN","data":{"secret":"{\"gameId\":42}"}}"#),
            Some(DiscordRequest::Join { game_id: 42 })
        );
        assert_eq!(
            interpret(r#"{"evt":"ACTIVITY_SPECTATE","data":{"secret":"{\"gameId\":7}"}}"#),
            Some(DiscordRequest::Spectate { game_id: 7 })
        );
    }

    #[test]
    fn a_secret_we_did_not_write_is_ignored() {
        // Secrets round-trip through Discord and another app's client could be
        // holding a stale or foreign one. A secret that is not our JSON shape
        // must not become a join attempt for some arbitrary game id.
        assert_eq!(
            interpret(r#"{"evt":"ACTIVITY_JOIN","data":{"secret":"lobby-42"}}"#),
            None
        );
    }

    #[test]
    fn a_join_request_is_not_auto_accepted() {
        assert_eq!(
            interpret(r#"{"evt":"ACTIVITY_JOIN_REQUEST","data":{"user":{"id":"9"}}}"#),
            None
        );
    }

    #[tokio::test]
    async fn frames_split_across_reads_are_reassembled() {
        let (tx, mut rx) = mpsc::channel(4);
        let frame = discord::encode(
            Opcode::Frame,
            r#"{"evt":"ACTIVITY_JOIN","data":{"secret":"{\"gameId\":5}"}}"#,
        );

        // Arrive one byte at a time: a socket read boundary can fall anywhere.
        let mut buffer = Vec::new();
        for byte in &frame {
            buffer.push(*byte);
            handle_frames(&mut buffer, &tx).await.unwrap();
        }

        assert_eq!(rx.try_recv(), Ok(DiscordRequest::Join { game_id: 5 }));
        assert!(buffer.is_empty(), "a handled frame must be consumed");
    }

    #[tokio::test]
    async fn two_frames_in_one_read_are_both_handled() {
        let (tx, mut rx) = mpsc::channel(4);
        let mut buffer = discord::encode(
            Opcode::Frame,
            r#"{"evt":"ACTIVITY_JOIN","data":{"secret":"{\"gameId\":1}"}}"#,
        );
        buffer.extend(discord::encode(
            Opcode::Frame,
            r#"{"evt":"ACTIVITY_SPECTATE","data":{"secret":"{\"gameId\":2}"}}"#,
        ));

        handle_frames(&mut buffer, &tx).await.unwrap();
        assert_eq!(rx.try_recv(), Ok(DiscordRequest::Join { game_id: 1 }));
        assert_eq!(rx.try_recv(), Ok(DiscordRequest::Spectate { game_id: 2 }));
    }

    #[tokio::test]
    async fn a_close_frame_ends_the_session() {
        let (tx, _rx) = mpsc::channel(4);
        let mut buffer = discord::encode(Opcode::Close, "{}");
        assert!(handle_frames(&mut buffer, &tx).await.is_err());
    }

    #[tokio::test]
    async fn a_corrupt_length_ends_the_session_rather_than_desyncing() {
        let (tx, _rx) = mpsc::channel(4);
        let mut buffer = 1u32.to_le_bytes().to_vec();
        buffer.extend(u32::MAX.to_le_bytes());
        assert!(handle_frames(&mut buffer, &tx).await.is_err());
    }

    #[tokio::test]
    async fn publishing_writes_a_framed_set_activity() {
        let presence = Arc::new(Mutex::new(Presence {
            activity: Some(Activity {
                state: "Hosting".into(),
                details: "faf | test".into(),
                ..Activity::default()
            }),
            revision: 3,
        }));

        let mut written = Vec::new();
        let revision = publish(&mut written, &presence, "n1").await.unwrap();
        assert_eq!(revision, 3);

        let Decoded::Frame {
            opcode, payload, ..
        } = discord::decode(&written)
        else {
            panic!("expected a complete frame");
        };
        assert_eq!(opcode, Opcode::Frame);
        assert!(payload.contains("SET_ACTIVITY"));
        assert!(payload.contains("Hosting"));
    }

    #[test]
    fn an_unchanged_presence_does_not_bump_the_revision() {
        // Presence is recomputed on every lobby snapshot: several a second in
        // a busy lobby. Without this, each one would be a socket write.
        let client = DiscordClient::new(DiscordConfig {
            application_id: "test".into(),
        });
        let activity = Activity {
            state: "Playing".into(),
            ..Activity::default()
        };

        client.set_presence(Some(activity.clone()));
        let first = client.presence.lock().unwrap().revision;
        client.set_presence(Some(activity));
        assert_eq!(client.presence.lock().unwrap().revision, first);

        client.set_presence(None);
        assert_eq!(client.presence.lock().unwrap().revision, first + 1);
    }

    #[tokio::test]
    async fn the_fake_never_reports_a_request() {
        FakeDiscord.set_presence(Some(Activity::default()));
        let mut rx = FakeDiscord.requests().await;
        assert!(rx.try_recv().is_err());
    }
}
