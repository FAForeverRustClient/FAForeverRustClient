//! Game notifications: the tracker that turns the lobby's game lists and
//! matchmaker queues into signals (a new game, a full lobby, friends starting
//! to play, your game ending, an opponent in a watched queue), and the
//! notifications those signals raise.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use faf_domain::state::{
    Game, MatchmakerQueue, NotificationAction, NotificationKind, NotificationPreferences,
    PlayerLobbyRating,
};

use crate::runtime::EventSink;
use crate::services::notifications;

#[derive(Debug, Clone)]
pub(super) enum GameNotificationSignal {
    NewGame(Game),
    GameFull(Game),
    FriendsPlaying { logins: Vec<String>, game: Game },
    OwnGameEnded(Game),
}

/// Turns full lobby snapshots into transitions. `None` means no baseline has
/// been received yet, so reconnect/initial snapshots never announce hundreds
/// of existing games as new.
#[derive(Default)]
pub(super) struct GameNotificationTracker {
    open: Option<HashMap<i32, Game>>,
    live: Option<HashMap<i32, Game>>,
    suppress_until: Option<Instant>,
    pub(super) queue_opponents: QueueOpponentTracker,
    /// When each game was last announced as full, so a lobby that fills,
    /// loses a player to the observers and fills again is announced once
    /// rather than on every move (#382).
    full_announced: HashMap<i32, Instant>,
}

/// How long a game stays announced as full. People move between the slots
/// and the observers for the whole of a lobby's setup.
const GAME_FULL_COOLDOWN: Duration = Duration::from_secs(5 * 60);

/// Whether a game that just filled up should be announced, and if so, record
/// that it was. See [`GameNotificationTracker::full_announced`].
fn announce_full(announced: &mut HashMap<i32, Instant>, game_id: i32) -> bool {
    let now = Instant::now();
    if announced
        .get(&game_id)
        .is_some_and(|at| now.duration_since(*at) < GAME_FULL_COOLDOWN)
    {
        return false;
    }
    announced.insert(game_id, now);
    true
}

/// How long a queue keeps quiet after announcing an opponent.
///
/// Rating windows widen while a search waits and a search can be re-queued, so
/// the in-range count can drop to zero and come back within a minute for the
/// very same opponent. One announcement per queue in this window is enough to
/// bring somebody to the client; a toast on every flicker would be the spam
/// that makes people switch it off.
const QUEUE_OPPONENT_COOLDOWN: Duration = Duration::from_secs(5 * 60);

/// Notices a matchmaker queue going from nobody in the player's rating range
/// to somebody (#340).
///
/// Edge-triggered on the in-range count, which is the number the Play tab
/// prints on the queue card and computed the same way (see
/// `queueRatingRange.ts`). The first sight of a queue only records it: a queue
/// that already has somebody in range when the client connects is on screen
/// the moment the player opens the Play tab, and announcing it at login would
/// announce every watched queue at once.
#[derive(Default)]
pub(super) struct QueueOpponentTracker {
    in_range: HashMap<String, i32>,
    announced_at: HashMap<String, Instant>,
}

impl QueueOpponentTracker {
    /// The watched queues that just gained an opponent, with how many are in
    /// range now. Every queue's count is recorded whether or not it is
    /// watched, so switching a queue on does not announce the opponent who
    /// was already waiting in it.
    pub(super) fn observe(
        &mut self,
        queues: &[MatchmakerQueue],
        ratings: &[PlayerLobbyRating],
        searching: &[String],
        watched: &[String],
        now: Instant,
    ) -> Vec<(MatchmakerQueue, i32)> {
        let mut signals = Vec::new();
        for queue in queues {
            let own_search = searching
                .iter()
                .any(|name| name.eq_ignore_ascii_case(&queue.queue_name));
            let count = rating_for_queue(ratings, &queue.queue_name)
                .and_then(|rating| players_in_rating_range(queue, rating))
                // The server counts the player's own search among the others.
                .map(|in_range| (in_range - i32::from(own_search)).max(0))
                .unwrap_or(0);
            let Some(previous) = self.in_range.insert(queue.queue_name.clone(), count) else {
                continue;
            };
            if previous > 0 || count == 0 || own_search {
                continue;
            }
            if !watched
                .iter()
                .any(|name| name.eq_ignore_ascii_case(&queue.queue_name))
            {
                continue;
            }
            if self
                .announced_at
                .get(&queue.queue_name)
                .is_some_and(|at| now.duration_since(*at) < QUEUE_OPPONENT_COOLDOWN)
            {
                continue;
            }
            self.announced_at.insert(queue.queue_name.clone(), now);
            signals.push((queue.clone(), count));
        }
        signals
    }
}

