//! Players on the wire: one entry of `player_info` or `welcome`, the lists of
//! `social`, and the avatars an account may wear.

use std::collections::BTreeMap;

use serde_json::Value;

use crate::protocol::rating::{displayed_points, whole_points};
use crate::state::{AvailableAvatar, PlayerLobbyRating};

/// One player as `player_info` or the `me` of `welcome` describes them.
///
/// Read as far as it can be read and no further. Whether an entry is enough
/// to be a profile (it needs an id and a name), and what a partial one leaves
/// unchanged, depends on what the session already knows about the player, so
/// that is decided there.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct PlayerEntry {
    pub id: Option<i64>,
    /// `login`, or `name` in older payloads. Never empty.
    pub login: Option<String>,
    /// `state: "offline"`: the server's notice that the player left.
    pub offline: bool,
    /// As sent, which is uppercase.
    pub country: String,
    pub clan: String,
    /// Empty when the player wears none; the server sends `null` then.
    pub avatar_url: String,
    pub avatar_tooltip: String,
    /// Every leaderboard the entry rates the player on, by leaderboard.
    /// `None` is a partial update with no ratings in it at all; `Some([])` is
    /// the server saying the player has none.
    pub ratings: Option<Vec<PlayerLobbyRating>>,
    /// The displayed global rating, from the ratings above or from the
    /// `global_rating` number older payloads carry instead.
    pub rating_estimate: Option<i32>,
    /// That older number by itself, for a profile with nothing better.
    pub legacy_global_rating: Option<f64>,
}

impl PlayerEntry {
    pub fn decode(player: &Value) -> Self {
        let text = |key: &str| {
            player
                .get(key)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()
        };
        // `avatar` is `{"url": …, "tooltip": …}` when set, and `null` otherwise.
        let avatar = player.get("avatar");
        let avatar_text = |key: &str| {
            avatar
                .and_then(|avatar| avatar.get(key))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()
        };
        Self {
            id: player.get("id").and_then(Value::as_i64),
            login: player
                .get("login")
                .or_else(|| player.get("name"))
                .and_then(Value::as_str)
                .filter(|login| !login.is_empty())
                .map(str::to_owned),
            offline: player.get("state").and_then(Value::as_str) == Some("offline"),
            country: text("country"),
            clan: text("clan"),
            avatar_url: avatar_text("url"),
            avatar_tooltip: avatar_text("tooltip"),
            ratings: player_lobby_ratings(player),
            rating_estimate: player_rating_estimate(player),
            legacy_global_rating: player.get("global_rating").and_then(value_as_f64),
        }
    }
}

/// The `social` message: this account's friends and foes by account id, and
/// the chat channels the server assigns it.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SocialLists {
    pub friends: Vec<i64>,
    pub foes: Vec<i64>,
    /// Without the `#` prefix, which the domain adds when it normalizes them.
    pub channels: Vec<String>,
}

impl SocialLists {
    pub fn decode(value: &Value) -> Self {
        Self {
            friends: id_list(value, "friends"),
            foes: id_list(value, "foes"),
            channels: parse_autojoin(value),
        }
    }
}

pub(super) fn parse_available_avatars(message: &Value) -> Vec<AvailableAvatar> {
    let avatars = message
        .get("avatarlist")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|value| {
            let url = value.get("url")?.as_str()?.trim();
            if url.is_empty() {
                return None;
            }
            Some(AvailableAvatar {
                url: url.to_string(),
                tooltip: value
                    .get("tooltip")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim()
                    .to_string(),
            })
        })
        .take(500)
        .collect::<Vec<_>>();
    let mut by_url = BTreeMap::new();
    for avatar in avatars {
        by_url.entry(avatar.url.clone()).or_insert(avatar);
    }
    let mut avatars = by_url.into_values().collect::<Vec<_>>();
    avatars.sort_by(|left, right| {
        left.tooltip
            .to_lowercase()
            .cmp(&right.tooltip.to_lowercase())
            .then_with(|| left.url.cmp(&right.url))
    });
    avatars
}

/// Read the channel list out of a `social` message.
///
/// The server has used both `autojoin` and `channels` for this field, so both
/// are accepted; the Java client reads `channels` while the Python client reads
/// `autojoin`. Names arrive without the `#` prefix, which the domain adds when
/// it normalizes them.
pub(super) fn parse_autojoin(value: &Value) -> Vec<String> {
    value
        .get("autojoin")
        .or_else(|| value.get("channels"))
        .and_then(Value::as_array)
        .map(|channels| {
            channels
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// The lobby sends relation ids as numbers, but has historically sent them as
/// strings too; accept both rather than silently losing a friends list.
pub(super) fn id_list(value: &Value, key: &str) -> Vec<i64> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(|id| id.as_i64().or_else(|| id.as_str()?.parse().ok()))
                .collect()
        })
        .unwrap_or_default()
}

/// The displayed global rating of one entry. FAF sends TrueSkill
/// `[mean, deviation]`; the displayed value is `mean - 3 * deviation`,
/// unclamped: see [`crate::protocol::rating`]. Older payloads carry a single
/// `global_rating` number instead, which is taken as it is.
pub(super) fn player_rating_estimate(player: &Value) -> Option<i32> {
    player
        .get("ratings")
        .and_then(|all| all.get("global"))
        .and_then(|global| global.get("rating"))
        .and_then(Value::as_array)
        .and_then(|rating| {
            let mean = rating.first().and_then(Value::as_f64)?;
            let deviation = rating.get(1).and_then(Value::as_f64)?;
            displayed_points(mean, deviation)
        })
        .or_else(|| {
            player
                .get("global_rating")
                .and_then(value_as_f64)
                .and_then(whole_points)
        })
}

/// Preserve every rating queue from the live player directory for cheap UI
/// summaries. `None` means this was a partial update with no ratings field;
/// `Some([])` means the server explicitly supplied an empty rating map.
pub(super) fn player_lobby_ratings(player: &Value) -> Option<Vec<PlayerLobbyRating>> {
    let ratings = player.get("ratings")?.as_object()?;
    let mut summaries = ratings
        .iter()
        .filter_map(|(leaderboard, entry)| {
            let rating = entry.get("rating")?.as_array()?;
            let mean = rating.first().and_then(Value::as_f64)?;
            let deviation = rating.get(1).and_then(Value::as_f64)?;
            let games_played = entry
                .get("number_of_games")
                .and_then(|value| {
                    value
                        .as_i64()
                        .or_else(|| value.as_str()?.parse::<i64>().ok())
                })
                .and_then(|value| i32::try_from(value).ok())
                .unwrap_or_default()
                .max(0);
            Some(PlayerLobbyRating {
                leaderboard: leaderboard.clone(),
                rating: displayed_points(mean, deviation)?,
                mean: whole_points(mean.round())?,
                deviation: whole_points(deviation.round())?,
                games_played,
            })
        })
        .collect::<Vec<_>>();
    summaries.sort_by(|left, right| left.leaderboard.cmp(&right.leaderboard));
    Some(summaries)
}

pub(super) fn value_as_f64(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str()?.parse::<f64>().ok())
}
