//! Inert tournament backend: used offline, in tests, and in CI.
//!
//! Writable rather than read-only, and for a sharper reason than the Challonge
//! fake had: this client is for *players*, and everything a player does here is
//! a write. A fake that only answered `list` would leave entering an event,
//! checking in, reporting a series and confirming an opponent's score with no
//! way to be developed or tested at all.
//!
//! It is not a reimplementation of the service. It keeps the parts the client's
//! own flow turns on: an entrant appears, a team checks in, a submitted score
//! waits for the other side, and a confirmed one advances the winner along
//! `winner_to`. It approximates the rest. Seeding, rating gates, vetoes and
//! draft order are the server's business, and anything that depends on their
//! exact behaviour has to be checked against a real instance.

use std::collections::HashMap;
use std::sync::Mutex;

use async_trait::async_trait;
use faf_domain::state::{
    Article, BracketKind, BracketSide, ChatPost, ChatRoom, Competition, Formation, HostingStatus,
    MapPool, MatchLink, MatchReport, MatchStatus, PendingReport, PoolAssignment, PoolDraft,
    InviteStatus, NewsPost, RatingGate, SeedOrder, TeamRequest, Tourney, TourneyCategory,
    TourneyDraft, TourneyInvite, TourneyMap, TourneyMatch, TourneyPhase, TourneyPlayer,
    TourneyStatus, TourneyTeam, TourneyViewer,
};

use crate::ports::{RequestError, TourneyPort};

/// Whoever is signed in offline. Fixed, because the fake stands in for the
/// server's session and the client must not be able to claim another identity.
const ME_FAF_ID: i32 = 101;
const ME_NAME: &str = "Nuggets";

/// One tournament plus the conversations hanging off it.
struct FakeEvent {
    event: Tourney,
    /// Room id to its posts.
    chat: HashMap<String, Vec<ChatPost>>,
    next_id: u32,
}

impl FakeEvent {
    fn handle(&mut self, prefix: &str) -> String {
        self.next_id += 1;
        format!("{prefix}{:04}", self.next_id)
    }

    fn entry_mut(&mut self, match_id: &str) -> Result<&mut TourneyMatch, RequestError> {
        self.event
            .matches
            .iter_mut()
            .find(|entry| entry.id == match_id)
            .ok_or_else(|| RequestError::not_found("That match is not in this tournament."))
    }

    /// Apply a decided series: record it, and send both sides where the graph
    /// says they go.
    ///
    /// Following `winner_to` rather than recomputing a tree is the whole point
    /// of the bracket being an explicit graph, and it means the fake advances
    /// entrants exactly the way the real server does.
    fn finalise(&mut self, match_id: &str, score1: i32, score2: i32) {
        let Ok(entry) = self.entry_mut(match_id) else {
            return;
        };
        entry.score1 = Some(score1);
        entry.score2 = Some(score2);
        entry.pending_report = None;

        let needed = (entry.best_of + 1) / 2;
        if score1 < needed && score2 < needed {
            // Still being played: a 1-1 in a best of three.
            entry.status = MatchStatus::Live;
            return;
        }

        entry.status = MatchStatus::Done;
        let (winner, loser) = if score1 > score2 {
            (entry.team1.clone(), entry.team2.clone())
        } else {
            (entry.team2.clone(), entry.team1.clone())
        };
        entry.winner = winner.clone();
        entry.loser = loser.clone();
        let onward = [
            (entry.winner_to.clone(), winner),
            (entry.loser_to.clone(), loser.clone()),
        ];

        for (link, team) in onward {
            let (Some(link), Some(team)) = (link, team) else {
                continue;
            };
            let Ok(destination) = self.entry_mut(&link.match_id) else {
                continue;
            };
            if link.slot == 2 {
                destination.team2 = Some(team);
            } else {
                destination.team1 = Some(team);
            }
            if destination.team1.is_some() && destination.team2.is_some() {
                destination.status = MatchStatus::Ready;
            }
        }

        // Nowhere left to send the winner: that was the final.
        if let Ok(entry) = self.entry_mut(match_id) {
            if entry.winner_to.is_none() {
                self.event.champion_team_id = self.event.matches
                    .iter()
                    .find(|m| m.id == match_id)
                    .and_then(|m| m.winner.clone());
                self.event.status = TourneyStatus::Finished;
            }
        }
        if let Some(team) = self.event.teams.iter_mut().find(|t| Some(&t.id) == loser.as_ref()) {
            team.eliminated = true;
        }
    }
}

pub struct FakeTourney {
    events: Mutex<Vec<FakeEvent>>,
    articles: Vec<Article>,
    next_event: Mutex<u32>,
}

impl Default for FakeTourney {
    fn default() -> Self {
        Self::new()
    }
}

impl FakeTourney {
    pub fn new() -> Self {
        Self {
            events: Mutex::new(vec![
                signup_event(),
                duo_event(),
                running_event(),
                spectator_event(),
            ]),
            articles: articles(),
            next_event: Mutex::new(0),
        }
    }

    fn with_event<T>(
        &self,
        tournament_id: &str,
        act: impl FnOnce(&mut FakeEvent) -> Result<T, RequestError>,
    ) -> Result<T, RequestError> {
        let mut events = self.events.lock().expect("fake tournaments poisoned");
        let event = events
            .iter_mut()
            .find(|held| held.event.id == tournament_id)
            .ok_or_else(|| RequestError::not_found("That tournament no longer exists."))?;
        act(event)
    }
}

#[async_trait]
impl TourneyPort for FakeTourney {
    async fn hosting(&self) -> Result<HostingStatus, RequestError> {
        // Allowed offline, because the alternative is a create button nobody
        // can press and a feature nobody can develop.
        Ok(HostingStatus {
            logged_in: true,
            allowed: true,
            pending: false,
        })
    }

    async fn create(&self, draft: &TourneyDraft) -> Result<String, RequestError> {
        if draft.name.trim().is_empty() {
            return Err(RequestError::rejected("Name required"));
        }
        let id = {
            let mut counter = self.next_event.lock().expect("fake tournaments poisoned");
            *counter += 1;
            format!("new{:03}", *counter)
        };
        let mut event = empty_event(&id, draft.name.trim(), TourneyStatus::Signup);
        apply(&mut event, draft);
        event.category = draft.category;
        event.competition = draft.competition;
        event.formation = draft.effective_formation();
        event.bracket_kind = draft.bracket_kind;
        event.team_size = draft.team_size.clamp(1, 6);
        self.events
            .lock()
            .expect("fake tournaments poisoned")
            .push(FakeEvent {
                event,
                chat: HashMap::new(),
                next_id: 100,
            });
        Ok(id)
    }

