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
    Article, AuditEntry, BracketKind, BracketSide, ChatPost, ChatRoom, Competition, Formation,
    HostingStatus, InviteStatus, MapDraft, MapPool, MatchLink, MatchReport, MatchStatus, NewsPost,
    Organiser, PendingReport, PoolAssignment, PoolDraft, RatingGate, SeedOrder, TeamExit,
    TeamRequest, Tourney, TourneyCategory, TourneyDraft, TourneyInvite, TourneyMap, TourneyMatch,
    TourneyPhase, TourneyPlayer, TourneyStatus, TourneyTeam, TourneyViewer,
};
use faf_domain::state::{
    BracketConfig, Caster, FormatDraft, Qualifier, QualifierRule, SeriesColour, SeriesDetail,
    SeriesDraft, SeriesEdition, TourneySeries,
};
use faf_domain::state::{FfaReport, MatchVeto, PoolAction, VetoChoice, VetoDecider};

use crate::ports::{RequestError, TourneyPort};

/// Whoever is signed in offline. Taken from the bundle's one identity rather
/// than declared here: the fake stands in for the server's *session*, and a
/// session that disagreed with the login would hide exactly the bug that
/// disagreement once hid.
const ME_FAF_ID: i32 = super::OFFLINE_FAF_ID;
const ME_NAME: &str = super::OFFLINE_FAF_NAME;

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

    fn entry(&self, match_id: &str) -> Result<&TourneyMatch, RequestError> {
        self.event
            .matches
            .iter()
            .find(|entry| entry.id == match_id)
            .ok_or_else(|| RequestError::rejected("Match not found"))
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
        self.finalise_with_winner(match_id, score1, score2, None);
    }

    /// Settle a match, optionally with a winner the score does not imply.
    ///
    /// `override_winner` is the organiser's word: a forfeit, or a series nobody
    /// clinched that still has to produce someone for the next round. With it
    /// set, the match is done however the score reads.
    fn finalise_with_winner(
        &mut self,
        match_id: &str,
        score1: i32,
        score2: i32,
        override_winner: Option<String>,
    ) {
        let Ok(entry) = self.entry_mut(match_id) else {
            return;
        };
        entry.score1 = Some(score1);
        entry.score2 = Some(score2);
        entry.pending_report = None;

        let needed = (entry.best_of + 1) / 2;
        if override_winner.is_none() && score1 < needed && score2 < needed {
            // Still being played: a 1-1 in a best of three.
            entry.status = MatchStatus::Live;
            return;
        }

        entry.status = MatchStatus::Done;
        let (winner, loser) = match override_winner {
            Some(named) if entry.team2.as_deref() == Some(named.as_str()) => {
                (entry.team2.clone(), entry.team1.clone())
            }
            Some(_) => (entry.team1.clone(), entry.team2.clone()),
            None if score1 > score2 => (entry.team1.clone(), entry.team2.clone()),
            None => (entry.team2.clone(), entry.team1.clone()),
        };
        entry.winner = winner.clone();
        entry.loser = loser.clone();
        // Where the losing run ended, which is what the standings are built
        // from. The service writes it here too; a fake that only set
        // `eliminated` would leave every knocked-out team unplaceable.
        let exit = TeamExit {
            bracket: entry.bracket,
            round: entry.round,
        };
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
                self.event.champion_team_id = self
                    .event
                    .matches
                    .iter()
                    .find(|m| m.id == match_id)
                    .and_then(|m| m.winner.clone());
                self.event.status = TourneyStatus::Finished;
            }
        }
        if let Some(team) = self
            .event
            .teams
            .iter_mut()
            .find(|t| Some(&t.id) == loser.as_ref())
        {
            team.eliminated = true;
            team.out = Some(exit);
        }
    }
}

pub struct FakeTourney {
    events: Mutex<Vec<FakeEvent>>,
    articles: Vec<Article>,
    next_event: Mutex<u32>,
    /// Series are held apart from the events, the way the service holds them:
    /// a series is a row of its own, and an edition points at it. Everything a
    /// series *reports* (how many editions, how many are live, which is latest)
    /// is counted off the events on read rather than stored here.
    series: Mutex<Vec<FakeSeries>>,
    next_series: Mutex<u32>,
}