/// The player's lobby rating for a queue. Queue names (`ladder1v1`,
/// `tmm4v4_full_share`) and leaderboard names (`ladder_1v1`) differ only in
/// punctuation, apart from old snapshots calling the full-share queue `tmm4v4`.
/// Twin of `ratingForQueue` in `matchmakerRatings.ts`.
fn rating_for_queue<'a>(
    ratings: &'a [PlayerLobbyRating],
    queue_name: &str,
) -> Option<&'a PlayerLobbyRating> {
    let key = |value: &str| {
        value
            .chars()
            .filter(char::is_ascii_alphanumeric)
            .collect::<String>()
            .to_ascii_lowercase()
    };
    let wanted = match key(queue_name).as_str() {
        "tmm4v4" => "tmm4v4fullshare".to_string(),
        other => other.to_string(),
    };
    ratings
        .iter()
        .find(|rating| key(&rating.leaderboard) == wanted)
}

/// How many queued searches would take the player, or `None` when that cannot
/// honestly be said. Twin of `playersInRatingRange` in `queueRatingRange.ts`,
/// which carries the reasoning: the windows are the server's, they are built
/// from the mean rather than the displayed rating, and a rating the server is
/// still unsure of has no answer.
fn players_in_rating_range(queue: &MatchmakerQueue, rating: &PlayerLobbyRating) -> Option<i32> {
    if rating.mean == 0 && rating.deviation == 0 {
        return None; // The lobby sent no rating for this board.
    }
    if rating.deviation > 200 {
        return None;
    }
    let windows = if rating.deviation < 100 {
        &queue.boundary_80s
    } else {
        &queue.boundary_75s
    };
    if windows.is_empty() {
        return None;
    }
    if queue.team_size == 1 {
        // The server's own 1v1 rule rather than the windows, which it never
        // widens and does not match on. See `matchReach` in the twin.
        let mean = matchmaking_mean(rating);
        let reach = match_reach(f64::from(rating.deviation), SEARCH_EXPANSION_MAX);
        return Some(
            windows
                .iter()
                .filter(|window| {
                    let centre = f64::from(window.min + window.max) / 2.0;
                    (centre - mean).abs() <= reach
                })
                .count() as i32,
        );
    }
    let mean = rating.mean;
    Some(
        windows
            .iter()
            .filter(|window| window.min < mean && mean < window.max)
            .count() as i32,
    )
}

/// `trueskill.setup(beta=240)` in the server's `config.py`.
const TRUESKILL_BETA: f64 = 240.0;
/// `LADDER_SEARCH_EXPANSION_MAX`: how far a match threshold drops, at most.
const SEARCH_EXPANSION_MAX: f64 = 0.25;

/// The mean the server matches a 1v1 search on: pulled towards 500 until the
/// account has played ten games (`NEWBIE_MIN_GAMES`, `NEWBIE_BASE_MEAN`).
fn matchmaking_mean(rating: &PlayerLobbyRating) -> f64 {
    let games = f64::from(rating.games_played.clamp(0, 10));
    if rating.games_played > 10 {
        return f64::from(rating.mean);
    }
    ((10.0 - games) * 500.0 + games * f64::from(rating.mean)) / 10.0
}