    async fn edit_info(
        &self,
        tournament_id: &str,
        draft: &TourneyDraft,
    ) -> Result<(), RequestError> {
        self.with_event(tournament_id, |held| {
            if draft.name.trim().is_empty() {
                return Err(RequestError::rejected("Name required"));
            }
            apply(&mut held.event, draft);
            Ok(())
        })
    }

    async fn publish(&self, tournament_id: &str) -> Result<(), RequestError> {
        // Nothing to model: the fake never hides an event from its own list, so
        // publishing has to succeed and change nothing visible.
        self.with_event(tournament_id, |_| Ok(()))
    }

    async fn advance(
        &self,
        tournament_id: &str,
        phase: TourneyPhase,
    ) -> Result<(), RequestError> {
        self.with_event(tournament_id, |held| {
            if !phase.is_legal_from(held.event.status) {
                return Err(RequestError::rejected(match phase {
                    TourneyPhase::FormTeams => "Teams already formed",
                    TourneyPhase::StartBracket => "Form teams first",
                    TourneyPhase::ReopenSignups => "Bracket already started",
                }));
            }
            match phase {
                TourneyPhase::FormTeams => {
                    if held.event.players.len() < 2 {
                        return Err(RequestError::rejected("Need at least 2 players"));
                    }
                    form_teams(&mut held.event);
                    held.event.status = TourneyStatus::Drafted;
                }
                TourneyPhase::StartBracket => {
                    if held.event.teams.len() < 2 {
                        return Err(RequestError::rejected("Need at least 2 teams"));
                    }
                    draw_bracket(&mut held.event);
                    held.event.status = TourneyStatus::Running;
                }
                TourneyPhase::ReopenSignups => {
                    held.event.teams.clear();
                    held.event.matches.clear();
                    held.event.team_count = 0;
                    for player in &mut held.event.players {
                        player.team_id = None;
                    }
                    held.event.viewer.member_team_id = None;
                    held.event.status = TourneyStatus::Signup;
                }
            }
            Ok(())
        })
    }

    async fn archive(&self, tournament_id: &str) -> Result<(), RequestError> {
        let mut events = self.events.lock().expect("fake tournaments poisoned");
        let before = events.len();
        events.retain(|held| held.event.id != tournament_id);
        if events.len() == before {
            return Err(RequestError::not_found("That tournament no longer exists."));
        }
        Ok(())
    }

    async fn list(&self) -> Result<Vec<Tourney>, RequestError> {
        let events = self.events.lock().expect("fake tournaments poisoned");
        Ok(events
            .iter()
            .map(|held| {
                // The list endpoint sends counts and no people, and the client
                // has to keep working when that is all it gets.
                Tourney {
                    players: Vec::new(),
                    teams: Vec::new(),
                    matches: Vec::new(),
                    viewer: TourneyViewer::default(),
                    ..held.event.clone()
                }
            })
            .collect())
    }

    async fn detail(&self, tournament_id: &str) -> Result<Tourney, RequestError> {
        self.with_event(tournament_id, |held| Ok(held.event.clone()))
    }

    async fn sign_up(&self, tournament_id: &str) -> Result<(), RequestError> {
        self.with_event(tournament_id, |held| {
            if held.event.status != TourneyStatus::Signup {
                return Err(RequestError::rejected("Signups are closed"));
            }
            if held.event.viewer.is_signed_up() {
                return Err(RequestError::rejected("You are already signed up"));
            }
            let player_id = held.handle("p");
            // No team. The server never makes one at signup: a solo event's
            // teams are formed at the phase change, and a team event's by the
            // players themselves. Handing out a team here is what hid the dead
            // end a 2v2 entrant used to walk into.
            held.event.players.push(TourneyPlayer {
                id: player_id.clone(),
                name: ME_NAME.into(),
                faf_id: Some(ME_FAF_ID),
                rating: Some(1_640),
                rating_actual: Some(1_640),
                team_id: None,
                manual: false,
                late: false,
                pending: false,
                signed_at: Some(1_785_100_000),
                note: String::new(),
            });
            held.event.player_count = held.event.players.len() as i32;
            held.event.viewer.signed_up_player_id = Some(player_id);
            Ok(())
        })
    }

    async fn withdraw(&self, tournament_id: &str, player_id: &str) -> Result<(), RequestError> {
        self.with_event(tournament_id, |held| {
            if held.event.status != TourneyStatus::Signup {
                return Err(RequestError::rejected(
                    "Ask the organiser to remove you: the bracket has already been drawn.",
                ));
            }
            // Withdrawing takes the entry out of any team it had reached, the
            // same cleanup the server does, or the team keeps a ghost slot that
            // reads as full and that nobody can take.
            if let Some(team_id) = held
                .event
                .players
                .iter()
                .find(|player| player.id == player_id)
                .and_then(|player| player.team_id.clone())
            {
                leave(&mut held.event, player_id, &team_id);
            }
            held.event.players.retain(|player| player.id != player_id);
            for team in &mut held.event.teams {
                team.join_requests.retain(|ask| ask.player_id != player_id);
                team.invites.retain(|invite| invite.player_id != player_id);
            }
            held.event.player_count = held.event.players.len() as i32;
            held.event.team_count = held.event.teams.len() as i32;
            held.event.viewer.signed_up_player_id = None;
            held.event.viewer.member_team_id = None;
            Ok(())
        })
    }

    async fn create_team(&self, tournament_id: &str, name: &str) -> Result<(), RequestError> {
        self.with_event(tournament_id, |held| {
            let Some(me) = held.event.viewer.signed_up_player_id.clone() else {
                return Err(RequestError::rejected("Sign up first, then create a team"));
            };
            if held.event.viewer.member_team_id.is_some() {
                return Err(RequestError::rejected("Leave your current team first"));
            }
            let name = name.trim();
            if name.is_empty() {
                return Err(RequestError::rejected("Team name required"));
            }
            if held
                .event
                .teams
                .iter()
                .any(|team| team.name.eq_ignore_ascii_case(name))
            {
                return Err(RequestError::rejected("That team name is taken"));
            }
            let team_id = held.handle("t");
            held.event.teams.push(TourneyTeam {
                id: team_id.clone(),
                name: name.to_string(),
                seed: 0,
                captain_id: Some(me.clone()),
                player_ids: vec![me.clone()],
                division: 0,
                checked_in: false,
                eliminated: false,
                final_rank: None,
                join_requests: Vec::new(),
                invites: Vec::new(),
            });
            join(&mut held.event, &me, &team_id);
            Ok(())
        })
    }