/// A series as the fake stores it: the four fields the organiser sets, and
/// nothing derived.
struct FakeSeries {
    id: String,
    name: String,
    description: String,
    colour: SeriesColour,
    category: Option<TourneyCategory>,
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
                draft_event(),
                ffa_event(),
                spectator_event(),
                finished_event(),
            ]),
            articles: articles(),
            next_event: Mutex::new(0),
            series: Mutex::new(vec![FakeSeries {
                id: "s0001".into(),
                name: "Weekend Ladder".into(),
                description: "A monthly 1v1 cup. Each edition stands on its own.".into(),
                colour: SeriesColour::Blue,
                category: Some(TourneyCategory::Official),
            }]),
            next_series: Mutex::new(1),
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
        // The service creates every tournament unpublished, and an offline fake
        // that skipped that would hide the one step an organiser must not miss.
        event.published = false;
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
        self.with_event(tournament_id, |held| {
            held.event.published = true;
            held.event.publish_at = None;
            Ok(())
        })
    }

    async fn advance(
        &self,
        tournament_id: &str,
        phase: TourneyPhase,
        config: Option<&BracketConfig>,
    ) -> Result<(), RequestError> {
        // The best-of plan is drawn into the matches by the service, and this
        // fake draws a much simpler bracket than it does. Refusing a config it
        // cannot honour would be worse than ignoring one: the flow being
        // exercised here is "the organiser settles the plan and the draw
        // happens", and the shape of the plan is pinned by the codec instead.
        let _ = config;
        self.with_event(tournament_id, |held| {
            if !phase.is_legal_from(held.event.status) {
                return Err(RequestError::rejected(match phase {
                    TourneyPhase::FormTeams => "Teams already formed",
                    TourneyPhase::StartBracket => "Form teams first",
                    TourneyPhase::ReopenSignups => "Bracket already started",
                    TourneyPhase::SetCaptains | TourneyPhase::StartDraft => {
                        "This tournament does not use a draft"
                    }
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
                TourneyPhase::SetCaptains => {
                    // A no-op step: the list is sent with the command, and the
                    // service only stores it. `set_captains` on the port is the
                    // one that carries the ids.
                }
                TourneyPhase::StartDraft => {
                    if held.event.formation != Formation::Draft {
                        return Err(RequestError::rejected(
                            "This tournament does not use a draft",
                        ));
                    }
                    let captains = held.event.pending_captains.clone();
                    if captains.len() < 2 {
                        return Err(RequestError::rejected(
                            "Mark at least 2 captains in the player list first",
                        ));
                    }
                    build_draft(&mut held.event, &captains);
                    held.event.status = TourneyStatus::Draft;
                }
                TourneyPhase::ReopenSignups => {
                    held.event.draft = None;
                    held.event.pending_captains.clear();
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
                out: None,
                final_rank: None,
                captain_renamed: false,
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
            let me = held
                .event
                .viewer
                .signed_up_player_id
                .clone()
                .unwrap_or_default();
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
            if team
                .invites
                .iter()
                .any(|invite| invite.player_id == target.id)
            {
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
            let Some(index) = team
                .invites
                .iter()
                .position(|invite| invite.player_id == me)
            else {
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
                return Err(RequestError::rejected(format!(
                    "{name} is already signed up"
                )));
            }
            let id = held.handle("p");
            held.event.players.push(TourneyPlayer {
                id,
                name: name.to_string(),
                // `org_add_player` resolves the name against FAF and stores the
                // account, which is what lets the entry carry an avatar. Mirrored
                // here, or the offline build would show every added entrant as a
                // bare string and make a working feature look broken.
                //
                // A name the offline list does not know still resolves to none,
                // because that case is real: the picker lets an organiser send a
                // spelling FAF's search did not match.
                faf_id: fake_faf_id(name),
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

    async fn set_captain(
        &self,
        tournament_id: &str,
        team_id: &str,
        player_id: &str,
    ) -> Result<(), RequestError> {
        self.with_event(tournament_id, |held| {
            let Some(team) = held.event.teams.iter_mut().find(|team| team.id == team_id) else {
                return Err(RequestError::rejected("Team not found"));
            };
            // The server insists the new captain is already on the team, rather
            // than pulling them across as a side effect.
            if !team.player_ids.iter().any(|id| id == player_id) {
                return Err(RequestError::rejected("That player is not on this team"));
            }
            team.captain_id = Some(player_id.to_string());
            Ok(())
        })
    }

    async fn move_player(
        &self,
        tournament_id: &str,
        player_id: &str,
        team_id: Option<&str>,
    ) -> Result<(), RequestError> {
        self.with_event(tournament_id, |held| {
            if held.event.player(player_id).is_none() {
                return Err(RequestError::rejected("Player not found"));
            }
            let size = held.event.team_size;

            // Off the old team first, exactly in the server's order: a team that
            // loses its last member is dissolved, and a departing captain's
            // armband passes to whoever is now first.
            if let Some(current) = held
                .event
                .players
                .iter()
                .find(|player| player.id == player_id)
                .and_then(|player| player.team_id.clone())
            {
                if let Some(team) = held.event.teams.iter_mut().find(|team| team.id == current) {
                    team.player_ids.retain(|id| id != player_id);
                    if team.captain_id.as_deref() == Some(player_id) {
                        team.captain_id = team.player_ids.first().cloned();
                    }
                }
                held.event.teams.retain(|team| !team.player_ids.is_empty());
            }
            if let Some(player) = held
                .event
                .players
                .iter_mut()
                .find(|player| player.id == player_id)
            {
                player.team_id = None;
            }

            // Then onto the new one, if there is one and it has room.
            if let Some(destination) = team_id {
                let Some(team) = held
                    .event
                    .teams
                    .iter_mut()
                    .find(|team| team.id == destination)
                else {
                    return Err(RequestError::rejected("Destination team not found"));
                };
                if i32::try_from(team.player_ids.len()).unwrap_or(i32::MAX) >= size {
                    return Err(RequestError::rejected("That team is full"));
                }
                team.player_ids.push(player_id.to_string());
                if team.captain_id.is_none() {
                    team.captain_id = Some(player_id.to_string());
                }
                if let Some(player) = held
                    .event
                    .players
                    .iter_mut()
                    .find(|player| player.id == player_id)
                {
                    player.team_id = Some(destination.to_string());
                }
            }
            held.event.team_count = held.event.teams.len() as i32;
            Ok(())
        })
    }

    async fn edit_player(
        &self,
        tournament_id: &str,
        player_id: &str,
        note: &str,
        rating: Option<i32>,
    ) -> Result<(), RequestError> {
        self.with_event(tournament_id, |held| {
            // The rating gate is the server's, and it is worth keeping here: it is
            // the one refusal an organiser meets by accident, when they try to
            // correct a rating the service fetched itself.
            let rated = held.event.rating_kind != faf_domain::state::RatingKind::None;
            if rating.is_some() && rated {
                return Err(RequestError::rejected(
                    "Ratings are fetched from FAF for this tournament and cannot be edited",
                ));
            }
            let Some(player) = held
                .event
                .players
                .iter_mut()
                .find(|player| player.id == player_id)
            else {
                return Err(RequestError::rejected("Player not found"));
            };
            player.note = note.trim().chars().take(40).collect();
            if let Some(rating) = rating {
                if !(0..=4_000).contains(&rating) {
                    return Err(RequestError::rejected("Rating must be 0-4000"));
                }
                player.rating_actual = Some(rating);
                player.rating = Some(rating);
            }
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
                    edited_at: None,
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
            let entry = held.entry_mut(&report.match_id)?;
            let needed = (entry.best_of + 1) / 2;

            // The forfeit shorthand, as the server derives it: the other side
            // takes the win at the series length, the forfeiting side is recorded
            // at -1.
            if report.is_bare_forfeit() {
                let forfeiting = report.forfeit.clone().unwrap_or_default();
                let Some(winner) = entry.forfeit_opponent(&forfeiting).map(str::to_string) else {
                    return Err(RequestError::rejected(
                        "Forfeiting team is not in this match",
                    ));
                };
                let (score1, score2) = if entry.team1.as_deref() == Some(forfeiting.as_str()) {
                    (-1, needed)
                } else {
                    (needed, -1)
                };
                held.finalise_with_winner(&report.match_id, score1, score2, Some(winner));
                return Ok(());
            }

            if !report.is_submittable(entry) {
                return Err(RequestError::rejected(format!(
                    "Scores must be between 0 and {needed}"
                )));
            }
            // An explicit winner finalises even a score that reached nobody's
            // threshold: a 1-1 somebody walked away from.
            let winner = report.winner.clone().or_else(|| {
                report
                    .forfeit
                    .as_deref()
                    .and_then(|team| entry.forfeit_opponent(team))
                    .map(str::to_string)
            });
            held.finalise_with_winner(&report.match_id, report.score1, report.score2, winner);
            Ok(())
        })
    }

    async fn chat_rooms(&self, tournament_id: &str) -> Result<Vec<ChatRoom>, RequestError> {
        self.with_event(tournament_id, |held| {
            let count = |room: &str| {
                held.chat
                    .get(room)
                    .map_or(0, |posts| i32::try_from(posts.len()).unwrap_or(i32::MAX))
            };
            let mut rooms = vec![ChatRoom {
                id: "global".into(),
                name: "Global: everyone".into(),
                count: count("global"),
                ..ChatRoom::default()
            }];
            // A match gets a room once both sides are known, exactly as the
            // server decides it, and a played match's room is marked done so
            // the list can fold it away rather than leaving a bracket's worth
            // of finished conversations above the live ones.
            for entry in &held.event.matches {
                let (Some(one), Some(two)) = (entry.team1.as_ref(), entry.team2.as_ref()) else {
                    continue;
                };
                if one == "BYE" || two == "BYE" {
                    continue;
                }
                // `match:{id}`, which is the service's own grammar. The fake
                // used the bare match id, and a fake that spells an id
                // differently from the service is a fake that cannot catch a
                // client which spells it wrong either.
                let room_id = format!("match:{}", entry.id);
                rooms.push(ChatRoom {
                    count: count(&room_id),
                    id: room_id,
                    name: format!(
                        "{} vs {}",
                        team_name(&held.event, one),
                        team_name(&held.event, two)
                    ),
                    done: entry.status == MatchStatus::Done,
                    ..ChatRoom::default()
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
            held.chat
                .entry(room_id.to_string())
                .or_default()
                .push(ChatPost {
                    id,
                    author: ME_NAME.into(),
                    faf_id: Some(ME_FAF_ID),
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

    async fn draft_pick(&self, tournament_id: &str, player_id: &str) -> Result<(), RequestError> {
        self.with_event(tournament_id, |held| {
            if !held.event.may_pick() {
                return Err(RequestError::rejected(
                    if held.event.draft_turn().is_none() {
                        "No draft in progress"
                    } else {
                        "Not your pick"
                    },
                ));
            }
            let turn = held.event.draft_turn().expect("checked above").to_string();
            let at_index = held.event.draft.as_ref().map_or(0, |draft| draft.current);
            let Some(player) = held
                .event
                .players
                .iter_mut()
                .find(|player| player.id == player_id)
            else {
                return Err(RequestError::rejected("Player not found"));
            };
            if player.team_id.is_some() {
                return Err(RequestError::rejected("Player already picked"));
            }
            player.team_id = Some(turn.clone());
            if let Some(team) = held.event.teams.iter_mut().find(|team| team.id == turn) {
                team.player_ids.push(player_id.to_string());
            }
            if let Some(draft) = held.event.draft.as_mut() {
                draft.last_pick = Some(faf_domain::state::DraftPick {
                    player_id: player_id.to_string(),
                    team_id: turn,
                    at_index,
                });
                draft.current += 1;
                // The order running out ends the draft, which is the service's
                // `finishDraftIfDone`: teams are formed and seeding can start.
                if draft.turn().is_none() {
                    held.event.status = TourneyStatus::Drafted;
                }
            }
            Ok(())
        })
    }

    async fn draft_undo(&self, tournament_id: &str) -> Result<(), RequestError> {
        self.with_event(tournament_id, |held| {
            if !held.event.may_undo_pick() {
                return Err(RequestError::rejected(
                    "You can only undo your own pick, and only before the next one",
                ));
            }
            let Some(last) = held
                .event
                .draft
                .as_ref()
                .and_then(|draft| draft.last_pick.clone())
            else {
                return Err(RequestError::rejected("Nothing to undo"));
            };
            if let Some(player) = held
                .event
                .players
                .iter_mut()
                .find(|player| player.id == last.player_id)
            {
                player.team_id = None;
            }
            if let Some(team) = held
                .event
                .teams
                .iter_mut()
                .find(|team| team.id == last.team_id)
            {
                team.player_ids.retain(|id| id != &last.player_id);
            }
            if let Some(draft) = held.event.draft.as_mut() {
                draft.current = last.at_index;
                draft.last_pick = None;
            }
            held.event.status = TourneyStatus::Draft;
            Ok(())
        })
    }

    async fn set_captains(
        &self,
        tournament_id: &str,
        player_ids: &[String],
    ) -> Result<(), RequestError> {
        self.with_event(tournament_id, |held| {
            held.event.pending_captains = player_ids
                .iter()
                .filter(|id| held.event.players.iter().any(|player| &&player.id == id))
                .cloned()
                .collect();
            Ok(())
        })
    }

    async fn report_ffa(
        &self,
        tournament_id: &str,
        report: &FfaReport,
    ) -> Result<(), RequestError> {
        self.with_event(tournament_id, |held| {
            let scored = {
                let entry = held.entry(&report.match_id)?;
                held.event.ffa_is_scored(entry)
            };
            let needed = {
                let entry = held.entry(&report.match_id)?;
                held.event.ffa_winners_needed(entry)
            };
            let entry = held.entry_mut(&report.match_id)?;
            if entry.bracket != BracketSide::FreeForAll {
                return Err(RequestError::rejected("That is not a free-for-all lobby"));
            }
            if !report.is_submittable(entry, scored, needed) {
                return Err(RequestError::rejected(if scored {
                    "Enter points (0-1000) for every player".to_string()
                } else {
                    format!(
                        "Select exactly {needed} winner{}",
                        if needed == 1 { "" } else { "s" }
                    )
                }));
            }
            if scored {
                entry.points = report.points.clone();
            } else {
                entry.winners = report.winners.clone();
                let out: Vec<String> = entry
                    .entrants
                    .iter()
                    .filter(|id| !report.winners.contains(id))
                    .cloned()
                    .collect();
                let round = entry.round;
                entry.status = MatchStatus::Done;
                // Elimination knocks the rest out, which is what the standings
                // are read from. Points mode keeps everybody in.
                for team in held.event.teams.iter_mut().filter(|t| out.contains(&t.id)) {
                    team.eliminated = true;
                    team.out = Some(TeamExit {
                        bracket: BracketSide::FreeForAll,
                        round,
                    });
                }
                return Ok(());
            }
            entry.status = MatchStatus::Done;
            Ok(())
        })
    }

    async fn veto_act(
        &self,
        tournament_id: &str,
        match_id: &str,
        map_id: &str,
    ) -> Result<(), RequestError> {
        self.with_event(tournament_id, |held| {
            if !held.event.veto.enabled {
                return Err(RequestError::rejected(
                    "Vetoes are not enabled for this tournament",
                ));
            }
            let organiser = held.event.viewer.organiser;
            let mine = held.event.viewer.member_team_id.clone();
            let entry = held.entry_mut(match_id)?;
            if entry.status == MatchStatus::Done {
                return Err(RequestError::rejected(
                    "This match already has a result, its veto is closed",
                ));
            }
            let Some(veto) = entry.veto.as_mut() else {
                return Err(RequestError::rejected("No veto in progress for this match"));
            };
            if veto.done {
                return Err(RequestError::rejected(
                    "The veto is already complete for this match",
                ));
            }
            let Some(turn) = veto.current_turn() else {
                return Err(RequestError::rejected(
                    "The organizer has not set Team A / Team B for this match yet",
                ));
            };
            if !organiser && mine.as_deref() != Some(turn.team_id.as_str()) {
                return Err(RequestError::rejected("Not your turn"));
            }
            let Some(at) = veto.remaining.iter().position(|id| id == map_id) else {
                return Err(RequestError::rejected("That map is not available"));
            };

            let taken = veto.remaining.remove(at);
            match turn.action {
                PoolAction::Ban => veto.banned.push(VetoChoice {
                    map: taken,
                    by: turn.team_id,
                    game: None,
                }),
                PoolAction::Pick => {
                    let game = veto.picks.len() as i32 + 1;
                    veto.picks.push(VetoChoice {
                        map: taken,
                        by: turn.team_id,
                        game: Some(game),
                    });
                }
            }
            advance_veto(veto);
            Ok(())
        })
    }

    async fn veto_set_sides(
        &self,
        tournament_id: &str,
        match_id: &str,
        team_a: &str,
    ) -> Result<(), RequestError> {
        self.with_event(tournament_id, |held| {
            let entry = held.entry_mut(match_id)?;
            let (team1, team2) = (entry.team1.clone(), entry.team2.clone());
            let Some(veto) = entry.veto.as_mut() else {
                return Err(RequestError::rejected("No veto for this match"));
            };
            if !veto.may_set_sides() {
                return Err(RequestError::rejected("The veto has already started"));
            }
            if team1.as_deref() != Some(team_a) && team2.as_deref() != Some(team_a) {
                return Err(RequestError::rejected("teamA must be one of the two teams"));
            }
            veto.team_b = if team1.as_deref() == Some(team_a) {
                team2
            } else {
                team1
            };
            veto.team_a = Some(team_a.to_string());
            Ok(())
        })
    }

    async fn veto_undo(&self, tournament_id: &str, match_id: &str) -> Result<(), RequestError> {
        self.with_event(tournament_id, |held| {
            let entry = held.entry_mut(match_id)?;
            let Some(veto) = entry.veto.as_mut() else {
                return Err(RequestError::rejected("No veto for this match"));
            };
            if veto.step_index == 0 && !veto.done {
                return Err(RequestError::rejected("Nothing to undo"));
            }
            if veto.done {
                veto.done = false;
                veto.decider = None;
            }
            if veto.step_index > 0 {
                veto.step_index -= 1;
            }
            // The step being undone decides which list the map comes back from,
            // which is what the service does: a ban and a pick are stored apart.
            if let Some(step) = veto
                .sequence
                .get(usize::try_from(veto.step_index).unwrap_or(usize::MAX))
                .copied()
            {
                let restored = match step.action {
                    PoolAction::Ban => veto.banned.pop(),
                    PoolAction::Pick => veto.picks.pop(),
                };
                if let Some(choice) = restored {
                    veto.remaining.push(choice.map);
                }
            }
            Ok(())
        })
    }

    async fn save_map(&self, tournament_id: &str, map: &MapDraft) -> Result<(), RequestError> {
        self.with_event(tournament_id, |held| {
            let name = map.name.trim();
            if name.is_empty() {
                return Err(RequestError::rejected("Map name required"));
            }
            if let Some(existing) = held.event.map_db.iter_mut().find(|held| held.id == map.id) {
                existing.name = name.to_string();
                existing.description = map.description.trim().to_string();
                existing.published = map.published;
                return Ok(());
            }
            let id = held.handle("map");
            held.event.map_db.push(TourneyMap {
                id,
                name: name.to_string(),
                image_url: String::new(),
                description: map.description.trim().to_string(),
                published: map.published,
            });
            Ok(())
        })
    }

    async fn publish_map(
        &self,
        tournament_id: &str,
        map_id: &str,
        published: bool,
    ) -> Result<(), RequestError> {
        self.with_event(tournament_id, |held| {
            let Some(map) = held.event.map_db.iter_mut().find(|map| map.id == map_id) else {
                return Err(RequestError::rejected("Map not found"));
            };
            map.published = published;
            Ok(())
        })
    }

    async fn delete_map(&self, tournament_id: &str, map_id: &str) -> Result<(), RequestError> {
        self.with_event(tournament_id, |held| {
            held.event.map_db.retain(|map| map.id != map_id);
            // The service cascades, and a fake that did not would leave pools
            // pointing at a map the tab can no longer name.
            for pool in &mut held.event.map_pools {
                pool.map_ids.retain(|id| id != map_id);
            }
            Ok(())
        })
    }

    async fn publish_pool(
        &self,
        tournament_id: &str,
        pool_id: &str,
        published: bool,
    ) -> Result<(), RequestError> {
        self.with_event(tournament_id, |held| {
            let Some(pool) = held
                .event
                .map_pools
                .iter_mut()
                .find(|pool| pool.id == pool_id)
            else {
                return Err(RequestError::rejected("Pool not found"));
            };
            pool.published = published;
            pool.publish_at = None;
            let ids = pool.map_ids.clone();
            // A visible pool of invisible maps is a list of raw ids, so the
            // service publishes the maps too. Copied because it is a rule
            // players see the effect of, not an implementation detail.
            if published {
                for map in &mut held.event.map_db {
                    if ids.contains(&map.id) {
                        map.published = true;
                    }
                }
            }
            Ok(())
        })
    }

    async fn delete_pool(&self, tournament_id: &str, pool_id: &str) -> Result<(), RequestError> {
        self.with_event(tournament_id, |held| {
            held.event.map_pools.retain(|pool| pool.id != pool_id);
            held.event
                .pool_assign
                .retain(|assigned| assigned.pool_id != pool_id);
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
                sequence: pool.sequence.clone(),
                best_of: pool.best_of,
                published: false,
                publish_at: None,
            });
            Ok(())
        })
    }

    async fn series(&self) -> Result<Vec<TourneySeries>, RequestError> {
        let events = self.events.lock().expect("fake tournaments poisoned");
        let series = self.series.lock().expect("fake series poisoned");
        let mut rows: Vec<TourneySeries> = series
            .iter()
            .map(|held| summarise_series(held, &events))
            .collect();
        // The service's own order, and worth reproducing rather than leaving
        // the insertion order: running series first, then most recent activity.
        // A client that quietly re-sorted would look right offline and wrong
        // against the service.
        rows.sort_by(|left, right| {
            (right.active > 0)
                .cmp(&(left.active > 0))
                .then(right.last_at.cmp(&left.last_at))
                .then_with(|| left.name.cmp(&right.name))
        });
        Ok(rows)
    }

    async fn series_detail(&self, series_id: &str) -> Result<SeriesDetail, RequestError> {
        let events = self.events.lock().expect("fake tournaments poisoned");
        let series = self.series.lock().expect("fake series poisoned");
        let held = series
            .iter()
            .find(|held| held.id == series_id)
            .ok_or_else(|| RequestError::not_found("That series no longer exists."))?;
        let mut editions: Vec<SeriesEdition> = events
            .iter()
            .map(|held| &held.event)
            .filter(|event| event.series_id.as_deref() == Some(series_id))
            .map(edition_of)
            .collect();
        editions.sort_by(|left, right| right.event_date.cmp(&left.event_date));
        Ok(SeriesDetail {
            id: held.id.clone(),
            name: held.name.clone(),
            description: held.description.clone(),
            colour: held.colour,
            category: held.category,
            editions,
            // The offline account organises every fixture event, so it manages
            // every series they could reach.
            can_edit: true,
        })
    }

    async fn save_series(&self, draft: &SeriesDraft) -> Result<(), RequestError> {
        if draft.name.trim().is_empty() {
            return Err(RequestError::rejected("Enter a series name"));
        }
        let mut series = self.series.lock().expect("fake series poisoned");
        // The service refuses a duplicate name outright, case-insensitively,
        // and it is the one refusal an organiser meets by accident: a series
        // per edition, all called the same thing.
        if series.iter().any(|held| {
            held.id != draft.id.trim() && held.name.eq_ignore_ascii_case(draft.name.trim())
        }) {
            return Err(RequestError::rejected(
                "A series with that name already exists",
            ));
        }
        if let Some(existing) = series
            .iter_mut()
            .find(|held| !draft.id.trim().is_empty() && held.id == draft.id.trim())
        {
            existing.name = draft.name.trim().to_string();
            existing.description = draft.description.trim().to_string();
            existing.colour = draft.colour;
            existing.category = draft.category;
            return Ok(());
        }
        let id = {
            let mut next = self
                .next_series
                .lock()
                .expect("fake series counter poisoned");
            *next += 1;
            format!("s{:04}", *next)
        };
        series.push(FakeSeries {
            id,
            name: draft.name.trim().to_string(),
            description: draft.description.trim().to_string(),
            colour: draft.colour,
            category: draft.category,
        });
        Ok(())
    }

    async fn delete_series(&self, series_id: &str) -> Result<(), RequestError> {
        let mut series = self.series.lock().expect("fake series poisoned");
        let before = series.len();
        series.retain(|held| held.id != series_id);
        if series.len() == before {
            return Err(RequestError::rejected("Series not found"));
        }
        // Editions are unfiled, not deleted. The service does the same, and it
        // is the half an organiser worries about before pressing the button.
        let mut events = self.events.lock().expect("fake tournaments poisoned");
        for held in events.iter_mut() {
            if held.event.series_id.as_deref() == Some(series_id) {
                held.event.series_id = None;
                held.event.series_name = String::new();
                held.event.series_colour = SeriesColour::default();
            }
        }
        Ok(())
    }

    async fn set_series(
        &self,
        tournament_id: &str,
        series_id: Option<&str>,
    ) -> Result<(), RequestError> {
        let named = match series_id {
            None => None,
            Some(id) => {
                let series = self.series.lock().expect("fake series poisoned");
                Some(
                    series
                        .iter()
                        .find(|held| held.id == id)
                        .map(|held| (held.id.clone(), held.name.clone(), held.colour))
                        .ok_or_else(|| RequestError::rejected("Series not found"))?,
                )
            }
        };
        self.with_event(tournament_id, |held| {
            match named {
                Some((id, name, colour)) => {
                    held.event.series_id = Some(id);
                    held.event.series_name = name;
                    held.event.series_colour = colour;
                }
                None => {
                    held.event.series_id = None;
                    held.event.series_name = String::new();
                    held.event.series_colour = SeriesColour::default();
                }
            }
            Ok(())
        })
    }

    async fn add_qualifier(
        &self,
        tournament_id: &str,
        qualifier_id: &str,
        rule: QualifierRule,
    ) -> Result<(), RequestError> {
        if qualifier_id == tournament_id {
            return Err(RequestError::rejected(
                "A tournament cannot qualify into itself",
            ));
        }
        let mut events = self.events.lock().expect("fake tournaments poisoned");
        let child = events
            .iter()
            .map(|held| &held.event)
            .find(|event| event.id == qualifier_id)
            .ok_or_else(|| RequestError::rejected("Tournament not found"))?;
        // The cycle check the client cannot make: it needs the *child's* links,
        // which a list row does not carry.
        if child
            .qualifiers
            .iter()
            .any(|link| link.tournament_id == tournament_id)
        {
            return Err(RequestError::rejected(
                "That tournament already draws its qualifiers from this one",
            ));
        }
        let name = child.name.clone();
        let status = child.status;
        // Applied at once where the child has already finished, which is what
        // the service's lazy sweep amounts to: it runs on the next read, and
        // this *is* the next read.
        let settled = (status == TourneyStatus::Finished).then(|| qualified_of(child, rule));
        let parent = events
            .iter_mut()
            .find(|held| held.event.id == tournament_id)
            .ok_or_else(|| RequestError::not_found("That tournament no longer exists."))?;
        if parent
            .event
            .qualifiers
            .iter()
            .any(|link| link.tournament_id == qualifier_id)
        {
            return Err(RequestError::rejected("That qualifier is already linked"));
        }
        let id = parent.handle("qual");
        let (qualified, unreachable) = settled.clone().unwrap_or_default();
        parent.event.qualifiers.push(Qualifier {
            id,
            tournament_id: qualifier_id.to_string(),
            name,
            status: Some(status),
            rule,
            applied: settled.is_some().then_some(1_786_300_000),
            qualified,
            unreachable,
        });
        Ok(())
    }

    async fn remove_qualifier(
        &self,
        tournament_id: &str,
        link_id: &str,
    ) -> Result<(), RequestError> {
        self.with_event(tournament_id, |held| {
            let before = held.event.qualifiers.len();
            held.event.qualifiers.retain(|link| link.id != link_id);
            if held.event.qualifiers.len() == before {
                return Err(RequestError::rejected("Qualifier link not found"));
            }
            Ok(())
        })
    }

    async fn edit_format(
        &self,
        tournament_id: &str,
        format: &FormatDraft,
        structural: bool,
    ) -> Result<(), RequestError> {
        self.with_event(tournament_id, |held| {
            if held.event.status.has_bracket() {
                return Err(RequestError::rejected(
                    "The format is locked once the bracket has started",
                ));
            }
            if structural && held.event.status != TourneyStatus::Signup {
                return Err(RequestError::rejected(
                    "Reopen signups to change the team setup",
                ));
            }
            if structural {
                held.event.competition = format.competition;
                // The service's own clamps: 1 to 6 for a team event, 1 to 3 for
                // a free-for-all, and a team of one is solo whatever was asked
                // for. Reproduced because they are what makes the answer differ
                // from what was sent.
                let ceiling = if format.competition == Competition::FreeForAll {
                    3
                } else {
                    6
                };
                held.event.team_size = format.team_size.clamp(1, ceiling);
                // A team of one is solo whatever was asked for, and a
                // free-for-all has no draft: the service writes `premade`
                // there, which reads back as `Open`.
                held.event.formation = if held.event.team_size == 1 {
                    Formation::Solo
                } else if format.competition == Competition::FreeForAll {
                    Formation::Open
                } else {
                    format.formation
                };
                held.event.draft_snakes = format.draft_snakes;
            }
            held.event.bracket_kind = format.bracket_kind;
            Ok(())
        })
    }

    async fn mute_chat(
        &self,
        tournament_id: &str,
        faf_id: i32,
        name: &str,
        muted: bool,
    ) -> Result<(), RequestError> {
        self.with_event(tournament_id, |held| {
            held.event.chat_mutes.retain(|mute| mute.faf_id != faf_id);
            if muted {
                held.event.chat_mutes.push(faf_domain::state::ChatMute {
                    faf_id,
                    name: name.to_string(),
                    at: Some(1_786_300_000),
                });
            }
            // The silenced account is told before it types, not after: that is
            // the whole reason `chatMutedMe` is read at all.
            if Some(faf_id) == held.event.viewer.faf_id {
                held.event.chat_muted_me = muted;
            }
            Ok(())
        })
    }

    async fn delete_chat_post(
        &self,
        tournament_id: &str,
        room_id: &str,
        post_id: &str,
    ) -> Result<(), RequestError> {
        self.with_event(tournament_id, |held| {
            let Some(posts) = held.chat.get_mut(room_id) else {
                return Ok(());
            };
            posts.retain(|post| post.id != post_id);
            Ok(())
        })
    }

    async fn add_organiser(
        &self,
        tournament_id: &str,
        faf_id: i32,
        name: &str,
    ) -> Result<(), RequestError> {
        self.with_event(tournament_id, |held| {
            if held
                .event
                .organiser_accounts
                .iter()
                .any(|held| held.faf_id == faf_id)
            {
                return Err(RequestError::rejected("Already an organizer"));
            }
            held.event.organiser_accounts.push(Organiser {
                faf_id,
                name: name.to_string(),
                hidden: false,
            });
            held.event.organisers.push(name.to_string());
            Ok(())
        })
    }

    async fn set_organiser_visibility(
        &self,
        tournament_id: &str,
        faf_id: i32,
        hidden: bool,
    ) -> Result<(), RequestError> {
        self.with_event(tournament_id, |held| {
            let Some(organiser) = held
                .event
                .organiser_accounts
                .iter_mut()
                .find(|held| held.faf_id == faf_id)
            else {
                return Err(RequestError::rejected(
                    "Not an organizer of this tournament",
                ));
            };
            organiser.hidden = hidden;
            let name = organiser.name.clone();
            // Two lists with different meanings, and the public one is what the
            // hiding is for: `organizersPublic` leaves the hidden out,
            // `organizers` does not.
            held.event.organisers = held
                .event
                .organiser_accounts
                .iter()
                .filter(|held| !held.hidden)
                .map(|held| held.name.clone())
                .collect();
            let _ = name;
            Ok(())
        })
    }

    async fn abandon(&self, tournament_id: &str, abandoned: bool) -> Result<(), RequestError> {
        self.with_event(tournament_id, |held| {
            held.event.abandoned = abandoned;
            Ok(())
        })
    }

    async fn edit_news(
        &self,
        tournament_id: &str,
        news_id: &str,
        body: &str,
        important: bool,
    ) -> Result<(), RequestError> {
        if body.trim().is_empty() {
            return Err(RequestError::rejected("Write something first"));
        }
        self.with_event(tournament_id, |held| {
            let Some(post) = held.event.news.iter_mut().find(|post| post.id == news_id) else {
                return Err(RequestError::rejected("Post not found"));
            };
            post.body = body.trim().to_string();
            post.important = important;
            post.edited_at = Some(1_786_300_000);
            Ok(())
        })
    }

    async fn set_caster(
        &self,
        tournament_id: &str,
        faf_id: i32,
        name: &str,
        casting: bool,
    ) -> Result<(), RequestError> {
        self.with_event(tournament_id, |held| {
            held.event.casters.retain(|held| held.faf_id != faf_id);
            if casting {
                held.event.casters.push(Caster {
                    faf_id,
                    name: name.to_string(),
                });
            }
            // The point of the role, reproduced so the flow is walkable: a
            // caster is shown every match chat rather than only their own.
            if Some(faf_id) == held.event.viewer.faf_id {
                held.event.viewer.caster = casting;
            }
            Ok(())
        })
    }

    async fn mark_news_read(&self, tournament_id: &str) -> Result<(), RequestError> {
        self.with_event(tournament_id, |held| {
            if !held.event.viewer.logged_in {
                // The service answers `{ok: 0}` rather than an error, and
                // remembers nothing: there is no account to remember it for.
                return Ok(());
            }
            held.event.viewer.news_read_at = held
                .event
                .news
                .iter()
                .filter_map(|post| post.at)
                .max()
                .or(held.event.viewer.news_read_at);
            Ok(())
        })
    }
}

/// One series' derived row, counted off the tournaments filed under it.
///
/// Derived rather than stored for the same reason the service derives it: the
/// counts are a view of the tournaments, and a stored copy would be a second
/// answer that drifts the moment an edition is filed or abandoned.
fn summarise_series(held: &FakeSeries, events: &[FakeEvent]) -> TourneySeries {
    let mine: Vec<&Tourney> = events
        .iter()
        .map(|event| &event.event)
        .filter(|event| event.series_id.as_deref() == Some(held.id.as_str()) && event.published)
        .collect();
    let latest = mine
        .iter()
        .max_by_key(|event| event.event_date.or(event.created_at).unwrap_or(0));
    TourneySeries {
        id: held.id.clone(),
        name: held.name.clone(),
        description: held.description.clone(),
        colour: held.colour,
        category: held.category,
        editions: i32::try_from(mine.len()).unwrap_or(i32::MAX),
        active: i32::try_from(
            mine.iter()
                .filter(|event| {
                    matches!(
                        event.status,
                        TourneyStatus::Signup
                            | TourneyStatus::Draft
                            | TourneyStatus::Drafted
                            | TourneyStatus::Running
                    )
                })
                .count(),
        )
        .unwrap_or(i32::MAX),
        last_at: mine
            .iter()
            .filter_map(|event| event.event_date.or(event.created_at))
            .max(),
        latest_id: latest.map(|event| event.id.clone()),
        latest_name: latest.map(|event| event.name.clone()).unwrap_or_default(),
        latest_date: latest.and_then(|event| event.event_date),
    }
}

fn edition_of(event: &Tourney) -> SeriesEdition {
    SeriesEdition {
        id: event.id.clone(),
        name: event.name.clone(),
        status: event.status,
        category: Some(event.category),
        published: event.published,
        competition: event.competition,
        bracket_kind: event.bracket_kind,
        team_size: event.team_size,
        player_count: i32::try_from(event.players.len()).unwrap_or(event.player_count),
        team_count: i32::try_from(event.teams.len()).unwrap_or(event.team_count),
        event_date: event.event_date,
        abandoned: false,
        champion_team_id: event.champion_team_id.clone(),
        champion: event
            .champion_team_id
            .as_deref()
            .map(|id| team_name(event, id))
            .unwrap_or_default(),
    }
}

/// Who goes through from a finished child, and who cannot be reached.
///
/// A thin stand-in for `qualifyingTeamIds`: the champion first and then the
/// rest by how late they went out, which is the elimination half of the
/// service's ranking. Enough to walk the flow offline, and not enough to settle
/// an argument about a real bracket, which is why the standings rule proper
/// lives in the domain and is pinned.
fn qualified_of(child: &Tourney, rule: QualifierRule) -> (Vec<String>, Vec<String>) {
    let wanted = usize::try_from(rule.n.max(1)).unwrap_or(1);
    let mut ranked: Vec<&TourneyTeam> = child.teams.iter().collect();
    ranked.sort_by_key(|team| {
        (
            child.champion_team_id.as_deref() != Some(team.id.as_str()),
            team.out.as_ref().map_or(0, |out| -out.round),
            team.seed,
        )
    });
    let mut qualified = Vec::new();
    let mut unreachable = Vec::new();
    for team in ranked.into_iter().take(wanted) {
        let name = team_name(child, &team.id);
        // An invite is addressed to a FAF account, and a manually added entrant
        // has none. The service reports them rather than swallowing them: it is
        // the organiser who then has to add them by hand.
        let reachable = team.player_ids.iter().any(|player_id| {
            child
                .players
                .iter()
                .any(|player| &player.id == player_id && player.faf_id.is_some())
        });
        if reachable {
            qualified.push(name);
        } else {
            unreachable.push(name);
        }
    }
    (qualified, unreachable)
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
    // Always off, as the real body says: the client has no player reporting
    // path, and the service would default an absent key to *on*.
    event.player_reporting = false;
    event.event_date = draft.event_date;
    event.signup_opens_at = draft.signup_opens_at;
    event.signup_closes_at = draft.signup_closes_at;
    event.rating_date = draft.rating_date;
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
            out: None,
            final_rank: None,
            captain_renamed: false,
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

/// The FAF account behind a name, as the offline player lookup knows it.
///
/// Kept in step with `FakePlayerCard`'s own fixed list on purpose: the two fakes
/// stand in for two services that agree about who exists, and an entrant the
/// account lookup cannot resolve would show no avatar for a reason that has
/// nothing to do with the client.
fn fake_faf_id(name: &str) -> Option<i32> {
    const KNOWN: [(&str, i32); 6] = [
        ("Nuggets", 101),
        ("Ada_Lovelace", 102),
        ("Grace-Hopper", 103),
        ("Newcomer", 104),
        ("Nugget", 105),
        ("TestCommander", 106),
    ];
    KNOWN
        .iter()
        .find(|(login, _)| login.eq_ignore_ascii_case(name.trim()))
        .map(|(_, id)| *id)
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
        out: None,
        final_rank: None,
        captain_renamed: false,
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
        veto: None,
        entrants: Vec::new(),
        winners: Vec::new(),
        points: Vec::new(),
        is_final: false,
        replay_ids: Vec::new(),
    }
}

/// One step on, and finished when the order runs out or one map is left.
///
/// Twin of `lib/match.js::vetoAdvance`. The leftover becomes the decider and is
/// played last, which is why a Bo3 pool holds four maps for three steps.
fn advance_veto(veto: &mut MatchVeto) {
    veto.step_index += 1;
    let walked = usize::try_from(veto.step_index).unwrap_or(usize::MAX) >= veto.sequence.len();
    if walked || veto.remaining.len() <= 1 {
        veto.done = true;
        if veto.remaining.len() == 1 {
            veto.decider = Some(VetoDecider {
                map: veto.remaining[0].clone(),
                game: veto.picks.len() as i32 + 1,
            });
        }
    }
}

/// Build the pick order and the teams it picks into.
///
/// Twin of `lib/teams.js::buildDraft`: one team per captain, then rounds of
/// picks until every team is full. A snake order reverses on every other pass,
/// which is what stops the first captain getting every first pick.
fn build_draft(event: &mut Tourney, captains: &[String]) {
    event.teams = captains
        .iter()
        .enumerate()
        .map(|(index, captain)| TourneyTeam {
            id: format!("dt{}", index + 1),
            name: String::new(),
            seed: index as i32 + 1,
            captain_id: Some(captain.clone()),
            player_ids: vec![captain.clone()],
            division: 0,
            checked_in: false,
            eliminated: false,
            out: None,
            final_rank: None,
            captain_renamed: false,
            join_requests: Vec::new(),
            invites: Vec::new(),
        })
        .collect();
    for team in &event.teams {
        let captain = team.captain_id.clone();
        if let Some(player) = event
            .players
            .iter_mut()
            .find(|player| Some(&player.id) == captain.as_ref())
        {
            player.team_id = Some(team.id.clone());
        }
    }
    event.team_count = event.teams.len() as i32;

    let count = event.teams.len();
    let mut order = Vec::new();
    for round in 0..event.team_size.max(1) - 1 {
        for position in 0..count {
            let at = if event.draft_snakes && round % 2 == 1 {
                count - 1 - position
            } else {
                position
            };
            order.push(event.teams[at].id.clone());
        }
    }
    event.draft = Some(faf_domain::state::Draft {
        order,
        current: 0,
        last_pick: None,
    });
    event.pending_captains.clear();
}

fn map(id: &str, name: &str) -> TourneyMap {
    TourneyMap {
        id: id.into(),
        name: name.into(),
        image_url: String::new(),
        description: String::new(),
        published: true,
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
        // The seeded events stand in for what the list already carries, which
        // is only ever published rows. `create` overrides it.
        published: true,
        created_at: Some(1_785_000_000),
        organisers: vec!["Nuggets".into()],
        viewer: TourneyViewer {
            logged_in: true,
            // The offline account organises every fixture event, which is what
            // `my_tournaments` above also says. The two have to agree: the
            // organiser surface is the larger half of this tab, and a fake that
            // withheld it would leave that half undevelopable.
            organiser: true,
            faf_id: Some(ME_FAF_ID),
            faf_name: ME_NAME.into(),
            ..TourneyViewer::default()
        },
        // Organiser-only, so it belongs on the organiser's blank rather than on
        // every event: a reader who is not one never receives it.
        audit_log: vec![
            audit("seeded the bracket", 1_786_212_400),
            audit("closed signups", 1_786_212_200),
            audit("added Ada", 1_786_212_000),
        ],
        organiser_accounts: vec![Organiser {
            faf_id: ME_FAF_ID,
            name: ME_NAME.into(),
            hidden: false,
        }],
        ..Tourney::default()
    }
}

/// One announcement, newest first, as the service orders them.
fn announcement(id: &str, body: &str, at: u32) -> NewsPost {
    NewsPost {
        id: id.into(),
        body: body.into(),
        by: ME_NAME.into(),
        at: Some(at),
        edited_at: None,
        important: false,
    }
}

/// One audit line, newest first, as the service orders them.
fn audit(text: &str, at: u32) -> AuditEntry {
    AuditEntry {
        at: Some(at),
        by: ME_NAME.into(),
        text: text.into(),
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
            description: String::new(),
            published: true,
        },
        TourneyMap {
            id: "map2".into(),
            name: "Astro Crater Battles".into(),
            image_url: String::new(),
            description: String::new(),
            published: true,
        },
    ];
    event.map_pools = vec![MapPool {
        id: "pool1".into(),
        name: "Round 1".into(),
        map_ids: vec!["map1".into(), "map2".into()],
        sequence: Vec::new(),
        best_of: Some(3),
        published: true,
        publish_at: None,
    }];
    // Announcements, unread. The unread badge, marking them read and correcting
    // one are all undevelopable against an event that has none, and `post_news`
    // is a poor substitute: a post this account just wrote is never unread.
    event.news = vec![
        announcement(
            "news2",
            "Check-in opens an hour before the first round.",
            1_786_100_000,
        ),
        announcement("news1", "Signups close on the Friday.", 1_786_000_000),
    ];

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
    // A result the opponent raised, waiting on this account's answer. Seeded
    // rather than submitted, because the client no longer raises one: recording
    // a result is the organiser's, and `report_submit` additionally insists on a
    // replay id per game. Answering a report raised on the website is the case
    // that remains, and it has to be exercisable offline.
    semi_one.pending_report = Some(PendingReport {
        score1: 2,
        score2: 0,
        by_team: "t4".into(),
        by_name: "Alan".into(),
        replay_ids: vec!["22334455".into(), "22334456".into()],
        at: Some(1_786_215_600),
    });
    event.veto = faf_domain::state::VetoConfig {
        enabled: true,
        mode: faf_domain::state::VetoMode::Upfront,
    };
    event.map_db = vec![
        map("map1", "Setons Clutch"),
        map("map2", "Theta Passage"),
        map("map3", "Open Palms"),
        map("map4", "Twin Rivers"),
    ];
    // A live ban/pick run on the other semi, so the whole flow is exercisable
    // offline: this account captains t1 and is not in this match, an organiser
    // is, and both paths matter.
    let mut semi_two = entry("m2", 1, 1, (Some("t2"), Some("t3")));
    semi_two.veto = Some(MatchVeto {
        remaining: vec!["map1".into(), "map2".into(), "map3".into(), "map4".into()],
        banned: Vec::new(),
        picks: Vec::new(),
        sequence: vec![
            faf_domain::state::PoolStep {
                action: PoolAction::Ban,
                team: faf_domain::state::PoolSide::A,
            },
            faf_domain::state::PoolStep {
                action: PoolAction::Pick,
                team: faf_domain::state::PoolSide::B,
            },
            faf_domain::state::PoolStep {
                action: PoolAction::Pick,
                team: faf_domain::state::PoolSide::A,
            },
        ],
        step_index: 0,
        team_a: Some("t2".into()),
        team_b: Some("t3".into()),
        done: false,
        decider: None,
    });
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
            faf_id: Some(103),
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
/// A scored free-for-all, so the mode the bracket cannot express is
/// developable offline: six entrants over two lobbies, points rather than
/// elimination, and one round already scored so the table has something in it.
fn ffa_event() -> FakeEvent {
    let mut event = empty_event("f4f4f", "Sunday Free-for-All", TourneyStatus::Running);
    event.description = "Six players, points over three rounds.".into();
    event.competition = Competition::FreeForAll;
    event.team_size = 1;
    event.published = true;
    event.ffa = Some(faf_domain::state::FfaConfig {
        per_match: 3,
        advance: 1,
        mode: faf_domain::state::FfaMode::Points,
        rounds: 3,
        cut_to: 0,
        final_size: 0,
    });
    event.players = vec![
        player("p1", ME_NAME, ME_FAF_ID, "t1", 1_640),
        player("p2", "Ada", 102, "t2", 1_910),
        player("p3", "Grace", 103, "t3", 1_480),
        player("p4", "Alan", 104, "t4", 1_720),
        player("p5", "Edsger", 105, "t5", 1_560),
        player("p6", "Barbara", 106, "t6", 1_400),
    ];
    event.teams = vec![
        team("t1", 1, "p1"),
        team("t2", 2, "p2"),
        team("t3", 3, "p3"),
        team("t4", 4, "p4"),
        team("t5", 5, "p5"),
        team("t6", 6, "p6"),
    ];
    event.player_count = 6;
    event.team_count = 6;

    let lobby = |id: &str, index: i32, entrants: &[&str], points: &[(&str, i32)]| TourneyMatch {
        bracket: BracketSide::FreeForAll,
        index,
        entrants: entrants.iter().map(|id| (*id).to_string()).collect(),
        points: points
            .iter()
            .map(|(id, score)| faf_domain::state::TeamPoints {
                team_id: (*id).to_string(),
                points: *score,
            })
            .collect(),
        status: if points.is_empty() {
            MatchStatus::Ready
        } else {
            MatchStatus::Done
        },
        ..entry(id, 1, index, (None, None))
    };

    event.matches = vec![
        lobby(
            "f1",
            0,
            &["t1", "t2", "t3"],
            &[("t1", 3), ("t2", 5), ("t3", 1)],
        ),
        // Not scored yet: the one an organiser can still fill in.
        lobby("f2", 1, &["t4", "t5", "t6"], &[]),
    ];

    FakeEvent {
        event,
        chat: HashMap::new(),
        next_id: 100,
    }
}

/// A 2v2 whose teams are drafted, so the whole captains flow is exercisable
/// offline: four entrants, two of them captains, and signups still open so the
/// draft can actually be started.
fn draft_event() -> FakeEvent {
    let mut event = empty_event("d3d3d", "Captains Cup", TourneyStatus::Signup);
    event.description = "Two captains pick their partners.".into();
    event.formation = Formation::Draft;
    event.team_size = 2;
    event.published = true;
    event.players = vec![
        player_free("c1", ME_NAME, ME_FAF_ID, 1_640),
        player_free("c2", "Ada", 102, 1_910),
        player_free("f1", "Grace", 103, 1_480),
        player_free("f2", "Alan", 104, 1_720),
    ];
    event.player_count = 4;
    // Marked, not started: the organiser still has to close signups, which is
    // the step the panel offers.
    event.pending_captains = vec!["c1".into(), "c2".into()];

    FakeEvent {
        event,
        chat: HashMap::new(),
        next_id: 100,
    }
}

/// An entrant with no team yet, which is every entrant before a draft.
fn player_free(id: &str, name: &str, faf_id: i32, rating: i32) -> TourneyPlayer {
    TourneyPlayer {
        team_id: None,
        ..player(id, name, faf_id, "", rating)
    }
}

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

/// A finished event, so qualification can be walked offline.
///
/// The only fixture with a champion, and it exists for that: a qualifier link
/// applies when its child has finished, so without one the whole flow ends at
/// "linked, waiting". It is filed under the seeded series too, which is what
/// makes the series list show an edition rather than a zero.
///
/// `q4` has no FAF account, which is the case worth having: they finish second,
/// so a top-2 rule qualifies them and cannot invite them. The service reports
/// that rather than swallowing it, and the panel has to show it.
fn finished_event() -> FakeEvent {
    let mut event = empty_event("e7f7f", "Spring Ladder Cup", TourneyStatus::Finished);
    event.description = "Last month's edition. Four entrants, single elimination.".into();
    event.event_date = Some(1_784_400_000);
    event.bracket_kind = BracketKind::Single;
    event.series_id = Some("s0001".into());
    event.series_name = "Weekend Ladder".into();
    event.series_colour = SeriesColour::Blue;
    event.players = vec![
        player("q1", "Ada", 102, "w1", 1_910),
        player("q2", "Grace", 103, "w2", 1_480),
        player("q3", "Alan", 104, "w3", 1_720),
        TourneyPlayer {
            // Added by hand by the organiser, so there is no account to invite.
            faf_id: None,
            manual: true,
            ..player("q4", "Guest", 0, "w4", 1_500)
        },
    ];
    event.teams = vec![
        TourneyTeam {
            final_rank: Some(1),
            eliminated: false,
            ..team("w1", 1, "q1")
        },
        TourneyTeam {
            final_rank: Some(3),
            eliminated: true,
            out: Some(TeamExit {
                bracket: BracketSide::Winners,
                round: 1,
            }),
            ..team("w2", 3, "q2")
        },
        TourneyTeam {
            final_rank: Some(3),
            eliminated: true,
            out: Some(TeamExit {
                bracket: BracketSide::Winners,
                round: 1,
            }),
            ..team("w3", 4, "q3")
        },
        TourneyTeam {
            final_rank: Some(2),
            eliminated: true,
            out: Some(TeamExit {
                bracket: BracketSide::Winners,
                round: 2,
            }),
            ..team("w4", 2, "q4")
        },
    ];
    event.player_count = 4;
    event.team_count = 4;
    event.champion_team_id = Some("w1".into());
    event.matches = vec![
        decided("f1", 1, 0, ("w1", "w2"), 2, 0),
        decided("f2", 1, 1, ("w4", "w3"), 2, 1),
        TourneyMatch {
            is_final: true,
            ..decided("f3", 2, 0, ("w1", "w4"), 2, 1)
        },
    ];

    FakeEvent {
        event,
        chat: HashMap::new(),
        next_id: 100,
    }
}

/// A match that has been played out, winner first.
fn decided(
    id: &str,
    round: i32,
    index: i32,
    teams: (&str, &str),
    score1: i32,
    score2: i32,
) -> TourneyMatch {
    TourneyMatch {
        status: MatchStatus::Done,
        score1: Some(score1),
        score2: Some(score2),
        winner: Some(teams.0.into()),
        loser: Some(teams.1.into()),
        ..entry(id, round, index, (Some(teams.0), Some(teams.1)))
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
            winner: None,
            forfeit: None,
        }
    }

    #[tokio::test]
    async fn the_list_carries_counts_but_not_people() {
        // What the real list endpoint does, and the client has to survive it.
        let fake = FakeTourney::new();
        let list = fake.list().await.unwrap();
        // Asserted as a property rather than a count. A magic number here says
        // nothing about what the test is for and goes stale every time a
        // fixture event is added, which is exactly what happened to it.
        assert!(!list.is_empty());
        assert!(
            list.iter()
                .all(|event| event.players.is_empty() && event.teams.is_empty()),
            "the list carries no people"
        );
        let cup = list.iter().find(|event| event.id == "e1a2b").unwrap();
        assert_eq!(cup.player_count, 2, "but it does carry the counts");
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
    async fn a_score_raised_elsewhere_waits_for_this_account() {
        let fake = FakeTourney::new();
        let event = fake.detail("e9z9z").await.unwrap();
        let entry = &event.matches[0];
        assert_eq!(
            entry.status,
            MatchStatus::Ready,
            "the bracket has not moved"
        );
        let pending = entry
            .pending_report
            .as_ref()
            .expect("awaiting confirmation");
        assert_eq!((pending.score1, pending.score2), (2, 0));
        assert_eq!(pending.by_team, "t4");
        // Raised by the other side, so it is this account's to answer.
        assert!(event.may_confirm(entry));
        // And the match with nothing pending has nothing to answer.
        assert!(!event.may_confirm(&event.matches[1]));
    }

    #[tokio::test]
    async fn confirming_advances_the_winner_along_the_graph() {
        // Following winner_to is the point of the bracket being a real graph:
        // the fake moves entrants exactly the way the server does.
        let fake = FakeTourney::new();
        fake.confirm_report("e9z9z", "m1", true).await.unwrap();

        let event = fake.detail("e9z9z").await.unwrap();
        assert_eq!(event.matches[0].status, MatchStatus::Done);
        assert_eq!(event.matches[0].winner.as_deref(), Some("t1"));
        assert_eq!(
            event.matches[2].team1.as_deref(),
            Some("t1"),
            "the winner lands in the final's first slot"
        );
        assert_eq!(
            event.matches[2].status,
            MatchStatus::Waiting,
            "one side only"
        );
        assert!(event.team("t4").unwrap().eliminated);
    }

    #[tokio::test]
    async fn rejecting_a_score_clears_it_and_leaves_the_match_alone() {
        let fake = FakeTourney::new();
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
        fake.decide_report("e9z9z", &report("m1", 1, 1, &[]))
            .await
            .unwrap();
        let event = fake.detail("e9z9z").await.unwrap();
        assert_eq!(event.matches[0].status, MatchStatus::Live);
        assert!(event.matches[2].team1.is_none());
        assert!(event.may_report(&event.matches[0]), "still reportable");
    }

    #[tokio::test]
    async fn winning_the_last_match_crowns_a_champion() {
        let fake = FakeTourney::new();
        fake.decide_report("e9z9z", &report("m1", 2, 0, &[]))
            .await
            .unwrap();
        fake.decide_report("e9z9z", &report("m2", 0, 2, &[]))
            .await
            .unwrap();
        fake.decide_report("e9z9z", &report("m3", 2, 1, &[]))
            .await
            .unwrap();

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
        // `match:{id}`, the service's own grammar. The fake used the bare match
        // id, which no client would ever send it.
        assert_eq!(
            ids,
            vec!["global", "match:m1", "match:m2"],
            "the final has no opponents yet"
        );
        assert_eq!(rooms[1].name, "Nuggets vs Alan");
        assert!(
            rooms.iter().all(|room| !room.done),
            "nothing has been played, so nothing folds away yet"
        );

        fake.chat_post("e9z9z", "match:m1", "  gl hf  ")
            .await
            .unwrap();
        let posts = fake.chat_read("e9z9z", "match:m1").await.unwrap();
        assert_eq!(posts.len(), 1);
        assert_eq!(posts[0].body, "gl hf");
        assert!(fake.chat_post("e9z9z", "match:m1", "   ").await.is_err());
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
                sequence: Vec::new(),
            },
        )
        .await
        .unwrap();

        let event = fake.detail("e1a2b").await.unwrap();
        assert_eq!(event.map_pools.len(), 2);
        let created = event.map_pools.last().unwrap();
        assert_eq!(created.name, "Semifinals");

        fake.assign_pool("e1a2b", "wb:2", &created.id)
            .await
            .unwrap();
        let event = fake.detail("e1a2b").await.unwrap();
        let bound = event
            .pool_for_round("wb:2")
            .expect("bound to the semifinals");
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
