//! Settings service.
//!
//! Loads persisted settings at startup and persists changes. Note the persistence
//! pattern: the service emits the event first (so the single reduce chokepoint
//! updates the authoritative state), then reads the *post-reduce* settings back
//! from the sink and hands the whole slice to the port. This keeps services free
//! of any direct state mutation while still persisting the resulting state.

use faf_domain::state::{SettingsCommand, SettingsEvent};

use crate::runtime::{EventSink, ServiceCtx};

pub async fn handle(cmd: SettingsCommand, ctx: &ServiceCtx, out: &EventSink) {
    match cmd {
        SettingsCommand::Load => {
            let settings = ctx.ports.settings.load().await;
            out.emit(SettingsEvent::Loaded { settings });
        }
        SettingsCommand::SetTheme { theme } => {
            out.emit(SettingsEvent::ThemeChanged { theme });
            // Persist the resulting slice (post-reduce, authoritative).
            ctx.ports.settings.save(&out.snapshot().settings).await;
        }
    }
}