    async fn request_join(&self, tournament_id: &str, team_id: &str) -> Result<(), RequestError> {
        self.with_event(tournament_id, |held| {
            let Some(me) = held.event.viewer.signed_up_player_id.clone() else {
                return Err(RequestError::rejected("Sign up first"));
            };
            if held.event.viewer.member_team_id.is_some() {
                return Err(RequestError::rejected("Leave your current team first"));
            }
            let size = held.event.team_size;
            let name = held
                .event
                .player(&me)
                .map(|player| player.name.clone())
                .unwrap_or_default();
            let Some(team) = held.event.teams.iter_mut().find(|team| team.id == team_id) else {
                return Err(RequestError::rejected("Team not found"));
            };
            if i32::try_from(team.player_ids.len()).unwrap_or(i32::MAX) >= size {
                return Err(RequestError::rejected("That team is full"));
            }
            if team.join_requests.iter().any(|ask| ask.player_id == me) {
                return Ok(());
            }
            team.join_requests.push(TeamRequest {
                player_id: me,
                name,
                at: Some(1_785_400_000),
            });
            Ok(())
        })
    }

    async fn cancel_join(&self, tournament_id: &str, team_id: &str) -> Result<(), RequestError> {
        self.with_event(tournament_id, |held| {
            let me = held.event.viewer.signed_up_player_id.clone().unwrap_or_default();
            let Some(team) = held.event.teams.iter_mut().find(|team| team.id == team_id) else {
                return Err(RequestError::rejected("Team not found"));
            };
            team.join_requests.retain(|ask| ask.player_id != me);
            Ok(())
        })
    }

    async fn respond_join(
        &self,
        tournament_id: &str,
        team_id: &str,
        player_id: &str,
        accept: bool,
    ) -> Result<(), RequestError> {
        self.with_event(tournament_id, |held| {
            let size = held.event.team_size;
            let Some(team) = held.event.teams.iter_mut().find(|team| team.id == team_id) else {
                return Err(RequestError::rejected("Team not found"));
            };
            let Some(index) = team
                .join_requests
                .iter()
                .position(|ask| ask.player_id == player_id)
            else {
                return Err(RequestError::rejected("That request is no longer pending"));
            };
            team.join_requests.remove(index);
            if !accept {
                return Ok(());
            }
            if i32::try_from(team.player_ids.len()).unwrap_or(i32::MAX) >= size {
                return Err(RequestError::rejected("Your team is already full"));
            }
            team.player_ids.push(player_id.to_string());
            join(&mut held.event, player_id, team_id);
            Ok(())
        })
    }

    async fn invite_to_team(
        &self,
        tournament_id: &str,
        team_id: &str,
        player_id: &str,
    ) -> Result<(), RequestError> {
        self.with_event(tournament_id, |held| {
            let Some(target) = held.event.player(player_id).cloned() else {
                return Err(RequestError::rejected("Player not found"));
            };
            if target.team_id.is_some() {
                return Err(RequestError::rejected("That player is already on a team"));
            }
            let Some(team) = held.event.teams.iter_mut().find(|team| team.id == team_id) else {
                return Err(RequestError::rejected("Team not found"));
            };
            if team.invites.iter().any(|invite| invite.player_id == target.id) {
                return Ok(());
            }
            team.invites.push(TeamRequest {
                player_id: target.id,
                name: target.name,
                at: Some(1_785_400_000),
            });
            Ok(())
        })
    }

    async fn respond_invite(
        &self,
        tournament_id: &str,
        team_id: &str,
        accept: bool,
    ) -> Result<(), RequestError> {
        self.with_event(tournament_id, |held| {
            let Some(me) = held.event.viewer.signed_up_player_id.clone() else {
                return Err(RequestError::rejected("Sign up first"));
            };
            let size = held.event.team_size;
            let Some(team) = held.event.teams.iter_mut().find(|team| team.id == team_id) else {
                return Err(RequestError::rejected("Team not found"));
            };
            let Some(index) = team.invites.iter().position(|invite| invite.player_id == me) else {
                return Err(RequestError::rejected("That invite is no longer available"));
            };
            team.invites.remove(index);
            if !accept {
                return Ok(());
            }
            if i32::try_from(team.player_ids.len()).unwrap_or(i32::MAX) >= size {
                return Err(RequestError::rejected("That team is now full"));
            }
            team.player_ids.push(me.clone());
            join(&mut held.event, &me, team_id);
            Ok(())
        })
    }

    async fn leave_team(&self, tournament_id: &str) -> Result<(), RequestError> {
        self.with_event(tournament_id, |held| {
            let (Some(me), Some(team_id)) = (
                held.event.viewer.signed_up_player_id.clone(),
                held.event.viewer.member_team_id.clone(),
            ) else {
                return Err(RequestError::rejected("You are not on a team"));
            };
            leave(&mut held.event, &me, &team_id);
            Ok(())
        })
    }

    async fn disband_team(&self, tournament_id: &str, team_id: &str) -> Result<(), RequestError> {
        self.with_event(tournament_id, |held| {
            if !held.event.teams.iter().any(|team| team.id == team_id) {
                return Err(RequestError::rejected("Team not found"));
            }
            let members: Vec<String> = held
                .event
                .team(team_id)
                .map(|team| team.player_ids.clone())
                .unwrap_or_default();
            for member in members {
                if let Some(player) = held.event.players.iter_mut().find(|held| held.id == member) {
                    player.team_id = None;
                }
                if held.event.viewer.signed_up_player_id.as_deref() == Some(member.as_str()) {
                    held.event.viewer.member_team_id = None;
                }
            }
            held.event.teams.retain(|team| team.id != team_id);
            held.event.team_count = held.event.teams.len() as i32;
            Ok(())
        })
    }

    async fn rename_team(
        &self,
        tournament_id: &str,
        team_id: &str,
        name: &str,
    ) -> Result<(), RequestError> {
        self.with_event(tournament_id, |held| {
            let name = name.trim();
            if name.is_empty() {
                return Err(RequestError::rejected("Team name required"));
            }
            if held
                .event
                .teams
                .iter()
                .any(|team| team.id != team_id && team.name.eq_ignore_ascii_case(name))
            {
                return Err(RequestError::rejected("That team name is taken"));
            }
            let Some(team) = held.event.teams.iter_mut().find(|team| team.id == team_id) else {
                return Err(RequestError::rejected("Team not found"));
            };
            team.name = name.to_string();
            Ok(())
        })
    }


