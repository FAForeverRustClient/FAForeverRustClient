//! Real OAuth2 auth provider — FAF's Ory Hydra, Authorization Code + PKCE flow.
//!
//! This is the production implementation of [`AuthPort`]. It performs the whole
//! interactive login behind the trait's `login()` call, so the auth service, the
//! `auth` slice and the UI are completely unaware of OAuth (ARCHITECTURE.md §5):
//!
//! 1. bind a loopback redirect listener on an ephemeral port;
//! 2. open the system browser at Hydra's `/oauth2/auth` (PKCE `S256`);
//! 3. receive the `code` on the loopback socket;
//! 4. exchange the code for tokens at `/oauth2/token` (public client, no secret);
//! 5. persist the refresh token in the OS keyring (best-effort);
//! 6. look up the player at `/me` and return it.
//!
//! Native FAF protocol values are taken from the reference clients; everything is
//! overridable via [`OAuthConfig::from_env`] so a partner dev can point at staging.

use std::time::Duration;

use async_trait::async_trait;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use faf_domain::state::Player;
use rand::RngCore;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use url::Url;

use crate::infra::session::TokenStore;
use crate::ports::{AuthError, AuthPort, AuthResult};

/// How long we wait for the user to finish the browser login before giving up.
const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);

/// Endpoints and client identity for the OAuth2 flow. Defaults target FAF prod.
#[derive(Debug, Clone)]
pub struct OAuthConfig {
    /// Ory Hydra base URL, e.g. `https://hydra.faforever.com`.
    pub hydra_base: String,
    /// FAF API base URL, e.g. `https://api.faforever.com`.
    pub api_base: String,
    /// Public OAuth2 client id (PKCE, no secret).
    pub client_id: String,
    /// Space-separated scopes.
    pub scopes: String,
    /// Keyring service name under which the refresh token is stored.
    pub keyring_service: String,
}

impl OAuthConfig {
    /// FAF production defaults (mirrors the reference clients' config).
    pub fn faf() -> Self {
        Self {
            hydra_base: "https://hydra.faforever.com".into(),
            api_base: "https://api.faforever.com".into(),
            // Public PKCE client id registered with FAF Hydra.
            client_id: "95ecec08-29c1-4c48-ae0a-b000ff349cb8".into(),
            scopes: "openid offline public_profile upload_map upload_mod lobby".into(),
            keyring_service: "forge-client".into(),
        }
    }

    /// Like [`Self::faf`] but lets each value be overridden via environment
    /// variables (`FAF_HYDRA_BASE`, `FAF_API_BASE`, `FAF_OAUTH_CLIENT_ID`,
    /// `FAF_OAUTH_SCOPES`) — handy for pointing at staging.
    pub fn from_env() -> Self {
        let base = Self::faf();
        Self {
            hydra_base: env_or("FAF_HYDRA_BASE", base.hydra_base),
            api_base: env_or("FAF_API_BASE", base.api_base),
            client_id: env_or("FAF_OAUTH_CLIENT_ID", base.client_id),
            scopes: env_or("FAF_OAUTH_SCOPES", base.scopes),
            keyring_service: base.keyring_service,
        }
    }
}

fn env_or(key: &str, fallback: String) -> String {
    std::env::var(key).ok().filter(|v| !v.is_empty()).unwrap_or(fallback)
}

/// Production [`AuthPort`]: OAuth2 Authorization Code + PKCE against FAF Hydra.
pub struct OAuthAuth {
    config: OAuthConfig,
    http: reqwest::Client,
    /// Shared access-token store, read by network ports (e.g. the lobby client).
    tokens: TokenStore,
}

impl OAuthAuth {
    pub fn new(config: OAuthConfig, tokens: TokenStore) -> Self {
        Self {
            config,
            http: reqwest::Client::new(),
            tokens,
        }
    }

    /// Construct with FAF defaults and a standalone token store, honouring env
    /// overrides. Use [`Self::new`] to share a store with other ports.
    pub fn faf() -> Self {
        Self::new(OAuthConfig::from_env(), TokenStore::new())
    }
}

