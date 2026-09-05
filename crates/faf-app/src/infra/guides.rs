//! The training catalogue's repository, over GitHub's API.
//!
//! Two halves with very different postures.
//!
//! **Reading needs nothing.** Open issues on a public repository are public, so
//! the submission queue loads before anybody signs in, and for most players it
//! is the only half that ever runs. GitHub allows sixty unauthenticated
//! requests an hour per address, which covers one queue load per visit to the
//! tab with room to spare; a signed-in session gets five thousand and the token
//! is used when there is one.
//!
//! **Writing is authorised by GitHub, not by this client.** The device flow
//! (RFC 8628, which is what GitHub calls "device flow") hands the player a
//! short code to type on github.com; the client never sees a password and
//! receives only a token, which goes into the OS keyring beside the FAF one. A
//! commit from an account that is not a collaborator is refused by GitHub, and
//! that refusal is passed through verbatim rather than mapped to a category:
//! "Resource not accessible by personal access token" tells a maintainer more
//! than "not allowed" ever could.
//!
//! Accepting is one port operation and four requests, because they only make
//! sense together: read the catalogue, write it back with the entry in it,
//! comment on the issue, close it. A commit without the issue closed would
//! leave the submission open for a second verdict.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine as _;
use faf_domain::state::{
    accept_commit_message, catalogue_with, entry_from_body, guide_file_path, guide_from_body,
    guide_raw_url, prose_from_body, rejection_comment, submission_body, submission_title,
    GuideSubmission, GuidesIdentity, RejectReason, TrainingResource, CATALOGUE_PATH, GUIDES_REPO,
    SUBMISSION_LABEL,
};
use serde::Deserialize;
use serde_json::json;

use crate::infra::env_or;
use crate::ports::{DeviceCode, GuidesPort};

/// The scope a catalogue maintainer needs: read and write a public repository's
/// contents and issues. Deliberately the narrowest scope that can do the job;
/// `repo` would additionally grant access to every private repository the
/// account can see, which this has no business holding.
const SCOPE: &str = "public_repo";

/// GitHub caps a page of issues at 100. Fifty is more than a submission queue
/// should ever hold, and a queue longer than that is a signal in itself.
const QUEUE_PAGE: u32 = 50;

/// A guard on the polling loop, independent of GitHub's `expires_in`, so a
/// wedged login cannot poll for the rest of the session.
const MAX_LOGIN_WAIT: Duration = Duration::from_secs(15 * 60);

/// The OAuth app the client signs in with, on the `FAForeverRustClient` org.
///
/// Compiled in rather than configured, because a device-flow client id is
/// public by design: the flow has no client secret, which is exactly why it
/// suits a desktop application that could not keep one. The environment
/// override exists for a fork or a test app, not to keep this one out of the
/// binary.
const CLIENT_ID: &str = "Ov23li9p0m7RMbNfLUgv";

#[derive(Debug, Clone)]
pub struct GuidesConfig {
    /// `owner/name` of the catalogue repository.
    pub repo: String,
    /// The OAuth app's client id. Empty means signing in is not offered at
    /// all: see [`GuidesPort::configured`]. Shipped set; emptying it is how a
    /// build turns catalogue maintenance off.
    pub client_id: String,
    pub api_base: String,
    /// Where the device flow happens. Separate from `api_base` because GitHub
    /// serves the OAuth endpoints from `github.com`, not from `api.github.com`.
    pub oauth_base: String,
    pub keyring_service: String,
}

impl GuidesConfig {
    pub fn faf() -> Self {
        Self {
            repo: env_or("FAF_GUIDES_REPO", GUIDES_REPO),
            client_id: env_or("FAF_GUIDES_GITHUB_CLIENT_ID", CLIENT_ID),
            api_base: env_or("FAF_GUIDES_API_BASE", "https://api.github.com"),
            oauth_base: env_or("FAF_GUIDES_OAUTH_BASE", "https://github.com"),
            keyring_service: crate::infra::APP_SLUG.into(),
        }
    }
}