    async fn add_player(
        &self,
        tournament_id: &str,
        name: &str,
        rating: Option<i32>,
    ) -> Result<(), RequestError> {
        self.with_event(tournament_id, |held| {
            let name = name.trim();
            if name.is_empty() {
                return Err(RequestError::rejected("Enter a FAF name"));
            }
            if held.event.status != TourneyStatus::Signup {
                return Err(RequestError::rejected("Signups are closed"));
            }
            if held
                .event
                .players
                .iter()
                .any(|player| player.name.eq_ignore_ascii_case(name))
            {
                return Err(RequestError::rejected(format!("{name} is already signed up")));
            }
            let id = held.handle("p");
            held.event.players.push(TourneyPlayer {
                id,
                name: name.to_string(),
                // A real lookup would bring the account back; offline there is
                // none, and an entry without one is a case the tab must handle.
                faf_id: None,
                rating: rating.or(Some(1_500)),
                rating_actual: rating.or(Some(1_500)),
                team_id: None,
                manual: true,
                late: false,
                pending: false,
                signed_at: Some(1_785_400_000),
                note: String::new(),
            });
            held.event.player_count = held.event.players.len() as i32;
            Ok(())
        })
    }

    async fn respond_signup(
        &self,
        tournament_id: &str,
        player_id: &str,
        accept: bool,
    ) -> Result<(), RequestError> {
        self.with_event(tournament_id, |held| {
            let Some(player) = held
                .event
                .players
                .iter_mut()
                .find(|player| player.id == player_id && player.pending)
            else {
                return Err(RequestError::rejected("That request is no longer pending"));
            };
            if accept {
                player.pending = false;
            } else {
                held.event.players.retain(|player| player.id != player_id);
                held.event.player_count = held.event.players.len() as i32;
            }
            Ok(())
        })
    }

    async fn invite_player(&self, tournament_id: &str, name: &str) -> Result<(), RequestError> {
        self.with_event(tournament_id, |held| {
            let name = name.trim();
            if name.is_empty() {
                return Err(RequestError::rejected("Enter a FAF name"));
            }
            if held
                .event
                .invites
                .iter()
                .any(|invite| invite.name.eq_ignore_ascii_case(name))
            {
                return Err(RequestError::rejected(format!("{name} is already invited")));
            }
            held.next_id += 1;
            held.event.invites.push(TourneyInvite {
                faf_id: 900 + held.next_id as i32,
                name: name.to_string(),
                status: InviteStatus::Pending,
            });
            Ok(())
        })
    }

    async fn uninvite(&self, tournament_id: &str, faf_id: i32) -> Result<(), RequestError> {
        self.with_event(tournament_id, |held| {
            held.event.invites.retain(|invite| invite.faf_id != faf_id);
            Ok(())
        })
    }

    async fn reseed(&self, tournament_id: &str, order: &SeedOrder) -> Result<(), RequestError> {
        self.with_event(tournament_id, |held| {
            if held.event.status != TourneyStatus::Drafted {
                return Err(RequestError::rejected(
                    "Seeds can only be changed after teams are formed and before the bracket starts",
                ));
            }
            match order {
                SeedOrder::Randomise => {
                    // Reversed rather than shuffled: the fake has no clock and
                    // no randomness, and a deterministic reorder proves the
                    // round trip just as well.
                    held.event.teams.reverse();
                    for (index, team) in held.event.teams.iter_mut().enumerate() {
                        team.seed = index as i32 + 1;
                    }
                }
                SeedOrder::Explicit { team_ids } => {
                    if !order.is_complete(&held.event.teams) {
                        return Err(RequestError::rejected(
                            "Seed order must include every team exactly once",
                        ));
                    }
                    for (index, wanted) in team_ids.iter().enumerate() {
                        if let Some(team) =
                            held.event.teams.iter_mut().find(|team| &team.id == wanted)
                        {
                            team.seed = index as i32 + 1;
                        }
                    }
                    held.event.teams.sort_by_key(|team| team.seed);
                }
            }
            Ok(())
        })
    }

    async fn split_divisions(
        &self,
        tournament_id: &str,
        divisions: i32,
    ) -> Result<(), RequestError> {
        self.with_event(tournament_id, |held| {
            if held.event.status != TourneyStatus::Drafted {
                return Err(RequestError::rejected(
                    "Split into divisions after forming teams and before starting the bracket",
                ));
            }
            let count = divisions.clamp(1, 6);
            if count == 1 {
                for team in &mut held.event.teams {
                    team.division = 0;
                }
                held.event.divisions = 0;
                return Ok(());
            }
            let per = held.event.teams.len().div_ceil(count as usize).max(1);
            for (index, team) in held.event.teams.iter_mut().enumerate() {
                team.division = ((index / per) as i32 + 1).min(count);
            }
            held.event.divisions = count;
            Ok(())
        })
    }

    async fn set_division(
        &self,
        tournament_id: &str,
        team_id: &str,
        division: i32,
    ) -> Result<(), RequestError> {
        self.with_event(tournament_id, |held| {
            let Some(team) = held.event.teams.iter_mut().find(|team| team.id == team_id) else {
                return Err(RequestError::rejected("Team not found"));
            };
            team.division = division.clamp(0, 6);
            Ok(())
        })
    }

    async fn post_news(
        &self,
        tournament_id: &str,
        body: &str,
        important: bool,
    ) -> Result<(), RequestError> {
        self.with_event(tournament_id, |held| {
            let body = body.trim();
            if body.is_empty() {
                return Err(RequestError::rejected("Write something first"));
            }
            let id = held.handle("nw");
            // Newest first, which is the order the server sorts them into.
            held.event.news.insert(
                0,
                NewsPost {
                    id,
                    body: body.to_string(),
                    by: ME_NAME.into(),
                    at: Some(1_785_400_000),
                    important,
                },
            );
            Ok(())
        })
    }

    async fn delete_news(&self, tournament_id: &str, news_id: &str) -> Result<(), RequestError> {
        self.with_event(tournament_id, |held| {
            held.event.news.retain(|post| post.id != news_id);
            Ok(())
        })
    }

    async fn check_in(&self, tournament_id: &str) -> Result<(), RequestError> {
        self.with_event(tournament_id, |held| {
            let Some(team_id) = held.event.viewer.member_team_id.clone() else {
                return Err(RequestError::rejected("Join a team first"));
            };
            let team = held
                .event
                .teams
                .iter_mut()
                .find(|team| team.id == team_id)
                .ok_or_else(|| RequestError::rejected("Team not found"))?;
            team.checked_in = true;
            Ok(())
        })
    }

    async fn submit_report(
        &self,
        tournament_id: &str,
        report: &MatchReport,
    ) -> Result<(), RequestError> {
        self.with_event(tournament_id, |held| {
            let Some(mine) = held.event.viewer.member_team_id.clone() else {
                return Err(RequestError::rejected(
                    "Only players in this match can submit its score",
                ));
            };
            let entry = held.entry_mut(&report.match_id)?;
            if entry.opponent_of(&mine).is_none() {
                return Err(RequestError::rejected(
                    "Only players in this match can submit its score",
                ));
            }
            let games = report.new_games(entry);
            if !report.is_submittable(entry) {
                return Err(RequestError::rejected(format!(
                    "Provide exactly {games} replay ID{}, one for each newly reported game",
                    if games == 1 { "" } else { "s" }
                )));
            }
            entry.pending_report = Some(PendingReport {
                score1: report.score1,
                score2: report.score2,
                by_team: mine,
                by_name: ME_NAME.into(),
                replay_ids: report.replay_ids.clone(),
                at: Some(1_785_400_000),
            });
            Ok(())
        })
    }