#[async_trait]
impl AuthPort for OAuthAuth {
    async fn login(&self) -> AuthResult<Player> {
        // 1. Loopback redirect listener on an ephemeral port. Hydra allows any
        //    127.0.0.1 port for native apps (RFC 8252), so no fixed port needed.
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| AuthError::new(format!("Could not open redirect listener: {e}")))?;
        let port = listener
            .local_addr()
            .map_err(|e| AuthError::new(format!("Could not read redirect port: {e}")))?
            .port();
        let redirect_uri = format!("http://127.0.0.1:{port}");

        // 2. PKCE + CSRF material and the authorize URL.
        let verifier = random_token(32);
        let challenge = pkce_challenge(&verifier);
        let state = random_token(16);
        let auth_url = build_authorize_url(&self.config, &state, &challenge, &redirect_uri);

        // 3. Hand the URL to the system browser. spawn_blocking: `open` shells out.
        let opened = tokio::task::spawn_blocking(move || open::that(&auth_url)).await;
        match opened {
            Ok(Ok(())) => {}
            Ok(Err(e)) => return Err(AuthError::new(format!("Could not open browser: {e}"))),
            Err(e) => return Err(AuthError::new(format!("Browser task failed: {e}"))),
        }

        // 4. Wait for the browser redirect (bounded so we never hang forever).
        let redirect = tokio::time::timeout(LOGIN_TIMEOUT, accept_redirect(&listener))
            .await
            .map_err(|_| AuthError::new("Login timed out waiting for the browser."))??;

        if redirect.state.as_deref() != Some(state.as_str()) {
            return Err(AuthError::new("Login failed: state mismatch (possible CSRF)."));
        }
        if let Some(error) = redirect.error {
            return Err(AuthError::new(format!("Login was denied: {error}")));
        }
        let code = redirect
            .code
            .ok_or_else(|| AuthError::new("Login failed: no authorization code returned."))?;

        // 5. Exchange the code for tokens.
        let tokens = self.exchange_code(&code, &verifier, &redirect_uri).await?;

        // 6. Make the access token available to network ports (e.g. lobby).
        self.tokens.set(&tokens.access_token);

        // 7. Persist the refresh token (best-effort — a keyring failure must not
        //    block an otherwise successful login).
        if let Some(refresh) = &tokens.refresh_token {
            self.store_refresh_token(refresh);
        }

        // 8. Resolve the player.
        self.fetch_me(&tokens.access_token).await
    }

    async fn logout(&self) -> AuthResult<()> {
        // Best-effort: drop both the in-memory access token and the stored refresh
        // token. The session itself is torn down by the auth slice regardless.
        self.tokens.clear();
        if let Ok(entry) = keyring::Entry::new(&self.config.keyring_service, "refresh_token") {
            let _ = entry.delete_credential();
        }
        Ok(())
    }
}

impl OAuthAuth {
    async fn exchange_code(
        &self,
        code: &str,
        verifier: &str,
        redirect_uri: &str,
    ) -> AuthResult<TokenResponse> {
        let params = [
            ("grant_type", "authorization_code"),
            ("code", code),
            ("code_verifier", verifier),
            ("client_id", self.config.client_id.as_str()),
            ("redirect_uri", redirect_uri),
        ];
        let resp = self
            .http
            .post(format!("{}/oauth2/token", self.config.hydra_base))
            .form(&params)
            .send()
            .await
            .map_err(|e| AuthError::new(format!("Token request failed: {e}")))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(AuthError::new(format!(
                "Token exchange rejected ({status}): {body}"
            )));
        }

        resp.json::<TokenResponse>()
            .await
            .map_err(|e| AuthError::new(format!("Could not parse token response: {e}")))
    }

    async fn fetch_me(&self, access_token: &str) -> AuthResult<Player> {
        let resp = self
            .http
            .get(format!("{}/me", self.config.api_base))
            .bearer_auth(access_token)
            .header(reqwest::header::ACCEPT, "application/json")
            .send()
            .await
            .map_err(|e| AuthError::new(format!("/me request failed: {e}")))?;

        if !resp.status().is_success() {
            return Err(AuthError::new(format!(
                "Could not load profile (/me returned {})",
                resp.status()
            )));
        }

        // Parse leniently from a Value so a number-vs-string field never breaks
        // login, and keep the raw body to make any real shape mismatch diagnosable.
        let body = resp
            .text()
            .await
            .map_err(|e| AuthError::new(format!("Could not read /me response: {e}")))?;
        let value: Value = serde_json::from_str(&body)
            .map_err(|e| AuthError::new(format!("/me was not JSON: {e}; body: {}", snippet(&body))))?;
        player_from_me(&value)
            .ok_or_else(|| AuthError::new(format!("Unexpected /me shape; body: {}", snippet(&body))))
    }

    fn store_refresh_token(&self, refresh_token: &str) {
        if let Ok(entry) = keyring::Entry::new(&self.config.keyring_service, "refresh_token") {
            let _ = entry.set_password(refresh_token);
        }
    }
}

