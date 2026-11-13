//! The Activity part of the profile's Statistics tab (issue 748): when, how
//! long and in which queue a player played, read off the same scanned game
//! history as the rest of the tab.
//!
//! Time is the games' own: from the start the API states to the end it
//! states, the minutes [`PlayedGame::duration_minutes`] already holds. A game
//! without both ends adds a game and no time, as it does to the average
//! length. Replays, offline games and time in lobbies are not FAF games, so
//! Steam's playtime is always the larger number.

use std::collections::BTreeMap;

use chrono::{DateTime, Datelike, Timelike, Utc};
use serde::{Deserialize, Serialize};
use specta::Type;

use super::player_card::PlayedGame;

/// The game counts the milestones are reached at.
pub const MILESTONES: [i32; 5] = [1, 10, 100, 1_000, 10_000];

/// Hours in a week: the length of [`PlayerActivity::week_minutes`].
pub const WEEK_HOURS: usize = 7 * 24;

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlayerActivity {
    /// Every month from the first game's to the last game's, oldest first,
    /// months without a game included, so a break shows as one.
    pub months: Vec<PlayerActivityMonth>,
    /// Minutes played by the hour of the week the game started in, UTC:
    /// Monday 00:00 to 00:59 first, Sunday 23:00 last, [`WEEK_HOURS`] in all.
    /// UTC because the domain has no clock or time zone; the view turns it
    /// into the reader's local week.
    pub week_minutes: Vec<i32>,
    /// Games and minutes per faction played, most minutes first.
    pub factions: Vec<PlayerFactionTime>,
    /// When each of [`MILESTONES`] was reached, as far as the scan reaches.
    pub milestones: Vec<PlayerMilestone>,
}

/// One calendar month (UTC) of games.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlayerActivityMonth {
    /// `YYYY-MM`.
    pub period: String,
    pub games: i32,
    pub minutes: i32,
    /// The minutes per queue (leaderboard name), most first; queues without
    /// a minute are left out.
    pub queues: Vec<PlayerQueueMinutes>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlayerQueueMinutes {
    pub queue: String,
    pub minutes: i32,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlayerFactionTime {
    /// The game's faction id.
    pub faction: i32,
    pub games: i32,
    pub minutes: i32,
}

/// The `games`-th game of the history, and when it started (ISO).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlayerMilestone {
    pub games: i32,
    pub reached: String,
}

fn started(game: &PlayedGame) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(&game.started_at)
        .ok()
        .map(|at| at.with_timezone(&Utc))
}

/// `YYYY-MM` of the month after `period`.
fn next_month(period: &str) -> Option<String> {
    let (year, month) = period.split_once('-')?;
    let (year, month): (i32, u32) = (year.parse().ok()?, month.parse().ok()?);
    Some(if month >= 12 {
        format!("{:04}-01", year + 1)
    } else {
        format!("{year:04}-{:02}", month + 1)
    })
}

