//! Fake chat provider — simulates a single IRC channel without any network.
//!
//! Stands in for the real chat IRC protocol. On `connect` it seeds a couple of
//! online users (plus the connecting user) and a welcome message, then just
//! idles until cancelled — unlike `FakeLobby` there's no need to keep
//! simulating activity for the offline dev path to be useful. `send_message`
//! builds a `ChatMessage` and pushes it straight back onto the update stream:
//! this **is** the local echo (the real client doesn't negotiate IRC's
//! `echo-message` capability either, so both fake and real ports own this).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use faf_domain::state::ChatMessage;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::ports::{ChatPort, ChatUpdate};

#[derive(Debug, Default)]
pub struct FakeChat {
    cancel: Arc<Mutex<Option<CancellationToken>>>,
    /// The live connection's update sender, so `send_message` (a separate
    /// call) can push onto the same stream the service is draining.
    updates: Arc<Mutex<Option<mpsc::Sender<ChatUpdate>>>>,
    username: Arc<Mutex<String>>,
    next_id: Arc<AtomicU64>,
}

#[async_trait]
impl ChatPort for FakeChat {
    async fn connect(&self, username: String) -> mpsc::Receiver<ChatUpdate> {
        let token = CancellationToken::new();
        if let Some(prev) = self.cancel.lock().unwrap().replace(token.clone()) {
            prev.cancel();
        }
        *self.username.lock().unwrap() = username.clone();

        let (tx, rx) = mpsc::channel(32);
        *self.updates.lock().unwrap() = Some(tx.clone());

        let next_id = self.next_id.clone();
        tokio::spawn(async move {
            let mut users = seed_users();
            users.push(username);
            users.sort();
            if tx.send(ChatUpdate::UsersUpdated(users)).await.is_err() {
                return;
            }
            let welcome = ChatMessage {
                id: next_id.fetch_add(1, Ordering::SeqCst).to_string(),
                sender: "ArchSupport".into(),
                content: "Welcome to #aeolus!".into(),
                timestamp: chrono::Utc::now().to_rfc3339(),
            };
            let _ = tx.send(ChatUpdate::MessageReceived(welcome)).await;

            // Idle until disconnected — no artificial ticking needed here.
            token.cancelled().await;
        });
        rx
    }

    fn send_message(&self, content: String) {
        let Some(tx) = self.updates.lock().unwrap().clone() else {
            eprintln!("[chat] send ignored: no active connection");
            return;
        };
        let message = ChatMessage {
            id: self.next_id.fetch_add(1, Ordering::SeqCst).to_string(),
            sender: self.username.lock().unwrap().clone(),
            content,
            timestamp: chrono::Utc::now().to_rfc3339(),
        };
        tokio::spawn(async move {
            let _ = tx.send(ChatUpdate::MessageReceived(message)).await;
        });
    }

    fn disconnect(&self) {
        if let Some(token) = self.cancel.lock().unwrap().take() {
            token.cancel();
        }
        *self.updates.lock().unwrap() = None;
    }
}

fn seed_users() -> Vec<String> {
    vec!["Stormlord".into(), "Aurora".into()]
}
