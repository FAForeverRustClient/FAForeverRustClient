//! How big the authoritative state is, slice by slice, written to the client
//! log now and then.
//!
//! Everything the client holds lives in one [`faf_domain::AppState`], and the
//! webview mirrors all of it. Whether that is fine at a populated catalogue,
//! and whether anything in it only ever grows over a long session, were
//! questions a review could only raise: nothing measured them. This takes the
//! state's serialised size per slice shortly after startup and again every
//! half hour, so a session that ran all evening leaves its growth behind as
//! numbers.
//!
//! The state is cloned under the read lock and measured outside it, so a
//! writer waits for one copy, not for the serialising.

use std::time::Duration;

use super::EventSink;

/// The first census: late enough for login, the lobby and the vaults to have
/// filled the state in.
const FIRST_CENSUS_AFTER: Duration = Duration::from_secs(120);

/// Every later one.
const CENSUS_INTERVAL: Duration = Duration::from_secs(30 * 60);

pub(super) fn spawn(sink: EventSink) {
    tokio::spawn(async move {
        tokio::time::sleep(FIRST_CENSUS_AFTER).await;
        let mut ticker = tokio::time::interval(CENSUS_INTERVAL);
        loop {
            ticker.tick().await;
            let reader = sink.clone();
            let census = tokio::task::spawn_blocking(move || {
                let state = reader.with_state(Clone::clone);
                slice_sizes(&state)
            })
            .await;
            if let Ok(Some((total, slices))) = census {
                tracing::info!(total_bytes = total, slices = %slices, "state census");
            }
        }
    });
}

/// The whole state's serialised size, and each top-level slice's, largest
/// first, as "maps=3712345 lobby=81234 ...".
fn slice_sizes(state: &faf_domain::AppState) -> Option<(usize, String)> {
    // Destructure exhaustively so adding a slice requires updating the census.
    // Count directly into a sink instead of cloning JSON values and buffers.
    macro_rules! slices {
        ($($field:ident => $name:literal),+ $(,)?) => {{
            let faf_domain::AppState { $($field),+ } = state;
            vec![$(($name, serialized_size($field)?)),+]
        }};
    }
    let mut sizes = slices!(
        session => "session",
        install => "install",
        auth => "auth",
        nav => "nav",
        notifications => "notifications",
        chat => "chat",
        clan => "clan",
        coop => "coop",
        events => "events",
        lobby => "lobby",
        replays => "replays",
        maps => "maps",
        map_generator => "mapGenerator",
        mods => "mods",
        leaderboard => "leaderboard",
        player_card => "playerCard",
        reporting => "reporting",
        reviews => "reviews",
        social => "social",
        streams => "streams",
        tourney => "tourney",
        training => "training",
        tutorials => "tutorials",
        uploads => "uploads",
        galactic_war => "galacticWar",
        linux_runtime => "linuxRuntime",
        guides => "guides",
        client_update => "clientUpdate",
        settings => "settings",
        changelog => "changelog",
        connectivity => "connectivity",
    );
    sizes.sort_by_key(|(_, bytes)| std::cmp::Reverse(*bytes));
    let total = 2
        + sizes
            .iter()
            .map(|(name, bytes)| name.len() + 3 + bytes)
            .sum::<usize>()
        + sizes.len().saturating_sub(1);
    let slices = sizes
        .iter()
        .map(|(name, bytes)| format!("{name}={bytes}"))
        .collect::<Vec<_>>()
        .join(" ");
    Some((total, slices))
}

fn serialized_size(value: &impl serde::Serialize) -> Option<usize> {
    struct Counter(usize);
    impl std::io::Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0 += bytes.len();
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut counter = Counter(0);
    serde_json::to_writer(&mut counter, value).ok()?;
    Some(counter.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_slice_is_listed_largest_first_and_adds_up_to_about_the_total() {
        let state = faf_domain::AppState::default();
        let (total, slices) = slice_sizes(&state).expect("measured");
        assert_eq!(total, serde_json::to_vec(&state).unwrap().len());
        let sizes: Vec<usize> = slices
            .split(' ')
            .map(|entry| {
                entry
                    .split_once('=')
                    .and_then(|(_, bytes)| bytes.parse().ok())
                    .expect("name=bytes")
            })
            .collect();
        assert!(
            sizes.len() > 5,
            "the state has more than a handful of slices"
        );
        assert!(sizes.windows(2).all(|pair| pair[0] >= pair[1]));
        // The total adds braces, keys, quotes and commas around the slices.
        assert!(total > sizes.iter().sum::<usize>());
    }
}