/// Parsed query parameters from the OAuth redirect.
struct Redirect {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

/// Accept a single loopback connection and parse the OAuth redirect from its
/// request line, then send a minimal HTML page back to the browser.
async fn accept_redirect(listener: &TcpListener) -> AuthResult<Redirect> {
    let (mut stream, _) = listener
        .accept()
        .await
        .map_err(|e| AuthError::new(format!("Redirect connection failed: {e}")))?;

    // Read only the request line — that carries `?code=...&state=...`.
    let request_line = {
        let mut reader = BufReader::new(&mut stream);
        let mut line = String::new();
        reader
            .read_line(&mut line)
            .await
            .map_err(|e| AuthError::new(format!("Could not read redirect request: {e}")))?;
        line
    };

    let redirect = parse_redirect_request(&request_line)?;
    let success = redirect.error.is_none() && redirect.code.is_some();

    let body = response_html(success);
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.flush().await;

    Ok(redirect)
}

/// SHA-256 → base64url (no padding) of the PKCE verifier (RFC 7636 `S256`).
fn pkce_challenge(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}

/// Random base64url token of `n` bytes of entropy (used for verifier and state).
fn random_token(n: usize) -> String {
    let mut bytes = vec![0u8; n];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Build Hydra's authorize URL. Pure (no IO) so it can be unit-tested.
fn build_authorize_url(
    config: &OAuthConfig,
    state: &str,
    challenge: &str,
    redirect_uri: &str,
) -> String {
    let mut url = Url::parse(&format!("{}/oauth2/auth", config.hydra_base))
        .expect("hydra_base must be a valid URL");
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", &config.client_id)
        .append_pair("state", state)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("scope", &config.scopes)
        .append_pair("code_challenge_method", "S256")
        .append_pair("code_challenge", challenge);
    url.into()
}

/// Parse the HTTP request line (`GET /?code=...&state=... HTTP/1.1`) into the
/// OAuth redirect parameters. Pure, so it can be unit-tested.
fn parse_redirect_request(request_line: &str) -> AuthResult<Redirect> {
    let target = request_line
        .split_whitespace()
        .nth(1)
        .ok_or_else(|| AuthError::new("Malformed redirect request."))?;

    // Resolve against a dummy base so relative targets parse into a full URL.
    let url = Url::parse("http://127.0.0.1")
        .and_then(|base| base.join(target))
        .map_err(|e| AuthError::new(format!("Could not parse redirect URL: {e}")))?;

    let mut redirect = Redirect {
        code: None,
        state: None,
        error: None,
    };
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "code" => redirect.code = Some(value.into_owned()),
            "state" => redirect.state = Some(value.into_owned()),
            "error" => redirect.error = Some(value.into_owned()),
            _ => {}
        }
    }
    Ok(redirect)
}

fn response_html(success: bool) -> String {
    let (title, message) = if success {
        ("Signed in", "You can close this tab and return to Forge Client.")
    } else {
        ("Sign-in failed", "Something went wrong. Return to Forge Client and try again.")
    };
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>{title}</title></head>\
         <body style=\"font-family:system-ui;text-align:center;padding-top:4rem\">\
         <h2>{title}</h2><p>{message}</p></body></html>"
    )
}

/// Hydra's token endpoint response (only the fields we use).
#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
}

