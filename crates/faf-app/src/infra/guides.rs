//! The training catalogue's repository, over GitHub's API.
//!
//! Two halves with very different postures.
//!
//! **Reading needs nothing.** Open issues on a public repository are public, so
//! the submission queue loads before anybody signs in, and for most players it
//! is the only half that ever runs. GitHub allows sixty unauthenticated
//! requests an hour per address, which covers one queue load per visit to the
//! tab with room to spare; a signed-in session gets five thousand and the token
//! is used when there is one. A token GitHub no longer accepts never costs the
//! reading half anything: the read is repeated anonymously, the token is
//! dropped, and the service is told so it can say the session ended.
//!
//! **Writing is authorised by GitHub, not by this client.** The device flow
//! (RFC 8628, which is what GitHub calls "device flow") hands the player a
//! short code to type on github.com; the client never sees a password and
//! receives only a token, which goes into the OS keyring beside the FAF one. A
//! commit from an account that is not a collaborator is refused by GitHub, and
//! that refusal is passed through verbatim rather than mapped to a category:
//! "Resource not accessible by personal access token" tells a maintainer more
//! than "not allowed" ever could. The one thing checked here first is the
//! account's permission, and only because a comment needs none: without that
//! check a verdict from somebody who may not give one left its public comment
//! behind before GitHub refused the close.
//!
//! A verdict is one port operation and several requests, because they only
//! make sense together: commit the entry, comment on the issue, close it. Each
//! step finds out first whether an earlier attempt already did it (the entry
//! is in the catalogue, the comment is on the issue, the issue is closed), so a
//! verdict that failed halfway is finished by giving it again, with no second
//! commit and no second comment.
//!
//! **A written guide travels as a pull request.** It is a file, it may carry
//! pictures, and an issue can hold neither. Submitting builds one commit
//! through the Git data API (a blob per file, one tree, one commit on top of
//! the catalogue's `main`) on a branch of the author's fork, or of the
//! repository itself for somebody who may push to it, and proposes it.
//! Accepting merges exactly the commit the queue read, and only when the pull
//! request holds nothing but that guide and its pictures, then adds the entry
//! to the catalogue the way an issue's is added.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine as _;
use faf_domain::state::guides::{
    acceptance_comment, catalogue_claim, entry_from_issue, entry_problem, foreign_files,
    guide_image_path, id_candidates, is_submission_issue, merge_commit_message, place_images,
    pull_guide_note, submission_branch, submitted_guide_id, CatalogueClaim, ACCEPTED_LABEL,
    ACCEPT_MARKER, DECLINED_LABEL, DECLINE_MARKER, GUIDES_BRANCH,
};
use faf_domain::state::{
    accept_commit_message, catalogue_with, guide_file_path, guide_from_body, guide_raw_url,
    prose_from_body, rejection_comment, submission_body, submission_title, GuideImage,
    GuideSubmission, GuidesIdentity, RejectReason, SubmissionPull, TrainingResource,
    CATALOGUE_PATH, GUIDES_REPO, SUBMISSION_LABEL,
};
use reqwest::{Method, StatusCode};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::json;
use tokio::sync::Notify;

use crate::infra::env_or;
use crate::ports::guides::LOGIN_CANCELLED;
use crate::ports::{DeviceCode, GuidesPort};

/// The scope a catalogue maintainer needs: read and write a public repository's
/// contents and issues. Deliberately the narrowest scope that can do the job;
/// `repo` would additionally grant access to every private repository the
/// account can see, which this has no business holding.
const SCOPE: &str = "public_repo";

/// GitHub's largest page of issues.
const QUEUE_PAGE: u32 = 100;

/// How many pages of open issues the queue reads before it stops.
///
/// The queue is read without a label filter (see [`is_submission_issue`]), so
/// a page holds ordinary repository traffic too. A thousand open issues is far
/// beyond what this repository will see; the cap exists so a runaway cannot
/// spend an anonymous reader's whole hourly allowance on one refresh.
const MAX_QUEUE_PAGES: u32 = 10;

/// A guide is prose somebody wrote. Anything past this, read off a pull
/// request, is not one; the same ceiling the library's reader keeps.
const MAX_GUIDE_BYTES: usize = 512 * 1024;

/// How long to wait between asking a fork that is still being made whether it
/// is ready. GitHub forks asynchronously and says so: "Forking a Repository
/// happens asynchronously. You may have to wait a short period of time before
/// you can access the git objects."
const FORK_PAUSE: Duration = if cfg!(test) {
    Duration::from_millis(1)
} else {
    Duration::from_secs(2)
};

/// How many times a fork that is not ready yet is asked again: a minute.
const FORK_ATTEMPTS: u32 = 30;

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
    /// Where a file is read at a commit: a pull request's guide, at the commit
    /// the queue lists it at. Not the API, which would spend the anonymous
    /// reader's hourly allowance on every guide in the queue.
    pub raw_base: String,
    /// The OS keyring service the token is stored under. Empty keeps the token
    /// in memory only, which is what the tests use so they never read or
    /// delete anything in the developer's own credential store.
    pub keyring_service: String,
}

impl GuidesConfig {
    pub fn faf() -> Self {
        Self {
            repo: env_or("FAF_GUIDES_REPO", GUIDES_REPO),
            client_id: env_or("FAF_GUIDES_GITHUB_CLIENT_ID", CLIENT_ID),
            api_base: env_or("FAF_GUIDES_API_BASE", "https://api.github.com"),
            oauth_base: env_or("FAF_GUIDES_OAUTH_BASE", "https://github.com"),
            raw_base: env_or("FAF_GUIDES_RAW_BASE", "https://raw.githubusercontent.com"),
            keyring_service: crate::infra::APP_SLUG.into(),
        }
    }
}

/// A request GitHub did not answer with success, and the status it answered
/// with when it answered at all.
///
/// The status is what decisions are made on: a 401 is the only answer that
/// says a token is dead, and a 409 the only one that says the catalogue moved
/// under a commit. Reading either out of GitHub's sentence instead would break
/// the day GitHub rewords it. The sentence is still what reaches the screen.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Failure {
    status: Option<StatusCode>,
    message: String,
}

impl Failure {
    fn unreachable(what: &str, error: impl std::fmt::Display) -> Self {
        Self {
            status: None,
            message: format!("could not reach GitHub to {what}: {error}"),
        }
    }

    fn refused(what: &str, status: StatusCode, body: &str) -> Self {
        Self {
            status: Some(status),
            message: match github_message(body) {
                Some(message) => format!("GitHub refused to {what}: {message}"),
                None => format!("GitHub answered {status} when asked to {what}"),
            },
        }
    }

    fn unreadable(what: &str, error: impl std::fmt::Display) -> Self {
        Self {
            status: None,
            message: format!("GitHub's answer when asked to {what} was unreadable: {error}"),
        }
    }

    /// GitHub no longer accepts the credentials. The one answer that means a
    /// saved sign-in is dead rather than temporarily unusable.
    fn is_unauthorised(&self) -> bool {
        self.status == Some(StatusCode::UNAUTHORIZED)
    }

    fn is_not_found(&self) -> bool {
        self.status == Some(StatusCode::NOT_FOUND)
    }

    /// The file moved between reading and writing it: 409 for a `sha` that no
    /// longer matches, 422 for a file created or removed in between (a `sha`
    /// sent for a file that is gone, or none sent for one that now exists).
    fn is_conflict(&self) -> bool {
        matches!(
            self.status,
            Some(StatusCode::CONFLICT | StatusCode::UNPROCESSABLE_ENTITY)
        )
    }
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl From<Failure> for String {
    fn from(failure: Failure) -> Self {
        failure.message
    }
}

/// A successful answer, and whether GitHub said there is a further page.
struct Answer {
    body: String,
    more: bool,
}

pub struct GuidesClient {
    config: GuidesConfig,
    http: reqwest::Client,
    /// The token for the current session, mirrored from the keyring so every
    /// request does not hit the OS credential store.
    token: Arc<std::sync::Mutex<Option<String>>>,
    /// Why the stored token was dropped, until the service asks. See
    /// [`GuidesPort::take_lost_session`].
    lost_session: Arc<std::sync::Mutex<Option<String>>>,
    cancelled: Arc<AtomicBool>,
    /// Wakes a polling loop that is sleeping between polls, so cancelling
    /// ends it at once rather than after the next interval. Until it ends, the
    /// service's single-flight guard is held and a fresh sign-in is ignored.
    cancel_wake: Arc<Notify>,
}

impl GuidesClient {
    pub fn new(config: GuidesConfig) -> Self {
        Self {
            config,
            http: super::http::shared_http_client(),
            token: Arc::new(std::sync::Mutex::new(None)),
            lost_session: Arc::new(std::sync::Mutex::new(None)),
            cancelled: Arc::new(AtomicBool::new(false)),
            cancel_wake: Arc::new(Notify::new()),
        }
    }

    pub fn faf() -> Self {
        Self::new(GuidesConfig::faf())
    }

    fn keyring_entry(&self) -> Option<keyring::Entry> {
        if self.config.keyring_service.is_empty() {
            return None;
        }
        keyring::Entry::new(&self.config.keyring_service, "github_token").ok()
    }

    fn stored_token(&self) -> Option<String> {
        if let Some(token) = self.token.lock().expect("guides token lock").clone() {
            return Some(token);
        }
        let token = self.keyring_entry()?.get_password().ok()?;
        *self.token.lock().expect("guides token lock") = Some(token.clone());
        Some(token)
    }

    fn remember(&self, token: &str) {
        *self.token.lock().expect("guides token lock") = Some(token.to_string());
        *self.lost_session.lock().expect("guides session lock") = None;
        // Best effort, exactly like the FAF refresh token: a machine with no
        // credential store still works for the session, it just asks again
        // next time.
        if let Some(entry) = self.keyring_entry() {
            if let Err(error) = entry.set_password(token) {
                tracing::warn!(%error, "could not store the GitHub token");
            }
        }
    }

    fn forget(&self) {
        *self.token.lock().expect("guides token lock") = None;
        if let Some(entry) = self.keyring_entry() {
            let _ = entry.delete_credential();
        }
    }

    /// GitHub answered 401 to a request that carried the stored token.
    ///
    /// That is a definitive answer about the token, unlike every other
    /// failure, so it is dropped here and the reason is kept for the service:
    /// a session that ended has to say so rather than look as though it never
    /// started.
    fn session_rejected(&self, failure: &Failure) {
        tracing::info!(reason = %failure, "GitHub no longer accepts the stored token");
        self.forget();
        *self.lost_session.lock().expect("guides session lock") = Some(format!(
            "the saved GitHub sign-in no longer works and was removed ({failure}); sign in again to review submissions"
        ));
    }

