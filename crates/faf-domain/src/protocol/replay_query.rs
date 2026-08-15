//! Replay vault search: the RSQL filter both reference clients build against
//! the FAF Data API's `/data/game` endpoint.
//!
//! The API takes an RSQL expression in `filter`, e.g.
//! `(validity=="VALID";mapVersion.map.displayName=="*setons*")`. Both clients
//! assemble that string by hand; this module is the same assembly, pure and
//! testable, with the property names taken from the Java client's
//! `SearchablePropertyMappings.GAME_PROPERTY_MAPPING` and the value encodings
//! from the Python client's `prepareFilters`.
//!
//! ## Two details worth keeping
//!
//! **Ratings are offset by +300.** The API exposes `meanBefore`, the raw
//! TrueSkill mean, while players think in *displayed* rating
//! (`mean - 3*deviation`). Both clients bridge that by adding 300: assuming a
//! deviation around 100: rather than filtering on a field the API doesn't
//! have. The Java client carries a `//TODO` about it; we inherit the same
//! approximation so a search for "1500+" means the same thing in all three.
//!
//! **Unbounded searches get a date floor.** The Python client's comment is
//! blunt about why: a filtered query with no time bound can take the database
//! tens of seconds. It therefore adds `startTime=ge=<3 months ago>` (6 months
//! when a player name narrows it) whenever the user set filters but no
//! explicit dates. [`ReplayQuery::fallback_months`] is that rule; the caller
//! supplies the resulting timestamp so this module stays clock-free.

use serde::{Deserialize, Serialize};
use specta::Type;

/// The offset from raw TrueSkill mean to displayed rating: see module docs.
const RATING_MEAN_OFFSET: i32 = 300;

/// FA simulates 10 ticks per second, so a minute is 600 ticks. The Java
/// client's duration filter does the same conversion (`value * 60 * 10`).
const TICKS_PER_MINUTE: i32 = 600;

/// Pixels per kilometre of map. The engine's 10x10 km map is 512x512, which is
/// the Java client's `MapSize.MAP_SIZE_FACTOR`: the API stores pixels while
/// players think in km, so the filter converts.
const MAP_PIXELS_PER_KM: f32 = 51.2;

/// The rating range the sliders span. The Java client's
/// `ChatUserFilterController.MIN_RATING`/`MAX_RATING`, reused there for the
/// replay search's rating filter.
pub const MIN_RATING: i32 = -1000;
pub const MAX_RATING: i32 = 4000;

/// Which property the results are ordered by. The sortable subset of the Java
/// client's `GAME_PROPERTY_MAPPING` (its `Property::sortable` flag).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ReplaySortField {
    #[default]
    StartTime,
    EndTime,
    Duration,
    ReviewScore,
    Title,
    Id,
    VictoryCondition,
}

impl ReplaySortField {
    /// The API property name behind this option.
    pub fn property(self) -> &'static str {
        match self {
            ReplaySortField::StartTime => "startTime",
            ReplaySortField::EndTime => "endTime",
            ReplaySortField::Duration => "replayTicks",
            ReplaySortField::ReviewScore => "reviewsSummary.averageScore",
            ReplaySortField::Title => "name",
            ReplaySortField::Id => "id",
            ReplaySortField::VictoryCondition => "victoryCondition",
        }
    }
}

/// The four victory conditions the engine reports, as the API spells them.
/// (`com.faforever.commons.api.dto.VictoryCondition` in the Java client.)
pub const VICTORY_CONDITIONS: [&str; 4] =
    ["DEMORALIZATION", "DOMINATION", "ERADICATION", "SANDBOX"];

