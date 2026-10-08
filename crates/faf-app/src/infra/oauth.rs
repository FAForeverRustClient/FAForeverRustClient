//! Real OAuth2 auth provider: FAF's Ory Hydra, Authorization Code + PKCE flow.
//!
//! This is the production implementation of [`AuthPort`]. It performs the whole
//! interactive login behind the trait's `login()` call, so the auth service, the
//! `auth` slice and the UI are completely unaware of OAuth (ARCHITECTURE.md §5):
//!
//! 1. bind a loopback redirect listener on an ephemeral port;
//! 2. open the system browser at Hydra's `/oauth2/auth` (PKCE `S256`);
//! 3. receive the `code` on the loopback socket;
//! 4. exchange the code for tokens at `/oauth2/token` (public client, no secret);
//! 5. look up the player at `/me`, stage the session and return the player.
//!
//! The staged session is published (access token made current, refresh token
//! persisted in the OS keyring, renewal scheduled) only when the auth service
//! commits it, which it does once the attempt is known to be still wanted.
//!
//! Native FAF protocol values are taken from the reference clients; everything is
//! overridable via [`OAuthConfig::from_env`] so a partner dev can point at staging.

use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use async_trait::async_trait;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use faf_domain::state::Player;
use rand::RngCore;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, AsyncReadExt as _, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use url::Url;

use crate::infra::session::TokenStore;
use crate::ports::{AuthError, AuthPort, AuthResult};

/// How long we wait for the user to finish the browser login before giving up.
const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);

/// This client's own public PKCE client with FAF Hydra, "FAF Rust Client",
/// registered by FAForever/gitops-stack#335.
const CLIENT_ID: &str = "03c2132b-b5f8-4cbd-9901-499e83700f45";

/// The Python client's id, which this client signed in with until it had its
/// own. Only refresh tokens remembered before the switch are still renewed
/// under it; see [`StoredRefresh`].
const LEGACY_CLIENT_ID: &str = "95ecec08-29c1-4c48-ae0a-b000ff349cb8";

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
    /// FAF production defaults: the reference clients' endpoints and scopes,
    /// and this client's own id.
    pub fn faf() -> Self {
        Self {
            hydra_base: "https://hydra.faforever.com".into(),
            api_base: "https://api.faforever.com".into(),
            client_id: CLIENT_ID.into(),
            scopes: "openid offline public_profile upload_map upload_mod lobby".into(),
            keyring_service: crate::infra::APP_SLUG.into(),
        }
    }

    /// Like [`Self::faf`] but lets each value be overridden via environment
    /// variables (`FAF_HYDRA_BASE`, `FAF_API_BASE`, `FAF_OAUTH_CLIENT_ID`,
    /// `FAF_OAUTH_SCOPES`): handy for pointing at staging.
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
    std::env::var(key)
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or(fallback)
}

/// Production [`AuthPort`]: OAuth2 Authorization Code + PKCE against FAF Hydra.
pub struct OAuthAuth {
    config: OAuthConfig,
    http: reqwest::Client,
    /// Shared access-token store, read by network ports (e.g. the lobby client).
    tokens: TokenStore,
    /// The running background refresh, so a second login replaces it rather
    /// than leaving two loops refreshing the same store.
    refresh_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// The session the last login or restore obtained but nobody has
    /// committed yet. See [`AuthPort::commit_session`].
    pending: Mutex<Option<PendingSession>>,
}

/// A signed-in session that is not visible to the rest of the client yet.
///
/// Login used to publish the access token, persist the refresh token and start
/// the renewal loop before the `/me` request had answered. A sign-in that was
/// cancelled during that request, or whose profile lookup failed, then left a
/// live session behind a login screen, and with "Remember me" one that the
/// next start would restore. Holding everything here until the auth service
/// commits makes publication a single step that only a wanted attempt takes.
#[derive(Debug)]
struct PendingSession {
    access_token: String,
    /// Written to the keyring on commit. `None` when the user did not ask to
    /// be remembered, or when a restore has already persisted the rotated one.
    refresh_token: Option<StoredRefresh>,
    /// Whether the committed session is kept valid by the background refresh.
    renew: bool,
    expires_in: Option<u64>,
}