/// How far apart in mean two players of this deviation can be and still be
/// matched in 1v1, with their thresholds dropped by `expansion`. Twin of
/// `matchReach` in `queueRatingRange.ts`, which carries the derivation.
fn match_reach(deviation: f64, expansion: f64) -> f64 {
    let c2 = 2.0 * TRUESKILL_BETA.powi(2) + 2.0 * deviation.powi(2);
    let self_quality = (2.0 * TRUESKILL_BETA.powi(2) / c2).sqrt();
    let ratio = 0.8 - expansion / self_quality;
    if ratio <= 0.0 {
        return f64::INFINITY;
    }
    (-2.0 * c2 * ratio.ln()).sqrt()
}

impl GameNotificationTracker {
    pub(super) fn mark_authenticated(&mut self) {
        self.suppress_until = Some(Instant::now() + Duration::from_secs(5));
    }

    fn is_suppressed(&self) -> bool {
        self.suppress_until
            .is_some_and(|until| Instant::now() < until)
    }

    /// The delta twin of [`Self::observe_open`].
    ///
    /// The tracker keeps its own index precisely so that a change can be read
    /// without being handed the whole list again. Before the first snapshot
    /// there is nothing to compare against, so a delta only primes the index,
    /// which is what the snapshot path does on its own first call too.
    pub(super) fn observe_open_delta(
        &mut self,
        upserted: &[Game],
        removed: &[i32],
        player_name: Option<&str>,
    ) -> Vec<GameNotificationSignal> {
        let Some(index) = self.open.as_mut() else {
            return Vec::new();
        };
        let suppressed = self
            .suppress_until
            .is_some_and(|until| Instant::now() < until);

        let mut signals = Vec::new();
        for game in upserted {
            let previous = index.insert(game.id, game.clone());
            if suppressed {
                continue;
            }
            match previous {
                None => signals.push(GameNotificationSignal::NewGame(game.clone())),
                Some(old) => {
                    if let Some(player_name) = player_name {
                        if filled_up(&old, game, player_name)
                            && announce_full(&mut self.full_announced, game.id)
                        {
                            signals.push(GameNotificationSignal::GameFull(game.clone()));
                        }
                    }
                }
            }
        }
        for id in removed {
            index.remove(id);
            self.full_announced.remove(id);
        }
        signals
    }

    /// The delta twin of [`Self::observe_live`].
    ///
    /// A game leaving the live list is what "your game ended" means, so the
    /// removals are read before they are applied.
    pub(super) fn observe_live_delta(
        &mut self,
        upserted: &[Game],
        removed: &[i32],
        friends: &[String],
        player_name: Option<&str>,
    ) -> Vec<GameNotificationSignal> {
        let Some(index) = self.live.as_mut() else {
            return Vec::new();
        };
        let suppressed = self
            .suppress_until
            .is_some_and(|until| Instant::now() < until);

        let mut signals = Vec::new();
        for game in upserted {
            let previous = index.insert(game.id, game.clone());
            if suppressed || previous.is_some() {
                continue;
            }
            let mut game_friends = Vec::new();
            for login in participants(game) {
                if contains_name(friends, login) && !contains_name(&game_friends, login) {
                    game_friends.push(login.to_owned());
                }
            }
            if !game_friends.is_empty() {
                signals.push(GameNotificationSignal::FriendsPlaying {
                    logins: game_friends,
                    game: game.clone(),
                });
            }
        }
        for id in removed {
            let Some(gone) = index.remove(id) else {
                continue;
            };
            if suppressed {
                continue;
            }
            if let Some(player_name) = player_name {
                if game_has_player(&gone, player_name) {
                    signals.push(GameNotificationSignal::OwnGameEnded(gone));
                }
            }
        }
        signals
    }