    async fn confirm_report(
        &self,
        tournament_id: &str,
        match_id: &str,
        accept: bool,
    ) -> Result<(), RequestError> {
        self.with_event(tournament_id, |held| {
            let entry = held.entry_mut(match_id)?;
            let pending = entry.pending_report.clone().ok_or_else(|| {
                RequestError::rejected("Nothing awaiting confirmation on this match")
            })?;
            if !accept {
                entry.pending_report = None;
                return Ok(());
            }
            held.finalise(match_id, pending.score1, pending.score2);
            Ok(())
        })
    }

    async fn decide_report(
        &self,
        tournament_id: &str,
        report: &MatchReport,
    ) -> Result<(), RequestError> {
        self.with_event(tournament_id, |held| {
            held.entry_mut(&report.match_id)?;
            held.finalise(&report.match_id, report.score1, report.score2);
            Ok(())
        })
    }

    async fn chat_rooms(&self, tournament_id: &str) -> Result<Vec<ChatRoom>, RequestError> {
        self.with_event(tournament_id, |held| {
            let mut rooms = vec![ChatRoom {
                id: "global".into(),
                name: "Global: everyone".into(),
                unread: 0,
            }];
            // A match gets a room once both sides are known, exactly as the
            // server decides it.
            for entry in &held.event.matches {
                let (Some(one), Some(two)) = (entry.team1.as_ref(), entry.team2.as_ref()) else {
                    continue;
                };
                rooms.push(ChatRoom {
                    id: entry.id.clone(),
                    name: format!(
                        "{} vs {}",
                        team_name(&held.event, one),
                        team_name(&held.event, two)
                    ),
                    unread: 0,
                });
            }
            Ok(rooms)
        })
    }

    async fn chat_read(
        &self,
        tournament_id: &str,
        room_id: &str,
    ) -> Result<Vec<ChatPost>, RequestError> {
        self.with_event(tournament_id, |held| {
            Ok(held.chat.get(room_id).cloned().unwrap_or_default())
        })
    }

    async fn chat_post(
        &self,
        tournament_id: &str,
        room_id: &str,
        body: &str,
    ) -> Result<(), RequestError> {
        self.with_event(tournament_id, |held| {
            if body.trim().is_empty() {
                return Err(RequestError::rejected("Empty message"));
            }
            let id = held.handle("c");
            held.chat.entry(room_id.to_string()).or_default().push(ChatPost {
                id,
                author: ME_NAME.into(),
                body: body.trim().to_string(),
                at: Some(1_785_400_000),
                system: false,
            });
            Ok(())
        })
    }

    async fn articles(&self) -> Result<Vec<Article>, RequestError> {
        Ok(self.articles.clone())
    }

    async fn assign_pool(
        &self,
        tournament_id: &str,
        round_key: &str,
        pool_id: &str,
    ) -> Result<(), RequestError> {
        self.with_event(tournament_id, |held| {
            held.event
                .pool_assign
                .retain(|assignment| assignment.round != round_key);
            if pool_id.is_empty() {
                return Ok(());
            }
            if !held.event.map_pools.iter().any(|pool| pool.id == pool_id) {
                return Err(RequestError::rejected("Pool not found"));
            }
            held.event.pool_assign.push(PoolAssignment {
                round: round_key.to_string(),
                pool_id: pool_id.to_string(),
            });
            Ok(())
        })
    }

    async fn save_pool(&self, tournament_id: &str, pool: &PoolDraft) -> Result<(), RequestError> {
        self.with_event(tournament_id, |held| {
            if pool.name.trim().is_empty() {
                return Err(RequestError::rejected("Pool name required"));
            }
            if let Some(existing) = held
                .event
                .map_pools
                .iter_mut()
                .find(|held| held.id == pool.id && !pool.id.is_empty())
            {
                existing.name = pool.name.clone();
                existing.map_ids = pool.map_ids.clone();
                existing.best_of = pool.best_of;
                return Ok(());
            }
            let id = held.handle("pool");
            held.event.map_pools.push(MapPool {
                id,
                name: pool.name.clone(),
                map_ids: pool.map_ids.clone(),
                sequence: Vec::new(),
                best_of: pool.best_of,
            });
            Ok(())
        })
    }
}

/// Put a player on a team, and drop their outstanding requests everywhere.
///
/// The server does the same tidying: once somebody has a team, every other
/// request and invite of theirs is moot and would otherwise linger as a place
/// nobody can take.
fn join(event: &mut Tourney, player_id: &str, team_id: &str) {
    if let Some(player) = event.players.iter_mut().find(|held| held.id == player_id) {
        player.team_id = Some(team_id.to_string());
    }
    for team in &mut event.teams {
        team.join_requests.retain(|ask| ask.player_id != player_id);
        team.invites.retain(|invite| invite.player_id != player_id);
    }
    if event.viewer.signed_up_player_id.as_deref() == Some(player_id) {
        event.viewer.member_team_id = Some(team_id.to_string());
    }
    event.team_count = event.teams.len() as i32;
}

/// Take a player off their team, dissolving it if they were the last out and
/// passing the armband on if they were the captain.
fn leave(event: &mut Tourney, player_id: &str, team_id: &str) {
    if let Some(team) = event.teams.iter_mut().find(|team| team.id == team_id) {
        team.player_ids.retain(|held| held != player_id);
        if team.captain_id.as_deref() == Some(player_id) {
            team.captain_id = team.player_ids.first().cloned();
        }
    }
    event.teams.retain(|team| !team.player_ids.is_empty());
    if let Some(player) = event.players.iter_mut().find(|held| held.id == player_id) {
        player.team_id = None;
    }
    if event.viewer.signed_up_player_id.as_deref() == Some(player_id) {
        event.viewer.member_team_id = None;
    }
    event.team_count = event.teams.len() as i32;
}

/// Copy a draft's settings onto an event.
fn apply(event: &mut Tourney, draft: &TourneyDraft) {
    event.name = draft.name.trim().to_string();
    event.description = draft.description.trim().to_string();
    event.player_reporting = draft.player_reporting;
    event.event_date = draft.event_date;
    event.signup_opens_at = draft.signup_opens_at;
    event.signup_closes_at = draft.signup_closes_at;
    event.rating = draft.rating.clone();
}