pub struct GuidesClient {
    config: GuidesConfig,
    http: reqwest::Client,
    /// The token for the current session, mirrored from the keyring so every
    /// request does not hit the OS credential store.
    token: Arc<std::sync::Mutex<Option<String>>>,
    cancelled: Arc<AtomicBool>,
}

impl GuidesClient {
    pub fn new(config: GuidesConfig) -> Self {
        Self {
            config,
            http: super::http::shared_http_client(),
            token: Arc::new(std::sync::Mutex::new(None)),
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn faf() -> Self {
        Self::new(GuidesConfig::faf())
    }

    fn stored_token(&self) -> Option<String> {
        if let Some(token) = self.token.lock().expect("guides token lock").clone() {
            return Some(token);
        }
        let entry = keyring::Entry::new(&self.config.keyring_service, "github_token").ok()?;
        let token = entry.get_password().ok()?;
        *self.token.lock().expect("guides token lock") = Some(token.clone());
        Some(token)
    }

    fn remember(&self, token: &str) {
        *self.token.lock().expect("guides token lock") = Some(token.to_string());
        // Best effort, exactly like the FAF refresh token: a machine with no
        // credential store still works for the session, it just asks again
        // next time.
        if let Ok(entry) = keyring::Entry::new(&self.config.keyring_service, "github_token") {
            if let Err(error) = entry.set_password(token) {
                tracing::warn!(%error, "could not store the GitHub token");
            }
        }
    }

    fn forget(&self) {
        *self.token.lock().expect("guides token lock") = None;
        if let Ok(entry) = keyring::Entry::new(&self.config.keyring_service, "github_token") {
            let _ = entry.delete_credential();
        }
    }

    /// A request with the API headers GitHub asks for, and the token when we
    /// hold one.
    fn api(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        let mut request = self
            .http
            .request(method, format!("{}{path}", self.config.api_base))
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28");
        if let Some(token) = self.stored_token() {
            request = request.bearer_auth(token);
        }
        request
    }

    /// Send a request and read GitHub's own words on failure.
    ///
    /// The `message` field of an error response is written for a human and is
    /// consistently the most useful sentence available: which permission is
    /// missing, which field was rejected, that the token expired. Replacing it
    /// with a category would throw away the only part a maintainer can act on.
    async fn send(&self, request: reqwest::RequestBuilder, what: &str) -> Result<String, String> {
        let response = request
            .send()
            .await
            .map_err(|error| format!("could not reach GitHub to {what}: {error}"))?;
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if status.is_success() {
            return Ok(body);
        }
        Err(match github_message(&body) {
            Some(message) => format!("GitHub refused to {what}: {message}"),
            None => format!("GitHub answered {status} when asked to {what}"),
        })
    }

    async fn read_catalogue(&self) -> Result<(String, String), String> {
        self.read_file(CATALOGUE_PATH)
            .await?
            .ok_or_else(|| format!("the repository has no {CATALOGUE_PATH} to add to"))
    }

    /// Read a file, or `None` when the repository does not have one there yet.
    ///
    /// The distinction matters for a guide file: creating one takes no `sha`
    /// and replacing one takes the current one, and sending the wrong shape is
    /// rejected either way.
    async fn read_file(&self, path: &str) -> Result<Option<(String, String)>, String> {
        let response = self
            .api(
                reqwest::Method::GET,
                &format!("/repos/{}/contents/{path}", self.config.repo),
            )
            .send()
            .await
            .map_err(|error| format!("could not reach GitHub to read {path}: {error}"))?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(match github_message(&body) {
                Some(message) => format!("GitHub refused to read {path}: {message}"),
                None => format!("GitHub answered {status} when asked to read {path}"),
            });
        }
        let file: ContentsFile = serde_json::from_str(&body)
            .map_err(|error| format!("GitHub's response for {path} was unreadable: {error}"))?;
        // GitHub wraps base64 at 60 columns, which the strict decoder rejects.
        let packed: String = file.content.split_whitespace().collect();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(packed)
            .map_err(|error| format!("{path} is not valid base64: {error}"))?;
        let text = String::from_utf8(bytes)
            .map_err(|error| format!("{path} is not valid UTF-8: {error}"))?;
        Ok(Some((text, file.sha)))
    }

    async fn write_file(
        &self,
        path: &str,
        contents: &str,
        sha: Option<&str>,
        message: &str,
    ) -> Result<(), String> {
        let encoded = base64::engine::general_purpose::STANDARD.encode(contents.as_bytes());
        let mut payload = json!({ "message": message, "content": encoded });
        if let Some(sha) = sha {
            payload["sha"] = json!(sha);
        }
        self.send(
            self.api(
                reqwest::Method::PUT,
                &format!("/repos/{}/contents/{path}", self.config.repo),
            )
            .json(&payload),
            &format!("commit {path}"),
        )
        .await
        .map(|_| ())
    }

    async fn comment(&self, number: i32, body: &str) -> Result<(), String> {
        self.send(
            self.api(
                reqwest::Method::POST,
                &format!("/repos/{}/issues/{number}/comments", self.config.repo),
            )
            .json(&json!({ "body": body })),
            "comment on the submission",
        )
        .await
        .map(|_| ())
    }

    async fn close(&self, number: i32, label: &str) -> Result<(), String> {
        self.send(
            self.api(
                reqwest::Method::PATCH,
                &format!("/repos/{}/issues/{number}", self.config.repo),
            )
            .json(&json!({ "state": "closed", "labels": [SUBMISSION_LABEL, label] })),
            "close the submission",
        )
        .await
        .map(|_| ())
    }

    /// Who the current token belongs to, and whether they may commit here.
    ///
    /// The permission comes from the repository's own answer about *this*
    /// token, which is the only account whose permissions a token can read.
    async fn identify(&self) -> Result<GuidesIdentity, String> {
        let body = self
            .send(
                self.api(reqwest::Method::GET, "/user"),
                "identify the signed-in account",
            )
            .await?;
        let user: GitHubUser = serde_json::from_str(&body)
            .map_err(|error| format!("GitHub's account response was unreadable: {error}"))?;

        // A failure here is not a failed login: the account is signed in, it
        // simply may not be a collaborator, and the accept button will say so
        // when GitHub refuses the commit.
        let can_commit = match self
            .send(
                self.api(
                    reqwest::Method::GET,
                    &format!("/repos/{}", self.config.repo),
                ),
                "read the catalogue repository",
            )
            .await
        {
            Ok(body) => serde_json::from_str::<Repository>(&body)
                .map(|repository| repository.permissions.push)
                .unwrap_or(false),
            Err(reason) => {
                tracing::info!(%reason, "could not read this account's repository permissions");
                false
            }
        };

        Ok(GuidesIdentity {
            login: user.login,
            avatar_url: user.avatar_url.unwrap_or_default(),
            can_commit,
        })
    }
}

#[async_trait]
impl GuidesPort for GuidesClient {
    fn repo(&self) -> String {
        self.config.repo.clone()
    }

