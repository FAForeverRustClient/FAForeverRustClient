//! Server-side map and mod vault queries.
//!
//! Both reference clients treat these vaults as paginated services and send the
//! filters to the API rather than downloading the catalogue and filtering it
//! locally. This builds the same requests.
//!
//! ## Where the property names come from
//!
//! Not from guesswork. A property the API does not recognise makes it reject the
//! whole `filter`, so the vault fails to load outright instead of degrading, and
//! there is no way to notice that without a live token. Every name below is
//! taken from the Java client, which is the reference implementation:
//!
//! - `query/SearchablePropertyMappings.java`: `MAP_PROPERTY_MAPPING` and
//!   `MOD_PROPERTY_MAPPING` list what is filterable and sortable.
//! - `map/MapVaultController.java` and `mod/ModVaultController.java`: the
//!   filters each vault actually installs.
//! - `map/MapService.java` and `mod/ModService.java`: the showroom queries, and
//!   so the sort properties (`reviewsSummary.lowerBound` for "highest rated",
//!   `latestVersion.createTime` for "newest", `gamesPlayed` for "most played").
//!
//! Note the asymmetry that follows from that: the rating *filter* is on
//! `reviewsSummary.averageScore` while the rating *sort* is on
//! `reviewsSummary.lowerBound`. That is what the Java client does, and the two
//! are different things: an average of 5.0 from one review should not outrank a
//! 4.8 from two hundred.

use serde::{Deserialize, Serialize};
use specta::Type;

/// Sort orders offered for the map vault. Every property is one the Java
/// client sorts by, so all of them are known-sortable server side.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum MapSortField {
    /// Wilson lower bound, not the raw average: see the module note.
    #[default]
    Rating,
    Newest,
    Played,
    Name,
    Size,
}

impl MapSortField {
    pub fn property(self) -> &'static str {
        match self {
            Self::Rating => "reviewsSummary.lowerBound",
            Self::Newest => "latestVersion.createTime",
            Self::Played => "gamesPlayed",
            Self::Name => "displayName",
            Self::Size => "latestVersion.width",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ModSortField {
    #[default]
    Rating,
    Newest,
    Updated,
    Name,
}

impl ModSortField {
    pub fn property(self) -> &'static str {
        match self {
            Self::Rating => "reviewsSummary.lowerBound",
            Self::Newest => "latestVersion.createTime",
            Self::Updated => "latestVersion.updateTime",
            Self::Name => "displayName",
        }
    }
}

/// A page of the map vault.
///
/// Empty strings and `None` mean "do not filter on this", so a default query is
/// the unfiltered highest-rated feed the tab opens with. Ratings are in tenths
/// to keep the whole state `Eq`, matching [`crate::state::VaultMap`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MapVaultQuery {
    /// Free text, matched against the map's display name.
    pub search: String,
    pub author: String,
    /// `None` = either; `Some(true)` = ranked only.
    pub ranked: Option<bool>,
    /// The "recommended" preset, which the API models as a flag on the map.
    pub recommended: bool,
    /// Average review score bounds, in tenths of a star (`43` = 4.3).
    pub min_rating_tenths: Option<i32>,
    pub max_rating_tenths: Option<i32>,
    pub min_players: Option<i32>,
    pub max_players: Option<i32>,
    /// Exact map edge length in pixels, `0` for any.
    pub width: i32,
    pub height: i32,
    /// Inclusive `YYYY-MM-DD` bounds on the upload date. Empty = unbounded.
    pub after: String,
    pub before: String,
    pub sort_by: MapSortField,
    pub sort_descending: bool,
    /// 1-based, matching the API's `page[number]`.
    pub page: u32,
    pub page_size: u32,
}

impl Default for MapVaultQuery {
    fn default() -> Self {
        Self {
            search: String::new(),
            author: String::new(),
            ranked: None,
            recommended: false,
            min_rating_tenths: None,
            max_rating_tenths: None,
            min_players: None,
            max_players: None,
            width: 0,
            height: 0,
            after: String::new(),
            before: String::new(),
            sort_by: MapSortField::Rating,
            sort_descending: true,
            page: 1,
            page_size: 36,
        }
    }
}

/// A page of the mod vault.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ModVaultQuery {
    pub search: String,
    /// Matched against the mod's author, which on this endpoint is a plain
    /// string field rather than a related player (`MOD_PROPERTY_MAPPING`).
    pub author: String,
    /// `ui` or `sim`; empty for either.
    pub mod_type: String,
    pub ranked: Option<bool>,
    pub recommended: bool,
    pub min_rating_tenths: Option<i32>,
    pub max_rating_tenths: Option<i32>,
    /// Which timestamp the date bounds apply to: `updated` or `uploaded`.
    pub date_field_updated: bool,
    pub after: String,
    pub before: String,
    pub sort_by: ModSortField,
    pub sort_descending: bool,
    pub page: u32,
    pub page_size: u32,
}

impl Default for ModVaultQuery {
    fn default() -> Self {
        Self {
            search: String::new(),
            author: String::new(),
            mod_type: String::new(),
            ranked: None,
            recommended: false,
            min_rating_tenths: None,
            max_rating_tenths: None,
            date_field_updated: true,
            after: String::new(),
            before: String::new(),
            sort_by: ModSortField::Rating,
            sort_descending: true,
            page: 1,
            page_size: 36,
        }
    }
}

