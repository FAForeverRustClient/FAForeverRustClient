//! faf-tournaments: FAF's own tournament service.
//!
//! Replaces the Challonge bridge. Where that was a proxy in front of somebody
//! else's product, this is a service the tournament team owns, so the client
//! talks to it directly at [`TourneyConfig::api_base`] and authenticates with
//! the same FAF access token every other adapter uses.
//!
//! Parsing lives in `faf_domain::protocol::tourney`; this module only moves
//! bytes, builds request bodies, and turns statuses into [`RequestError`]
//! categories.
//!
//! # Request bodies
//!
//! The service has no schema and no API document. Its routes are a chain of
//! `if (sub === '...')` in a four-thousand-line handler. Every body below was
//! read out of that handler rather than guessed, and the field names are its
//! own: `key` rather than `round` for a pool assignment, `text` rather than
//! `body` for a chat post. Read the handler before writing any request body;
//! `docs/tourney-audit.md` records what has actually been checked
//! against it and what has not.

use async_trait::async_trait;
use faf_domain::protocol::tourney;
use faf_domain::state::{
    Article, BracketConfig, ChatPost, ChatRoom, FfaReport, FormatDraft, HostingStatus, MapDraft,
    MatchReport, PoolDraft, QualifierRule, SeedOrder, SeriesDetail, SeriesDraft, Tourney,
    TourneyDraft, TourneyPhase, TourneySeries,
};
use serde_json::{json, Value};

use crate::infra::env_or;
use crate::infra::jsonapi::{bounded_document_body, request_error};
use crate::infra::session::TokenStore;
use crate::ports::{RequestError, TourneyPort};

/// The tournament team's deployment. Overridable so a developer can point at a
/// local `node server.js` without rebuilding.
const DEFAULT_API_BASE: &str = "https://tournaments.doodlepros.com";

#[derive(Debug, Clone)]
pub struct TourneyConfig {
    pub api_base: String,
}

impl TourneyConfig {
    pub fn faf() -> Self {
        Self {
            api_base: env_or("TOURNEY_API_BASE", DEFAULT_API_BASE),
        }
    }
}

impl Default for TourneyConfig {
    fn default() -> Self {
        Self::faf()
    }
}

pub struct TourneyClient {
    config: TourneyConfig,
    tokens: TokenStore,
    http: reqwest::Client,
}

impl TourneyClient {
    pub fn new(config: TourneyConfig, tokens: TokenStore) -> Self {
        Self {
            config,
            tokens,
            http: super::http::shared_http_client(),
        }
    }

    pub fn faf(tokens: TokenStore) -> Self {
        Self::new(TourneyConfig::faf(), tokens)
    }

    /// The URL for one API path, e.g. `t/e1a2b/signup`.
    fn url(&self, path: &str) -> Result<url::Url, RequestError> {
        let base = self.config.api_base.trim_end_matches('/');
        url::Url::parse(&format!("{base}/api/{path}"))
            .map_err(|error| RequestError::unexpected(format!("invalid API base: {error}")))
    }