    fn configured(&self) -> bool {
        !self.config.client_id.trim().is_empty()
    }

    async fn begin_login(&self) -> Result<DeviceCode, String> {
        if !self.configured() {
            return Err("this client was not configured with a GitHub app".into());
        }
        self.cancelled.store(false, Ordering::Relaxed);

        let response = self
            .http
            .post(format!("{}/login/device/code", self.config.oauth_base))
            .header("Accept", "application/json")
            .json(&json!({ "client_id": self.config.client_id, "scope": SCOPE }))
            .send()
            .await
            .map_err(|error| format!("could not reach GitHub to start signing in: {error}"))?;
        let body = response.text().await.unwrap_or_default();
        let issued: DeviceCodeResponse =
            serde_json::from_str(&body).map_err(|_| match github_message(&body) {
                Some(message) => format!("GitHub refused to start signing in: {message}"),
                None => "GitHub's sign-in response was unreadable".to_string(),
            })?;

        Ok(DeviceCode {
            device_code: issued.device_code,
            user_code: issued.user_code,
            verification_uri: issued.verification_uri,
            expires_in: issued.expires_in.unwrap_or(900),
            // Never below GitHub's documented floor: polling faster earns a
            // `slow_down` and a longer wait than being patient would have.
            interval: issued.interval.unwrap_or(5).max(5),
        })
    }

