//! Real ICE adapter provider — runs FAF's Go adapter `faf-pioneer`.
//!
//! Mirrors the Python client's `GoProcessArguments` (`IceAdapterProcess.py`): we
//! spawn the single Go binary with the player/game identity, the OAuth access
//! token, the FAF API `/ice` root, and the two GPGNet ports (the one the adapter
//! opens for the game, and our relay server it connects back to). The adapter does
//! its own ICE-server negotiation, so there is no JSON-RPC and no ICE-servers poll.
//!
//! This backend owns the GPGNet relay server internally and exposes the unified
//! [`ConnectivitySession`]: it decodes the adapter's GPGNet stream into
//! [`RelayMsg`]s for the lobby, injects the Go-only `CreateLobby` reply on the
//! game's `Idle` state, and encodes lobby messages back to the adapter.
//!
//! The binary is located via `FAF_ICE_ADAPTER_PATH` (default `faf-pioneer[.exe]`).
//! Opt-in via `FAF_REAL_LAUNCH=1`; the [`FakeIce`] default keeps the app runnable
//! without the binary.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use faf_domain::protocol::gpgnet::{GpgArg, GpgMessage};
use serde_json::Value;
use tokio::process::{Child, Command};
use tokio::sync::mpsc;

use crate::infra::free_port;
use crate::infra::relay::GpgRelayServer;
use crate::infra::session::TokenStore;
use crate::ports::{ConnectivitySession, IceParams, IcePort, RelayMsg, RelayPort};

/// Configuration for the real adapter.
#[derive(Debug, Clone)]
pub struct IceConfig {
    /// Path to the `faf-pioneer` executable.
    pub adapter_path: String,
    /// FAF API base (`api.faforever.com`); the adapter's `--api-root` is this + `/ice`.
    pub api_base: String,
    /// Directory for adapter logs (`--log-path`).
    pub log_path: String,
}

impl IceConfig {
    pub fn faf() -> Self {
        Self {
            adapter_path: env_or("FAF_ICE_ADAPTER_PATH", default_adapter_path()),
            api_base: env_or("FAF_API_BASE", "https://api.faforever.com"),
            log_path: default_log_path(),
        }
    }
}

fn env_or(key: &str, fallback: impl Into<String>) -> String {
    std::env::var(key)
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| fallback.into())
}

fn default_adapter_path() -> &'static str {
    if cfg!(windows) {
        "faf-pioneer.exe"
    } else {
        "faf-pioneer"
    }
}

fn default_log_path() -> String {
    std::env::temp_dir()
        .join("forge-client")
        .join("iceAdapterLogs")
        .to_string_lossy()
        .into_owned()
}

pub struct PioneerAdapter {
    config: IceConfig,
    tokens: TokenStore,
    child: Arc<Mutex<Option<Child>>>,
    relay: GpgRelayServer,
}

impl PioneerAdapter {
    pub fn new(config: IceConfig, tokens: TokenStore) -> Self {
        Self {
            config,
            tokens,
            child: Arc::new(Mutex::new(None)),
            relay: GpgRelayServer::default(),
        }
    }

    pub fn faf(tokens: TokenStore) -> Self {
        Self::new(IceConfig::faf(), tokens)
    }
}