    async fn send(
        &self,
        method: reqwest::Method,
        path: &str,
        query: &[(&str, &str)],
        body: Option<Value>,
    ) -> Result<Value, RequestError> {
        let mut url = self.url(path)?;
        {
            let mut pairs = url.query_pairs_mut();
            for (key, value) in query {
                pairs.append_pair(key, value);
            }
        }

        // Every route, read or write, is behind the session: the service shows
        // an anonymous caller nothing, so there is no useful unauthenticated
        // path to fall back to.
        let token = self
            .tokens
            .get()
            .ok_or_else(|| RequestError::unauthorized("Sign in to FAF to see tournaments."))?;
        let mut request = self
            .http
            .request(method, url)
            .bearer_auth(token)
            .header(reqwest::header::ACCEPT, "application/json");
        if let Some(body) = body {
            request = request.json(&body);
        }

        let response = request
            .send()
            .await
            .map_err(|error| self.unreachable(error))?;
        let status = response.status();
        let body = bounded_document_body(response).await?;

        if !status.is_success() {
            return Err(tourney_error(status, &body));
        }
        // A write answers `{ ok: true }`, and occasionally nothing at all.
        if body.trim().is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&body)
            .map_err(|error| RequestError::unexpected(format!("invalid server response: {error}")))
    }

    /// A connection that never got anywhere.
    ///
    /// Not `request_error`: that one says "could not reach FAF services", which
    /// is wrong twice over here. This is not FAF's service, and the usual cause
    /// is not the network but a server that is not running, which sending
    /// somebody off to check their connection actively hides. Naming the
    /// address is what turns it into something anybody can act on.
    fn unreachable(&self, error: reqwest::Error) -> RequestError {
        if error.is_connect() || error.is_timeout() {
            return RequestError::offline(format!(
                "Could not reach the tournament service at {}. If that is a local server, check it is running.",
                self.config.api_base
            ));
        }
        request_error(error)
    }

    async fn get(&self, path: &str, query: &[(&str, &str)]) -> Result<Value, RequestError> {
        self.send(reqwest::Method::GET, path, query, None).await
    }

    /// One write against a tournament. Every one of them is a `POST` to
    /// `/api/t/{id}/{action}`, whatever it does.
    async fn act(
        &self,
        tournament_id: &str,
        action: &str,
        body: Value,
    ) -> Result<(), RequestError> {
        self.send(
            reqwest::Method::POST,
            &format!("t/{}/{action}", encode(tournament_id)),
            &[],
            Some(body),
        )
        .await
        .map(|_| ())
    }
}

/// Percent-encode one path segment.
///
/// Tournament ids are server-generated handles like `e1a2b`, but they reach
/// this layer from state that has crossed into TypeScript and back, so nothing
/// here assumes they are safe to paste into a URL.
fn encode(segment: &str) -> String {
    url::form_urlencoded::byte_serialize(segment.as_bytes()).collect()
}

/// Turn a failed response into the category the UI acts on.
///
/// The distinction worth having here is 403. This service answers it for two
/// different things: "organiser rights required", and a rule the caller broke
/// such as confirming their own score. Neither is fixed by signing in again.
/// The server's own sentence says which, and it is far better than anything
/// this layer could invent, so it is passed through.
fn tourney_error(status: reqwest::StatusCode, body: &str) -> RequestError {
    let detail = error_detail(body);
    match status {
        reqwest::StatusCode::UNAUTHORIZED => {
            RequestError::unauthorized("Your FAF session has expired. Sign out and sign in again.")
        }
        reqwest::StatusCode::FORBIDDEN => RequestError::rejected(
            detail.unwrap_or_else(|| "You are not allowed to do that here.".to_string()),
        ),
        reqwest::StatusCode::NOT_FOUND => {
            RequestError::not_found("That tournament no longer exists.")
        }
        status if status.is_server_error() => RequestError::offline(
            "The tournament service is temporarily unavailable. Please try again shortly.",
        ),
        status if status.is_client_error() => RequestError::rejected(
            detail.unwrap_or_else(|| format!("The request was rejected ({status}).")),
        ),
        _ => RequestError::unexpected(format!(
            "The tournament service returned an unexpected status ({status})."
        )),
    }
}

/// The service reports every refusal as `{"error": "..."}`.
///
/// Surfaced verbatim, because these are written for the player and say the one
/// thing they need: which rating gate they missed, when check-in opens, how
/// many replay ids are still wanted. A generic "rejected" would throw all of
/// that away.
fn error_detail(body: &str) -> Option<String> {
    let value: Value = serde_json::from_str(body).ok()?;
    let message = value.get("error")?.as_str()?.trim();
    (!message.is_empty()).then(|| message.to_string())
}

#[async_trait]
impl TourneyPort for TourneyClient {
    async fn hosting(&self) -> Result<HostingStatus, RequestError> {
        let document = self.get("host_status", &[]).await?;
        Ok(tourney::parse_hosting(&document))
    }