    /// Send one API request, with the headers GitHub asks for and the token
    /// unless `anonymous`, and read GitHub's own words on failure.
    ///
    /// The `message` field of an error response is written for a human and is
    /// consistently the most useful sentence available: which permission is
    /// missing, which field was rejected, that the token expired. Replacing it
    /// with a category would throw away the only part a maintainer can act on.
    async fn request(
        &self,
        method: Method,
        path: &str,
        payload: Option<&serde_json::Value>,
        what: &str,
        anonymous: bool,
    ) -> Result<Answer, Failure> {
        let token = if anonymous { None } else { self.stored_token() };
        let mut request = self
            .http
            .request(method, format!("{}{path}", self.config.api_base))
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28");
        if let Some(token) = &token {
            request = request.bearer_auth(token);
        }
        if let Some(payload) = payload {
            request = request.json(payload);
        }

        let response = request
            .send()
            .await
            .map_err(|error| Failure::unreachable(what, error))?;
        let status = response.status();
        let more = response
            .headers()
            .get(reqwest::header::LINK)
            .and_then(|value| value.to_str().ok())
            .is_some_and(link_has_next);
        let body = response.text().await.unwrap_or_default();
        if status.is_success() {
            return Ok(Answer { body, more });
        }

        let failure = Failure::refused(what, status, &body);
        if failure.is_unauthorised() && token.is_some() {
            self.session_rejected(&failure);
        }
        Err(failure)
    }

    async fn send(
        &self,
        method: Method,
        path: &str,
        payload: Option<&serde_json::Value>,
        what: &str,
    ) -> Result<String, Failure> {
        self.request(method, path, payload, what, false)
            .await
            .map(|answer| answer.body)
    }

