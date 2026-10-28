//! The profile's Statistics tab, read off the scanned game history the way
//! faftracker.xyz reads it (issue 606).
//!
//! Every number here is the tracker's: its `buildPlayerReport`,
//! `computeMaxStreaks`, `buildMonthlyTimeline`, `buildDailyTimeline` and
//! `buildImprovementDetector` in `src/analytics.js`, and the teammate and
//! opponent split of `src/providers/official.js`. Nothing comes from the
//! API's own counters (the achievement events, a leaderboard's `wonGames`),
//! which do not agree with the games behind them.
//!
//! Where the tracker's rule looks odd it is kept anyway, with a note: the point
//! is that a player who checks the two finds the same figures.

use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};
use specta::Type;

use super::player_card::PlayedGame;
use crate::protocol::game_outcome::Outcome;

/// How many teammates and opponents are sent, most games first. A long
/// history meets thousands of names; past a few hundred each, a row is a
/// handful of games nobody looks up here.
pub const RELATIONS_KEPT: usize = 400;

/// The tracker's "Recent ranked 25".
const RECENT_RATED_GAMES: usize = 25;

/// The tracker's window for "maps gaining/bleeding rating lately".
const RECENT_MAP_GAMES: usize = 60;

/// Everything the Statistics tab shows. Part of [`super::PlayerMapStats`], so
/// it comes with the scan the Maps and Results tabs already share.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlayerReport {
    /// Games whose result is known and that moved a rating: the tracker's
    /// `hasKnownRatingMovement`, the base of every rating figure below.
    pub rated_games: i32,
    /// Of the last 25 rated games, the wins and the wins plus losses: the
    /// tracker's "Recent ranked 25".
    pub recent_wins: i32,
    pub recent_decided: i32,
    /// The average game length in tenths of a minute, over every game the scan
    /// read. A game without both ends counts as zero minutes, as it does there.
    pub average_minutes_tenths: i32,
    /// The longest unbroken runs of ranked wins and of ranked losses.
    pub max_win_streak: PlayerStreak,
    pub max_loss_streak: PlayerStreak,
    /// The longest run of losses across every game, draws and unknown results
    /// passing over it rather than ending it: the improvement detector's own
    /// count, shown beside the worst month.
    pub worst_loss_streak: i32,
    /// The last twelve months with rated games, oldest first.
    pub months: Vec<PlayerPeriodStat>,
    /// Of those months, the ones with at least five rated games, best and
    /// worst by rating gained, at most twelve each.
    pub best_months: Vec<PlayerPeriodStat>,
    pub worst_months: Vec<PlayerPeriodStat>,
    /// Days with at least three rated games, best and worst by rating gained,
    /// at most twelve each.
    pub best_days: Vec<PlayerPeriodStat>,
    pub worst_days: Vec<PlayerPeriodStat>,
    /// The days the last sixty games span, `YYYY-MM-DD`; empty for none.
    pub recent_from: String,
    pub recent_to: String,
    /// Maps of the last sixty games with at least three rated games there,
    /// gaining and losing rating, at most five each.
    pub maps_gaining: Vec<PlayerMapTrend>,
    pub maps_losing: Vec<PlayerMapTrend>,
    /// Repeat 1v1 opponents beaten at least twenty points more often in the
    /// newer half of the history than in the older: the tracker's "1v1
    /// runbacks you started winning". At most five.
    pub runbacks: Vec<PlayerRunback>,
    /// Who the player played with and against, in rated games with a result.
    pub teammates: Vec<PlayerRelation>,
    pub opponents: Vec<PlayerRelation>,
    /// Ranked games with a result, per faction played.
    pub factions: Vec<PlayerFactionStat>,
}

/// One run of results in a row.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlayerStreak {
    pub size: i32,
    /// The days its first and last games were played, `YYYY-MM-DD`.
    pub first: String,
    pub last: String,
}

/// One month (`YYYY-MM`) or day (`YYYY-MM-DD`) of rated games.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlayerPeriodStat {
    pub period: String,
    pub games: i32,
    pub wins: i32,
    pub losses: i32,
    pub draws: i32,
    pub rating_delta_hundredths: i32,
}

