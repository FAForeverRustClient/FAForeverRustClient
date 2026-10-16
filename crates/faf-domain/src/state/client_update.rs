//! Client self-update: noticing that a newer build exists, and fetching it.
//!
//! Java `update/`: `ClientUpdateService` polls releases, compares the running
//! version against the newest tag, and raises a notification offering the
//! download. Python has no equivalent; its users update through the installer.
//!
//! Two things in here are load-bearing and belong in the domain rather than in
//! the adapter, because getting either wrong is silent:
//!
//! - [`should_update`] decides whether to nag at all. The classic failure is a
//!   lexicographic comparison, under which `1.9.0` outranks `1.10.0` and the
//!   client stops offering updates forever at the first two-digit minor.
//! - [`is_release_version`] is the shape check that everything downstream
//!   relies on. The adapter derives the *filename it writes and then executes*
//!   from the version string, so a tag containing a path separator has to be
//!   rejected before it ever reaches a `Path`.
//!
//! Note what this slice deliberately does not claim: nothing here verifies a
//! signature. The trust chain is TLS plus the adapter's host/repository pinning
//!: the same chain the Java client relies on: and no more than that.

use serde::{Deserialize, Serialize};
use specta::Type;
use std::cmp::Ordering;

use crate::protocol::changelog::ChangelogBlock;

/// Give players three days to choose a convenient time to update.
pub const GRACE_PERIOD_DAYS: i64 = 3;
/// Two newer releases are enough to require an update even during the grace period.
pub const RELEASES_BEHIND_LIMIT: usize = 2;

/// Whether an offered release has stopped being optional: the player is
/// [`RELEASES_BEHIND_LIMIT`] releases behind, or it was published at least
/// [`GRACE_PERIOD_DAYS`] ago. A publish date the client cannot read, or one in
/// the future, never makes it overdue: nobody is locked out on data the client
/// does not understand.
pub fn is_overdue(
    release: &ClientRelease,
    now: chrono::DateTime<chrono::Utc>,
    behind: usize,
) -> bool {
    behind >= RELEASES_BEHIND_LIMIT
        || chrono::DateTime::parse_from_rfc3339(&release.published_at).is_ok_and(|published| {
            now.signed_duration_since(published) >= chrono::Duration::days(GRACE_PERIOD_DAYS)
        })
}

/// How many published releases on the player's channel are newer than the
/// running build, each version counted once.
pub fn releases_behind(
    current: &str,
    notes: &[ClientReleaseNotes],
    channel: ReleaseChannel,
) -> usize {
    notes
        .iter()
        .filter(|note| {
            (channel == ReleaseChannel::PreRelease || !note.pre_release)
                && should_update(current, &note.version)
        })
        .map(|note| strip_version_prefix(&note.version))
        .collect::<std::collections::HashSet<_>>()
        .len()
}

/// Which releases to offer.
///
/// Java splits this across two tasks (`CheckForUpdateTask` and
/// `CheckForBetaUpdateTask`) selected by `preferences.isPreReleaseCheckEnabled`.
/// One enum reaching one port is the same choice with one code path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ReleaseChannel {
    /// Published, non-prerelease builds only.
    #[default]
    Stable,
    /// Also offers prereleases: the newest tag wins regardless of flag.
    PreRelease,
}

/// A release that could be installed over the running client.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClientRelease {
    /// The tag with any `v` prefix removed, e.g. `0.3.1`.
    pub version: String,
    /// Where the release notes are, for the "What's new" link.
    pub notes_url: String,
    /// The installer for *this* platform, or empty when the release has none.
    ///
    /// Empty is a normal outcome, not an error: a release may ship a Windows
    /// installer and nothing else, and a Linux user should still be told a new
    /// version exists rather than shown a button that cannot work.
    pub download_url: String,
    /// The asset's own name, for display only. The adapter never uses it to
    /// build a path.
    pub asset_name: String,
    pub size_bytes: u32,
    pub pre_release: bool,
    pub published_at: String,
}

impl ClientRelease {
    /// Whether this release can actually be installed from inside the client.
    pub fn is_installable(&self) -> bool {
        !self.download_url.is_empty()
    }
}

/// One published release of this client and what it changed: a row of the
/// Changelog tab's client section, and the body of the What's new popup.
///
/// Every published release rather than only the ones on the update channel.
/// Every release this project has published so far is marked as a prerelease,
/// so a list filtered by channel would be empty for anyone on the stable one;
/// the flag is carried so the view can say which is which instead.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClientReleaseNotes {
    /// The tag with any `v` prefix removed, as on [`ClientRelease::version`].
    pub version: String,
    /// When GitHub published it, RFC 3339. `None` when the release did not say.
    pub published_at: Option<String>,
    pub pre_release: bool,
    /// The release's page on GitHub.
    pub notes_url: String,
    /// The release body, parsed by
    /// [`crate::protocol::changelog::parse_release_notes`]. Empty for a release
    /// published without notes, which every release before the changelog
    /// snippets was.
    pub blocks: Vec<ChangelogBlock>,
}

/// Status of the release-notes list. Mirrors `ChangelogStatus`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    content = "payload",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ClientReleaseNotesStatus {
    #[default]
    Idle,
    Loading,
    Ready,
    Failed {
        reason: String,
    },
}

