//! faf-tournaments API boundary.
//!
//! FAF's own tournament service (`tournaments.doodlepros.com`), which replaced
//! the Challonge bridge this client first shipped against. Every endpoint
//! accepts `Authorization: Bearer <FAF access token>`, so the same
//! `TokenStore` that feeds every other adapter feeds this one.
//!
//! # What is here, and what deliberately is not
//!
//! The service has over a hundred endpoints. This trait covers what a *player*
//! needs during a tournament, plus the one organiser task the client does
//! better than the website:
//!
//! - see the event, its bracket, its teams and its rules
//! - enter it, withdraw, check in
//! - report a result, where the organiser allowed players to
//! - read and post in the tournament chat
//! - assign a map pool to a round, with FAF's own map previews
//!
//! Setting a tournament up: format, best-of plan, rating gates, series,
//! qualifiers, the map database, site administration: stays on the website. It
//! is done once per event, it is form-heavy, and a second surface for it would
//! be a worse copy of a maintained one. The client links there instead.

use async_trait::async_trait;
use faf_domain::state::{
    Article, ChatPost, ChatRoom, HostingStatus, MatchReport, PoolDraft, SeedOrder, Tourney,
    TourneyDraft, TourneyPhase,
};

use super::RequestError;

#[async_trait]
pub trait TourneyPort: Send + Sync {
    /// Whether this account may host a tournament at all.
    ///
    /// Hosting is approval-only, granted per account by the site admin, so the
    /// answer is a property of the session rather than of any one event.
    async fn hosting(&self) -> Result<HostingStatus, RequestError>;

    /// Create an event, answering with its new id.
    async fn create(&self, draft: &TourneyDraft) -> Result<String, RequestError>;

    /// Change an existing event's settings.
    ///
    /// A narrower set than creation: the format, the team size and the category
    /// are welded to a bracket that may already exist, and the server keeps
    /// separate endpoints for those.
    async fn edit_info(
        &self,
        tournament_id: &str,
        draft: &TourneyDraft,
    ) -> Result<(), RequestError>;

    /// Make a draft event visible to everyone.
    async fn publish(&self, tournament_id: &str) -> Result<(), RequestError>;

    /// Move the event along its own lifecycle.
    async fn advance(&self, tournament_id: &str, phase: TourneyPhase) -> Result<(), RequestError>;

    /// Hide the event. A site admin can restore it, which is why this is not
    /// called delete: for anyone else the server archives rather than removes.
    async fn archive(&self, tournament_id: &str) -> Result<(), RequestError>;

    /// Every tournament the caller may see.
    ///
    /// Drafts are already filtered server-side for non-organisers. Finished
    /// events arrive too and are separated by status, not by a second request.
    async fn list(&self) -> Result<Vec<Tourney>, RequestError>;

    /// One tournament, whole: overview, players, teams, bracket, map pools.
    ///
    /// A single call by the server's design, which is worth keeping: three
    /// separate requests could return three views that disagree.
    async fn detail(&self, tournament_id: &str) -> Result<Tourney, RequestError>;

    /// Enter the tournament as the signed-in player.
    ///
    /// The client's best reason to exist for a player: they are already
    /// authenticated here, so entering is one click instead of a browser and a
    /// second login.
    async fn sign_up(&self, tournament_id: &str) -> Result<(), RequestError>;

    /// Withdraw from the tournament.
    ///
    /// Addressed by the player id the server handed out in
    /// [`faf_domain::state::TourneyViewer::signed_up_player_id`], because the
    /// server's own check is that the entry being removed belongs to the
    /// calling account.
    async fn withdraw(&self, tournament_id: &str, player_id: &str) -> Result<(), RequestError>;

    /// Start a team and captain it.
    ///
    /// There is no counterpart for joining one directly: the server retired
    /// that path and answers `join_team` with "send a join request, the captain
    /// approves it". Every route onto a team goes through one of the two
    /// conversations below.
    async fn create_team(&self, tournament_id: &str, name: &str) -> Result<(), RequestError>;

    /// Ask a team for a place.
    async fn request_join(&self, tournament_id: &str, team_id: &str) -> Result<(), RequestError>;

    /// Withdraw an outstanding request.
    async fn cancel_join(&self, tournament_id: &str, team_id: &str) -> Result<(), RequestError>;

    /// Answer somebody's request, as the captain or an organiser.
    async fn respond_join(
        &self,
        tournament_id: &str,
        team_id: &str,
        player_id: &str,
        accept: bool,
    ) -> Result<(), RequestError>;

    /// Ask a player to join, as the captain.
    async fn invite_to_team(
        &self,
        tournament_id: &str,
        team_id: &str,
        player_id: &str,
    ) -> Result<(), RequestError>;

    /// Answer an invitation addressed to this account.
    async fn respond_invite(
        &self,
        tournament_id: &str,
        team_id: &str,
        accept: bool,
    ) -> Result<(), RequestError>;

    /// Leave the team.
    ///
    /// The server does the tidying: the last member out dissolves the team, and
    /// a departing captain hands the armband to the next member.
    async fn leave_team(&self, tournament_id: &str) -> Result<(), RequestError>;

