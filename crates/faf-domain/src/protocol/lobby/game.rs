//! Games on the wire: a lobby as `game_info` describes it, and the launch
//! order of `game_launch`.

use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::Value;

use crate::state::{Game, GameLaunch, GLOBAL_LEADERBOARD};

/// Every player's displayed rating on every leaderboard the server has sent
/// one for: login, then leaderboard (`global`, `ladder_1v1`, `tmm_2v2`, ...).
///
/// A single global number was enough while every game average was a global
/// average. It is not enough now that a game is averaged over the leaderboard
/// it is actually rated on.
pub type PlayerRatings = BTreeMap<String, BTreeMap<String, i32>>;

/// One game as it arrives in a `game_info` message. Only the fields we surface.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct GameInfo {
    /// Some lobby payloads omit optional fields or send them as JSON `null`.
    /// Keep the wire model permissive and apply the client defaults in
    /// `into_game` instead of dropping the complete game from the snapshot.
    pub uid: Option<i32>,
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub num_players: Option<i32>,
    #[serde(default)]
    pub max_players: Option<i32>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub mapname: Option<String>,
    #[serde(default)]
    pub featured_mod: Option<String>,
    #[serde(default)]
    pub average_rating: Option<f64>,
    #[serde(default)]
    pub password_protected: Option<bool>,
    #[serde(default)]
    pub visibility: Option<String>,
    #[serde(default)]
    pub game_type: Option<String>,
    #[serde(default)]
    pub rating_type: Option<String>,
    #[serde(default)]
    pub launched_at: Option<f64>,
    #[serde(default)]
    pub hosted_at: Option<String>,
    #[serde(default)]
    pub rating_min: Option<f64>,
    #[serde(default)]
    pub rating_max: Option<f64>,
    #[serde(default)]
    pub enforce_rating_range: Option<bool>,
    #[serde(default)]
    pub teams: Option<std::collections::BTreeMap<String, Vec<String>>>,
    #[serde(default)]
    pub sim_mods: Option<std::collections::BTreeMap<String, String>>,
}

impl GameInfo {
    /// Only games still open for joining belong in the list.
    pub fn is_open(&self) -> bool {
        self.state.as_deref() == Some("open")
            && self
                .game_type
                .as_deref()
                .is_none_or(|gt| !gt.eq_ignore_ascii_case("matchmaker"))
            && self
                .visibility
                .as_deref()
                .is_none_or(|v| !v.eq_ignore_ascii_case("matchmaker"))
    }

    /// Games actively in progress: not joinable, but watchable live.
    pub fn is_playing(&self) -> bool {
        self.state.as_deref() == Some("playing")
    }

    /// The game as the client lists it, with the defaults the reference
    /// clients give a field the server left out. `player_ratings` is what the
    /// session knows of the players, for the average when the server sends
    /// none. `None` for a payload without the game's id.
    pub fn into_game(self, player_ratings: &PlayerRatings) -> Option<Game> {
        let id = self.uid?;
        // Empty is not a rating type. The server defaults the field to
        // `global`, and a payload that omits it entirely is an older one
        // saying the same thing.
        let rating_type = self
            .rating_type
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| GLOBAL_LEADERBOARD.to_string());
        let average_rating = average_game_rating(self.teams.as_ref(), player_ratings, &rating_type);
        Some(Game {
            id,
            title: self.title.unwrap_or_default(),
            host: self.host.unwrap_or_default(),
            players: self.num_players.unwrap_or_default(),
            max_players: self.max_players.unwrap_or_default(),
            map: self.mapname.unwrap_or_default(),
            mod_name: self.featured_mod.unwrap_or_else(|| "faf".into()),
            average_rating: self
                .average_rating
                .map(|value| value.round() as i32)
                .filter(|value| *value > 0)
                .unwrap_or(average_rating),
            password_protected: self.password_protected.unwrap_or(false),
            visibility: self.visibility.unwrap_or_else(|| "public".into()),
            game_type: self.game_type.unwrap_or_else(|| "custom".into()),
            rating_type,
            launched_at: self.launched_at.map(|value| value.round() as u32),
            hosted_at: self.hosted_at,
            rating_min: self.rating_min.map(|value| value.round() as i32),
            rating_max: self.rating_max.map(|value| value.round() as i32),
            enforce_rating_range: self.enforce_rating_range.unwrap_or(false),
            teams: self.teams.unwrap_or_default(),
            sim_mods: self.sim_mods.unwrap_or_default(),
        })
    }
}