/// A remembered refresh token and the OAuth client it was issued to.
///
/// Hydra binds a refresh token to the client that obtained it and refuses to
/// renew it under any other id. This client signed in with the Python client's
/// id until it had its own, so every token remembered before the switch still
/// belongs to that id: renewing it under the new one would have signed every
/// remembered user out on the first launch of the update. Each token therefore
/// carries its client and is always renewed under that one. The user moves to
/// this client's own id at their next interactive login.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
struct StoredRefresh {
    client_id: String,
    refresh_token: String,
}

impl StoredRefresh {
    /// Read a keyring value. A bare token predates the switch, so it was issued
    /// to the Python client's id.
    fn decode(raw: &str) -> Self {
        serde_json::from_str(raw).unwrap_or_else(|_| Self {
            client_id: LEGACY_CLIENT_ID.into(),
            refresh_token: raw.to_owned(),
        })
    }

    fn encode(&self) -> String {
        serde_json::json!({
            "client_id": self.client_id,
            "refresh_token": self.refresh_token,
        })
        .to_string()
    }

    /// The token Hydra rotated this one into, which belongs to the same client.
    fn rotated(&self, refresh_token: &str) -> Self {
        Self {
            client_id: self.client_id.clone(),
            refresh_token: refresh_token.to_owned(),
        }
    }
}

/// Refresh this far before the access token actually expires.
///
/// Hydra issues short-lived access tokens (an hour is typical). Renewing at the
/// last second would leave in-flight requests racing the expiry, so the loop
/// wakes up early enough to absorb a slow round trip.
const REFRESH_MARGIN: Duration = Duration::from_secs(120);

/// Floor on the sleep between refreshes, so a very short or a missing
/// `expires_in` cannot turn the loop into a hot spin against Hydra.
const MIN_REFRESH_INTERVAL: Duration = Duration::from_secs(60);

/// Assumed lifetime when the token response omits `expires_in`.
const DEFAULT_TOKEN_LIFETIME: Duration = Duration::from_secs(3_600);

/// Longest single sleep the refresh loop takes, whatever the token's lifetime.
///
/// `tokio::time::sleep` runs off a monotonic clock, and on Windows that clock
/// stops while the host is suspended. A laptop that sleeps through most of an
/// hour therefore wakes with an access token the server considers expired and
/// a timer that still believes it has nearly the whole lifetime left: every
/// FAF API call 401s (the chat client's token endpoint first and loudest)
/// until the timer finally catches up, tens of minutes later. Waking on this
/// interval and re-deriving what is left from the *wall* clock bounds that
/// error to one tick, so a resumed client renews within half a minute.
const REFRESH_TICK: Duration = Duration::from_secs(30);

impl OAuthAuth {
    pub fn new(config: OAuthConfig, tokens: TokenStore) -> Self {
        Self {
            config,
            http: super::http::shared_http_client(),
            tokens,
            refresh_task: Mutex::new(None),
            pending: Mutex::new(None),
        }
    }

    fn pending_slot(&self) -> std::sync::MutexGuard<'_, Option<PendingSession>> {
        self.pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Wait for the player's profile, then stage the session for the auth
    /// service to commit.
    ///
    /// Nothing is published here, not even after the profile arrives: the
    /// attempt may have been called off while `/me` was in flight, and only the
    /// service knows that. A cancelled attempt drops this future before the
    /// staging line runs; a failed lookup returns before it.
    async fn stage_session(
        &self,
        tokens: TokenResponse,
        persist_refresh: bool,
        renew: bool,
        profile: impl std::future::Future<Output = AuthResult<Player>>,
    ) -> AuthResult<Player> {
        let mut player = profile.await?;
        player.roles = session_roles(&tokens);
        // Only a login persists its token through here, and a login always
        // runs under the configured client.
        let refresh_token = tokens
            .refresh_token
            .filter(|_| persist_refresh)
            .map(|refresh_token| StoredRefresh {
                client_id: self.config.client_id.clone(),
                refresh_token,
            });
        *self.pending_slot() = Some(PendingSession {
            access_token: tokens.access_token,
            refresh_token,
            renew,
            expires_in: tokens.expires_in,
        });
        Ok(player)
    }

