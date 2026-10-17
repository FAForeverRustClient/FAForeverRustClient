//! Cache metadata shared by the map and mod lookup catalogues.
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

/// Weekly full reads remove deleted records that a timestamp delta cannot report.
pub const FULL_REFRESH_AFTER: Duration = Duration::days(7);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedCatalogue<T> {
    pub full_at: String,
    pub newest_change: String,
    pub entries: Vec<T>,
}

impl<T> CachedCatalogue<T> {
    pub fn age_seconds(&self, now: DateTime<Utc>) -> Option<i64> {
        DateTime::parse_from_rfc3339(&self.full_at)
            .ok()
            .map(|at| now.signed_duration_since(at).num_seconds())
    }

    pub fn needs_full_refresh(&self, now: DateTime<Utc>) -> bool {
        DateTime::parse_from_rfc3339(&self.full_at).map_or(true, |at| {
            let age = now.signed_duration_since(at);
            age < Duration::zero() || age >= FULL_REFRESH_AFTER
        })
    }
}

/// API metadata stays outside VaultMap/VaultMod, whose readers do not need it.
#[derive(Debug, Clone, Default)]
pub struct CatalogueBatch<T> {
    pub entries: Vec<T>,
    pub newest_change: String,
    pub removed_ids: Vec<i32>,
    pub pages: u32,
}

/// Apply a delta to a saved catalogue: every entry under a changed key is
/// replaced, a change `keep` refuses (a hidden or removed entry) only removes
/// its entry, and each key is held once even when the delta lists it twice.
/// A replaced entry keeps its place, so the saved copy keeps its order.
pub fn merge_changes<T: Clone>(
    entries: &mut Vec<T>,
    changes: &[T],
    key: impl Fn(&T) -> i32,
    keep: impl Fn(&T) -> bool,
) {
    use std::collections::{HashMap, HashSet};
    // The last change listed for a key wins.
    let latest: HashMap<i32, &T> = changes.iter().map(|change| (key(change), change)).collect();
    let mut placed = HashSet::new();
    entries.retain_mut(|entry| {
        let id = key(entry);
        match latest.get(&id) {
            None => true,
            Some(change) if keep(change) && placed.insert(id) => {
                *entry = (*change).clone();
                true
            }
            Some(_) => false,
        }
    });
    for change in changes {
        let id = key(change);
        if latest
            .get(&id)
            .is_some_and(|latest| std::ptr::eq(*latest, change))
            && keep(change)
            && placed.insert(id)
        {
            entries.push(change.clone());
        }
    }
}

/// Whether a delta would change anything a saved catalogue holds. A delta
/// always returns at least the records at its lower bound, so most starts get
/// back only entries already held, and republishing those rebuilt the whole
/// lookup index in the page and rewrote the file for nothing.
pub fn changes_anything<T: PartialEq>(
    entries: &[T],
    changes: &[T],
    key: impl Fn(&T) -> i32,
    keep: impl Fn(&T) -> bool,
) -> bool {
    changes.iter().any(|change| {
        let held = entries.iter().find(|entry| key(entry) == key(change));
        if keep(change) {
            held != Some(change)
        } else {
            held.is_some()
        }
    })
}

/// Whether `candidate` is a later change time than `current`.
pub fn is_later(candidate: &str, current: &str) -> bool {
    match (
        DateTime::parse_from_rfc3339(candidate),
        DateTime::parse_from_rfc3339(current),
    ) {
        (Ok(candidate), Ok(current)) => candidate > current,
        (Ok(_), Err(_)) => true,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn merge_changes_replaces_in_place_and_holds_each_key_once() {
        // (key, version); a negative version stands for a hidden change.
        let key = |entry: &(i32, i32)| entry.0;
        let keep = |entry: &(i32, i32)| entry.1 >= 0;
        let mut entries = vec![(1, 1), (2, 1), (3, 1), (2, 0)];
        let changes = [(2, 2), (4, 1), (3, -1), (4, 2), (5, -1)];
        assert!(changes_anything(&entries, &changes, key, keep));
        merge_changes(&mut entries, &changes, key, keep);
        assert_eq!(entries, [(1, 1), (2, 2), (4, 2)]);
        assert!(!changes_anything(&entries, &[(1, 1), (5, -1)], key, keep));
    }
}