    async fn create(&self, draft: &TourneyDraft) -> Result<String, RequestError> {
        // The one write that is not addressed to a tournament, and the only one
        // whose answer the client needs: the new id, so the organiser lands in
        // the event they just made.
        let document = self
            .send(
                reqwest::Method::POST,
                "tournaments",
                &[],
                Some(tourney::create_body(draft)),
            )
            .await?;
        document
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| {
                RequestError::unexpected("The tournament service did not return the new event.")
            })
    }

    async fn edit_info(
        &self,
        tournament_id: &str,
        draft: &TourneyDraft,
    ) -> Result<(), RequestError> {
        self.act(tournament_id, "edit_info", tourney::edit_info_body(draft))
            .await
    }

    async fn publish(&self, tournament_id: &str) -> Result<(), RequestError> {
        // No `publishAt`: an absent schedule means publish now, which is the
        // only thing this client offers.
        self.act(tournament_id, "publish", json!({})).await
    }

    async fn advance(
        &self,
        tournament_id: &str,
        phase: TourneyPhase,
        config: Option<&BracketConfig>,
    ) -> Result<(), RequestError> {
        self.act(tournament_id, "phase", tourney::phase_body(phase, config))
            .await
    }

    async fn archive(&self, tournament_id: &str) -> Result<(), RequestError> {
        // `delete` archives for anyone who is not a site admin, and the client
        // never holds that role, so this is reversible in practice.
        self.act(tournament_id, "delete", json!({})).await
    }

    async fn list(&self) -> Result<Vec<Tourney>, RequestError> {
        let document = self.get("tournaments", &[]).await?;
        Ok(tourney::parse_tourney_list(&document))
    }

    async fn detail(&self, tournament_id: &str) -> Result<Tourney, RequestError> {
        let document = self
            .get(&format!("t/{}", encode(tournament_id)), &[])
            .await?;
        tourney::parse_tourney(&document)
            .ok_or_else(|| RequestError::not_found("That tournament no longer exists."))
    }

    async fn sign_up(&self, tournament_id: &str) -> Result<(), RequestError> {
        // No body: with FAF login on, the server takes the entrant's name and
        // account from the session and refuses anything the caller claims.
        self.act(tournament_id, "signup", json!({})).await
    }

    async fn withdraw(&self, tournament_id: &str, player_id: &str) -> Result<(), RequestError> {
        self.act(tournament_id, "remove", json!({ "playerId": player_id }))
            .await
    }

    async fn create_team(&self, tournament_id: &str, name: &str) -> Result<(), RequestError> {
        self.act(tournament_id, "create_team", json!({ "name": name }))
            .await
    }

    async fn request_join(&self, tournament_id: &str, team_id: &str) -> Result<(), RequestError> {
        self.act(tournament_id, "request_join", json!({ "teamId": team_id }))
            .await
    }

    async fn cancel_join(&self, tournament_id: &str, team_id: &str) -> Result<(), RequestError> {
        self.act(tournament_id, "cancel_join", json!({ "teamId": team_id }))
            .await
    }

    async fn respond_join(
        &self,
        tournament_id: &str,
        team_id: &str,
        player_id: &str,
        accept: bool,
    ) -> Result<(), RequestError> {
        self.act(
            tournament_id,
            "respond_join",
            json!({ "teamId": team_id, "playerId": player_id, "accept": accept }),
        )
        .await
    }

    async fn invite_to_team(
        &self,
        tournament_id: &str,
        team_id: &str,
        player_id: &str,
    ) -> Result<(), RequestError> {
        self.act(
            tournament_id,
            "invite_to_team",
            json!({ "teamId": team_id, "playerId": player_id }),
        )
        .await
    }

    async fn respond_invite(
        &self,
        tournament_id: &str,
        team_id: &str,
        accept: bool,
    ) -> Result<(), RequestError> {
        self.act(
            tournament_id,
            "respond_invite",
            json!({ "teamId": team_id, "accept": accept }),
        )
        .await
    }

    async fn leave_team(&self, tournament_id: &str) -> Result<(), RequestError> {
        // No `targetPlayerId`: that field lets an organiser pull somebody else
        // out, and this is the player leaving of their own accord.
        self.act(tournament_id, "leave_team", json!({})).await
    }

    async fn disband_team(&self, tournament_id: &str, team_id: &str) -> Result<(), RequestError> {
        self.act(tournament_id, "disband_team", json!({ "teamId": team_id }))
            .await
    }

    async fn rename_team(
        &self,
        tournament_id: &str,
        team_id: &str,
        name: &str,
    ) -> Result<(), RequestError> {
        self.act(
            tournament_id,
            "rename_team",
            json!({ "teamId": team_id, "name": name }),
        )
        .await
    }

    async fn add_player(
        &self,
        tournament_id: &str,
        name: &str,
        rating: Option<i32>,
    ) -> Result<(), RequestError> {
        let mut body = json!({ "name": name });
        // Only an unrated tournament reads this. Sending it otherwise is
        // harmless but says something the server would ignore.
        if let Some(rating) = rating {
            body["rating"] = json!(rating);
        }
        self.act(tournament_id, "org_add_player", body).await
    }

    async fn set_captain(
        &self,
        tournament_id: &str,
        team_id: &str,
        player_id: &str,
    ) -> Result<(), RequestError> {
        self.act(
            tournament_id,
            "set_captain",
            json!({ "teamId": team_id, "playerId": player_id }),
        )
        .await
    }

    async fn move_player(
        &self,
        tournament_id: &str,
        player_id: &str,
        team_id: Option<&str>,
    ) -> Result<(), RequestError> {
        // An absent `teamId` is the instruction to park them: the server takes
        // them off their current team and puts them nowhere. Sending `null`
        // rather than omitting the key says the same thing and reads clearer.
        self.act(
            tournament_id,
            "move_player",
            json!({ "playerId": player_id, "teamId": team_id }),
        )
        .await
    }

    async fn edit_player(
        &self,
        tournament_id: &str,
        player_id: &str,
        note: &str,
        rating: Option<i32>,
    ) -> Result<(), RequestError> {
        // `name` is deliberately never sent. The server compares it against the
        // stored one and refuses any difference, so including it can only turn a
        // note edit into a refusal.
        let mut body = json!({ "playerId": player_id, "note": note });
        if let Some(rating) = rating {
            body["rating"] = json!(rating);
        }
        self.act(tournament_id, "edit_player", body).await
    }

    async fn respond_signup(
        &self,
        tournament_id: &str,
        player_id: &str,
        accept: bool,
    ) -> Result<(), RequestError> {
        self.act(
            tournament_id,
            "respond_signup",
            json!({ "playerId": player_id, "accept": accept }),
        )
        .await
    }

    async fn invite_player(&self, tournament_id: &str, name: &str) -> Result<(), RequestError> {
        self.act(tournament_id, "invite_player", json!({ "name": name }))
            .await
    }

    async fn uninvite(&self, tournament_id: &str, faf_id: i32) -> Result<(), RequestError> {
        // The server compares this against a string, so it goes as one.
        self.act(
            tournament_id,
            "uninvite_player",
            json!({ "fafId": faf_id.to_string() }),
        )
        .await
    }

    async fn reseed(&self, tournament_id: &str, order: &SeedOrder) -> Result<(), RequestError> {
        let body = match order {
            SeedOrder::Randomise => json!({ "randomize": true }),
            SeedOrder::Explicit { team_ids } => json!({ "order": team_ids }),
        };
        self.act(tournament_id, "reseed", body).await
    }

    async fn split_divisions(
        &self,
        tournament_id: &str,
        divisions: i32,
    ) -> Result<(), RequestError> {
        self.act(
            tournament_id,
            "split_divisions",
            json!({ "divisions": divisions }),
        )
        .await
    }

    async fn set_division(
        &self,
        tournament_id: &str,
        team_id: &str,
        division: i32,
    ) -> Result<(), RequestError> {
        self.act(
            tournament_id,
            "set_division",
            json!({ "teamId": team_id, "division": division }),
        )
        .await
    }

    async fn post_news(
        &self,
        tournament_id: &str,
        body: &str,
        important: bool,
    ) -> Result<(), RequestError> {
        self.act(
            tournament_id,
            "news_post",
            json!({ "body": body, "important": important }),
        )
        .await
    }

    async fn delete_news(&self, tournament_id: &str, news_id: &str) -> Result<(), RequestError> {
        self.act(tournament_id, "news_delete", json!({ "id": news_id }))
            .await
    }

    async fn check_in(&self, tournament_id: &str) -> Result<(), RequestError> {
        // The team is resolved from the session server-side; any member may
        // check the team in, which is the point of not naming one here.
        self.act(tournament_id, "checkin_team", json!({ "value": true }))
            .await
    }

    async fn confirm_report(
        &self,
        tournament_id: &str,
        match_id: &str,
        accept: bool,
    ) -> Result<(), RequestError> {
        self.act(
            tournament_id,
            "report_confirm",
            json!({ "matchId": match_id, "accept": accept }),
        )
        .await
    }

    async fn decide_report(
        &self,
        tournament_id: &str,
        report: &MatchReport,
    ) -> Result<(), RequestError> {
        let mut body = json!({ "matchId": report.match_id });
        // The bare forfeit is recognised by the *absence* of a score: sending
        // `score1: 0, score2: 0` alongside it would put the server on its normal
        // path and refuse a grand final that starts 1-0. So the shorthand sends
        // the forfeiting team and nothing else.
        if !report.is_bare_forfeit() {
            body["score1"] = json!(report.score1);
            body["score2"] = json!(report.score2);
        }
        if let Some(winner) = report.winner.as_deref() {
            body["winner"] = json!(winner);
        }
        if let Some(forfeit) = report.forfeit.as_deref() {
            body["forfeit"] = json!(forfeit);
        }
        // Only sent when there is something to store: the key's presence
        // *replaces* the stored set, so an empty list would wipe an archive an
        // organiser had already recorded elsewhere.
        if !report.replay_ids.is_empty() {
            body["replayIds"] = json!(report.replay_ids);
        }
        if !report.draw_replay_ids.is_empty() {
            body["drawReplayIds"] = json!(report.draw_replay_ids);
        }
        self.act(tournament_id, "report", body).await
    }

    async fn chat_rooms(&self, tournament_id: &str) -> Result<Vec<ChatRoom>, RequestError> {
        let document = self
            .get(&format!("t/{}/chat_rooms", encode(tournament_id)), &[])
            .await?;
        Ok(tourney::parse_chat_rooms(&document))
    }

    async fn chat_read(
        &self,
        tournament_id: &str,
        room_id: &str,
    ) -> Result<Vec<ChatPost>, RequestError> {
        // Without `since` the server sends the last 200 posts, which is the
        // whole room as far as a tournament is concerned. Reading also clears
        // this account's unread marker, which is why the client never has to
        // acknowledge one separately.
        let document = self
            .get(
                &format!("t/{}/chat_read", encode(tournament_id)),
                &[("room", room_id)],
            )
            .await?;
        Ok(tourney::parse_chat_posts(&document))
    }

    async fn chat_post(
        &self,
        tournament_id: &str,
        room_id: &str,
        body: &str,
    ) -> Result<(), RequestError> {
        self.act(
            tournament_id,
            "chat_post",
            json!({ "room": room_id, "text": body }),
        )
        .await
    }

    async fn articles(&self) -> Result<Vec<Article>, RequestError> {
        let document = self.get("articles", &[]).await?;
        Ok(tourney::parse_articles(&document))
    }

    async fn assign_pool(
        &self,
        tournament_id: &str,
        round_key: &str,
        pool_id: &str,
    ) -> Result<(), RequestError> {
        // An absent `poolId` clears the assignment rather than failing, which is
        // how the round tile's "no pool" option is expressed.
        self.act(
            tournament_id,
            "pool_assign",
            json!({ "key": round_key, "poolId": pool_id }),
        )
        .await
    }

    async fn draft_pick(&self, tournament_id: &str, player_id: &str) -> Result<(), RequestError> {
        self.act(tournament_id, "pick", json!({ "playerId": player_id }))
            .await
    }

    async fn draft_undo(&self, tournament_id: &str) -> Result<(), RequestError> {
        self.act(tournament_id, "undo_pick", json!({})).await
    }

    async fn set_captains(
        &self,
        tournament_id: &str,
        player_ids: &[String],
    ) -> Result<(), RequestError> {
        // `phase` again, like every other lifecycle step: the action name is in
        // the body, not the path.
        self.act(
            tournament_id,
            "phase",
            json!({ "action": "set_captains", "captainIds": player_ids }),
        )
        .await
    }

    async fn report_ffa(
        &self,
        tournament_id: &str,
        report: &FfaReport,
    ) -> Result<(), RequestError> {
        let mut body = json!({ "matchId": report.match_id });
        if report.points.is_empty() {
            body["winners"] = json!(report.winners);
        } else {
            // An object keyed by team id, which is how the handler indexes it.
            body["points"] = Value::Object(
                report
                    .points
                    .iter()
                    .map(|scored| (scored.team_id.clone(), json!(scored.points)))
                    .collect(),
            );
        }
        self.act(tournament_id, "report", body).await
    }

    async fn veto_act(
        &self,
        tournament_id: &str,
        match_id: &str,
        map_id: &str,
    ) -> Result<(), RequestError> {
        // `map` rather than `mapId`: the handler compares it against the ids in
        // `remaining`, case-insensitively, but the key is its own.
        self.act(
            tournament_id,
            "veto_action",
            json!({ "matchId": match_id, "map": map_id }),
        )
        .await
    }

    async fn veto_set_sides(
        &self,
        tournament_id: &str,
        match_id: &str,
        team_a: &str,
    ) -> Result<(), RequestError> {
        self.act(
            tournament_id,
            "veto_setab",
            json!({ "matchId": match_id, "teamA": team_a }),
        )
        .await
    }

    async fn veto_undo(&self, tournament_id: &str, match_id: &str) -> Result<(), RequestError> {
        self.act(tournament_id, "veto_undo", json!({ "matchId": match_id }))
            .await
    }

    async fn save_map(&self, tournament_id: &str, map: &MapDraft) -> Result<(), RequestError> {
        let mut body = json!({
            "name": map.name.trim(),
            "description": map.description.trim(),
            "published": map.published,
        });
        // An empty id means "add"; sending it anyway would have the service look
        // for a map called "" and refuse.
        if !map.id.is_empty() {
            body["id"] = json!(map.id);
        }
        self.act(tournament_id, "map_save", body).await
    }

    async fn publish_map(
        &self,
        tournament_id: &str,
        map_id: &str,
        published: bool,
    ) -> Result<(), RequestError> {
        self.act(
            tournament_id,
            "map_publish",
            json!({ "id": map_id, "published": published }),
        )
        .await
    }

    async fn delete_map(&self, tournament_id: &str, map_id: &str) -> Result<(), RequestError> {
        self.act(tournament_id, "map_delete", json!({ "id": map_id }))
            .await
    }

    async fn publish_pool(
        &self,
        tournament_id: &str,
        pool_id: &str,
        published: bool,
    ) -> Result<(), RequestError> {
        self.act(
            tournament_id,
            "pool_publish",
            json!({ "id": pool_id, "published": published }),
        )
        .await
    }

    async fn delete_pool(&self, tournament_id: &str, pool_id: &str) -> Result<(), RequestError> {
        self.act(tournament_id, "pool_delete", json!({ "id": pool_id }))
            .await
    }

    async fn save_pool(&self, tournament_id: &str, pool: &PoolDraft) -> Result<(), RequestError> {
        let mut body = json!({
            "name": pool.name,
            "mapIds": pool.map_ids,
            "bo": pool.best_of.unwrap_or(1),
            // Objects, and the side is upper case: `cleanSequence` keeps only
            // `{action, team}` pairs whose team is exactly `A` or `B`, and
            // silently drops the rest. Sending the serde spelling would post an
            // order and store none.
            "sequence": pool
                .sequence
                .iter()
                .map(|step| json!({ "action": step.action.as_wire(), "team": step.team.as_wire() }))
                .collect::<Vec<_>>(),
        });
        // An empty id creates; the server distinguishes on the key being
        // present at all, so it is left out rather than sent blank.
        if !pool.id.is_empty() {
            body["id"] = json!(pool.id);
        }
        self.act(tournament_id, "pool_save", body).await
    }

    async fn series(&self) -> Result<Vec<TourneySeries>, RequestError> {
        let document = self.get("series", &[]).await?;
        Ok(tourney::parse_series_list(&document))
    }

    async fn series_detail(&self, series_id: &str) -> Result<SeriesDetail, RequestError> {
        let document = self
            .get(&format!("series/{}", encode(series_id)), &[])
            .await?;
        tourney::parse_series_detail(&document)
            .ok_or_else(|| RequestError::not_found("That series no longer exists."))
    }

    async fn save_series(&self, draft: &SeriesDraft) -> Result<(), RequestError> {
        // Not a tournament write: `series` is a top-level collection, and all
        // three of its verbs are one POST distinguished by `action`.
        self.send(
            reqwest::Method::POST,
            "series",
            &[],
            Some(tourney::series_body(draft)),
        )
        .await
        .map(|_| ())
    }

    async fn delete_series(&self, series_id: &str) -> Result<(), RequestError> {
        self.send(
            reqwest::Method::POST,
            "series",
            &[],
            Some(tourney::delete_series_body(series_id)),
        )
        .await
        .map(|_| ())
    }

    async fn set_series(
        &self,
        tournament_id: &str,
        series_id: Option<&str>,
    ) -> Result<(), RequestError> {
        self.act(
            tournament_id,
            "set_series",
            tourney::set_series_body(series_id),
        )
        .await
    }

    async fn add_qualifier(
        &self,
        tournament_id: &str,
        qualifier_id: &str,
        rule: QualifierRule,
    ) -> Result<(), RequestError> {
        self.act(
            tournament_id,
            "qualifier_add",
            tourney::qualifier_add_body(qualifier_id, rule),
        )
        .await
    }

    async fn remove_qualifier(
        &self,
        tournament_id: &str,
        link_id: &str,
    ) -> Result<(), RequestError> {
        self.act(
            tournament_id,
            "qualifier_remove",
            tourney::qualifier_remove_body(link_id),
        )
        .await
    }

    async fn edit_format(
        &self,
        tournament_id: &str,
        format: &FormatDraft,
        structural: bool,
    ) -> Result<(), RequestError> {
        self.act(
            tournament_id,
            "edit_format",
            tourney::edit_format_body(format, structural),
        )
        .await
    }

    async fn mute_chat(
        &self,
        tournament_id: &str,
        faf_id: i32,
        name: &str,
        muted: bool,
    ) -> Result<(), RequestError> {
        self.act(
            tournament_id,
            "chat_mute",
            tourney::chat_mute_body(faf_id, name, muted),
        )
        .await
    }

    async fn delete_chat_post(
        &self,
        tournament_id: &str,
        room_id: &str,
        post_id: &str,
    ) -> Result<(), RequestError> {
        self.act(
            tournament_id,
            "chat_delete",
            tourney::chat_delete_body(room_id, post_id),
        )
        .await
    }

    async fn add_organiser(
        &self,
        tournament_id: &str,
        faf_id: i32,
        name: &str,
    ) -> Result<(), RequestError> {
        self.act(
            tournament_id,
            "add_organizer",
            tourney::add_organiser_body(faf_id, name),
        )
        .await
    }

    async fn set_organiser_visibility(
        &self,
        tournament_id: &str,
        faf_id: i32,
        hidden: bool,
    ) -> Result<(), RequestError> {
        self.act(
            tournament_id,
            "organizer_visibility",
            tourney::organiser_visibility_body(faf_id, hidden),
        )
        .await
    }

    async fn abandon(&self, tournament_id: &str, abandoned: bool) -> Result<(), RequestError> {
        self.act(tournament_id, "abandon", tourney::abandon_body(abandoned))
            .await
    }

    async fn edit_news(
        &self,
        tournament_id: &str,
        news_id: &str,
        body: &str,
        important: bool,
    ) -> Result<(), RequestError> {
        self.act(
            tournament_id,
            "news_edit",
            tourney::edit_news_body(news_id, body, important),
        )
        .await
    }

    async fn mark_news_read(&self, tournament_id: &str) -> Result<(), RequestError> {
        // No body: the service reads the account off the session and marks
        // every announcement up to the newest one.
        self.act(tournament_id, "news_read", json!({})).await
    }

    async fn set_caster(
        &self,
        tournament_id: &str,
        faf_id: i32,
        name: &str,
        casting: bool,
    ) -> Result<(), RequestError> {
        // Two endpoints rather than a flag, unlike muting: removal takes only
        // the id, so there is nothing for a shared body to carry.
        if casting {
            self.act(
                tournament_id,
                "add_caster",
                tourney::add_caster_body(faf_id, name),
            )
            .await
        } else {
            self.act(
                tournament_id,
                "remove_caster",
                tourney::remove_caster_body(faf_id),
            )
            .await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use faf_domain::state::{PoolAction, PoolSide};
    use serde_json::json;

    fn client(base: &str) -> TourneyClient {
        TourneyClient::new(
            TourneyConfig {
                api_base: base.into(),
            },
            TokenStore::new(),
        )
    }

    #[test]
    fn paths_hang_off_the_configured_base() {
        let deployed = client("https://tournaments.doodlepros.com");
        assert_eq!(
            deployed.url("t/e1a2b/signup").unwrap().as_str(),
            "https://tournaments.doodlepros.com/api/t/e1a2b/signup"
        );
        // A base with a trailing slash is the same base.
        assert_eq!(
            client("http://localhost:3000/")
                .url("tournaments")
                .unwrap()
                .as_str(),
            "http://localhost:3000/api/tournaments"
        );
    }

    #[test]
    fn a_pool_step_is_spelled_the_way_the_service_reads_it() {
        // `lib/match.js::cleanSequence` keeps a step only if its team is exactly
        // `A` or `B`, and drops anything else without an error. The serde
        // spelling of `PoolSide` is lower case, so sending the enum straight
        // through would post a ban/pick order and store an empty one.
        assert_eq!(PoolSide::A.as_wire(), "A");
        assert_eq!(PoolSide::B.as_wire(), "B");
        assert_eq!(PoolAction::Ban.as_wire(), "ban");
        assert_eq!(PoolAction::Pick.as_wire(), "pick");

        // And the round trip holds, which is what keeps an edited pool the same
        // pool: read the service's spelling, write it back unchanged.
        for side in [PoolSide::A, PoolSide::B] {
            assert_eq!(PoolSide::from_wire(side.as_wire()), side);
        }
        for action in [PoolAction::Ban, PoolAction::Pick] {
            assert_eq!(PoolAction::from_wire(action.as_wire()), action);
        }
    }

    #[test]
    fn an_id_cannot_escape_its_path_segment() {
        // Ids reach this layer from state that has been through TypeScript.
        let url = client("https://tournaments.doodlepros.com")
            .url(&format!("t/{}/signup", encode("../../admin")))
            .unwrap();
        assert_eq!(url.path(), "/api/t/..%2F..%2Fadmin/signup");
    }

    #[tokio::test]
    async fn every_route_needs_a_session() {
        // The service shows an anonymous caller nothing, so failing here is
        // better than a request that can only come back empty.
        let error = client("https://tournaments.doodlepros.com")
            .list()
            .await
            .expect_err("no token");
        assert!(matches!(error, RequestError::Unauthorized(_)));
    }

    #[test]
    fn a_refusal_reaches_the_player_in_the_servers_own_words() {
        // The whole reason for passing 403 through: this sentence tells the
        // player which gate they missed, and nothing this layer could write
        // would come close.
        let error = tourney_error(
            reqwest::StatusCode::BAD_REQUEST,
            &json!({ "error": "You can’t sign up here: your rating (1420) is below this tournament’s minimum of 1500." })
                .to_string(),
        );
        assert!(matches!(error, RequestError::Rejected(_)));
        assert!(error.message().contains("1500"));
    }

    #[test]
    fn a_missing_role_is_not_an_expired_session() {
        // 403 here means the account is signed in and simply may not do this;
        // reading it as an auth problem would send the user off to re-login.
        let forbidden = tourney_error(
            reqwest::StatusCode::FORBIDDEN,
            &json!({ "error": "Organizer rights required" }).to_string(),
        );
        assert!(matches!(forbidden, RequestError::Rejected(_)));
        assert_eq!(forbidden.message(), "Organizer rights required");

        assert!(matches!(
            tourney_error(reqwest::StatusCode::UNAUTHORIZED, ""),
            RequestError::Unauthorized(_)
        ));
    }

    #[test]
    fn a_server_failure_reads_as_temporary() {
        // Offline rather than Rejected: retrying is the right advice, and the
        // player's score must not look like the problem.
        assert!(matches!(
            tourney_error(reqwest::StatusCode::BAD_GATEWAY, ""),
            RequestError::Offline(_)
        ));
    }

    #[test]
    fn a_rejection_without_a_readable_body_still_says_something() {
        let error = tourney_error(reqwest::StatusCode::BAD_REQUEST, "<html>nope");
        assert!(matches!(error, RequestError::Rejected(_)));
        assert!(error.message().contains("400"));
    }
}