/// Put every entrant in a team of one, seeded by rating, as
/// `formTeamsGrouped` does for a solo event.
fn form_teams(event: &mut Tourney) {
    let mut entrants: Vec<TourneyPlayer> = event.players.clone();
    entrants.sort_by(|left, right| right.rating.cmp(&left.rating));
    event.teams = entrants
        .iter()
        .enumerate()
        .map(|(index, entrant)| TourneyTeam {
            id: format!("t{}", index + 1),
            name: String::new(),
            seed: index as i32 + 1,
            captain_id: Some(entrant.id.clone()),
            player_ids: vec![entrant.id.clone()],
            division: 0,
            checked_in: false,
            eliminated: false,
            final_rank: None,
            join_requests: Vec::new(),
            invites: Vec::new(),
        })
        .collect();
    let owners: Vec<(String, String)> = event
        .teams
        .iter()
        .map(|team| (team.id.clone(), team.player_ids[0].clone()))
        .collect();
    for (team_id, owner) in owners {
        if let Some(entrant) = event.players.iter_mut().find(|held| held.id == owner) {
            entrant.team_id = Some(team_id.clone());
        }
        if event.viewer.signed_up_player_id.as_deref() == Some(owner.as_str()) {
            event.viewer.member_team_id = Some(team_id);
        }
    }
    event.team_count = event.teams.len() as i32;
}

/// A single-elimination first round, seeded high against low, with the winners
/// linked into the next one. Enough of a bracket for the client's own flow to
/// be real; the server's byes and its exact seeding chart are its business.
fn draw_bracket(event: &mut Tourney) {
    let seeds: Vec<String> = event.teams.iter().map(|team| team.id.clone()).collect();
    let pairs = seeds.len() / 2;
    let mut matches = Vec::new();
    for index in 0..pairs {
        let mut first = entry(
            &format!("r1m{index}"),
            1,
            index as i32,
            (
                Some(seeds[index].as_str()),
                Some(seeds[seeds.len() - 1 - index].as_str()),
            ),
        );
        if pairs > 1 {
            first.winner_to = Some(MatchLink {
                match_id: format!("r2m{}", index / 2),
                slot: if index % 2 == 0 { 1 } else { 2 },
            });
        }
        matches.push(first);
    }
    for index in 0..(pairs / 2) {
        matches.push(entry(&format!("r2m{index}"), 2, index as i32, (None, None)));
    }
    event.matches = matches;
}

fn team_name(event: &Tourney, team_id: &str) -> String {
    event
        .team(team_id)
        .map(|team| team.display_name(&event.players))
        .unwrap_or_else(|| team_id.to_string())
}

/// An entrant who has not reached a team yet.
fn unteamed(id: &str, name: &str, faf_id: i32, rating: i32) -> TourneyPlayer {
    TourneyPlayer {
        team_id: None,
        ..player(id, name, faf_id, "", rating)
    }
}

fn player(id: &str, name: &str, faf_id: i32, team_id: &str, rating: i32) -> TourneyPlayer {
    TourneyPlayer {
        id: id.into(),
        name: name.into(),
        faf_id: Some(faf_id),
        rating: Some(rating),
        rating_actual: Some(rating),
        team_id: (!team_id.is_empty()).then(|| team_id.to_string()),
        manual: false,
        late: false,
        pending: false,
        signed_at: Some(1_785_100_000),
        note: String::new(),
    }
}

fn team(id: &str, seed: i32, player_id: &str) -> TourneyTeam {
    TourneyTeam {
        id: id.into(),
        name: String::new(),
        seed,
        captain_id: Some(player_id.into()),
        player_ids: vec![player_id.into()],
        division: 0,
        checked_in: false,
        eliminated: false,
        final_rank: None,
        join_requests: Vec::new(),
        invites: Vec::new(),
    }
}

fn entry(id: &str, round: i32, index: i32, teams: (Option<&str>, Option<&str>)) -> TourneyMatch {
    TourneyMatch {
        id: id.into(),
        bracket: BracketSide::Winners,
        round,
        index,
        best_of: 3,
        handicap: 0,
        division: 0,
        team1: teams.0.map(str::to_string),
        team2: teams.1.map(str::to_string),
        score1: None,
        score2: None,
        status: if teams.0.is_some() && teams.1.is_some() {
            MatchStatus::Ready
        } else {
            MatchStatus::Waiting
        },
        winner: None,
        loser: None,
        winner_to: None,
        loser_to: None,
        pending_report: None,
        replay_ids: Vec::new(),
    }
}

fn empty_event(id: &str, name: &str, status: TourneyStatus) -> Tourney {
    Tourney {
        id: id.into(),
        name: name.into(),
        status,
        category: TourneyCategory::Official,
        competition: Competition::Team,
        formation: Formation::Solo,
        team_size: 1,
        player_reporting: true,
        created_at: Some(1_785_000_000),
        organisers: vec!["Nuggets".into()],
        viewer: TourneyViewer {
            logged_in: true,
            faf_id: Some(ME_FAF_ID),
            faf_name: ME_NAME.into(),
            ..TourneyViewer::default()
        },
        ..Tourney::default()
    }
}

/// An event taking signups, so entering and withdrawing can be exercised.
fn signup_event() -> FakeEvent {
    let mut event = empty_event("e1a2b", "Weekend Ladder Cup", TourneyStatus::Signup);
    event.description =
        "A best-of-three 1v1 cup. Signups close on the Friday; check in on the day.".into();
    event.event_date = Some(1_787_421_600);
    event.signup_closes_at = Some(1_787_270_400);
    event.rating = RatingGate {
        min: Some(800),
        max: Some(2_200),
        ..RatingGate::default()
    };
    // Entrants with no team, which is what signups actually look like: teams
    // are formed later, by the organiser or by the players.
    event.players = vec![
        unteamed("p0001", "Ada", 102, 1_910),
        unteamed("p0002", "Grace", 103, 1_480),
    ];
    event.player_count = 2;
    event.map_db = vec![
        TourneyMap {
            id: "map1".into(),
            name: "Seton's Clutch".into(),
            image_url: String::new(),
        },
        TourneyMap {
            id: "map2".into(),
            name: "Astro Crater Battles".into(),
            image_url: String::new(),
        },
    ];
    event.map_pools = vec![MapPool {
        id: "pool1".into(),
        name: "Round 1".into(),
        map_ids: vec!["map1".into(), "map2".into()],
        sequence: Vec::new(),
        best_of: Some(3),
    }];

    FakeEvent {
        event,
        chat: HashMap::new(),
        next_id: 100,
    }
}