/// The activity over `games`, in any order.
pub fn build_player_activity(games: &[PlayedGame]) -> PlayerActivity {
    let mut dated: Vec<(DateTime<Utc>, &PlayedGame)> = games
        .iter()
        .filter_map(|game| started(game).map(|at| (at, game)))
        .collect();
    dated.sort_by_key(|(at, game)| (*at, game.game_id));

    let mut by_month: BTreeMap<String, (i32, i32, BTreeMap<String, i32>)> = BTreeMap::new();
    let mut week_minutes = vec![0; WEEK_HOURS];
    let mut by_faction: BTreeMap<i32, (i32, i32)> = BTreeMap::new();
    let mut milestones = Vec::new();

    for (index, (at, game)) in dated.iter().enumerate() {
        let minutes = game.duration_minutes.max(0);
        let month = by_month
            .entry(format!("{:04}-{:02}", at.year(), at.month()))
            .or_default();
        month.0 += 1;
        month.1 += minutes;
        if minutes > 0 {
            *month.2.entry(game.queue.clone()).or_default() += minutes;
        }

        let hour = at.weekday().num_days_from_monday() as usize * 24 + at.hour() as usize;
        week_minutes[hour] += minutes;

        if let Some(faction) = game.faction {
            let row = by_faction.entry(faction).or_default();
            row.0 += 1;
            row.1 += minutes;
        }

        let count = i32::try_from(index + 1).unwrap_or(i32::MAX);
        if MILESTONES.contains(&count) {
            milestones.push(PlayerMilestone {
                games: count,
                reached: at.to_rfc3339(),
            });
        }
    }

    // Every month between the first and the last, so a year off is a gap in
    // the chart rather than two months that look adjacent.
    let mut months = Vec::new();
    if let (Some(first), Some(last)) = (
        by_month.keys().next().cloned(),
        by_month.keys().next_back().cloned(),
    ) {
        let mut period = first;
        loop {
            let (games, minutes, queues) = by_month.remove(&period).unwrap_or_default();
            let mut queues: Vec<PlayerQueueMinutes> = queues
                .into_iter()
                .map(|(queue, minutes)| PlayerQueueMinutes { queue, minutes })
                .collect();
            queues.sort_by(|a, b| b.minutes.cmp(&a.minutes).then(a.queue.cmp(&b.queue)));
            months.push(PlayerActivityMonth {
                period: period.clone(),
                games,
                minutes,
                queues,
            });
            if period >= last {
                break;
            }
            match next_month(&period) {
                Some(next) => period = next,
                None => break,
            }
        }
    }

    let mut factions: Vec<PlayerFactionTime> = by_faction
        .into_iter()
        .map(|(faction, (games, minutes))| PlayerFactionTime {
            faction,
            games,
            minutes,
        })
        .collect();
    factions.sort_by(|a, b| b.minutes.cmp(&a.minutes).then(a.faction.cmp(&b.faction)));

    PlayerActivity {
        months,
        week_minutes,
        factions,
        milestones,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn game(id: i32, started_at: &str, minutes: i32, queue: &str, faction: i32) -> PlayedGame {
        PlayedGame {
            game_id: id,
            queue: queue.into(),
            started_at: started_at.into(),
            duration_minutes: minutes,
            faction: Some(faction),
            ..PlayedGame::default()
        }
    }

    #[test]
    fn months_run_from_the_first_game_to_the_last_with_the_gaps_in() {
        // Newest first, as the scan delivers them.
        let games = [
            game(3, "2026-03-02T20:00:00Z", 30, "ladder_1v1", 1),
            game(2, "2026-01-31T23:30:00Z", 40, "global", 2),
            game(1, "2026-01-05T20:00:00Z", 20, "ladder_1v1", 1),
        ];
        let activity = build_player_activity(&games);
        let periods: Vec<&str> = activity.months.iter().map(|m| m.period.as_str()).collect();
        assert_eq!(periods, ["2026-01", "2026-02", "2026-03"]);
        let january = &activity.months[0];
        assert_eq!((january.games, january.minutes), (2, 60));
        assert_eq!(
            january.queues,
            vec![
                PlayerQueueMinutes {
                    queue: "global".into(),
                    minutes: 40
                },
                PlayerQueueMinutes {
                    queue: "ladder_1v1".into(),
                    minutes: 20
                },
            ]
        );
        assert_eq!(activity.months[1].games, 0, "February had no game");
    }

    #[test]
    fn a_year_boundary_is_crossed_by_month() {
        let games = [
            game(2, "2026-01-01T10:00:00Z", 10, "global", 1),
            game(1, "2025-11-30T10:00:00Z", 10, "global", 1),
        ];
        let periods: Vec<String> = build_player_activity(&games)
            .months
            .into_iter()
            .map(|m| m.period)
            .collect();
        assert_eq!(periods, ["2025-11", "2025-12", "2026-01"]);
    }

    #[test]
    fn the_week_is_counted_in_utc_hours_from_monday() {
        // 2026-11-09 is a Monday, 2026-11-15 a Sunday.
        let games = [
            game(1, "2026-11-09T00:10:00Z", 25, "global", 1),
            game(2, "2026-11-15T23:59:00Z", 15, "global", 1),
        ];
        let week = build_player_activity(&games).week_minutes;
        assert_eq!(week.len(), WEEK_HOURS);
        assert_eq!(week[0], 25);
        assert_eq!(week[WEEK_HOURS - 1], 15);
        assert_eq!(week.iter().sum::<i32>(), 40);
    }

    #[test]
    fn milestones_count_games_oldest_first() {
        let mut games: Vec<PlayedGame> = (1..=12)
            .map(|day| game(day, &format!("2026-01-{day:02}T12:00:00Z"), 20, "global", 3))
            .collect();
        games.reverse();
        let activity = build_player_activity(&games);
        let reached: Vec<(i32, &str)> = activity
            .milestones
            .iter()
            .map(|m| (m.games, &m.reached[..10]))
            .collect();
        assert_eq!(reached, [(1, "2026-01-01"), (10, "2026-01-10")]);
        assert_eq!(
            activity.factions,
            vec![PlayerFactionTime {
                faction: 3,
                games: 12,
                minutes: 240
            }]
        );
    }

    #[test]
    fn a_game_without_a_start_counts_nowhere() {
        let games = [game(1, "", 30, "global", 1)];
        assert_eq!(
            build_player_activity(&games),
            PlayerActivity {
                week_minutes: vec![0; WEEK_HOURS],
                ..PlayerActivity::default()
            }
        );
    }
}
