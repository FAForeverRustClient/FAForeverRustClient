//! Minimal JSON-RPC 2.0 client over TCP — drives the Java `faf-ice-adapter`.
//!
//! Mirrors the Python client's `JsonRpcTcpClient.py`. The wire is a stream of JSON
//! objects (newline-terminated when we send; concatenated/whitespace-separated when
//! parsing, to be defensive). We:
//! - **call** adapter methods fire-and-forget (`{jsonrpc,method,params}\n`), and
//! - receive the adapter's **notifications/requests** (objects with a `method`),
//!   surfaced on a channel; if one carries an `id` we reply with a null result.
//!
//! Responses to our own calls (objects with `result`/`error`) are not needed for
//! connectivity, so they are ignored.

use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;

/// An inbound method call from the adapter (e.g. `onGpgNetMessageReceived`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RpcNotification {
    pub method: String,
    pub params: Vec<Value>,
}

/// A connected JSON-RPC client. Cheap to clone (just an `mpsc::Sender` handle);
/// clones share the same connection.
#[derive(Clone)]
pub struct JsonRpcClient {
    out: mpsc::Sender<String>,
}

impl JsonRpcClient {
    /// Connect to `host:port`, retrying until the adapter's RPC port is up or the
    /// budget is exhausted. Returns the client plus a receiver of inbound
    /// notifications. Spawns the read/write pumps.
    pub async fn connect(
        host: &str,
        port: u16,
        timeout: Duration,
    ) -> Result<(Self, mpsc::Receiver<RpcNotification>), String> {
        let deadline = std::time::Instant::now() + timeout;
        let stream = loop {
            match TcpStream::connect((host, port)).await {
                Ok(s) => break s,
                Err(e) => {
                    if std::time::Instant::now() >= deadline {
                        return Err(format!("could not connect to adapter rpc {host}:{port}: {e}"));
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            }
        };
        let (mut read_half, mut write_half) = stream.into_split();

        let (out_tx, mut out_rx) = mpsc::channel::<String>(64);
        let (note_tx, note_rx) = mpsc::channel::<RpcNotification>(64);

        // Writer pump.
        tokio::spawn(async move {
            while let Some(frame) = out_rx.recv().await {
                if write_half.write_all(frame.as_bytes()).await.is_err() {
                    break;
                }
            }
        });

        // Reader pump: parse objects, route notifications, answer id'd requests.
        let reply_tx = out_tx.clone();
        tokio::spawn(async move {
            let mut buffer: Vec<u8> = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                match read_half.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => buffer.extend_from_slice(&chunk[..n]),
                }
                for value in parse_objects(&mut buffer) {
                    if let Some(note) = route(&value, &reply_tx) {
                        if note_tx.send(note).await.is_err() {
                            return; // consumer gone
                        }
                    }
                }
            }
        });

        Ok((Self { out: out_tx }, note_rx))
    }

    /// Call an adapter method, fire-and-forget (no response awaited).
    pub fn call(&self, method: &str, params: Vec<Value>) {
        let frame = json!({ "jsonrpc": "2.0", "method": method, "params": params });
        let _ = self.out.try_send(format!("{frame}\n"));
    }
}

/// Classify one inbound object: a `method` object is a notification/request (and,
/// if it has an `id`, gets a null-result reply queued); anything else is a response
/// we ignore. Returns the notification to surface, if any.
fn route(value: &Value, reply_tx: &mpsc::Sender<String>) -> Option<RpcNotification> {
    let method = value.get("method").and_then(Value::as_str)?;
    if let Some(id) = value.get("id") {
        let reply = json!({ "jsonrpc": "2.0", "id": id, "result": Value::Null });
        let _ = reply_tx.try_send(format!("{reply}\n"));
    }
    let params = value
        .get("params")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Some(RpcNotification {
        method: method.to_string(),
        params,
    })
}

/// Drain every complete JSON object from `buffer`, leaving any partial trailing
/// object for the next read. Handles concatenated and newline-separated objects.
fn parse_objects(buffer: &mut Vec<u8>) -> Vec<Value> {
    let mut stream = serde_json::Deserializer::from_slice(buffer).into_iter::<Value>();
    let mut values = Vec::new();
    loop {
        match stream.next() {
            Some(Ok(v)) => values.push(v),
            // Incomplete trailing object — wait for more bytes.
            Some(Err(e)) if e.is_eof() => break,
            // Malformed — stop; drain what we consumed so we don't loop forever.
            Some(Err(_)) => break,
            None => break,
        }
    }
    let consumed = stream.byte_offset();
    if consumed > 0 {
        buffer.drain(..consumed);
    }
    values
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_newline_separated_objects() {
        let mut buf = b"{\"jsonrpc\":\"2.0\",\"method\":\"a\",\"params\":[1]}\n{\"jsonrpc\":\"2.0\",\"method\":\"b\",\"params\":[]}\n".to_vec();
        let objs = parse_objects(&mut buf);
        assert_eq!(objs.len(), 2);
        assert_eq!(objs[0]["method"], "a");
        assert_eq!(objs[1]["method"], "b");
        assert!(buf.is_empty());
    }

    #[test]
    fn parses_concatenated_objects_without_newlines() {
        let mut buf = br#"{"method":"x","params":[]}{"method":"y","params":[2]}"#.to_vec();
        let objs = parse_objects(&mut buf);
        assert_eq!(objs.len(), 2);
        assert_eq!(objs[1]["params"][0], 2);
        assert!(buf.is_empty());
    }

    #[test]
    fn keeps_partial_trailing_object_buffered() {
        let full = br#"{"method":"a","params":[]}{"method":"b","par"#.to_vec();
        let mut buf = full.clone();
        let objs = parse_objects(&mut buf);
        assert_eq!(objs.len(), 1); // only the complete one
        assert_eq!(objs[0]["method"], "a");
        // The partial second object stays for the next read.
        assert_eq!(buf, br#"{"method":"b","par"#.to_vec());

        // Completing it parses the rest.
        buf.extend_from_slice(br#"ams":[]}"#);
        let objs = parse_objects(&mut buf);
        assert_eq!(objs.len(), 1);
        assert_eq!(objs[0]["method"], "b");
        assert!(buf.is_empty());
    }

    #[test]
    fn route_returns_notification_and_ignores_responses() {
        let (tx, _rx) = mpsc::channel::<String>(4);
        let note = route(&json!({"method":"onIceMsg","params":[1,2,"x"]}), &tx);
        assert_eq!(
            note,
            Some(RpcNotification {
                method: "onIceMsg".into(),
                params: vec![json!(1), json!(2), json!("x")],
            })
        );
        // A response object (no method) is ignored.
        assert_eq!(route(&json!({"id":1,"result":null}), &tx), None);
    }

    #[tokio::test]
    async fn id_carrying_request_gets_a_reply_queued() {
        let (tx, mut rx) = mpsc::channel::<String>(4);
        let note = route(&json!({"method":"ping","id":7,"params":[]}), &tx);
        assert!(note.is_some());
        let reply = rx.recv().await.unwrap();
        let v: Value = serde_json::from_str(reply.trim()).unwrap();
        assert_eq!(v["id"], 7);
        assert!(v.get("result").is_some());
    }
}