    /// A read of something public: with the token while it works, and
    /// anonymously when GitHub refuses the token.
    ///
    /// A revoked token used to make the queue fail outright with a 401, for
    /// information anybody may read without one.
    async fn read_public(&self, path: &str, what: &str) -> Result<Answer, Failure> {
        match self.request(Method::GET, path, None, what, false).await {
            Err(failure) if failure.is_unauthorised() => {
                self.request(Method::GET, path, None, what, true).await
            }
            other => other,
        }
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
    async fn read_file(&self, path: &str) -> Result<Option<(String, String)>, Failure> {
        let what = format!("read {path}");
        let body = match self
            .send(
                Method::GET,
                &format!("/repos/{}/contents/{path}", self.config.repo),
                None,
                &what,
            )
            .await
        {
            Ok(body) => body,
            Err(failure) if failure.is_not_found() => return Ok(None),
            Err(failure) => return Err(failure),
        };
        let file: ContentsFile =
            serde_json::from_str(&body).map_err(|error| Failure::unreadable(&what, error))?;
        // GitHub wraps base64 at 60 columns, which the strict decoder rejects.
        let packed: String = file.content.split_whitespace().collect();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(packed)
            .map_err(|error| Failure::unreadable(&what, error))?;
        let text = String::from_utf8(bytes).map_err(|error| Failure::unreadable(&what, error))?;
        Ok(Some((text, file.sha)))
    }

    async fn write_file(
        &self,
        path: &str,
        contents: &str,
        sha: Option<&str>,
        message: &str,
    ) -> Result<(), Failure> {
        let encoded = base64::engine::general_purpose::STANDARD.encode(contents.as_bytes());
        let mut payload = json!({ "message": message, "content": encoded });
        if let Some(sha) = sha {
            payload["sha"] = json!(sha);
        }
        self.send(
            Method::PUT,
            &format!("/repos/{}/contents/{path}", self.config.repo),
            Some(&payload),
            &format!("commit {path}"),
        )
        .await
        .map(|_| ())
    }

    /// Write a file unless it already holds exactly `contents`.
    ///
    /// The "already" case is an accept being finished after it failed past
    /// this step: committing the same bytes again would only add a commit that
    /// changes nothing. One retry when the file moved in between, for the same
    /// reason the catalogue gets one.
    async fn write_if_changed(
        &self,
        path: &str,
        contents: &str,
        message: &str,
    ) -> Result<(), String> {
        let mut attempts = 0;
        loop {
            attempts += 1;
            let existing = self.read_file(path).await?;
            if existing.as_ref().is_some_and(|(held, _)| held == contents) {
                return Ok(());
            }
            let sha = existing.as_ref().map(|(_, sha)| sha.as_str());
            match self.write_file(path, contents, sha, message).await {
                Ok(()) => return Ok(()),
                Err(failure) if attempts < 2 && failure.is_conflict() => {
                    tracing::info!(path, "the file changed under us; re-reading and retrying");
                }
                Err(failure) => return Err(failure.into()),
            }
        }
    }

    async fn issue(&self, number: i32) -> Result<Issue, Failure> {
        let what = format!("read #{number}");
        let body = self
            .send(
                Method::GET,
                &format!("/repos/{}/issues/{number}", self.config.repo),
                None,
                &what,
            )
            .await?;
        serde_json::from_str(&body).map_err(|error| Failure::unreadable(&what, error))
    }

    /// The comments on an issue, as text. The first hundred, which for a
    /// submission is all of them.
    async fn comments(&self, number: i32) -> Result<Vec<String>, Failure> {
        let what = format!("read the comments on #{number}");
        let body = self
            .send(
                Method::GET,
                &format!(
                    "/repos/{}/issues/{number}/comments?per_page=100",
                    self.config.repo
                ),
                None,
                &what,
            )
            .await?;
        let comments: Vec<Comment> =
            serde_json::from_str(&body).map_err(|error| Failure::unreadable(&what, error))?;
        Ok(comments
            .into_iter()
            .filter_map(|comment| comment.body)
            .collect())
    }

    async fn comment(&self, number: i32, body: &str) -> Result<(), Failure> {
        self.send(
            Method::POST,
            &format!("/repos/{}/issues/{number}/comments", self.config.repo),
            Some(&json!({ "body": body })),
            "comment on the submission",
        )
        .await
        .map(|_| ())
    }

    /// Close an issue and add the verdict's label to it.
    ///
    /// The label is *added*, never set. Sending `labels` with the close
    /// replaced the issue's whole set, which removed whatever a maintainer had
    /// put there. Adding it is best effort: the verdict is the close and the
    /// comment, and a missing label is not worth reporting a verdict as failed.
    async fn close(&self, number: i32, label: &str, state_reason: &str) -> Result<(), Failure> {
        self.send(
            Method::PATCH,
            &format!("/repos/{}/issues/{number}", self.config.repo),
            Some(&json!({ "state": "closed", "state_reason": state_reason })),
            "close the submission",
        )
        .await?;
        self.add_labels(number, &[SUBMISSION_LABEL, label]).await;
        Ok(())
    }

    /// [`Self::close`] for a pull request, which GitHub closes through its own
    /// endpoint and which has no `state_reason`.
    async fn close_pull(&self, number: i32, label: &str) -> Result<(), Failure> {
        self.send(
            Method::PATCH,
            &format!("/repos/{}/pulls/{number}", self.config.repo),
            Some(&json!({ "state": "closed" })),
            "close the submission",
        )
        .await?;
        self.add_labels(number, &[SUBMISSION_LABEL, label]).await;
        Ok(())
    }

    /// Add labels to an issue or pull request, best effort. A missing label is
    /// not worth reporting a verdict or a submission as failed, and an author
    /// who is not a collaborator may not label anything: the title prefix is
    /// what marks a submission for them (see [`is_submission_issue`]).
    async fn add_labels(&self, number: i32, labels: &[&str]) {
        if let Err(failure) = self
            .send(
                Method::POST,
                &format!("/repos/{}/issues/{number}/labels", self.config.repo),
                Some(&json!({ "labels": labels })),
                "label the submission",
            )
            .await
        {
            tracing::info!(number, reason = %failure, "could not label the submission");
        }
    }

    /// What the current token may do on the catalogue repository.
    ///
    /// The repository's own answer about *this* token, which is the only
    /// account whose permissions a token can read.
    async fn permissions(&self) -> Result<Permissions, Failure> {
        let what = "read the catalogue repository";
        let body = self
            .send(
                Method::GET,
                &format!("/repos/{}", self.config.repo),
                None,
                what,
            )
            .await?;
        serde_json::from_str::<Repository>(&body)
            .map(|repository| repository.permissions)
            .map_err(|error| Failure::unreadable(what, error))
    }

    async fn login(&self) -> Result<GitHubUser, Failure> {
        let what = "identify the signed-in account";
        let body = self.send(Method::GET, "/user", None, what).await?;
        serde_json::from_str(&body).map_err(|error| Failure::unreadable(what, error))
    }

    /// Who the current token belongs to, and whether they may commit here.
    async fn identify(&self) -> Result<GuidesIdentity, Failure> {
        let user = self.login().await?;

        // A failure here is not a failed login: the account is signed in, it
        // simply may not be a collaborator, and the accept button will say so
        // when GitHub refuses the commit.
        let can_commit = match self.permissions().await {
            Ok(permissions) => permissions.push,
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

    /// The deciding account's login, once GitHub has said it may decide.
    ///
    /// `commit` asks for push access, which an accept needs; a rejection only
    /// closes, which triage access is enough for. Asked before anything is
    /// written, because the first write of a rejection is a comment and a
    /// comment needs no permission at all.
    async fn may_decide(&self, commit: bool) -> Result<String, String> {
        if self.stored_token().is_none() {
            return Err("not signed in to GitHub".into());
        }
        let user = self.login().await?;
        let permissions = self.permissions().await?;
        let allowed = if commit {
            permissions.push
        } else {
            permissions.may_close()
        };
        if allowed {
            return Ok(user.login);
        }
        Err(format!(
            "GitHub says {} may not {} on {}, so nothing was changed",
            user.login,
            if commit {
                "commit to the catalogue"
            } else {
                "close submissions"
            },
            self.config.repo
        ))
    }

    /// Commit the guide file, when there is one, and the catalogue entry, under
    /// an id nobody else holds. `entry` comes back with the id and link it was
    /// published under.
    async fn publish(
        &self,
        number: i32,
        guide: Option<&str>,
        entry: &mut TrainingResource,
    ) -> Result<(), String> {
        let guide = guide.map(|text| format!("{}\n", text.trim()));
        let base = entry.id.clone();
        let placed = |id: &str| {
            let mut placed = entry.clone();
            placed.id = id.to_string();
            if guide.is_some() {
                placed.url = guide_raw_url(&self.config.repo, id);
            }
            placed
        };

        // The repository's own check, before anything is written. A suffix
        // never changes the verdict, so the base id stands for all of them.
        if let Some(problem) = entry_problem(&placed(&base)) {
            return Err(format!(
                "#{number} cannot be published as it stands: {problem}. Correct the issue on GitHub and accept again"
            ));
        }

        // An id nobody else holds, in the catalogue or as a guide file. The
        // same title used to replace the first entry and its file.
        let (current, _) = self.read_catalogue().await?;
        let mut chosen = None;
        for candidate in id_candidates(&base) {
            let attempt = placed(&candidate);
            match catalogue_claim(&current, &attempt)? {
                CatalogueClaim::Taken => continue,
                CatalogueClaim::Ours => {}
                CatalogueClaim::Free => {
                    // A file nothing points at may be this submission's own,
                    // from an accept that failed before the catalogue, or
                    // somebody's file added by hand. Only the first is ours.
                    if let Some(text) = &guide {
                        let held = self.read_file(&guide_file_path(&candidate)).await?;
                        if held.is_some_and(|(held, _)| held != *text) {
                            continue;
                        }
                    }
                }
            }
            chosen = Some(attempt);
            break;
        }
        *entry = chosen.ok_or_else(|| {
            format!(
                "every id from `{base}` to `{base}-50` is already taken; change the issue's title and accept again"
            )
        })?;

        // The guide file before the catalogue, on purpose: a catalogue entry
        // whose file does not exist yet is a dead link on everybody's screen,
        // whereas a file nothing points at yet is invisible and harmless.
        if let Some(text) = &guide {
            self.write_if_changed(
                &guide_file_path(&entry.id),
                text,
                &format!("Add the guide for #{number} to the repository"),
            )
            .await?;
        }

        // Read, patch, write. The sha is what makes the write safe: if anybody
        // committed in between, GitHub rejects it rather than overwriting their
        // change, and one retry against the fresh document is enough for the
        // ordinary case of two trainers working at once.
        let mut attempts = 0;
        loop {
            attempts += 1;
            let (current, sha) = self.read_catalogue().await?;
            if catalogue_claim(&current, entry)? == CatalogueClaim::Taken {
                return Err(format!(
                    "somebody added `{}` to the catalogue a moment ago; accept again to publish under the next free id",
                    entry.id
                ));
            }
            let updated = catalogue_with(&current, entry)?;
            if updated == current {
                // Already there, byte for byte: an earlier attempt committed it.
                return Ok(());
            }
            match self
                .write_file(
                    CATALOGUE_PATH,
                    &updated,
                    Some(&sha),
                    &accept_commit_message(entry, number),
                )
                .await
            {
                Ok(()) => return Ok(()),
                Err(failure) if attempts < 2 && failure.is_conflict() => {
                    tracing::info!("the catalogue changed under us; re-reading and retrying");
                }
                Err(failure) => return Err(failure.into()),
            }
        }
    }

    /// Every page of a list the queue reads, up to [`MAX_QUEUE_PAGES`]. `path`
    /// carries its query already; the page is appended.
    async fn read_pages<T: DeserializeOwned>(
        &self,
        path: &str,
        what: &str,
    ) -> Result<Vec<T>, Failure> {
        let mut rows = Vec::new();
        for page in 1..=MAX_QUEUE_PAGES {
            let answer = self
                .read_public(&format!("{path}&page={page}"), what)
                .await?;
            let batch: Vec<T> = serde_json::from_str(&answer.body)
                .map_err(|error| Failure::unreadable(what, error))?;
            rows.extend(batch);
            if !answer.more {
                break;
            }
            if page == MAX_QUEUE_PAGES {
                tracing::warn!(
                    pages = MAX_QUEUE_PAGES,
                    what,
                    "the catalogue repository has more open items than the queue reads"
                );
            }
        }
        Ok(rows)
    }

    /// A file at a commit, as text, from the raw host rather than the API.
    async fn read_raw(&self, url: &str) -> Result<String, String> {
        let response = self
            .http
            .get(url)
            .send()
            .await
            .map_err(|error| format!("could not read {url}: {error}"))?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!("{url} answered {status}"));
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|error| format!("could not read {url}: {error}"))?;
        if bytes.len() > MAX_GUIDE_BYTES {
            return Err(format!("{url} is too large to be a guide"));
        }
        String::from_utf8(bytes.to_vec()).map_err(|_| format!("{url} is not text"))
    }

    /// One open pull request as a row of the queue.
    ///
    /// Never fails the queue: a pull request whose files or guide cannot be
    /// read is still listed, with nothing to accept in one press, because a
    /// row that says it needs a hand is better than a queue that will not load.
    async fn pull_submission(&self, pull: Pull) -> GuideSubmission {
        let number = pull.number;
        let files: Vec<PullFile> = match self
            .read_pages(
                &format!(
                    "/repos/{}/pulls/{number}/files?per_page={QUEUE_PAGE}",
                    self.config.repo
                ),
                "read a proposed guide's files",
            )
            .await
        {
            Ok(files) => files,
            Err(failure) => {
                tracing::warn!(number, reason = %failure, "could not read a proposed guide's files");
                Vec::new()
            }
        };
        let paths: Vec<String> = files.iter().map(|file| file.filename.clone()).collect();
        let id = submitted_guide_id(&paths);
        let mut foreign = foreign_files(id.as_deref(), &paths);
        // Only what the pull request adds goes in with one press. A changed,
        // renamed or removed file is an edit to something already published,
        // and that is a review on GitHub rather than a guide in a queue.
        for file in files.iter().filter(|file| file.status != "added") {
            for path in std::iter::once(&file.filename).chain(file.previous_filename.as_ref()) {
                if !foreign.contains(path) {
                    foreign.push(path.clone());
                }
            }
        }
        let images = match &id {
            Some(id) => {
                let folder = guide_image_path(id, "");
                paths
                    .iter()
                    .filter(|path| path.starts_with(&folder) && !foreign.contains(*path))
                    .cloned()
                    .collect()
            }
            None => Vec::new(),
        };

        let guide_url = match (&id, &pull.head.repo) {
            (Some(id), Some(repo)) => format!(
                "{}/{}/{}/{}",
                self.config.raw_base,
                repo.full_name,
                pull.head.sha,
                guide_file_path(id)
            ),
            _ => String::new(),
        };
        let guide = if guide_url.is_empty() {
            None
        } else {
            match self.read_raw(&guide_url).await {
                Ok(text) => Some(text),
                Err(reason) => {
                    tracing::warn!(number, %reason, "could not read a proposed guide");
                    None
                }
            }
        };

        let body = pull.body.unwrap_or_default();
        let mut entry = entry_from_issue(number, &pull.title, &body);
        // The id the files were committed under, not one derived again from
        // the title: a maintainer may have retitled the pull request, and the
        // file is where the entry has to point.
        if let (Some(entry), Some(id)) = (entry.as_mut(), id.as_ref()) {
            entry.id = id.clone();
        }
        GuideSubmission {
            number,
            summary: prose_from_body(&body),
            entry,
            author: pull
                .user
                .as_ref()
                .map(|user| user.login.clone())
                .unwrap_or_default(),
            author_avatar_url: pull
                .user
                .and_then(|user| user.avatar_url)
                .unwrap_or_default(),
            created_at: pull.created_at.unwrap_or_default(),
            url: pull.html_url.unwrap_or_default(),
            title: pull.title,
            guide,
            pull: Some(SubmissionPull {
                head_sha: pull.head.sha,
                guide_url,
                images,
                foreign,
            }),
        }
    }

    async fn pull(&self, number: i32) -> Result<Pull, Failure> {
        let what = format!("read #{number}");
        let body = self
            .send(
                Method::GET,
                &format!("/repos/{}/pulls/{number}", self.config.repo),
                None,
                &what,
            )
            .await?;
        serde_json::from_str(&body).map_err(|error| Failure::unreadable(&what, error))
    }

    /// Merge exactly `sha`, as one squashed commit. GitHub refuses if the pull
    /// request has moved on since, which is the guarantee that what a trainer
    /// read is what goes in.
    async fn merge(&self, number: i32, sha: &str, message: &str) -> Result<(), Failure> {
        self.send(
            Method::PUT,
            &format!("/repos/{}/pulls/{number}/merge", self.config.repo),
            Some(&json!({ "merge_method": "squash", "sha": sha, "commit_title": message })),
            "merge the proposed guide",
        )
        .await
        .map(|_| ())
    }

    /// Remove a decided submission's branch when it lives in this repository.
    /// Best effort: a branch left behind costs nothing, and one in the
    /// author's fork is theirs to remove.
    async fn drop_branch(&self, head: &PullHead) {
        let ours = head
            .repo
            .as_ref()
            .is_some_and(|repo| repo.full_name == self.config.repo);
        if !ours || !head.ref_name.starts_with("submission/") {
            return;
        }
        if let Err(failure) = self
            .send(
                Method::DELETE,
                &format!(
                    "/repos/{}/git/refs/heads/{}",
                    self.config.repo, head.ref_name
                ),
                None,
                "remove the submission's branch",
            )
            .await
        {
            tracing::info!(reason = %failure, "left the submission's branch in place");
        }
    }

    /// Accept a pull request: merge it, then publish its entry.
    async fn accept_pull(
        &self,
        submission: GuideSubmission,
        pull: SubmissionPull,
    ) -> Result<(), String> {
        let number = submission.number;
        let mut entry = submission
            .entry
            .clone()
            .ok_or_else(|| "this submission carries no catalogue entry to publish".to_string())?;
        let guide = submission.guide.clone().ok_or_else(|| {
            format!("the guide in #{number} could not be read, so it was not published")
        })?;
        if !pull.foreign.is_empty() {
            return Err(format!(
                "#{number} changes more than its guide and pictures ({}), so it was not merged",
                pull.foreign.join(", ")
            ));
        }
        entry.approved_by = self.may_decide(true).await?;

        let current = self.pull(number).await?;
        if current.is_closed() && !current.merged {
            return Err(format!(
                "#{number} is already closed on GitHub, so it was not published"
            ));
        }
        let comments = self.comments(number).await?;
        if comments
            .iter()
            .any(|comment| comment.contains(DECLINE_MARKER))
        {
            return Err(format!(
                "#{number} was already declined, so it was not published"
            ));
        }

        // The merge before the catalogue, for the reason an issue's guide file
        // is written first: an entry pointing at a file that is not there yet
        // is a dead link on everybody's screen.
        if !current.merged {
            if current.head.sha != pull.head_sha {
                return Err(format!(
                    "#{number} has changed since the queue read it, so it was not merged. Refresh the queue and read it again before accepting"
                ));
            }
            self.merge(
                number,
                &pull.head_sha,
                &merge_commit_message(&entry, number),
            )
            .await?;
        }

        if !comments
            .iter()
            .any(|comment| comment.contains(ACCEPT_MARKER))
        {
            self.publish(number, Some(&guide), &mut entry)
                .await
                .map_err(|reason| {
                    format!(
                        "#{number} was merged, but {reason}. Accepting again finishes it without merging twice"
                    )
                })?;
            self.comment(number, &acceptance_comment(&entry.id))
                .await
                .map_err(|failure| {
                    format!(
                        "#{number} was published as `{}`, but {failure}. Accepting again finishes it without publishing twice",
                        entry.id
                    )
                })?;
        }
        self.add_labels(number, &[SUBMISSION_LABEL, ACCEPTED_LABEL])
            .await;
        self.drop_branch(&current.head).await;
        Ok(())
    }

    /// The commit `main` points at, and that commit's tree: what a submission
    /// is built on top of.
    async fn main_commit(&self) -> Result<(String, String), Failure> {
        let what = "read the catalogue's latest commit";
        let body = self
            .send(
                Method::GET,
                &format!("/repos/{}/git/ref/heads/{GUIDES_BRANCH}", self.config.repo),
                None,
                what,
            )
            .await?;
        let reference: GitRef =
            serde_json::from_str(&body).map_err(|error| Failure::unreadable(what, error))?;
        let body = self
            .send(
                Method::GET,
                &format!(
                    "/repos/{}/git/commits/{}",
                    self.config.repo, reference.object.sha
                ),
                None,
                what,
            )
            .await?;
        let commit: GitCommit =
            serde_json::from_str(&body).map_err(|error| Failure::unreadable(what, error))?;
        Ok((reference.object.sha, commit.tree.sha))
    }

    /// An id for a new guide that neither the catalogue nor a guide file holds.
    async fn free_id(&self, entry: &TrainingResource) -> Result<String, String> {
        let (current, _) = self.read_catalogue().await?;
        for candidate in id_candidates(&entry.id) {
            let mut attempt = entry.clone();
            attempt.id = candidate.clone();
            if catalogue_claim(&current, &attempt)? != CatalogueClaim::Free {
                continue;
            }
            if self
                .read_file(&guide_file_path(&candidate))
                .await?
                .is_some()
            {
                continue;
            }
            return Ok(candidate);
        }
        Err(format!(
            "every id from `{0}` to `{0}-50` is already taken; choose another title",
            entry.id
        ))
    }

    /// The author's fork of the catalogue repository, made if there is none.
    ///
    /// Asking GitHub for a fork that exists answers with that fork, so this is
    /// safe to call every time. An old fork is brought up to the catalogue's
    /// `main` on the way, best effort: the submission's commit is built on the
    /// catalogue's own `main` either way.
    async fn fork(&self) -> Result<String, Failure> {
        let what = "fork the catalogue repository";
        let body = self
            .send(
                Method::POST,
                &format!("/repos/{}/forks", self.config.repo),
                Some(&json!({ "default_branch_only": true })),
                what,
            )
            .await?;
        let fork: RepositoryName =
            serde_json::from_str(&body).map_err(|error| Failure::unreadable(what, error))?;
        if let Err(failure) = self
            .send(
                Method::POST,
                &format!("/repos/{}/merge-upstream", fork.full_name),
                Some(&json!({ "branch": GUIDES_BRANCH })),
                "bring the fork up to date",
            )
            .await
        {
            tracing::info!(reason = %failure, "the fork was not brought up to date");
        }
        Ok(fork.full_name)
    }

    /// `POST /repos/{repo}/git/{kind}`, answering with the new object's sha.
    async fn create(
        &self,
        repo: &str,
        kind: &str,
        payload: &serde_json::Value,
        what: &str,
    ) -> Result<String, Failure> {
        let body = self
            .send(
                Method::POST,
                &format!("/repos/{repo}/git/{kind}"),
                Some(payload),
                what,
            )
            .await?;
        serde_json::from_str::<GitObject>(&body)
            .map(|object| object.sha)
            .map_err(|error| Failure::unreadable(what, error))
    }

    /// Upload one file's bytes. A fork GitHub is still making answers 404, or
    /// 409 while it has no objects yet, so those are asked again for a while.
    async fn blob(&self, repo: &str, bytes: &[u8]) -> Result<String, Failure> {
        let payload = json!({
            "content": base64::engine::general_purpose::STANDARD.encode(bytes),
            "encoding": "base64",
        });
        let mut attempts = 0;
        loop {
            attempts += 1;
            match self
                .create(repo, "blobs", &payload, "upload the submission's files")
                .await
            {
                Err(failure)
                    if repo != self.config.repo
                        && attempts < FORK_ATTEMPTS
                        && matches!(
                            failure.status,
                            Some(StatusCode::NOT_FOUND | StatusCode::CONFLICT)
                        ) =>
                {
                    tokio::time::sleep(FORK_PAUSE).await;
                }
                other => return other,
            }
        }
    }

    /// Propose a guide written in the client as a pull request: the guide and
    /// its pictures in one commit on top of the catalogue's `main`.
    async fn open_pull(
        &self,
        mut entry: TrainingResource,
        guide: &str,
        images: &[GuideImage],
    ) -> Result<String, String> {
        if self.stored_token().is_none() {
            return Err("not signed in to GitHub".into());
        }
        // Where the branch goes: the repository itself for somebody who may
        // push to it, otherwise the author's own fork, which is how anybody
        // proposes a change to a repository they cannot write.
        let can_push = match self.permissions().await {
            Ok(permissions) => permissions.push,
            Err(reason) => {
                tracing::info!(%reason, "could not read this account's repository permissions; proposing from a fork");
                false
            }
        };

        let (main, base_tree) = self.main_commit().await?;
        entry.id = self.free_id(&entry).await?;
        let id = entry.id.clone();
        let names: Vec<String> = images.iter().map(|image| image.name.clone()).collect();
        let text = format!("{}\n", place_images(guide, &id, &names).trim());

        let head_repo = if can_push {
            self.config.repo.clone()
        } else {
            self.fork().await?
        };
        let mut files = vec![(guide_file_path(&id), text.into_bytes())];
        files.extend(
            images
                .iter()
                .map(|image| (guide_image_path(&id, &image.name), image.bytes.clone())),
        );
        let mut tree = Vec::with_capacity(files.len());
        for (path, bytes) in &files {
            let sha = self.blob(&head_repo, bytes).await?;
            tree.push(json!({ "path": path, "mode": "100644", "type": "blob", "sha": sha }));
        }
        let tree = self
            .create(
                &head_repo,
                "trees",
                &json!({ "base_tree": base_tree, "tree": tree }),
                "build the submission's files",
            )
            .await?;
        let commit = self
            .create(
                &head_repo,
                "commits",
                &json!({
                    "message": format!("Submit \"{}\"", entry.title.trim()),
                    "tree": tree,
                    "parents": [main],
                }),
                "commit the submission",
            )
            .await?;
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_secs())
            .unwrap_or_default();
        let branch = submission_branch(&id, stamp);
        self.send(
            Method::POST,
            &format!("/repos/{head_repo}/git/refs"),
            Some(&json!({ "ref": format!("refs/heads/{branch}"), "sha": commit })),
            "create the submission's branch",
        )
        .await?;

        let owner = head_repo.split('/').next().unwrap_or_default();
        let mut proposal = json!({
            "title": submission_title(&entry),
            "head": if can_push { branch.clone() } else { format!("{owner}:{branch}") },
            "base": GUIDES_BRANCH,
            "body": submission_body(&entry, &pull_guide_note(&id)),
        });
        if !can_push {
            // So a maintainer can fix a typo in the guide before accepting
            // rather than declining it over one.
            proposal["maintainer_can_modify"] = json!(true);
        }
        let body = self
            .send(
                Method::POST,
                &format!("/repos/{}/pulls", self.config.repo),
                Some(&proposal),
                "propose the guide",
            )
            .await?;
        let created: Pull = serde_json::from_str(&body)
            .map_err(|error| format!("GitHub's pull request response was unreadable: {error}"))?;
        self.add_labels(created.number, &[SUBMISSION_LABEL]).await;
        Ok(created.html_url.unwrap_or_default())
    }