    /// Take a team apart, as its captain or an organiser.
    async fn disband_team(&self, tournament_id: &str, team_id: &str) -> Result<(), RequestError>;

    async fn rename_team(
        &self,
        tournament_id: &str,
        team_id: &str,
        name: &str,
    ) -> Result<(), RequestError>;

    /// Add an entrant by FAF name, as the organiser.
    ///
    /// The server looks the name up against FAF and refuses one it cannot
    /// find: there is no free-typed entrant, which is what keeps every entry
    /// attached to a real account. `rating` is consulted only by an unrated
    /// tournament, where there is nothing to fetch.
    async fn add_player(
        &self,
        tournament_id: &str,
        name: &str,
        rating: Option<i32>,
    ) -> Result<(), RequestError>;

    /// Approve or decline a signup waiting in request mode.
    async fn respond_signup(
        &self,
        tournament_id: &str,
        player_id: &str,
        accept: bool,
    ) -> Result<(), RequestError>;

    /// Ask somebody to enter, by FAF name.
    async fn invite_player(&self, tournament_id: &str, name: &str) -> Result<(), RequestError>;

    /// Withdraw an invitation.
    async fn uninvite(&self, tournament_id: &str, faf_id: i32) -> Result<(), RequestError>;

    /// Set the seeding, at random or in a given order.
    ///
    /// Randomising is the server's shuffle rather than the client's, so nobody
    /// can claim the draw was picked here.
    async fn reseed(&self, tournament_id: &str, order: &SeedOrder) -> Result<(), RequestError>;

    /// Split the field into divisions by combined rating. A count of one puts
    /// everyone back into a single field.
    async fn split_divisions(
        &self,
        tournament_id: &str,
        divisions: i32,
    ) -> Result<(), RequestError>;

    /// Move one team between divisions, after the automatic split.
    async fn set_division(
        &self,
        tournament_id: &str,
        team_id: &str,
        division: i32,
    ) -> Result<(), RequestError>;

    /// Post an announcement.
    async fn post_news(
        &self,
        tournament_id: &str,
        body: &str,
        important: bool,
    ) -> Result<(), RequestError>;

    async fn delete_news(&self, tournament_id: &str, news_id: &str) -> Result<(), RequestError>;

    /// Confirm attendance during the check-in window.
    ///
    /// Checks in the whole team: any member may do it, since the captain may be
    /// the one running late.
    async fn check_in(&self, tournament_id: &str) -> Result<(), RequestError>;

    /// Report a result as one of the players.
    ///
    /// Only legal when the organiser enabled player reporting
    /// ([`faf_domain::state::Tourney::may_report`]) and the caller is in the
    /// match. The other side confirms with [`Self::confirm_report`].
    async fn submit_report(
        &self,
        tournament_id: &str,
        report: &MatchReport,
    ) -> Result<(), RequestError>;

    /// Answer a result the opponent submitted.
    ///
    /// `accept` is the whole point of the two-signature flow: rejecting is as
    /// ordinary an answer as agreeing, and it clears the pending score so the
    /// other side can submit the right one.
    async fn confirm_report(
        &self,
        tournament_id: &str,
        match_id: &str,
        accept: bool,
    ) -> Result<(), RequestError>;

    /// Set a result as an organiser, which needs no confirmation.
    async fn decide_report(
        &self,
        tournament_id: &str,
        report: &MatchReport,
    ) -> Result<(), RequestError>;

    /// The chat rooms the caller may see.
    async fn chat_rooms(&self, tournament_id: &str) -> Result<Vec<ChatRoom>, RequestError>;

    /// Read one room.
    async fn chat_read(
        &self,
        tournament_id: &str,
        room_id: &str,
    ) -> Result<Vec<ChatPost>, RequestError>;

    /// Post to one room.
    async fn chat_post(
        &self,
        tournament_id: &str,
        room_id: &str,
        body: &str,
    ) -> Result<(), RequestError>;

    /// The rules and FAQ pages, shown alongside official tournaments.
    ///
    /// Site-wide rather than per-tournament, and returned whole in the order the
    /// editors put them in. Fetching all of them is what avoids hard-coding the
    /// three article ids the website happens to use today.
    async fn articles(&self) -> Result<Vec<Article>, RequestError>;

    /// Bind a map pool to a round, or clear the binding with an empty `pool_id`.
    ///
    /// The one organiser task worth having in the client: picking maps is a
    /// search through FAF's vault with previews, which the client already has
    /// and the website cannot match.
    ///
    /// `round_key` is the server's own key, which is either `{bracket}:{round}`
    /// (`wb:1`) or `match:{match_id}` for a single override. Taken verbatim from
    /// [`faf_domain::state::PoolAssignment::round`] rather than assembled here,
    /// so the client never has to know that grammar.
    async fn assign_pool(
        &self,
        tournament_id: &str,
        round_key: &str,
        pool_id: &str,
    ) -> Result<(), RequestError>;

    /// Create or replace a map pool.
    async fn save_pool(&self, tournament_id: &str, pool: &PoolDraft) -> Result<(), RequestError>;
}