/// Everything the vault search can be narrowed by.
///
/// Empty string / `None` means "don't filter on this", so a default query is
/// the unfiltered newest-first feed the tab opens with. Strings rather than
/// richer types for the free-text fields: they come straight from input boxes,
/// and the API matches them as glob patterns.
// No `Eq`: `min_review_score` is an `f32`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReplayQuery {
    /// Player login. Substring by default, exact when [`Self::exact_player`].
    pub player: String,
    /// The Python client's "match username exactly" checkbox.
    pub exact_player: bool,
    pub map: String,
    pub map_author: String,
    /// The host-chosen lobby title (`game.attributes.name`).
    pub title: String,
    /// A specific replay id. Free text so a blank field is "any"; a
    /// non-numeric value simply matches nothing.
    pub replay_id: String,
    /// The player who hosted the game.
    pub host: String,
    /// Featured mod technical names (`faf`, `ladder1v1`, …). Empty = any.
    /// A list, not one value: the Java client's mod filter is a checkbox list.
    pub featured_mods: Vec<String>,
    /// Leaderboard technical names (`ladder_1v1`, `global`, …). Empty = any.
    pub leaderboards: Vec<String>,
    /// Factions any player took: 1=UEF, 2=Aeon, 3=Cybran, 4=Seraphim.
    pub factions: Vec<i32>,
    /// Victory conditions, from [`VICTORY_CONDITIONS`]. Empty = any.
    pub victory_conditions: Vec<String>,
    /// Displayed rating bounds, inclusive.
    pub min_rating: Option<i32>,
    pub max_rating: Option<i32>,
    /// Average review score bounds, 0–5.
    pub min_review_score: Option<f32>,
    pub max_review_score: Option<f32>,
    /// Game duration bounds in minutes.
    pub min_duration_minutes: Option<i32>,
    pub max_duration_minutes: Option<i32>,
    /// The map's player-slot count.
    pub map_min_players: Option<i32>,
    pub map_max_players: Option<i32>,
    /// Map edge length in km (the API stores pixels; see [`MAP_PIXELS_PER_KM`]).
    pub map_min_size_km: Option<i32>,
    pub map_max_size_km: Option<i32>,
    /// Only maps that are ranked (`mapVersion.ranked`).
    pub ranked_map_only: bool,
    /// Inclusive date bounds on `startTime`, as `YYYY-MM-DD` or a full
    /// RFC 3339 instant. Empty = unbounded.
    pub after: String,
    pub before: String,
    /// Only games that counted for rating (`validity == VALID`).
    pub only_ranked: bool,
    pub sort_by: ReplaySortField,
    pub sort_descending: bool,
    /// 1-based, matching the API's `page[number]`.
    pub page: u32,
    pub page_size: u32,
}

impl Default for ReplayQuery {
    fn default() -> Self {
        Self {
            player: String::new(),
            exact_player: false,
            map: String::new(),
            map_author: String::new(),
            title: String::new(),
            replay_id: String::new(),
            host: String::new(),
            featured_mods: Vec::new(),
            leaderboards: Vec::new(),
            factions: Vec::new(),
            victory_conditions: Vec::new(),
            min_rating: None,
            max_rating: None,
            min_review_score: None,
            max_review_score: None,
            min_duration_minutes: None,
            max_duration_minutes: None,
            map_min_players: None,
            map_max_players: None,
            map_min_size_km: None,
            map_max_size_km: None,
            ranked_map_only: false,
            after: String::new(),
            before: String::new(),
            only_ranked: false,
            sort_by: ReplaySortField::StartTime,
            sort_descending: true,
            page: 1,
            page_size: 50,
        }
    }
}

impl ReplayQuery {
    /// Whether the user narrowed the search at all (dates aside).
    fn has_narrowing_filter(&self) -> bool {
        !self.player.is_empty()
            || !self.map.is_empty()
            || !self.map_author.is_empty()
            || !self.title.is_empty()
            || !self.replay_id.is_empty()
            || !self.host.is_empty()
            || !self.featured_mods.is_empty()
            || !self.leaderboards.is_empty()
            || !self.factions.is_empty()
            || !self.victory_conditions.is_empty()
            || self.min_rating.is_some()
            || self.max_rating.is_some()
            || self.min_review_score.is_some()
            || self.max_review_score.is_some()
            || self.min_duration_minutes.is_some()
            || self.max_duration_minutes.is_some()
            || self.map_min_players.is_some()
            || self.map_max_players.is_some()
            || self.map_min_size_km.is_some()
            || self.map_max_size_km.is_some()
            || self.ranked_map_only
            || self.only_ranked
    }

    /// The API's `sort` parameter. A leading `-` means descending.
    pub fn sort_param(&self) -> String {
        let property = self.sort_by.property();
        if self.sort_descending {
            format!("-{property}")
        } else {
            property.to_string()
        }
    }

    /// How far back an otherwise unbounded search should reach, in months.
    ///
    /// `None` when the query already has an explicit `after` bound, or when it
    /// has no filters at all (the plain newest-first feed is cheap: the API
    /// just takes the first page of an index scan). Otherwise the Python
    /// client's rule: 3 months, or 6 when a player name is doing the narrowing.
    pub fn fallback_months(&self) -> Option<u32> {
        if !self.after.is_empty() || !self.has_narrowing_filter() {
            return None;
        }
        Some(if self.player.is_empty() { 3 } else { 6 })
    }
}

