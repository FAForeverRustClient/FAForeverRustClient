//! Social slice: the lobby server's view of who we know and who is online.
//!
//! Sourced entirely from the lobby connection (the `social` and `player_info`
//! commands), not from chat: IRC knows nicknames and channel modes, it does not
//! know that a nickname belongs to a FAF account, what country that account
//! plays from, or that you have befriended it. Both reference clients cross-
//! reference the two the same way: the Java client's `ChatChannelUser` holds
//! an optional `PlayerInfo` and derives its `SocialStatus` from it, and the
//! Python client's chatter ranking falls back to `NONPLAYER` when no player
//! record matches.
//!
//! Kept as its own slice (rather than as lobby fields) because it is consumed
//! by chat, not by the game browser: the planned slice list in
//! ARCHITECTURE.md §2 already reserves `social` for exactly this.

use serde::{Deserialize, Serialize};
use specta::Type;

/// One conservative displayed rating from the lobby's live `player_info`
/// snapshot. This deliberately stays smaller than the player-card API model:
/// chat only needs an instant hover summary, not history or win/loss details.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlayerLobbyRating {
    pub leaderboard: String,
    pub rating: i32,
    /// TrueSkill parameters passed to Forged Alliance for the in-game lobby.
    pub mean: i32,
    pub deviation: i32,
    /// Zero when the lobby omitted the count.
    pub games_played: i32,
}

/// What the lobby knows about one account. The chat roster renders the flag,
/// avatar and clan tag from this, and the user menu needs `id` because the
/// social/party wire commands address players by id, not by name.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlayerProfile {
    pub id: i32,
    pub login: String,
    /// Conservative displayed global rating (`mean - 3 × deviation`). Zero
    /// means the lobby supplied no global rating for this account.
    pub global_rating: i32,
    /// All rating queues supplied by the lobby, sorted by technical name.
    pub ratings: Vec<PlayerLobbyRating>,
    /// ISO 3166-1 alpha-2, lowercased (`"de"`). Empty when the account has no
    /// country set: the flag is then simply not rendered.
    pub country: String,
    /// Clan tag without brackets, empty when the player is in no clan.
    pub clan: String,
    /// Absolute URL of the player's avatar, empty when they have none.
    pub avatar_url: String,
    /// The avatar's hover text (its name), as the reference clients show it.
    pub avatar_tooltip: String,
}

/// Which relation list an action operates on. Friends and foes are mutually
/// exclusive on the server, and the reducer keeps them that way locally too.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Relation {
    Friend,
    Foe,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SocialState {
    /// Logins of players on our friends list, sorted.
    pub friends: Vec<String>,
    /// Logins of players on our foes list, sorted.
    pub foes: Vec<String>,
    /// Every FAF account currently announced online, sorted by login.
    pub players: Vec<PlayerProfile>,
}

impl SocialState {
    pub fn is_friend(&self, login: &str) -> bool {
        self.friends.iter().any(|f| f == login)
    }

    pub fn is_foe(&self, login: &str) -> bool {
        self.foes.iter().any(|f| f == login)
    }

