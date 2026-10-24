//! Minimal JSON-RPC 2.0 client over TCP: drives the Java `faf-ice-adapter`.
//!
//! Mirrors the Python client's `JsonRpcTcpClient.py`. The wire is a stream of JSON
//! objects (newline-terminated when we send; concatenated/whitespace-separated when
//! parsing, to be defensive). We:
//! - **call** adapter methods fire-and-forget (`{jsonrpc,method,params}\n`), and
//! - receive the adapter's **notifications/requests** (objects with a `method`),
//!   surfaced on a channel; if one carries an `id` we reply with a null result;
//! - **request** the odd method whose answer matters (`status`, for the live
//!   relay view) with an `id`, and match the response to it.
//!
//! Responses to the fire-and-forget calls carry no id of ours and are ignored.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot};

/// Requests sent and not yet answered, by id. The reader pump resolves them;
/// when the connection ends it drops them all, which fails every waiter at
/// once rather than leaving each to its timeout.
type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

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
    out: mpsc::UnboundedSender<String>,
    pending: Pending,
    next_id: Arc<AtomicU64>,
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
                        return Err(format!(
                            "could not connect to adapter rpc {host}:{port}: {e}"
                        ));
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            }
        };
        let (mut read_half, mut write_half) = stream.into_split();

        // Signaling bursts scale with peer count and candidate count. This is
        // intentionally unbounded because dropping a JSON-RPC `iceMsg` frame
        // after an arbitrary queue limit makes only some peers fail to connect.
        // The producer is the authenticated FAF lobby, not arbitrary local UI.
        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
        let (note_tx, note_rx) = mpsc::channel::<RpcNotification>(64);

        // Writer pump.
        tokio::spawn(async move {
            while let Some(frame) = out_rx.recv().await {
                if write_half.write_all(frame.as_bytes()).await.is_err() {
                    break;
                }
            }
        });

        // Reader pump: parse objects, route notifications, answer id'd requests,
        // and hand responses to whoever asked.
        let reply_tx = out_tx.clone();
        let pending: Pending = Arc::default();
        let answers = pending.clone();
        tokio::spawn(async move {
            let mut buffer: Vec<u8> = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                match read_half.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => buffer.extend_from_slice(&chunk[..n]),
                }
                for value in parse_objects(&mut buffer) {
                    if answer(&value, &answers) {
                        continue;
                    }
                    if let Some(note) = route(&value, &reply_tx) {
                        if note_tx.send(note).await.is_err() {
                            answers.lock().unwrap().clear();
                            return; // consumer gone
                        }
                    }
                }
                // Whatever is still unparsed is a message that has not ended
                // yet. The adapters write one short line per message, so past
                // the budget it is not one: end the connection, as a closed
                // stream does, rather than keep reparsing a growing buffer.
                if exceeds_budget(&buffer) {
                    tracing::warn!(
                        bytes = buffer.len(),
                        "closing an adapter connection that sent an unending message"
                    );
                    break;
                }
            }
            answers.lock().unwrap().clear();
        });

        Ok((
            Self {
                out: out_tx,
                pending,
                next_id: Arc::new(AtomicU64::new(1)),
            },
            note_rx,
        ))
    }

    /// Call an adapter method, fire-and-forget (no response awaited).
    pub fn call(&self, method: &str, params: Vec<Value>) {
        let frame = json!({ "jsonrpc": "2.0", "method": method, "params": params });
        let _ = self.out.send(format!("{frame}\n"));
    }

    /// Call an adapter method and wait up to `timeout` for its result.
    pub async fn request(
        &self,
        method: &str,
        params: Vec<Value>,
        timeout: Duration,
    ) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (answered, answer) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, answered);
        let frame = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        if self.out.send(format!("{frame}\n")).is_err() {
            self.pending.lock().unwrap().remove(&id);
            return Err("the adapter's control connection is closed".into());
        }
        match tokio::time::timeout(timeout, answer).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("the adapter's control connection closed".into()),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err(format!(
                    "the adapter did not answer `{method}` within {} seconds",
                    timeout.as_secs()
                ))
            }
        }
    }
}