/// Where the update flow currently is.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    content = "payload",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ClientUpdateStatus {
    /// Nothing has been checked yet this session.
    #[default]
    Idle,
    Checking,
    /// A check completed and found nothing newer.
    UpToDate,
    /// A newer release exists; see [`ClientUpdateState::release`].
    Available,
    Downloading {
        received_bytes: u32,
        /// Zero when the server sent no `Content-Length`.
        total_bytes: u32,
    },
    /// The installer is on disk and waiting to be run.
    Ready {
        path: String,
    },
    /// The installer has been started. The client does not quit itself: see
    /// the note on [`ClientUpdateCommand::Install`].
    Installing,
    Failed {
        reason: String,
    },
}

impl ClientUpdateStatus {
    /// Whether something is in flight. Used to drop a redundant command rather
    /// than run two checks or two downloads over each other.
    pub fn is_busy(&self) -> bool {
        matches!(self, Self::Checking | Self::Downloading { .. })
    }

    /// Download progress as a percentage, when it is meaningful.
    pub fn percent(&self) -> Option<u32> {
        match self {
            Self::Downloading {
                received_bytes,
                total_bytes,
            } if *total_bytes > 0 => {
                Some((*received_bytes as u64 * 100 / *total_bytes as u64) as u32)
            }
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClientUpdateState {
    pub status: ClientUpdateStatus,
    /// The offered release has passed the grace period or the release-count limit.
    #[serde(default)]
    pub overdue: bool,
    /// The running build's version, filled in by the first check.
    pub current_version: String,
    pub release: Option<ClientRelease>,
    /// The version the user waved away. Empty when nothing is dismissed.
    ///
    /// Kept per-version rather than as a flag so that dismissing `0.3.0` does
    /// not also hide `0.4.0`: the reason a "don't show again" checkbox is the
    /// wrong shape for this.
    pub dismissed_version: String,
    /// When the last check finished, RFC 3339. Empty until one has.
    ///
    /// Recorded because the status alone cannot answer "did my click do
    /// anything". Checking twice in a row leaves the same terminal status both
    /// times, so a second "Check now" produced no visible change at all and the
    /// button read as broken. The status says what is true; this says when we
    /// last found out.
    #[serde(default)]
    pub last_checked: String,
    /// Every published release's notes, newest first. Filled by every check
    /// that reached the release list, from the same response: one request
    /// serves both the update banner and the changelog.
    pub notes: Vec<ClientReleaseNotes>,
    pub notes_status: ClientReleaseNotesStatus,
    /// The version whose What's new popup is waiting to be seen: the running
    /// build, on its first start after an update. `None` when there is
    /// nothing to show, including on a fresh install, where everything is new
    /// and a list of changes would mean nothing.
    pub whats_new: Option<String>,
}

impl ClientUpdateState {
    /// The release the update banner should be showing, if any.
    ///
    /// Derived rather than stored: the banner must survive a page re-render and
    /// must not need its own local `dismissed` flag, which is exactly how the
    /// install banner's dismissal ends up out of sync with the backend.
    pub fn banner_release(&self) -> Option<&ClientRelease> {
        let release = self.release.as_ref()?;
        let showing = match &self.status {
            ClientUpdateStatus::Available
            | ClientUpdateStatus::Downloading { .. }
            | ClientUpdateStatus::Ready { .. }
            | ClientUpdateStatus::Installing => true,
            // A failure *during* an update the user started is worth showing;
            // a failed background check is not, and would greet everyone with
            // an error box whenever GitHub is briefly unreachable.
            ClientUpdateStatus::Failed { .. } => true,
            ClientUpdateStatus::Idle
            | ClientUpdateStatus::Checking
            | ClientUpdateStatus::UpToDate => false,
        };
        (showing && release.version != self.dismissed_version).then_some(release)
    }

    /// An installable release becomes required only after the grace period or
    /// release-count limit. This delivers fixes within days without interrupting
    /// everyone on release day. Dismissal never postpones that deadline, and a
    /// release with no installer cannot lock players out.
    pub fn required_release(&self) -> Option<&ClientRelease> {
        let release = self.release.as_ref()?;
        if !self.overdue || !release.is_installable() {
            return None;
        }
        match &self.status {
            // A download that failed keeps the gate up rather than opening it:
            // the reason is shown and the button retries. Failing the download
            // is not a way past the update.
            ClientUpdateStatus::Available
            | ClientUpdateStatus::Downloading { .. }
            | ClientUpdateStatus::Ready { .. }
            | ClientUpdateStatus::Installing
            | ClientUpdateStatus::Failed { .. } => Some(release),
            ClientUpdateStatus::Idle
            | ClientUpdateStatus::Checking
            | ClientUpdateStatus::UpToDate => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    content = "payload",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ClientUpdateEvent {
    /// A check began. Carries the running version because the domain has no
    /// other way to learn it: it comes from the build, through the runtime.
    CheckStarted {
        current_version: String,
    },
    UpToDate,
    Available {
        release: ClientRelease,
    },
    /// The held release has become required, independently of dismissal.
    Overdue,
    /// A check settled, whichever way it went. Separate from the outcome
    /// because the outcome is often identical to the previous one, and "we
    /// asked, just now" is the part the user pressed the button for.
    CheckCompleted {
        at: String,
    },
    DownloadProgressed {
        received_bytes: u32,
        total_bytes: u32,
    },
    /// The download was called off before the installer was written. The
    /// release is still on offer, so the status goes back to `Available`
    /// rather than to a failure: nothing went wrong.
    DownloadCancelled,
    Downloaded {
        path: String,
    },
    Installing,
    Failed {
        reason: String,
    },
    Dismissed {
        version: String,
    },
    NotesLoading,
    /// The whole list, replacing the one before: newest first.
    NotesLoaded {
        notes: Vec<ClientReleaseNotes>,
    },
    NotesFailed {
        reason: String,
    },
    /// The running build is newer than the last one the user saw the notes
    /// of, and they asked to be told.
    WhatsNewPending {
        version: String,
    },
    WhatsNewDismissed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum ClientUpdateCommand {
    /// Ask the release source what the newest build is. Runs automatically at
    /// startup and every six hours.
    Check,
    /// Fetch the installer for the release already in state.
    Download,
    /// Stop the installer download that is running. The partial file is
    /// deleted, so the next `Download` starts from nothing rather than from
    /// half an installer. Does nothing once the installer is whole.
    CancelDownload,
    /// Start the downloaded installer.
    ///
    /// The client does **not** exit itself. On Windows an installer cannot
    /// replace a running executable, so the user has to close the client: the
    /// UI says so. Quitting on the user's behalf would risk killing a game
    /// launch or an upload that is still in flight.
    Install,
    /// Hide the banner for the release currently offered.
    Dismiss,
    /// Read every release's notes. Answered from the release list the last
    /// check read when there is one, so opening the changelog after the
    /// startup check costs no request; fetched only when nothing has been
    /// read yet.
    LoadNotes,
    /// Close the What's new popup, and remember the running version as seen so
    /// it is not shown again.
    ///
    /// Nothing is remembered before this: a popup that never reached the
    /// screen (offline, or closed before the notes arrived) comes back on the
    /// next start rather than being lost.
    DismissWhatsNew,
}

pub fn reduce(state: &mut ClientUpdateState, event: &ClientUpdateEvent) {
    match event {
        ClientUpdateEvent::CheckStarted { current_version } => {
            state.current_version = current_version.clone();
            state.status = ClientUpdateStatus::Checking;
            // Asking again is asking to be told again. "Not now" hid the
            // notice for that version, and "Check now" in Settings then found
            // the same version and showed nothing: the update could not be
            // brought back short of a restart. No automatic check reaches
            // this with a dismissal in place: the startup check runs before
            // anything can be dismissed, and the six-hour ticker skips its
            // check while a release is held.
            state.dismissed_version.clear();
        }
        ClientUpdateEvent::UpToDate => {
            // Drop any previously offered release: the user may have installed
            // it out of band, and keeping it would leave a stale banner behind
            // a status that says everything is current.
            state.release = None;
            state.overdue = false;
            state.status = ClientUpdateStatus::UpToDate;
        }
        ClientUpdateEvent::Available { release } => {
            if state.release.as_ref().map(|known| &known.version) != Some(&release.version) {
                state.overdue = false;
            }
            state.release = Some(release.clone());
            state.status = ClientUpdateStatus::Available;
        }
        ClientUpdateEvent::Overdue => state.overdue = true,
        ClientUpdateEvent::DownloadProgressed {
            received_bytes,
            total_bytes,
        } => {
            state.status = ClientUpdateStatus::Downloading {
                received_bytes: *received_bytes,
                total_bytes: *total_bytes,
            }
        }
        ClientUpdateEvent::DownloadCancelled => {
            // Only a download in progress is called off; a late cancel must
            // not take back an installer that is already `Ready`.
            if matches!(state.status, ClientUpdateStatus::Downloading { .. }) {
                state.status = if state.release.is_some() {
                    ClientUpdateStatus::Available
                } else {
                    ClientUpdateStatus::Idle
                };
            }
        }
        ClientUpdateEvent::Downloaded { path } => {
            state.status = ClientUpdateStatus::Ready { path: path.clone() }
        }
        ClientUpdateEvent::Installing => state.status = ClientUpdateStatus::Installing,
        ClientUpdateEvent::Failed { reason } => {
            state.status = ClientUpdateStatus::Failed {
                reason: reason.clone(),
            }
        }
        ClientUpdateEvent::Dismissed { version } => state.dismissed_version = version.clone(),
        ClientUpdateEvent::CheckCompleted { at } => state.last_checked = at.clone(),
        // A refresh of a list that is already on screen is not shown as one:
        // `Loading` blanks the section, and there is nothing to blank it for.
        ClientUpdateEvent::NotesLoading => {
            if state.notes_status != ClientReleaseNotesStatus::Ready {
                state.notes_status = ClientReleaseNotesStatus::Loading;
            }
        }
        ClientUpdateEvent::NotesLoaded { notes } => {
            state.notes = notes.clone();
            state.notes_status = ClientReleaseNotesStatus::Ready;
        }
        // Likewise a refresh that fails leaves what is on screen alone, as the
        // game changelog does: the list is still the list, and an error page in
        // its place would make a flaky connection destroy a working tab.
        ClientUpdateEvent::NotesFailed { reason } => {
            if state.notes_status != ClientReleaseNotesStatus::Ready {
                state.notes_status = ClientReleaseNotesStatus::Failed {
                    reason: reason.clone(),
                };
            }
        }
        ClientUpdateEvent::WhatsNewPending { version } => state.whats_new = Some(version.clone()),
        ClientUpdateEvent::WhatsNewDismissed => state.whats_new = None,
    }
}

/// Version strings that mean "this is not a released build".
///
/// Java's `Version` treats these as never-updatable, and the reasoning holds
/// here: a developer running a local build should not be offered an installer
/// that would overwrite it.
const DEV_VERSIONS: [&str; 3] = ["", "snapshot", "unspecified"];

/// Strip the `v` that GitHub tags conventionally carry.
pub fn strip_version_prefix(version: &str) -> &str {
    version.strip_prefix('v').unwrap_or(version)
}

/// Whether a string is shaped like a release version this client can reason
/// about: `1`, `1.2`, `1.2.3`, `1.2.3-rc1`, optionally `v`-prefixed.
///
/// Stricter than Java's `v?\d+(\.\d+)*[^.]*`, on purpose. That pattern accepts
/// `v1.0.0-/../../evil`, and the adapter builds the downloaded installer's
/// *filename* from this string before executing it. Restricting the suffix to
/// alphanumerics, `.`, `-` and `+` makes a traversing tag unrepresentable
/// rather than merely unlikely.
pub fn is_release_version(version: &str) -> bool {
    parse_version(version).is_some()
}

/// `(numeric core, prerelease suffix)`, or `None` when the shape is wrong.
fn parse_version(version: &str) -> Option<(Vec<u64>, Option<String>)> {
    let version = strip_version_prefix(version);
    if version.is_empty() || version.len() > 64 {
        return None;
    }

    // Build metadata never affects precedence (semver §10), so drop it before
    // anything else looks at the string.
    let version = version.split('+').next().unwrap_or(version);
    let (core, suffix) = match version.split_once('-') {
        Some((core, suffix)) => (core, Some(suffix)),
        None => (version, None),
    };

    let mut numbers = Vec::new();
    for segment in core.split('.') {
        // `u64` rather than saturating: a 30-digit "version" is not a version,
        // and clamping would make two different absurd tags compare equal.
        numbers.push(segment.parse::<u64>().ok()?);
    }
    if numbers.is_empty() || numbers.len() > 8 {
        return None;
    }

    let suffix = match suffix {
        None => None,
        Some(suffix) => {
            let allowed = |c: char| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+');
            if suffix.is_empty() || !suffix.chars().all(allowed) {
                return None;
            }
            Some(suffix.to_ascii_lowercase())
        }
    };

    Some((numbers, suffix))
}

/// Order two release versions. Neither being a valid version is [`Ordering::Equal`].
///
/// Numeric segments compare as numbers (so `1.10.0` beats `1.9.0`), missing
/// segments count as zero (so `1.2` equals `1.2.0`), and a prerelease sorts
/// *below* the release it leads to (`1.3.0-rc1` < `1.3.0`).
pub fn compare_versions(left: &str, right: &str) -> Ordering {
    let (Some(left), Some(right)) = (parse_version(left), parse_version(right)) else {
        return Ordering::Equal;
    };

    let width = left.0.len().max(right.0.len());
    for index in 0..width {
        let a = left.0.get(index).copied().unwrap_or(0);
        let b = right.0.get(index).copied().unwrap_or(0);
        match a.cmp(&b) {
            Ordering::Equal => continue,
            other => return other,
        }
    }

    match (&left.1, &right.1) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(a), Some(b)) => a.cmp(b),
    }
}

/// Whether `candidate` should be offered to a client running `current`.
///
/// Mirrors Java's `Version.shouldUpdate`, with one deliberate difference: an
/// unparseable *current* version returns `false` where Java throws. A client
/// whose own version is broken should quietly stop offering updates, not fail
/// its startup path.
pub fn should_update(current: &str, candidate: &str) -> bool {
    let normalized = strip_version_prefix(current).to_ascii_lowercase();
    if DEV_VERSIONS.contains(&normalized.as_str()) {
        return false;
    }
    if !is_release_version(current) || !is_release_version(candidate) {
        return false;
    }
    compare_versions(candidate, current) == Ordering::Greater
}

/// What a start of the client does about the What's new popup.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WhatsNewOnStartup {
    /// The running build is the one last seen, or not a release at all.
    Nothing,
    /// Record the running build as seen, and show nothing.
    Remember,
    /// Show the popup. The build is recorded as seen only once it is
    /// dismissed, so a popup that never reached the screen comes back.
    Show,
}

/// Decide [`WhatsNewOnStartup`] from the last version whose notes were seen,
/// the running version, and the user's preference.
///
/// Compared as versions, the way [`should_update`] compares them, so `0.10.0`
/// counts as newer than `0.9.0`. Every case that is not "this client was
/// updated" stays quiet:
///
/// - **Nothing recorded** is a settings file written by a build from before
///   the record existed (0.8.0 and older), so it is an update like any other:
///   from a build older than every one that reads the record. That is what
///   makes the popup appear on the update that ships it. A fresh install is
///   not this case and never reaches it: there a list of changes would be
///   measured against nothing, so the settings load records the running build
///   when it finds no settings file at all (`SettingsCommand::Load`), and this
///   sees the same build again.
/// - **A record that is not a version** is recorded over, and shows nothing:
///   there is no telling what the client was updated from.
/// - **A downgrade** shows nothing either; the notes of a build that came
///   *before* the last one seen are not news. The running version is
///   recorded, so the record describes the build that is actually installed.
/// - **The preference off** records the version too, so turning it back on
///   later announces the next update rather than a backlog.
/// - **A development build** (`test`, `snapshot`, an empty version) does
///   nothing at all, and in particular does not overwrite what a real build
///   recorded.
pub fn whats_new_on_startup(
    last_seen: Option<&str>,
    current: &str,
    enabled: bool,
) -> WhatsNewOnStartup {
    if !is_release_version(current) {
        return WhatsNewOnStartup::Nothing;
    }
    let last_seen_against_current = match last_seen {
        // Written before the record existed: older than any build reading it.
        None => Ordering::Less,
        Some(seen) if is_release_version(seen) => compare_versions(seen, current),
        // Comparing against a value that is not a version would read as
        // "equal" forever and never show anything, so it is replaced.
        Some(_) => return WhatsNewOnStartup::Remember,
    };
    match last_seen_against_current {
        Ordering::Equal => WhatsNewOnStartup::Nothing,
        Ordering::Less if enabled => WhatsNewOnStartup::Show,
        Ordering::Less | Ordering::Greater => WhatsNewOnStartup::Remember,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_notice_policy() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-10-16T12:00:00Z")
            .unwrap()
            .to_utc();
        let mut candidate = release("1.0.0");
        candidate.published_at = "2026-10-14T12:00:00Z".into();
        assert!(!is_overdue(&candidate, now, 1));
        assert!(is_overdue(&candidate, now + chrono::Duration::days(1), 1));
        assert!(is_overdue(&candidate, now, 2));
        for date in ["", "broken", "2027-01-01T00:00:00Z"] {
            candidate.published_at = date.into();
            assert!(!is_overdue(&candidate, now, 1));
        }
        let mut published = vec![notes("0.9.0"), notes("1.0.0"), notes("1.1.0"), notes("bad")];
        published[1].pre_release = false;
        published.push(published[1].clone());
        assert_eq!(
            releases_behind("0.9.0", &published, ReleaseChannel::Stable),
            1
        );
        assert_eq!(
            releases_behind("0.9.0", &published, ReleaseChannel::PreRelease),
            2
        );

        let mut state = ClientUpdateState::default();
        reduce(
            &mut state,
            &ClientUpdateEvent::Available {
                release: candidate.clone(),
            },
        );
        assert!(state.required_release().is_none());
        reduce(&mut state, &ClientUpdateEvent::Overdue);
        assert!(state.required_release().is_some());
        reduce(
            &mut state,
            &ClientUpdateEvent::Available {
                release: candidate.clone(),
            },
        );
        assert!(state.overdue, "the same offer keeps its deadline");
        candidate.version = "1.1.0".into();
        reduce(
            &mut state,
            &ClientUpdateEvent::Available { release: candidate },
        );
        assert!(!state.overdue);
        reduce(&mut state, &ClientUpdateEvent::Overdue);
        reduce(&mut state, &ClientUpdateEvent::UpToDate);
        assert!(!state.overdue);
    }

    #[test]
    fn checking_again_brings_a_dismissed_update_back() {
        let mut state = ClientUpdateState::default();
        reduce(
            &mut state,
            &ClientUpdateEvent::Available {
                release: release("1.0.0"),
            },
        );
        reduce(
            &mut state,
            &ClientUpdateEvent::Dismissed {
                version: "1.0.0".into(),
            },
        );
        assert!(state.banner_release().is_none());
        reduce(
            &mut state,
            &ClientUpdateEvent::CheckStarted {
                current_version: "0.9.0".into(),
            },
        );
        reduce(
            &mut state,
            &ClientUpdateEvent::Available {
                release: release("1.0.0"),
            },
        );
        assert!(state.banner_release().is_some());
    }

    fn release(version: &str) -> ClientRelease {
        ClientRelease {
            version: version.into(),
            notes_url: format!("https://example.invalid/releases/{version}"),
            download_url: "https://example.invalid/installer.exe".into(),
            asset_name: "installer.exe".into(),
            size_bytes: 1024,
            pre_release: false,
            published_at: "2026-01-01T00:00:00Z".into(),
        }
    }

    #[test]
    fn a_higher_minor_wins_even_with_two_digits() {
        // The bug this function exists to prevent: compared as text, "1.9.0"
        // sorts above "1.10.0" and the client silently stops updating.
        assert!(should_update("1.9.0", "1.10.0"));
        assert!(!should_update("1.10.0", "1.9.0"));
        assert_eq!(compare_versions("1.10.0", "1.9.0"), Ordering::Greater);
    }

    #[test]
    fn the_v_prefix_is_irrelevant_on_either_side() {
        assert!(should_update("0.2.0", "v0.3.0"));
        assert!(should_update("v0.2.0", "0.3.0"));
        assert!(!should_update("v0.3.0", "v0.3.0"));
    }

    #[test]
    fn missing_segments_count_as_zero() {
        assert_eq!(compare_versions("1.2", "1.2.0"), Ordering::Equal);
        assert!(!should_update("1.2", "1.2.0"));
        assert!(should_update("1.2", "1.2.1"));
    }

    #[test]
    fn a_prerelease_sorts_below_the_release_it_leads_to() {
        assert_eq!(compare_versions("1.3.0-rc1", "1.3.0"), Ordering::Less);
        assert!(should_update("1.3.0-rc1", "1.3.0"));
        // …and someone on the finished release is not sent backwards to it.
        assert!(!should_update("1.3.0", "1.3.0-rc2"));
    }

    #[test]
    fn build_metadata_does_not_affect_precedence() {
        // Semver §10. Without the explicit split this would read as a
        // prerelease suffix and rank *below* the plain version.
        assert_eq!(compare_versions("1.3.0+build7", "1.3.0"), Ordering::Equal);
        assert!(!should_update("1.3.0", "1.3.0+build7"));
    }

    #[test]
    fn a_development_build_is_never_offered_an_update() {
        for current in ["", "snapshot", "SNAPSHOT", "unspecified", "vsnapshot"] {
            assert!(
                !should_update(current, "9.9.9"),
                "{current} must not be updated over"
            );
        }
    }

    #[test]
    fn a_malformed_candidate_is_ignored_rather_than_trusted() {
        // The remote side is not ours to fix; the right response to a tag we
        // cannot read is to offer nothing.
        for candidate in ["latest", "nightly", "1.0.0.0.0.0.0.0.0", "", "v"] {
            assert!(
                !should_update("1.0.0", candidate),
                "{candidate:?} must not be offered"
            );
        }
    }

    #[test]
    fn a_tag_that_could_escape_a_path_is_not_a_version() {
        // The adapter names the downloaded installer after the version and
        // then executes it, so this check is the one keeping a hostile tag out
        // of a `Path`.
        for tag in [
            "1.0.0-../../evil",
            "1.0.0-/etc/passwd",
            "1.0.0-a\\b",
            "1.0.0-a b",
            "../1.0.0",
            "1.0.0-\0",
        ] {
            assert!(!is_release_version(tag), "{tag:?} must be rejected");
        }
    }

    #[test]
    fn ordinary_release_tags_are_accepted() {
        for tag in ["1", "1.2", "v1.2.3", "0.2.0", "1.3.0-rc1", "1.3.0+build7"] {
            assert!(is_release_version(tag), "{tag} should be accepted");
        }
    }

    #[test]
    fn an_absurd_numeric_segment_is_refused_rather_than_clamped() {
        // Clamping would make two different nonsense tags compare equal, and
        // then "newer" would depend on which arrived first.
        assert!(!is_release_version("1.99999999999999999999999.0"));
    }

    #[test]
    fn a_check_records_the_running_version_before_it_finishes() {
        let mut state = ClientUpdateState::default();
        reduce(
            &mut state,
            &ClientUpdateEvent::CheckStarted {
                current_version: "0.2.0".into(),
            },
        );
        assert_eq!(state.current_version, "0.2.0");
        assert_eq!(state.status, ClientUpdateStatus::Checking);
        assert!(state.status.is_busy());
    }

    #[test]
    fn finding_nothing_new_clears_a_previously_offered_release() {
        // Otherwise installing an update out of band leaves the banner up
        // behind a status that says the client is current.
        let mut state = ClientUpdateState::default();
        reduce(
            &mut state,
            &ClientUpdateEvent::Available {
                release: release("0.3.0"),
            },
        );
        reduce(&mut state, &ClientUpdateEvent::UpToDate);
        assert_eq!(state.release, None);
        assert_eq!(state.status, ClientUpdateStatus::UpToDate);
        assert_eq!(state.banner_release(), None);
    }

    #[test]
    fn the_banner_follows_the_offer_through_download_and_install() {
        let mut state = ClientUpdateState::default();
        reduce(
            &mut state,
            &ClientUpdateEvent::Available {
                release: release("0.3.0"),
            },
        );
        assert_eq!(
            state.banner_release().map(|r| r.version.as_str()),
            Some("0.3.0")
        );

        for event in [
            ClientUpdateEvent::DownloadProgressed {
                received_bytes: 10,
                total_bytes: 100,
            },
            ClientUpdateEvent::Downloaded {
                path: "/tmp/installer.exe".into(),
            },
            ClientUpdateEvent::Installing,
        ] {
            reduce(&mut state, &event);
            assert!(
                state.banner_release().is_some(),
                "still showing after {event:?}"
            );
        }
    }

    /// A called-off download puts the offer back, not a failure, and a late
    /// cancel cannot take back an installer that is already whole.
    #[test]
    fn a_cancelled_download_puts_the_offer_back() {
        let mut state = ClientUpdateState::default();
        reduce(
            &mut state,
            &ClientUpdateEvent::Available {
                release: release("0.3.0"),
            },
        );
        reduce(
            &mut state,
            &ClientUpdateEvent::DownloadProgressed {
                received_bytes: 10,
                total_bytes: 100,
            },
        );
        reduce(&mut state, &ClientUpdateEvent::DownloadCancelled);
        assert_eq!(state.status, ClientUpdateStatus::Available);
        assert!(state.banner_release().is_some(), "the offer stays");

        reduce(
            &mut state,
            &ClientUpdateEvent::Downloaded {
                path: "installer.exe".into(),
            },
        );
        reduce(&mut state, &ClientUpdateEvent::DownloadCancelled);
        assert_eq!(
            state.status,
            ClientUpdateStatus::Ready {
                path: "installer.exe".into()
            }
        );
    }

    #[test]
    fn dismissing_hides_that_version_and_only_that_version() {
        let mut state = ClientUpdateState::default();
        reduce(
            &mut state,
            &ClientUpdateEvent::Available {
                release: release("0.3.0"),
            },
        );
        reduce(
            &mut state,
            &ClientUpdateEvent::Dismissed {
                version: "0.3.0".into(),
            },
        );
        assert_eq!(state.banner_release(), None);

        // The next release must get through: this is why the dismissal is a
        // version rather than a boolean.
        reduce(
            &mut state,
            &ClientUpdateEvent::Available {
                release: release("0.4.0"),
            },
        );
        assert_eq!(
            state.banner_release().map(|r| r.version.as_str()),
            Some("0.4.0")
        );
    }

    #[test]
    fn a_release_with_no_asset_for_this_platform_is_not_installable() {
        let mut without_asset = release("0.3.0");
        without_asset.download_url = String::new();
        assert!(!without_asset.is_installable());
        assert!(release("0.3.0").is_installable());
    }

    #[test]
    fn download_progress_is_a_percentage_only_when_the_size_is_known() {
        assert_eq!(ClientUpdateStatus::Idle.percent(), None);
        assert_eq!(
            ClientUpdateStatus::Downloading {
                received_bytes: 25,
                total_bytes: 100
            }
            .percent(),
            Some(25)
        );
        // No `Content-Length` is reported as zero, and must not divide.
        assert_eq!(
            ClientUpdateStatus::Downloading {
                received_bytes: 25,
                total_bytes: 0
            }
            .percent(),
            None
        );
        // 3 GB overflows `u32` once multiplied by 100.
        assert_eq!(
            ClientUpdateStatus::Downloading {
                received_bytes: 3_000_000_000,
                total_bytes: 4_000_000_000
            }
            .percent(),
            Some(75)
        );
    }

    #[test]
    fn only_the_in_flight_stages_count_as_busy() {
        assert!(ClientUpdateStatus::Checking.is_busy());
        assert!(ClientUpdateStatus::Downloading {
            received_bytes: 1,
            total_bytes: 2
        }
        .is_busy());
        for settled in [
            ClientUpdateStatus::Idle,
            ClientUpdateStatus::UpToDate,
            ClientUpdateStatus::Available,
            ClientUpdateStatus::Ready { path: "x".into() },
            ClientUpdateStatus::Installing,
            ClientUpdateStatus::Failed { reason: "x".into() },
        ] {
            assert!(!settled.is_busy(), "{settled:?} is not in flight");
        }
    }

    #[test]
    fn a_background_check_failure_does_not_raise_a_banner_on_its_own() {
        // `release` is `None` after a failed check, so there is nothing to
        // show: the error belongs in Settings, not in everyone's face.
        let mut state = ClientUpdateState::default();
        reduce(
            &mut state,
            &ClientUpdateEvent::Failed {
                reason: "github unreachable".into(),
            },
        );
        assert_eq!(state.banner_release(), None);
    }

    #[test]
    fn a_failure_after_an_offer_stays_visible() {
        // Here the user pressed a button, so the failure is an answer they are
        // waiting for.
        let mut state = ClientUpdateState::default();
        reduce(
            &mut state,
            &ClientUpdateEvent::Available {
                release: release("0.3.0"),
            },
        );
        reduce(
            &mut state,
            &ClientUpdateEvent::Failed {
                reason: "download failed".into(),
            },
        );
        assert!(state.banner_release().is_some());
    }

    /// The state after a check that found `version`, with `adjust` applied to
    /// the release first.
    fn offered(version: &str, adjust: impl FnOnce(&mut ClientRelease)) -> ClientUpdateState {
        let mut found = release(version);
        adjust(&mut found);
        let mut state = ClientUpdateState::default();
        reduce(&mut state, &ClientUpdateEvent::Available { release: found });
        reduce(&mut state, &ClientUpdateEvent::Overdue);
        state
    }

    #[test]
    fn a_stable_installable_release_is_required() {
        let state = offered("0.4.0", |_| {});
        assert_eq!(
            state.required_release().map(|r| r.version.as_str()),
            Some("0.4.0"),
        );
    }

    #[test]
    fn dismissing_hides_the_banner_and_not_the_gate() {
        // The whole difference between the two: a dismissal is the user saying
        // "I know", which is an answer to an offer and not to a requirement.
        let mut state = offered("0.4.0", |_| {});
        reduce(
            &mut state,
            &ClientUpdateEvent::Dismissed {
                version: "0.4.0".into(),
            },
        );
        assert_eq!(state.banner_release(), None);
        assert!(state.required_release().is_some());
    }

    #[test]
    fn a_prerelease_this_client_was_offered_is_required_too() {
        // Only a client on the prerelease channel is ever offered one, and
        // every release this project publishes is marked as a prerelease: if
        // this returned `None` the gate would be unreachable in practice,
        // which is exactly what it was.
        let state = offered("0.4.0-rc1", |release| release.pre_release = true);
        assert!(state.banner_release().is_some());
        assert_eq!(
            state.required_release().map(|r| r.version.as_str()),
            Some("0.4.0-rc1"),
        );
    }

    #[test]
    fn a_release_this_platform_cannot_install_is_never_required() {
        // Otherwise a Linux user, for whom a release may legitimately ship no
        // installer, is locked out of a client with no way to satisfy the
        // demand it is making.
        let state = offered("0.4.0", |release| release.download_url.clear());
        assert!(state.banner_release().is_some());
        assert_eq!(state.required_release(), None);
    }

    #[test]
    fn nothing_is_required_until_a_check_has_found_something() {
        let mut state = ClientUpdateState::default();
        assert_eq!(state.required_release(), None);

        reduce(
            &mut state,
            &ClientUpdateEvent::CheckStarted {
                current_version: "0.3.0".into(),
            },
        );
        assert_eq!(state.required_release(), None);

        reduce(&mut state, &ClientUpdateEvent::UpToDate);
        assert_eq!(state.required_release(), None);
    }

    #[test]
    fn an_update_server_having_a_bad_day_locks_nobody_out() {
        let mut state = ClientUpdateState::default();
        reduce(
            &mut state,
            &ClientUpdateEvent::CheckStarted {
                current_version: "0.3.0".into(),
            },
        );
        reduce(
            &mut state,
            &ClientUpdateEvent::Failed {
                reason: "github unreachable".into(),
            },
        );
        assert_eq!(state.required_release(), None);
    }

    #[test]
    fn a_failed_download_keeps_the_gate_up() {
        // Failing the download is not a way past the update; the gate shows
        // the reason and the button retries.
        let mut state = offered("0.4.0", |_| {});
        reduce(
            &mut state,
            &ClientUpdateEvent::Failed {
                reason: "connection reset".into(),
            },
        );
        assert!(state.required_release().is_some());
    }

    fn notes(version: &str) -> ClientReleaseNotes {
        ClientReleaseNotes {
            version: version.into(),
            published_at: Some("2026-02-01T00:00:00Z".into()),
            pre_release: true,
            notes_url: format!("https://example.invalid/releases/{version}"),
            blocks: vec![ChangelogBlock::Heading {
                level: 3,
                text: "Features".into(),
            }],
        }
    }

    #[test]
    fn loaded_notes_replace_the_list_wholesale() {
        let mut state = ClientUpdateState::default();
        reduce(&mut state, &ClientUpdateEvent::NotesLoading);
        assert_eq!(state.notes_status, ClientReleaseNotesStatus::Loading);

        reduce(
            &mut state,
            &ClientUpdateEvent::NotesLoaded {
                notes: vec![notes("0.3.0"), notes("0.2.0")],
            },
        );
        reduce(
            &mut state,
            &ClientUpdateEvent::NotesLoaded {
                notes: vec![notes("0.4.0")],
            },
        );
        assert_eq!(state.notes_status, ClientReleaseNotesStatus::Ready);
        assert_eq!(state.notes, vec![notes("0.4.0")]);
    }

    #[test]
    fn a_failed_first_load_is_reported() {
        let mut state = ClientUpdateState::default();
        reduce(&mut state, &ClientUpdateEvent::NotesLoading);
        reduce(
            &mut state,
            &ClientUpdateEvent::NotesFailed {
                reason: "github unreachable".into(),
            },
        );
        assert_eq!(
            state.notes_status,
            ClientReleaseNotesStatus::Failed {
                reason: "github unreachable".into()
            }
        );
    }

    #[test]
    fn a_refresh_of_notes_on_screen_neither_blanks_nor_breaks_them() {
        // The game changelog's rule: a list that is already showing is still
        // the list, and a flaky connection must not replace it with an error.
        let mut state = ClientUpdateState::default();
        reduce(
            &mut state,
            &ClientUpdateEvent::NotesLoaded {
                notes: vec![notes("0.3.0")],
            },
        );
        reduce(&mut state, &ClientUpdateEvent::NotesLoading);
        assert_eq!(state.notes_status, ClientReleaseNotesStatus::Ready);
        reduce(
            &mut state,
            &ClientUpdateEvent::NotesFailed {
                reason: "github unreachable".into(),
            },
        );
        assert_eq!(state.notes_status, ClientReleaseNotesStatus::Ready);
        assert_eq!(state.notes, vec![notes("0.3.0")]);
    }

    #[test]
    fn whats_new_is_pending_until_dismissed() {
        let mut state = ClientUpdateState::default();
        assert_eq!(state.whats_new, None);
        reduce(
            &mut state,
            &ClientUpdateEvent::WhatsNewPending {
                version: "0.4.0".into(),
            },
        );
        assert_eq!(state.whats_new.as_deref(), Some("0.4.0"));
        reduce(&mut state, &ClientUpdateEvent::WhatsNewDismissed);
        assert_eq!(state.whats_new, None);
    }

    #[test]
    fn whats_new_shows_only_after_an_update() {
        use WhatsNewOnStartup::*;
        // (last seen, running, preference) -> decision
        for (last_seen, current, enabled, expected) in [
            // A settings file from before the record: updated from an older
            // build, so the same as any update. (A fresh install has the
            // running build recorded by the settings load, and is the same
            // build again by the time this is asked.)
            (None, "0.4.0", true, Show),
            (None, "0.4.0", false, Remember),
            // Updated: shown when wanted, quietly recorded when not.
            (Some("0.3.0"), "0.4.0", true, Show),
            (Some("0.3.0"), "0.4.0", false, Remember),
            // Compared as versions, not as text.
            (Some("0.9.0"), "0.10.0", true, Show),
            (Some("v0.3.0"), "0.4.0", true, Show),
            // The same build again.
            (Some("0.4.0"), "0.4.0", true, Nothing),
            (Some("0.4"), "0.4.0", true, Nothing),
            // A downgrade is not news.
            (Some("0.5.0"), "0.4.0", true, Remember),
            // A record that is not a version says nothing about what came
            // before, so it is recorded over and nothing is shown.
            (Some("garbage"), "0.4.0", true, Remember),
            (Some(""), "0.4.0", true, Remember),
            // A development build leaves the record alone.
            (Some("0.3.0"), "test", true, Nothing),
            (None, "test", true, Nothing),
            (None, "", true, Nothing),
        ] {
            assert_eq!(
                whats_new_on_startup(last_seen, current, enabled),
                expected,
                "{last_seen:?} -> {current} (enabled: {enabled})"
            );
        }
    }

    #[test]
    fn the_gate_stays_up_through_the_whole_install() {
        let mut state = offered("0.4.0", |_| {});
        for event in [
            ClientUpdateEvent::DownloadProgressed {
                received_bytes: 512,
                total_bytes: 1024,
            },
            ClientUpdateEvent::Downloaded {
                path: "installer.exe".into(),
            },
            ClientUpdateEvent::Installing,
        ] {
            reduce(&mut state, &event);
            assert!(state.required_release().is_some(), "{event:?}");
        }
    }
}