/// One map's rating movement in the recent games.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlayerMapTrend {
    /// Empty for a generated map, which the API names no map for.
    pub map: String,
    pub games: i32,
    pub rating_delta_hundredths: i32,
}

/// A repeat 1v1 opponent, the older half of the history against the newer.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlayerRunback {
    pub login: String,
    pub early_games: i32,
    pub early_wins: i32,
    pub late_games: i32,
    pub late_wins: i32,
}

/// A teammate or an opponent.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlayerRelation {
    pub login: String,
    pub games: i32,
    /// The tracker's win rate here is wins out of games, draws included.
    pub wins: i32,
    /// The rating moved in those games, net, and its gains and losses apart.
    pub net_hundredths: i32,
    pub gained_hundredths: i32,
    pub lost_hundredths: i32,
}

/// One faction's ranked record.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlayerFactionStat {
    /// The game's faction id: 1 UEF, 2 Aeon, 3 Cybran, 4 Seraphim.
    pub faction: i32,
    pub games: i32,
    pub wins: i32,
    pub losses: i32,
    pub draws: i32,
}

fn known(game: &PlayedGame) -> bool {
    game.outcome != Outcome::Unknown
}

fn decisive(game: &PlayedGame) -> bool {
    matches!(game.outcome, Outcome::Win | Outcome::Loss)
}

/// This player's rating movement in the game, zero for none.
fn delta(game: &PlayedGame) -> f64 {
    game.rating_delta.filter(|d| d.is_finite()).unwrap_or(0.0)
}

/// `hasKnownRatingMovement`: a known result, and a rating that moved.
fn rated(game: &PlayedGame) -> bool {
    known(game) && delta(game) != 0.0
}

/// `isRankedGame`: rated, or a ladder game with a known result.
fn ranked(game: &PlayedGame) -> bool {
    rated(game) || (game.queue.eq_ignore_ascii_case("ladder_1v1") && known(game))
}

fn hundredths(value: f64) -> i32 {
    (value * 100.0).round() as i32
}

fn day_of(game: &PlayedGame) -> &str {
    game.started_at.get(..10).unwrap_or("")
}

fn month_of(game: &PlayedGame) -> &str {
    game.started_at.get(..7).unwrap_or("")
}

/// Wins out of wins and losses, in percent; zero with neither.
fn win_rate(wins: i32, losses: i32) -> f64 {
    let decided = wins + losses;
    if decided == 0 {
        0.0
    } else {
        f64::from(wins) * 100.0 / f64::from(decided)
    }
}

/// The report over `games`, newest first as the scan returns them.
pub fn build_player_report(games: &[PlayedGame]) -> PlayerReport {
    let mut report = PlayerReport::default();
    let rated_games: Vec<&PlayedGame> = games.iter().filter(|game| rated(game)).collect();
    report.rated_games = rated_games.len() as i32;

    for game in rated_games.iter().take(RECENT_RATED_GAMES) {
        if decisive(game) {
            report.recent_decided += 1;
            if game.outcome == Outcome::Win {
                report.recent_wins += 1;
            }
        }
    }

    if !games.is_empty() {
        let minutes: i64 = games
            .iter()
            .map(|game| i64::from(game.duration_minutes))
            .sum();
        report.average_minutes_tenths =
            ((minutes as f64 / games.len() as f64) * 10.0).round() as i32;
    }

    let stats_games: Vec<&PlayedGame> = games
        .iter()
        .filter(|game| ranked(game) && known(game))
        .collect();
    let (wins, losses) = max_streaks(&stats_games);
    report.max_win_streak = wins;
    report.max_loss_streak = losses;
    report.worst_loss_streak = worst_loss_streak(games);

    report.months = periods(&rated_games, month_of);
    let twelve = report.months.len().saturating_sub(12);
    report.months.drain(..twelve);
    (report.best_months, report.worst_months) = best_and_worst(&report.months, 5);
    let days = periods(&rated_games, day_of);
    (report.best_days, report.worst_days) = best_and_worst(&days, 3);

    recent_maps(games, &mut report);
    report.runbacks = runbacks(games);
    (report.teammates, report.opponents) = relations(games);
    report.factions = factions(&stats_games);
    report
}

