//! Clan management against `faf-java-api`.
//!
//! Two families of request, because the API has two. `ClansController`
//! (`/clans/**`) covers the three operations JSON:API cannot express, and each
//! takes its parameters in the *query string* rather than a body, which is
//! unusual enough here to be worth stating: `POST /clans/create?name=&tag=`
//! carries no request body at all. Everything else is ordinary Elide against
//! `/data/clan` and `/data/clanMembership`.
//!
//! The clan is read out of the *player* document rather than `GET /data/clan`,
//! reusing the player card's parser: the screen this feeds is about the clan
//! this account is in, and `joinedAt` only exists relative to a membership.

use async_trait::async_trait;
use faf_domain::state::{ClanDraft, ClanIdentity, PlayerClan};
use serde_json::{json, Value};

use crate::infra::env_or;
use crate::infra::jsonapi::{
    delete_resource_typed, fetch_document_typed, patch_document, request_error, write_error,
};
use crate::infra::player_card::clan_from_player_document;
use crate::infra::session::TokenStore;
use crate::ports::{ClanPort, RequestError};

#[derive(Debug, Clone)]
pub struct ClanConfig {
    pub api_base: String,
}

impl ClanConfig {
    pub fn faf() -> Self {
        Self {
            api_base: env_or("FAF_API_BASE", "https://api.faforever.com"),
        }
    }
}

pub struct ClanClient {
    config: ClanConfig,
    tokens: TokenStore,
    http: reqwest::Client,
}

impl ClanClient {
    pub fn new(config: ClanConfig, tokens: TokenStore) -> Self {
        Self {
            config,
            tokens,
            http: super::http::shared_http_client(),
        }
    }

    pub fn faf(tokens: TokenStore) -> Self {
        Self::new(ClanConfig::faf(), tokens)
    }

    fn token(&self) -> Result<String, RequestError> {
        self.tokens
            .get()
            .ok_or_else(|| RequestError::unauthorized("You are not signed in to FAF."))
    }

    fn url(&self, path: &str) -> Result<url::Url, RequestError> {
        url::Url::parse(&format!("{}{path}", self.config.api_base))
            .map_err(|error| RequestError::unexpected(format!("invalid API base: {error}")))
    }

    /// One of `ClansController`'s query-parameter endpoints.
    ///
    /// Both the GETs and the POSTs there take their arguments this way and
    /// answer plain JSON rather than JSON:API, so neither the document helpers
    /// nor a request body apply.
    async fn controller(
        &self,
        method: reqwest::Method,
        path: &str,
        params: &[(&str, String)],
    ) -> Result<Value, RequestError> {
        let token = self.token()?;
        let mut url = self.url(path)?;
        url.query_pairs_mut()
            .extend_pairs(params.iter().map(|(key, value)| (*key, value.as_str())));

        let response = self
            .http
            .request(method, url.clone())
            .bearer_auth(token)
            .header(reqwest::header::ACCEPT, "application/json")
            .send()
            .await
            .map_err(request_error)?;

        let status = response.status();
        let body = response.text().await.map_err(request_error)?;
        if !status.is_success() {
            return Err(write_error(status, url.path(), &body));
        }
        // `joinClan` answers 200 with no body at all.
        if body.trim().is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&body)
            .map_err(|error| RequestError::unexpected(format!("invalid server response: {error}")))
    }
}

#[async_trait]
impl ClanPort for ClanClient {
    async fn me(&self) -> Result<ClanIdentity, RequestError> {
        let body = self
            .controller(reqwest::Method::GET, "/clans/me", &[])
            .await?;
        Ok(identity_from_me(&body))
    }

    async fn clan(&self, player_id: i32) -> Result<PlayerClan, RequestError> {
        let token = self.token()?;
        let mut url = self.url("/data/player")?;
        url.query_pairs_mut()
            .append_pair("filter", &format!("id=={player_id}"))
            .append_pair(
                "include",
                "clanMembership.clan.memberships.player,clanMembership.clan.leader,clanMembership.clan.founder",
            )
            .append_pair("page[size]", "1");

        let doc = fetch_document_typed(&self.http, url, &token).await?;
        clan_from_player_document(&doc).ok_or_else(|| {
            // Not an error condition the caller can act on differently: it is
            // what the API says when the membership is gone, which is exactly
            // what a reload after leaving or being removed should see.
            RequestError::not_found("That account is not in a clan.")
        })
    }

    async fn create(&self, draft: &ClanDraft) -> Result<String, RequestError> {
        let body = self
            .controller(
                reqwest::Method::POST,
                "/clans/create",
                &[
                    ("name", draft.name.clone()),
                    ("tag", draft.tag.clone()),
                    ("description", draft.description.clone()),
                ],
            )
            .await?;
        // `{"id": 42, "type": "clan"}`. The id is a number here and a string
        // everywhere in JSON:API, so it is normalised on the way in rather
        // than leaving every consumer to cope with both.
        Ok(json_id(&body, "id"))
    }

    async fn edit(&self, clan_id: &str, draft: &ClanDraft) -> Result<(), RequestError> {
        let url = self.url(&format!("/data/clan/{clan_id}"))?;
        let token = self.token()?;
        patch_document(
            &self.http,
            url,
            &token,
            json!({
                "type": "clan",
                "id": clan_id,
                "attributes": {
                    "name": draft.name,
                    "tag": draft.tag,
                    "description": draft.description,
                },
            }),
        )
        .await
    }

