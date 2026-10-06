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
            let state = sink.with_state(Clone::clone);
            let census = tokio::task::spawn_blocking(move || slice_sizes(&state)).await;
            if let Ok(Some((total, slices))) = census {
                tracing::info!(total_bytes = total, slices = %slices, "state census");
            }
        }
    });
}

/// The whole state's serialised size, and each top-level slice's, largest
/// first, as "maps=3712345 lobby=81234 ...".
fn slice_sizes(state: &faf_domain::AppState) -> Option<(usize, String)> {
    let value = serde_json::to_value(state).ok()?;
    let object = value.as_object()?;
    let mut sizes: Vec<(&str, usize)> = object
        .iter()
        .map(|(name, slice)| {
            let bytes = serde_json::to_vec(slice).map_or(0, |json| json.len());
            (name.as_str(), bytes)
        })
        .collect();
    sizes.sort_by_key(|(_, bytes)| std::cmp::Reverse(*bytes));
    let total = serde_json::to_vec(&value).map_or(0, |json| json.len());
    let slices = sizes
        .iter()
        .map(|(name, bytes)| format!("{name}={bytes}"))
        .collect::<Vec<_>>()
        .join(" ");
    Some((total, slices))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_slice_is_listed_largest_first_and_adds_up_to_about_the_total() {
        let (total, slices) = slice_sizes(&faf_domain::AppState::default()).expect("measured");
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