#[async_trait]
impl IcePort for PioneerAdapter {
    async fn start(&self, params: IceParams) -> Result<ConnectivitySession, String> {
        let Some(token) = self.tokens.get() else {
            return Err("no access token (not logged in?)".into());
        };
        let _ = std::fs::create_dir_all(&self.config.log_path);

        // GPGNet relay server (the adapter's --gpgnet-client-port) + a free port
        // the adapter opens for the game (--gpgnet-port).
        let relay = self.relay.start().await?;
        let game_port = free_port().ok_or("could not reserve a game port")?;

        let api_root = format!("{}/ice", self.config.api_base.trim_end_matches('/'));
        let args: Vec<String> = vec![
            "--user-id".into(),
            params.player_id.to_string(),
            "--user-name".into(),
            params.player_login.clone(),
            "--game-id".into(),
            params.game_id.to_string(),
            "--access-token".into(),
            token,
            "--api-root".into(),
            api_root,
            "--gpgnet-port".into(),
            game_port.to_string(),
            "--gpgnet-client-port".into(),
            relay.port.to_string(),
            "--log-level".into(),
            "-1".into(),
            "--log-path".into(),
            self.config.log_path.clone(),
        ];

        // Never log the token.
        eprintln!(
            "[ice] starting {} (game {} gpgnet:{} client:{})",
            self.config.adapter_path, params.game_id, game_port, relay.port
        );

        let mut child = Command::new(&self.config.adapter_path)
            .args(&args)
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("could not start '{}': {e}", self.config.adapter_path))?;

        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                use tokio::io::{AsyncBufReadExt, BufReader};
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    eprintln!("[ice] {line}");
                }
            });
        }
        if let Some(prev) = self.child.lock().unwrap().replace(child) {
            drop(prev);
        }

        // Bridge the adapter's GPGNet relay (GpgMessage) to the lobby (RelayMsg).
        let (to_lobby_tx, to_lobby_rx) = mpsc::channel::<RelayMsg>(64);
        let (from_lobby_tx, mut from_lobby_rx) = mpsc::channel::<RelayMsg>(64);

        // adapter → lobby (+ local CreateLobby on Idle).
        let mut from_adapter = relay.from_adapter;
        let to_adapter = relay.to_adapter;
        let create_lobby_sink = to_adapter.clone();
        let init_mode = params.init_mode;
        let player_login = params.player_login.clone();
        let player_id = params.player_id;
        tokio::spawn(async move {
            while let Some(message) = from_adapter.recv().await {
                // Go-only: the client answers the game's `GameState: Idle` with
                // `CreateLobby` so FA builds its in-game lobby (the Java adapter
                // does this itself). Without it the game waits on a black screen.
                if is_game_state(&message, "Idle") {
                    let create = GpgMessage::new(
                        "CreateLobby",
                        vec![
                            GpgArg::Int(init_mode),
                            GpgArg::Int(0),
                            GpgArg::Str(player_login.clone()),
                            GpgArg::Int(player_id),
                            GpgArg::Int(1),
                        ],
                    );
                    let _ = create_lobby_sink.try_send(create);
                }
                let relay_msg = RelayMsg {
                    command: message.command,
                    args: json_from_gpg_args(&message.args),
                };
                if to_lobby_tx.send(relay_msg).await.is_err() {
                    break; // launcher gone
                }
            }
        });

        // lobby → adapter.
        tokio::spawn(async move {
            while let Some(msg) = from_lobby_rx.recv().await {
                let gpg = GpgMessage {
                    command: msg.command,
                    args: msg.args.iter().map(gpg_arg_from_json).collect(),
                };
                if to_adapter.send(gpg).await.is_err() {
                    break; // relay gone
                }
            }
        });

        Ok(ConnectivitySession {
            game_port,
            to_lobby: to_lobby_rx,
            from_lobby: from_lobby_tx,
        })
    }

    fn stop(&self) {
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.start_kill();
        }
        self.relay.stop();
    }
}

/// Whether a message is `GameState` carrying the given state string.
fn is_game_state(message: &GpgMessage, state: &str) -> bool {
    message.command == "GameState"
        && matches!(message.args.first(), Some(GpgArg::Str(s)) if s == state)
}

fn gpg_arg_from_json(value: &Value) -> GpgArg {
    match value {
        Value::Number(n) if n.is_i64() => GpgArg::Int(n.as_i64().unwrap_or(0) as i32),
        Value::String(s) => GpgArg::Str(s.clone()),
        // Floats/bools/objects aren't part of the GPGNet arg space; stringify so
        // nothing is silently dropped.
        other => GpgArg::Str(other.to_string()),
    }
}

fn json_from_gpg_args(args: &[GpgArg]) -> Vec<Value> {
    args.iter()
        .map(|arg| match arg {
            GpgArg::Int(n) => Value::from(*n),
            GpgArg::Str(s) => Value::from(s.clone()),
        })
        .collect()
}

/// Inert ICE port — used offline and in tests. Yields a session whose channels
/// carry nothing, so the launcher's pump idles and nothing real starts.
#[derive(Debug, Clone, Default)]
pub struct FakeIce;

#[async_trait]
impl IcePort for FakeIce {
    async fn start(&self, _params: IceParams) -> Result<ConnectivitySession, String> {
        let (_to_lobby_tx, to_lobby_rx) = mpsc::channel::<RelayMsg>(1);
        let (from_lobby_tx, _from_lobby_rx) = mpsc::channel::<RelayMsg>(1);
        Ok(ConnectivitySession {
            game_port: 0,
            to_lobby: to_lobby_rx,
            from_lobby: from_lobby_tx,
        })
    }
    fn stop(&self) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_game_state_idle() {
        let idle = GpgMessage::new("GameState", vec![GpgArg::Str("Idle".into())]);
        assert!(is_game_state(&idle, "Idle"));
        assert!(!is_game_state(&idle, "Lobby"));
        assert!(!is_game_state(&GpgMessage::new("GameFull", vec![]), "Idle"));
    }

    #[test]
    fn gpg_json_roundtrip_preserves_types() {
        let json = vec![Value::from(42), Value::from("peer")];
        let gpg: Vec<GpgArg> = json.iter().map(gpg_arg_from_json).collect();
        assert_eq!(gpg, vec![GpgArg::Int(42), GpgArg::Str("peer".into())]);
        assert_eq!(json_from_gpg_args(&gpg), json);
    }
}
