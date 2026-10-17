//! Linux runtime orchestration: check the system, install what is missing,
//! switch game launches onto it.
//!
//! `Prepare` runs once at every start (the shell sends it after the settings
//! are read) and again when the player retries or changes the launch command.
//! There is no button to start the first installation: on Linux the game
//! cannot run without the runtime, so the client sets it up the first time it
//! starts, the way it updates the game files without being asked.
//!
//! A launch command of the player's own (Settings, Game) means they run the
//! game their own way; the runtime is then neither installed nor used.

use faf_domain::state::{
    LinuxRuntimeCommand, LinuxRuntimeEvent, LinuxRuntimeStatus, NotificationAction,
    NotificationKind,
};

use crate::ports::{RuntimeCheck, RuntimeProgress};
use crate::runtime::{CancellationSlot, EventSink, ServiceCtx};
use crate::services::notifications;

#[derive(Default)]
pub struct LinuxRuntimeContext {
    install: CancellationSlot,
}

pub async fn handle(cmd: LinuxRuntimeCommand, ctx: &ServiceCtx, out: &EventSink) {
    match cmd {
        LinuxRuntimeCommand::Prepare => prepare(ctx, out).await,
        LinuxRuntimeCommand::Cancel => ctx.linux_runtime.install.cancel(),
    }
}

fn publish(out: &EventSink, status: LinuxRuntimeStatus) {
    out.emit(LinuxRuntimeEvent::StatusChanged { status });
}

/// Where the explanation is: the Game section shows the status, what is
/// missing and how to install it.
fn to_game_settings() -> Option<NotificationAction> {
    Some(NotificationAction::OpenSettings {
        section: Some("game".to_string()),
    })
}

/// A failure the player has to hear about even with alerts turned off: until
/// it is fixed, no game starts.
fn fail(out: &EventSink, reason: String) {
    notifications::add_required_failure(
        out,
        notifications::Text::new("notifications.msg.linuxRuntimeFailed"),
        "Setting up Forged Alliance for Linux failed",
        reason.clone(),
        to_game_settings(),
    );
    publish(out, LinuxRuntimeStatus::Failed { reason });
}

async fn prepare(ctx: &ServiceCtx, out: &EventSink) {
    crate::runtime::expect_admitted(crate::runtime::Key::LinuxRuntime);
    let own_command = out.with_state(|state| !state.settings.game.launch_wrapper.trim().is_empty());
    if own_command {
        ctx.ports.linux_runtime.activate(false);
        publish(out, LinuxRuntimeStatus::NotNeeded);
        return;
    }

    publish(out, LinuxRuntimeStatus::Checking);
    match ctx.ports.linux_runtime.check().await {
        RuntimeCheck::NotNeeded => {
            ctx.ports.linux_runtime.activate(false);
            publish(out, LinuxRuntimeStatus::NotNeeded);
        }
        RuntimeCheck::Missing {
            prerequisites,
            distribution,
        } => {
            ctx.ports.linux_runtime.activate(false);
            notifications::add_required_text(
                out,
                NotificationKind::GameInstall,
                notifications::Text::new("notifications.msg.linuxRuntimeMissing"),
                "Forged Alliance cannot run on this system yet",
                "Something only you can install is missing. Settings, Game says what, and \
                 how to install it.",
                to_game_settings(),
            );
            publish(
                out,
                LinuxRuntimeStatus::Missing {
                    prerequisites,
                    distribution,
                },
            );
        }
        RuntimeCheck::Installed => {
            ctx.ports.linux_runtime.activate(true);
            publish(out, LinuxRuntimeStatus::Ready);
        }
        RuntimeCheck::Incomplete => install(ctx, out).await,
    }
}

async fn install(ctx: &ServiceCtx, out: &EventSink) {
    // A half-replaced runtime is no runtime: games stop going through it until
    // the installation finished.
    ctx.ports.linux_runtime.activate(false);
    let cancel = ctx.linux_runtime.install.begin();
    let mut progress = ctx.ports.linux_runtime.install(cancel.clone());

    // The port always ends with `Finished`. A stream that closes without one
    // is a worker that died, and must not leave a progress bar standing.
    let mut settled = None;
    while let Some(step) = progress.recv().await {
        if cancel.is_cancelled() && !matches!(step, RuntimeProgress::Finished(_)) {
            continue;
        }
        match step {
            RuntimeProgress::Downloading {
                component,
                received_bytes,
                total_bytes,
            } => publish(
                out,
                LinuxRuntimeStatus::Downloading {
                    component,
                    downloaded_bytes: received_bytes,
                    total_bytes,
                },
            ),
            RuntimeProgress::Installing(step) => {
                publish(out, LinuxRuntimeStatus::Installing { step })
            }
            RuntimeProgress::Finished(outcome) => settled = Some(outcome),
        }
    }

    match settled {
        Some(Ok(())) => {
            // Asked again rather than assumed: `Ready` has to mean that games
            // will start through the runtime, and only a complete one is
            // switched on.
            match ctx.ports.linux_runtime.check().await {
                RuntimeCheck::Installed => {
                    ctx.ports.linux_runtime.activate(true);
                    publish(out, LinuxRuntimeStatus::Ready);
                }
                _ => fail(
                    out,
                    "the installation finished, but the runtime is not complete".into(),
                ),
            }
        }
        Some(Err(reason)) if !cancel.is_cancelled() => fail(out, reason),
        None if !cancel.is_cancelled() => {
            fail(out, "the installation stopped without finishing".into())
        }
        // Called off by the player, who needs no notification about it. Shown
        // as stopped, with the retry a failure offers; the parts already in
        // place stay, and the next run continues from them.
        _ => publish(
            out,
            LinuxRuntimeStatus::Failed {
                reason: "the installation was cancelled".into(),
            },
        ),
    }
}
