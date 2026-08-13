//! Real ICE adapter provider — runs FAF's Java adapter `faf-ice-adapter`.
//!
//! Unlike the Go adapter (a GPGNet relay), the Java adapter is driven over
//! **JSON-RPC** ([`jsonrpc`](crate::infra::jsonrpc)) and **hosts the GPGNet port
//! for the game itself** (so there is no relay server, and the adapter — not us —
//! answers `CreateLobby`). It also does not fetch ICE servers itself, so we poll
//! `GET {api}/ice/session/game/{id}` and push them via `setIceServers`. Mirrors the
//! Python client's `IceAdapterClient.py` / `IceAdapterProcess.py` / `IceServersPoller.py`.
//!
//! Located via `FAF_ICE_ADAPTER_JAR` (the `.jar`) + `FAF_JAVA_PATH` (default `java`).
//! Opt-in via `FAF_REAL_LAUNCH=1` with `FAF_ICE_ADAPTER_KIND=java` (the default kind).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::Value;
use tokio::process::{Child, Command};
use tokio::sync::mpsc;

use crate::infra::free_port;
use crate::infra::jsonrpc::{JsonRpcClient, RpcNotification};
use crate::infra::session::TokenStore;
use crate::ports::{ConnectivitySession, IceParams, IcePort, RelayMsg};

/// How long to wait for the adapter's RPC port to come up.
const RPC_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone)]
pub struct JavaConfig {
    /// Path to the `java` executable.
    pub java_path: String,
    /// Path to `faf-ice-adapter.jar`.
    pub jar_path: String,
    /// FAF API base (`api.faforever.com`); ICE servers come from `{base}/ice/session/game/{id}`.
    pub api_base: String,
}

impl JavaConfig {
    pub fn faf() -> Self {
        Self {
            java_path: env_or("FAF_JAVA_PATH", "java"),
            jar_path: std::env::var("FAF_ICE_ADAPTER_JAR").unwrap_or_default(),
            api_base: env_or("FAF_API_BASE", "https://api.faforever.com"),
        }
    }
}

fn env_or(key: &str, fallback: impl Into<String>) -> String {
    std::env::var(key)
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| fallback.into())
}

pub struct JavaAdapter {
    config: JavaConfig,
    tokens: TokenStore,
    http: reqwest::Client,
    child: Arc<Mutex<Option<Child>>>,
    rpc: Arc<Mutex<Option<JsonRpcClient>>>,
}

impl JavaAdapter {
    pub fn new(config: JavaConfig, tokens: TokenStore) -> Self {
        Self {
            config,
            tokens,
            http: reqwest::Client::new(),
            child: Arc::new(Mutex::new(None)),
            rpc: Arc::new(Mutex::new(None)),
        }
    }

    pub fn faf(tokens: TokenStore) -> Self {
        Self::new(JavaConfig::faf(), tokens)
    }
}

#[async_trait]
impl IcePort for JavaAdapter {
    async fn start(&self, params: IceParams) -> Result<ConnectivitySession, String> {
        let Some(token) = self.tokens.get() else {
            return Err("no access token (not logged in?)".into());
        };
        if self.config.jar_path.is_empty() {
            return Err("FAF_ICE_ADAPTER_JAR is not set".into());
        }

        // ICE servers (the Java adapter doesn't fetch these itself).
        let ice = fetch_ice_servers(&self.http, &self.config.api_base, &token, params.game_id)
            .await?;

        let rpc_port = free_port().ok_or("could not reserve an rpc port")?;
        let gpg_port = free_port().ok_or("could not reserve a game port")?;

        let mut args: Vec<String> = vec![
            "-jar".into(),
            self.config.jar_path.clone(),
            "--id".into(),
            params.player_id.to_string(),
            "--login".into(),
            params.player_login.clone(),
            "--game-id".into(),
            params.game_id.to_string(),
            "--rpc-port".into(),
            rpc_port.to_string(),
            "--gpgnet-port".into(),
            gpg_port.to_string(),
        ];
        if ice.force_relay {
            args.push("--force-relay".into());
        }

        eprintln!(
            "[ice] starting java adapter (game {} rpc:{} gpgnet:{})",
            params.game_id, rpc_port, gpg_port
        );

        let mut child = Command::new(&self.config.java_path)
            .args(&args)
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("could not start '{}': {e}", self.config.java_path))?;
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

        // JSON-RPC control channel.
        let (rpc, mut notifications) =
            JsonRpcClient::connect("127.0.0.1", rpc_port, RPC_CONNECT_TIMEOUT).await?;
        rpc.call("setIceServers", vec![Value::Array(ice.servers)]);
        rpc.call(
            "setLobbyInitMode",
            vec![Value::String(lobby_init_mode_name(params.init_mode))],
        );

        let (to_lobby_tx, to_lobby_rx) = mpsc::channel::<RelayMsg>(64);
        let (from_lobby_tx, mut from_lobby_rx) = mpsc::channel::<RelayMsg>(64);

        // adapter notifications → lobby.
        tokio::spawn(async move {
            while let Some(note) = notifications.recv().await {
                if let Some(relay) = relay_from_notification(&note) {
                    if to_lobby_tx.send(relay).await.is_err() {
                        break;
                    }
                }
            }
        });

        // lobby game-relay → adapter RPC calls.
        let rpc_for_calls = rpc.clone();
        tokio::spawn(async move {
            while let Some(msg) = from_lobby_rx.recv().await {
                if let Some((method, p)) = rpc_call_for(&msg) {
                    rpc_for_calls.call(&method, p);
                }
            }
        });

        *self.rpc.lock().unwrap() = Some(rpc);

