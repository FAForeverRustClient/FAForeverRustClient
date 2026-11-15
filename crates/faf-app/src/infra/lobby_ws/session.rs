//! Pure lobby session fold. Socket, HTTP, clocks and machine proofs stay in the adapter.
use crate::ports::LobbyUpdate;
use faf_domain::protocol::lobby::{
    average_game_rating, ClientMessage, GameInfo, PlayerEntry, PlayerRatings, ServerMessage,
    SocialLists,
};
use faf_domain::protocol::rating::whole_points;
use faf_domain::state::{
    Game, MatchmakingState, PartyState, PlayerLobbyRating, PlayerProfile, Relation,
    GLOBAL_LEADERBOARD,
};
use std::collections::BTreeMap;

/// Ordered instructions for the transport. None performs I/O in the fold.
#[derive(Debug)]
pub(super) enum Effect {
    Emit(LobbyUpdate),
    Send(ClientMessage),
    TrySend(ClientMessage),
    MachineProof(String),
    ResolveContacts(Vec<i64>),
    Stop { hopeless: bool },
}

#[derive(Default)]
pub(super) struct SessionState {
    games: GameSet,
    ratings: PlayerRatings,
    directory: PlayerDirectory,
    own_player_id: Option<i64>,
    matchmaking: MatchmakingState,
    authenticated: bool,
}

impl SessionState {
    pub(super) fn authenticated(&self) -> bool {
        self.authenticated
    }

    pub(super) fn contact_relation_message(
        &mut self,
        contact: faf_domain::state::Contact,
        member: bool,
    ) -> ClientMessage {
        self.directory.contact_relation_message(contact, member)
    }

    pub(super) fn contacts_resolved(&mut self, names: Vec<(i64, String)>) -> Vec<Effect> {
        for (id, login) in names {
            self.directory.record_login(id, login);
        }
        vec![Effect::Emit(self.directory.contact_update())]
    }

    pub(super) fn outgoing(&mut self, frame: &ClientMessage) -> Vec<Effect> {
        self.directory.note_local_relation(frame);
        // The server sends no search stop after a match. A local game end
        // must retire Launching before a later search_info can republish it.
        if frame.reports_game_ended()
            && matches!(
                self.matchmaking,
                MatchmakingState::Launching { .. } | MatchmakingState::MatchFound { .. }
            )
        {
            self.matchmaking = MatchmakingState::Idle;
            vec![Effect::Emit(LobbyUpdate::Matchmaking(
                self.matchmaking.clone(),
            ))]
        } else {
            vec![]
        }
    }

    pub(super) fn incoming(&mut self, message: ServerMessage) -> Vec<Effect> {
        let mut effects = Vec::new();
        match message {
            ServerMessage::GameRelay { command, args } => {
                effects.push(Effect::Emit(LobbyUpdate::GameRelay { command, args }))
            }
            ServerMessage::Ping => effects.push(Effect::Send(ClientMessage::Pong)),
            ServerMessage::Session { session } => effects.push(Effect::MachineProof(session)),
            ServerMessage::AuthenticationFailed { reason } => {
                tracing::error!(%reason, "lobby authentication failed");
                effects.push(Effect::Emit(LobbyUpdate::ConnectionRejected { reason }));
                effects.push(Effect::Stop { hopeless: false });
            }
            ServerMessage::Welcome { me } => self.welcome(me, &mut effects),
            ServerMessage::PlayerInfo { players } => self.players(players, &mut effects),
            ServerMessage::Notice(notice) => {
                tracing::info!(style = ?notice.style, text = %notice.text, "lobby notice received");
                if notice.is_unofficial_client_greeting() {
                    return effects;
                }
                if notice.is_ban() {
                    effects.push(Effect::Emit(LobbyUpdate::Banned {
                        text: notice.plain_text(),
                    }));
                    effects.push(Effect::Stop { hopeless: true });
                } else {
                    effects.push(Effect::Emit(LobbyUpdate::Notice {
                        style: notice.style,
                        text: notice.text,
                    }));
                }
            }
            ServerMessage::Invalid { text } => {
                let reason = text.unwrap_or_else(|| {
                    if self.authenticated {
                        "The lobby server rejected an invalid client command."
                    } else {
                        "The lobby server rejected this client's sign-in."
                    }
                    .to_string()
                });
                tracing::error!(%reason, authenticated = self.authenticated, "lobby protocol command rejected");
                effects.push(Effect::Emit(LobbyUpdate::ConnectionRejected { reason }));
                effects.push(Effect::Stop { hopeless: false });
            }
            ServerMessage::GameInfo { games } => self.games(games, &mut effects),
            ServerMessage::GameLaunch(launch) => {
                if let Some(launch) = launch {
                    if launch.game_type.eq_ignore_ascii_case("matchmaker") {
                        if let Some(queue_name) =
                            self.matchmaking.matched_queue().map(str::to_owned)
                        {
                            self.matchmaking = MatchmakingState::Launching { queue_name };
                            effects.push(self.matchmaking_update());
                        }
                    }
                    effects.push(Effect::Emit(LobbyUpdate::Launch(launch)));
                } else {
                    tracing::warn!("game launch message was missing required fields");
                }
            }
            ServerMessage::GameJoinFailed { id, reason } => {
                effects.push(Effect::Emit(LobbyUpdate::JoinFailed { id, reason }))
            }
            ServerMessage::MatchmakerInfo { queues } => {
                effects.push(Effect::Emit(LobbyUpdate::MatchmakerQueues(queues)))
            }
            ServerMessage::SearchInfo {
                queue_name,
                searching,
            } => {
                if self.matchmaking.update_search(queue_name, searching) {
                    effects.push(self.matchmaking_update());
                }
            }
            ServerMessage::MatchFound { queue_name } => {
                self.matchmaking = MatchmakingState::MatchFound { queue_name };
                effects.push(self.matchmaking_update());
                effects.push(Effect::TrySend(ClientMessage::MatchReady));
            }
            ServerMessage::MatchCancelled => {
                self.matchmaking = MatchmakingState::Cancelled {
                    queue_name: self.matchmaking.matched_queue().map(str::to_owned),
                };
                effects.push(self.matchmaking_update());
            }
            ServerMessage::UpdateParty(party) => {
                effects.push(Effect::Emit(LobbyUpdate::Party(party)))
            }
            ServerMessage::PartyInvite {
                sender_id: player_id,
            } => {
                if player_id > 0 {
                    let login = self
                        .directory
                        .login(player_id)
                        .unwrap_or_else(|| format!("Player {player_id}"));
                    effects.push(Effect::Emit(LobbyUpdate::PartyInvite { player_id, login }));
                }
            }
            ServerMessage::KickedFromParty => {
                effects.push(Effect::Emit(LobbyUpdate::Party(PartyState::default())))
            }
            ServerMessage::VetoesInfo { vetoes, forced } => {
                effects.push(Effect::Emit(LobbyUpdate::Vetoes { vetoes, forced }))
            }
            ServerMessage::Social(social) => {
                self.directory.set_relations(&social);
                let missing = self.directory.unresolved_relation_ids();
                if missing.is_empty() {
                    effects.push(Effect::Emit(self.directory.contact_update()));
                } else {
                    effects.push(Effect::ResolveContacts(missing));
                }
                effects.push(Effect::Emit(LobbyUpdate::AutoJoinChannels(social.channels)));
            }
            ServerMessage::Avatars(avatars) => {
                effects.push(Effect::Emit(LobbyUpdate::Avatars(avatars)))
            }
            ServerMessage::FailedMessage {
                reason,
                key,
                request,
            } => {
                tracing::warn!(%reason, %key, %request, "the message broker refused a frame from this client")
            }
            ServerMessage::Other { .. } => {}
        }
        effects
    }