/// Hand a response to the request it answers. True when `value` was one, so
/// it is not also read as a notification.
fn answer(value: &Value, pending: &Pending) -> bool {
    if value.get("method").is_some() {
        return false;
    }
    let Some(id) = value.get("id").and_then(Value::as_u64) else {
        return false;
    };
    let Some(waiter) = pending.lock().unwrap().remove(&id) else {
        return false;
    };
    let result = match value.get("error") {
        Some(error) if !error.is_null() => Err(format!("the adapter refused: {error}")),
        _ => Ok(value.get("result").cloned().unwrap_or(Value::Null)),
    };
    let _ = waiter.send(result);
    true
}

/// Classify one inbound object: a `method` object is a notification/request (and,
/// if it has an `id`, gets a null-result reply queued); anything else is a response
/// we ignore. Returns the notification to surface, if any.
fn route(value: &Value, reply_tx: &mpsc::UnboundedSender<String>) -> Option<RpcNotification> {
    let method = value.get("method").and_then(Value::as_str)?;
    if let Some(id) = value.get("id") {
        let reply = json!({ "jsonrpc": "2.0", "id": id, "result": Value::Null });
        let _ = reply_tx.send(format!("{reply}\n"));
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

/// The most a message may hold back while its end is awaited, malformed or
/// merely incomplete.
const MAX_UNPARSED_BYTES: usize = 1 << 20;

/// Whether the unparsed rest of the stream is past [`MAX_UNPARSED_BYTES`].
///
/// An incomplete object (a string or array that is never closed) returns from
/// [`parse_objects`] before its own cap, which only applies to malformed
/// input, so the reader checks this after every read.
fn exceeds_budget(buffer: &[u8]) -> bool {
    buffer.len() > MAX_UNPARSED_BYTES
}

/// Drain every complete JSON object from `buffer`, leaving any partial trailing
/// object for the next read. Handles concatenated and newline-separated objects.
///
/// A malformed object is skipped to the end of its line (the adapters write
/// one message per line) and parsing goes on after it. It used to stay at the
/// front of the buffer for good: every message after it was dropped, pending
/// requests timed out, and the buffer grew without bound.
fn parse_objects(buffer: &mut Vec<u8>) -> Vec<Value> {
    let mut values = Vec::new();
    loop {
        let mut stream = serde_json::Deserializer::from_slice(buffer).into_iter::<Value>();
        let mut malformed = false;
        loop {
            match stream.next() {
                Some(Ok(v)) => values.push(v),
                // Incomplete trailing object: wait for more bytes.
                Some(Err(e)) if e.is_eof() => break,
                Some(Err(_)) => {
                    malformed = true;
                    break;
                }
                None => break,
            }
        }
        let consumed = stream.byte_offset();
        if consumed > 0 {
            buffer.drain(..consumed);
        }
        if !malformed {
            return values;
        }
        match buffer.iter().position(|&byte| byte == b'\n') {
            Some(newline) => {
                tracing::warn!(
                    bytes = newline,
                    "skipping a malformed message from the adapter"
                );
                buffer.drain(..=newline);
            }
            None => {
                // The rest of the bad line has not arrived yet. Bounded, so a
                // stream that never sends one cannot grow without end.
                if buffer.len() > MAX_UNPARSED_BYTES {
                    tracing::warn!("dropping an unparseable adapter stream");
                    buffer.clear();
                }
                return values;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_malformed_message_is_skipped_and_the_next_one_still_arrives() {
        let mut buf = b"{\"jsonrpc\":\"2.0\",\"method\":\"a\",\"params\":[1]}\n{\"broken\": nope}\n{\"jsonrpc\":\"2.0\",\"method\":\"b\",\"params\":[]}\n".to_vec();
        let objs = parse_objects(&mut buf);
        assert_eq!(objs.len(), 2);
        assert_eq!(objs[0]["method"], "a");
        assert_eq!(objs[1]["method"], "b");
        assert!(buf.is_empty());

        // The bad line's end still to come: held, then skipped once it arrives.
        let mut buf = b"{\"broken\": nope".to_vec();
        assert!(parse_objects(&mut buf).is_empty());
        buf.extend_from_slice(b"}\n{\"method\":\"c\"}\n");
        let objs = parse_objects(&mut buf);
        assert_eq!(objs.len(), 1);
        assert_eq!(objs[0]["method"], "c");
    }

    #[test]
    fn an_object_that_never_ends_is_over_budget() {
        let mut buf = br#"{"method":"a","params":[""#.to_vec();
        buf.extend(std::iter::repeat_n(b'x', MAX_UNPARSED_BYTES));
        assert!(parse_objects(&mut buf).is_empty());
        // Held back as incomplete, never dropped by the parser itself: the
        // reader has to see this and close the connection.
        assert!(exceeds_budget(&buf));
        assert!(!exceeds_budget(br#"{"method":"a","par"#));
    }

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
        let (tx, _rx) = mpsc::unbounded_channel::<String>();
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
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        let note = route(&json!({"method":"ping","id":7,"params":[]}), &tx);
        assert!(note.is_some());
        let reply = rx.recv().await.unwrap();
        let v: Value = serde_json::from_str(reply.trim()).unwrap();
        assert_eq!(v["id"], 7);
        assert!(v.get("result").is_some());
    }

    #[test]
    fn outbound_candidate_bursts_are_not_dropped_at_an_arbitrary_queue_limit() {
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        let client = JsonRpcClient {
            out: tx,
            pending: Arc::default(),
            next_id: Arc::new(AtomicU64::new(1)),
        };
        for candidate in 0..256 {
            client.call("iceMsg", vec![json!(candidate)]);
        }

        let frames = std::iter::from_fn(|| rx.try_recv().ok()).count();
        assert_eq!(frames, 256);
    }

    /// A loopback stand-in for the adapter: answers each request it reads with
    /// whatever `respond` makes of it, after a notification of its own, so the
    /// reader has to tell the two apart.
    async fn adapter(respond: fn(&Value) -> Option<Value>) -> u16 {
        use tokio::io::{AsyncBufReadExt, BufReader};
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let (read, mut write) = socket.into_split();
            let mut lines = BufReader::new(read).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let request: Value = serde_json::from_str(&line).unwrap();
                let note = json!({"jsonrpc":"2.0","method":"onConnectionStateChanged","params":["Connected"]});
                let _ = write.write_all(format!("{note}\n").as_bytes()).await;
                if let Some(reply) = respond(&request) {
                    let _ = write.write_all(format!("{reply}\n").as_bytes()).await;
                }
            }
        });
        port
    }

    #[tokio::test]
    async fn a_request_receives_the_response_carrying_its_id() {
        let port = adapter(|request| {
            Some(json!({"jsonrpc":"2.0","id":request["id"],"result":"{\"version\":\"3.3.9\"}"}))
        })
        .await;
        let (client, mut notes) = JsonRpcClient::connect("127.0.0.1", port, Duration::from_secs(5))
            .await
            .unwrap();

        let result = client
            .request("status", vec![], Duration::from_secs(5))
            .await
            .unwrap();
        assert_eq!(result, json!("{\"version\":\"3.3.9\"}"));
        // The notification sent beside it still reaches the notification stream.
        let note = notes.recv().await.unwrap();
        assert_eq!(note.method, "onConnectionStateChanged");
    }

    #[tokio::test]
    async fn an_error_response_and_a_silent_adapter_both_fail_the_request() {
        let port = adapter(|request| {
            (request["method"] == "refuse").then(
                || json!({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32601,"message":"no"}}),
            )
        })
        .await;
        let (client, _notes) = JsonRpcClient::connect("127.0.0.1", port, Duration::from_secs(5))
            .await
            .unwrap();

        let refused = client
            .request("refuse", vec![], Duration::from_secs(5))
            .await
            .unwrap_err();
        assert!(refused.contains("refused"), "{refused}");
        let silent = client
            .request("status", vec![], Duration::from_millis(100))
            .await
            .unwrap_err();
        assert!(silent.contains("did not answer"), "{silent}");
        assert!(
            client.pending.lock().unwrap().is_empty(),
            "nothing left waiting"
        );
    }
}
