//! Navigation service.
//!
//! Pure UI-state transition with no IO: a `Select` command becomes a `TabSelected`
//! event, and each section command its `...SectionSelected` event. It still goes
//! through the loop so navigation obeys the same single mutation path as
//! everything else: and so backend logic can drive the view too.

use faf_domain::state::{NavCommand, NavEvent};

use crate::runtime::{EventSink, ServiceCtx};

pub async fn handle(cmd: NavCommand, _ctx: &ServiceCtx, out: &EventSink) {
    match cmd {
        NavCommand::Select { tab } => out.emit(NavEvent::TabSelected { tab }),
        NavCommand::SelectMapsSection { section } => {
            out.emit(NavEvent::MapsSectionSelected { section })
        }
        NavCommand::SelectModsSection { section } => {
            out.emit(NavEvent::ModsSectionSelected { section })
        }
        NavCommand::SelectReplaysSection { section } => {
            out.emit(NavEvent::ReplaysSectionSelected { section })
        }
        NavCommand::SelectSettingsSection { section } => {
            out.emit(NavEvent::SettingsSectionSelected { section })
        }
    }
}
