//! The matchmaker on the wire: queues, the party, and map vetoes.

use serde_json::Value;

use crate::state::{MatchmakerQueue, PartyMember, PartyState, PlayerVeto, RatingRange};

/// One queue's published rating windows, as `[[min, max], ...]`.
///
/// A malformed pair is dropped rather than defaulted: an entry that became
/// `0..0` would silently fail to contain anybody's rating, which reads as a
/// quiet queue rather than as bad data.
pub(super) fn parse_rating_ranges(queue: &Value, key: &str) -> Vec<RatingRange> {
    queue
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|pair| {
            let pair = pair.as_array()?;
            Some(RatingRange {
                min: pair.first()?.as_f64()?.round() as i32,
                max: pair.get(1)?.as_f64()?.round() as i32,
            })
        })
        .collect()
}

/// The queues of a `matchmaker_info` message. `received` is when it arrived,
/// which the time to each queue's next pop is counted from.
pub(super) fn parse_matchmaker_queues_at(
    message: &Value,
    received: chrono::DateTime<chrono::Utc>,
) -> Vec<MatchmakerQueue> {
    message
        .get("queues")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|queue| MatchmakerQueue {
            queue_name: queue
                .get("queue_name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            team_size: queue.get("team_size").and_then(Value::as_i64).unwrap_or(1) as i32,
            num_players: queue
                .get("num_players")
                .and_then(Value::as_i64)
                .unwrap_or(0) as i32,
            queue_pop_time_seconds: queue
                .get("queue_pop_time_delta")
                .and_then(Value::as_f64)
                .unwrap_or_default()
                .round() as i32,
            queue_pops_at: queue_pops_at(queue, received),
            boundary_80s: parse_rating_ranges(queue, "boundary_80s"),
            boundary_75s: parse_rating_ranges(queue, "boundary_75s"),
        })
        .filter(|queue| !queue.queue_name.is_empty())
        .collect()
}

/// The instant the queue pops next: the server's delta, counted from when the
/// message arrived. See [`MatchmakerQueue::queue_pops_at`].
///
/// The delta rather than the server's own `queue_pop_time`, which is what the
/// Java client reads: both name the same moment, but the absolute one is only
/// right on a machine whose clock agrees with the server's, and the countdown
/// is read against this machine's clock.
pub(super) fn queue_pops_at(queue: &Value, received: chrono::DateTime<chrono::Utc>) -> String {
    let Some(delta) = queue
        .get("queue_pop_time_delta")
        .and_then(Value::as_f64)
        .filter(|delta| delta.is_finite())
    else {
        return String::new();
    };
    // A pop already due is due now, not in the past: the server sends the
    // next one with the queue's next update.
    let millis = (delta.max(0.0) * 1000.0).round() as i64;
    (received + chrono::Duration::milliseconds(millis))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub(super) fn parse_party(message: &Value) -> PartyState {
    let owner_id = message
        .get("owner")
        .and_then(Value::as_i64)
        .map(|id| id as i32);
    let members = message
        .get("members")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|member| {
            let player_id = member.get("player")?.as_i64()? as i32;
            let factions = member
                .get("factions")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect();
            Some(PartyMember {
                player_id,
                // The server never sends one: `PartyMember.to_dict` is the
                // player id and the factions, nothing else. This is read
                // anyway in case that changes, but the label below is what
                // actually ships, and the UI resolves the id against the live
                // player directory rather than showing it.
                name: member
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("Player {player_id}")),
                factions,
            })
        })
        .collect();
    PartyState { owner_id, members }
}

pub(super) fn parse_vetoes(message: &Value) -> Vec<PlayerVeto> {
    message
        .get("vetoes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|veto| {
            Some(PlayerVeto {
                matchmaker_queue_map_pool_id: veto.get("matchmaker_queue_map_pool_id")?.as_i64()?
                    as i32,
                map_pool_map_version_id: veto.get("map_pool_map_version_id")?.as_i64()? as i32,
                veto_tokens_applied: veto.get("veto_tokens_applied")?.as_i64()? as i32,
            })
        })
        .collect()
}