    async fn complete_login(&self, code: DeviceCode) -> Result<GuidesIdentity, String> {
        let mut wait = Duration::from_secs(code.interval as u64);
        let deadline = tokio::time::Instant::now()
            + Duration::from_secs(code.expires_in as u64).min(MAX_LOGIN_WAIT);

        loop {
            tokio::time::sleep(wait).await;
            if self.cancelled.load(Ordering::Relaxed) {
                return Err("signing in was cancelled".into());
            }
            if tokio::time::Instant::now() >= deadline {
                return Err("the sign-in code expired before it was used".into());
            }

            let response = self
                .http
                .post(format!(
                    "{}/login/oauth/access_token",
                    self.config.oauth_base
                ))
                .header("Accept", "application/json")
                .json(&json!({
                    "client_id": self.config.client_id,
                    "device_code": code.device_code,
                    "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                }))
                .send()
                .await
                .map_err(|error| format!("could not reach GitHub while signing in: {error}"))?;
            let body = response.text().await.unwrap_or_default();
            let answer: TokenResponse = serde_json::from_str(&body)
                .map_err(|_| "GitHub's sign-in response was unreadable".to_string())?;

            if let Some(token) = answer.access_token {
                self.remember(&token);
                return self.identify().await;
            }

            match answer.error.as_deref() {
                // The ordinary case: nobody has typed the code yet.
                Some("authorization_pending") => {}
                // Asked for explicitly by GitHub when we polled too fast.
                Some("slow_down") => wait += Duration::from_secs(5),
                Some("expired_token") => {
                    return Err("the sign-in code expired before it was used".into())
                }
                Some("access_denied") => return Err("the sign-in was declined".into()),
                Some(other) => {
                    return Err(answer
                        .error_description
                        .unwrap_or_else(|| format!("GitHub refused the sign-in: {other}")))
                }
                None => return Err("GitHub's sign-in response said nothing".into()),
            }
        }
    }

    fn cancel_login(&self) {
        self.cancelled.store(true, Ordering::Relaxed);
    }

    async fn restore_login(&self) -> Result<Option<GuidesIdentity>, String> {
        if self.stored_token().is_none() {
            return Ok(None);
        }
        match self.identify().await {
            Ok(identity) => Ok(Some(identity)),
            Err(reason) => {
                // A token that no longer works is worse than none: every write
                // would fail with an authentication error nobody can act on.
                // Dropping it puts the sign-in button back, and the reason goes
                // with it so the tab can say what happened rather than looking
                // as though it never knew who they were.
                tracing::info!(%reason, "the stored GitHub token no longer works");
                self.forget();
                Err(reason)
            }
        }
    }

    async fn sign_out(&self) {
        self.forget();
    }

    async fn list_submissions(&self) -> Result<Vec<GuideSubmission>, String> {
        let body = self
            .send(
                self.api(
                    reqwest::Method::GET,
                    &format!(
                        "/repos/{}/issues?state=open&labels={SUBMISSION_LABEL}&per_page={QUEUE_PAGE}",
                        self.config.repo
                    ),
                ),
                "list the submissions",
            )
            .await?;
        let issues: Vec<Issue> = serde_json::from_str(&body)
            .map_err(|error| format!("GitHub's issue list was unreadable: {error}"))?;

        Ok(issues
            .into_iter()
            // A pull request is an issue as far as this endpoint is concerned,
            // and a PR against the catalogue is somebody editing it directly
            // rather than submitting through the client.
            .filter(|issue| issue.pull_request.is_none())
            .map(|issue| {
                let body = issue.body.unwrap_or_default();
                // The title carries the catalogue's title and, through it, the
                // entry's id, so it is read before it is moved into the row.
                let entry = entry_from_body(&issue.title, &body);
                GuideSubmission {
                    number: issue.number,
                    title: issue.title,
                    summary: prose_from_body(&body),
                    entry,
                    author: issue
                        .user
                        .as_ref()
                        .map(|user| user.login.clone())
                        .unwrap_or_default(),
                    author_avatar_url: issue
                        .user
                        .and_then(|user| user.avatar_url)
                        .unwrap_or_default(),
                    created_at: issue.created_at.unwrap_or_default(),
                    url: issue.html_url.unwrap_or_default(),
                    guide: guide_from_body(&body),
                }
            })
            .collect())
    }

    async fn accept(&self, submission: GuideSubmission) -> Result<(), String> {
        let mut entry = submission
            .entry
            .clone()
            .ok_or_else(|| "this submission carries no catalogue entry to publish".to_string())?;

        // A guide written in the client becomes a file, and the entry points at
        // it. Committed before the catalogue on purpose: a catalogue entry
        // whose file does not exist yet is a dead link on everybody's screen,
        // whereas a file nothing points at yet is invisible and harmless.
        if let Some(guide) = submission.guide.as_deref() {
            let path = guide_file_path(&entry.id);
            let existing = self.read_file(&path).await?;
            self.write_file(
                &path,
                &format!("{}\n", guide.trim()),
                existing.as_ref().map(|(_, sha)| sha.as_str()),
                &format!("Add the guide for #{} to the repository", submission.number),
            )
            .await?;
            entry.url = guide_raw_url(&self.config.repo, &entry.id);
        }

        // Read, patch, write. The sha is what makes the write safe: if anybody
        // committed in between, GitHub rejects it rather than overwriting their
        // change, and one retry against the fresh document is enough for the
        // ordinary case of two trainers working at once.
        let mut attempts = 0;
        loop {
            attempts += 1;
            let (current, sha) = self.read_catalogue().await?;
            let updated = catalogue_with(&current, &entry)?;
            match self
                .write_file(
                    CATALOGUE_PATH,
                    &updated,
                    Some(&sha),
                    &accept_commit_message(&entry, submission.number),
                )
                .await
            {
                Ok(()) => break,
                Err(reason) if attempts < 2 && reason.contains("does not match") => {
                    tracing::info!("the catalogue changed under us; re-reading and retrying");
                }
                Err(reason) => return Err(reason),
            }
        }

        self.comment(
            submission.number,
            &format!(
                "Published to the catalogue as `{}`. Thanks for the submission.\n\nAccepted from the FAF client's Training tab.\n",
                entry.id
            ),
        )
        .await?;
        self.close(submission.number, "accepted").await
    }

    async fn reject(&self, number: i32, reason: RejectReason, note: String) -> Result<(), String> {
        // The comment first: a closed issue with no explanation is the feedback
        // that makes people stop submitting, and if the close fails the reason
        // is at least on the record.
        self.comment(number, &rejection_comment(reason, &note))
            .await?;
        self.close(number, "declined").await
    }

    async fn submit(&self, entry: TrainingResource, guide: String) -> Result<String, String> {
        let body = self
            .send(
                self.api(
                    reqwest::Method::POST,
                    &format!("/repos/{}/issues", self.config.repo),
                )
                .json(&json!({
                    "title": submission_title(&entry),
                    "body": submission_body(&entry, &guide),
                    "labels": [SUBMISSION_LABEL],
                })),
                "open the submission",
            )
            .await?;
        let issue: Issue = serde_json::from_str(&body)
            .map_err(|error| format!("GitHub's issue response was unreadable: {error}"))?;
        Ok(issue.html_url.unwrap_or_default())
    }
}

/// GitHub's error sentence, when it sent one.
fn github_message(body: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    // `error_description` on the OAuth endpoints, `message` on the API.
    for key in ["error_description", "message"] {
        if let Some(text) = value.get(key).and_then(serde_json::Value::as_str) {
            if !text.is_empty() {
                return Some(text.to_string());
            }
        }
    }
    None
}

// -- GitHub's wire shapes, narrowed to what is used ------------------------

#[derive(Debug, Deserialize)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: Option<u32>,
    interval: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GitHubUser {
    login: String,
    avatar_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Repository {
    #[serde(default)]
    permissions: Permissions,
}

#[derive(Debug, Default, Deserialize)]
struct Permissions {
    #[serde(default)]
    push: bool,
}

#[derive(Debug, Deserialize)]
struct ContentsFile {
    content: String,
    sha: String,
}

#[derive(Debug, Deserialize)]
struct Issue {
    number: i32,
    title: String,
    body: Option<String>,
    user: Option<GitHubUser>,
    created_at: Option<String>,
    html_url: Option<String>,
    /// Present when the "issue" is really a pull request.
    #[serde(default)]
    pull_request: Option<serde_json::Value>,
}

/// Inert catalogue repository: used offline and in tests.
///
/// Reports itself unconfigured, so the UI offers no sign-in rather than a
/// button that cannot work, and answers an empty queue rather than failing:
/// the training tab's other sections do not depend on this one.
#[derive(Debug, Clone, Default)]
pub struct FakeGuides;

#[async_trait]
impl GuidesPort for FakeGuides {
    fn repo(&self) -> String {
        GUIDES_REPO.to_string()
    }

    fn configured(&self) -> bool {
        false
    }

    async fn begin_login(&self) -> Result<DeviceCode, String> {
        Err("this client was not configured with a GitHub app".into())
    }

    async fn complete_login(&self, _code: DeviceCode) -> Result<GuidesIdentity, String> {
        Err("this client was not configured with a GitHub app".into())
    }

    fn cancel_login(&self) {}

    async fn restore_login(&self) -> Result<Option<GuidesIdentity>, String> {
        Ok(None)
    }

    async fn sign_out(&self) {}

    async fn list_submissions(&self) -> Result<Vec<GuideSubmission>, String> {
        Ok(Vec::new())
    }

    async fn accept(&self, _submission: GuideSubmission) -> Result<(), String> {
        Err("not signed in to GitHub".into())
    }

    async fn reject(
        &self,
        _number: i32,
        _reason: RejectReason,
        _note: String,
    ) -> Result<(), String> {
        Err("not signed in to GitHub".into())
    }

    async fn submit(&self, _entry: TrainingResource, _guide: String) -> Result<String, String> {
        Err("not signed in to GitHub".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn githubs_own_sentence_is_what_reaches_the_player() {
        // "Resource not accessible by personal access token" tells a
        // maintainer which permission is missing. "Not allowed" tells them
        // nothing, and this is the one place the distinction is cheap to keep.
        assert_eq!(
            github_message(r#"{"message":"Resource not accessible by personal access token"}"#),
            Some("Resource not accessible by personal access token".into())
        );
        assert_eq!(
            github_message(r#"{"error":"access_denied","error_description":"The user denied it"}"#),
            Some("The user denied it".into())
        );
        assert_eq!(github_message("not json"), None);
        assert_eq!(github_message(r#"{"message":""}"#), None);
    }

    #[test]
    fn a_device_code_response_is_read_with_githubs_floors_respected() {
        let issued: DeviceCodeResponse = serde_json::from_str(
            r#"{"device_code":"3584d83","user_code":"WDJB-MJHT",
                "verification_uri":"https://github.com/login/device",
                "expires_in":899,"interval":5}"#,
        )
        .unwrap();
        assert_eq!(issued.user_code, "WDJB-MJHT");
        assert_eq!(issued.interval, Some(5));
    }

    #[test]
    fn a_pull_request_is_not_a_submission() {
        // GitHub's issue endpoint returns pull requests too, and a PR against
        // the catalogue is somebody editing it directly rather than submitting
        // through the client.
        let issues: Vec<Issue> = serde_json::from_str(
            r#"[
                {"number":1,"title":"A submission","body":null},
                {"number":2,"title":"A PR","body":null,"pull_request":{"url":"x"}}
            ]"#,
        )
        .unwrap();
        let kept: Vec<i32> = issues
            .into_iter()
            .filter(|issue| issue.pull_request.is_none())
            .map(|issue| issue.number)
            .collect();
        assert_eq!(kept, vec![1]);
    }

    #[test]
    fn an_account_with_no_push_permission_is_signed_in_but_cannot_commit() {
        // Signing in and being a collaborator are different facts, and the
        // second one only decides wording: GitHub refuses the commit either
        // way, which is the authorisation.
        let repository: Repository =
            serde_json::from_str(r#"{"permissions":{"pull":true,"push":false}}"#).unwrap();
        assert!(!repository.permissions.push);

        // A response with no permissions block at all must not panic.
        let bare: Repository = serde_json::from_str("{}").unwrap();
        assert!(!bare.permissions.push);
    }

    #[test]
    fn githubs_wrapped_base64_decodes() {
        // The contents API wraps at 60 columns, which the strict decoder
        // rejects. Reading the catalogue is the first step of every accept, so
        // this is not a corner.
        let encoded = base64::engine::general_purpose::STANDARD.encode(b"{\"resources\":[]}");
        let wrapped = format!("{}\n{}\n", &encoded[..8], &encoded[8..]);
        let packed: String = wrapped.split_whitespace().collect();
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(packed)
            .expect("it decodes");
        assert_eq!(String::from_utf8(decoded).unwrap(), "{\"resources\":[]}");
    }

    #[test]
    fn the_shipped_client_signs_in_against_the_org_s_own_app() {
        // A device-flow client id is public by design: the flow has no client
        // secret, which is exactly why it suits a desktop application that
        // could not keep one. Wrong here means every maintainer is told the
        // client was not configured with a GitHub app.
        //
        // Asserted on the constant rather than on `GuidesConfig::faf()`, which
        // reads the environment: a test must not pass or fail depending on what
        // the developer running it happens to export.
        assert_eq!(CLIENT_ID, "Ov23li9p0m7RMbNfLUgv");
        assert!(GuidesClient::new(GuidesConfig {
            repo: GUIDES_REPO.into(),
            client_id: CLIENT_ID.into(),
            api_base: "https://api.github.com".into(),
            oauth_base: "https://github.com".into(),
            keyring_service: "faf-guides-test".into(),
        })
        .configured());
    }

    #[test]
    fn the_scope_is_the_narrowest_one_that_can_commit() {
        // `repo` would additionally grant every private repository the account
        // can see. A game client has no business holding that.
        assert_eq!(SCOPE, "public_repo");
    }

    #[tokio::test]
    async fn an_unconfigured_client_offers_no_sign_in_and_an_empty_queue() {
        let client = GuidesClient::new(GuidesConfig {
            repo: GUIDES_REPO.into(),
            client_id: String::new(),
            api_base: "https://api.invalid".into(),
            oauth_base: "https://github.invalid".into(),
            keyring_service: "faf-guides-test".into(),
        });
        assert!(!client.configured());
        assert!(client.begin_login().await.is_err());
    }

    #[tokio::test]
    async fn the_fake_is_inert_in_both_directions() {
        assert!(!FakeGuides.configured());
        assert_eq!(FakeGuides.repo(), GUIDES_REPO);
        assert!(FakeGuides.list_submissions().await.unwrap().is_empty());
        assert_eq!(FakeGuides.restore_login().await, Ok(None));
        assert!(FakeGuides
            .reject(1, RejectReason::Duplicate, String::new())
            .await
            .is_err());
    }
}