/// Compute the displayed rating for a game from its active team members.
/// Observers (`-1`/`null`) are intentionally excluded, matching both reference
/// clients. A server-provided `average_rating` remains authoritative when
/// present; this is the fallback used by current lobby payloads, which do not
/// carry one at all.
///
/// Averaged over the game's *own* leaderboard rather than always over `global`.
/// A 1v1 ladder game whose two players are 466 and 500 on the ladder is not a
/// 900-rated game because that is what their global ratings happen to be, and
/// the number printed here is read beside the same players' ratings in the
/// lineup, which name the same leaderboard.
///
/// Rounded to nearest, which is not what a displayed rating does. The two are
/// different quantities: a displayed rating is truncated because that is what
/// the server and both reference clients print for it, while this is an
/// average of several of those and truncating one biases it downward by up to
/// a point every time. A server-supplied `average_rating` is rounded by the
/// caller, so a fallback that truncated also disagreed with the value it
/// stands in for.
pub fn average_game_rating(
    teams: Option<&BTreeMap<String, Vec<String>>>,
    player_ratings: &PlayerRatings,
    leaderboard: &str,
) -> i32 {
    let ratings = teams
        .into_iter()
        .flatten()
        .filter(|(team, _)| team.as_str() != "-1" && team.as_str() != "null")
        .flat_map(|(_, players)| players.iter())
        .filter_map(|login| {
            player_ratings
                .get(login)
                .and_then(|board| board.get(leaderboard))
                .copied()
        })
        .collect::<Vec<_>>();

    if ratings.is_empty() {
        return 0;
    }
    // Through `f64`, not integer division: `/` truncates toward zero, which
    // rounds a negative average the wrong way as well as a positive one.
    let total: i64 = ratings.iter().map(|rating| i64::from(*rating)).sum();
    (total as f64 / ratings.len() as f64).round() as i32
}

/// A `game_info` message is either a single game or a batch under `games`.
pub fn games_in(message: &Value) -> Vec<GameInfo> {
    if let Some(array) = message.get("games").and_then(Value::as_array) {
        array
            .iter()
            .filter_map(|v| serde_json::from_value(v.clone()).ok())
            .collect()
    } else {
        serde_json::from_value(message.clone())
            .into_iter()
            .collect()
    }
}

/// A `game_launch` message: the server's order to start a game. `args` arrives as
/// a mixed list of strings and numbers (`list[str | int]`), so we take it as raw
/// `Value`s and stringify. `uid` is required; everything else defaults.
#[derive(Debug, Clone, Deserialize)]
struct RawGameLaunch {
    uid: i32,
    #[serde(rename = "mod", default)]
    mod_name: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    mapname: String,
    #[serde(default)]
    game_type: String,
    #[serde(default)]
    rating_type: String,
    #[serde(default)]
    expected_players: Option<i32>,
    #[serde(default)]
    team: Option<i32>,
    #[serde(default)]
    faction: Option<i32>,
    #[serde(default)]
    map_position: Option<i32>,
    #[serde(default)]
    game_options: std::collections::BTreeMap<String, Value>,
    #[serde(default)]
    args: Vec<Value>,
}

impl RawGameLaunch {
    fn into_launch(self) -> GameLaunch {
        GameLaunch {
            uid: self.uid,
            mod_name: self.mod_name,
            name: self.name,
            mapname: self.mapname,
            game_type: self.game_type,
            rating_type: self.rating_type,
            expected_players: self.expected_players,
            team: self.team,
            faction: self.faction,
            map_position: self.map_position,
            game_options: self
                .game_options
                .into_iter()
                .map(|(name, value)| (name, value_to_arg(&value)))
                .collect(),
            args: self.args.iter().map(value_to_arg).collect(),
        }
    }
}

/// Render a launch arg as a string: bare for strings, JSON form for numbers/bools.
pub(super) fn value_to_arg(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// Parse a `game_launch` message into a [`GameLaunch`], or `None` if it lacks the
/// required `uid`.
pub(super) fn parse_game_launch(message: &Value) -> Option<GameLaunch> {
    serde_json::from_value::<RawGameLaunch>(message.clone())
        .ok()
        .map(RawGameLaunch::into_launch)
}