/// `computeMaxStreaks`: the decisive games oldest first, and the longest
/// unbroken run of each result.
fn max_streaks(games: &[&PlayedGame]) -> (PlayerStreak, PlayerStreak) {
    let mut chronological: Vec<&PlayedGame> = games
        .iter()
        .copied()
        .filter(|game| decisive(game))
        .collect();
    chronological.sort_by(|a, b| a.started_at.cmp(&b.started_at));

    let mut best_win: &[&PlayedGame] = &[];
    let mut best_loss: &[&PlayedGame] = &[];
    let mut start = 0;
    for end in 1..=chronological.len() {
        let run_ends = end == chronological.len()
            || chronological[end].outcome != chronological[start].outcome;
        if !run_ends {
            continue;
        }
        let run = &chronological[start..end];
        let best = if run[0].outcome == Outcome::Win {
            &mut best_win
        } else {
            &mut best_loss
        };
        if run.len() > best.len() {
            *best = run;
        }
        start = end;
    }
    (streak(best_win), streak(best_loss))
}

fn streak(run: &[&PlayedGame]) -> PlayerStreak {
    match (run.first(), run.last()) {
        (Some(first), Some(last)) => PlayerStreak {
            size: run.len() as i32,
            first: day_of(first).to_string(),
            last: day_of(last).to_string(),
        },
        _ => PlayerStreak::default(),
    }
}

/// The improvement detector's loss streak: every game oldest first, a loss
/// adding one, a win ending the run, anything else passing over it.
fn worst_loss_streak(games: &[PlayedGame]) -> i32 {
    let (mut current, mut worst) = (0, 0);
    for game in games.iter().rev() {
        match game.outcome {
            Outcome::Loss => {
                current += 1;
                worst = worst.max(current);
            }
            Outcome::Win => current = 0,
            _ => {}
        }
    }
    worst
}

/// `buildMonthlyTimeline` and `buildDailyTimeline`: rated games bucketed by
/// `key`, oldest first.
fn periods(rated: &[&PlayedGame], key: fn(&PlayedGame) -> &str) -> Vec<PlayerPeriodStat> {
    let mut buckets: BTreeMap<String, (PlayerPeriodStat, f64)> = BTreeMap::new();
    for game in rated {
        let period = key(game);
        if period.is_empty() {
            continue;
        }
        let (row, total) = buckets.entry(period.to_string()).or_insert_with(|| {
            (
                PlayerPeriodStat {
                    period: period.to_string(),
                    ..PlayerPeriodStat::default()
                },
                0.0,
            )
        });
        row.games += 1;
        match game.outcome {
            Outcome::Win => row.wins += 1,
            Outcome::Loss => row.losses += 1,
            _ => {}
        }
        *total += delta(game);
    }
    buckets
        .into_values()
        .map(|(row, total)| PlayerPeriodStat {
            draws: row.games - row.wins - row.losses,
            rating_delta_hundredths: hundredths(total),
            ..row
        })
        .collect()
}

/// The periods with at least `minimum` games, best and worst by rating
/// gained, the win rate breaking a tie; twelve of each.
fn best_and_worst(
    periods: &[PlayerPeriodStat],
    minimum: i32,
) -> (Vec<PlayerPeriodStat>, Vec<PlayerPeriodStat>) {
    let eligible: Vec<&PlayerPeriodStat> =
        periods.iter().filter(|row| row.games >= minimum).collect();
    let rate = |row: &PlayerPeriodStat| win_rate(row.wins, row.losses);
    let mut best = eligible.clone();
    best.sort_by(|a, b| {
        b.rating_delta_hundredths
            .cmp(&a.rating_delta_hundredths)
            .then(rate(b).total_cmp(&rate(a)))
    });
    let mut worst = eligible;
    worst.sort_by(|a, b| {
        a.rating_delta_hundredths
            .cmp(&b.rating_delta_hundredths)
            .then(rate(a).total_cmp(&rate(b)))
    });
    let take = |rows: Vec<&PlayerPeriodStat>| rows.into_iter().take(12).cloned().collect();
    (take(best), take(worst))
}

