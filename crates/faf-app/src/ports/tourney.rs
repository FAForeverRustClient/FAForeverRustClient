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
//! - run the organiser's side of an event: the map database, the map pools,
//!   the vetoes, the draft, the series it belongs to and the qualifiers that
//!   feed it
//!
//! What stays on the website is site administration: the article pages, the
//! hosting approvals, the category tags. Those are the site team's, not an
//! organiser's, and a second surface for them would be a worse copy of a
//! maintained one. The client links there instead.

use async_trait::async_trait;
use faf_domain::state::{
    Article, BracketConfig, ChatPost, ChatRoom, FfaReport, FormatDraft, HostingStatus, MapDraft,
    MatchReport, PoolDraft, QualifierRule, SeedOrder, SeriesDetail, SeriesDraft, Tourney,
    TourneyDraft, TourneyPhase, TourneySeries,
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
    ///
    /// `config` is the best-of plan and is read on `start_bracket` alone. It is
    /// optional because the service defaults every value from the event's own
    /// plan: an absent config draws exactly the bracket it drew before this
    /// existed.
    async fn advance(
        &self,
        tournament_id: &str,
        phase: TourneyPhase,
        config: Option<&BracketConfig>,
    ) -> Result<(), RequestError>;

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

    /// Hand the armband to another member of a team.
    async fn set_captain(
        &self,
        tournament_id: &str,
        team_id: &str,
        player_id: &str,
    ) -> Result<(), RequestError>;

    /// Move an entrant to another team, or off every team.
    ///
    /// `team_id` of `None` parks them without removing them from the event. The
    /// server dissolves a team its last member leaves and passes a departing
    /// captain's armband on, so the caller reloads rather than modelling it.
    async fn move_player(
        &self,
        tournament_id: &str,
        player_id: &str,
        team_id: Option<&str>,
    ) -> Result<(), RequestError>;

    /// Attach a note to an entrant, and set a rating where the event has none.
    ///
    /// Names are not editable: identity comes from FAF and the server says so.
    /// `rating` is refused by any event that fetches ratings.
    async fn edit_player(
        &self,
        tournament_id: &str,
        player_id: &str,
        note: &str,
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

    /// Answer a result raised against this account's match.
    ///
    /// The client never raises one: recording a result is the organiser's, and
    /// `report_submit` additionally insists on one FAF replay id per game.
    /// Answering is a different act, and a report raised from the website has
    /// to be answerable here or the tab shows a decision it cannot make.
    ///
    /// `accept` is the whole point: rejecting is as ordinary an answer as
    /// agreeing, and it clears the pending score so the right one can follow.
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

    /// Take the draft pick that is due.
    ///
    /// Refused unless the caller captains the team on the clock, or organises
    /// the event. The picked entrant must be teamless.
    async fn draft_pick(&self, tournament_id: &str, player_id: &str) -> Result<(), RequestError>;

    /// Take back the last pick. A captain may undo only their own, and only
    /// while nobody has picked after them; an organiser at any point.
    async fn draft_undo(&self, tournament_id: &str) -> Result<(), RequestError>;

    /// Mark which entrants captain a team, before a draft starts.
    async fn set_captains(
        &self,
        tournament_id: &str,
        player_ids: &[String],
    ) -> Result<(), RequestError>;

    /// Record a free-for-all lobby.
    ///
    /// Separate from [`Self::decide_report`] because the body is a different
    /// shape: a lobby has entrants rather than two sides, and is settled by a
    /// set of winners or a points table.
    async fn report_ffa(&self, tournament_id: &str, report: &FfaReport)
        -> Result<(), RequestError>;

    /// Take the veto step that is due.
    ///
    /// Refused unless it is this caller's turn, which is why the tab checks
    /// [`faf_domain::state::Tourney::may_veto`] before offering the grid.
    async fn veto_act(
        &self,
        tournament_id: &str,
        match_id: &str,
        map_id: &str,
    ) -> Result<(), RequestError>;

    /// Say which team is A. Only before the first step.
    async fn veto_set_sides(
        &self,
        tournament_id: &str,
        match_id: &str,
        team_a: &str,
    ) -> Result<(), RequestError>;

    /// Take back the last step. Organiser only.
    async fn veto_undo(&self, tournament_id: &str, match_id: &str) -> Result<(), RequestError>;

    /// Add a map to the event's own database, or edit one already there.
    ///
    /// Returns nothing: the service answers with the new id, but the tab reloads
    /// the whole event afterwards and reads it from there, which is the only
    /// version guaranteed to agree with everything else on screen.
    async fn save_map(&self, tournament_id: &str, map: &MapDraft) -> Result<(), RequestError>;

    /// Show or hide one map.
    async fn publish_map(
        &self,
        tournament_id: &str,
        map_id: &str,
        published: bool,
    ) -> Result<(), RequestError>;

    /// Remove a map, and with it every pool entry and round assignment naming
    /// it. The service does that cascade itself.
    async fn delete_map(&self, tournament_id: &str, map_id: &str) -> Result<(), RequestError>;

    /// Show or hide one pool. Publishing also publishes every map in it.
    async fn publish_pool(
        &self,
        tournament_id: &str,
        pool_id: &str,
        published: bool,
    ) -> Result<(), RequestError>;

    async fn delete_pool(&self, tournament_id: &str, pool_id: &str) -> Result<(), RequestError>;

    /// Create or replace a map pool.
    async fn save_pool(&self, tournament_id: &str, pool: &PoolDraft) -> Result<(), RequestError>;

    /// Every series, already sorted by the service.
    ///
    /// Site-wide rather than per-tournament, like [`Self::articles`]: a series
    /// groups editions that are otherwise independent events, so it cannot hang
    /// off any one of them.
    async fn series(&self) -> Result<Vec<TourneySeries>, RequestError>;

    /// One series with its editions.
    async fn series_detail(&self, series_id: &str) -> Result<SeriesDetail, RequestError>;

    /// Create a series, or rename one that exists.
    ///
    /// Creating needs hosting rights, which every organiser already has;
    /// renaming needs more, and the service decides that itself and reports it
    /// in [`SeriesDetail::can_edit`].
    async fn save_series(&self, draft: &SeriesDraft) -> Result<(), RequestError>;

    /// Delete a series. Its editions are unfiled, not deleted.
    async fn delete_series(&self, series_id: &str) -> Result<(), RequestError>;

    /// File this event under a series, or take it out with `None`.
    async fn set_series(
        &self,
        tournament_id: &str,
        series_id: Option<&str>,
    ) -> Result<(), RequestError>;

    /// Link an event whose result feeds entrants into this one.
    ///
    /// The link lives on the parent alone. Qualifying does not sign anybody up:
    /// the service invites each qualified account, and they still accept.
    async fn add_qualifier(
        &self,
        tournament_id: &str,
        qualifier_id: &str,
        rule: QualifierRule,
    ) -> Result<(), RequestError>;

    /// Unlink one, by the link's own id. Invites already sent are kept.
    async fn remove_qualifier(
        &self,
        tournament_id: &str,
        link_id: &str,
    ) -> Result<(), RequestError>;

    /// Change the shape of the competition.
    ///
    /// `structural` says whether the team setup is among the changes. It is a
    /// parameter rather than something worked out here because the service
    /// refuses those four keys outside signups on *presence* alone: resending
    /// an unchanged team size would turn an ordinary bracket-type change into a
    /// refusal.
    async fn edit_format(
        &self,
        tournament_id: &str,
        format: &FormatDraft,
        structural: bool,
    ) -> Result<(), RequestError>;

    /// Silence an account in the event's chat, or let it speak again.
    async fn mute_chat(
        &self,
        tournament_id: &str,
        faf_id: i32,
        name: &str,
        muted: bool,
    ) -> Result<(), RequestError>;

    /// Take one post out of a room.
    async fn delete_chat_post(
        &self,
        tournament_id: &str,
        room_id: &str,
        post_id: &str,
    ) -> Result<(), RequestError>;

    /// Give a FAF account organiser rights here.
    ///
    /// No counterpart: `remove_organizer` is site-admin-only, and nothing in the
    /// viewer block says whether this account is one. A button that answered
    /// "Site admin only" for every ordinary organiser would read as broken.
    async fn add_organiser(
        &self,
        tournament_id: &str,
        faf_id: i32,
        name: &str,
    ) -> Result<(), RequestError>;

    /// Show or hide one organiser in the public list.
    async fn set_organiser_visibility(
        &self,
        tournament_id: &str,
        faf_id: i32,
        hidden: bool,
    ) -> Result<(), RequestError>;

    /// Mark the event as called off, or take that back.
    ///
    /// Not the same as archiving: an abandoned event stays visible, which is
    /// the point. An empty bracket with no explanation reads as a broken tab.
    async fn abandon(&self, tournament_id: &str, abandoned: bool) -> Result<(), RequestError>;

    /// Correct an announcement already posted.
    async fn edit_news(
        &self,
        tournament_id: &str,
        news_id: &str,
        body: &str,
        important: bool,
    ) -> Result<(), RequestError>;

    /// Clear this account's unread badge for the event, on every device.
    async fn mark_news_read(&self, tournament_id: &str) -> Result<(), RequestError>;

    /// Let a FAF account cast this event, or take that back.
    ///
    /// A caster sees every match chat rather than only their own. This replaced
    /// a secret link carrying a token, which the client had nowhere to put.
    async fn set_caster(
        &self,
        tournament_id: &str,
        faf_id: i32,
        name: &str,
        casting: bool,
    ) -> Result<(), RequestError>;
}