    pub(super) fn observe_open(
        &mut self,
        games: &[Game],
        player_name: Option<&str>,
    ) -> Vec<GameNotificationSignal> {
        let next = indexed_games(games);
        let Some(previous) = self.open.replace(next.clone()) else {
            return Vec::new();
        };

        if self.is_suppressed() {
            return Vec::new();
        }

        let mut signals = Vec::new();
        for game in games {
            if !previous.contains_key(&game.id) {
                signals.push(GameNotificationSignal::NewGame(game.clone()));
            }
            if let (Some(player_name), Some(old)) = (player_name, previous.get(&game.id)) {
                if filled_up(old, game, player_name)
                    && announce_full(&mut self.full_announced, game.id)
                {
                    signals.push(GameNotificationSignal::GameFull(game.clone()));
                }
            }
        }
        signals
    }

    pub(super) fn observe_live(
        &mut self,
        games: &[Game],
        friends: &[String],
        player_name: Option<&str>,
    ) -> Vec<GameNotificationSignal> {
        let next = indexed_games(games);
        let Some(previous) = self.live.replace(next.clone()) else {
            return Vec::new();
        };

        if self.is_suppressed() {
            return Vec::new();
        }

        let mut signals = Vec::new();
        for game in games.iter().filter(|game| !previous.contains_key(&game.id)) {
            let mut game_friends = Vec::new();
            for login in participants(game) {
                if contains_name(friends, login) && !contains_name(&game_friends, login) {
                    game_friends.push(login.to_owned());
                }
            }
            if !game_friends.is_empty() {
                signals.push(GameNotificationSignal::FriendsPlaying {
                    logins: game_friends,
                    game: game.clone(),
                });
            }
        }
        if let Some(player_name) = player_name {
            for game in previous
                .values()
                .filter(|game| !next.contains_key(&game.id) && game_has_player(game, player_name))
            {
                signals.push(GameNotificationSignal::OwnGameEnded(game.clone()));
            }
        }
        signals
    }
}

fn format_friends_playing(logins: &[String], game_title: &str) -> (&'static str, String) {
    match logins {
        [] => (
            "Friend started playing",
            format!("A friend started playing {game_title}."),
        ),
        [single] => (
            "Friend started playing",
            format!("{single} started playing {game_title}."),
        ),
        [first, second] => (
            "Friends started playing",
            format!("{first} and {second} started playing {game_title}."),
        ),
        [first, second, third] => (
            "Friends started playing",
            format!("{first}, {second}, and {third} started playing {game_title}."),
        ),
        [first, second, rest @ ..] => {
            let count = rest.len();
            let other_friends = if count == 1 {
                "1 other friend".to_string()
            } else {
                format!("{count} other friends")
            };
            (
                "Friends started playing",
                format!("{first}, {second}, and {other_friends} started playing {game_title}."),
            )
        }
    }
}

/// The catalog form of `format_friends_playing` (#458): up to three names are
/// listed, more than that name two and count the rest.
fn friends_playing_text(logins: &[String], game_title: &str) -> notifications::Text {
    let text = match logins {
        [] => notifications::Text::new("notifications.msg.friendsPlayingSomeone"),
        [single] => {
            notifications::Text::new("notifications.msg.friendPlaying").with("first", single)
        }
        [first, second] => notifications::Text::new("notifications.msg.friendsPlayingTwo")
            .with("first", first)
            .with("second", second),
        [first, second, third] => notifications::Text::new("notifications.msg.friendsPlayingThree")
            .with("first", first)
            .with("second", second)
            .with("third", third),
        [first, second, rest @ ..] => {
            notifications::Text::new("notifications.msg.friendsPlayingMany")
                .with("first", first)
                .with("second", second)
                .with("count", rest.len())
        }
    };
    text.with("game", game_title)
}

