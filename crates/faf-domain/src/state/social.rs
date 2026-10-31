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
    /// Conservative displayed global rating (`mean - 3 × deviation`), and it
    /// may be negative: a new or long-idle account's deviation is large enough
    /// to put it below zero, which is what the server, the website and both
    /// reference clients all print.
    ///
    /// Zero is the "not supplied" sentinel and also a rating somebody can
    /// really have, so `ratings` is what settles the difference: an account
    /// the lobby said nothing about has an empty table. This field is the
    /// fallback for the partial `player_info` payloads that carry the scalar
    /// and no table at all.
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

/// A relation keeps its stable account id even when its name cannot be loaded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Contact {
    pub player_id: i32,
    pub login: Option<String>,
    pub relation: Relation,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ContactsState {
    pub open: bool,
    pub entries: Vec<Contact>,
    pub refreshing: bool,
}

/// What the API said about a login nobody online answers to.
///
/// The user menu opens on names from replays, results and leaderboards, most
/// of them offline, and every account action (friend, foe, note) addresses the
/// player by id. `id` is `None` when the API knows no such account, which is
/// the answer for an IRC-only nickname.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LoginLookup {
    pub login: String,
    pub id: Option<i32>,
}

/// How many account lookups are kept. A menu opened on a few hundred offline
/// names in one session is a lot; the oldest answers go first.
pub const MAX_LOGIN_LOOKUPS: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SocialState {
    #[serde(default)]
    pub contacts: ContactsState,
    /// Logins of players on our friends list, sorted.
    pub friends: Vec<String>,
    /// Logins of players on our foes list, sorted.
    pub foes: Vec<String>,
    /// Every FAF account currently announced online, sorted by login.
    pub players: Vec<PlayerProfile>,
    /// Accounts looked up by login for the user menu, oldest first.
    pub login_lookups: Vec<LoginLookup>,
    /// Logins of FAF's moderators and administrators: the members of the
    /// public moderation and administration groups the API lists. Chat
    /// counts them as "Moderators & admins" beside the channel operators,
    /// because on FAF's IRC the moderators hold no operator mode, and that
    /// category showed nobody but the QAI bot (issue 607). Sorted.
    pub staff: Vec<String>,
}

impl SocialState {
    pub fn is_friend(&self, login: &str) -> bool {
        self.friends.iter().any(|f| f.eq_ignore_ascii_case(login))
    }

    pub fn is_foe(&self, login: &str) -> bool {
        self.foes.iter().any(|f| f.eq_ignore_ascii_case(login))
    }

    pub fn is_staff(&self, login: &str) -> bool {
        self.staff.iter().any(|s| s.eq_ignore_ascii_case(login))
    }