/// "Maps gaining/bleeding rating lately": the last sixty games, the rated
/// ones bucketed by map, three games at least.
fn recent_maps(games: &[PlayedGame], report: &mut PlayerReport) {
    let window = &games[..games.len().min(RECENT_MAP_GAMES)];
    let mut days: Vec<&str> = window
        .iter()
        .map(day_of)
        .filter(|day| !day.is_empty())
        .collect();
    days.sort_unstable();
    report.recent_from = days.first().map(|day| day.to_string()).unwrap_or_default();
    report.recent_to = days.last().map(|day| day.to_string()).unwrap_or_default();

    let mut maps: BTreeMap<String, (i32, f64)> = BTreeMap::new();
    for game in window.iter().filter(|game| rated(game)) {
        let entry = maps.entry(game.map.clone()).or_insert((0, 0.0));
        entry.0 += 1;
        entry.1 += delta(game);
    }
    let rows: Vec<PlayerMapTrend> = maps
        .into_iter()
        .filter(|(_, (games, _))| *games >= 3)
        .map(|(map, (games, total))| PlayerMapTrend {
            map,
            games,
            rating_delta_hundredths: hundredths(total),
        })
        .collect();
    let mut gaining: Vec<PlayerMapTrend> = rows
        .iter()
        .filter(|row| row.rating_delta_hundredths > 0)
        .cloned()
        .collect();
    gaining.sort_by(|a, b| {
        b.rating_delta_hundredths
            .cmp(&a.rating_delta_hundredths)
            .then(b.games.cmp(&a.games))
    });
    gaining.truncate(5);
    let mut losing: Vec<PlayerMapTrend> = rows
        .into_iter()
        .filter(|row| row.rating_delta_hundredths < 0)
        .collect();
    losing.sort_by(|a, b| {
        a.rating_delta_hundredths
            .cmp(&b.rating_delta_hundredths)
            .then(b.games.cmp(&a.games))
    });
    losing.truncate(5);
    report.maps_gaining = gaining;
    report.maps_losing = losing;
}

/// "1v1 runbacks you started winning": the history split in two, newer half
/// against older, over decisive games against one opponent and no teammate.
fn runbacks(games: &[PlayedGame]) -> Vec<PlayerRunback> {
    let midpoint = games.len() / 2;
    let (recent, earlier) = games.split_at(midpoint);
    let mut by_opponent: HashMap<String, PlayerRunback> = HashMap::new();
    for (late, half) in [(false, earlier), (true, recent)] {
        for game in half {
            if !decisive(game) || game.opponents.len() != 1 || !game.teammates.is_empty() {
                continue;
            }
            let login = &game.opponents[0];
            let row = by_opponent
                .entry(login.clone())
                .or_insert_with(|| PlayerRunback {
                    login: login.clone(),
                    ..PlayerRunback::default()
                });
            let won = i32::from(game.outcome == Outcome::Win);
            if late {
                row.late_games += 1;
                row.late_wins += won;
            } else {
                row.early_games += 1;
                row.early_wins += won;
            }
        }
    }
    let rate = |wins: i32, games: i32| f64::from(wins) * 100.0 / f64::from(games.max(1));
    let improvement = |row: &PlayerRunback| {
        // Rounded to a tenth before it is compared, as the tracker does.
        ((rate(row.late_wins, row.late_games) - rate(row.early_wins, row.early_games)) * 10.0)
            .round()
            / 10.0
    };
    let mut rows: Vec<PlayerRunback> = by_opponent
        .into_values()
        .filter(|row| row.early_games >= 3 && row.late_games >= 3 && improvement(row) >= 20.0)
        .collect();
    rows.sort_by(|a, b| {
        improvement(b)
            .total_cmp(&improvement(a))
            .then(b.late_games.cmp(&a.late_games))
            .then(a.login.cmp(&b.login))
    });
    rows.truncate(5);
    rows
}

