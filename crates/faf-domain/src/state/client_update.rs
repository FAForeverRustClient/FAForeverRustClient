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
    /// The running build's version, filled in by the first check.
    pub current_version: String,
    pub release: Option<ClientRelease>,
    /// The version the user waved away. Empty when nothing is dismissed.
    ///
    /// Kept per-version rather than as a flag so that dismissing `0.3.0` does
    /// not also hide `0.4.0`: the reason a "don't show again" checkbox is the
    /// wrong shape for this.
    pub dismissed_version: String,
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
    DownloadProgressed {
        received_bytes: u32,
        total_bytes: u32,
    },
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
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum ClientUpdateCommand {
    /// Ask the release source what the newest build is. Runs automatically at
    /// startup unless the user turned that off.
    Check,
    /// Fetch the installer for the release already in state.
    Download,
    /// Start the downloaded installer.
    ///
    /// The client does **not** exit itself. On Windows an installer cannot
    /// replace a running executable, so the user has to close the client: the
    /// UI says so. Quitting on the user's behalf would risk killing a game
    /// launch or an upload that is still in flight.
    Install,
    /// Hide the banner for the release currently offered.
    Dismiss,
}

pub fn reduce(state: &mut ClientUpdateState, event: &ClientUpdateEvent) {
    match event {
        ClientUpdateEvent::CheckStarted { current_version } => {
            state.current_version = current_version.clone();
            state.status = ClientUpdateStatus::Checking;
        }
        ClientUpdateEvent::UpToDate => {
            // Drop any previously offered release: the user may have installed
            // it out of band, and keeping it would leave a stale banner behind
            // a status that says everything is current.
            state.release = None;
            state.status = ClientUpdateStatus::UpToDate;
        }
        ClientUpdateEvent::Available { release } => {
            state.release = Some(release.clone());
            state.status = ClientUpdateStatus::Available;
        }
        ClientUpdateEvent::DownloadProgressed {
            received_bytes,
            total_bytes,
        } => {
            state.status = ClientUpdateStatus::Downloading {
                received_bytes: *received_bytes,
                total_bytes: *total_bytes,
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