/// The API's `sort` parameter. A leading `-` means descending.
fn sort_param(property: &str, descending: bool) -> String {
    if descending {
        format!("-{property}")
    } else {
        property.to_string()
    }
}

impl MapVaultQuery {
    pub fn sort_param(&self) -> String {
        sort_param(self.sort_by.property(), self.sort_descending)
    }

    /// The RSQL `filter`, or `None` when nothing narrows the search.
    pub fn build_filter(&self) -> Option<String> {
        let mut clauses = vec![
            // Hidden versions are never browsable, which is why this is not
            // conditional: it is the same clause the catalogue crawl uses.
            "latestVersion.hidden=='false'".to_string(),
        ];
        if self.recommended {
            clauses.push(r#"recommended=="true""#.to_string());
        }
        if !self.search.is_empty() {
            clauses.push(format!(r#"displayName=="{}""#, glob(&self.search)));
        }
        if !self.author.is_empty() {
            clauses.push(format!(r#"author.login=="{}""#, glob(&self.author)));
        }
        if let Some(ranked) = self.ranked {
            clauses.push(format!(r#"latestVersion.ranked=="{ranked}""#));
        }
        push_range(
            &mut clauses,
            "reviewsSummary.averageScore",
            self.min_rating_tenths.map(tenths_to_score),
            self.max_rating_tenths.map(tenths_to_score),
        );
        push_range(
            &mut clauses,
            "latestVersion.maxPlayers",
            self.min_players.map(|value| value.to_string()),
            self.max_players.map(|value| value.to_string()),
        );
        if self.width > 0 {
            clauses.push(format!(r#"latestVersion.width=="{}""#, self.width));
        }
        if self.height > 0 {
            clauses.push(format!(r#"latestVersion.height=="{}""#, self.height));
        }
        push_dates(
            &mut clauses,
            "latestVersion.createTime",
            &self.after,
            &self.before,
        );
        Some(clauses.join(";"))
    }
}

impl ModVaultQuery {
    pub fn sort_param(&self) -> String {
        sort_param(self.sort_by.property(), self.sort_descending)
    }

    pub fn build_filter(&self) -> Option<String> {
        let mut clauses = vec!["latestVersion.hidden=='false'".to_string()];
        if self.recommended {
            clauses.push(r#"recommended=="true""#.to_string());
        }
        if !self.search.is_empty() {
            clauses.push(format!(r#"displayName=="{}""#, glob(&self.search)));
        }
        if !self.author.is_empty() {
            clauses.push(format!(r#"author=="{}""#, glob(&self.author)));
        }
        if !self.mod_type.is_empty() {
            // The API spells these upper case (`ModVaultController` filters
            // `latestVersion.type` against `UI` and `SIM`), while this client
            // carries them lower case.
            clauses.push(format!(
                r#"latestVersion.type=="{}""#,
                escape(&self.mod_type).to_uppercase()
            ));
        }
        if let Some(ranked) = self.ranked {
            clauses.push(format!(r#"latestVersion.ranked=="{ranked}""#));
        }
        push_range(
            &mut clauses,
            "reviewsSummary.averageScore",
            self.min_rating_tenths.map(tenths_to_score),
            self.max_rating_tenths.map(tenths_to_score),
        );
        let date_property = if self.date_field_updated {
            "latestVersion.updateTime"
        } else {
            "latestVersion.createTime"
        };
        push_dates(&mut clauses, date_property, &self.after, &self.before);
        Some(clauses.join(";"))
    }
}

/// Tenths back to the decimal the API compares against (`43` -> `4.3`).
fn tenths_to_score(tenths: i32) -> String {
    format!("{}.{}", tenths / 10, (tenths % 10).abs())
}

fn push_range(clauses: &mut Vec<String>, property: &str, min: Option<String>, max: Option<String>) {
    if let Some(min) = min {
        clauses.push(format!("{property}=ge={min}"));
    }
    if let Some(max) = max {
        clauses.push(format!("{property}=le={max}"));
    }
}

/// Date bounds, expanded to instants.
///
/// A bare `YYYY-MM-DD` is rejected by this API where a full instant is accepted;
/// the replay vault hit exactly that and every dated search failed. `before` is
/// expanded to the end of its day, because a bound documented as inclusive that
/// excludes the whole named day is not what a date picker implies.
fn push_dates(clauses: &mut Vec<String>, property: &str, after: &str, before: &str) {
    if !after.is_empty() {
        clauses.push(format!("{property}=ge='{}'", as_instant(after, false)));
    }
    if !before.is_empty() {
        clauses.push(format!("{property}=le='{}'", as_instant(before, true)));
    }
}

fn as_instant(value: &str, end_of_day: bool) -> String {
    let is_date_only = value.len() == 10
        && value.as_bytes()[4] == b'-'
        && value.as_bytes()[7] == b'-'
        && value
            .bytes()
            .enumerate()
            .all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit());
    if !is_date_only {
        return escape(value);
    }
    if end_of_day {
        format!("{value}T23:59:59Z")
    } else {
        format!("{value}T00:00:00Z")
    }
}

fn glob(value: &str) -> String {
    format!("*{}*", escape(value))
}

/// Strip the characters that would break out of a quoted RSQL argument. The API
/// offers no escape syntax, so removal is the only safe option, and none of
/// these are meaningful in a map name, mod name or login.
fn escape(value: &str) -> String {
    value
        .chars()
        .filter(|c| !matches!(c, '"' | '\\' | '*' | ';' | '(' | ')' | ',' | '\''))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unfiltered_map_query_still_hides_hidden_versions() {
        let query = MapVaultQuery::default();
        assert_eq!(
            query.build_filter().unwrap(),
            "latestVersion.hidden=='false'"
        );
        assert_eq!(query.sort_param(), "-reviewsSummary.lowerBound");
    }

    #[test]
    fn map_filters_use_the_java_clients_property_names() {
        let query = MapVaultQuery {
            search: "seton".into(),
            author: "Nory".into(),
            ranked: Some(true),
            recommended: true,
            min_rating_tenths: Some(43),
            max_rating_tenths: Some(50),
            min_players: Some(2),
            max_players: Some(8),
            width: 1024,
            height: 512,
            after: "2026-01-01".into(),
            before: "2026-08-16".into(),
            ..MapVaultQuery::default()
        };
        let filter = query.build_filter().unwrap();
        for expected in [
            "latestVersion.hidden=='false'",
            r#"recommended=="true""#,
            r#"displayName=="*seton*""#,
            r#"author.login=="*Nory*""#,
            r#"latestVersion.ranked=="true""#,
            "reviewsSummary.averageScore=ge=4.3",
            "reviewsSummary.averageScore=le=5.0",
            "latestVersion.maxPlayers=ge=2",
            "latestVersion.maxPlayers=le=8",
            r#"latestVersion.width=="1024""#,
            r#"latestVersion.height=="512""#,
            "latestVersion.createTime=ge='2026-01-01T00:00:00Z'",
            "latestVersion.createTime=le='2026-08-16T23:59:59Z'",
        ] {
            assert!(
                filter.contains(expected),
                "missing `{expected}` in {filter}"
            );
        }
    }

    /// The bound is documented as inclusive, so "before the 16th" has to include
    /// the whole of the 16th. A bare date is also not accepted by this API.
    #[test]
    fn the_before_bound_covers_its_whole_day() {
        let query = MapVaultQuery {
            before: "2026-08-16".into(),
            ..MapVaultQuery::default()
        };
        assert!(query
            .build_filter()
            .unwrap()
            .contains("=le='2026-08-16T23:59:59Z'"));
    }

    #[test]
    fn an_unranked_filter_is_distinct_from_no_filter() {
        let any = MapVaultQuery::default();
        assert!(!any.build_filter().unwrap().contains("ranked"));

        let unranked = MapVaultQuery {
            ranked: Some(false),
            ..MapVaultQuery::default()
        };
        assert!(unranked
            .build_filter()
            .unwrap()
            .contains(r#"latestVersion.ranked=="false""#));
    }

    /// A quote or a semicolon in a search box would otherwise end the argument
    /// and turn the rest of the name into RSQL.
    #[test]
    fn search_text_cannot_break_out_of_its_quotes() {
        let query = MapVaultQuery {
            search: r#"a";b=="c"#.into(),
            ..MapVaultQuery::default()
        };
        let filter = query.build_filter().unwrap();
        assert!(filter.contains(r#"displayName=="*ab==c*""#), "{filter}");
    }

    #[test]
    fn mod_type_is_sent_the_way_the_api_spells_it() {
        let query = ModVaultQuery {
            mod_type: "ui".into(),
            ..ModVaultQuery::default()
        };
        assert!(query
            .build_filter()
            .unwrap()
            .contains(r#"latestVersion.type=="UI""#));
    }

    #[test]
    fn the_mod_date_bounds_follow_the_chosen_field() {
        let updated = ModVaultQuery {
            after: "2026-01-01".into(),
            date_field_updated: true,
            ..ModVaultQuery::default()
        };
        assert!(updated
            .build_filter()
            .unwrap()
            .contains("latestVersion.updateTime=ge="));

        let uploaded = ModVaultQuery {
            after: "2026-01-01".into(),
            date_field_updated: false,
            ..ModVaultQuery::default()
        };
        assert!(uploaded
            .build_filter()
            .unwrap()
            .contains("latestVersion.createTime=ge="));
    }

    #[test]
    fn ascending_sorts_drop_the_leading_minus() {
        let query = MapVaultQuery {
            sort_by: MapSortField::Name,
            sort_descending: false,
            ..MapVaultQuery::default()
        };
        assert_eq!(query.sort_param(), "displayName");
    }

    #[test]
    fn rating_tenths_become_the_decimal_the_api_compares() {
        assert_eq!(tenths_to_score(43), "4.3");
        assert_eq!(tenths_to_score(50), "5.0");
        assert_eq!(tenths_to_score(0), "0.0");
    }
}