/// Teammates and opponents, from the games with a result that moved a
/// rating: the tracker's relationship games.
fn relations(games: &[PlayedGame]) -> (Vec<PlayerRelation>, Vec<PlayerRelation>) {
    let mut teammates: HashMap<String, (PlayerRelation, f64, f64, f64)> = HashMap::new();
    let mut opponents: HashMap<String, (PlayerRelation, f64, f64, f64)> = HashMap::new();
    for game in games.iter().filter(|game| rated(game)) {
        let d = delta(game);
        let won = i32::from(game.outcome == Outcome::Win);
        for (logins, bucket) in [
            (&game.teammates, &mut teammates),
            (&game.opponents, &mut opponents),
        ] {
            for login in logins {
                let entry = bucket.entry(login.clone()).or_insert_with(|| {
                    (
                        PlayerRelation {
                            login: login.clone(),
                            ..PlayerRelation::default()
                        },
                        0.0,
                        0.0,
                        0.0,
                    )
                });
                entry.0.games += 1;
                entry.0.wins += won;
                entry.1 += d;
                if d > 0.0 {
                    entry.2 += d;
                } else {
                    entry.3 += -d;
                }
            }
        }
    }
    let finish = |bucket: HashMap<String, (PlayerRelation, f64, f64, f64)>| {
        let mut rows: Vec<PlayerRelation> = bucket
            .into_values()
            .map(|(row, net, gained, lost)| PlayerRelation {
                net_hundredths: hundredths(net),
                gained_hundredths: hundredths(gained),
                lost_hundredths: hundredths(lost),
                ..row
            })
            .collect();
        rows.sort_by(|a, b| b.games.cmp(&a.games).then(a.login.cmp(&b.login)));
        rows.truncate(RELATIONS_KEPT);
        rows
    };
    (finish(teammates), finish(opponents))
}