/// A running four-team bracket the signed-in account is playing in, so
/// reporting and confirming have something real to act on.
fn running_event() -> FakeEvent {
    let mut event = empty_event("e9z9z", "Autumn Invitational", TourneyStatus::Running);
    event.description = "Four invited players, double elimination.".into();
    event.event_date = Some(1_786_212_000);
    event.players = vec![
        player("p1", ME_NAME, ME_FAF_ID, "t1", 1_640),
        player("p2", "Ada", 102, "t2", 1_910),
        player("p3", "Grace", 103, "t3", 1_480),
        player("p4", "Alan", 104, "t4", 1_720),
    ];
    event.teams = vec![
        team("t1", 1, "p1"),
        team("t2", 2, "p2"),
        team("t3", 3, "p3"),
        team("t4", 4, "p4"),
    ];
    event.player_count = 4;
    event.team_count = 4;

    let mut semi_one = entry("m1", 1, 0, (Some("t1"), Some("t4")));
    semi_one.winner_to = Some(faf_domain::state::MatchLink {
        match_id: "m3".into(),
        slot: 1,
    });
    let mut semi_two = entry("m2", 1, 1, (Some("t2"), Some("t3")));
    semi_two.winner_to = Some(faf_domain::state::MatchLink {
        match_id: "m3".into(),
        slot: 2,
    });
    let final_match = entry("m3", 2, 0, (None, None));
    event.matches = vec![semi_one, semi_two, final_match];

    // This account is playing in it, which is what makes reporting and
    // confirming exercisable offline at all. Seeded deliberately, and paired
    // with `spectator_event` below so the difference between "in it" and
    // "watching it" is visible rather than something to be taken on trust.
    event.viewer.signed_up_player_id = Some("p1".into());
    event.viewer.member_team_id = Some("t1".into());

    let mut chat = HashMap::new();
    chat.insert(
        "global".to_string(),
        vec![ChatPost {
            id: "c1".into(),
            author: "Organizer".into(),
            body: "Semifinals start at 19:00 UTC. Post your replay ids when you report.".into(),
            at: Some(1_785_300_000),
            system: false,
        }],
    );

    FakeEvent {
        event,
        chat,
        next_id: 100,
    }
}

/// A 2v2 taking signups, with entrants who have not found a team yet and one
/// team with a place going.
///
/// The shape the client had no answer for: entering a team event and then
/// needing somewhere to go. Seeded so the whole conversation, requests and
/// invites both ways, can be exercised offline.
fn duo_event() -> FakeEvent {
    let mut event = empty_event("e2v2b", "Duo Ladder Night", TourneyStatus::Signup);
    event.description = "Two a side. Form a team, or ask to join one.".into();
    event.competition = Competition::Team;
    event.formation = Formation::Open;
    event.team_size = 2;
    event.event_date = Some(1_787_500_000);
    event.players = vec![
        player("d1", "Ada", 102, "dt1", 1_910),
        unteamed("d2", "Grace", 103, 1_480),
        unteamed("d3", "Alan", 104, 1_720),
    ];
    // One team of one, so its captain has a place to fill and this account has
    // somewhere to ask.
    let mut open_team = team("dt1", 1, "d1");
    open_team.name = "Half a Team".into();
    event.teams = vec![open_team];
    event.player_count = 3;
    event.team_count = 1;

    FakeEvent {
        event,
        chat: HashMap::new(),
        next_id: 100,
    }
}

/// A running event this account is *not* in.
///
/// Exists because the fake is the only thing anyone can develop against, and
/// one that claims you are in every event is worse than one with a boring
/// bracket: it makes a genuine leak indistinguishable from seed data. With this
/// here, "am I in this?" has both answers in the list.
fn spectator_event() -> FakeEvent {
    let mut event = empty_event("e5x5x", "Midweek Blitz", TourneyStatus::Running);
    event.description = "Two invited players, single elimination. You are not in this one.".into();
    event.event_date = Some(1_786_040_000);
    event.bracket_kind = BracketKind::Single;
    event.players = vec![
        player("q1", "Ada", 102, "u1", 1_910),
        player("q2", "Alan", 104, "u2", 1_720),
    ];
    event.teams = vec![team("u1", 1, "q1"), team("u2", 2, "q2")];
    event.player_count = 2;
    event.team_count = 2;
    event.matches = vec![entry("n1", 1, 0, (Some("u1"), Some("u2")))];

    FakeEvent {
        event,
        chat: HashMap::new(),
        next_id: 100,
    }
}

