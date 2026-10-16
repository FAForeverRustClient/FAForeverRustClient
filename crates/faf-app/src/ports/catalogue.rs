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
