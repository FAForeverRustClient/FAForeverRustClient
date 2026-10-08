//! Vault rows: turning `/data/game` and `/data/featuredMod` documents into the
//! `VaultReplay`s and mod names the vault view shows.
//!
//! Separate from the requests in `vault` because this part is pure: a
//! document in, rows out, with every relationship walk, rating formula and
//! fallback the API's shape calls for, all of it testable without a network.

use std::collections::HashMap;

use faf_domain::protocol::map_generator::is_generated_map;
use faf_domain::state::{ReplayPlayer, ReplayTeam, VaultReplay};
use serde_json::Value;

use crate::infra::jsonapi::{
    rel_target, rel_targets, resource_index, value_i32, JsonApiDoc, JsonApiResource,
};
use crate::infra::GENERATED_MAP_PLACEHOLDER_URL;

/// `game.relationships.mapVersion -> mapVersion.relationships.map -> map.attributes.displayName`.
/// Falls back to `mapVersion.attributes.folderName`, `mapVersion.attributes.description`,
/// `mapVersion.attributes.filename`, or `game.attributes.mapFolderName` / `mapName` when the
/// map relationship is absent (such as for generated mapgen maps or custom scenarios).
fn resolve_map_name(
    game_attributes: &Value,
    relationships: &Value,
    index: &HashMap<(String, String), &JsonApiResource>,
    mod_name: &str,
) -> String {
    if let Some(mv) = rel_target(relationships, "mapVersion").and_then(|k| index.get(&k)) {
        if let Some(folder_name) = mv
            .attributes
            .get("folderName")
            .or_else(|| mv.attributes.get("mapName"))
            .or_else(|| mv.attributes.get("name"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            if is_generated_map(folder_name)
                || folder_name.to_ascii_lowercase().starts_with("neroxis")
            {
                return folder_name.to_string();
            }
        }

        if let Some(map_name) = rel_target(&mv.relationships, "map")
            .and_then(|k| index.get(&k))
            .and_then(|m| m.attributes.get("displayName"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            return map_name.to_string();
        }

        if let Some(folder_name) = mv
            .attributes
            .get("folderName")
            .or_else(|| mv.attributes.get("mapName"))
            .or_else(|| mv.attributes.get("name"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            return folder_name.to_string();
        }

        if let Some(desc) = mv
            .attributes
            .get("description")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            return desc.to_string();
        }

        if let Some(filename) = mv
            .attributes
            .get("filename")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            return filename.to_string();
        }
    }

    for key in [
        "mapFolderName",
        "mapName",
        "map",
        "map_folder_name",
        "map_name",
        "scenarioFile",
        "scenario_file",
    ] {
        if let Some(val) = game_attributes.get(key) {
            if let Some(s) = val.as_str().filter(|s| !s.is_empty()) {
                return s.to_string();
            }
            if let Some(obj) = val.as_object() {
                if let Some(name) = obj
                    .get("displayName")
                    .or_else(|| obj.get("folderName"))
                    .or_else(|| obj.get("mapName"))
                    .or_else(|| obj.get("name"))
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                {
                    return name.to_string();
                }
            }
        }
    }

    if let Some(title) = game_attributes.get("name").and_then(Value::as_str) {
        if is_generated_map(title) || title.to_ascii_lowercase().starts_with("neroxis") {
            return title.to_string();
        }
    }

    // Mirrors the Python client (src/replays/replayitem.py:257): in FAF API, games played on
    // generated maps do not have a mapVersion relationship (generated maps are never uploaded
    // to the map vault). When mapVersion is absent for non-coop games, it was a generated map.
    if !mod_name.eq_ignore_ascii_case("coop") {
        return "Neroxis Map Generator".to_string();
    }

    "unknown map".to_string()
}

/// `game.relationships.featuredMod -> featuredMod.attributes.technicalName`.
fn resolve_mod_name(
    relationships: &Value,
    index: &HashMap<(String, String), &JsonApiResource>,
) -> String {
    rel_target(relationships, "featuredMod")
        .and_then(|k| index.get(&k))
        .and_then(|m| m.attributes.get("technicalName"))
        .and_then(Value::as_str)
        .unwrap_or("faf")
        .to_string()
}

/// `game.relationships.mapVersion -> mapVersion.attributes.thumbnailUrlSmall`.
/// Same relationship chain as [`resolve_map_name`], but reads straight off
/// the `mapVersion` resource rather than following into `map`: mirrors
/// `infra::maps`'s exact attribute name for map thumbnails.
fn resolve_map_thumbnail(
    relationships: &Value,
    index: &HashMap<(String, String), &JsonApiResource>,
) -> String {
    rel_target(relationships, "mapVersion")
        .and_then(|k| index.get(&k))
        .and_then(|mv| mv.attributes.get("thumbnailUrlSmall"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

/// `game.relationships.playerStats[] -> playerStats.relationships.player ->
/// player.attributes.login`, grouped by `playerStats.attributes.team`.
///
fn resolve_player_avatar(
    player: Option<&JsonApiResource>,
    index: &HashMap<(String, String), &JsonApiResource>,
) -> Option<String> {
    let player = player?;
    let selected = rel_targets(&player.relationships, "avatarAssignments")
        .into_iter()
        .filter_map(|key| index.get(&key).copied())
        .find(|assignment| {
            assignment
                .attributes
                .get("selected")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        });
    let selected_url = selected
        .and_then(|assignment| rel_target(&assignment.relationships, "avatar"))
        .and_then(|key| index.get(&key).copied())
        .and_then(|avatar| avatar.attributes.get("url"))
        .and_then(Value::as_str)
        .filter(|url| !url.trim().is_empty())
        .map(str::to_string);
    selected_url.or_else(|| {
        player
            .attributes
            .get("avatarUrl")
            .and_then(Value::as_str)
            .filter(|url| !url.trim().is_empty())
            .map(str::to_string)
    })
}

fn resolve_teams(
    relationships: &Value,
    index: &HashMap<(String, String), &JsonApiResource>,
) -> Vec<ReplayTeam> {
    let mut by_team: HashMap<i32, Vec<ReplayPlayer>> = HashMap::new();
    for key in rel_targets(relationships, "playerStats") {
        let Some(stat) = index.get(&key) else {
            continue;
        };
        let team = stat
            .attributes
            .get("team")
            .and_then(team_value)
            .unwrap_or(0);
        let player = rel_target(&stat.relationships, "player").and_then(|k| index.get(&k).copied());
        let name = player
            .and_then(|p| p.attributes.get("login"))
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        let avatar_url = resolve_player_avatar(player, index);
        let faction = stat.attributes.get("faction").and_then(faction_value);
        let journals: Vec<&JsonApiResource> = rel_targets(&stat.relationships, "ratingChanges")
            .into_iter()
            .filter_map(|key| index.get(&key).copied())
            .collect();
        let rating = journals
            .iter()
            .find_map(|journal| displayed_rating_before(&journal.attributes))
            // Older game resources expose the same values directly on the
            // player stat instead of including a rating journal relationship.
            .or_else(|| displayed_rating_from_stat(&stat.attributes));
        // The *first* journal, as Java takes it: a game touches one leaderboard
        // for the player, and the ordering the API returns is the one both
        // clients rely on.
        let rating_change = journals
            .first()
            .and_then(|journal| rating_change_of(&journal.attributes));
        by_team.entry(team).or_default().push(ReplayPlayer {
            name,
            avatar_url,
            faction,
            rating,
            rating_change,
            outcome: stat
                .attributes
                .get("result")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            score: value_i32(&stat.attributes, "score"),
            country: None,
        });
    }
    let mut teams: Vec<ReplayTeam> = by_team
        .into_iter()
        .map(|(team, players)| ReplayTeam { team, players })
        .collect();
    // Observers use the negative team bucket. Keep them visible but after the
    // competitive lineup, matching the reference clients' scoreboards.
    teams.sort_by_key(|team| (team.team < 0, team.team));
    teams
}

/// Match quality uses the same TrueSkill parameters as the Java client. The
/// result is meaningful only for two competitive teams whose first rating
/// journal contains both the mean and deviation.
fn resolve_match_quality(
    relationships: &Value,
    index: &HashMap<(String, String), &JsonApiResource>,
) -> Option<i32> {
    let mut by_team: HashMap<i32, Vec<(f64, f64)>> = HashMap::new();
    for key in rel_targets(relationships, "playerStats") {
        let stat = index.get(&key)?;
        let team = stat.attributes.get("team").and_then(team_value)?;
        if team < 0 {
            continue;
        }
        let (mean, deviation) = rel_targets(&stat.relationships, "ratingChanges")
            .into_iter()
            .filter_map(|rating_key| index.get(&rating_key))
            .find_map(|journal| rating_before(&journal.attributes))?;
        by_team.entry(team).or_default().push((mean, deviation));
    }

    let mut teams: Vec<Vec<(f64, f64)>> = by_team.into_values().collect();
    teams.sort_by_key(|team| team.len());
    calculate_match_quality(&teams)
}

/// The two-team TrueSkill quality formula used by `jskills`. FAF's Java
/// client configures beta to 240, while the other GameInfo parameters affect
/// rating updates rather than this quality calculation.
fn calculate_match_quality(teams: &[Vec<(f64, f64)>]) -> Option<i32> {
    if teams.len() != 2 || teams.iter().any(Vec::is_empty) {
        return None;
    }

    const BETA: f64 = 240.0;
    let total_players = teams.iter().map(Vec::len).sum::<usize>() as f64;
    let beta_term = total_players * BETA * BETA;
    let uncertainty = teams
        .iter()
        .flat_map(|team| team.iter().map(|(_, deviation)| deviation * deviation))
        .sum::<f64>();
    let denominator = beta_term + uncertainty;
    if !denominator.is_finite() || denominator <= 0.0 {
        return None;
    }

    let team_means = teams
        .iter()
        .map(|team| team.iter().map(|(mean, _)| mean).sum::<f64>())
        .collect::<Vec<_>>();
    let mean_difference = team_means[0] - team_means[1];
    let quality = (beta_term / denominator).sqrt()
        * (-(mean_difference * mean_difference) / (2.0 * denominator)).exp();
    (quality.is_finite() && quality >= 0.0)
        .then_some((quality * 100.0).round().clamp(0.0, 100.0) as i32)
}

fn faction_value(value: &Value) -> Option<i32> {
    if let Some(number) = value.as_i64() {
        return i32::try_from(number).ok();
    }
    let value = value.as_str()?.trim();
    value
        .parse()
        .ok()
        .or_else(|| match value.to_ascii_uppercase().as_str() {
            "UEF" => Some(1),
            "AEON" => Some(2),
            "CYBRAN" => Some(3),
            "SERAPHIM" => Some(4),
            "RANDOM" => Some(5),
            _ => None,
        })
}

fn team_value(value: &Value) -> Option<i32> {
    if let Some(number) = value.as_i64() {
        return i32::try_from(number).ok();
    }
    match value {
        Value::Null => Some(-1),
        Value::String(value) if value.trim().eq_ignore_ascii_case("null") => Some(-1),
        Value::String(value) => value.trim().parse().ok(),
        _ => None,
    }
}

fn rating_before(attributes: &Value) -> Option<(f64, f64)> {
    let numeric = |name: &str| {
        attributes.get(name).and_then(|value| {
            value
                .as_f64()
                .or_else(|| value.as_str().and_then(|text| text.trim().parse().ok()))
        })
    };
    Some((numeric("meanBefore")?, numeric("deviationBefore")?))
}

fn displayed_rating_before(attributes: &Value) -> Option<i32> {
    displayed_rating_with_fields(attributes, "meanBefore", "deviationBefore")
}

/// What one rating journal says this game did to the player's displayed rating.
///
/// Both ends go through the same `mean - 3*deviation` rounding before they are
/// subtracted, so the number matches what the two ratings would have read as,
/// rather than a rounded difference of unrounded means. `None` unless the
/// journal carries an "after" side: an unrated or unresolved game has none, and
/// reporting a change for it is exactly the bug this replaced. Mirrors Java's
/// `PlayerCardController::getRatingChange`.
fn rating_change_of(attributes: &Value) -> Option<i32> {
    let after = displayed_rating_with_fields(attributes, "meanAfter", "deviationAfter")?;
    let before = displayed_rating_before(attributes)?;
    Some(after - before)
}

fn displayed_rating_from_stat(attributes: &Value) -> Option<i32> {
    displayed_rating_with_fields(attributes, "beforeMean", "beforeDeviation")
}

fn displayed_rating_with_fields(
    attributes: &Value,
    mean_field: &str,
    deviation_field: &str,
) -> Option<i32> {
    let numeric = |name: &str| {
        attributes.get(name).and_then(|value| {
            value
                .as_f64()
                .or_else(|| value.as_str().and_then(|text| text.trim().parse().ok()))
        })
    };
    let mean = numeric(mean_field)?;
    let deviation = numeric(deviation_field)?;
    let rating = mean - 3.0 * deviation;
    // Truncated, not rounded. Both reference clients cast rather than round:
    // Java's `RatingUtil.getRating` is `(int) (mean - 3f * deviation)` and the
    // Python client's `rating_estimate` is `int(rating.displayed())`. Rounding
    // put us a point above them for every rating whose fraction was over .5,
    // and made a rating *change*, which subtracts two of these, disagree by one
    // in either direction.
    (rating.is_finite() && rating >= f64::from(i32::MIN) && rating <= f64::from(i32::MAX))
        .then_some(rating as i32)
}

/// `game.relationships.reviewsSummary -> reviewsSummary.attributes`.
fn resolve_reviews(
    relationships: &Value,
    index: &HashMap<(String, String), &JsonApiResource>,
) -> (Option<f32>, Option<i32>) {
    let Some(summary) = rel_target(relationships, "reviewsSummary").and_then(|k| index.get(&k))
    else {
        return (None, None);
    };
    let average = summary
        .attributes
        .get("averageScore")
        .and_then(Value::as_f64)
        .map(|v| v as f32);
    // `reviews` is the API's name for it (`GameReviewsSummary.getReviews`);
    // this read `numReviews`, which no summary has, so a rated replay's count
    // was always empty and the card hid its stars. The maps and mods vaults
    // read the same pair in the same order.
    let count = ["reviews", "numReviews"].iter().find_map(|key| {
        summary
            .attributes
            .get(*key)
            .and_then(Value::as_i64)
            .map(|v| v as i32)
    });
    (average, count)
}

/// Seconds between two RFC3339 timestamps, or `None` if either is missing or
/// unparseable (e.g. a still-in-progress game has no `endTime`).
fn duration_between(start: &str, end: Option<&str>) -> Option<i32> {
    let start = chrono::DateTime::parse_from_rfc3339(start).ok()?;
    let end = chrono::DateTime::parse_from_rfc3339(end?).ok()?;
    i32::try_from((end - start).num_seconds()).ok()
}

/// Technical names from a `/data/featuredMod` document, in the order the API
/// returned them (which `sort=order` makes the mods' own display order).
pub(super) fn parse_featured_mods(doc: &JsonApiDoc) -> Vec<String> {
    doc.data
        .iter()
        .filter_map(|entry| {
            entry
                .attributes
                .get("technicalName")
                .and_then(Value::as_str)
                .filter(|name| !name.is_empty())
                .map(str::to_string)
        })
        .collect()
}

pub(super) fn parse_vault_replays(doc: &JsonApiDoc) -> Vec<VaultReplay> {
    let index = resource_index(&doc.included);
    doc.data
        .iter()
        .filter_map(|game| {
            let uid: i32 = game.id.parse().ok()?;
            let start_time = game
                .attributes
                .get("startTime")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let end_time = game.attributes.get("endTime").and_then(Value::as_str);
            let teams = resolve_teams(&game.relationships, &index);
            let quality = resolve_match_quality(&game.relationships, &index);
            let average_rating = {
                let ratings: Vec<i32> = teams
                    .iter()
                    .filter(|team| team.team >= 0)
                    .flat_map(|t| &t.players)
                    .filter_map(|p| p.rating)
                    .collect();
                if ratings.is_empty() {
                    None
                } else {
                    Some(ratings.iter().sum::<i32>() / ratings.len() as i32)
                }
            };
            let (reviews_average, reviews_count) = resolve_reviews(&game.relationships, &index);
            let title = game
                .attributes
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let mod_name = resolve_mod_name(&game.relationships, &index);
            let map = resolve_map_name(&game.attributes, &game.relationships, &index, &mod_name);
            let mut map_thumbnail_url = resolve_map_thumbnail(&game.relationships, &index);
            if map_thumbnail_url.is_empty()
                && (is_generated_map(&map) || map.to_ascii_lowercase().starts_with("neroxis"))
            {
                map_thumbnail_url = GENERATED_MAP_PLACEHOLDER_URL.to_string();
            }
            // The Java client parses the SupCom patch from the replay body.
            // `featuredModVersion` is a mod release identifier, not the game
            // patch, so it must never be presented as the game version.
            let game_version = value_i32(&game.attributes, "gameVersion");
            Some(VaultReplay {
                uid,
                title,
                map,
                map_thumbnail_url,
                mod_name,
                duration_seconds: duration_between(&start_time, end_time),
                game_duration_seconds: value_i32(&game.attributes, "replayTicks")
                    .and_then(|ticks| (ticks >= 0).then_some(ticks / 10)),
                start_time,
                end_time: end_time.unwrap_or_default().to_string(),
                // Missing/non-bool defaults to "not available": safer than
                // assuming a replay exists when we can't tell.
                replay_available: game
                    .attributes
                    .get("replayAvailable")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                teams,
                average_rating,
                quality,
                reviews_average,
                reviews_count,
                game_version,
                validity: game
                    .attributes
                    .get("validity")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                victory_condition: game
                    .attributes
                    .get("victoryCondition")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_vault_replays_resolving_map_and_mod_through_included() {
        let doc: JsonApiDoc = serde_json::from_value(json!({
            "data": [
                {
                    "type": "game",
                    "id": "12345",
                    "attributes": {
                        "name": "all welcome",
                        "startTime": "2026-01-01T12:00:00Z",
                        "endTime": "2026-01-01T12:30:00Z",
                        "replayTicks": 12345,
                        "replayAvailable": true,
                        "featuredModVersion": 999,
                    },
                    "relationships": {
                        "mapVersion": { "data": { "type": "mapVersion", "id": "9" } },
                        "featuredMod": { "data": { "type": "featuredMod", "id": "1" } },
                        "playerStats": { "data": [
                            { "type": "gamePlayerStats", "id": "100" },
                            { "type": "gamePlayerStats", "id": "101" },
                            { "type": "gamePlayerStats", "id": "102" },
                        ] },
                        "reviewsSummary": { "data": { "type": "gameReviewsSummary", "id": "12345" } },
                    },
                },
            ],
            "included": [
                {
                    "type": "mapVersion",
                    "id": "9",
                    "attributes": { "thumbnailUrlSmall": "https://content.faforever.com/maps/scmp_009.small.png" },
                    "relationships": {
                        "map": { "data": { "type": "map", "id": "77" } },
                    },
                },
                {
                    "type": "map",
                    "id": "77",
                    "attributes": { "displayName": "Seton's Clutch" },
                },
                {
                    "type": "featuredMod",
                    "id": "1",
                    "attributes": { "technicalName": "faf" },
                },
                {
                    "type": "gamePlayerStats",
                    "id": "100",
                    "attributes": { "team": 2, "faction": 1, "result": "VICTORY", "score": 3210 },
                    "relationships": {
                        "player": { "data": { "type": "player", "id": "500" } },
                        "ratingChanges": { "data": [{ "type": "leaderboardRatingJournal", "id": "700" }] }
                    },
                },
                {
                    "type": "gamePlayerStats",
                    "id": "101",
                    "attributes": {
                        "team": 3,
                        "faction": "RANDOM",
                        "beforeMean": 1600.0,
                        "beforeDeviation": 100.0
                    },
                    "relationships": { "player": { "data": { "type": "player", "id": "501" } } },
                },
                {
                    "type": "gamePlayerStats",
                    "id": "102",
                    "attributes": { "team": "null", "faction": "SERAPHIM" },
                    "relationships": { "player": { "data": { "type": "player", "id": "502" } } },
                },
                {
                    "type": "player",
                    "id": "500",
                    "attributes": { "login": "Seraphim-Noob" },
                    "relationships": {
                        "avatarAssignments": { "data": [{ "type": "avatarAssignment", "id": "900" }] }
                    }
                },
                { "type": "player", "id": "501", "attributes": { "login": "Nomander" } },
                { "type": "player", "id": "502", "attributes": { "login": "Watcher" } },
                {
                    "type": "avatarAssignment",
                    "id": "900",
                    "attributes": { "selected": true },
                    "relationships": { "avatar": { "data": { "type": "avatar", "id": "901" } } }
                },
                {
                    "type": "avatar",
                    "id": "901",
                    "attributes": { "url": "https://content.faforever.com/faf/avatars/GW_Seraphim.png" }
                },
                {
                    "type": "leaderboardRatingJournal",
                    "id": "700",
                    "attributes": {
                        "meanBefore": 1600.0, "deviationBefore": 100.0,
                        "meanAfter": 1615.0, "deviationAfter": 98.0
                    }
                },
                {
                    "type": "gameReviewsSummary",
                    "id": "12345",
                    "attributes": { "averageScore": 4.5, "reviews": 2 },
                },
            ],
        }))
        .unwrap();

        let replays = parse_vault_replays(&doc);
        assert_eq!(replays.len(), 1);
        let replay = &replays[0];
        assert_eq!(replay.uid, 12345);
        assert_eq!(replay.title, "all welcome");
        assert_eq!(replay.map, "Seton's Clutch");
        assert_eq!(
            replay.map_thumbnail_url,
            "https://content.faforever.com/maps/scmp_009.small.png"
        );
        assert_eq!(replay.mod_name, "faf");
        assert_eq!(replay.start_time, "2026-01-01T12:00:00Z");
        assert!(replay.replay_available);
        assert_eq!(replay.duration_seconds, Some(1800));
        assert_eq!(replay.game_duration_seconds, Some(1234));
        assert_eq!(replay.reviews_average, Some(4.5));
        assert_eq!(replay.reviews_count, Some(2));
        assert_eq!(replay.game_version, None);
        assert_eq!(replay.teams.len(), 3);
        assert_eq!(replay.teams[0].team, 2);
        assert_eq!(replay.teams[0].players[0].name, "Seraphim-Noob");
        assert_eq!(
            replay.teams[0].players[0].avatar_url.as_deref(),
            Some("https://content.faforever.com/faf/avatars/GW_Seraphim.png")
        );
        assert_eq!(replay.teams[0].players[0].faction, Some(1));
        assert_eq!(replay.teams[0].players[0].rating, Some(1300));
        // 1615 - 3*98 = 1321, against 1600 - 3*100 = 1300.
        assert_eq!(replay.teams[0].players[0].rating_change, Some(21));
        assert_eq!(replay.teams[0].players[0].outcome, "VICTORY");
        assert_eq!(replay.teams[0].players[0].score, Some(3210));
        assert_eq!(replay.average_rating, Some(1300));
        assert_eq!(replay.teams[1].team, 3);
        assert_eq!(replay.teams[1].players[0].name, "Nomander");
        assert_eq!(replay.teams[1].players[0].faction, Some(5));
        assert_eq!(replay.teams[1].players[0].rating, Some(1300));
        // No journal at all, so nothing to report: the old stat-level fields
        // carry a rating but never a change.
        assert_eq!(replay.teams[1].players[0].rating_change, None);
        assert_eq!(replay.teams[2].team, -1);
        assert_eq!(replay.teams[2].players[0].name, "Watcher");
    }

    #[test]
    fn a_rating_change_needs_both_ends_of_the_journal() {
        // Both ends are rounded the way a displayed rating is before they are
        // subtracted, so the number matches the two ratings a player sees.
        let rated = json!({
            "meanBefore": 1500.0, "deviationBefore": 90.0,
            "meanAfter": 1520.0, "deviationAfter": 88.0
        });
        assert_eq!(rating_change_of(&rated), Some(26));

        // An unrated or unresolved game has no "after" side. Reporting a
        // change for one is the bug this replaced: the score was shown
        // instead, which exists even for a game the server never resolved.
        let unrated = json!({ "meanBefore": 1500.0, "deviationBefore": 90.0 });
        assert_eq!(rating_change_of(&unrated), None);
        assert_eq!(rating_change_of(&json!({})), None);
    }

    #[test]
    fn match_quality_matches_two_team_true_skill_shape() {
        let even = calculate_match_quality(&[vec![(1500.0, 100.0)], vec![(1500.0, 100.0)]])
            .expect("two rated teams have a quality");
        assert!(even > 90, "even teams should be high quality, got {even}");

        let uneven = calculate_match_quality(&[vec![(1900.0, 100.0)], vec![(1100.0, 100.0)]])
            .expect("two rated teams have a quality");
        assert!(uneven < even);
        assert_eq!(calculate_match_quality(&[vec![(1500.0, 100.0)]]), None);
    }

    #[test]
    fn parse_vault_replays_defaults_gracefully_without_included() {
        let doc: JsonApiDoc = serde_json::from_value(json!({
            "data": [{ "type": "game", "id": "1", "attributes": {}, "relationships": {} }],
        }))
        .unwrap();

        let replays = parse_vault_replays(&doc);
        assert_eq!(replays.len(), 1);
        let replay = &replays[0];
        assert_eq!(replay.title, "");
        assert_eq!(replay.map, "Neroxis Map Generator");
        assert_eq!(replay.map_thumbnail_url, GENERATED_MAP_PLACEHOLDER_URL);
        assert_eq!(replay.mod_name, "faf");
        assert_eq!(replay.start_time, "");
        assert!(
            !replay.replay_available,
            "missing attribute defaults to unavailable"
        );
        assert_eq!(replay.duration_seconds, None);
        assert!(replay.teams.is_empty());
        assert_eq!(replay.average_rating, None);
        assert_eq!(replay.reviews_average, None);
        assert_eq!(replay.reviews_count, None);
    }

    #[test]
    fn parse_vault_replays_resolves_generated_map() {
        let doc: JsonApiDoc = serde_json::from_value(json!({
            "data": [{
                "type": "game",
                "id": "27634581",
                "attributes": {
                    "name": "2v2",
                    "replayAvailable": true
                },
                "relationships": {
                    "mapVersion": { "data": { "type": "mapVersion", "id": "999" } }
                }
            }],
            "included": [
                {
                    "type": "mapVersion",
                    "id": "999",
                    "attributes": {
                        "folderName": "neroxis_map_generator_1.21.2_ybufyzg64pai2_aqfqeai_aaaaaadkqocko"
                    },
                    "relationships": {}
                }
            ]
        }))
        .unwrap();

        let replays = parse_vault_replays(&doc);
        assert_eq!(replays.len(), 1);
        let replay = &replays[0];
        assert_eq!(replay.uid, 27634581);
        assert_eq!(replay.title, "2v2");
        assert_eq!(
            replay.map,
            "neroxis_map_generator_1.21.2_ybufyzg64pai2_aqfqeai_aaaaaadkqocko"
        );
        assert_eq!(replay.map_thumbnail_url, GENERATED_MAP_PLACEHOLDER_URL);
    }
}