fn articles() -> Vec<Article> {
    vec![
        Article {
            id: "art33adc81d9f78".into(),
            title: "Tournament rules".into(),
            body: "Be on time, be civil, and post your replay ids with every reported game."
                .into(),
            parent_id: None,
        },
        Article {
            id: "art8f783c6882c5".into(),
            title: "Reporting a result".into(),
            body: "Either player submits the score; the opponent confirms it. Only then does the bracket move."
                .into(),
            parent_id: Some("art33adc81d9f78".into()),
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report(match_id: &str, score1: i32, score2: i32, replays: &[&str]) -> MatchReport {
        MatchReport {
            match_id: match_id.into(),
            score1,
            score2,
            replay_ids: replays.iter().map(|id| (*id).to_string()).collect(),
            draw_replay_ids: Vec::new(),
        }
    }

    #[tokio::test]
    async fn the_list_carries_counts_but_not_people() {
        // What the real list endpoint does, and the client has to survive it.
        let fake = FakeTourney::new();
        let list = fake.list().await.unwrap();
        assert_eq!(list.len(), 4);
        let cup = list.iter().find(|event| event.id == "e1a2b").unwrap();
        assert_eq!(cup.player_count, 2);
        assert!(cup.players.is_empty());
    }

    #[tokio::test]
    async fn entering_and_leaving_a_tournament_round_trips() {
        let fake = FakeTourney::new();
        let before = fake.detail("e1a2b").await.unwrap();
        assert!(before.may_sign_up());

        fake.sign_up("e1a2b").await.unwrap();
        let entered = fake.detail("e1a2b").await.unwrap();
        assert_eq!(entered.player_count, 3);
        assert!(entered.viewer.is_signed_up());
        // Signing up gives no team: the server never makes one here, and
        // pretending otherwise is what hid the dead end a 2v2 entrant hit.
        assert!(entered.viewer.member_team_id.is_none());
        assert!(entered.may_withdraw());
        assert!(!entered.may_sign_up());
        // Entering twice is the server's refusal, not a second entry.
        assert!(fake.sign_up("e1a2b").await.is_err());

        let player_id = entered.viewer.signed_up_player_id.clone().unwrap();
        fake.withdraw("e1a2b", &player_id).await.unwrap();
        let left = fake.detail("e1a2b").await.unwrap();
        assert_eq!(left.player_count, 2);
        assert!(!left.viewer.is_signed_up());
    }

    #[tokio::test]
    async fn a_submitted_score_waits_for_the_other_side() {
        let fake = FakeTourney::new();
        fake.submit_report("e9z9z", &report("m1", 2, 0, &["22334455", "22334456"]))
            .await
            .unwrap();

        let event = fake.detail("e9z9z").await.unwrap();
        let entry = &event.matches[0];
        assert_eq!(entry.status, MatchStatus::Ready, "the bracket has not moved");
        let pending = entry.pending_report.as_ref().expect("awaiting confirmation");
        assert_eq!((pending.score1, pending.score2), (2, 0));
        assert_eq!(pending.by_team, "t1");
        // The submitting side does not get to confirm its own report.
        assert!(!event.may_confirm(entry));
    }

    #[tokio::test]
    async fn a_report_without_one_replay_per_game_is_refused() {
        // The rule that makes a bracket auditable, and the one a player is most
        // likely to trip over.
        let fake = FakeTourney::new();
        let error = fake
            .submit_report("e9z9z", &report("m1", 2, 0, &["22334455"]))
            .await
            .expect_err("two games, one replay id");
        assert!(error.message().contains("2 replay IDs"));
    }

    #[tokio::test]
    async fn confirming_advances_the_winner_along_the_graph() {
        // Following winner_to is the point of the bracket being a real graph:
        // the fake moves entrants exactly the way the server does.
        let fake = FakeTourney::new();
        fake.submit_report("e9z9z", &report("m1", 2, 0, &["22334455", "22334456"]))
            .await
            .unwrap();
        fake.confirm_report("e9z9z", "m1", true).await.unwrap();

        let event = fake.detail("e9z9z").await.unwrap();
        assert_eq!(event.matches[0].status, MatchStatus::Done);
        assert_eq!(event.matches[0].winner.as_deref(), Some("t1"));
        assert_eq!(
            event.matches[2].team1.as_deref(),
            Some("t1"),
            "the winner lands in the final's first slot"
        );
        assert_eq!(event.matches[2].status, MatchStatus::Waiting, "one side only");
        assert!(event.team("t4").unwrap().eliminated);
    }

    #[tokio::test]
    async fn rejecting_a_score_clears_it_and_leaves_the_match_alone() {
        let fake = FakeTourney::new();
        fake.submit_report("e9z9z", &report("m1", 2, 0, &["22334455", "22334456"]))
            .await
            .unwrap();
        fake.confirm_report("e9z9z", "m1", false).await.unwrap();

        let event = fake.detail("e9z9z").await.unwrap();
        assert!(event.matches[0].pending_report.is_none());
        assert_eq!(event.matches[0].status, MatchStatus::Ready);
        assert!(event.matches[2].team1.is_none());
        // Nothing pending: there is nothing left to answer.
        assert!(fake.confirm_report("e9z9z", "m1", true).await.is_err());
    }

    #[tokio::test]
    async fn an_undecided_series_stays_live_rather_than_advancing() {
        let fake = FakeTourney::new();
        fake.decide_report("e9z9z", &report("m1", 1, 1, &[])).await.unwrap();
        let event = fake.detail("e9z9z").await.unwrap();
        assert_eq!(event.matches[0].status, MatchStatus::Live);
        assert!(event.matches[2].team1.is_none());
        assert!(event.may_report(&event.matches[0]), "still reportable");
    }

    #[tokio::test]
    async fn winning_the_last_match_crowns_a_champion() {
        let fake = FakeTourney::new();
        fake.decide_report("e9z9z", &report("m1", 2, 0, &[])).await.unwrap();
        fake.decide_report("e9z9z", &report("m2", 0, 2, &[])).await.unwrap();
        fake.decide_report("e9z9z", &report("m3", 2, 1, &[])).await.unwrap();

        let event = fake.detail("e9z9z").await.unwrap();
        assert_eq!(event.champion_team_id.as_deref(), Some("t1"));
        assert_eq!(event.status, TourneyStatus::Finished);
    }

    #[tokio::test]
    async fn checking_in_marks_the_whole_team() {
        let fake = FakeTourney::new();
        fake.check_in("e9z9z").await.unwrap();
        let event = fake.detail("e9z9z").await.unwrap();
        assert!(event.team("t1").unwrap().checked_in);
    }

    #[tokio::test]
    async fn a_match_room_exists_once_both_sides_are_known() {
        let fake = FakeTourney::new();
        let rooms = fake.chat_rooms("e9z9z").await.unwrap();
        let ids: Vec<&str> = rooms.iter().map(|room| room.id.as_str()).collect();
        assert_eq!(ids, vec!["global", "m1", "m2"], "the final has no opponents yet");
        assert_eq!(rooms[1].name, "Nuggets vs Alan");

        fake.chat_post("e9z9z", "m1", "  gl hf  ").await.unwrap();
        let posts = fake.chat_read("e9z9z", "m1").await.unwrap();
        assert_eq!(posts.len(), 1);
        assert_eq!(posts[0].body, "gl hf");
        assert!(fake.chat_post("e9z9z", "m1", "   ").await.is_err());
    }

    #[tokio::test]
    async fn a_pool_can_be_created_and_bound_to_a_round() {
        let fake = FakeTourney::new();
        fake.save_pool(
            "e1a2b",
            &PoolDraft {
                id: String::new(),
                name: "Semifinals".into(),
                map_ids: vec!["map1".into(), "map2".into()],
                best_of: Some(3),
            },
        )
        .await
        .unwrap();

        let event = fake.detail("e1a2b").await.unwrap();
        assert_eq!(event.map_pools.len(), 2);
        let created = event.map_pools.last().unwrap();
        assert_eq!(created.name, "Semifinals");

        fake.assign_pool("e1a2b", "wb:2", &created.id).await.unwrap();
        let event = fake.detail("e1a2b").await.unwrap();
        let bound = event.pool_for_round("wb:2").expect("bound to the semifinals");
        assert_eq!(bound.name, "Semifinals");
        assert_eq!(event.pool_maps(bound).len(), 2);

        // An empty pool id clears the binding rather than failing.
        fake.assign_pool("e1a2b", "wb:2", "").await.unwrap();
        assert!(fake
            .detail("e1a2b")
            .await
            .unwrap()
            .pool_for_round("wb:2")
            .is_none());
        assert!(fake.assign_pool("e1a2b", "wb:2", "nope").await.is_err());
    }

    #[tokio::test]
    async fn an_unknown_tournament_is_not_found_rather_than_empty() {
        let fake = FakeTourney::new();
        assert!(matches!(
            fake.detail("nope").await.expect_err("no such event"),
            RequestError::NotFound(_)
        ));
    }
}
