//! Navigation service.
//!
//! Pure UI-state transition with no IO: a `Select` command becomes a `TabSelected`
//! event, and each section command its `...SectionSelected` event. It still goes
//! through the loop so navigation obeys the same single mutation path as
//! everything else: and so backend logic can drive the view too.
//!
//! `faf://` links come through here too. The backend reads them, so a link
//! from chat and one from the operating system are checked by the same code;
//! the frontend opens what a readable one points at (`nav.link_request`).

use std::sync::atomic::{AtomicU32, Ordering};

use faf_domain::protocol::deep_link::{parse_deep_link, DeepLinkError};
use faf_domain::state::{LinkRequest, NavCommand, NavEvent, NotificationKind};

use crate::runtime::{EventSink, ServiceCtx};
use crate::services::notifications;

/// The id of the next link request. Process-wide: a request only has to be
/// told apart from the one before it.
static NEXT_LINK: AtomicU32 = AtomicU32::new(1);

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
        NavCommand::SelectChangelogSection { section } => {
            out.emit(NavEvent::ChangelogSectionSelected { section })
        }
        NavCommand::SelectChangelogClientRelease { version } => {
            out.emit(NavEvent::ChangelogClientReleaseSelected { version })
        }
        NavCommand::OpenLink { url } => open_link(&url, out),
        NavCommand::LinkShown { id } => out.emit(NavEvent::LinkShown { id }),
    }
}

/// Read a `faf://` link and hand it to the frontend, which knows how each tab
/// opens on one item. A link that cannot be read opens nothing and says so,
/// even with notifications off: somebody clicked it and is waiting for
/// something to happen.
fn open_link(url: &str, out: &EventSink) {
    match parse_deep_link(url) {
        Ok(link) => out.emit(NavEvent::LinkRequested {
            request: LinkRequest {
                id: NEXT_LINK.fetch_add(1, Ordering::Relaxed),
                link,
            },
        }),
        Err(error) => {
            tracing::info!(%url, ?error, "refused a link");
            let reason = match error {
                DeepLinkError::NotALink => "it is not a faf:// link".to_owned(),
                DeepLinkError::UnknownTarget(target) => {
                    format!("the client does not know \"{target}\"")
                }
                DeepLinkError::BadValue(value) => format!("\"{value}\" is not a valid value"),
            };
            // Only the start of a link goes into the notice: it can come from
            // any web page.
            let shown: String = url.chars().take(120).collect();
            notifications::add_required_text(
                out,
                NotificationKind::Error,
                notifications::Text::new("notifications.msg.linkRefused").with("link", &shown),
                "This link could not be opened",
                format!("{shown}: {reason}."),
                None,
            );
        }
    }
}