    async fn hand_over(&self, clan_id: &str, player_id: i32) -> Result<(), RequestError> {
        let url = self.url(&format!("/data/clan/{clan_id}"))?;
        let token = self.token()?;
        // A relationship rather than an attribute, which is why this cannot go
        // through the attributes-only helper the other writes use.
        patch_document(
            &self.http,
            url,
            &token,
            json!({
                "type": "clan",
                "id": clan_id,
                "relationships": {
                    "leader": {
                        "data": { "type": "player", "id": player_id.to_string() },
                    },
                },
            }),
        )
        .await
    }

    async fn invite(&self, clan_id: &str, player_id: i32) -> Result<String, RequestError> {
        let body = self
            .controller(
                reqwest::Method::GET,
                "/clans/generateInvitationLink",
                &[
                    ("clanId", clan_id.to_string()),
                    ("playerId", player_id.to_string()),
                ],
            )
            .await?;
        let token = body
            .get("jwtToken")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if token.is_empty() {
            return Err(RequestError::unexpected(
                "FAF accepted the invitation but did not return a token.".to_string(),
            ));
        }
        Ok(token)
    }

    async fn accept_invitation(&self, token: &str) -> Result<(), RequestError> {
        self.controller(
            reqwest::Method::POST,
            "/clans/joinClan",
            &[("token", token.to_string())],
        )
        .await
        .map(|_| ())
    }

    async fn remove_membership(&self, membership_id: &str) -> Result<(), RequestError> {
        let url = self.url(&format!("/data/clanMembership/{membership_id}"))?;
        let token = self.token()?;
        delete_resource_typed(&self.http, url, &token).await
    }

    async fn disband(&self, clan_id: &str) -> Result<(), RequestError> {
        let url = self.url(&format!("/data/clan/{clan_id}"))?;
        let token = self.token()?;
        delete_resource_typed(&self.http, url, &token).await
    }
}

/// `{ "player": {"id":1,"login":"x"}, "clan": {"id":2,"name":"y","tag":"z"} }`,
/// with `clan` absent or null when the account is in none.
fn identity_from_me(body: &Value) -> ClanIdentity {
    let player = body.get("player");
    let clan = body.get("clan").filter(|value| !value.is_null());
    ClanIdentity {
        player_id: player
            .and_then(|player| player.get("id"))
            .and_then(Value::as_i64)
            .unwrap_or_default() as i32,
        login: player
            .and_then(|player| player.get("login"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        clan_id: clan.map(|clan| json_id(clan, "id")).unwrap_or_default(),
        clan_name: clan
            .and_then(|clan| clan.get("name"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        clan_tag: clan
            .and_then(|clan| clan.get("tag"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        // Resolved by the service from the clan document; this endpoint does
        // not say, and guessing here would be a second opinion about the one
        // thing the server already decides.
        is_leader: false,
    }
}

/// An id that is a number in `ClansController`'s answers and a string in every
/// JSON:API document, read as the string the rest of the client uses.
fn json_id(value: &Value, key: &str) -> String {
    match value.get(key) {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => number.to_string(),
        _ => String::new(),
    }
}

/// Offline stand-in. Reports rather than pretending, like the other fakes: a
/// clan the client invented would be worse than an empty screen.
pub struct FakeClan;

#[async_trait]
impl ClanPort for FakeClan {
    async fn me(&self) -> Result<ClanIdentity, RequestError> {
        Ok(ClanIdentity::default())
    }

    async fn clan(&self, _player_id: i32) -> Result<PlayerClan, RequestError> {
        Err(RequestError::not_found("That account is not in a clan."))
    }

    async fn create(&self, _draft: &ClanDraft) -> Result<String, RequestError> {
        Err(offline())
    }

    async fn edit(&self, _clan_id: &str, _draft: &ClanDraft) -> Result<(), RequestError> {
        Err(offline())
    }

    async fn hand_over(&self, _clan_id: &str, _player_id: i32) -> Result<(), RequestError> {
        Err(offline())
    }

    async fn invite(&self, _clan_id: &str, _player_id: i32) -> Result<String, RequestError> {
        Err(offline())
    }

    async fn accept_invitation(&self, _token: &str) -> Result<(), RequestError> {
        Err(offline())
    }

    async fn remove_membership(&self, _membership_id: &str) -> Result<(), RequestError> {
        Err(offline())
    }

    async fn disband(&self, _clan_id: &str) -> Result<(), RequestError> {
        Err(offline())
    }
}

fn offline() -> RequestError {
    RequestError::offline("Clans are unavailable in offline mode.")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn me_reads_an_account_that_is_in_a_clan() {
        let body = json!({
            "player": { "id": 7, "login": "Sheikah" },
            "clan": { "id": 42, "name": "Brotherhood", "tag": "BRO" },
        });
        let identity = identity_from_me(&body);
        assert_eq!(identity.player_id, 7);
        assert_eq!(identity.login, "Sheikah");
        // A number on this endpoint, a string everywhere else: normalised here
        // so nothing downstream has to know which it was.
        assert_eq!(identity.clan_id, "42");
        assert_eq!(identity.clan_tag, "BRO");
        assert!(identity.in_a_clan());
        assert!(
            !identity.is_leader,
            "this endpoint does not say, so it must not claim to"
        );
    }

    #[test]
    fn me_reads_an_account_that_is_in_none() {
        // The field is present and null rather than absent, which a plain
        // `get("clan")` would have read as an object.
        let identity = identity_from_me(&json!({
            "player": { "id": 7, "login": "Sheikah" },
            "clan": null,
        }));
        assert!(!identity.in_a_clan());
        assert_eq!(identity.clan_id, "");
        assert_eq!(identity.player_id, 7);
    }

    #[test]
    fn an_answer_missing_everything_is_read_as_no_clan_rather_than_a_failure() {
        let identity = identity_from_me(&json!({}));
        assert!(!identity.in_a_clan());
        assert_eq!(identity.player_id, 0);
    }
}