    /// Keep the access token valid for as long as the client is signed in.
    ///
    /// Without this the token was refreshed **only at startup**, so after about
    /// an hour every FAF API call returned 401 and the user was told their
    /// session had expired while they were plainly still signed in: the lobby
    /// socket and IRC connection authenticate once at connect time and stay up,
    /// so nothing else looked wrong. Everything served from `/data` (the vaults,
    /// player cards, leaderboards, coop, tournaments) failed together.
    ///
    /// Renewing on a timer rather than retrying on a 401 keeps every call site
    /// unchanged: `TokenStore::get` is synchronous and read from a dozen ports,
    /// and this way it simply never hands out a stale token. A token revoked
    /// server-side still yields a 401, and there the existing message is
    /// accurate.
    fn schedule_refresh(&self, expires_in: Option<u64>) {
        let lifetime = expires_in
            .map(Duration::from_secs)
            .unwrap_or(DEFAULT_TOKEN_LIFETIME);
        let config = self.config.clone();
        let http = self.http.clone();
        let tokens = self.tokens.clone();

        let handle = tokio::spawn(async move {
            let mut due = SystemTime::now() + refresh_delay(lifetime);
            loop {
                sleep_until(due).await;

                let Some(stored) = load_refresh_token(&config) else {
                    // Nothing persisted (the user did not ask to be remembered),
                    // so there is nothing to renew with. Stop rather than spin.
                    return;
                };
                match exchange_refresh_token(&http, &config, &stored).await {
                    Ok(response) => {
                        tokens.set(&response.access_token);
                        if let Some(refresh) = &response.refresh_token {
                            store_refresh_token(&config, &stored.rotated(refresh));
                        }
                        let wait = refresh_delay(
                            response
                                .expires_in
                                .map(Duration::from_secs)
                                .unwrap_or(DEFAULT_TOKEN_LIFETIME),
                        );
                        due = SystemTime::now() + wait;
                        tracing::debug!(?wait, "access token refreshed");
                    }
                    Err(error) => {
                        // Try again on the shortest allowed interval: a refresh
                        // that fails because the network dropped should recover
                        // on its own, and one that fails because the grant was
                        // revoked will surface as a 401 the user can act on.
                        tracing::warn!(%error, "could not refresh the access token");
                        due = SystemTime::now() + MIN_REFRESH_INTERVAL;
                    }
                }
            }
        });

        if let Ok(mut slot) = self.refresh_task.lock() {
            if let Some(previous) = slot.replace(handle) {
                previous.abort();
            }
        }
    }

