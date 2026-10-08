//! Business logic. One module per feature.
//!
//! A service consumes a command, performs side effects through [`crate::ports`],
//! and emits events via the [`EventSink`](crate::EventSink). A service **never**
//! touches `AppState` directly (ARCHITECTURE.md §3.4).

/// The wall clock as Unix seconds.
///
/// Shared because three services need it for the same reason: deciding
/// whether something has already happened: and three copies is three chances
/// to get the saturation wrong. Saturates at zero rather than wrapping: a clock
/// set before 1970 would otherwise become a colossal future timestamp, which
/// reads as "every tournament has finished" and "every match is old enough to
/// spectate".
pub(crate) fn now_seconds() -> u32 {
    u32::try_from(chrono::Utc::now().timestamp()).unwrap_or(0)
}

/// The share of a transfer that has arrived, in whole percent, or `None`
/// while the size is not known.
pub(crate) fn percent_of(received: u64, total: Option<u64>) -> Option<u8> {
    let total = total.filter(|total| *total > 0)?;
    Some((received.min(total) * 100 / total) as u8)
}

/// Report a transfer's progress through `emit`, but only when the whole
/// percent it shows changes.
///
/// An adapter reports once per chunk received, which is hundreds of times for
/// one map, and every report that reached the sink would be an event the whole
/// state is reduced by and the webview redraws for. `None` (no size known, or
/// a step with nothing to measure) is reported once on the way in, and is
/// taken to be what the operation's start already said.
pub(crate) fn whole_percent_reporter(
    emit: impl Fn(Option<u8>) + Send + Sync + 'static,
) -> impl Fn(Option<u8>) + Send + Sync + 'static {
    let shown = std::sync::Mutex::new(None::<u8>);
    move |progress: Option<u8>| {
        let mut last = shown
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if *last != progress {
            *last = progress;
            emit(progress);
        }
    }
}

/// A vault install's steps as a whole-percent progress, see
/// [`whole_percent_reporter`]. Unpacking has nothing to measure, so the bar
/// goes back to sweeping while the archive is unpacked.
pub(crate) fn vault_install_progress(
    emit: impl Fn(Option<u8>) + Send + Sync + 'static,
) -> crate::ports::VaultInstallProgress {
    let report = whole_percent_reporter(emit);
    std::sync::Arc::new(move |step| {
        report(match step {
            crate::ports::VaultInstallStep::Downloading {
                received_bytes,
                total_bytes,
            } => percent_of(received_bytes, total_bytes),
            crate::ports::VaultInstallStep::Unpacking => None,
        })
    })
}

pub mod auth;
pub mod changelog;
pub mod chat;
pub mod clan;
pub mod client_update;
pub mod connectivity;
pub mod coop;
pub mod discord;
pub mod events;
pub mod galactic_war;
pub mod guides;
pub mod launcher;
pub mod leaderboard;
pub mod lobby;
pub mod map_generator;
pub mod maps;
pub mod mods;
pub mod nav;
pub mod notifications;
pub mod player_card;
pub mod reconnect;
pub mod replays;
pub mod reporting;
pub mod reviews;
pub mod session;
pub mod settings;
pub mod social;
pub mod streams;
pub mod tourney;
pub mod training;
pub mod tutorials;
pub mod uploads;

#[cfg(test)]
mod progress_tests {
    use super::*;

    /// One report per whole percent, however many chunks it takes, and an
    /// unknown size said once rather than per chunk.
    #[test]
    fn only_a_change_of_whole_percent_is_reported() {
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let report = {
            let seen = seen.clone();
            vault_install_progress(move |progress| seen.lock().unwrap().push(progress))
        };
        for received in [0, 1, 9, 10, 15, 1_000] {
            report(crate::ports::VaultInstallStep::Downloading {
                received_bytes: received,
                total_bytes: Some(1_000),
            });
        }
        report(crate::ports::VaultInstallStep::Unpacking);
        report(crate::ports::VaultInstallStep::Unpacking);
        assert_eq!(
            *seen.lock().unwrap(),
            [Some(0), Some(1), Some(100), None],
            "every chunk was an event"
        );
        assert_eq!(percent_of(5, None), None);
        assert_eq!(percent_of(5, Some(0)), None);
        assert_eq!(percent_of(2_000, Some(1_000)), Some(100));
    }
}