pub(super) fn notify_game_signal(
    out: &EventSink,
    preferences: &NotificationPreferences,
    signal: GameNotificationSignal,
) {
    match signal {
        GameNotificationSignal::NewGame(game) => {
            let friend_host =
                out.with_state(|state| contains_name(&state.social.friends, &game.host));
            if preferences.new_custom_games
                && (!preferences.new_custom_games_friends_only || friend_host)
            {
                notifications::add_text(
                    out,
                    NotificationKind::NewCustomGame,
                    notifications::Text::new("notifications.msg.newCustomGame")
                        .with("host", &game.host)
                        .with("title", &game.title),
                    "New custom game",
                    format!("{} hosted {}.", game.host, game.title),
                    Some(NotificationAction::OpenCustomGames),
                );
            }
        }
        GameNotificationSignal::GameFull(game) if preferences.game_full => notifications::add_text(
            out,
            NotificationKind::GameFull,
            notifications::Text::new("notifications.msg.gameFull").with("title", &game.title),
            "Game full",
            format!("{} is full and ready to launch.", game.title),
            Some(NotificationAction::OpenCustomGames),
        ),
        GameNotificationSignal::FriendsPlaying { logins, game } if preferences.friend_playing => {
            let (title, message) = format_friends_playing(&logins, &game.title);
            let text = friends_playing_text(&logins, &game.title);
            notifications::add_text(
                out,
                NotificationKind::FriendPlaying,
                text,
                title,
                message,
                None,
            );
        }
        GameNotificationSignal::OwnGameEnded(game) if preferences.review_reminder => {
            notifications::add_text(
                out,
                NotificationKind::ReviewReminder,
                notifications::Text::new("notifications.msg.reviewReminder")
                    .with("title", &game.title),
                "How was your game?",
                format!("Review the map or mods you played in {}.", game.title),
                None,
            );
        }
        _ => {}
    }
}

fn indexed_games(games: &[Game]) -> HashMap<i32, Game> {
    games.iter().map(|game| (game.id, game.clone())).collect()
}

fn contains_name(names: &[String], candidate: &str) -> bool {
    names
        .iter()
        .any(|name| name.eq_ignore_ascii_case(candidate))
}

fn participants(game: &Game) -> impl Iterator<Item = &str> {
    game.teams.values().flatten().map(String::as_str)
}

/// Did this update fill the last slot of a lobby the player is sitting in?
///
/// Hosting is not the question it was. The request was for the warning "even
/// when we're not the host", and it is the same fact for everybody in the
/// lobby: the game is about to launch, and anybody still on another screen
/// wants to know. Whoever is not in the lobby is not told, which is what keeps
/// this from being a notification about every full game on the server.
fn filled_up(old: &Game, game: &Game, player_name: &str) -> bool {
    seated_players(old) < old.max_players
        && seated_players(game) >= game.max_players
        && (game_has_player(game, player_name) || game_has_player(old, player_name))
}

/// How many of a lobby's seats are taken: the players in a team, observers
/// left out.
///
/// The server's `num_players` counts everybody connected to the lobby, and an
/// observer is connected without taking a slot. An eight-player map holding
/// six players and one observer is therefore at seven, and the next player to
/// join put it at eight: "game full", with a seat still open (#336). The teams
/// say who sits where, with observers under `-1` or `null`, so they are what
/// is counted. A game that reports no teams at all falls back to the server's
/// number rather than to zero.
fn seated_players(game: &Game) -> i32 {
    if game.teams.is_empty() {
        return game.players;
    }
    game.teams
        .iter()
        .filter(|(team, _)| team.as_str() != "-1" && team.as_str() != "null")
        .map(|(_, players)| players.len() as i32)
        .sum()
}