    fn matchmaking_update(&self) -> Effect {
        Effect::Emit(LobbyUpdate::Matchmaking(self.matchmaking.clone()))
    }

    fn welcome(&mut self, me: Option<PlayerEntry>, effects: &mut Vec<Effect>) {
        self.authenticated = true;
        effects.push(Effect::Emit(LobbyUpdate::Authenticated));
        if let Some(player) = me {
            self.own_player_id = player.id;
            update_player_ratings(&mut self.ratings, &player);
            if let Some(profile) = self.directory.observe(&player) {
                effects.push(Effect::Emit(LobbyUpdate::PlayersSeen(vec![profile])));
            }
        }
        effects.push(Effect::TrySend(ClientMessage::MatchmakerInfo));
    }

    fn players(&mut self, players: Vec<PlayerEntry>, effects: &mut Vec<Effect>) {
        let before = self.directory.relations();
        let mut seen = Vec::new();
        let mut removed = Vec::new();
        for player in players {
            if player.offline {
                // A reconnect's old socket can mark our live account offline.
                if player.id.is_some() && player.id == self.own_player_id {
                    continue;
                }
                if let Some(profile) = self.directory.remove(&player) {
                    self.ratings.remove(&profile.login);
                    removed.push(profile);
                }
            } else {
                update_player_ratings(&mut self.ratings, &player);
                if let Some(profile) = self.directory.observe(&player) {
                    seen.push(profile);
                }
            }
        }
        if !removed.is_empty() {
            effects.push(Effect::Emit(LobbyUpdate::PlayersRemoved(removed)));
        }
        if !seen.is_empty() {
            effects.push(Effect::Emit(LobbyUpdate::PlayersSeen(seen)));
        }
        if self.directory.relations() != before {
            effects.push(Effect::Emit(self.directory.contact_update()));
        }
        let mut delta = GameDelta::default();
        self.games.refresh_ratings(&self.ratings, &mut delta);
        delta.append_to(effects);
    }

    fn games(&mut self, games: Vec<GameInfo>, effects: &mut Vec<Effect>) {
        let replaces_list = games.len() > 1;
        let mut delta = GameDelta::default();
        for game in games {
            self.games.apply(game, &self.ratings, &mut delta);
        }
        let restored = self.directory.restore_seated(self.games.seated());
        if !restored.is_empty() {
            for profile in &restored {
                restore_player_ratings(&mut self.ratings, profile);
            }
            self.games.refresh_ratings(&self.ratings, &mut delta);
            effects.push(Effect::Emit(LobbyUpdate::PlayersSeen(restored)));
        }
        if replaces_list {
            effects.push(Effect::Emit(LobbyUpdate::Games(self.games.snapshot())));
            effects.push(Effect::Emit(LobbyUpdate::LiveGames(
                self.games.snapshot_live(),
            )));
        } else {
            delta.append_to(effects);
        }
    }
}

impl GameDelta {
    fn append_to(self, effects: &mut Vec<Effect>) {
        if !self.open_upserted.is_empty() || !self.open_removed.is_empty() {
            effects.push(Effect::Emit(LobbyUpdate::GamesChanged {
                upserted: self.open_upserted,
                removed: self.open_removed,
            }));
        }
        if !self.live_upserted.is_empty() || !self.live_removed.is_empty() {
            effects.push(Effect::Emit(LobbyUpdate::LiveGamesChanged {
                upserted: self.live_upserted,
                removed: self.live_removed,
            }));
        }
    }
}

/// Tracks who's who, so the chat roster can tell a FAF account from an
/// IRC-only nickname and can rank friends above strangers.
///
/// The lobby announces relations (`social`) as account *ids* but announces
/// identities (`player_info`) separately, and in either order: so this keeps
/// the raw ids and re-resolves them each time the directory grows. Both
/// reference clients do the same join; the Java client's `PlayerService` is
/// this map under another name.
#[derive(Debug, Default)]
struct PlayerDirectory {
    /// Last known account name by stable player id. Unlike `profiles`, this is
    /// deliberately retained while a player is offline: social relation
    /// payloads contain ids, so forgetting the name would make an unrelated
    /// later player update silently drop offline friends from the social list.
    logins: BTreeMap<i64, String>,
    profiles: BTreeMap<i64, PlayerProfile>,
    /// The last profile of each account an offline notice removed, until it
    /// is seen again: see `restore_seated`.
    departed: BTreeMap<i64, PlayerProfile>,
    friend_ids: Vec<i64>,
    foe_ids: Vec<i64>,
}

/// How many removed profiles the directory keeps. A day's coming and going on
/// FAF, at a few hundred bytes each.
const DEPARTED_LIMIT: usize = 4096;

