//! What only the Tauri shell builds or reads, as it crosses to and from the
//! page: the revisioned event stream and its snapshot, and the shell's own
//! commands outside [`AppCommand`](faf_domain::AppCommand).
//!
//! Here rather than in the shell because this crate cannot depend on the
//! shell, and a type the bindings export cannot see is a type the frontend
//! has to write out by hand. What `faf-app`'s adapters build is in
//! [`faf_domain::native`].
//!
//! Specta refuses `u64` (a value past 2^53 would not survive as a JavaScript
//! number), so the revisions below are exported as a plain `number`: one per
//! state change, they never come near it.

use faf_domain::frontend::FrontendUpdate;
use faf_domain::protocol::log_analysis::LogIssue;
use faf_domain::state::Theme;
use faf_domain::AppState;
use serde::{Deserialize, Serialize};
use specta::Type;
use specta_typescript::Number;

/// One ordered shell-to-webview stream. Recovery snapshots deliberately use
/// the same channel as deltas so the webview cannot observe a post-recovery
/// event and then roll itself back to an older snapshot from another channel.
#[derive(Clone, Serialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FrontendMessage {
    Event {
        #[specta(type = Number)]
        revision: u64,
        event: Box<FrontendUpdate>,
    },
    Snapshot {
        #[specta(type = Number)]
        revision: u64,
        state: Box<AppState>,
    },
}

/// The page's hydration snapshot, and the last event revision it contains:
/// the runtime's own `faf_app::VersionedSnapshot`, as the `snapshot` command
/// answers with it.
#[derive(Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct VersionedSnapshot {
    #[specta(type = Number)]
    pub revision: u64,
    pub state: AppState,
}

/// The newest file of one log folder, for the diagnostics page.
#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LogPreview {
    pub file_name: String,
    /// The newest 512 KiB of the file.
    pub content: String,
    /// Known problems recognised in this log (see
    /// [`faf_domain::protocol::log_analysis`]). Analysed in the shell rather
    /// than in the frontend so the whole file is scanned: `content` is
    /// truncated, and the trace that explains a crash is routinely older than
    /// what it keeps, so an issue can be reported that the excerpt does not
    /// contain.
    pub issues: Vec<LogIssue>,
}

/// Which rendering engine the client actually ended up in.
///
/// Facts only. Which release is new enough is deliberately a frontend
/// decision, because the features at stake are the ones its stylesheets use.
#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WebviewEngine {
    /// `windows`, `macos`, `linux`, or `other`.
    pub platform: &'static str,
    /// WebKitGTK `major.minor.micro`; only Linux has a version worth reporting.
    pub webkit_version: Option<String>,
}

/// One card of the desktop notification popup: bounded presentation data for
/// an existing notification id. No actions or URLs.
#[derive(Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NotificationPopupCard {
    pub id: String,
    pub title: String,
    pub body: String,
    pub action_label: Option<String>,
    pub tone: String,
    #[serde(default)]
    #[specta(optional)]
    pub image_url: Option<String>,
}

/// What the popup window shows: at most three cards, newest first.
#[derive(Clone, Default, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NotificationPopupBatch {
    #[specta(type = Number)]
    pub revision: u64,
    pub cards: Vec<NotificationPopupCard>,
    pub duration_seconds: u16,
    /// Only local test cards may opt out of expiry; live cards keep their timer.
    pub held_preview_ids: Vec<String>,
    pub theme: Theme,
    pub dismiss_label: String,
}

/// A display the popup can be placed on, by the name the settings keep.
#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NotificationDisplay {
    pub name: String,
    pub primary: bool,
}

/// What the page asks a file dialog to look like. Nothing in it decides what
/// may be picked: that is the player, in the dialog the shell opens, so a path
/// the page sends back later can be checked against what was picked.
#[derive(Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PickRequest {
    #[serde(default)]
    #[specta(optional)]
    pub title: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub filters: Vec<PickFilter>,
    /// Pick a folder rather than a file.
    #[serde(default)]
    #[specta(optional)]
    pub directory: bool,
    /// Where the dialog starts: a folder, or a file to preselect.
    #[serde(default)]
    #[specta(optional)]
    pub default_path: Option<String>,
}

/// One filter of the dialog, as the page describes it.
#[derive(Deserialize, Type)]
pub struct PickFilter {
    pub name: String,
    pub extensions: Vec<String>,
}