/// Ranked games with a result per faction played. Not one of the tracker's
/// sections: it is here because the API's per-faction counters were wrong, and
/// the same games tell it right.
fn factions(stats_games: &[&PlayedGame]) -> Vec<PlayerFactionStat> {
    let mut by_faction: BTreeMap<i32, PlayerFactionStat> = BTreeMap::new();
    for game in stats_games {
        let Some(faction) = game.faction else {
            continue;
        };
        let row = by_faction
            .entry(faction)
            .or_insert_with(|| PlayerFactionStat {
                faction,
                ..PlayerFactionStat::default()
            });
        row.games += 1;
        match game.outcome {
            Outcome::Win => row.wins += 1,
            Outcome::Loss => row.losses += 1,
            Outcome::Draw => row.draws += 1,
            Outcome::Unknown => {}
        }
    }
    by_faction.into_values().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn game(day: &str, outcome: Outcome, delta: f64) -> PlayedGame {
        PlayedGame {
            game_id: 0,
            map: "Loki".into(),
            outcome,
            rating_moved: delta != 0.0,
            queue: "global".into(),
            played_at: format!("{day}T12:00:00Z"),
            started_at: format!("{day}T11:40:00Z"),
            duration_minutes: 20,
            rating_delta: Some(delta),
            faction: Some(1),
            ..PlayedGame::default()
        }
    }

    #[test]
    fn the_longest_runs_are_counted_oldest_first_over_ranked_results() {
        // Newest first, as the scan delivers them.
        let games = [
            game("2026-10-06", Outcome::Loss, -10.0),
            game("2026-10-05", Outcome::Win, 10.0),
            game("2026-10-04", Outcome::Win, 10.0),
            game("2026-10-03", Outcome::Draw, 1.0),
            game("2026-10-02", Outcome::Win, 10.0),
            game("2026-10-01", Outcome::Loss, -10.0),
        ];
        let report = build_player_report(&games);
        // The draw is no decisive game, so it does not break the run of three.
        assert_eq!(report.max_win_streak.size, 3);
        assert_eq!(report.max_win_streak.first, "2026-10-02");
        assert_eq!(report.max_win_streak.last, "2026-10-05");
        assert_eq!(report.max_loss_streak.size, 1);
        assert_eq!((report.recent_wins, report.recent_decided), (3, 5));
        assert_eq!(report.average_minutes_tenths, 200);
    }

    #[test]
    fn months_carry_rated_games_only_and_rank_by_rating_gained() {
        let mut games = Vec::new();
        for day in [
            "2026-09-01",
            "2026-09-02",
            "2026-09-03",
            "2026-09-04",
            "2026-09-05",
        ] {
            games.push(game(day, Outcome::Win, 10.0));
        }
        for day in [
            "2026-10-01",
            "2026-10-02",
            "2026-10-03",
            "2026-10-04",
            "2026-10-05",
        ] {
            games.push(game(day, Outcome::Loss, -5.0));
        }
        // Moved nothing: not in any month.
        games.push(game("2026-08-01", Outcome::Win, 0.0));
        games.reverse();
        let report = build_player_report(&games);
        let months: Vec<&str> = report
            .months
            .iter()
            .map(|row| row.period.as_str())
            .collect();
        assert_eq!(months, ["2026-09", "2026-10"]);
        assert_eq!(report.best_months[0].period, "2026-09");
        assert_eq!(report.best_months[0].rating_delta_hundredths, 5000);
        assert_eq!(report.worst_months[0].period, "2026-10");
    }

    #[test]
    fn teammates_and_opponents_come_from_rated_games_with_a_result() {
        let mut won = game("2026-10-02", Outcome::Win, 12.0);
        won.teammates = vec!["Ally".into()];
        won.opponents = vec!["Foe".into(), "Other".into()];
        let mut lost = game("2026-10-01", Outcome::Loss, -8.0);
        lost.opponents = vec!["Foe".into()];
        let mut unrated = game("2026-09-30", Outcome::Win, 0.0);
        unrated.opponents = vec!["Foe".into()];
        let report = build_player_report(&[won, lost, unrated]);
        let foe = &report.opponents[0];
        assert_eq!(foe.login, "Foe");
        assert_eq!((foe.games, foe.wins), (2, 1));
        assert_eq!(
            (
                foe.net_hundredths,
                foe.gained_hundredths,
                foe.lost_hundredths
            ),
            (400, 1200, 800)
        );
        assert_eq!(report.teammates[0].login, "Ally");
    }

    #[test]
    fn a_repeat_opponent_beaten_more_often_lately_is_a_runback() {
        let duel = |day: &str, outcome| {
            let mut played = game(day, outcome, 5.0);
            played.opponents = vec!["Rival".into()];
            played
        };
        // Newest first: three wins, then (older) three losses.
        let games = [
            duel("2026-10-06", Outcome::Win),
            duel("2026-10-05", Outcome::Win),
            duel("2026-10-04", Outcome::Win),
            duel("2026-10-03", Outcome::Loss),
            duel("2026-10-02", Outcome::Loss),
            duel("2026-10-01", Outcome::Loss),
        ];
        let report = build_player_report(&games);
        assert_eq!(
            report.runbacks,
            vec![PlayerRunback {
                login: "Rival".into(),
                early_games: 3,
                early_wins: 0,
                late_games: 3,
                late_wins: 3,
            }]
        );
    }

    #[test]
    fn factions_count_ranked_games_with_a_result() {
        let mut aeon = game("2026-10-02", Outcome::Win, 5.0);
        aeon.faction = Some(2);
        let unranked = game("2026-10-01", Outcome::Win, 0.0);
        let report = build_player_report(&[aeon, unranked]);
        assert_eq!(
            report.factions,
            vec![PlayerFactionStat {
                faction: 2,
                games: 1,
                wins: 1,
                losses: 0,
                draws: 0,
            }]
        );
    }
}