    /// The profile for a nickname, or `None` if it isn't a known FAF account.
    pub fn player(&self, login: &str) -> Option<&PlayerProfile> {
        self.players
            .binary_search_by(|p| p.login.as_str().cmp(login))
            .ok()
            .map(|i| &self.players[i])
            .or_else(|| {
                self.players
                    .iter()
                    .find(|p| p.login.eq_ignore_ascii_case(login))
            })
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
    ContactsUpdated {
        contacts: Vec<Contact>,
    },
    ContactSet {
        contact: Contact,
        member: bool,
    },
    ContactsOpened {
        open: bool,
    },
    ContactsRefreshing {
        refreshing: bool,
    },
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
    PlayersSeen {
        players: Vec<PlayerProfile>,
    },
    /// Profiles authoritatively marked offline by `player_info`. Relations are
    /// retained: going offline does not stop somebody being a friend or foe.
    PlayersRemoved {
        logins: Vec<String>,
    },
    /// The lobby connection went away; relations are no longer authoritative.
    Cleared,
    /// The API answered an account lookup by login: the id, or `None` for a
    /// login with no account behind it.
    LoginLookedUp {
        login: String,
        id: Option<i32>,
    },
    /// The API listed FAF's moderators and administrators (see
    /// [`SocialState::staff`]). Replaces the list.
    StaffLoaded {
        logins: Vec<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    content = "payload",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SocialCommand {
    SetContactsOpen {
        open: bool,
    },
    ResolveContacts,
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
    /// Find the account behind a login nobody online answers to, so the user
    /// menu can offer an offline player the same account actions as an
    /// online one.
    LookUpLogin {
        login: String,
    },
}

pub fn reduce(state: &mut SocialState, event: &SocialEvent) {
    match event {
        SocialEvent::ContactsOpened { open } => state.contacts.open = *open,
        SocialEvent::ContactsRefreshing { refreshing } => state.contacts.refreshing = *refreshing,
        SocialEvent::ContactsUpdated { contacts } => state.contacts.entries = contacts.clone(),
        SocialEvent::ContactSet { contact, member } => {
            let previous: Vec<_> = state
                .contacts
                .entries
                .iter()
                .filter(|known| {
                    known.player_id == contact.player_id
                        && (*member || known.relation == contact.relation)
                })
                .cloned()
                .collect();
            // A lookup may have resolved the name since the action was sent.
            // Remove the prior identity by id, even if the action had no name.
            for known in &previous {
                if let Some(login) = &known.login {
                    reduce(
                        state,
                        &SocialEvent::RelationSet {
                            login: login.clone(),
                            relation: known.relation,
                            member: false,
                        },
                    );
                }
            }
            let login = contact
                .login
                .clone()
                .or_else(|| previous.iter().find_map(|known| known.login.clone()));
            if let Some(login) = &login {
                reduce(
                    state,
                    &SocialEvent::RelationSet {
                        login: login.clone(),
                        relation: contact.relation,
                        member: *member,
                    },
                );
            }
            state.contacts.entries.retain(|known| {
                known.player_id != contact.player_id
                    || (!*member && known.relation != contact.relation)
            });
            if *member {
                state.contacts.entries.push(Contact {
                    login,
                    ..contact.clone()
                });
            }
        }
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
            target.retain(|l| !l.eq_ignore_ascii_case(login));
            if *member {
                target.push(login.clone());
                target.sort();
                // The server treats the two lists as mutually exclusive.
                opposite.retain(|l| !l.eq_ignore_ascii_case(login));
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
            state.players.retain(|profile| {
                !logins
                    .iter()
                    .any(|login| login.eq_ignore_ascii_case(&profile.login))
            });
        }
        // The staff list is the API's, not the lobby's, so a lobby disconnect
        // does not make it any less true.
        SocialEvent::Cleared => {
            *state = SocialState {
                contacts: ContactsState {
                    open: state.contacts.open,
                    ..ContactsState::default()
                },
                staff: std::mem::take(&mut state.staff),
                ..SocialState::default()
            }
        }
        SocialEvent::StaffLoaded { logins } => state.staff = sorted(logins.clone()),
        SocialEvent::LoginLookedUp { login, id } => {
            // The newest answer replaces an older one for the same login and
            // moves to the end, so the cap drops the answers asked for longest
            // ago.
            state
                .login_lookups
                .retain(|lookup| !lookup.login.eq_ignore_ascii_case(login));
            state.login_lookups.push(LoginLookup {
                login: login.clone(),
                id: *id,
            });
            let excess = state.login_lookups.len().saturating_sub(MAX_LOGIN_LOOKUPS);
            state.login_lookups.drain(..excess);
        }
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

    #[test]
    fn contacts_keep_offline_ids_and_move_or_remove_without_a_profile() {
        let mut state = SocialState::default();
        reduce(&mut state, &SocialEvent::ContactsOpened { open: true });
        let friend = Contact {
            player_id: 7,
            login: Some("Offline".into()),
            relation: Relation::Friend,
        };
        reduce(
            &mut state,
            &SocialEvent::ContactSet {
                contact: friend.clone(),
                member: true,
            },
        );
        let unknown = Contact {
            player_id: 99,
            login: None,
            relation: Relation::Foe,
        };
        reduce(
            &mut state,
            &SocialEvent::ContactSet {
                contact: unknown.clone(),
                member: true,
            },
        );
        assert!(state.players.is_empty());
        assert_eq!(state.friends, ["Offline"]);
        assert_eq!(state.contacts.entries.len(), 2);
        reduce(
            &mut state,
            &SocialEvent::ContactSet {
                contact: Contact {
                    relation: Relation::Foe,
                    ..friend
                },
                member: true,
            },
        );
        assert!(state.friends.is_empty());
        assert_eq!(state.foes, ["Offline"]);
        assert_eq!(state.contacts.entries.len(), 2);
        reduce(
            &mut state,
            &SocialEvent::ContactSet {
                contact: unknown,
                member: false,
            },
        );
        assert_eq!(state.contacts.entries.len(), 1);
        reduce(
            &mut state,
            &SocialEvent::ContactsRefreshing { refreshing: true },
        );
        reduce(&mut state, &SocialEvent::Cleared);
        assert!(state.contacts.open);
        assert!(!state.contacts.refreshing);
        assert!(state.contacts.entries.is_empty());
    }

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
            contacts: ContactsState::default(),
            friends: names(&["Aurora"]),
            foes: Vec::new(),
            players: vec![profile(1, "Aurora"), profile(2, "Zed")],
            login_lookups: Vec::new(),
            staff: Vec::new(),
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
    fn cleared_resets_everything_the_lobby_told_us() {
        let mut s = SocialState {
            contacts: ContactsState::default(),
            friends: names(&["Aurora"]),
            foes: names(&["Griefer"]),
            players: vec![profile(1, "Aurora")],
            login_lookups: vec![LoginLookup {
                login: "Zed".into(),
                id: Some(2),
            }],
            staff: names(&["Morax"]),
        };
        reduce(&mut s, &SocialEvent::Cleared);
        // The staff list came from the API, and stays (issue 607).
        assert_eq!(
            s,
            SocialState {
                staff: names(&["Morax"]),
                ..SocialState::default()
            }
        );
    }

    #[test]
    fn staff_matches_any_spelling() {
        let mut s = SocialState::default();
        reduce(
            &mut s,
            &SocialEvent::StaffLoaded {
                logins: names(&["Morax", "Brutus5000"]),
            },
        );
        assert_eq!(s.staff, names(&["Brutus5000", "Morax"]));
        assert!(s.is_staff("morax"));
        assert!(!s.is_staff("Aurora"));
    }

    #[test]
    fn relations_case_insensitive_matching() {
        let mut s = SocialState::default();
        reduce(
            &mut s,
            &SocialEvent::RelationsUpdated {
                friends: names(&["Aurora"]),
                foes: names(&["Griefer"]),
            },
        );
        assert!(s.is_friend("aurora"));
        assert!(s.is_friend("AURORA"));
        assert!(s.is_foe("griefer"));

        // Removing with different casing works.
        reduce(
            &mut s,
            &SocialEvent::RelationSet {
                login: "aurora".into(),
                relation: Relation::Friend,
                member: false,
            },
        );
        assert!(!s.is_friend("Aurora"));
    }

    #[test]
    fn player_case_insensitive_lookup() {
        let mut s = SocialState::default();
        reduce(
            &mut s,
            &SocialEvent::PlayersSeen {
                players: vec![profile(1, "Aurora")],
            },
        );
        assert_eq!(s.player("aurora").map(|p| p.id), Some(1));
        assert_eq!(s.player("AURORA").map(|p| p.id), Some(1));
    }

    fn looked_up(login: &str, id: Option<i32>) -> SocialEvent {
        SocialEvent::LoginLookedUp {
            login: login.into(),
            id,
        }
    }

    #[test]
    fn a_login_lookup_is_kept_once_with_its_newest_answer_last() {
        let mut s = SocialState::default();
        reduce(&mut s, &looked_up("Aurora", Some(1)));
        reduce(&mut s, &looked_up("bot", None));
        reduce(&mut s, &looked_up("aurora", Some(1)));
        assert_eq!(
            s.login_lookups,
            vec![
                LoginLookup {
                    login: "bot".into(),
                    id: None
                },
                LoginLookup {
                    login: "aurora".into(),
                    id: Some(1)
                },
            ]
        );
    }

    #[test]
    fn login_lookups_drop_the_oldest_past_the_cap() {
        let mut s = SocialState::default();
        for n in 0..=MAX_LOGIN_LOOKUPS {
            reduce(&mut s, &looked_up(&format!("player{n}"), Some(n as i32)));
        }
        assert_eq!(s.login_lookups.len(), MAX_LOGIN_LOOKUPS);
        assert_eq!(s.login_lookups[0].login, "player1");
    }
}