fn game_has_player(game: &Game, player_name: &str) -> bool {
    game.host.eq_ignore_ascii_case(player_name)
        || participants(game).any(|name| name.eq_ignore_ascii_case(player_name))
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    fn game(id: i32, host: &str, players: &[&str], current: i32, max: i32) -> Game {
        Game {
            id,
            title: format!("Game {id}"),
            host: host.into(),
            players: current,
            max_players: max,
            map: "scmp_001".into(),
            mod_name: "faf".into(),
            average_rating: 1_000,
            rating_type: "global".into(),
            password_protected: false,
            visibility: "public".into(),
            game_type: "custom".into(),
            launched_at: None,
            hosted_at: None,
            rating_min: None,
            rating_max: None,
            enforce_rating_range: false,
            teams: BTreeMap::from([(
                "1".into(),
                players.iter().map(|name| (*name).to_owned()).collect(),
            )]),
            sim_mods: BTreeMap::new(),
        }
    }

    #[test]
    fn initial_game_snapshots_never_emit_notifications() {
        let mut tracker = GameNotificationTracker::default();
        assert!(tracker
            .observe_open(&[game(1, "Host", &["Host"], 1, 4)], Some("Me"))
            .is_empty());
        assert!(tracker
            .observe_live(
                &[game(2, "Friend", &["Friend"], 2, 2)],
                &["Friend".into()],
                Some("Me"),
            )
            .is_empty());
    }

    #[test]
    fn open_game_transitions_detect_new_games_and_own_full_lobby() {
        let mut tracker = GameNotificationTracker::default();
        let mine = game(1, "Me", &["Me"], 1, 2);
        tracker.observe_open(std::slice::from_ref(&mine), Some("me"));

        let signals = tracker.observe_open(
            &[
                game(1, "ME", &["Me", "Other"], 2, 2),
                game(2, "Host", &["Host"], 1, 4),
            ],
            Some("me"),
        );
        assert_eq!(signals.len(), 2);
        assert!(signals.iter().any(
            |signal| matches!(signal, GameNotificationSignal::GameFull(game) if game.id == 1)
        ));
        assert!(signals
            .iter()
            .any(|signal| matches!(signal, GameNotificationSignal::NewGame(game) if game.id == 2)));
    }

    #[test]
    fn a_lobby_filling_up_is_reported_to_everybody_in_it() {
        let mut tracker = GameNotificationTracker::default();
        // Somebody else's lobby, with us in it, and one somebody else's with
        // us nowhere near it.
        tracker.observe_open(
            &[
                game(1, "Host", &["Host", "Me"], 2, 3),
                game(2, "Host", &["Host"], 1, 2),
            ],
            Some("me"),
        );

        let signals = tracker.observe_open(
            &[
                game(1, "Host", &["Host", "Me", "Third"], 3, 3),
                game(2, "Host", &["Host", "Other"], 2, 2),
            ],
            Some("me"),
        );
        assert_eq!(
            signals
                .iter()
                .filter(|signal| matches!(signal, GameNotificationSignal::GameFull(_)))
                .count(),
            1
        );
        assert!(signals.iter().any(
            |signal| matches!(signal, GameNotificationSignal::GameFull(game) if game.id == 1)
        ));
    }

    /// The report in #382: people going to the observers and back made the
    /// lobby full again, and every time was a toast and a sound.
    #[test]
    fn a_lobby_that_fills_again_is_announced_once() {
        let mut tracker = GameNotificationTracker::default();
        tracker.observe_open(&[game(1, "Me", &["Me"], 1, 2)], Some("me"));
        let full = |tracker: &mut GameNotificationTracker| {
            tracker
                .observe_open(&[game(1, "Me", &["Me", "Other"], 2, 2)], Some("me"))
                .iter()
                .filter(|signal| matches!(signal, GameNotificationSignal::GameFull(_)))
                .count()
        };
        assert_eq!(full(&mut tracker), 1);
        tracker.observe_open(&[game(1, "Me", &["Me"], 1, 2)], Some("me"));
        assert_eq!(full(&mut tracker), 0);
    }

    #[test]
    fn an_observer_does_not_take_a_seat_in_a_full_lobby() {
        let mut tracker = GameNotificationTracker::default();
        let with_observer = |id, seated: &[&str], connected| {
            let mut lobby = game(id, "Me", seated, connected, 8);
            lobby.teams.insert("-1".into(), vec!["Watcher".into()]);
            lobby
        };
        // Six players and an observer on an eight-player map: the server says
        // seven.
        tracker.observe_open(
            &[with_observer(1, &["Me", "A", "B", "C", "D", "E"], 7)],
            Some("me"),
        );

        // A seventh player joins. The server says eight, and a seat is open.
        let signals = tracker.observe_open(
            &[with_observer(1, &["Me", "A", "B", "C", "D", "E", "F"], 8)],
            Some("me"),
        );
        assert!(!signals
            .iter()
            .any(|signal| matches!(signal, GameNotificationSignal::GameFull(_))));

        // The eighth does fill it.
        let signals = tracker.observe_open(
            &[with_observer(
                1,
                &["Me", "A", "B", "C", "D", "E", "F", "G"],
                9,
            )],
            Some("me"),
        );
        assert!(signals.iter().any(
            |signal| matches!(signal, GameNotificationSignal::GameFull(game) if game.id == 1)
        ));
    }

    fn queue(name: &str, windows: &[(i32, i32)]) -> MatchmakerQueue {
        MatchmakerQueue {
            queue_name: name.into(),
            team_size: 1,
            num_players: windows.len() as i32,
            queue_pop_time_seconds: 30,
            queue_pops_at: String::new(),
            boundary_80s: windows
                .iter()
                .map(|&(min, max)| faf_domain::state::RatingRange { min, max })
                .collect(),
            boundary_75s: Vec::new(),
        }
    }

    fn rating(leaderboard: &str, mean: i32) -> PlayerLobbyRating {
        PlayerLobbyRating {
            leaderboard: leaderboard.into(),
            rating: mean - 150,
            mean,
            deviation: 50,
            games_played: 100,
        }
    }

    #[test]
    fn a_watched_queue_announces_an_opponent_once() {
        let mut tracker = QueueOpponentTracker::default();
        let ratings = [rating("ladder_1v1", 1500)];
        let watched = vec!["ladder1v1".to_string()];
        let start = Instant::now();

        // First sight only records the queue.
        assert!(tracker
            .observe(&[queue("ladder1v1", &[])], &ratings, &[], &watched, start)
            .is_empty());
        // Somebody whose window takes 1500 joins.
        let signals = tracker.observe(
            &[queue("ladder1v1", &[(1300, 1700)])],
            &ratings,
            &[],
            &watched,
            start,
        );
        assert_eq!(signals.len(), 1);
        assert_eq!(signals[0].1, 1);
        // They leave and come back within the cooldown: quiet.
        tracker.observe(&[queue("ladder1v1", &[])], &ratings, &[], &watched, start);
        assert!(tracker
            .observe(
                &[queue("ladder1v1", &[(1300, 1700)])],
                &ratings,
                &[],
                &watched,
                start + Duration::from_secs(60),
            )
            .is_empty());
    }

    #[test]
    fn a_queue_stays_quiet_when_unwatched_out_of_range_or_searched() {
        let mut tracker = QueueOpponentTracker::default();
        let ratings = [rating("tmm_2v2", 1500), rating("ladder_1v1", 1500)];
        let now = Instant::now();
        let empty = [queue("ladder1v1", &[]), queue("tmm2v2", &[])];
        tracker.observe(&empty, &ratings, &[], &["ladder1v1".into()], now);

        // tmm2v2 is not watched; ladder1v1's newcomer is far out of range.
        let signals = tracker.observe(
            &[
                queue("ladder1v1", &[(2200, 2600)]),
                queue("tmm2v2", &[(1300, 1700)]),
            ],
            &ratings,
            &[],
            &["ladder1v1".into()],
            now,
        );
        assert!(signals.is_empty());

        // Searching the queue yourself: your own window is not an opponent,
        // and the search will find the real one by itself.
        let mut tracker = QueueOpponentTracker::default();
        tracker.observe(
            &[queue("ladder1v1", &[])],
            &ratings,
            &[],
            &["ladder1v1".into()],
            now,
        );
        let signals = tracker.observe(
            &[queue("ladder1v1", &[(1300, 1700), (1400, 1600)])],
            &ratings,
            &["ladder1v1".into()],
            &["ladder1v1".into()],
            now,
        );
        assert!(signals.is_empty());
    }

    #[test]
    fn live_transitions_detect_friend_start_and_own_game_end() {
        let mut tracker = GameNotificationTracker::default();
        tracker.observe_live(
            &[game(1, "Me", &["Me", "Other"], 2, 2)],
            &["Friend".into()],
            Some("Me"),
        );

        let signals = tracker.observe_live(
            &[game(2, "Host", &["FRIEND", "Host"], 2, 2)],
            &["Friend".into()],
            Some("me"),
        );
        assert_eq!(signals.len(), 2);
        assert!(signals.iter().any(|signal| matches!(
            signal,
            GameNotificationSignal::FriendsPlaying { logins, game }
                if logins == &["FRIEND"] && game.id == 2
        )));
        assert!(signals.iter().any(|signal| matches!(
            signal,
            GameNotificationSignal::OwnGameEnded(game) if game.id == 1
        )));
    }

    #[test]
    fn multiple_friends_in_same_game_produce_single_notification_signal() {
        let mut tracker = GameNotificationTracker::default();
        tracker.observe_live(
            &[],
            &["Friend1".into(), "Friend2".into(), "Friend3".into()],
            None,
        );

        let signals = tracker.observe_live(
            &[game(
                10,
                "Host",
                &["Friend1", "Friend2", "Friend3", "Other"],
                4,
                4,
            )],
            &["Friend1".into(), "Friend2".into(), "Friend3".into()],
            None,
        );
        assert_eq!(signals.len(), 1);
        let GameNotificationSignal::FriendsPlaying { logins, game } = &signals[0] else {
            panic!("expected FriendsPlaying signal");
        };
        assert_eq!(game.id, 10);
        assert_eq!(logins, &["Friend1", "Friend2", "Friend3"]);
    }

    #[test]
    fn format_friends_playing_messages() {
        let (title1, msg1) = format_friends_playing(&["Alice".into()], "1.7k+");
        assert_eq!(title1, "Friend started playing");
        assert_eq!(msg1, "Alice started playing 1.7k+.");

        let (title2, msg2) = format_friends_playing(&["Alice".into(), "Bob".into()], "1.7k+");
        assert_eq!(title2, "Friends started playing");
        assert_eq!(msg2, "Alice and Bob started playing 1.7k+.");

        let (title3, msg3) =
            format_friends_playing(&["Alice".into(), "Bob".into(), "Charlie".into()], "1.7k+");
        assert_eq!(title3, "Friends started playing");
        assert_eq!(msg3, "Alice, Bob, and Charlie started playing 1.7k+.");

        let (title5, msg5) = format_friends_playing(
            &[
                "Doni-".into(),
                "Terarii".into(),
                "VindexNoob".into(),
                "KnownSniper".into(),
                "Resistance".into(),
            ],
            "1.7k+",
        );
        assert_eq!(title5, "Friends started playing");
        assert_eq!(
            msg5,
            "Doni-, Terarii, and 3 other friends started playing 1.7k+."
        );
    }

    #[test]
    fn suppression_window_silences_initial_connection_burst() {
        let mut tracker = GameNotificationTracker::default();
        tracker.mark_authenticated();

        // First packet
        assert!(tracker
            .observe_live(
                &[game(1, "Host1", &["Friend1"], 1, 2)],
                &["Friend1".into()],
                None
            )
            .is_empty());

        // Subsequent packets within the suppression window still establish baseline without firing
        assert!(tracker
            .observe_live(
                &[
                    game(1, "Host1", &["Friend1"], 1, 2),
                    game(2, "Host2", &["Friend2"], 1, 2),
                ],
                &["Friend1".into(), "Friend2".into()],
                None,
            )
            .is_empty());
    }
}