impl PlayerDirectory {
    fn contact_relation_message(
        &mut self,
        contact: faf_domain::state::Contact,
        member: bool,
    ) -> ClientMessage {
        if let Some(login) = contact.login.filter(|login| !login.is_empty()) {
            // UI actions may outlive a rename; only seed an unknown identity.
            self.logins
                .entry(i64::from(contact.player_id))
                .or_insert(login);
        }
        ClientMessage::Relation {
            player_id: contact.player_id,
            relation: contact.relation,
            member,
        }
    }
    fn contacts(&self) -> Vec<faf_domain::state::Contact> {
        [
            (Relation::Friend, &self.friend_ids),
            (Relation::Foe, &self.foe_ids),
        ]
        .into_iter()
        .flat_map(|(relation, ids)| {
            ids.iter().filter_map(move |id| {
                let player_id = i32::try_from(*id).ok().filter(|id| *id > 0)?;
                Some(faf_domain::state::Contact {
                    player_id,
                    login: self.logins.get(id).cloned(),
                    relation,
                })
            })
        })
        .collect()
    }

    fn contact_update(&self) -> LobbyUpdate {
        let (friends, foes) = self.relations();
        LobbyUpdate::Relations {
            friends,
            foes,
            contacts: self.contacts(),
        }
    }

    fn login(&self, id: i32) -> Option<String> {
        self.logins.get(&(id as i64)).cloned()
    }

    /// Remove an authoritative offline entry, returning the last full profile.
    /// Repeated/unknown offline messages are no-ops, which prevents duplicate
    /// notifications and mirrors both reference clients' player maps.
    fn remove(&mut self, player: &PlayerEntry) -> Option<PlayerProfile> {
        let id = player.id?;
        if let Some(login) = &player.login {
            self.logins.insert(id, login.clone());
        }
        let profile = self.profiles.remove(&id)?;
        if self.departed.len() >= DEPARTED_LIMIT {
            self.departed.pop_first();
        }
        self.departed.insert(id, profile.clone());
        Some(profile)
    }

    /// Bring back the removed profiles of players a game lists, and return
    /// them.
    ///
    /// An offline notice is not always true. When an account signs in again,
    /// the server registers the new connection and only then drops the old
    /// one, and dropping it deletes the player by id, which by then is the
    /// new connection's entry, and broadcasts the old one as `offline`
    /// (`player_service.remove_player`). Everyone else's client forgets a
    /// player who is still online, and the server sends no new `player_info`
    /// for them until their avatar or rating changes. Seated in a lobby, they
    /// showed with no flag, no rating and an unrated average (#595).
    ///
    /// `game_info` lists only connected players, so a seat is proof enough.
    fn restore_seated<'a>(&mut self, seated: impl Iterator<Item = &'a str>) -> Vec<PlayerProfile> {
        if self.departed.is_empty() {
            return Vec::new();
        }
        let wanted: std::collections::BTreeSet<String> = seated.map(str::to_lowercase).collect();
        let ids: Vec<i64> = self
            .departed
            .iter()
            .filter(|(_, profile)| wanted.contains(&profile.login.to_lowercase()))
            .map(|(id, _)| *id)
            .collect();
        let mut restored = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(profile) = self.departed.remove(&id) {
                if let std::collections::btree_map::Entry::Vacant(slot) = self.profiles.entry(id) {
                    slot.insert(profile.clone());
                    restored.push(profile);
                }
            }
        }
        restored
    }

    /// Record one `player_info`/`me` entry. Returns the profile only when it is
    /// new or has actually changed, so a `player_info` that repeats what we
    /// already know costs nothing on the update stream: this arrives for every
    /// online player at login and then continuously.
    fn observe(&mut self, player: &PlayerEntry) -> Option<PlayerProfile> {
        let login = player.login.clone()?;
        let id = player.id?;
        self.logins.insert(id, login.clone());
        self.departed.remove(&id);

        let known = self.profiles.get(&id);
        let ratings = player
            .ratings
            .clone()
            .or_else(|| known.map(|profile| profile.ratings.clone()))
            .unwrap_or_else(|| {
                player
                    .legacy_global_rating
                    .and_then(|rating| {
                        Some(vec![PlayerLobbyRating {
                            leaderboard: "global".into(),
                            rating: whole_points(rating)?,
                            mean: whole_points(rating)?,
                            deviation: 0,
                            games_played: 0,
                        }])
                    })
                    .unwrap_or_default()
            });

        let profile = PlayerProfile {
            // Ids are database serials, comfortably inside i32 (see `Player`).
            id: id as i32,
            login,
            // Some incremental `player_info` variants omit ratings. Preserve
            // the last known estimate instead of making the UI flash unrated.
            global_rating: player
                .rating_estimate
                .or_else(|| known.map(|profile| profile.global_rating))
                .unwrap_or_default(),
            ratings,
            // Flag filenames are lowercase; normalise here so the UI doesn't
            // have to care that the server sends "DE".
            country: player.country.to_lowercase(),
            clan: player.clan.clone(),
            avatar_url: player.avatar_url.clone(),
            avatar_tooltip: player.avatar_tooltip.clone(),
        };

        match self.profiles.get(&id) {
            Some(known) if *known == profile => None,
            _ => {
                self.profiles.insert(id, profile.clone());
                Some(profile)
            }
        }
    }

    fn set_relations(&mut self, social: &SocialLists) {
        self.friend_ids = social.friends.clone();
        self.foe_ids = social.foes.clone();
    }

    /// Fold a `social_add`/`social_remove` this client is *sending* into the
    /// directory's own lists.
    ///
    /// The server acknowledges neither command and never sends a second
    /// `social` message, so the connection would otherwise never learn what
    /// the user just did: the id lists stay exactly as they arrived at login.
    /// That was invisible until the next `player_info` named an account the
    /// relation lists had been waiting for, because the resolved lists are
    /// re-sent then -- and they are built from these ids, so they replaced the
    /// change the user had just made with the state from login. Adding a foe
    /// put a friend back, removing a friend restored them, and adding a friend
    /// held for a second or two and then vanished.
    ///
    /// The two lists are kept mutually exclusive here, as they are in the
    /// slice: `services::social` sends the matching `social_remove` for the
    /// other list, so this is the local half of the same decision.
    fn note_local_relation(&mut self, message: &ClientMessage) {
        let ClientMessage::Relation {
            player_id,
            relation,
            member,
        } = message
        else {
            return;
        };
        let id = i64::from(*player_id);
        let (list, other) = match relation {
            Relation::Friend => (&mut self.friend_ids, &mut self.foe_ids),
            Relation::Foe => (&mut self.foe_ids, &mut self.friend_ids),
        };
        list.retain(|known| *known != id);
        if *member {
            list.push(id);
            other.retain(|known| *known != id);
        }
    }
    fn unresolved_relation_ids(&self) -> Vec<i64> {
        let mut missing = Vec::new();
        for &id in self.friend_ids.iter().chain(self.foe_ids.iter()) {
            if !self.logins.contains_key(&id) && !missing.contains(&id) {
                missing.push(id);
            }
        }
        missing
    }

    fn record_login(&mut self, id: i64, login: String) {
        // A lookup started before a rename must not replace a live profile.
        let login = self
            .profiles
            .get(&id)
            .map(|profile| profile.login.clone())
            .unwrap_or(login);
        self.logins.insert(id, login);
    }

    #[cfg(test)]
    fn has_relations(&self) -> bool {
        !self.friend_ids.is_empty() || !self.foe_ids.is_empty()
    }

    /// Relations as logins, dropping ids we have never been able to name,
    /// they resolve on a later `player_info`, which re-emits. Known identities
    /// survive an offline transition even though their online profile does not.
    fn relations(&self) -> (Vec<String>, Vec<String>) {
        let resolve = |ids: &Vec<i64>| {
            ids.iter()
                .filter_map(|id| self.logins.get(id).cloned())
                .collect()
        };
        (resolve(&self.friend_ids), resolve(&self.foe_ids))
    }
}