/// Widen a bare `YYYY-MM-DD` into the full instant the API demands.
///
/// Comparing `startTime` against a date-only value is rejected outright:
/// `Could not load vault: Invalid value: 2025-08-14`. Both the date pickers
/// (an `<input type="date">` yields `YYYY-MM-DD`) and the "Last year" preset
/// produced exactly that, so every dated search failed while the internal
/// fallback bound, which is already a full RFC 3339 instant, worked fine.
///
/// `before` is expanded to the *end* of its day: the bound is documented as
/// inclusive, and "before the 14th" meaning "excluding all of the 14th" is not
/// what a date picker implies.
fn as_instant(value: &str, end_of_day: bool) -> String {
    let is_date_only = value.len() == 10
        && value.as_bytes()[4] == b'-'
        && value.as_bytes()[7] == b'-'
        && value
            .bytes()
            .enumerate()
            .all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit());
    if !is_date_only {
        return value.to_string();
    }
    if end_of_day {
        format!("{value}T23:59:59Z")
    } else {
        format!("{value}T00:00:00Z")
    }
}

/// Build the RSQL `filter` parameter, or `None` when nothing narrows the search.
///
/// `fallback_after` is the timestamp computed from [`ReplayQuery::fallback_months`]
///: passed in rather than derived here so this stays clock-free (same posture
/// as chat message timestamps being stamped by the port).
pub fn build_filter(query: &ReplayQuery, fallback_after: Option<&str>) -> Option<String> {
    let mut clauses: Vec<String> = Vec::new();

    if query.only_ranked {
        clauses.push(r#"validity=="VALID""#.to_string());
    }
    if !query.player.is_empty() {
        let pattern = if query.exact_player {
            escape(&query.player)
        } else {
            glob(&query.player)
        };
        clauses.push(format!(r#"playerStats.player.login=="{pattern}""#));
    }
    if !query.map.is_empty() {
        clauses.push(format!(
            r#"mapVersion.map.displayName=="{}""#,
            glob(&query.map)
        ));
    }
    if !query.map_author.is_empty() {
        clauses.push(format!(
            r#"mapVersion.map.author.login=="{}""#,
            glob(&query.map_author)
        ));
    }
    if !query.title.is_empty() {
        clauses.push(format!(r#"name=="{}""#, glob(&query.title)));
    }
    if !query.replay_id.is_empty() {
        clauses.push(format!(r#"id=="{}""#, escape(&query.replay_id)));
    }
    if !query.host.is_empty() {
        clauses.push(format!(r#"host.login=="{}""#, glob(&query.host)));
    }
    if let Some(clause) = in_clause("featuredMod.technicalName", &query.featured_mods) {
        clauses.push(clause);
    }
    if let Some(clause) = in_clause(
        "playerStats.ratingChanges.leaderboard.technicalName",
        &query.leaderboards,
    ) {
        clauses.push(clause);
    }
    if let Some(clause) = in_clause(
        "playerStats.faction",
        &query
            .factions
            .iter()
            .map(i32::to_string)
            .collect::<Vec<_>>(),
    ) {
        clauses.push(clause);
    }
    if let Some(clause) = in_clause("victoryCondition", &query.victory_conditions) {
        clauses.push(clause);
    }
    if let Some(min) = query.min_rating {
        clauses.push(format!(
            r#"playerStats.ratingChanges.meanBefore=ge="{}""#,
            min + RATING_MEAN_OFFSET
        ));
    }
    if let Some(max) = query.max_rating {
        clauses.push(format!(
            r#"playerStats.ratingChanges.meanBefore=le="{}""#,
            max + RATING_MEAN_OFFSET
        ));
    }
    if let Some(score) = query.min_review_score {
        clauses.push(format!(r#"reviewsSummary.averageScore=ge="{score}""#));
    }
    if let Some(score) = query.max_review_score {
        clauses.push(format!(r#"reviewsSummary.averageScore=le="{score}""#));
    }
    if let Some(min) = query.min_duration_minutes {
        clauses.push(format!(r#"replayTicks=ge="{}""#, min * TICKS_PER_MINUTE));
    }
    if let Some(max) = query.max_duration_minutes {
        clauses.push(format!(r#"replayTicks=le="{}""#, max * TICKS_PER_MINUTE));
    }
    if let Some(min) = query.map_min_players {
        clauses.push(format!(r#"mapVersion.maxPlayers=ge="{min}""#));
    }
    if let Some(max) = query.map_max_players {
        clauses.push(format!(r#"mapVersion.maxPlayers=le="{max}""#));
    }
    if let Some(km) = query.map_min_size_km {
        clauses.push(format!(r#"mapVersion.width=ge="{}""#, km_to_pixels(km)));
    }
    if let Some(km) = query.map_max_size_km {
        clauses.push(format!(r#"mapVersion.width=le="{}""#, km_to_pixels(km)));
    }
    if query.ranked_map_only {
        clauses.push(r#"mapVersion.ranked=="true""#.to_string());
    }
    if !query.after.is_empty() {
        clauses.push(format!(
            r#"startTime=ge="{}""#,
            escape(&as_instant(&query.after, false))
        ));
    } else if let Some(fallback) = fallback_after {
        clauses.push(format!(r#"startTime=ge="{}""#, escape(fallback)));
    }
    if !query.before.is_empty() {
        clauses.push(format!(
            r#"startTime=le="{}""#,
            escape(&as_instant(&query.before, true))
        ));
    }

    if clauses.is_empty() {
        return None;
    }
    Some(format!("({})", clauses.join(";")))
}

/// An `=in=("a","b")` clause, or `None` when nothing is selected (which means
/// "any", not "none"). This is the form the Java client's multi-select category
/// filters produce.
fn in_clause(property: &str, values: &[String]) -> Option<String> {
    let values: Vec<String> = values
        .iter()
        .map(|v| escape(v))
        .filter(|v| !v.is_empty())
        .map(|v| format!("\"{v}\""))
        .collect();
    if values.is_empty() {
        return None;
    }
    Some(format!("{property}=in=({})", values.join(",")))
}

/// Map edge length in km to the pixel width the API stores.
fn km_to_pixels(km: i32) -> i32 {
    (km as f32 * MAP_PIXELS_PER_KM).round() as i32
}

/// A substring match. RSQL uses `*` as its wildcard, so a literal `*` the user
/// typed has to go: otherwise `a*b` silently becomes a two-part wildcard.
fn glob(value: &str) -> String {
    format!("*{}*", escape(value))
}

/// Strip the characters that would break out of a quoted RSQL argument.
/// The API offers no escape syntax, so removal is the only safe option: and
/// none of them are meaningful in a login, map name or title.
fn escape(value: &str) -> String {
    value
        .chars()
        .filter(|c| !matches!(c, '"' | '\\' | '*' | ';' | '(' | ')' | ',' | '\''))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn query() -> ReplayQuery {
        ReplayQuery::default()
    }

    #[test]
    fn an_empty_query_has_no_filter() {
        assert_eq!(build_filter(&query(), None), None);
    }

    #[test]
    fn player_defaults_to_a_substring_match() {
        let q = ReplayQuery {
            player: "Stormlord".into(),
            ..query()
        };
        assert_eq!(
            build_filter(&q, None).unwrap(),
            r#"(playerStats.player.login=="*Stormlord*")"#
        );
    }

    #[test]
    fn exact_player_drops_the_wildcards() {
        let q = ReplayQuery {
            player: "Stormlord".into(),
            exact_player: true,
            ..query()
        };
        assert_eq!(
            build_filter(&q, None).unwrap(),
            r#"(playerStats.player.login=="Stormlord")"#
        );
    }

    #[test]
    fn clauses_are_anded_in_a_parenthesised_group() {
        let q = ReplayQuery {
            only_ranked: true,
            map: "Setons".into(),
            ..query()
        };
        assert_eq!(
            build_filter(&q, None).unwrap(),
            r#"(validity=="VALID";mapVersion.map.displayName=="*Setons*")"#
        );
    }

    #[test]
    fn rating_bounds_are_offset_to_the_raw_mean() {
        // A user asking for 1500+ means displayed rating; the API stores mean.
        let q = ReplayQuery {
            min_rating: Some(1500),
            max_rating: Some(2000),
            ..query()
        };
        let filter = build_filter(&q, None).unwrap();
        assert!(filter.contains(r#"meanBefore=ge="1800""#), "{filter}");
        assert!(filter.contains(r#"meanBefore=le="2300""#), "{filter}");
    }

    #[test]
    fn duration_bounds_convert_minutes_to_ticks() {
        let q = ReplayQuery {
            min_duration_minutes: Some(10),
            max_duration_minutes: Some(60),
            ..query()
        };
        let filter = build_filter(&q, None).unwrap();
        assert!(filter.contains(r#"replayTicks=ge="6000""#), "{filter}");
        assert!(filter.contains(r#"replayTicks=le="36000""#), "{filter}");
    }

    #[test]
    fn every_text_field_maps_to_its_api_property() {
        let q = ReplayQuery {
            map: "Setons".into(),
            map_author: "Ozonex".into(),
            title: "all welcome".into(),
            replay_id: "22841190".into(),
            host: "Stormlord".into(),
            ..query()
        };
        let filter = build_filter(&q, None).unwrap();
        for expected in [
            r#"mapVersion.map.displayName=="*Setons*""#,
            r#"mapVersion.map.author.login=="*Ozonex*""#,
            r#"name=="*all welcome*""#,
            r#"id=="22841190""#,
            r#"host.login=="*Stormlord*""#,
        ] {
            assert!(filter.contains(expected), "missing {expected} in {filter}");
        }
    }

    #[test]
    fn multi_select_filters_become_in_clauses() {
        let q = ReplayQuery {
            featured_mods: vec!["faf".into(), "ladder1v1".into()],
            leaderboards: vec!["global".into()],
            factions: vec![1, 3],
            victory_conditions: vec!["DEMORALIZATION".into()],
            ..query()
        };
        let filter = build_filter(&q, None).unwrap();
        for expected in [
            r#"featuredMod.technicalName=in=("faf","ladder1v1")"#,
            r#"playerStats.ratingChanges.leaderboard.technicalName=in=("global")"#,
            r#"playerStats.faction=in=("1","3")"#,
            r#"victoryCondition=in=("DEMORALIZATION")"#,
        ] {
            assert!(filter.contains(expected), "missing {expected} in {filter}");
        }
    }

    #[test]
    fn an_empty_multi_select_means_any_not_none() {
        // Selecting nothing must not produce `=in=()`, which would match zero
        // rows instead of leaving the property unfiltered.
        let q = ReplayQuery {
            featured_mods: vec![],
            factions: vec![],
            ..query()
        };
        assert_eq!(build_filter(&q, None), None);
    }

    #[test]
    fn review_score_bounds_filter_on_the_summary() {
        let q = ReplayQuery {
            min_review_score: Some(4.0),
            max_review_score: Some(5.0),
            ..query()
        };
        let filter = build_filter(&q, None).unwrap();
        assert!(
            filter.contains(r#"reviewsSummary.averageScore=ge="4""#),
            "{filter}"
        );
        assert!(
            filter.contains(r#"reviewsSummary.averageScore=le="5""#),
            "{filter}"
        );
    }

    #[test]
    fn map_slot_and_size_bounds_convert_to_api_units() {
        let q = ReplayQuery {
            map_min_players: Some(4),
            map_max_players: Some(8),
            // 10 km is the engine's 512-pixel map; 20 km is 1024.
            map_min_size_km: Some(10),
            map_max_size_km: Some(20),
            ..query()
        };
        let filter = build_filter(&q, None).unwrap();
        assert!(
            filter.contains(r#"mapVersion.maxPlayers=ge="4""#),
            "{filter}"
        );
        assert!(
            filter.contains(r#"mapVersion.maxPlayers=le="8""#),
            "{filter}"
        );
        assert!(filter.contains(r#"mapVersion.width=ge="512""#), "{filter}");
        assert!(filter.contains(r#"mapVersion.width=le="1024""#), "{filter}");
    }

    #[test]
    fn ranked_map_only_filters_the_map_version() {
        let q = ReplayQuery {
            ranked_map_only: true,
            ..query()
        };
        assert!(build_filter(&q, None)
            .unwrap()
            .contains(r#"mapVersion.ranked=="true""#));
    }

    #[test]
    fn sort_combines_property_and_direction() {
        let mut q = query();
        assert_eq!(q.sort_param(), "-startTime");
        q.sort_descending = false;
        assert_eq!(q.sort_param(), "startTime");
        q.sort_by = ReplaySortField::ReviewScore;
        assert_eq!(q.sort_param(), "reviewsSummary.averageScore");
        q.sort_descending = true;
        assert_eq!(q.sort_param(), "-reviewsSummary.averageScore");
    }

    #[test]
    fn every_sort_field_has_an_api_property() {
        for (field, property) in [
            (ReplaySortField::StartTime, "startTime"),
            (ReplaySortField::EndTime, "endTime"),
            (ReplaySortField::Duration, "replayTicks"),
            (ReplaySortField::ReviewScore, "reviewsSummary.averageScore"),
            (ReplaySortField::Title, "name"),
            (ReplaySortField::Id, "id"),
            (ReplaySortField::VictoryCondition, "victoryCondition"),
        ] {
            assert_eq!(field.property(), property);
        }
    }

    #[test]
    fn explicit_dates_bound_start_time_on_both_sides() {
        let q = ReplayQuery {
            after: "2024-01-01".into(),
            before: "2024-02-01".into(),
            ..query()
        };
        // Date-only bounds are widened to instants: the API rejects a bare
        // date against `startTime`, which is what broke every dated search.
        assert_eq!(
            build_filter(&q, None).unwrap(),
            r#"(startTime=ge="2024-01-01T00:00:00Z";startTime=le="2024-02-01T23:59:59Z")"#
        );
    }

    #[test]
    fn a_full_instant_is_passed_through_untouched() {
        let q = ReplayQuery {
            after: "2024-01-01T12:30:00Z".into(),
            ..query()
        };
        assert!(
            build_filter(&q, None)
                .unwrap()
                .contains(r#"startTime=ge="2024-01-01T12:30:00Z""#),
            "an explicit instant must not be rewritten"
        );
    }

    #[test]
    fn a_before_bound_covers_the_whole_named_day() {
        // "before the 14th" including the 14th: the bound is documented as
        // inclusive, and a date picker implies the day, not its first instant.
        let q = ReplayQuery {
            before: "2024-02-01".into(),
            ..query()
        };
        assert!(build_filter(&q, None)
            .unwrap()
            .contains("2024-02-01T23:59:59Z"));
    }

    #[test]
    fn an_unfiltered_query_needs_no_date_floor() {
        // The plain newest-first feed is cheap; don't hide older results from it.
        assert_eq!(query().fallback_months(), None);
    }

    #[test]
    fn a_filtered_query_gets_a_three_month_floor() {
        let q = ReplayQuery {
            map: "Setons".into(),
            ..query()
        };
        assert_eq!(q.fallback_months(), Some(3));
    }

    #[test]
    fn a_player_search_gets_a_six_month_floor() {
        // A login narrows the query enough that the database can afford more.
        let q = ReplayQuery {
            player: "Stormlord".into(),
            ..query()
        };
        assert_eq!(q.fallback_months(), Some(6));
    }

    #[test]
    fn an_explicit_after_suppresses_the_fallback() {
        let q = ReplayQuery {
            map: "Setons".into(),
            after: "2020-01-01".into(),
            ..query()
        };
        assert_eq!(q.fallback_months(), None);
    }

    #[test]
    fn the_fallback_is_applied_only_when_after_is_empty() {
        let q = ReplayQuery {
            map: "Setons".into(),
            ..query()
        };
        let filter = build_filter(&q, Some("2024-01-01T00:00:00Z")).unwrap();
        assert!(
            filter.contains(r#"startTime=ge="2024-01-01T00:00:00Z""#),
            "{filter}"
        );

        let explicit = ReplayQuery {
            after: "2020-06-01".into(),
            ..q
        };
        let filter = build_filter(&explicit, Some("2024-01-01T00:00:00Z")).unwrap();
        // Widened to an instant like any other date-only bound; the point of
        // this case is that the explicit bound wins over the fallback.
        assert!(
            filter.contains(r#"startTime=ge="2020-06-01T00:00:00Z""#),
            "{filter}"
        );
        assert!(!filter.contains("2024-01-01"), "{filter}");
    }

    #[test]
    fn rsql_metacharacters_are_stripped_from_user_input() {
        // Without this a typed `"` or `;` would terminate the argument or the
        // clause and change the query's shape.
        let q = ReplayQuery {
            player: r#"a";b*c"#.into(),
            exact_player: true,
            ..query()
        };
        assert_eq!(
            build_filter(&q, None).unwrap(),
            r#"(playerStats.player.login=="abc")"#
        );
    }

    #[test]
    fn only_ranked_alone_counts_as_narrowing() {
        let q = ReplayQuery {
            only_ranked: true,
            ..query()
        };
        assert_eq!(q.fallback_months(), Some(3));
    }
}