    /// Open a submission that carries no file, a link, as an issue.
    async fn open_issue(&self, entry: TrainingResource, guide: String) -> Result<String, String> {
        let body = self
            .send(
                Method::POST,
                &format!("/repos/{}/issues", self.config.repo),
                Some(&json!({
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

        // Cancelled while GitHub was issuing the code. Handing it on would put
        // a code on screen that nothing is waiting for.
        if self.cancelled.load(Ordering::Relaxed) {
            return Err(LOGIN_CANCELLED.into());
        }

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
            tokio::select! {
                _ = tokio::time::sleep(wait) => {}
                _ = self.cancel_wake.notified() => {}
            }
            if self.cancelled.load(Ordering::Relaxed) {
                return Err(LOGIN_CANCELLED.into());
            }
            if tokio::time::Instant::now() >= deadline {
                return Err("the sign-in code expired before it was used".into());
            }

            let answer = match self
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
            {
                Ok(response) => {
                    let body = response.text().await.unwrap_or_default();
                    serde_json::from_str::<TokenResponse>(&body).ok()
                }
                Err(error) => {
                    tracing::info!(%error, "could not reach GitHub while waiting for the sign-in; asking again");
                    None
                }
            };

            match poll_step(answer, wait) {
                PollStep::Token(token) => {
                    self.remember(&token);
                    return self.identify().await.map_err(String::from);
                }
                PollStep::Again { wait: next } => wait = next,
                PollStep::Stop(reason) => return Err(reason),
            }
        }
    }

    fn cancel_login(&self) {
        self.cancelled.store(true, Ordering::Relaxed);
        self.cancel_wake.notify_waiters();
    }

    async fn restore_login(&self) -> Result<Option<GuidesIdentity>, String> {
        if self.stored_token().is_none() {
            return Ok(None);
        }
        // Only a 401 says the token is dead, and `request` has already dropped
        // it and recorded why. Anything else (GitHub unreachable, a server
        // error, a rate limit) says nothing about the token, which is kept and
        // tried again the next time the tab opens. Dropping it on every error
        // is what signed out for good anybody who once opened the tab offline.
        self.identify().await.map(Some).map_err(String::from)
    }

    async fn sign_out(&self) {
        self.forget();
        *self.lost_session.lock().expect("guides session lock") = None;
    }

    fn take_lost_session(&self) -> Option<String> {
        self.lost_session
            .lock()
            .expect("guides session lock")
            .take()
    }

    async fn list_submissions(&self) -> Result<Vec<GuideSubmission>, String> {
        // No `labels=` filter: see `is_submission_issue` for why the label
        // cannot be what makes an issue a submission.
        let issues: Vec<Issue> = self
            .read_pages(
                &format!(
                    "/repos/{}/issues?state=open&per_page={QUEUE_PAGE}",
                    self.config.repo
                ),
                "list the submissions",
            )
            .await?;
        let mut rows = submissions_from(issues);

        let pulls: Vec<Pull> = self
            .read_pages(
                &format!(
                    "/repos/{}/pulls?state=open&per_page={QUEUE_PAGE}",
                    self.config.repo
                ),
                "list the proposed guides",
            )
            .await?;
        for pull in pulls {
            let labels: Vec<&str> = pull
                .labels
                .iter()
                .map(|label| label.name.as_str())
                .collect();
            if is_submission_issue(&pull.title, &labels) {
                rows.push(self.pull_submission(pull).await);
            }
        }
        rows.sort_by_key(|row| row.number);
        Ok(rows)
    }

    async fn accept(&self, submission: GuideSubmission) -> Result<(), String> {
        if let Some(pull) = submission.pull.clone() {
            return self.accept_pull(submission, pull).await;
        }
        let number = submission.number;
        let mut entry = submission
            .entry
            .clone()
            .ok_or_else(|| "this submission carries no catalogue entry to publish".to_string())?;

        // The account that accepts is the one the entry names as having
        // vouched for it: `approvedBy`, which the library ranks on and shows
        // as "Reviewed by". It used to be left empty on every accept.
        entry.approved_by = self.may_decide(true).await?;

        // Where an earlier attempt got to, so this one neither repeats a step
        // nor overrides a different verdict.
        let issue = self.issue(number).await?;
        if issue.is_closed() {
            return if issue.has_label(ACCEPTED_LABEL) {
                Ok(())
            } else {
                Err(format!(
                    "#{number} is already closed on GitHub, so it was not published"
                ))
            };
        }
        let comments = self.comments(number).await?;
        if comments
            .iter()
            .any(|comment| comment.contains(DECLINE_MARKER))
        {
            return Err(format!(
                "#{number} was already declined, so it was not published"
            ));
        }

        // The acceptance comment is written only after the commits succeed,
        // so its presence means both are done.
        if !comments
            .iter()
            .any(|comment| comment.contains(ACCEPT_MARKER))
        {
            self.publish(number, submission.guide.as_deref(), &mut entry)
                .await?;
            self.comment(number, &acceptance_comment(&entry.id))
                .await
                .map_err(|failure| {
                    format!(
                        "#{number} was published as `{}`, but {failure}. Accepting again finishes it without publishing twice",
                        entry.id
                    )
                })?;
        }
        self.close(number, ACCEPTED_LABEL, "completed")
            .await
            .map_err(|failure| {
                format!(
                    "#{number} was published, but {failure}. Accepting again finishes it without publishing twice"
                )
            })
    }

    async fn reject(&self, number: i32, reason: RejectReason, note: String) -> Result<(), String> {
        // Permission first: a comment needs none, so commenting first let any
        // signed-in account leave a public "not taking this one" on somebody's
        // submission and only then be refused the close.
        self.may_decide(false).await?;

        let issue = self.issue(number).await?;
        if issue.is_closed() {
            return if issue.has_label(DECLINED_LABEL) {
                Ok(())
            } else {
                Err(format!("#{number} is already closed on GitHub"))
            };
        }
        let is_pull = issue.pull_request.is_some();
        let comments = self.comments(number).await?;
        if comments
            .iter()
            .any(|comment| comment.contains(ACCEPT_MARKER))
        {
            return Err(format!(
                "#{number} is already in the catalogue; accept it again to finish closing it instead"
            ));
        }

        // The comment before the close: a closed issue with no explanation is
        // the feedback that makes people stop submitting. Skipped when an
        // earlier attempt already left it.
        if !comments
            .iter()
            .any(|comment| comment.contains(DECLINE_MARKER))
        {
            self.comment(number, &rejection_comment(reason, &note))
                .await?;
        }
        let closed = if is_pull {
            self.close_pull(number, DECLINED_LABEL).await
        } else {
            self.close(number, DECLINED_LABEL, "not_planned").await
        };
        closed.map_err(|failure| {
            format!(
                "the reason is on #{number}, but {failure}. Declining again finishes it without a second comment"
            )
        })?;
        if is_pull {
            if let Ok(pull) = self.pull(number).await {
                self.drop_branch(&pull.head).await;
            }
        }
        Ok(())
    }

    async fn submit(
        &self,
        entry: TrainingResource,
        guide: String,
        images: Vec<GuideImage>,
    ) -> Result<String, String> {
        // A link has no file to carry, so it stays an issue. Anything written
        // here is a file, and a file is a pull request.
        if guide.trim().is_empty() {
            return self.open_issue(entry, guide).await;
        }
        self.open_pull(entry, &guide, &images).await
    }
}

/// The queue's rows, out of a page of open issues.
fn submissions_from(issues: Vec<Issue>) -> Vec<GuideSubmission> {
    issues
        .into_iter()
        // A pull request is an issue as far as this endpoint is concerned,
        // and a PR against the catalogue is somebody editing it directly
        // rather than submitting through the client.
        .filter(|issue| issue.pull_request.is_none())
        .filter(|issue| {
            let labels: Vec<&str> = issue
                .labels
                .iter()
                .map(|label| label.name.as_str())
                .collect();
            is_submission_issue(&issue.title, &labels)
        })
        .map(|issue| {
            let body = issue.body.unwrap_or_default();
            // The title carries the catalogue's title and, through it, the
            // entry's id, so it is read before it is moved into the row.
            let entry = entry_from_issue(issue.number, &issue.title, &body);
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
                pull: None,
            }
        })
        .collect()
}

/// Whether a `Link` header names a further page.
fn link_has_next(link: &str) -> bool {
    link.split(',').any(|part| {
        part.split(';')
            .skip(1)
            .any(|parameter| parameter.trim() == "rel=\"next\"")
    })
}

/// What one poll of the device flow means for the loop.
#[derive(Debug, PartialEq, Eq)]
enum PollStep {
    Token(String),
    /// Poll again after `wait`.
    Again {
        wait: Duration,
    },
    Stop(String),
}

/// Read one poll's answer. `None` is a poll that got no readable answer at
/// all: GitHub unreachable, or a proxy's error page.
///
/// Such a poll is asked again rather than ending the login. A sign-in takes
/// minutes of typing on another device, and one dropped request in that time
/// used to throw away a code the player was halfway through entering. The
/// loop's deadline still bounds it.
fn poll_step(answer: Option<TokenResponse>, wait: Duration) -> PollStep {
    let Some(answer) = answer else {
        return PollStep::Again { wait };
    };
    if let Some(token) = answer.access_token {
        return PollStep::Token(token);
    }
    match answer.error.as_deref() {
        // The ordinary case: nobody has typed the code yet.
        Some("authorization_pending") => PollStep::Again { wait },
        // Asked for explicitly by GitHub when we polled too fast: five more
        // seconds, or the interval it names if that is longer.
        Some("slow_down") => {
            let slower = wait + Duration::from_secs(5);
            PollStep::Again {
                wait: answer
                    .interval
                    .map(Duration::from_secs)
                    .map_or(slower, |named| named.max(slower)),
            }
        }
        Some("expired_token") => {
            PollStep::Stop("the sign-in code expired before it was used".into())
        }
        Some("access_denied") => PollStep::Stop("the sign-in was declined".into()),
        Some(other) => PollStep::Stop(
            answer
                .error_description
                .unwrap_or_else(|| format!("GitHub refused the sign-in: {other}")),
        ),
        // JSON with neither a token nor an error is not an answer about the
        // code; ask again like any other unreadable poll.
        None => PollStep::Again { wait },
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
    /// Sent with `slow_down`: the interval GitHub now expects.
    #[serde(default)]
    interval: Option<u64>,
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
    #[serde(default)]
    triage: bool,
    #[serde(default)]
    maintain: bool,
    #[serde(default)]
    admin: bool,
}

impl Permissions {
    /// Whether this account may close somebody else's issue. Triage is the
    /// least access GitHub grants it with; every higher role includes it.
    fn may_close(&self) -> bool {
        self.triage || self.push || self.maintain || self.admin
    }
}

#[derive(Debug, Deserialize)]
struct ContentsFile {
    content: String,
    sha: String,
}

#[derive(Debug, Deserialize)]
struct Label {
    name: String,
}

#[derive(Debug, Deserialize)]
struct Comment {
    body: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Issue {
    number: i32,
    title: String,
    body: Option<String>,
    user: Option<GitHubUser>,
    created_at: Option<String>,
    html_url: Option<String>,
    /// `open` or `closed`.
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    labels: Vec<Label>,
    /// Present when the "issue" is really a pull request.
    #[serde(default)]
    pull_request: Option<serde_json::Value>,
}

impl Issue {
    fn is_closed(&self) -> bool {
        self.state.as_deref() == Some("closed")
    }

    fn has_label(&self, name: &str) -> bool {
        self.labels.iter().any(|label| label.name == name)
    }
}

#[derive(Debug, Deserialize)]
struct Pull {
    number: i32,
    title: String,
    body: Option<String>,
    user: Option<GitHubUser>,
    created_at: Option<String>,
    html_url: Option<String>,
    #[serde(default)]
    state: Option<String>,
    /// Only on a single pull request's own answer; a list leaves it out.
    #[serde(default)]
    merged: bool,
    #[serde(default)]
    labels: Vec<Label>,
    head: PullHead,
}

impl Pull {
    fn is_closed(&self) -> bool {
        self.state.as_deref() == Some("closed")
    }
}

#[derive(Debug, Deserialize)]
struct PullHead {
    sha: String,
    #[serde(rename = "ref", default)]
    ref_name: String,
    /// `None` once the fork it came from has been deleted.
    repo: Option<RepositoryName>,
}

#[derive(Debug, Deserialize)]
struct RepositoryName {
    full_name: String,
}

#[derive(Debug, Deserialize)]
struct PullFile {
    filename: String,
    /// `added`, `modified`, `removed`, `renamed` and a few rarer ones.
    #[serde(default)]
    status: String,
    #[serde(default)]
    previous_filename: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GitObject {
    sha: String,
}

#[derive(Debug, Deserialize)]
struct GitRef {
    object: GitObject,
}

#[derive(Debug, Deserialize)]
struct GitCommit {
    tree: GitObject,
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

    async fn submit(
        &self,
        _entry: TrainingResource,
        _guide: String,
        _images: Vec<GuideImage>,
    ) -> Result<String, String> {
        Err("not signed in to GitHub".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

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
    fn the_queue_keeps_submissions_with_or_without_their_label() {
        // GitHub drops `labels=` from a prefilled link for a player who is
        // not a collaborator, so issues #10 and #11 arrived unlabelled and
        // the label-filtered queue never showed them. A pull request is still
        // not a submission, and neither is ordinary repository traffic.
        let issues: Vec<Issue> = serde_json::from_str(
            r####"[
                {"number":1,"title":"Something","body":null,"labels":[{"name":"training-submission"}]},
                {"number":2,"title":"A PR","body":null,"pull_request":{"url":"x"}},
                {"number":10,"title":"Training submission: Modern UI Mods Guide 2026 [EN] [RU]",
                 "body":"### Summary\n\nUI mods.\n\n### Link\n\nhttps://fafmodsguide.pages.dev/\n","labels":[]},
                {"number":12,"title":"The catalogue has a typo","body":"see title","labels":[{"name":"bug"}]}
            ]"####,
        )
        .unwrap();
        let kept = submissions_from(issues);
        assert_eq!(
            kept.iter().map(|row| row.number).collect::<Vec<_>>(),
            vec![1, 10]
        );
        let entry = kept[1].entry.as_ref().expect("an acceptable entry");
        assert_eq!(entry.id, "modern-ui-mods-guide-2026-en-ru");
        assert_eq!(entry.url, "https://fafmodsguide.pages.dev/");
    }

    #[test]
    fn an_account_with_no_push_permission_is_signed_in_but_cannot_commit() {
        // Signing in and being a collaborator are different facts, and the
        // second one only decides wording: GitHub refuses the commit either
        // way, which is the authorisation.
        let repository: Repository =
            serde_json::from_str(r#"{"permissions":{"pull":true,"push":false}}"#).unwrap();
        assert!(!repository.permissions.push);
        assert!(!repository.permissions.may_close());

        // Triage may close (and so decline) without being able to commit.
        let triage: Repository =
            serde_json::from_str(r#"{"permissions":{"pull":true,"triage":true}}"#).unwrap();
        assert!(triage.permissions.may_close());
        assert!(!triage.permissions.push);

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
    fn decisions_are_made_on_the_status_not_on_githubs_wording() {
        let failure = |status: StatusCode| Failure::refused("x", status, r#"{"message":"m"}"#);
        assert!(failure(StatusCode::CONFLICT).is_conflict());
        assert!(failure(StatusCode::UNPROCESSABLE_ENTITY).is_conflict());
        assert!(!failure(StatusCode::FORBIDDEN).is_conflict());
        assert!(failure(StatusCode::UNAUTHORIZED).is_unauthorised());
        assert!(!failure(StatusCode::INTERNAL_SERVER_ERROR).is_unauthorised());
        assert!(!Failure::unreachable("x", "offline").is_unauthorised());
        assert_eq!(
            String::from(failure(StatusCode::CONFLICT)),
            "GitHub refused to x: m"
        );
    }

    #[test]
    fn a_link_header_says_whether_there_is_another_page() {
        assert!(link_has_next(
            r#"<https://api.github.com/repositories/1/issues?page=2>; rel="next", <https://api.github.com/repositories/1/issues?page=5>; rel="last""#
        ));
        assert!(!link_has_next(
            r#"<https://api.github.com/repositories/1/issues?page=1>; rel="prev", <https://api.github.com/repositories/1/issues?page=1>; rel="first""#
        ));
        assert!(!link_has_next(""));
    }

    #[test]
    fn a_poll_that_got_no_answer_is_asked_again_rather_than_ending_the_login() {
        let wait = Duration::from_secs(5);
        let answer = |json: &str| serde_json::from_str::<TokenResponse>(json).ok();

        assert_eq!(poll_step(None, wait), PollStep::Again { wait });
        assert_eq!(
            poll_step(answer(r#"{"error":"authorization_pending"}"#), wait),
            PollStep::Again { wait }
        );
        assert_eq!(
            poll_step(answer(r#"{"access_token":"gho_x"}"#), wait),
            PollStep::Token("gho_x".into())
        );
        // `slow_down` adds five seconds, or takes GitHub's interval if longer.
        assert_eq!(
            poll_step(answer(r#"{"error":"slow_down"}"#), wait),
            PollStep::Again {
                wait: Duration::from_secs(10)
            }
        );
        assert_eq!(
            poll_step(answer(r#"{"error":"slow_down","interval":15}"#), wait),
            PollStep::Again {
                wait: Duration::from_secs(15)
            }
        );
        assert!(matches!(
            poll_step(answer(r#"{"error":"expired_token"}"#), wait),
            PollStep::Stop(_)
        ));
        assert!(matches!(
            poll_step(answer(r#"{"error":"access_denied"}"#), wait),
            PollStep::Stop(_)
        ));
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
            raw_base: "https://raw.githubusercontent.com".into(),
            keyring_service: String::new(),
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
            raw_base: "https://raw.invalid".into(),
            keyring_service: String::new(),
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
        assert_eq!(FakeGuides.take_lost_session(), None);
        assert!(FakeGuides
            .reject(1, RejectReason::Duplicate, String::new())
            .await
            .is_err());
    }

    // -- against a stand-in for GitHub -------------------------------------

    /// One request as the stand-in server saw it.
    #[derive(Debug, Clone)]
    struct Seen {
        method: String,
        target: String,
        authorised: bool,
        body: String,
    }

    /// Status, body and an optional `Link` header.
    type Reply = (u16, String, Option<&'static str>);
    type Route = Arc<dyn Fn(&Seen) -> Reply + Send + Sync>;

    /// A local HTTP server answering every request through `route`, and the
    /// log of what it was asked.
    async fn serve(route: Route) -> (String, Arc<Mutex<Vec<Seen>>>) {
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    return;
                };
                let route = route.clone();
                let log = log.clone();
                tokio::spawn(async move {
                    let mut raw = Vec::new();
                    let mut buffer = [0_u8; 4096];
                    let head_end = loop {
                        let read = stream.read(&mut buffer).await.unwrap_or(0);
                        if read == 0 {
                            return;
                        }
                        raw.extend_from_slice(&buffer[..read]);
                        if let Some(at) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                            break at + 4;
                        }
                    };
                    let head = String::from_utf8_lossy(&raw[..head_end]).to_string();
                    let length = head
                        .lines()
                        .find_map(|line| {
                            let (key, value) = line.split_once(':')?;
                            key.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().ok())
                                .flatten()
                        })
                        .unwrap_or(0);
                    while raw.len() < head_end + length {
                        let read = stream.read(&mut buffer).await.unwrap_or(0);
                        if read == 0 {
                            break;
                        }
                        raw.extend_from_slice(&buffer[..read]);
                    }
                    let mut first = head.lines().next().unwrap_or_default().split(' ');
                    let request = Seen {
                        method: first.next().unwrap_or_default().to_string(),
                        target: first.next().unwrap_or_default().to_string(),
                        authorised: head
                            .lines()
                            .any(|line| line.to_ascii_lowercase().starts_with("authorization:")),
                        body: String::from_utf8_lossy(&raw[head_end..]).to_string(),
                    };
                    let (status, reply, link) = route(&request);
                    log.lock().unwrap().push(request);
                    let link = link.map(|l| format!("Link: {l}\r\n")).unwrap_or_default();
                    let response = format!(
                        "HTTP/1.1 {status} Stand-in\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{link}\r\n{reply}",
                        reply.len()
                    );
                    let _ = stream.write_all(response.as_bytes()).await;
                    let _ = stream.shutdown().await;
                });
            }
        });
        (base, seen)
    }

    fn client_at(base: &str) -> GuidesClient {
        GuidesClient::new(GuidesConfig {
            repo: "o/r".into(),
            client_id: CLIENT_ID.into(),
            api_base: base.into(),
            oauth_base: base.into(),
            raw_base: base.into(),
            keyring_service: String::new(),
        })
    }

    fn holding(client: &GuidesClient, token: &str) {
        *client.token.lock().unwrap() = Some(token.into());
    }

    fn reply(status: u16, body: &str) -> Reply {
        (status, body.to_string(), None)
    }

    fn contents(text: &str, sha: &str) -> String {
        json!({
            "content": base64::engine::general_purpose::STANDARD.encode(text.as_bytes()),
            "sha": sha,
        })
        .to_string()
    }

    /// The text a contents `PUT` committed.
    fn committed(request: &Seen) -> String {
        let payload: serde_json::Value = serde_json::from_str(&request.body).unwrap();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(payload["content"].as_str().unwrap())
            .unwrap();
        String::from_utf8(bytes).unwrap()
    }

    #[tokio::test]
    async fn the_queue_reads_every_page_without_a_label_filter() {
        let (base, seen) = serve(Arc::new(|request: &Seen| {
            if request.target.contains("/pulls") {
                reply(200, "[]")
            } else if request.target.ends_with("&page=1") {
                (
                    200,
                    r####"[{"number":1,"title":"Training submission: One","body":"### Summary\n\nx\n"}]"####.to_string(),
                    Some(r#"<http://x/issues?page=2>; rel="next""#),
                )
            } else {
                reply(
                    200,
                    r####"[{"number":2,"title":"Training submission: Two","body":"### Summary\n\ny\n"}]"####,
                )
            }
        }))
        .await;

        let rows = client_at(&base).list_submissions().await.expect("it lists");
        assert_eq!(
            rows.iter().map(|row| row.number).collect::<Vec<_>>(),
            vec![1, 2]
        );
        let seen = seen.lock().unwrap();
        let issue_pages = seen
            .iter()
            .filter(|request| request.target.contains("/issues?"))
            .count();
        assert_eq!(issue_pages, 2, "both pages, and no third");
        assert!(seen
            .iter()
            .all(|request| !request.target.contains("labels=")));
    }

    #[tokio::test]
    async fn a_revoked_token_reads_the_queue_anonymously_and_ends_the_session() {
        let (base, seen) = serve(Arc::new(|request: &Seen| {
            if request.authorised {
                reply(401, r#"{"message":"Bad credentials"}"#)
            } else {
                reply(200, "[]")
            }
        }))
        .await;
        let client = client_at(&base);
        holding(&client, "revoked");

        assert_eq!(client.list_submissions().await, Ok(Vec::new()));
        assert_eq!(client.stored_token(), None, "the dead token is dropped");
        assert!(client
            .take_lost_session()
            .is_some_and(|reason| reason.contains("Bad credentials")));
        assert_eq!(client.take_lost_session(), None, "said once");
        // The refused read, its anonymous repeat, and the pull requests, read
        // anonymously from the start because the token is gone by then.
        assert_eq!(seen.lock().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn only_a_401_signs_out_and_github_being_down_keeps_the_saved_login() {
        let (base, _) = serve(Arc::new(|_: &Seen| reply(503, "unavailable"))).await;
        let client = client_at(&base);
        holding(&client, "good");
        assert!(client.restore_login().await.is_err());
        assert_eq!(client.stored_token().as_deref(), Some("good"), "kept");
        assert_eq!(client.take_lost_session(), None);

        let (base, _) = serve(Arc::new(|_: &Seen| {
            reply(401, r#"{"message":"Bad credentials"}"#)
        }))
        .await;
        let client = client_at(&base);
        holding(&client, "revoked");
        assert!(client.restore_login().await.is_err());
        assert_eq!(client.stored_token(), None, "dropped");
        assert!(client.take_lost_session().is_some());
    }

    #[tokio::test]
    async fn an_account_that_may_not_close_leaves_no_comment_behind() {
        // A comment needs no permission, so commenting first used to leave a
        // public "not taking this one" from anybody signed in.
        let (base, seen) = serve(Arc::new(|request: &Seen| match request.target.as_str() {
            "/user" => reply(200, r#"{"login":"passer-by"}"#),
            "/repos/o/r" => reply(200, r#"{"permissions":{"pull":true}}"#),
            _ => reply(201, "{}"),
        }))
        .await;
        let client = client_at(&base);
        holding(&client, "token");

        let refused = client
            .reject(7, RejectReason::PoorQuality, String::new())
            .await
            .expect_err("refused");
        assert!(refused.contains("passer-by"));
        let seen = seen.lock().unwrap();
        assert!(
            seen.iter().all(|request| request.method == "GET"),
            "{seen:?}"
        );
    }

    /// GitHub as a maintainer with push access sees it, around one open,
    /// unlabelled submission (#5) whose title's slug is already taken.
    fn maintainer_route(comments: &'static str, conflicts: Arc<Mutex<u32>>) -> Route {
        Arc::new(
            move |request: &Seen| match (request.method.as_str(), request.target.as_str()) {
                ("GET", "/user") => reply(200, r#"{"login":"maintainer"}"#),
                ("GET", "/repos/o/r") => reply(200, r#"{"permissions":{"push":true}}"#),
                ("GET", "/repos/o/r/issues/5") => reply(
                    200,
                    r#"{"number":5,"title":"Training submission: A guide","state":"open","labels":[{"name":"keep-me"}]}"#,
                ),
                ("GET", "/repos/o/r/issues/5/comments?per_page=100") => reply(200, comments),
                ("GET", "/repos/o/r/contents/catalogue.json") => reply(
                    200,
                    &contents(
                        r#"{"resources":[{"id":"a-guide","title":"Somebody else's","summary":"s","url":"https://other.example/"}]}"#,
                        "sha1",
                    ),
                ),
                ("PUT", "/repos/o/r/contents/catalogue.json") => {
                    let mut left = conflicts.lock().unwrap();
                    if *left > 0 {
                        *left -= 1;
                        reply(409, r#"{"message":"catalogue.json does not match sha1"}"#)
                    } else {
                        reply(200, "{}")
                    }
                }
                _ => reply(200, "{}"),
            },
        )
    }

    fn submission() -> GuideSubmission {
        GuideSubmission {
            number: 5,
            title: "Training submission: A guide".into(),
            entry: Some(TrainingResource {
                id: "a-guide".into(),
                title: "A guide".into(),
                summary: "Mine.".into(),
                url: "https://mine.example/guide".into(),
                ..TrainingResource::default()
            }),
            ..GuideSubmission::default()
        }
    }

    #[tokio::test]
    async fn accepting_takes_a_free_id_names_the_approver_and_retries_a_409() {
        let (base, seen) = serve(maintainer_route("[]", Arc::new(Mutex::new(1)))).await;
        let client = client_at(&base);
        holding(&client, "token");

        client.accept(submission()).await.expect("accepted");

        let seen = seen.lock().unwrap();
        let puts: Vec<&Seen> = seen.iter().filter(|r| r.method == "PUT").collect();
        assert_eq!(puts.len(), 2, "one conflict, one retry");
        let catalogue: serde_json::Value = serde_json::from_str(&committed(puts[1])).unwrap();
        let resources = catalogue["resources"].as_array().unwrap();
        assert_eq!(resources.len(), 2, "the existing entry is kept");
        assert_eq!(resources[0]["id"], "a-guide");
        assert_eq!(resources[1]["id"], "a-guide-2");
        assert_eq!(resources[1]["approvedBy"], "maintainer");

        let comment = seen
            .iter()
            .find(|r| r.method == "POST" && r.target.ends_with("/comments"))
            .expect("a comment");
        assert!(comment.body.contains("a-guide-2"));

        // Closed without touching the labels a maintainer set; the verdict's
        // label is added separately.
        let close = seen.iter().find(|r| r.method == "PATCH").expect("closed");
        assert!(!close.body.contains("labels"), "{}", close.body);
        assert!(seen.iter().any(|r| r.method == "POST"
            && r.target.ends_with("/labels")
            && r.body.contains("accepted")));
    }

    #[tokio::test]
    async fn an_accept_that_already_commented_only_finishes_the_close() {
        // The comment is written after the commits, so its presence means
        // they are done: a retry must not commit or comment again.
        let marker: &'static str = Box::leak(
            json!([{ "body": acceptance_comment("a-guide-2") }])
                .to_string()
                .into_boxed_str(),
        );
        let (base, seen) = serve(maintainer_route(marker, Arc::new(Mutex::new(0)))).await;
        let client = client_at(&base);
        holding(&client, "token");

        client.accept(submission()).await.expect("finished");

        let seen = seen.lock().unwrap();
        assert!(seen.iter().all(|r| r.method != "PUT"), "no second commit");
        assert!(
            seen.iter()
                .all(|r| !(r.method == "POST" && r.target.ends_with("/comments"))),
            "no second comment"
        );
        assert!(seen.iter().any(|r| r.method == "PATCH"));
    }

    #[tokio::test]
    async fn a_declined_submission_cannot_be_accepted_afterwards() {
        let marker: &'static str = Box::leak(
            json!([{ "body": rejection_comment(RejectReason::Duplicate, "") }])
                .to_string()
                .into_boxed_str(),
        );
        let (base, seen) = serve(maintainer_route(marker, Arc::new(Mutex::new(0)))).await;
        let client = client_at(&base);
        holding(&client, "token");

        let refused = client.accept(submission()).await.expect_err("refused");
        assert!(refused.contains("declined"));
        assert!(seen.lock().unwrap().iter().all(|r| r.method == "GET"));
    }

    #[tokio::test]
    async fn an_entry_the_catalogue_check_would_refuse_is_not_committed() {
        let (base, seen) = serve(maintainer_route("[]", Arc::new(Mutex::new(0)))).await;
        let client = client_at(&base);
        holding(&client, "token");

        let mut plain_http = submission();
        if let Some(entry) = plain_http.entry.as_mut() {
            entry.url = "http://mine.example/guide".into();
        }
        let refused = client.accept(plain_http).await.expect_err("refused");
        assert!(refused.contains("https://"), "{refused}");
        assert!(seen.lock().unwrap().iter().all(|r| r.method == "GET"));
    }

    // -- guides proposed as pull requests -----------------------------------

    const GUIDE_TEXT: &str = "# Setons air\n\n![The opening](images/setons-air/opening.png)\n";
    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13];

    fn pull_json(sha: &str, head_repo: &str) -> serde_json::Value {
        json!({
            "number": 7,
            "title": "Training submission: Setons air",
            "body": "### Summary\n\nAir slot.\n\n### Guide\n\n`guides/setons-air.md` in this pull request.\n",
            "user": { "login": "author" },
            "state": "open",
            "head": { "sha": sha, "ref": "submission/setons-air-1", "repo": { "full_name": head_repo } },
        })
    }

    fn proposed() -> GuideSubmission {
        GuideSubmission {
            number: 7,
            title: "Training submission: Setons air".into(),
            entry: Some(TrainingResource {
                id: "setons-air".into(),
                title: "Setons air".into(),
                summary: "Air slot.".into(),
                ..TrainingResource::default()
            }),
            guide: Some(GUIDE_TEXT.into()),
            pull: Some(SubmissionPull {
                head_sha: "abc".into(),
                guide_url: "http://raw/o/r/abc/guides/setons-air.md".into(),
                images: vec!["guides/images/setons-air/opening.png".into()],
                foreign: Vec::new(),
            }),
            ..GuideSubmission::default()
        }
    }

    #[tokio::test]
    async fn a_proposed_guide_is_listed_with_its_guide_read_at_the_listed_commit() {
        let (base, seen) = serve(Arc::new(|request: &Seen| {
            match request.target.as_str() {
                "/repos/o/r/pulls?state=open&per_page=100&page=1" => reply(
                    200,
                    &json!([
                        pull_json("abc", "author/r"),
                        // Not a submission: ordinary traffic on the repository.
                        { "number": 8, "title": "Fix a typo", "head": { "sha": "x", "repo": null } },
                    ])
                    .to_string(),
                ),
                "/repos/o/r/pulls/7/files?per_page=100&page=1" => reply(
                    200,
                    r#"[{"filename":"guides/setons-air.md","status":"added"},
                        {"filename":"guides/images/setons-air/opening.png","status":"added"}]"#,
                ),
                "/author/r/abc/guides/setons-air.md" => reply(200, GUIDE_TEXT),
                _ => reply(200, "[]"),
            }
        }))
        .await;

        let rows = client_at(&base).list_submissions().await.expect("it lists");
        assert_eq!(rows.len(), 1, "{rows:?}");
        let row = &rows[0];
        assert_eq!(row.number, 7);
        assert_eq!(row.guide.as_deref(), Some(GUIDE_TEXT));
        assert_eq!(
            row.entry.as_ref().map(|entry| entry.id.as_str()),
            Some("setons-air")
        );
        let pull = row.pull.as_ref().expect("a pull request");
        assert_eq!(pull.head_sha, "abc");
        assert_eq!(
            pull.images,
            vec!["guides/images/setons-air/opening.png".to_string()]
        );
        assert!(pull.foreign.is_empty());
        assert!(pull
            .guide_url
            .ends_with("/author/r/abc/guides/setons-air.md"));
        assert!(row.is_acceptable());
        // The guide came from the raw host, never through the API's allowance.
        assert!(seen
            .lock()
            .unwrap()
            .iter()
            .all(|request| !request.target.contains("/contents/")));
    }

    #[tokio::test]
    async fn a_proposed_guide_that_edits_anything_else_is_listed_but_not_acceptable() {
        let (base, _) = serve(Arc::new(|request: &Seen| match request.target.as_str() {
            "/repos/o/r/pulls?state=open&per_page=100&page=1" => {
                reply(200, &json!([pull_json("abc", "author/r")]).to_string())
            }
            "/repos/o/r/pulls/7/files?per_page=100&page=1" => reply(
                200,
                r#"[{"filename":"guides/setons-air.md","status":"added"},
                        {"filename":".github/workflows/validate.yml","status":"modified"}]"#,
            ),
            "/author/r/abc/guides/setons-air.md" => reply(200, GUIDE_TEXT),
            _ => reply(200, "[]"),
        }))
        .await;

        let rows = client_at(&base).list_submissions().await.expect("it lists");
        let pull = rows[0].pull.as_ref().expect("a pull request");
        assert_eq!(
            pull.foreign,
            vec![".github/workflows/validate.yml".to_string()]
        );
        assert!(!rows[0].is_acceptable());
    }

    /// GitHub as a maintainer sees it around pull request #7, whose head is
    /// `head_sha` now.
    fn merging_route(head_sha: &'static str) -> Route {
        Arc::new(
            move |request: &Seen| match (request.method.as_str(), request.target.as_str()) {
                ("GET", "/user") => reply(200, r#"{"login":"maintainer"}"#),
                ("GET", "/repos/o/r") => reply(200, r#"{"permissions":{"push":true}}"#),
                ("GET", "/repos/o/r/pulls/7") => {
                    reply(200, &pull_json(head_sha, "o/r").to_string())
                }
                ("GET", "/repos/o/r/issues/7/comments?per_page=100") => reply(200, "[]"),
                ("PUT", "/repos/o/r/pulls/7/merge") => reply(200, r#"{"merged":true}"#),
                ("GET", "/repos/o/r/contents/catalogue.json") => {
                    reply(200, &contents(r#"{"resources":[]}"#, "sha1"))
                }
                // There after the merge, exactly as the pull request had it.
                ("GET", "/repos/o/r/contents/guides/setons-air.md") => {
                    reply(200, &contents(GUIDE_TEXT, "g1"))
                }
                ("DELETE", _) => reply(204, ""),
                _ => reply(200, "{}"),
            },
        )
    }

    #[tokio::test]
    async fn accepting_a_proposed_guide_merges_exactly_the_commit_that_was_read() {
        let (base, seen) = serve(merging_route("abc")).await;
        let client = client_at(&base);
        holding(&client, "token");

        client.accept(proposed()).await.expect("accepted");

        let seen = seen.lock().unwrap();
        let merge = seen
            .iter()
            .position(|r| r.method == "PUT" && r.target.ends_with("/merge"))
            .expect("merged");
        assert!(
            seen[merge].body.contains(r#""sha":"abc""#),
            "{}",
            seen[merge].body
        );
        assert!(seen[merge].body.contains("squash"));

        // One commit after the merge: the catalogue. The guide file is already
        // there byte for byte, so it is not written a second time.
        let puts: Vec<usize> = seen
            .iter()
            .enumerate()
            .filter(|(_, r)| r.method == "PUT" && r.target.contains("/contents/"))
            .map(|(index, _)| index)
            .collect();
        assert_eq!(puts.len(), 1, "{seen:?}");
        assert!(seen[puts[0]].target.ends_with("/contents/catalogue.json"));
        assert!(
            puts[0] > merge,
            "the file is in before the entry points at it"
        );
        let catalogue: serde_json::Value =
            serde_json::from_str(&committed(&seen[puts[0]])).unwrap();
        let entry = &catalogue["resources"][0];
        assert_eq!(entry["id"], "setons-air");
        assert_eq!(
            entry["url"],
            "https://raw.githubusercontent.com/o/r/main/guides/setons-air.md"
        );
        assert_eq!(entry["approvedBy"], "maintainer");

        // The branch lived in this repository, so it is tidied away.
        assert!(seen.iter().any(|r| r.method == "DELETE"
            && r.target == "/repos/o/r/git/refs/heads/submission/setons-air-1"));
    }

    #[tokio::test]
    async fn a_proposed_guide_that_moved_on_since_it_was_read_is_not_merged() {
        let (base, seen) = serve(merging_route("def")).await;
        let client = client_at(&base);
        holding(&client, "token");

        let refused = client.accept(proposed()).await.expect_err("refused");
        assert!(refused.contains("changed since"), "{refused}");
        assert!(
            seen.lock().unwrap().iter().all(|r| r.method == "GET"),
            "nothing written"
        );
    }

    #[tokio::test]
    async fn a_guide_from_somebody_without_push_access_is_proposed_from_their_fork() {
        let blobs = Arc::new(Mutex::new(0_u32));
        let counter = blobs.clone();
        let (base, seen) = serve(Arc::new(move |request: &Seen| {
            match (request.method.as_str(), request.target.as_str()) {
                ("GET", "/repos/o/r") => reply(200, r#"{"permissions":{"pull":true}}"#),
                ("GET", "/repos/o/r/git/ref/heads/main") => {
                    reply(200, r#"{"object":{"sha":"m1"}}"#)
                }
                ("GET", "/repos/o/r/git/commits/m1") => reply(200, r#"{"tree":{"sha":"t1"}}"#),
                ("GET", "/repos/o/r/contents/catalogue.json") => {
                    reply(200, &contents(r#"{"resources":[]}"#, "c1"))
                }
                ("GET", "/repos/o/r/contents/guides/setons-air.md") => {
                    reply(404, r#"{"message":"Not Found"}"#)
                }
                ("POST", "/repos/o/r/forks") => reply(202, r#"{"full_name":"author/r"}"#),
                ("POST", "/repos/author/r/git/blobs") => {
                    let mut count = counter.lock().unwrap();
                    *count += 1;
                    if *count == 1 {
                        // GitHub is still making the fork.
                        reply(404, r#"{"message":"Not Found"}"#)
                    } else {
                        reply(201, &json!({ "sha": format!("b{count}") }).to_string())
                    }
                }
                ("POST", "/repos/author/r/git/trees") => reply(201, r#"{"sha":"t2"}"#),
                ("POST", "/repos/author/r/git/commits") => reply(201, r#"{"sha":"c2"}"#),
                ("POST", "/repos/o/r/pulls") => reply(
                    201,
                    r#"{"number":9,"title":"Training submission: Setons air","html_url":"https://github.com/o/r/pull/9","head":{"sha":"c2","repo":{"full_name":"author/r"}}}"#,
                ),
                ("POST", "/repos/o/r/issues/9/labels") => {
                    reply(403, r#"{"message":"Must have push access"}"#)
                }
                _ => reply(201, "{}"),
            }
        }))
        .await;
        let client = client_at(&base);
        holding(&client, "token");

        let url = client
            .submit(
                TrainingResource {
                    id: "setons-air".into(),
                    title: "Setons air".into(),
                    summary: "Air slot.".into(),
                    ..TrainingResource::default()
                },
                "# Setons air\n\n![The opening](images/opening.png)".into(),
                vec![GuideImage {
                    name: "opening.png".into(),
                    bytes: PNG.to_vec(),
                }],
            )
            .await
            .expect("proposed, though the label was refused");
        assert_eq!(url, "https://github.com/o/r/pull/9");

        let seen = seen.lock().unwrap();
        let body_of = |method: &str, target: &str| -> serde_json::Value {
            let request = seen
                .iter()
                .find(|r| r.method == method && r.target == target)
                .unwrap_or_else(|| panic!("no {method} {target}: {seen:?}"));
            serde_json::from_str(&request.body).unwrap()
        };

        // The guide's pictures point at the folder they are committed to.
        let guide = seen
            .iter()
            .filter(|r| r.target == "/repos/author/r/git/blobs")
            .map(|r| {
                let payload: serde_json::Value = serde_json::from_str(&r.body).unwrap();
                base64::engine::general_purpose::STANDARD
                    .decode(payload["content"].as_str().unwrap())
                    .unwrap()
            })
            .find_map(|bytes| {
                String::from_utf8(bytes)
                    .ok()
                    .filter(|text| text.starts_with('#'))
            })
            .expect("the guide was uploaded");
        assert_eq!(
            guide,
            "# Setons air\n\n![The opening](images/setons-air/opening.png)\n"
        );

        let tree = body_of("POST", "/repos/author/r/git/trees");
        assert_eq!(tree["base_tree"], "t1");
        let paths: Vec<&str> = tree["tree"]
            .as_array()
            .unwrap()
            .iter()
            .map(|file| file["path"].as_str().unwrap())
            .collect();
        assert_eq!(
            paths,
            vec![
                "guides/setons-air.md",
                "guides/images/setons-air/opening.png"
            ]
        );
        assert_eq!(
            body_of("POST", "/repos/author/r/git/commits")["parents"],
            json!(["m1"])
        );

        let proposal = body_of("POST", "/repos/o/r/pulls");
        assert!(proposal["head"]
            .as_str()
            .unwrap()
            .starts_with("author:submission/setons-air-"));
        assert_eq!(proposal["base"], "main");
        assert_eq!(proposal["maintainer_can_modify"], true);
        assert!(proposal["body"]
            .as_str()
            .unwrap()
            .contains("`guides/setons-air.md` in this pull request."));
    }

    #[tokio::test]
    async fn a_link_with_nothing_written_is_still_an_issue() {
        let (base, seen) = serve(Arc::new(|_: &Seen| {
            reply(
                201,
                r#"{"number":3,"title":"t","html_url":"https://github.com/o/r/issues/3"}"#,
            )
        }))
        .await;
        let client = client_at(&base);
        holding(&client, "token");

        let url = client
            .submit(
                TrainingResource {
                    id: "a-video".into(),
                    title: "A video".into(),
                    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ".into(),
                    ..TrainingResource::default()
                },
                String::new(),
                Vec::new(),
            )
            .await
            .expect("opened");
        assert!(url.ends_with("/issues/3"));
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].target, "/repos/o/r/issues");
    }
}