/// Put a restored player's ratings back, from the profile that kept them.
fn restore_player_ratings(ratings: &mut PlayerRatings, profile: &PlayerProfile) {
    if ratings.contains_key(&profile.login) {
        return;
    }
    let boards: BTreeMap<String, i32> = if profile.ratings.is_empty() {
        // Only the estimate `update_player_ratings` falls back to, if any.
        if profile.global_rating == 0 {
            return;
        }
        BTreeMap::from([(GLOBAL_LEADERBOARD.to_string(), profile.global_rating)])
    } else {
        profile
            .ratings
            .iter()
            .map(|rating| (rating.leaderboard.clone(), rating.rating))
            .collect()
    };
    ratings.insert(profile.login.clone(), boards);
}

fn update_player_ratings(ratings: &mut PlayerRatings, player: &PlayerEntry) {
    let Some(login) = player.login.as_deref() else {
        return;
    };

    // A partial `player_info` that carries no ratings at all must not erase
    // what the last full one said, which is the same rule `observe` follows
    // for the profile it keeps.
    if let Some(boards) = player.ratings.clone() {
        if !boards.is_empty() {
            ratings.insert(
                login.to_string(),
                boards
                    .into_iter()
                    .map(|rating| (rating.leaderboard, rating.rating))
                    .collect(),
            );
            return;
        }
    }
    if let Some(estimate) = player.rating_estimate {
        ratings
            .entry(login.to_string())
            .or_default()
            .insert(GLOBAL_LEADERBOARD.to_string(), estimate);
    }
}

/// The aggregated game lists, split into "open" (joinable) and "playing"
/// (watchable live). Keyed by id so updates replace in place and games that
/// leave a state are removed from it; snapshots are ordered by id for stable
/// rendering. A game moves between the two sets as its state changes (e.g.
/// `open` → `playing` when it launches).
#[derive(Debug, Default)]
struct GameSet {
    games: BTreeMap<i32, Game>,
    live_games: BTreeMap<i32, Game>,
}

/// What one batch of `game_info` frames did to the two lists.
///
/// Accumulated across the frames in a batch and sent once, so a server dump of
/// fifty lobbies is one event rather than fifty. Empty halves are not sent at
/// all: the common frame touches the open list and leaves the live list alone,
/// and re-sending an unchanged live list is most of what this replaces.
#[derive(Default)]
struct GameDelta {
    open_upserted: Vec<Game>,
    open_removed: Vec<i32>,
    live_upserted: Vec<Game>,
    live_removed: Vec<i32>,
}

impl GameSet {
    fn apply(&mut self, raw: GameInfo, player_ratings: &PlayerRatings, delta: &mut GameDelta) {
        let Some(uid) = raw.uid else {
            return;
        };
        let (open, playing) = (raw.is_open(), raw.is_playing());
        if open {
            if let Some(game) = raw.into_game(player_ratings) {
                // An unchanged repeat is not a change. The server re-announces a
                // lobby on any edit, including ones that leave everything this
                // client shows identical.
                if self.games.get(&uid) != Some(&game) {
                    delta.open_upserted.push(game.clone());
                    self.games.insert(uid, game);
                }
            }
            if self.live_games.remove(&uid).is_some() {
                delta.live_removed.push(uid);
            }
        } else if playing {
            if let Some(game) = raw.into_game(player_ratings) {
                if self.live_games.get(&uid) != Some(&game) {
                    delta.live_upserted.push(game.clone());
                    self.live_games.insert(uid, game);
                }
            }
            if self.games.remove(&uid).is_some() {
                delta.open_removed.push(uid);
            }
        } else {
            if self.games.remove(&uid).is_some() {
                delta.open_removed.push(uid);
            }
            if self.live_games.remove(&uid).is_some() {
                delta.live_removed.push(uid);
            }
        }
    }

    /// Re-average every game against ratings that just arrived, reporting only
    /// the games whose number actually moved.
    ///
    /// This runs on every `player_info`, which is the most frequent frame the
    /// lobby sends. It used to be followed by a full resend of both lists;
    /// almost always nothing had changed, because the player it described was
    /// not in a lobby at all.
    fn refresh_ratings(&mut self, player_ratings: &PlayerRatings, delta: &mut GameDelta) {
        for game in self.games.values_mut() {
            let average = average_game_rating(Some(&game.teams), player_ratings, &game.rating_type);
            if average > 0 && average != game.average_rating {
                game.average_rating = average;
                delta.open_upserted.push(game.clone());
            }
        }
        for game in self.live_games.values_mut() {
            let average = average_game_rating(Some(&game.teams), player_ratings, &game.rating_type);
            if average > 0 && average != game.average_rating {
                game.average_rating = average;
                delta.live_upserted.push(game.clone());
            }
        }
    }