    /// The profile for a nickname, or `None` if it isn't a known FAF account.
    pub fn player(&self, login: &str) -> Option<&PlayerProfile> {
        self.players
            .binary_search_by(|p| p.login.as_str().cmp(login))
            .ok()
            .map(|i| &self.players[i])
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    content = "payload",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SocialEvent {
    /// A full replacement of both relation lists (the lobby sends them together).
    RelationsUpdated {
        friends: Vec<String>,
        foes: Vec<String>,
    },
    /// One relation was added or removed. Emitted optimistically when the user
    /// acts, because `social_add`/`social_remove` are fire-and-forget: the
    /// server does not echo a fresh `social` message back, so both reference
    /// clients update their local set at the point of action too.
    RelationSet {
        login: String,
        relation: Relation,
        member: bool,
    },
    /// Profiles newly seen or changed. Merged into the existing set by login,
    /// not replacing it.
    PlayersSeen { players: Vec<PlayerProfile> },
    /// Profiles authoritatively marked offline by `player_info`. Relations are
    /// retained: going offline does not stop somebody being a friend or foe.
    PlayersRemoved { logins: Vec<String> },
    /// The lobby connection went away; relations are no longer authoritative.
    Cleared,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    content = "payload",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SocialCommand {
    /// Add or remove a friend/foe.
    ///
    /// Carries `login` alongside `player_id` because the wire command addresses
    /// the player by id while our own state is keyed by name: the same posture
    /// as `ChatCommand::Connect` carrying the UI-known username rather than
    /// making the backend look it up.
    SetRelation {
        player_id: i32,
        login: String,
        relation: Relation,
        member: bool,
    },
}

pub fn reduce(state: &mut SocialState, event: &SocialEvent) {
    match event {
        SocialEvent::RelationsUpdated { friends, foes } => {
            state.friends = sorted(friends.clone());
            state.foes = sorted(foes.clone());
        }
        SocialEvent::RelationSet {
            login,
            relation,
            member,
        } => {
            let (target, opposite) = match relation {
                Relation::Friend => (&mut state.friends, &mut state.foes),
                Relation::Foe => (&mut state.foes, &mut state.friends),
            };
            target.retain(|l| l != login);
            if *member {
                target.push(login.clone());
                target.sort();
                // The server treats the two lists as mutually exclusive.
                opposite.retain(|l| l != login);
            }
        }
        SocialEvent::PlayersSeen { players } => {
            for profile in players {
                match state
                    .players
                    .binary_search_by(|p| p.login.cmp(&profile.login))
                {
                    Ok(i) => state.players[i] = profile.clone(),
                    Err(i) => state.players.insert(i, profile.clone()),
                }
            }
        }
        SocialEvent::PlayersRemoved { logins } => {
            state
                .players
                .retain(|profile| !logins.iter().any(|login| login == &profile.login));
        }
        SocialEvent::Cleared => *state = SocialState::default(),
    }
}

fn sorted(mut values: Vec<String>) -> Vec<String> {
    values.sort();
    values.dedup();
    values
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn profile(id: i32, login: &str) -> PlayerProfile {
        PlayerProfile {
            id,
            login: login.into(),
            global_rating: 1_200,
            ratings: Vec::new(),
            country: "de".into(),
            ..Default::default()
        }
    }

    #[test]
    fn relations_replace_and_sort() {
        let mut s = SocialState::default();
        reduce(
            &mut s,
            &SocialEvent::RelationsUpdated {
                friends: names(&["Stormlord", "Aurora"]),
                foes: names(&["Griefer"]),
            },
        );
        assert_eq!(s.friends, names(&["Aurora", "Stormlord"]));
        assert!(s.is_friend("Aurora"));
        assert!(s.is_foe("Griefer"));

        reduce(
            &mut s,
            &SocialEvent::RelationsUpdated {
                friends: names(&["Sheikah"]),
                foes: vec![],
            },
        );
        assert_eq!(s.friends, names(&["Sheikah"]));
        assert!(!s.is_friend("Aurora"));
        assert!(s.foes.is_empty());
    }

    #[test]
    fn relation_set_adds_and_removes() {
        let mut s = SocialState::default();
        reduce(
            &mut s,
            &SocialEvent::RelationSet {
                login: "Aurora".into(),
                relation: Relation::Friend,
                member: true,
            },
        );
        assert!(s.is_friend("Aurora"));
        reduce(
            &mut s,
            &SocialEvent::RelationSet {
                login: "Aurora".into(),
                relation: Relation::Friend,
                member: false,
            },
        );
        assert!(!s.is_friend("Aurora"));
    }

    #[test]
    fn relation_set_is_idempotent() {
        let mut s = SocialState::default();
        for _ in 0..2 {
            reduce(
                &mut s,
                &SocialEvent::RelationSet {
                    login: "Aurora".into(),
                    relation: Relation::Friend,
                    member: true,
                },
            );
        }
        assert_eq!(s.friends, names(&["Aurora"]));
    }

    #[test]
    fn befriending_a_foe_drops_the_foe_entry() {
        // The server enforces mutual exclusion; local state must not disagree.
        let mut s = SocialState {
            foes: names(&["Griefer"]),
            ..Default::default()
        };
        reduce(
            &mut s,
            &SocialEvent::RelationSet {
                login: "Griefer".into(),
                relation: Relation::Friend,
                member: true,
            },
        );
        assert!(s.is_friend("Griefer"));
        assert!(!s.is_foe("Griefer"));
    }

    #[test]
    fn profiles_accumulate_sorted_and_update_in_place() {
        let mut s = SocialState::default();
        reduce(
            &mut s,
            &SocialEvent::PlayersSeen {
                players: vec![profile(2, "Zed"), profile(1, "Aurora")],
            },
        );
        reduce(
            &mut s,
            &SocialEvent::PlayersSeen {
                players: vec![profile(3, "Mid")],
            },
        );
        let logins: Vec<_> = s.players.iter().map(|p| p.login.as_str()).collect();
        assert_eq!(logins, vec!["Aurora", "Mid", "Zed"]);

        // A later announcement for the same login replaces, never duplicates.
        let mut renamed_country = profile(1, "Aurora");
        renamed_country.country = "fr".into();
        reduce(
            &mut s,
            &SocialEvent::PlayersSeen {
                players: vec![renamed_country],
            },
        );
        assert_eq!(s.players.len(), 3);
        assert_eq!(s.player("Aurora").unwrap().country, "fr");
    }

    #[test]
    fn player_lookup_distinguishes_accounts_from_irc_only_nicknames() {
        let mut s = SocialState::default();
        reduce(
            &mut s,
            &SocialEvent::PlayersSeen {
                players: vec![profile(1, "Aurora")],
            },
        );
        assert_eq!(s.player("Aurora").map(|p| p.id), Some(1));
        assert!(s.player("SomeBot").is_none());
    }

    #[test]
    fn removing_an_offline_profile_keeps_its_friend_relation() {
        let mut s = SocialState {
            friends: names(&["Aurora"]),
            foes: Vec::new(),
            players: vec![profile(1, "Aurora"), profile(2, "Zed")],
        };
        reduce(
            &mut s,
            &SocialEvent::PlayersRemoved {
                logins: vec!["Aurora".into()],
            },
        );

        assert!(s.player("Aurora").is_none());
        assert!(s.player("Zed").is_some());
        assert!(s.is_friend("Aurora"));
    }

    #[test]
    fn cleared_resets_everything() {
        let mut s = SocialState {
            friends: names(&["Aurora"]),
            foes: names(&["Griefer"]),
            players: vec![profile(1, "Aurora")],
        };
        reduce(&mut s, &SocialEvent::Cleared);
        assert_eq!(s, SocialState::default());
    }
}