        Ok(ConnectivitySession {
            game_port: gpg_port,
            to_lobby: to_lobby_rx,
            from_lobby: from_lobby_tx,
        })
    }

    fn stop(&self) {
        if let Some(rpc) = self.rpc.lock().unwrap().take() {
            rpc.call("quit", vec![]);
        }
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.start_kill();
        }
    }
}

struct IceServers {
    servers: Vec<Value>,
    force_relay: bool,
}

/// `GET {api}/ice/session/game/{id}` → `{ servers: [...], forceRelay: bool }`.
async fn fetch_ice_servers(
    http: &reqwest::Client,
    api_base: &str,
    token: &str,
    game_id: i32,
) -> Result<IceServers, String> {
    let url = format!(
        "{}/ice/session/game/{game_id}",
        api_base.trim_end_matches('/')
    );
    let resp = http
        .get(&url)
        .bearer_auth(token)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|e| format!("ice servers request failed: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| format!("read failed: {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "ice servers returned {status}: {}",
            body.chars().take(200).collect::<String>()
        ));
    }
    let value: Value = serde_json::from_str(&body).map_err(|e| format!("invalid JSON: {e}"))?;
    Ok(IceServers {
        servers: value
            .get("servers")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        force_relay: value
            .get("forceRelay")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

fn lobby_init_mode_name(init_mode: i32) -> String {
    if init_mode == 1 { "auto" } else { "normal" }.to_string()
}

/// Map an adapter notification to a lobby relay message (or `None` to ignore).
/// Mirrors `IceAdapterClient.onGpgNetMessageReceived` / `onIceMsg`.
fn relay_from_notification(note: &RpcNotification) -> Option<RelayMsg> {
    match note.method.as_str() {
        // onGpgNetMessageReceived(header, chunks) → {header, chunks}
        "onGpgNetMessageReceived" => {
            let command = note.params.first()?.as_str()?.to_string();
            let args = note
                .params
                .get(1)
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            Some(RelayMsg { command, args })
        }
        // onIceMsg(localId, remoteId, iceMsg) → IceMsg[remoteId, iceMsg]
        "onIceMsg" => {
            let remote = note.params.get(1)?.clone();
            let ice_msg = note.params.get(2)?.clone();
            Some(RelayMsg {
                command: "IceMsg".into(),
                args: vec![remote, ice_msg],
            })
        }
        // status/connection notifications aren't needed for connectivity.
        _ => None,
    }
}

/// Map a lobby game-relay message to a JSON-RPC call (method, params), or `None`
/// to ignore. Mirrors `IceAdapterClient.handle_message`.
fn rpc_call_for(msg: &RelayMsg) -> Option<(String, Vec<Value>)> {
    match msg.command.as_str() {
        "SendNatPacket" | "CreatePermission" => None,
        "JoinGame" => Some(("joinGame".into(), msg.args.clone())),
        "ConnectToPeer" => Some(("connectToPeer".into(), msg.args.clone())),
        "IceMsg" => Some(("iceMsg".into(), msg.args.clone())),
        "HostGame" => Some(("hostGame".into(), msg.args.iter().take(1).cloned().collect())),
        "DisconnectFromPeer" => Some((
            "disconnectFromPeer".into(),
            msg.args.iter().take(1).cloned().collect(),
        )),
        other => Some((
            "sendToGpgNet".into(),
            vec![Value::String(other.to_string()), Value::Array(msg.args.clone())],
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infra::jsonrpc::RpcNotification;
    use serde_json::json;

    #[test]
    fn maps_gpgnet_notification_to_relay() {
        let note = RpcNotification {
            method: "onGpgNetMessageReceived".into(),
            params: vec![json!("GameState"), json!(["Lobby"])],
        };
        assert_eq!(
            relay_from_notification(&note),
            Some(RelayMsg {
                command: "GameState".into(),
                args: vec![json!("Lobby")],
            })
        );
    }

    #[test]
    fn maps_ice_notification_dropping_local_id() {
        let note = RpcNotification {
            method: "onIceMsg".into(),
            params: vec![json!(42707), json!(436001), json!({"type": "candidate"})],
        };
        assert_eq!(
            relay_from_notification(&note),
            Some(RelayMsg {
                command: "IceMsg".into(),
                args: vec![json!(436001), json!({"type": "candidate"})],
            })
        );
    }

    #[test]
    fn ignores_status_notifications() {
        let note = RpcNotification {
            method: "onConnectionStateChanged".into(),
            params: vec![json!("Connected")],
        };
        assert_eq!(relay_from_notification(&note), None);
    }

    #[test]
    fn maps_lobby_messages_to_rpc_calls() {
        let join = RelayMsg {
            command: "JoinGame".into(),
            args: vec![json!("Critren"), json!(436001)],
        };
        assert_eq!(
            rpc_call_for(&join),
            Some(("joinGame".into(), vec![json!("Critren"), json!(436001)]))
        );

        // Unknown command → sendToGpgNet[command, args].
        let other = RelayMsg {
            command: "Bottleneck".into(),
            args: vec![json!(1)],
        };
        assert_eq!(
            rpc_call_for(&other),
            Some((
                "sendToGpgNet".into(),
                vec![json!("Bottleneck"), json!([1])]
            ))
        );

        // Ignored commands.
        assert_eq!(
            rpc_call_for(&RelayMsg {
                command: "SendNatPacket".into(),
                args: vec![]
            }),
            None
        );
    }

    #[test]
    fn init_mode_names() {
        assert_eq!(lobby_init_mode_name(0), "normal");
        assert_eq!(lobby_init_mode_name(1), "auto");
    }
}
