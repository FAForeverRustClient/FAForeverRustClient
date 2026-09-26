//! Vault publishing orchestration.

use faf_domain::state::{
    is_safe_folder_name, ModsEvent, UploadKind, UploadStatus, UploadsCommand, UploadsEvent,
};

use crate::runtime::{EventSink, ServiceCtx};

pub async fn handle(cmd: UploadsCommand, ctx: &ServiceCtx, out: &EventSink) {
    match cmd {
        UploadsCommand::Open { mut request } => {
            // A folder picked from disk arrives named after the folder, which
            // is not the name the vault will give it: that is the `name` inside
            // `mod_info.lua` or the scenario, read out of the archive. The
            // dialog printed the folder's name instead, and an author who
            // had named the folder differently was left not trusting the
            // upload (#337). One small file read, done before the dialog opens
            // so it never shows the wrong name first; the name also decides
            // the "new" or "update" badge, which is checked against the vault.
            if let Some(name) = ctx.ports.uploads.subject_name(request.clone()).await {
                request.display_name = name;
            }
            // The dialog opens now and the picture arrives when it arrives:
            // reading a `.scmap` is a file read and a PNG build, and a dialog
            // that waits for its own illustration is a dialog that stutters.
            out.emit(UploadsEvent::Opened {
                request: request.clone(),
            });
            if request.kind == UploadKind::Mod {
                rescan_mods(ctx, out);
            }
            let uploads = ctx.ports.uploads.clone();
            let sink = out.clone();
            tokio::spawn(async move {
                let data_url = uploads.map_preview(request).await;
                if !data_url.is_empty() {
                    sink.emit(UploadsEvent::PreviewRead { data_url });
                }
            });
        }
        UploadsCommand::Close => out.emit(UploadsEvent::Closed),
        UploadsCommand::SetRanked { ranked } => out.emit(UploadsEvent::RankedChanged { ranked }),
        UploadsCommand::Start => start(ctx, out).await,
    }
}

/// Re-read the mods folder while the publish dialog is opening.
///
/// The dialog prints the mod's version and uid, and it took them from the list
/// scanned when the client started. An author who edits `mod_info.lua` and then
/// publishes without restarting was shown the values from before the edit: the
/// report is that publishing "takes the wrong version and UID".
///
/// The archive itself was always current, because it is zipped from the folder
/// at the moment Publish is pressed. What was stale is the last screen before
/// that happens, which is the screen the author checks.
///
/// Off the critical path on purpose. The dialog is already on screen and fills
/// its facts in from the state; a scan that finishes a moment later corrects
/// them in place, and one that fails leaves what was there rather than emptying
/// the dialog. `InstalledLoading` is deliberately not emitted for the same
/// reason: the list is not empty, and saying it is loading would blank the
/// facts the author is reading.
fn rescan_mods(ctx: &ServiceCtx, out: &EventSink) {
    let mods = ctx.ports.mods.clone();
    let sink = out.clone();
    tokio::spawn(async move {
        match mods.list_installed().await {
            Ok(mods) => sink.emit(ModsEvent::InstalledLoaded { mods }),
            Err(reason) => {
                tracing::warn!(%reason, "could not re-read the mods folder for the publish dialog")
            }
        }
    });
}

async fn start(ctx: &ServiceCtx, out: &EventSink) {
    let Some(_guard) = ctx.uploads_active.try_acquire() else {
        return;
    };
    let state = out.with_state(|state| state.uploads.clone());

    // Both reference clients hold a global upload lock. A second publish would
    // fight the first for the same temporary archive path.
    if state.status.is_busy() {
        return;
    }
    let Some(request) = state.request.clone() else {
        return; // The dialog closed before this landed.
    };

    // Checked here as well as in the adapter. The adapter's check is the one
    // that protects the filesystem; this one keeps a bad name from ever
    // reaching a port, and produces the error the user actually sees.
    // A picked folder is exempt: its path is used as given and never joined to
    // a directory of ours, so there is nothing for a name to escape from. The
    // adapter validates it instead.
    if request.source_path.is_none() && !is_safe_folder_name(&request.folder_name) {
        out.emit(UploadsEvent::Progressed {
            status: UploadStatus::Failed {
                reason: format!(
                    "“{}” is not a folder name that can be published",
                    request.folder_name
                ),
            },
        });
        return;
    }

    let mut updates = ctx.ports.uploads.publish(request).await;

    // The port always ends with a terminal status; treating a stream that
    // closes without one as a failure keeps a panicked task from looking like
    // a successful publish.
    let mut settled = false;
    while let Some(status) = updates.recv().await {
        settled = matches!(
            status,
            UploadStatus::Succeeded | UploadStatus::Failed { .. }
        );
        out.emit(UploadsEvent::Progressed { status });
    }
    if !settled {
        out.emit(UploadsEvent::Progressed {
            status: UploadStatus::Failed {
                reason: "the upload stopped without finishing".into(),
            },
        });
    }
}