/// Extract the player from a FAF `/me` JSON:API document.
///
/// Shape: `{ "data": { "id": "me", "attributes": { "userId": …, "userName": … } } }`.
/// `data.id` is the literal `"me"`, so the numeric id comes from
/// `attributes.userId`; `data.id` is only a fallback. Parsed leniently from a
/// [`Value`] because `userId` may arrive as a number or a string.
fn player_from_me(value: &Value) -> Option<Player> {
    let data = value.get("data")?;
    let attributes = data.get("attributes");

    let name = attributes
        .and_then(|a| a.get("userName"))
        .or_else(|| attributes.and_then(|a| a.get("login")))
        .and_then(Value::as_str)?
        .to_string();

    let id = json_id(attributes.and_then(|a| a.get("userId")))
        .or_else(|| json_id(data.get("id")))?;

    Some(Player { id, name })
}

/// Read an id that the server may encode as a JSON number or a string.
fn json_id(value: Option<&Value>) -> Option<i32> {
    match value? {
        Value::Number(n) => n.as_i64().and_then(|v| i32::try_from(v).ok()),
        Value::String(s) => s.parse().ok(),
        _ => None,
    }
}

/// First 300 chars of a body, for embedding in diagnostic error messages.
fn snippet(body: &str) -> String {
    body.chars().take(300).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_matches_rfc7636_vector() {
        // RFC 7636 Appendix B reference vector.
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert_eq!(
            pkce_challenge(verifier),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn random_token_is_url_safe_and_sized() {
        let token = random_token(32);
        // 32 bytes → 43 base64url chars (no padding), URL-safe alphabet only.
        assert_eq!(token.len(), 43);
        assert!(token.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }

    #[test]
    fn authorize_url_carries_pkce_and_redirect() {
        let cfg = OAuthConfig::faf();
        let url = build_authorize_url(&cfg, "st4te", "ch4llenge", "http://127.0.0.1:54321");
        assert!(url.starts_with("https://hydra.faforever.com/oauth2/auth?"));
        assert!(url.contains("response_type=code"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("code_challenge=ch4llenge"));
        assert!(url.contains("state=st4te"));
        // redirect_uri is percent-encoded.
        assert!(url.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A54321"));
        assert!(url.contains(&format!("client_id={}", cfg.client_id)));
    }

    #[test]
    fn parses_code_and_state_from_request_line() {
        let line = "GET /?code=abc123&state=xyz HTTP/1.1\r\n";
        let r = parse_redirect_request(line).unwrap();
        assert_eq!(r.code.as_deref(), Some("abc123"));
        assert_eq!(r.state.as_deref(), Some("xyz"));
        assert_eq!(r.error, None);
    }

    #[test]
    fn parses_error_from_request_line() {
        let line = "GET /?error=access_denied&state=xyz HTTP/1.1\r\n";
        let r = parse_redirect_request(line).unwrap();
        assert_eq!(r.error.as_deref(), Some("access_denied"));
        assert_eq!(r.code, None);
    }

    #[test]
    fn token_response_deserializes() {
        let json = r#"{"access_token":"at","refresh_token":"rt","expires_in":3600}"#;
        let parsed: TokenResponse = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.access_token, "at");
        assert_eq!(parsed.refresh_token.as_deref(), Some("rt"));
    }

    fn me(json: &str) -> Option<Player> {
        player_from_me(&serde_json::from_str(json).unwrap())
    }

    #[test]
    fn me_maps_to_player_with_string_user_id() {
        // Real FAF shape: data.id is the literal "me"; numeric id is in attributes.
        let player =
            me(r#"{"data":{"id":"me","type":"me","attributes":{"userName":"Sheikah","userId":"3408"}}}"#)
                .unwrap();
        assert_eq!(player.id, 3408);
        assert_eq!(player.name, "Sheikah");
    }

    #[test]
    fn me_maps_to_player_with_numeric_user_id() {
        // userId may arrive as a JSON number rather than a string.
        let player =
            me(r#"{"data":{"id":"me","type":"me","attributes":{"userName":"Sheikah","userId":3408}}}"#)
                .unwrap();
        assert_eq!(player.id, 3408);
        assert_eq!(player.name, "Sheikah");
    }

    #[test]
    fn me_falls_back_to_data_id() {
        // If attributes.userId is absent, fall back to a numeric data.id.
        let player =
            me(r#"{"data":{"id":"3408","type":"me","attributes":{"userName":"Sheikah"}}}"#).unwrap();
        assert_eq!(player.id, 3408);
    }

    #[test]
    fn me_rejects_unrecognized_shape() {
        assert!(me(r#"{"unexpected":true}"#).is_none());
    }
}
