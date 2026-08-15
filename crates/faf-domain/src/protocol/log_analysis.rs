//! Recognising known problems in a Forged Alliance log.
//!
//! Mirrors the Java client's `LogAnalyzerService`. A game log is thousands of
//! engine trace lines, and the two failures users actually hit are both
//! invisible in that wall of text unless you already know the string to search
//! for. Surfacing them turns "the game crashed" into an actionable sentence.
//!
//! Only the *detection* lives here: this returns which issues were found, not
//! the sentence describing them. The wording is a UI concern (and a translated
//! one), and keeping it out of the domain means adding a language does not
//! touch this module.
//!
//! Deliberately conservative. A false positive tells a user their sound driver
//! is broken when it is not, which is worse than saying nothing, so each rule
//! matches the same literal traces the Java client matches and nothing more.

use serde::{Deserialize, Serialize};
use specta::Type;

/// The engine logs this whenever the window loses fullscreen, including via
/// Alt+Tab. Matched case-sensitively, exactly as the Java client does.
const MINIMIZED_TRACE: &str = "info: Minimized true";

/// The sound rule needs *both* markers. `warning: SND` alone is common and
/// harmless; it only indicates the crash-causing XACT problem together with the
/// XACT trace, which is why the Java client requires the pair.
const SOUND_WARNING_TRACE: &str = "warning: SND";
const SOUND_XACT_TRACE: &str = "XACT";

/// A problem recognised in a game log.
///
/// An enum rather than a message, so the UI owns the wording and its
/// translation, and so a new detection cannot silently change what an existing
/// one says.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum LogIssue {
    /// The game was minimized or Alt+Tabbed out of fullscreen, which the engine
    /// tolerates poorly and is a routine cause of crashes.
    GameMinimized,
    /// XACT sound failures, usually caused by OS sound settings or third-party
    /// audio software rather than by the game.
    SoundDriver,
}

/// Which known problems appear in `contents`.
///
/// Order is stable and matches declaration order, so the same log always
/// produces the same list rather than one that shuffles between runs.
pub fn analyze_game_log(contents: &str) -> Vec<LogIssue> {
    let mut issues = Vec::new();
    if contents.contains(MINIMIZED_TRACE) {
        issues.push(LogIssue::GameMinimized);
    }
    if contents.contains(SOUND_WARNING_TRACE) && contents.contains(SOUND_XACT_TRACE) {
        issues.push(LogIssue::SoundDriver);
    }
    issues
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_clean_log_reports_nothing() {
        assert!(analyze_game_log("info: loading map\ninfo: game started").is_empty());
        assert!(analyze_game_log("").is_empty());
    }

    #[test]
    fn a_minimized_game_is_recognised() {
        let log = "info: session start\ninfo: Minimized true\ninfo: session end";
        assert_eq!(analyze_game_log(log), vec![LogIssue::GameMinimized]);
    }

    #[test]
    fn the_sound_rule_needs_both_markers() {
        // `warning: SND` on its own is ordinary and must not accuse the user's
        // audio setup of a fault it does not have.
        assert!(analyze_game_log("warning: SND buffer underrun").is_empty());
        assert!(analyze_game_log("XACT engine ready").is_empty());
        assert_eq!(
            analyze_game_log("warning: SND failure\nXACT invalid arg"),
            vec![LogIssue::SoundDriver]
        );
    }

    #[test]
    fn several_issues_come_back_in_a_stable_order() {
        let log = "warning: SND failure\ninfo: Minimized true\nXACT invalid arg";
        assert_eq!(
            analyze_game_log(log),
            vec![LogIssue::GameMinimized, LogIssue::SoundDriver],
            "declaration order, not order of appearance in the log"
        );
    }

    #[test]
    fn matching_is_case_sensitive_like_the_java_client() {
        // The engine writes these traces in exactly one casing. Loosening the
        // match is how a rule starts firing on unrelated lines.
        assert!(analyze_game_log("info: minimized true").is_empty());
    }
}