    fn cancel_refresh(&self) {
        if let Ok(mut slot) = self.refresh_task.lock() {
            if let Some(task) = slot.take() {
                task.abort();
            }
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
    async fn login(&self, remember: bool) -> AuthResult<Player> {
        // A session an earlier attempt staged and nobody committed belongs to
        // that attempt, never to this one.
        self.discard_pending_session();
        // Remove the old token up front so an account switch cannot retain the
        // previous account, and so an unchecked "Remember me" choice takes
        // effect even if the user had remembered a different account.
        self.clear_refresh_token();

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
            return Err(AuthError::new(
                "Login failed: state mismatch (possible CSRF).",
            ));
        }
        if let Some(error) = redirect.error {
            return Err(AuthError::new(format!("Login was denied: {error}")));
        }
        let code = redirect
            .code
            .ok_or_else(|| AuthError::new("Login failed: no authorization code returned."))?;

        // 5. Exchange the code for tokens.
        let tokens = self.exchange_code(&code, &verifier, &redirect_uri).await?;

        // 6. Resolve the player, then stage the session. The refresh token is
        //    kept only when the user asked to be remembered, and only then is
        //    there something to renew with: without it the session lasts as
        //    long as the access token does.
        let access_token = tokens.access_token.clone();
        self.stage_session(tokens, remember, remember, self.fetch_me(&access_token))
            .await
    }

    async fn restore(&self) -> AuthResult<Option<Player>> {
        self.discard_pending_session();
        let Some(stored) = self.load_refresh_token() else {
            return Ok(None);
        };

        let tokens = match self.exchange_refresh_token(&stored).await {
            Ok(tokens) => tokens,
            Err(_) => {
                // Keep the stored credential for a later retry. A transient
                // network failure should not force the user through the browser
                // login again.
                return Ok(None);
            }
        };

        // The rotated refresh token is persisted now rather than on commit.
        // Hydra invalidates the one it was just given, so withholding the
        // replacement would not roll anything back: it would silently forget a
        // credential the user chose to keep before this attempt began.
        if let Some(refresh) = &tokens.refresh_token {
            self.store_refresh_token(&stored.rotated(refresh));
        }

        // The access token and the renewal loop wait for the commit, like a
        // login's do. A failed profile lookup therefore has nothing to undo.
        let access_token = tokens.access_token.clone();
        self.stage_session(tokens, false, true, self.fetch_me(&access_token))
            .await
            .map(Some)
    }

    fn commit_session(&self) -> bool {
        let Some(session) = self.pending_slot().take() else {
            return false;
        };
        self.tokens.set(&session.access_token);
        // Keyring failures must not block an otherwise successful login.
        if let Some(refresh) = &session.refresh_token {
            self.store_refresh_token(refresh);
        }
        if session.renew {
            self.schedule_refresh(session.expires_in);
        } else {
            // A loop left over from an earlier session would renew a token
            // this session replaced.
            self.cancel_refresh();
        }
        true
    }

    fn discard_pending_session(&self) {
        self.pending_slot().take();
    }

    async fn logout(&self) -> AuthResult<()> {
        // Best-effort: drop both the in-memory access token and the stored refresh
        // token. The session itself is torn down by the auth slice regardless.
        // The refresh loop goes first: left running it would immediately put a
        // fresh token back into the store the lines below are clearing.
        self.discard_pending_session();
        self.cancel_refresh();
        self.tokens.clear();
        self.clear_refresh_token();
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

    async fn exchange_refresh_token(&self, stored: &StoredRefresh) -> AuthResult<TokenResponse> {
        exchange_refresh_token(&self.http, &self.config, stored).await
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
        let value: Value = serde_json::from_str(&body).map_err(|e| {
            AuthError::new(format!("/me was not JSON: {e}; body: {}", snippet(&body)))
        })?;
        player_from_me(&value).ok_or_else(|| {
            AuthError::new(format!("Unexpected /me shape; body: {}", snippet(&body)))
        })
    }

    fn store_refresh_token(&self, stored: &StoredRefresh) {
        store_refresh_token(&self.config, stored);
    }

    fn load_refresh_token(&self) -> Option<StoredRefresh> {
        load_refresh_token(&self.config)
    }

    fn clear_refresh_token(&self) {
        if let Ok(entry) = keyring::Entry::new(&self.config.keyring_service, "refresh_token") {
            let _ = entry.delete_credential();
        }
    }
}

// Free functions so the background refresh task can use them without holding a
// borrow of the port itself.

fn store_refresh_token(config: &OAuthConfig, stored: &StoredRefresh) {
    write_refresh_token(&config.keyring_service, &stored.encode());
}

fn write_refresh_token(service: &str, raw: &str) {
    if let Ok(entry) = keyring::Entry::new(service, "refresh_token") {
        let _ = entry.set_password(raw);
    }
}

fn read_refresh_token(service: &str) -> Option<String> {
    keyring::Entry::new(service, "refresh_token")
        .ok()
        .and_then(|entry| entry.get_password().ok())
        .filter(|token| !token.is_empty())
}

/// The stored refresh token, falling back to the pre-rename keyring service.
///
/// Without the fallback the rename would have signed every existing user out:
/// the credential is stored under the service name, so a new name simply finds
/// nothing and the client sends them back through the browser. Found under the
/// old name, it is rewritten under the new one and the old entry removed, so
/// the fallback stops being consulted after one launch.
fn load_refresh_token(config: &OAuthConfig) -> Option<StoredRefresh> {
    if let Some(raw) = read_refresh_token(&config.keyring_service) {
        return Some(StoredRefresh::decode(&raw));
    }
    let raw = read_refresh_token(crate::infra::LEGACY_APP_SLUG)?;
    tracing::info!("migrating the stored refresh token to the renamed keyring service");
    // Copied as it is: decoding happens on the way out, so the copy keeps
    // naming whichever client the token was issued to.
    write_refresh_token(&config.keyring_service, &raw);
    if let Ok(entry) = keyring::Entry::new(crate::infra::LEGACY_APP_SLUG, "refresh_token") {
        let _ = entry.delete_credential();
    }
    Some(StoredRefresh::decode(&raw))
}

/// Renew `stored` under the client it was issued to, which is not necessarily
/// the configured one: see [`StoredRefresh`].
async fn exchange_refresh_token(
    http: &reqwest::Client,
    config: &OAuthConfig,
    stored: &StoredRefresh,
) -> AuthResult<TokenResponse> {
    let params = [
        ("grant_type", "refresh_token"),
        ("refresh_token", stored.refresh_token.as_str()),
        ("client_id", stored.client_id.as_str()),
    ];
    let resp = http
        .post(format!("{}/oauth2/token", config.hydra_base))
        .form(&params)
        .send()
        .await
        .map_err(|e| AuthError::new(format!("Refresh request failed: {e}")))?;

    if !resp.status().is_success() {
        return Err(AuthError::new(format!(
            "Refresh token rejected ({})",
            resp.status()
        )));
    }

    resp.json::<TokenResponse>()
        .await
        .map_err(|e| AuthError::new(format!("Could not parse refresh response: {e}")))
}

/// How long to wait before renewing a token that lives for `lifetime`.
///
/// Saturating, so a lifetime shorter than the margin does not underflow into a
/// very long sleep, and floored so it can never become a busy loop.
fn refresh_delay(lifetime: Duration) -> Duration {
    lifetime
        .saturating_sub(REFRESH_MARGIN)
        .max(MIN_REFRESH_INTERVAL)
}

/// Sleep until the wall clock reaches `due`, in slices of [`REFRESH_TICK`].
///
/// Re-reading the wall clock on every slice is the whole point: a suspend that
/// freezes the monotonic clock is invisible to a single long `sleep`, but
/// shows up here as a `due` that has already passed.
async fn sleep_until(due: SystemTime) {
    loop {
        let Ok(remaining) = due.duration_since(SystemTime::now()) else {
            return; // due, or the clock was stepped past it
        };
        if remaining.is_zero() {
            return;
        }
        tokio::time::sleep(remaining.min(REFRESH_TICK)).await;
    }
}

/// Parsed query parameters from the OAuth redirect.
struct Redirect {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

/// The longest request line the loopback listener will read.
///
/// An authorisation code and a state token are a few hundred bytes between
/// them. Without a bound, a local process that connects first can hold the
/// login open by never sending a newline, which the overall timeout caught but
/// only after five minutes of looking hung.
const MAX_REDIRECT_REQUEST_BYTES: u64 = 8 * 1024;

/// Accept loopback connections until one carries the OAuth redirect, then send
/// a minimal HTML page back to the browser.
///
/// A loop rather than a single `accept`: the port is on localhost, so any
/// process on the machine can reach it, and whoever connects first used to
/// decide whether the login worked. The state check below is what stops a
/// stranger's request being *believed*; this is what stops it being the only
/// one heard. The caller's `LOGIN_TIMEOUT` still bounds the whole wait.
async fn accept_redirect(listener: &TcpListener) -> AuthResult<Redirect> {
    loop {
        match accept_one_redirect(listener).await {
            Ok(redirect) => return Ok(redirect),
            // A connection that said nothing useful is not the browser. Keep
            // listening; the timeout is the thing that gives up.
            Err(reason) => tracing::debug!(%reason, "ignoring a loopback connection"),
        }
    }
}

async fn accept_one_redirect(listener: &TcpListener) -> AuthResult<Redirect> {
    let (mut stream, _) = listener
        .accept()
        .await
        .map_err(|e| AuthError::new(format!("Redirect connection failed: {e}")))?;

    // Read only the request line: that carries `?code=...&state=...`.
    let request_line = {
        let mut reader = BufReader::new((&mut stream).take(MAX_REDIRECT_REQUEST_BYTES));
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

/// The page the browser is left on once the redirect comes back.
///
/// A file rather than a string literal: it is a real page, with a style sheet
/// and the client's mark drawn as SVG, and every CSS brace in it would have to
/// be doubled to survive a `format!`. Its own wording is the successful case,
/// which is the one nearly everybody sees; the failure case swaps the four
/// lines that say it went well.
const LANDING_PAGE: &str = include_str!("oauth_landing.html");

fn response_html(success: bool) -> String {
    if success {
        return LANDING_PAGE.to_string();
    }
    LANDING_PAGE
        .replace("FAF: Signed in", "FAF: Sign-in failed")
        .replace(">✓<", ">✕<")
        .replace("You're signed in", "Sign-in failed")
        .replace(
            "Authentication was successful.",
            "Something went wrong. Return to FAForever Client and try again.",
        )
        .replace(
            "You can close this window now.",
            "You can close this window and try again in the client.",
        )
}

/// Hydra's token endpoint response (only the fields we use).
#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    /// Access-token lifetime in seconds. Drives when the background refresh
    /// wakes up; absent responses fall back to `DEFAULT_TOKEN_LIFETIME`.
    #[serde(default)]
    expires_in: Option<u64>,
    /// OIDC identity token, present because we request the `openid` scope. Its
    /// payload is where FAF puts the session's permission roles.
    #[serde(default)]
    id_token: Option<String>,
}

/// Environment override for the session's roles, comma-separated.
///
/// The counterpart to `FAF_FAKE_AUTH`: it lets role-gated UI be developed and
/// screenshotted without holding the role on the live account. It is safe
/// precisely because the roles decide nothing: the FAF API still refuses every
/// privileged call from an account that lacks them, so this reveals controls,
/// it does not grant anything.
const FAKE_ROLES_ENV: &str = "FAF_FAKE_ROLES";

/// Roles forced by [`FAKE_ROLES_ENV`], if any. Empty when the variable is unset
/// or holds nothing usable, so callers can treat it as "no override".
///
/// Shared with the offline port bundle so `FAF_FAKE_AUTH=1` and a real login
/// honour the same switch.
pub(crate) fn roles_from_env() -> Vec<String> {
    let Ok(raw) = std::env::var(FAKE_ROLES_ENV) else {
        return Vec::new();
    };
    let roles: Vec<String> = raw
        .split(',')
        .map(str::trim)
        .filter(|role| !role.is_empty())
        .map(str::to_string)
        .collect();
    if !roles.is_empty() {
        tracing::warn!(
            ?roles,
            "using {FAKE_ROLES_ENV}; role-gated UI is shown regardless of the account's real roles"
        );
    }
    roles
}

/// The permission roles for this session.
fn session_roles(tokens: &TokenResponse) -> Vec<String> {
    let overridden = roles_from_env();
    if !overridden.is_empty() {
        return overridden;
    }

    let roles = tokens
        .id_token
        .as_deref()
        .map(roles_from_id_token)
        .unwrap_or_default();
    if roles.is_empty() {
        // Not an error: most accounts hold no special permission, and the
        // client works identically either way. Logged because "the organiser
        // panel never appears" is otherwise indistinguishable from a bug.
        tracing::debug!("no roles found in the identity token");
    } else {
        tracing::debug!(?roles, "session roles");
    }
    roles
}

/// Read `ext.roles` out of an OIDC identity token.
///
/// **The signature is deliberately not verified.** That would normally be
/// unacceptable, and it is worth being explicit about why it is fine here: the
/// token came from Hydra over TLS on a connection this process opened itself,
/// and the value is used for one thing only: deciding whether to draw a
/// control. Authorisation happens at the FAF API, which validates the token
/// properly and answers 403 regardless of what this function returned. Adding
/// JWKS fetching and signature checking would buy no security while adding a
/// network dependency to login.
///
/// Anything unreadable yields no roles, never an error: a login must not fail
/// because a claim moved.
fn roles_from_id_token(id_token: &str) -> Vec<String> {
    let Some(payload) = id_token.split('.').nth(1) else {
        return Vec::new();
    };
    // JWT payloads are base64url without padding, but some issuers pad anyway.
    let Ok(decoded) = URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')) else {
        return Vec::new();
    };
    let Ok(claims) = serde_json::from_slice::<Value>(&decoded) else {
        return Vec::new();
    };
    // FAF nests them under `ext` (that is where Hydra puts a consent app's
    // custom claims); `roles` at the top level is the shape a plain OIDC
    // provider would use, and costs nothing to also accept.
    claims
        .get("ext")
        .and_then(|ext| ext.get("roles"))
        .or_else(|| claims.get("roles"))
        .and_then(Value::as_array)
        .map(|roles| {
            roles
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
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

    let id =
        json_id(attributes.and_then(|a| a.get("userId"))).or_else(|| json_id(data.get("id")))?;

    // Roles do not come from `/me`; the caller attaches them from the token.
    Some(Player::new(id, name))
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
    use std::sync::Arc;

    use tokio::sync::oneshot;

    use super::*;

    /// A JWT with `payload` as its claims. Header and signature are inert: the
    /// reader never looks at them (see `roles_from_id_token`).
    fn id_token(payload: Value) -> String {
        format!(
            "header.{}.signature",
            URL_SAFE_NO_PAD.encode(payload.to_string())
        )
    }

    #[test]
    fn roles_are_read_from_the_ext_claim() {
        // The shape FAF actually issues: Hydra nests a consent app's custom
        // claims under `ext`, which is where its own gateway reads them from.
        let token = id_token(serde_json::json!({
            "sub": "42",
            "ext": { "username": "Commander", "roles": ["USER", "TOURNAMENT_DIRECTOR"] },
        }));
        assert_eq!(
            roles_from_id_token(&token),
            vec!["USER".to_string(), "TOURNAMENT_DIRECTOR".to_string()]
        );
    }

    #[test]
    fn a_top_level_roles_claim_is_also_accepted() {
        let token = id_token(serde_json::json!({ "roles": ["ADMIN_MAP"] }));
        assert_eq!(roles_from_id_token(&token), vec!["ADMIN_MAP".to_string()]);
    }

    #[test]
    fn a_padded_payload_is_still_decoded() {
        // Base64url in a JWT is unpadded by spec, but padding shows up in the
        // wild and losing every role over a trailing `=` would be absurd.
        let encoded = URL_SAFE_NO_PAD.encode(r#"{"ext":{"roles":["USER"]}}"#);
        let token = format!("header.{encoded}==.signature");
        assert_eq!(roles_from_id_token(&token), vec!["USER".to_string()]);
    }

    #[test]
    fn an_unreadable_token_yields_no_roles_rather_than_failing() {
        // Every one of these must leave login working: the roles decide what is
        // drawn, and drawing less is always survivable.
        for token in [
            "",
            "not-a-jwt",
            "header.!!!not-base64!!!.signature",
            &id_token(serde_json::json!({ "ext": { "roles": "TOURNAMENT_DIRECTOR" } })),
            &id_token(serde_json::json!({ "ext": {} })),
            &id_token(serde_json::json!([])),
        ] {
            assert!(
                roles_from_id_token(token).is_empty(),
                "{token:?} should yield no roles"
            );
        }
    }

    #[test]
    fn non_string_entries_are_dropped_rather_than_stringified() {
        let token = id_token(serde_json::json!({ "ext": { "roles": ["USER", 7, null] } }));
        assert_eq!(roles_from_id_token(&token), vec!["USER".to_string()]);
    }

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
        assert!(token
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }

    #[test]
    fn the_refresh_wakes_up_before_the_token_expires() {
        // The bug this guards: nothing renewed the access token after startup,
        // so an hour in, every FAF API call returned 401 and told the user
        // their session had expired while they were still signed in.
        assert_eq!(
            refresh_delay(Duration::from_secs(3600)),
            Duration::from_secs(3600) - REFRESH_MARGIN
        );
    }

    #[test]
    fn a_short_lived_token_never_becomes_a_busy_loop() {
        // Saturating, not wrapping: a lifetime under the margin would otherwise
        // underflow into an effectively infinite sleep.
        assert_eq!(refresh_delay(Duration::from_secs(30)), MIN_REFRESH_INTERVAL);
        assert_eq!(refresh_delay(Duration::ZERO), MIN_REFRESH_INTERVAL);
        assert_eq!(
            refresh_delay(REFRESH_MARGIN + Duration::from_secs(1)),
            MIN_REFRESH_INTERVAL
        );
    }

    #[test]
    fn token_responses_carry_the_lifetime_when_hydra_sends_one() {
        let with = r#"{"access_token":"at","refresh_token":"rt","expires_in":3600}"#;
        let parsed: TokenResponse = serde_json::from_str(with).unwrap();
        assert_eq!(parsed.expires_in, Some(3600));

        // Absent is tolerated: the loop falls back to a one-hour assumption
        // rather than refusing to schedule anything.
        let without = r#"{"access_token":"at"}"#;
        let parsed: TokenResponse = serde_json::from_str(without).unwrap();
        assert_eq!(parsed.expires_in, None);
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
    fn the_client_signs_in_under_its_own_id() {
        assert_eq!(OAuthConfig::faf().client_id, CLIENT_ID);
        assert_ne!(CLIENT_ID, LEGACY_CLIENT_ID);
    }

    #[test]
    fn a_token_remembered_before_the_switch_renews_under_the_python_id() {
        let stored = StoredRefresh::decode("ory_rt_abc.def");
        assert_eq!(stored.client_id, LEGACY_CLIENT_ID);
        assert_eq!(stored.refresh_token, "ory_rt_abc.def");
    }

    #[test]
    fn a_stored_token_keeps_the_client_it_was_issued_to() {
        let stored = StoredRefresh {
            client_id: CLIENT_ID.into(),
            refresh_token: "ory_rt_abc.def".into(),
        };
        assert_eq!(StoredRefresh::decode(&stored.encode()), stored);
    }

    #[test]
    fn a_rotated_token_stays_with_its_client() {
        let legacy = StoredRefresh::decode("ory_rt_old");
        let rotated = legacy.rotated("ory_rt_new");
        assert_eq!(rotated.client_id, LEGACY_CLIENT_ID);
        assert_eq!(rotated.refresh_token, "ory_rt_new");
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
        let player = me(
            r#"{"data":{"id":"me","type":"me","attributes":{"userName":"Sheikah","userId":3408}}}"#,
        )
        .unwrap();
        assert_eq!(player.id, 3408);
        assert_eq!(player.name, "Sheikah");
    }

    #[test]
    fn me_falls_back_to_data_id() {
        // If attributes.userId is absent, fall back to a numeric data.id.
        let player =
            me(r#"{"data":{"id":"3408","type":"me","attributes":{"userName":"Sheikah"}}}"#)
                .unwrap();
        assert_eq!(player.id, 3408);
    }

    #[test]
    fn me_rejects_unrecognized_shape() {
        assert!(me(r#"{"unexpected":true}"#).is_none());
    }

    // The staging tests drive the real adapter from the token exchange's
    // answer onwards, with the `/me` request replaced by a future the test
    // controls. No refresh token is ever staged for persisting, so none of
    // them touches the OS keyring of whoever runs the suite.

    fn adapter() -> Arc<OAuthAuth> {
        Arc::new(OAuthAuth::new(OAuthConfig::faf(), TokenStore::new()))
    }

    fn exchanged() -> TokenResponse {
        TokenResponse {
            access_token: "at".into(),
            refresh_token: None,
            expires_in: Some(3600),
            id_token: None,
        }
    }

    /// What of a session the rest of the client can see.
    fn published(auth: &OAuthAuth) -> (Option<String>, bool) {
        let renewing = auth.refresh_task.lock().unwrap().is_some();
        (auth.tokens.get(), renewing)
    }

    #[tokio::test]
    async fn a_sign_in_called_off_during_the_profile_request_publishes_nothing() {
        let auth = adapter();
        let (entered_tx, entered_rx) = oneshot::channel();
        let (_release_tx, release_rx) = oneshot::channel::<()>();
        let staging = auth.clone();
        let sign_in = tokio::spawn(async move {
            let profile = async move {
                let _ = entered_tx.send(());
                let _ = release_rx.await;
                Ok(Player::new(7, "Ada"))
            };
            staging
                .stage_session(exchanged(), true, true, profile)
                .await
        });

        entered_rx.await.unwrap();
        assert_eq!(
            published(&auth),
            (None, false),
            "the session went live before /me answered"
        );

        // Cancelling the command drops the port's future, as here.
        sign_in.abort();
        let _ = sign_in.await;
        assert_eq!(published(&auth), (None, false));
        assert!(
            !auth.commit_session(),
            "a called-off attempt left a session to commit"
        );
        assert_eq!(published(&auth), (None, false));
    }

    #[tokio::test]
    async fn a_failed_profile_lookup_publishes_and_stages_nothing() {
        let auth = adapter();
        let result = auth
            .stage_session(exchanged(), true, true, async {
                Err(AuthError::new("Could not load profile (/me returned 500)"))
            })
            .await;
        assert!(result.is_err());
        assert_eq!(published(&auth), (None, false));
        assert!(!auth.commit_session());
        assert_eq!(published(&auth), (None, false));
    }

    #[tokio::test]
    async fn a_successful_sign_in_is_published_only_by_the_commit() {
        let auth = adapter();
        let player = auth
            .stage_session(exchanged(), true, true, async { Ok(Player::new(7, "Ada")) })
            .await
            .unwrap();
        assert_eq!(player.id, 7);
        assert_eq!(published(&auth), (None, false), "published before commit");

        assert!(auth.commit_session());
        assert_eq!(published(&auth), (Some("at".into()), true));
        // A commit publishes once; a second has nothing left to publish.
        assert!(!auth.commit_session());
        auth.cancel_refresh();
    }

    #[tokio::test]
    async fn a_session_without_remember_me_is_published_without_renewal() {
        let auth = adapter();
        auth.stage_session(exchanged(), false, false, async {
            Ok(Player::new(7, "Ada"))
        })
        .await
        .unwrap();
        assert!(auth.commit_session());
        assert_eq!(published(&auth), (Some("at".into()), false));
    }

    #[tokio::test]
    async fn a_discarded_session_can_no_longer_be_committed() {
        let auth = adapter();
        auth.stage_session(exchanged(), true, true, async { Ok(Player::new(7, "Ada")) })
            .await
            .unwrap();
        auth.discard_pending_session();
        assert!(!auth.commit_session());
        assert_eq!(published(&auth), (None, false));
    }
}
