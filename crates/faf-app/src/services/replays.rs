//! Replays service.
//!
//! Thin handler (like `services/nav.rs`): asks the [`ReplayPort`] to do the
//! work, then emits `Connecting`/`Playing`/`Failed`. The actual protocol
//! (WebSocket relay, file decompression, launching FA) lives entirely behind
//! the port — see `infra/replay.rs`.

use std::path::PathBuf;

use faf_domain::state::{ReplayCommand, ReplayEvent};

use crate::runtime::{EventSink, ServiceCtx};

pub async fn handle(cmd: ReplayCommand, ctx: &ServiceCtx, out: &EventSink) {
    match cmd {
        ReplayCommand::WatchLive(target) => {
            out.emit(ReplayEvent::Connecting);
            let uid = target.uid;
            let player = out
                .snapshot()
                .auth
                .player
                .map(|p| p.name)
                .unwrap_or_else(|| "spectator".to_string());
            match ctx.ports.replay.watch_live(target, player).await {
                Ok(warning) => out.emit(ReplayEvent::Playing { uid: Some(uid), warning }),
                Err(reason) => out.emit(ReplayEvent::Failed { reason }),
            }
        }
        ReplayCommand::OpenFile { path } => {
            out.emit(ReplayEvent::Connecting);
            match ctx.ports.replay.play_file(PathBuf::from(path)).await {
                Ok(warning) => out.emit(ReplayEvent::Playing { uid: None, warning }),
                Err(reason) => out.emit(ReplayEvent::Failed { reason }),
            }
        }
        ReplayCommand::LoadVault => {
            out.emit(ReplayEvent::VaultLoading);
            match ctx.ports.replay.list_vault().await {
                Ok(replays) => out.emit(ReplayEvent::VaultLoaded { replays }),
                Err(reason) => out.emit(ReplayEvent::VaultLoadFailed { reason }),
            }
        }
        ReplayCommand::WatchVault { uid } => {
            out.emit(ReplayEvent::Connecting);
            match ctx.ports.replay.watch_vault(uid).await {
                Ok(warning) => out.emit(ReplayEvent::Playing { uid: Some(uid), warning }),
                Err(reason) => out.emit(ReplayEvent::Failed { reason }),
            }
        }
        ReplayCommand::LoadLocal => {
            out.emit(ReplayEvent::LocalLoading);
            match ctx.ports.replay.list_local().await {
                Ok(replays) => out.emit(ReplayEvent::LocalLoaded { replays }),
                Err(reason) => out.emit(ReplayEvent::LocalLoadFailed { reason }),
            }
        }
    }
}
