//! Companion programs: telling the player what became of them.
//!
//! The launcher starts and closes them (`infra::companions`, behind the
//! process port) as each game and replay starts and ends; this turns what it
//! reports into state, for the result Settings shows beside each entry, and
//! a failure into a notification. Never a dialog: a companion that did not
//! start is not a reason to interrupt the game that did.

use std::sync::Arc;

use faf_domain::state::{CompanionOutcome, CompanionRun, InstallEvent};

use crate::runtime::{EventSink, ServiceCtx};
use crate::services::notifications;

/// Start the task that listens for the launcher's reports. Called once from
/// the runtime loop; it lives for the process.
pub fn spawn(ctx: Arc<ServiceCtx>, sink: EventSink) {
    tokio::spawn(async move {
        let mut reports = ctx.ports.process.companion_reports().await;
        while let Some(run) = reports.recv().await {
            report(&sink, run);
        }
    });
}

/// Record one result, and raise a failure as a notification.
pub(crate) fn report(out: &EventSink, run: CompanionRun) {
    if let CompanionOutcome::Failed { reason } = &run.outcome {
        // Named by the launcher: the entry's name, or its program's file.
        notifications::add_failure(
            out,
            notifications::Text::new("notifications.msg.companionFailed").with("name", &run.name),
            format!("{} did not start", run.name),
            reason.clone(),
        );
    }
    out.emit(InstallEvent::CompanionReported { run });
}