    fn snapshot(&self) -> Vec<Game> {
        self.games.values().cloned().collect()
    }

    /// Every player in an open or a running game, observers included.
    fn seated(&self) -> impl Iterator<Item = &str> {
        self.games
            .values()
            .chain(self.live_games.values())
            .flat_map(|game| game.teams.values().flatten())
            .map(String::as_str)
    }

    fn snapshot_live(&self) -> Vec<Game> {
        self.live_games.values().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use faf_domain::protocol::lobby::games_in;
    use serde_json::{json, Value};

    fn feed(state: &mut SessionState, value: Value) -> Vec<Effect> {
        state.incoming(ServerMessage::decode(&value, chrono::DateTime::UNIX_EPOCH))
    }

    #[test]
    fn session_fold_preserves_handshake_order_and_own_online_identity() {
        let mut state = SessionState::default();
        assert!(
            matches!(&feed(&mut state, json!({"command":"session", "session":123}))[..], [Effect::MachineProof(id)] if id == "123")
        );
        assert!(!state.authenticated());
        let effects = feed(
            &mut state,
            json!({"command":"welcome", "me":{"id":7,"login":"Owner"}}),
        );
        assert!(matches!(
            &effects[..],
            [
                Effect::Emit(LobbyUpdate::Authenticated),
                Effect::Emit(LobbyUpdate::PlayersSeen(_)),
                Effect::TrySend(ClientMessage::MatchmakerInfo)
            ]
        ));
        assert!(state.authenticated());
        assert!(feed(
            &mut state,
            json!({"command":"player_info", "players":[{"id":7,"login":"Owner","state":"offline"}]})
        )
        .is_empty());
        assert!(state.directory.profiles.contains_key(&7));
        assert!(matches!(
            &state.incoming(ServerMessage::Ping)[..],
            [Effect::Send(ClientMessage::Pong)]
        ));
    }

    #[test]
    fn session_fold_game_end_cannot_be_undone_by_a_late_search_stop() {
        let mut state = SessionState::default();
        let effects = state.incoming(ServerMessage::MatchFound {
            queue_name: "ladder1v1".into(),
        });
        assert!(matches!(
            &effects[..],
            [
                Effect::Emit(LobbyUpdate::Matchmaking(
                    MatchmakingState::MatchFound { .. }
                )),
                Effect::TrySend(ClientMessage::MatchReady)
            ]
        ));
        let effects = state.outgoing(&ClientMessage::GameRelay {
            command: "GameState".into(),
            args: vec![json!("Ended")],
        });
        assert!(matches!(
            &effects[..],
            [Effect::Emit(LobbyUpdate::Matchmaking(
                MatchmakingState::Idle
            ))]
        ));
        let effects = state.incoming(ServerMessage::SearchInfo {
            queue_name: "ladder1v1".into(),
            searching: false,
        });
        assert!(!effects.iter().any(|effect| matches!(
            effect,
            Effect::Emit(LobbyUpdate::Matchmaking(
                MatchmakingState::MatchFound { .. } | MatchmakingState::Launching { .. }
            ))
        )));
    }

    #[test]
    fn session_fold_defers_unknown_contacts_and_republishes_renames() {
        let mut state = SessionState::default();
        let effects = feed(
            &mut state,
            json!({"command":"social", "friends":[42], "foes":[], "channels":["#language"]}),
        );
        assert!(
            matches!(&effects[..], [Effect::ResolveContacts(ids), Effect::Emit(LobbyUpdate::AutoJoinChannels(_))] if ids == &[42])
        );
        let effects = state.contacts_resolved(vec![(42, "OfflineName".into())]);
        assert!(
            matches!(&effects[..], [Effect::Emit(LobbyUpdate::Relations { friends, .. })] if friends == &["OfflineName"])
        );
        let effects = feed(
            &mut state,
            json!({"command":"player_info", "players":[{"id":42,"login":"Renamed"}]}),
        );
        assert!(effects.iter().any(|effect| matches!(effect, Effect::Emit(LobbyUpdate::Relations { friends, .. }) if friends == &["Renamed"])));
        state.outgoing(&ClientMessage::Relation {
            player_id: 42,
            relation: Relation::Foe,
            member: true,
        });
        feed(
            &mut state,
            json!({"command":"player_info", "players":[{"id":99,"login":"Other"}]}),
        );
        assert_eq!(
            state.directory.relations(),
            (vec![], vec!["Renamed".to_string()])
        );
    }

    #[test]
    fn session_fold_rejections_stop_after_the_user_facing_update() {
        let mut state = SessionState::default();
        assert!(matches!(
            &state.incoming(ServerMessage::AuthenticationFailed {
                reason: "refused".into()
            })[..],
            [
                Effect::Emit(LobbyUpdate::ConnectionRejected { .. }),
                Effect::Stop { hopeless: false }
            ]
        ));
        assert!(
            matches!(&state.incoming(ServerMessage::Invalid { text:None })[..], [Effect::Emit(LobbyUpdate::ConnectionRejected { reason }), Effect::Stop { hopeless:false }] if reason.contains("sign-in"))
        );
    }
    #[test]
    fn contacts_preserve_unresolved_ids_and_never_turn_lookups_into_online_profiles() {
        let mut directory = super::PlayerDirectory::default();
        directory.set_relations(&social(serde_json::json!({ "friends": [7], "foes": [99] })));
        let before = directory.contacts();
        assert_eq!(before.len(), 2);
        assert!(before.iter().all(|contact| contact.login.is_none()));
        directory.record_login(7, "Offline".into());
        let after = directory.contacts();
        assert_eq!(after[0].login.as_deref(), Some("Offline"));
        assert!(directory.profiles.is_empty());
        directory.note_local_relation(&relation_frame(99, faf_domain::state::Relation::Foe, false));
        // A lookup completing after removal must not put the contact back.
        directory.record_login(99, "Removed".into());
        assert_eq!(directory.contacts().len(), 1);
        let frame = directory.contact_relation_message(
            faf_domain::state::Contact {
                player_id: 42,
                login: Some("NewOffline".into()),
                relation: faf_domain::state::Relation::Friend,
            },
            true,
        );
        directory.note_local_relation(&frame);
        assert_eq!(
            frame.to_value(),
            serde_json::json!({ "command": "social_add", "friend": 42 })
        );
        assert!(directory
            .contacts()
            .iter()
            .any(|contact| contact.login.as_deref() == Some("NewOffline")));
        assert!(directory.profiles.is_empty());
        directory.record_login(42, "Renamed".into());
        directory.contact_relation_message(
            faf_domain::state::Contact {
                player_id: 42,
                login: Some("Stale".into()),
                relation: faf_domain::state::Relation::Friend,
            },
            true,
        );
        assert_eq!(directory.login(42).as_deref(), Some("Renamed"));
        directory.observe(&player(
            serde_json::json!({ "id": 42, "login": "LiveName" }),
        ));
        directory.record_login(42, "StaleLookup".into());
        assert_eq!(directory.login(42).as_deref(), Some("LiveName"));
    }

    /// One `player_info` entry, read the way the session receives it.
    fn player(value: Value) -> PlayerEntry {
        PlayerEntry::decode(&value)
    }

    /// A `social` message, likewise.
    fn social(value: Value) -> SocialLists {
        SocialLists::decode(&value)
    }

    /// The message `set_contact_relation` puts on the outgoing queue.
    fn relation_frame(player_id: i32, relation: Relation, member: bool) -> ClientMessage {
        ClientMessage::Relation {
            player_id,
            relation,
            member,
        }
    }

    #[test]
    fn directory_reports_only_profiles_that_are_new_or_changed() {
        // `player_info` repeats every online player at login and then keeps
        // arriving; re-emitting unchanged profiles would flood the UI.
        let mut directory = PlayerDirectory::default();
        assert_eq!(
            directory
                .observe(&player(json!({ "id": 1, "login": "Aurora" })))
                .map(|p| p.login),
            Some("Aurora".to_string())
        );
        assert_eq!(
            directory.observe(&player(json!({ "id": 1, "login": "Aurora" }))),
            None
        );
        // A rename under the same id is a change.
        assert_eq!(
            directory
                .observe(&player(json!({ "id": 1, "login": "Aurora_" })))
                .map(|p| p.login),
            Some("Aurora_".to_string())
        );
        // So is gaining an avatar.
        assert_eq!(
            directory
                .observe(&player(json!({
                    "id": 1,
                    "login": "Aurora_",
                    "avatar": { "url": "https://x/a.png", "tooltip": "Cat" },
                })))
                .map(|p| p.avatar_url),
            Some("https://x/a.png".to_string())
        );
    }

    #[test]
    fn directory_reads_country_clan_and_avatar() {
        let mut directory = PlayerDirectory::default();
        let profile = directory
            .observe(&player(json!({
                "id": 7,
                "login": "Stormlord",
                // The server sends the country uppercased; flag assets are lowercase.
                "country": "DE",
                "clan": "BC",
                "avatar": { "url": "https://content/a.png", "tooltip": "Aeon" },
                "ratings": {
                    "global": { "rating": [1800, 200], "number_of_games": 374 },
                    "ladder_1v1": { "rating": [1500, 100], "number_of_games": "42" }
                },
            })))
            .unwrap();
        assert_eq!(profile.country, "de");
        assert_eq!(profile.clan, "BC");
        assert_eq!(profile.avatar_url, "https://content/a.png");
        assert_eq!(profile.avatar_tooltip, "Aeon");
        assert_eq!(profile.global_rating, 1200);
        assert_eq!(
            profile.ratings,
            vec![
                PlayerLobbyRating {
                    leaderboard: "global".into(),
                    rating: 1200,
                    mean: 1800,
                    deviation: 200,
                    games_played: 374,
                },
                PlayerLobbyRating {
                    leaderboard: "ladder_1v1".into(),
                    rating: 1200,
                    mean: 1500,
                    deviation: 100,
                    games_played: 42,
                },
            ]
        );

        assert_eq!(
            directory.observe(&player(json!({
                "id": 7,
                "login": "Stormlord",
                "country": "DE",
                "clan": "BC",
                "avatar": { "url": "https://content/a.png", "tooltip": "Aeon" },
            }))),
            None,
            "a partial update must retain the last known rating"
        );
    }

    #[test]
    fn directory_tolerates_a_null_avatar_and_missing_country() {
        let mut directory = PlayerDirectory::default();
        let profile = directory
            .observe(&player(
                json!({ "id": 8, "login": "Aurora", "avatar": Value::Null }),
            ))
            .unwrap();
        assert_eq!(profile.country, "");
        assert_eq!(profile.clan, "");
        assert_eq!(profile.avatar_url, "");
    }

    #[test]
    fn directory_ignores_entries_without_an_id_or_login() {
        let mut directory = PlayerDirectory::default();
        assert_eq!(
            directory.observe(&player(json!({ "login": "Aurora" }))),
            None
        );
        assert_eq!(directory.observe(&player(json!({ "id": 7 }))), None);
        assert_eq!(
            directory.observe(&player(json!({ "id": 7, "login": "" }))),
            None
        );
    }

    #[test]
    fn directory_offline_removal_is_authoritative_and_idempotent() {
        let mut directory = PlayerDirectory::default();
        directory.set_relations(&social(json!({ "friends": [7], "foes": [] })));
        directory
            .observe(&player(
                json!({ "id": 7, "login": "Aurora", "country": "DE" }),
            ))
            .unwrap();

        let removed = directory
            .remove(&player(
                json!({ "id": 7, "login": "Aurora", "state": "offline" }),
            ))
            .unwrap();
        assert_eq!(removed.login, "Aurora");
        assert_eq!(removed.country, "de");
        assert_eq!(directory.login(7).as_deref(), Some("Aurora"));
        assert_eq!(directory.relations().0, vec!["Aurora"]);
        assert!(directory
            .remove(&player(
                json!({ "id": 7, "login": "Aurora", "state": "offline" })
            ))
            .is_none());
    }

    #[test]
    fn a_player_a_game_seats_comes_back_after_a_false_offline_notice() {
        // #595: a re-login's old connection is broadcast offline after the
        // new one registered. The player is still online, and a game lists
        // them; their profile and ratings come back from what was kept.
        let mut directory = PlayerDirectory::default();
        directory
            .observe(&player(json!({
                "id": 480156, "login": "OGlobal2500lader", "country": "DE",
                "ratings": { "global": { "rating": [2016.0, 95.0], "number_of_games": 4200 } }
            })))
            .unwrap();
        directory
            .remove(&player(
                json!({ "id": 480156, "login": "OGlobal2500lader", "state": "offline" }),
            ))
            .unwrap();

        // Not seated anywhere: stays gone.
        assert!(directory
            .restore_seated(["Somebody"].into_iter())
            .is_empty());

        let restored = directory.restore_seated(["oglobal2500lader"].into_iter());
        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0].country, "de");
        let mut ratings = PlayerRatings::new();
        restore_player_ratings(&mut ratings, &restored[0]);
        assert_eq!(ratings["OGlobal2500lader"]["global"], 1731);

        // Once only: the profile is back in the directory.
        assert!(directory
            .restore_seated(["OGlobal2500lader"].into_iter())
            .is_empty());
    }

    #[test]
    fn a_player_seen_again_is_no_longer_waiting_to_be_restored() {
        let mut directory = PlayerDirectory::default();
        directory
            .observe(&player(json!({ "id": 7, "login": "Aurora" })))
            .unwrap();
        directory
            .remove(&player(
                json!({ "id": 7, "login": "Aurora", "state": "offline" }),
            ))
            .unwrap();
        directory
            .observe(&player(json!({ "id": 7, "login": "Aurora" })))
            .unwrap();
        assert!(directory.departed.is_empty());
        assert!(directory.restore_seated(["Aurora"].into_iter()).is_empty());
    }

    #[test]
    fn a_relation_the_user_sets_survives_the_next_player_info() {
        // The report: adding a foe made them a friend, removing a friend put
        // them back, and adding a friend held for a moment and vanished. All
        // three are this re-broadcast, which used to replay the login state.
        let mut directory = PlayerDirectory::default();
        directory.record_login(7, "Aurora".into());
        directory.record_login(9, "Nomander".into());
        directory.set_relations(&social(json!({ "friends": [7], "foes": [] })));

        directory.note_local_relation(&relation_frame(7, Relation::Foe, true));
        assert_eq!(directory.relations(), (vec![], vec!["Aurora".to_string()]));

        directory.note_local_relation(&relation_frame(9, Relation::Friend, true));
        assert_eq!(
            directory.relations(),
            (vec!["Nomander".to_string()], vec!["Aurora".to_string()])
        );

        directory.note_local_relation(&relation_frame(9, Relation::Friend, false));
        assert_eq!(directory.relations(), (vec![], vec!["Aurora".to_string()]));

        // Anything else on the outgoing channel leaves the lists alone.
        directory.note_local_relation(&ClientMessage::GameJoin {
            uid: 7,
            password: None,
        });
        assert_eq!(directory.relations(), (vec![], vec!["Aurora".to_string()]));
    }

    #[test]
    fn relations_resolve_ids_that_arrive_after_the_social_message() {
        // `social` routinely lands before the `player_info` naming those ids.
        let mut directory = PlayerDirectory::default();
        directory.set_relations(&social(json!({ "friends": [2, 3], "foes": [4] })));
        assert_eq!(directory.relations(), (vec![], vec![]));

        directory.observe(&player(json!({ "id": 2, "login": "Stormlord" })));
        directory.observe(&player(json!({ "id": 4, "login": "Griefer" })));
        assert_eq!(
            directory.relations(),
            (vec!["Stormlord".to_string()], vec!["Griefer".to_string()])
        );

        directory.observe(&player(json!({ "id": 3, "login": "Sheikah" })));
        assert_eq!(
            directory.relations().0,
            vec!["Stormlord".to_string(), "Sheikah".to_string()]
        );
    }

    /// A friend renamed while this client runs: the lists are kept by id, so
    /// the next `player_info` moves the friend to the new name, and the lists
    /// read differently afterwards, which is what has them sent again (#516).
    #[test]
    fn a_renamed_friend_stays_a_friend_under_the_new_name() {
        let mut directory = PlayerDirectory::default();
        directory.set_relations(&social(json!({ "friends": [2], "foes": [4] })));
        directory.observe(&player(json!({ "id": 2, "login": "Stormlord" })));
        directory.observe(&player(json!({ "id": 4, "login": "Griefer" })));
        let before = directory.relations();

        directory.observe(&player(json!({ "id": 2, "login": "StormlordTheSecond" })));
        directory.observe(&player(json!({ "id": 4, "login": "Reformed" })));
        let after = directory.relations();

        assert_eq!(
            after,
            (
                vec!["StormlordTheSecond".to_string()],
                vec!["Reformed".to_string()]
            )
        );
        assert_ne!(after, before, "a rename has to re-send the lists");
    }

    #[test]
    fn relation_ids_are_accepted_as_numbers_or_strings() {
        let mut directory = PlayerDirectory::default();
        directory.set_relations(&social(
            json!({ "friends": [2, "3", "not-a-number"], "foes": [] }),
        ));
        directory.observe(&player(json!({ "id": 2, "login": "Stormlord" })));
        directory.observe(&player(json!({ "id": 3, "login": "Sheikah" })));
        assert_eq!(
            directory.relations().0,
            vec!["Stormlord".to_string(), "Sheikah".to_string()]
        );
    }

    #[test]
    fn a_social_message_without_relations_is_not_treated_as_having_any() {
        let mut directory = PlayerDirectory::default();
        assert!(!directory.has_relations());
        directory.set_relations(&social(
            json!({ "command": "social", "autojoin": ["#aeolus"] }),
        ));
        assert!(!directory.has_relations());
    }

    fn open_game_json(uid: i32, state: &str, players: i32) -> Value {
        json!({
            "command": "game_info",
            "uid": uid,
            "state": state,
            "num_players": players,
            "max_players": 8,
            "title": format!("Game {uid}"),
            "host": "Stormlord",
            "mapname": "Theta Passage",
            "launched_at": 1_700_000_000.4,
        })
    }

    #[test]
    fn computes_average_rating_from_player_info_and_ignores_observers() {
        let mut ratings = PlayerRatings::new();
        update_player_ratings(
            &mut ratings,
            &player(json!({
                "login": "Alpha",
                "ratings": { "global": { "rating": [1800, 200] } }
            })),
        );
        update_player_ratings(
            &mut ratings,
            &player(json!({
                "login": "Bravo",
                "ratings": { "global": { "rating": [1700, 100] } }
            })),
        );
        update_player_ratings(
            &mut ratings,
            &player(json!({
                "login": "Spectator",
                "ratings": { "global": { "rating": [2500, 0] } }
            })),
        );

        let mut message = open_game_json(43, "open", 3);
        message["teams"] = json!({
            "1": ["Alpha"],
            "2": ["Bravo"],
            "-1": ["Spectator"]
        });
        let game = games_in(&message)
            .pop()
            .unwrap()
            .into_game(&ratings)
            .unwrap();

        // Alpha = 1200 and Bravo = 1400; observer is excluded.
        assert_eq!(game.average_rating, 1300);
    }

    #[test]
    fn accepts_legacy_player_rating_field() {
        let mut ratings = PlayerRatings::new();
        update_player_ratings(
            &mut ratings,
            &player(json!({ "login": "Legacy", "global_rating": 1234 })),
        );
        assert_eq!(ratings["Legacy"][GLOBAL_LEADERBOARD], 1234);
    }

    #[test]
    fn averages_a_matchmaker_game_over_the_queue_it_is_rated_on() {
        // The reported case: a 1v1 ladder game listing global ratings, which
        // are the numbers the game is not being played for.
        let mut ratings = PlayerRatings::new();
        update_player_ratings(
            &mut ratings,
            &player(json!({
                "login": "Valkyra",
                "ratings": {
                    "global": { "rating": [1100, 98] },
                    "ladder_1v1": { "rating": [662, 65] },
                }
            })),
        );
        update_player_ratings(
            &mut ratings,
            &player(json!({
                "login": "Rival",
                "ratings": {
                    "global": { "rating": [1600, 200] },
                    "ladder_1v1": { "rating": [1000, 100] },
                }
            })),
        );

        let mut message = open_game_json(44, "playing", 2);
        message["rating_type"] = json!("ladder_1v1");
        message["teams"] = json!({ "2": ["Valkyra"], "3": ["Rival"] });
        let game = games_in(&message)
            .pop()
            .unwrap()
            .into_game(&ratings)
            .unwrap();

        assert_eq!(game.rating_type, "ladder_1v1");
        // Ladder: 467 and 700, not global's 806 and 1000. 583.5 rounds up,
        // the way the server's own average does when it sends one.
        assert_eq!(game.average_rating, 584);
    }

    #[test]
    fn a_game_without_a_rating_type_is_a_global_one() {
        let mut ratings = PlayerRatings::new();
        update_player_ratings(
            &mut ratings,
            &player(
                json!({ "login": "Alpha", "ratings": { "global": { "rating": [1800, 200] } } }),
            ),
        );
        let mut message = open_game_json(45, "open", 1);
        message["teams"] = json!({ "1": ["Alpha"] });
        let game = games_in(&message)
            .pop()
            .unwrap()
            .into_game(&ratings)
            .unwrap();

        assert_eq!(game.rating_type, GLOBAL_LEADERBOARD);
        assert_eq!(game.average_rating, 1200);
    }

    #[test]
    fn a_partial_player_info_does_not_erase_the_ratings_already_known() {
        let mut ratings = PlayerRatings::new();
        update_player_ratings(
            &mut ratings,
            &player(json!({
                "login": "Alpha",
                "ratings": { "ladder_1v1": { "rating": [900, 100] } }
            })),
        );
        update_player_ratings(
            &mut ratings,
            &player(json!({ "login": "Alpha", "country": "de" })),
        );
        assert_eq!(ratings["Alpha"]["ladder_1v1"], 600);
    }

    #[test]
    fn gameset_adds_open_and_removes_closed() {
        let mut set = GameSet::default();
        for raw in games_in(&open_game_json(1, "open", 1)) {
            set.apply(raw, &PlayerRatings::new(), &mut GameDelta::default());
        }
        for raw in games_in(&open_game_json(2, "open", 2)) {
            set.apply(raw, &PlayerRatings::new(), &mut GameDelta::default());
        }
        assert_eq!(set.snapshot().len(), 2);

        // Game 1 transitions to playing → drops out of the open list.
        for raw in games_in(&open_game_json(1, "playing", 2)) {
            set.apply(raw, &PlayerRatings::new(), &mut GameDelta::default());
        }
        let snap = set.snapshot();
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0].id, 2); // ordered by id
    }

    #[test]
    fn gameset_update_replaces_in_place() {
        let mut set = GameSet::default();
        for raw in games_in(&open_game_json(5, "open", 1)) {
            set.apply(raw, &PlayerRatings::new(), &mut GameDelta::default());
        }
        for raw in games_in(&open_game_json(5, "open", 4)) {
            set.apply(raw, &PlayerRatings::new(), &mut GameDelta::default());
        }
        let snap = set.snapshot();
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0].players, 4);
    }

    #[test]
    fn gameset_ignores_forming_matchmaker_games_until_playing() {
        let mut set = GameSet::default();
        let forming_mm = json!({
            "command": "game_info",
            "uid": 99,
            "title": "Team DietTaco Vs Team Balde",
            "state": "open",
            "game_type": "matchmaker",
            "num_players": 4,
            "max_players": 6,
        });
        for raw in games_in(&forming_mm) {
            set.apply(raw, &PlayerRatings::new(), &mut GameDelta::default());
        }
        assert_eq!(set.snapshot().len(), 0);
        assert_eq!(set.snapshot_live().len(), 0);

        let playing_mm = json!({
            "command": "game_info",
            "uid": 99,
            "title": "Team DietTaco Vs Team Balde",
            "state": "playing",
            "game_type": "matchmaker",
            "num_players": 6,
            "max_players": 6,
        });
        for raw in games_in(&playing_mm) {
            set.apply(raw, &PlayerRatings::new(), &mut GameDelta::default());
        }
        assert_eq!(set.snapshot().len(), 0);
        assert_eq!(set.snapshot_live().len(), 1);
    }
}
