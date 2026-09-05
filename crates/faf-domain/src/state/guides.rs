//! Guides slice: maintaining the training catalogue from inside the client.
//!
//! The catalogue the Training tab reads lives in its own Git repository
//! (`FAForeverRustClient/guides`, see `docs/training-catalogue.md`). This slice
//! is the write side of it: a player submits a guide, a trainer accepts or
//! rejects it, and both end as changes in that repository.
//!
//! Three decisions shape everything here.
//!
//! **A submission is a GitHub issue whose body the client wrote.** The prose is
//! for the human reading it; underneath sits a fenced JSON block holding the
//! catalogue entry itself. Because the client authored it, accepting is a copy
//! rather than a rewrite, which is the whole reason a trainer can accept in one
//! step instead of retyping the tags. A human may edit the block by hand and it
//! still parses.
//!
//! **GitHub enforces the permission, not this client.** The queue is public
//! information (open issues on a public repository), so anybody may read it.
//! The accept and reject controls appear once someone has signed in, and a
//! commit from an account that is not a collaborator is refused *by GitHub*,
//! whose refusal is passed through verbatim. This is the same rule the rest of
//! the client follows: a role decides whether a control is drawn and never
//! whether an operation is allowed. The audit trail is the commit log.
//!
//! **Signing in never touches a password.** The device flow hands the player a
//! short code and a URL; GitHub authenticates them, and the client receives a
//! token it stores in the OS keyring. Exactly the posture of the FAF login.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::state::{
    kind_label, level_label, topic_label, video_still, ContributionDraft, ForumPost, TrainingKind,
    TrainingLevel, TrainingResource, TrainingTopic,
};

/// The repository the catalogue lives in. Overridable in the infrastructure so
/// a fork or a staging copy can be pointed at, but stated here because the
/// issue and commit URLs the UI shows are built from it.
pub const GUIDES_REPO: &str = "FAForeverRustClient/guides";

/// The file inside that repository the client reads and writes.
pub const CATALOGUE_PATH: &str = "catalogue.json";

/// The branch everything is read from and committed to.
pub const GUIDES_BRANCH: &str = "main";

/// The label that marks an issue as a submission rather than ordinary repo
/// traffic. Without it the queue would list bug reports about the catalogue.
pub const SUBMISSION_LABEL: &str = "training-submission";

/// What every submission's issue title starts with, so the queue's label is
/// not the only thing distinguishing one from ordinary repository traffic.
pub const SUBMISSION_PREFIX: &str = "Training submission:";

/// Where a guide written in the client is committed.
pub fn guide_file_path(id: &str) -> String {
    format!("guides/{id}.md")
}

/// The address that file is read from once it is committed.
///
/// The branch is named, not `HEAD`. `raw.githubusercontent.com` caches how it
/// resolves `HEAD` separately from the file itself, and nothing a client can
/// put in the URL bypasses that, so a `HEAD` address serves a stale file after
/// every commit. See `DEFAULT_MANIFEST` in `infra/training.rs`, which was wrong
/// the same way.
pub fn guide_raw_url(repo: &str, id: &str) -> String {
    format!(
        "https://raw.githubusercontent.com/{repo}/{GUIDES_BRANCH}/{}",
        guide_file_path(id)
    )
}

/// Who the client is signed in to GitHub as.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GuidesIdentity {
    pub login: String,
    pub avatar_url: String,
    /// Whether this account may commit to the catalogue, as GitHub reports it.
    ///
    /// Read for the sake of *wording*: it decides whether the buttons say
    /// "accept" or explain that a submission will be proposed rather than
    /// committed. It is never the authorisation, which is the answer GitHub
    /// gives to the write itself.
    pub can_commit: bool,
}

/// A device-flow login in progress.
///
/// The user code and the URL are both shown: the code has to be readable and
/// typed by hand, because the whole point of the flow is that the client never
/// sees the credentials.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DeviceLogin {
    /// The short code the user types into GitHub, e.g. `WDJB-MJHT`.
    pub user_code: String,
    /// Where they type it, `https://github.com/login/device`.
    pub verification_uri: String,
    /// Unix seconds after which the code stops working.
    pub expires_at: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum GuidesAuthStatus {
    #[default]
    SignedOut,
    /// The code has been issued and the client is waiting for GitHub.
    Waiting {
        login: Box<DeviceLogin>,
    },
    SignedIn {
        identity: Box<GuidesIdentity>,
    },
    Failed {
        reason: String,
    },
    /// No OAuth client id is configured, so signing in is not offered at all.
    ///
    /// Its own state rather than a silent absence: a maintainer looking for the
    /// accept button needs to know the client was not told which app to use,
    /// which is a deployment fact and not something they did wrong.
    Unconfigured,
}

/// One pending submission, as the queue lists it.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GuideSubmission {
    /// The issue number, which is what accept and reject address.
    pub number: i32,
    pub title: String,
    /// The prose half, with the JSON block removed: what a reviewer reads.
    pub summary: String,
    /// The catalogue entry, when the body carried a parseable one.
    ///
    /// `None` for an issue somebody opened by hand. Such a submission is still
    /// listed and still readable, but it cannot be accepted in one step,
    /// because there is nothing to copy into the catalogue.
    pub entry: Option<TrainingResource>,
    pub author: String,
    pub author_avatar_url: String,
    /// ISO 8601, straight from the API.
    pub created_at: String,
    /// The issue on github.com, for a reviewer who wants the full thread.
    pub url: String,
    /// The guide itself, when the author wrote one here instead of linking to
    /// one somewhere else. Accepting commits it as a file and points the
    /// catalogue entry at it.
    pub guide: Option<String>,
}

impl GuideSubmission {
    /// Whether accepting this can be done in one step.
    pub fn is_acceptable(&self) -> bool {
        self.entry.is_some()
    }
}

/// Why a submission was turned down.
///
/// A closed set, because the reason is written into the repository where the
/// author reads it, and "no" without a category is the feedback that makes
/// people stop submitting.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum RejectReason {
    Duplicate,
    IncorrectInformation,
    PoorQuality,
    Outdated,
    WrongCategorisation,
}

impl RejectReason {
    pub const ALL: [RejectReason; 5] = [
        RejectReason::Duplicate,
        RejectReason::IncorrectInformation,
        RejectReason::PoorQuality,
        RejectReason::Outdated,
        RejectReason::WrongCategorisation,
    ];

    /// The sentence written into the repository.
    ///
    /// English, and deliberately not translated: it is read by whoever
    /// submitted the guide on an English-language repository, and a rejection
    /// arriving in a language they do not read is not feedback.
    pub fn sentence(self) -> &'static str {
        match self {
            RejectReason::Duplicate => "the catalogue already covers this",
            RejectReason::IncorrectInformation => "some of this is not correct",
            RejectReason::PoorQuality => "this needs more work before it helps a reader",
            RejectReason::Outdated => "this describes a version of the game that has moved on",
            RejectReason::WrongCategorisation => "the tags do not match the content",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum GuidesStatus {
    #[default]
    Idle,
    Loading,
    Ready,
    Failed {
        reason: String,
    },
}

/// What a write is doing right now.
///
/// Carries the issue number so a row narrates its own progress: the queue is a
/// list, and a global spinner would say "something is happening" next to five
/// rows that are not.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum GuidesWrite {
    #[default]
    Idle,
    Accepting {
        number: i32,
    },
    Rejecting {
        number: i32,
    },
    /// A submission was published. Held so the queue can say what happened
    /// after the row it describes has gone.
    Accepted {
        number: i32,
    },
    Rejected {
        number: i32,
    },
    Failed {
        number: i32,
        reason: String,
    },
}

impl GuidesWrite {
    /// The issue a write is in flight for, if any. Rows other than this one
    /// stay operable.
    pub fn busy_number(&self) -> Option<i32> {
        match self {
            GuidesWrite::Accepting { number } | GuidesWrite::Rejecting { number } => Some(*number),
            _ => None,
        }
    }
}

/// Where a submission of our own ended up.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum SubmitStatus {
    #[default]
    Idle,
    Sending,
    /// Opened, with the issue's address so the author can follow it.
    Sent {
        url: String,
    },
    Failed {
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GuidesState {
    pub auth: GuidesAuthStatus,
    pub submissions: Vec<GuideSubmission>,
    pub status: GuidesStatus,
    pub write: GuidesWrite,
    pub submit: SubmitStatus,
    /// The repository being maintained, so the UI can name and link it without
    /// hardcoding what the infrastructure was configured with.
    pub repo: String,
    /// Submissions this session has already decided.
    ///
    /// Every verdict re-reads the queue, and GitHub's issue list does not
    /// always show a state change that happened a moment ago: the row a
    /// maintainer just declined would come back, look untouched, and invite a
    /// second verdict on it. Remembering the numbers is cheaper and more
    /// certain than guessing at a delay.
    ///
    /// Session-scoped, so an issue somebody genuinely reopens is listed again
    /// on the next start. That is the right trade: a reopened submission is
    /// rare, and one that reappears seconds after being closed is confusing
    /// every single time.
    pub settled: Vec<i32>,
}

impl GuidesState {
    /// Whether the accept and reject controls should be drawn.
    ///
    /// Visibility only. A signed-in account that turns out not to be a
    /// collaborator gets GitHub's refusal, which is a better error message than
    /// any this client could invent, and the button was never the permission.
    pub fn may_moderate(&self) -> bool {
        matches!(self.auth, GuidesAuthStatus::SignedIn { .. })
    }

    pub fn identity(&self) -> Option<&GuidesIdentity> {
        match &self.auth {
            GuidesAuthStatus::SignedIn { identity } => Some(identity),
            _ => None,
        }
    }

    pub fn submission(&self, number: i32) -> Option<&GuideSubmission> {
        self.submissions
            .iter()
            .find(|submission| submission.number == number)
    }
}

// ---------------------------------------------------------------------------
// The submission body: a filled-in form, readable by a person and by the client
// ---------------------------------------------------------------------------

/// The headings a submission's body is written with.
///
/// GitHub renders an answered **issue form** exactly like this: `### `, the
/// field's label, a blank line, the answer. So one set of headings serves both
/// paths. What the client writes and what somebody fills in on github.com are
/// the same document, and the queue never has to know which it is reading.
///
/// This is why the body carries no JSON and asks for no id. An author writes
/// prose and picks from lists; the id is derived from the title, and everything
/// a catalogue entry needs beyond that is a field on the form. Asking a person
/// to hand-edit a serialised struct was the wrong surface for the one job that
/// has to be easy.
///
/// These strings are a contract with
/// `.github/ISSUE_TEMPLATE/training-submission.yml` in the catalogue
/// repository: renaming a label there without renaming it here silently drops
/// that field from every submission opened in a browser.
mod field {
    pub const SUMMARY: &str = "Summary";
    pub const LINK: &str = "Link";
    pub const GUIDE: &str = "Guide";
    pub const KIND: &str = "Type";
    pub const LEVEL: &str = "Level";
    pub const TOPICS: &str = "Topics";
    pub const MODES: &str = "Game modes";
    pub const MAPS: &str = "Maps";
    pub const FACTIONS: &str = "Factions";
    pub const RATING_MIN: &str = "Rating from";
    pub const RATING_MAX: &str = "Rating to";
    pub const AUTHOR: &str = "FAF name";

    /// Every label. A field's answer runs until the next *field*, not until
    /// the next heading: a guide written in the client is Markdown and will
    /// have headings of its own, and cutting it at the first one truncated
    /// every guide with sections in it.
    pub const ALL: [&str; 12] = [
        SUMMARY, LINK, GUIDE, KIND, LEVEL, TOPICS, MODES, MAPS, FACTIONS, RATING_MIN, RATING_MAX,
        AUTHOR,
    ];
}

/// What GitHub writes for a field the author left blank.
const NO_RESPONSE: &str = "_No response_";

/// The `level` dropdown's "no answer" option, which is a real answer: a guide
/// that suits everybody is not the same as one whose level nobody stated, but
/// the catalogue treats both as an open band, so one option covers them.
const ANY_LEVEL: &str = "Any";

/// Write a submission's issue body as a filled-in form.
///
/// `guide` is the guide's own text, when the author wrote one here instead of
/// linking to one. It is its own section, so accepting can commit exactly that
/// text as a file and nothing of the surrounding answers.
pub fn submission_body(entry: &TrainingResource, guide: &str) -> String {
    let mut body = String::new();

    let mut section = |label: &str, value: &str| {
        body.push_str("### ");
        body.push_str(label);
        body.push_str("\n\n");
        let value = value.trim();
        body.push_str(if value.is_empty() { NO_RESPONSE } else { value });
        body.push_str("\n\n");
    };

    section(field::SUMMARY, &entry.summary);
    section(field::LINK, &entry.url);
    section(field::GUIDE, guide);
    section(field::KIND, &kind_label(entry.kind));
    section(
        field::LEVEL,
        &entry
            .level
            .map(level_label)
            .unwrap_or_else(|| ANY_LEVEL.to_string()),
    );
    section(
        field::TOPICS,
        &checklist(entry.topics.iter().map(|topic| topic_label(*topic))),
    );
    section(field::MODES, &entry.game_modes.join(", "));
    section(field::MAPS, &entry.maps.join(", "));
    section(field::FACTIONS, &checklist(entry.factions.iter().cloned()));
    section(
        field::RATING_MIN,
        &entry.rating_min.map(|n| n.to_string()).unwrap_or_default(),
    );
    section(
        field::RATING_MAX,
        &entry.rating_max.map(|n| n.to_string()).unwrap_or_default(),
    );
    section(field::AUTHOR, &entry.author);

    body
}

/// A ticked checkbox list, the way GitHub renders an answered `checkboxes`
/// field. Only the ticked ones are written; reading tolerates both.
fn checklist(values: impl Iterator<Item = String>) -> String {
    values
        .map(|value| format!("- [x] {value}"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Where `### label` starts, as a heading on a line of its own.
///
/// Line-anchored so a heading quoted inside an answer is not mistaken for a
/// field, and whole-line so `### Link` does not match `### Linkage`.
fn heading_offset(text: &str, label: &str) -> Option<usize> {
    let heading = format!("### {label}");
    text.match_indices(&heading)
        .find(|(index, _)| {
            let at_line_start = *index == 0 || text[..*index].ends_with('\n');
            let line_ends = text[*index + heading.len()..]
                .chars()
                .next()
                .is_none_or(|next| next == '\n' || next == '\r');
            at_line_start && line_ends
        })
        .map(|(index, _)| index)
}

/// One field's answer, or `None` when the body does not carry that field.
fn section_of(body: &str, label: &str) -> Option<String> {
    let start = heading_offset(body, label)? + label.len() + 4;
    let rest = &body[start..];

    // The answer runs to the next field, not to the next heading. A guide
    // written here is Markdown with sections of its own, and ending at the
    // first `###` truncated it at its first one.
    let end = field::ALL
        .iter()
        .filter_map(|other| heading_offset(rest, other))
        .min()
        .unwrap_or(rest.len());

    let answer = rest[..end].trim();
    if answer.is_empty() || answer == NO_RESPONSE {
        return None;
    }
    Some(answer.to_string())
}

/// The ticked entries of a checkbox field, lowercased for matching.
fn ticked(body: &str, label: &str) -> Vec<String> {
    section_of(body, label)
        .unwrap_or_default()
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            let rest = line
                .strip_prefix("- [x]")
                .or_else(|| line.strip_prefix("- [X]"))?;
            let value = rest.trim();
            (!value.is_empty()).then(|| value.to_lowercase())
        })
        .collect()
}

/// A comma-separated field, as a list.
fn commas(body: &str, label: &str) -> Vec<String> {
    section_of(body, label)
        .unwrap_or_default()
        .split(',')
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect()
}

/// The guide's own text, when the submission carries one.
pub fn guide_from_body(body: &str) -> Option<String> {
    section_of(body, field::GUIDE)
}

/// What a reviewer reads in the queue: the pitch, not the guide.
///
/// A body with no recognisable form is returned as it stands, because an issue
/// somebody typed freehand is still worth reading; it just cannot be accepted
/// in one step.
pub fn prose_from_body(body: &str) -> String {
    match section_of(body, field::SUMMARY) {
        Some(summary) => summary,
        None if body.contains("### ") => String::new(),
        None => strip_html_comments(body).trim().to_string(),
    }
}

/// Read the catalogue entry back out of an issue.
///
/// The title comes from the issue's own title rather than from a field, so the
/// two can never disagree, and the id is derived from it: an id is a file name
/// and the key `related` points at, which is not something to ask an author to
/// invent. A curator who wants a different one edits the title before
/// accepting.
///
/// `None` for an issue with no summary and no guide, which is what a freehand
/// issue looks like: there is nothing to publish, so the queue lists it, shows
/// it, and says it needs a hand.
pub fn entry_from_body(issue_title: &str, body: &str) -> Option<TrainingResource> {
    let title = catalogue_title(issue_title);
    if title.is_empty() {
        return None;
    }
    let summary = section_of(body, field::SUMMARY);
    let guide = section_of(body, field::GUIDE);
    let url = section_of(body, field::LINK).unwrap_or_default();
    if summary.is_none() && guide.is_none() {
        return None;
    }

    let topics = ticked(body, field::TOPICS);
    let factions = ticked(body, field::FACTIONS);
    let number =
        |label: &str| section_of(body, label).and_then(|value| value.trim().parse::<i32>().ok());

    Some(TrainingResource {
        id: slug(&title),
        title,
        summary: summary.unwrap_or_default(),
        // A submitted video gets the same thumbnail a catalogued one does, so
        // an accepted entry looks like the rest of the grid from the first
        // moment rather than after somebody adds a picture by hand.
        image_url: video_still(&url),
        kind: section_of(body, field::KIND)
            .and_then(|value| kind_from_label(&value))
            .unwrap_or(TrainingKind::Guide),
        level: section_of(body, field::LEVEL).and_then(|value| level_from_label(&value)),
        url,
        tutorial_id: None,
        author: section_of(body, field::AUTHOR).unwrap_or_default(),
        rating_min: number(field::RATING_MIN),
        rating_max: number(field::RATING_MAX),
        game_modes: commas(body, field::MODES),
        topics: TrainingTopic::ALL
            .into_iter()
            .filter(|topic| {
                let label = topic_label(*topic).to_lowercase();
                topics.contains(&label)
            })
            .collect(),
        maps: commas(body, field::MAPS),
        factions,
        duration_minutes: None,
        related: Vec::new(),
        approved_by: String::new(),
        updated_at: String::new(),
    })
}

/// A dropdown answer, back to the value it names.
///
/// Derived from the same label functions the form is generated from, so a
/// renamed label cannot make the two halves disagree: there is one table.
fn kind_from_label(label: &str) -> Option<TrainingKind> {
    TrainingKind::ALL
        .into_iter()
        .find(|kind| kind_label(*kind).eq_ignore_ascii_case(label.trim()))
}

fn level_from_label(label: &str) -> Option<TrainingLevel> {
    TrainingLevel::ALL
        .into_iter()
        .find(|level| level_label(*level).eq_ignore_ascii_case(label.trim()))
}

/// The catalogue title an issue carries, with the submission prefix removed.
pub fn catalogue_title(issue_title: &str) -> String {
    issue_title
        .trim()
        .strip_prefix(SUBMISSION_PREFIX)
        .unwrap_or(issue_title.trim())
        .trim()
        .to_string()
}

fn strip_html_comments(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("<!--") {
        out.push_str(&rest[..start]);
        match rest[start..].find("-->") {
            Some(end) => rest = &rest[start + end + 3..],
            // An unterminated comment swallows the rest, which is what a
            // Markdown renderer does too.
            None => return out,
        }
    }
    out.push_str(rest);
    out
}

/// The comment a rejection leaves behind.
pub fn rejection_comment(reason: RejectReason, note: &str) -> String {
    let mut body = format!(
        "Thanks for the submission. Not taking this one: {}.\n",
        reason.sentence()
    );
    if !note.trim().is_empty() {
        body.push('\n');
        body.push_str(note.trim());
        body.push('\n');
    }
    body.push_str("\nDeclined from the FAF client's Training tab.\n");
    body
}

// ---------------------------------------------------------------------------
// Accepting: the catalogue document, with one more entry in it
// ---------------------------------------------------------------------------

/// Add `entry` to a catalogue document, returning the document to commit.
///
/// Pure text in, pure text out, so what a commit will contain is testable
/// without a network. Parsing through `serde_json::Value` rather than through
/// `TrainingCatalogue` is deliberate: the manifest carries keys this client
/// does not model (the `//` comment keys, and whatever a future format adds),
/// and a round trip through the typed struct would delete them.
///
/// An entry whose id is already present **replaces** it rather than appending
/// a second one. Two entries with one id would make `related` ambiguous, and
/// re-accepting a corrected resubmission is the ordinary case.
pub fn catalogue_with(current: &str, entry: &TrainingResource) -> Result<String, String> {
    let mut document: serde_json::Value = serde_json::from_str(current)
        .map_err(|error| format!("the catalogue is not valid JSON: {error}"))?;
    let value = serde_json::to_value(entry)
        .map_err(|error| format!("the entry cannot be serialised: {error}"))?;

    let object = document
        .as_object_mut()
        .ok_or_else(|| "the catalogue is not a JSON object".to_string())?;
    let resources = object
        .entry("resources".to_string())
        .or_insert_with(|| serde_json::Value::Array(Vec::new()));
    let array = resources
        .as_array_mut()
        .ok_or_else(|| "the catalogue's `resources` is not an array".to_string())?;

    let existing = array.iter().position(|held| {
        held.get("id").and_then(serde_json::Value::as_str) == Some(entry.id.as_str())
    });
    match existing {
        Some(index) => array[index] = value,
        None => array.push(value),
    }

    serde_json::to_string_pretty(&document)
        .map(|text| format!("{text}\n"))
        .map_err(|error| format!("the catalogue cannot be written: {error}"))
}

/// The commit message an accept writes.
pub fn accept_commit_message(entry: &TrainingResource, number: i32) -> String {
    format!(
        "Add \"{}\" to the training catalogue (#{number})",
        entry.title.trim()
    )
}

/// A url that opens GitHub's new-issue form with the submission already in it.
///
/// The path for somebody who is not signed in to GitHub *in the client*: they
/// still have a browser session, and the issue that comes out is byte for byte
/// the one the API would have created, so accepting it works the same way.
pub fn new_issue_url(repo: &str, title: &str, body: &str) -> String {
    format!(
        "https://github.com/{repo}/issues/new?labels={SUBMISSION_LABEL}&title={}&body={}",
        crate::state::percent_encode(title),
        crate::state::percent_encode(body)
    )
}

/// The title an issue carries, so both submission paths agree on it.
pub fn submission_title(entry: &TrainingResource) -> String {
    format!("{SUBMISSION_PREFIX} {}", entry.title.trim())
}

/// An id derived from a title, for an entry nobody gave one.
///
/// Lowercase, hyphens, ASCII only: it becomes a file name in the repository and
/// the key `related` points at, so it has to survive both a filesystem and a
/// URL. A title with nothing usable in it falls back to something addressable
/// rather than to an empty id, which would be dropped on the way in.
pub fn slug(title: &str) -> String {
    let mut out = String::with_capacity(title.len());
    let mut last_dash = true;
    for character in title.chars() {
        if character.is_ascii_alphanumeric() {
            out.extend(character.to_lowercase());
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "untitled-guide".to_string()
    } else {
        // Long enough for any real title, short enough to stay a sane file name.
        trimmed
            .chars()
            .take(64)
            .collect::<String>()
            .trim_matches('-')
            .to_string()
    }
}

/// Turn what the submission form collected into a catalogue entry.
///
/// The id is derived from the title rather than asked for: it becomes a file
/// name and the key `related` points at, and asking an author to invent a
/// stable identifier is asking the wrong person. A curator can still change it
/// before accepting, because it is right there in the issue body.
pub fn entry_from_draft(draft: &ContributionDraft, author: &str) -> TrainingResource {
    let parse = |value: &str| value.trim().parse::<i32>().ok();
    TrainingResource {
        id: slug(&draft.title),
        title: draft.title.trim().to_string(),
        summary: draft.summary.trim().to_string(),
        kind: draft.kind,
        level: draft.level,
        image_url: video_still(draft.url.trim()),
        url: draft.url.trim().to_string(),
        tutorial_id: None,
        author: author.trim().to_string(),
        rating_min: parse(&draft.rating_min),
        rating_max: parse(&draft.rating_max),
        game_modes: draft.game_modes.clone(),
        topics: draft.topics.clone(),
        maps: draft.maps.clone(),
        factions: draft.factions.clone(),
        duration_minutes: None,
        related: Vec::new(),
        approved_by: String::new(),
        updated_at: String::new(),
    }
}

/// Compose the submission as a GitHub issue, prefilled.
///
/// The same body the API path sends, so a submission opened in a browser is
/// byte for byte one the queue can accept in a single step.
pub fn compose_submission(draft: &ContributionDraft, author: &str, repo: &str) -> ForumPost {
    let entry = entry_from_draft(draft, author);
    let title = submission_title(&entry);
    let body = submission_body(&entry, &draft.body);
    ForumPost {
        url: if repo.is_empty() {
            String::new()
        } else {
            new_issue_url(repo, &title, &body)
        },
        title,
        body,
    }
}

// ---------------------------------------------------------------------------
// Commands, events, reducer
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum GuidesCommand {
    /// Restore a stored token, if there is one. Runs when the tab first opens.
    Restore,
    /// Ask GitHub for a device code and start waiting for the authorisation.
    SignIn,
    /// Give up on a login in progress. The code is left to expire on its own;
    /// there is nothing to revoke because nothing was granted.
    CancelSignIn,
    SignOut,
    /// Read the open submissions. Needs no token.
    LoadQueue,
    /// Publish a submission's entry into the catalogue and close its issue.
    Accept {
        number: i32,
    },
    Reject {
        number: i32,
        reason: RejectReason,
        note: String,
    },
    /// Open a submission of our own, from the contribution form's draft.
    ///
    /// The draft travels rather than a finished entry: deriving one from the
    /// other (the id from the title, the numbers out of text fields) is a rule,
    /// and a rule the frontend also knew would be a rule written twice.
    Submit {
        draft: Box<ContributionDraft>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum GuidesEvent {
    /// The repository and whether signing in is possible at all.
    Configured {
        repo: String,
        configured: bool,
    },
    SignInStarted {
        login: Box<DeviceLogin>,
    },
    SignedIn {
        identity: Box<GuidesIdentity>,
    },
    SignInFailed {
        reason: String,
    },
    SignInCancelled,
    SignedOut,
    QueueLoading,
    QueueLoaded {
        submissions: Vec<GuideSubmission>,
    },
    QueueLoadFailed {
        reason: String,
    },
    Accepting {
        number: i32,
    },
    Accepted {
        number: i32,
    },
    Rejecting {
        number: i32,
    },
    Rejected {
        number: i32,
    },
    WriteFailed {
        number: i32,
        reason: String,
    },
    /// A fresh submission is being written, so whatever the last one did is no
    /// longer the answer to anything on screen.
    ///
    /// Its own event rather than a flag the UI keeps, because the stale value
    /// is in the backend's state: without this, composing a second guide in one
    /// session shows the *first* one's "submitted, open it" link and hides the
    /// send button, which reads as the client refusing to send the second one.
    SubmitReset,
    Submitting,
    Submitted {
        url: String,
    },
    SubmitFailed {
        reason: String,
    },
}

/// Drop a decided submission and remember that it is decided.
fn settle(state: &mut GuidesState, number: i32) {
    state.submissions.retain(|held| held.number != number);
    if !state.settled.contains(&number) {
        state.settled.push(number);
    }
}

pub fn reduce(state: &mut GuidesState, event: &GuidesEvent) {
    match event {
        GuidesEvent::Configured { repo, configured } => {
            state.repo = repo.clone();
            // Only moves *into* unconfigured, and only from signed out: a
            // restored session must not be thrown away by a later
            // configuration event arriving.
            if !configured && state.auth == GuidesAuthStatus::SignedOut {
                state.auth = GuidesAuthStatus::Unconfigured;
            }
        }
        GuidesEvent::SignInStarted { login } => {
            state.auth = GuidesAuthStatus::Waiting {
                login: login.clone(),
            }
        }
        GuidesEvent::SignedIn { identity } => {
            state.auth = GuidesAuthStatus::SignedIn {
                identity: identity.clone(),
            }
        }
        GuidesEvent::SignInFailed { reason } => {
            state.auth = GuidesAuthStatus::Failed {
                reason: reason.clone(),
            }
        }
        GuidesEvent::SignInCancelled | GuidesEvent::SignedOut => {
            state.auth = GuidesAuthStatus::SignedOut
        }
        GuidesEvent::QueueLoading => state.status = GuidesStatus::Loading,
        GuidesEvent::QueueLoaded { submissions } => {
            state.submissions = submissions
                .iter()
                .filter(|submission| !state.settled.contains(&submission.number))
                .cloned()
                .collect();
            state.status = GuidesStatus::Ready;
        }
        GuidesEvent::QueueLoadFailed { reason } => {
            state.status = GuidesStatus::Failed {
                reason: reason.clone(),
            }
        }
        GuidesEvent::Accepting { number } => {
            state.write = GuidesWrite::Accepting { number: *number }
        }
        GuidesEvent::Rejecting { number } => {
            state.write = GuidesWrite::Rejecting { number: *number }
        }
        // A settled write drops the row it settled. The queue is "what is still
        // open", and leaving a decided submission in it until the next reload
        // would invite a second verdict on it.
        GuidesEvent::Accepted { number } => {
            settle(state, *number);
            state.write = GuidesWrite::Accepted { number: *number };
        }
        GuidesEvent::Rejected { number } => {
            settle(state, *number);
            state.write = GuidesWrite::Rejected { number: *number };
        }
        GuidesEvent::WriteFailed { number, reason } => {
            state.write = GuidesWrite::Failed {
                number: *number,
                reason: reason.clone(),
            }
        }
        GuidesEvent::SubmitReset => state.submit = SubmitStatus::Idle,
        GuidesEvent::Submitting => state.submit = SubmitStatus::Sending,
        GuidesEvent::Submitted { url } => state.submit = SubmitStatus::Sent { url: url.clone() },
        GuidesEvent::SubmitFailed { reason } => {
            state.submit = SubmitStatus::Failed {
                reason: reason.clone(),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{TrainingKind, TrainingLevel, TrainingTopic};

    fn submission(number: i32) -> GuideSubmission {
        GuideSubmission {
            number,
            title: format!("Training submission: guide {number}"),
            ..GuideSubmission::default()
        }
    }

    fn entry() -> TrainingResource {
        TrainingResource {
            id: "setons-t1-build-order".into(),
            title: "Seton's Clutch T1 build order".into(),
            image_url: String::new(),
            summary: "Four mexes, then land.".into(),
            kind: TrainingKind::BuildOrder,
            level: Some(TrainingLevel::Beginner),
            url: "https://example.invalid/guide".into(),
            tutorial_id: None,
            author: "Someone".into(),
            rating_min: Some(700),
            rating_max: Some(1200),
            game_modes: vec!["4v4".into()],
            topics: vec![TrainingTopic::BuildOrder],
            maps: vec!["Setons Clutch".into()],
            factions: vec![],
            duration_minutes: Some(8),
            related: vec![],
            approved_by: String::new(),
            updated_at: String::new(),
        }
    }

    // -- the submission body -----------------------------------------------

    #[test]
    fn a_submission_body_round_trips_through_the_issue() {
        // The one property the whole one-press accept rests on: what the
        // client wrote, the client can read back. The author never sees an id
        // or a serialised struct, only answers to questions.
        let body = submission_body(&entry(), "## Opening\n\nFour mexes.");
        let read = entry_from_body(&submission_title(&entry()), &body).expect("it parses");

        // The id is derived from the title rather than carried, so it is the
        // title's slug and not whatever the entry happened to be filed under.
        // That is the point: an id is a file name and a key other entries
        // point at, and a submitter is the wrong person to ask for one.
        assert_eq!(read.id, slug(&entry().title));
        assert_eq!(read.title, entry().title);
        assert_eq!(read.summary, entry().summary);
        assert_eq!(read.kind, TrainingKind::BuildOrder);
        assert_eq!(read.level, Some(TrainingLevel::Beginner));
        assert_eq!(read.url, entry().url);
        assert_eq!(read.author, "Someone");
        assert_eq!(read.rating_min, Some(700));
        assert_eq!(read.rating_max, Some(1200));
        assert_eq!(read.game_modes, vec!["4v4".to_string()]);
        assert_eq!(read.topics, vec![TrainingTopic::BuildOrder]);
        assert_eq!(read.maps, vec!["Setons Clutch".to_string()]);
        assert_eq!(
            guide_from_body(&body).as_deref(),
            Some("## Opening\n\nFour mexes.")
        );
    }

    #[test]
    fn the_body_is_a_form_a_person_can_read_and_edit() {
        // No JSON, no id: the two things a submitter should never be asked to
        // hand-write. This is also exactly what GitHub renders for an answered
        // issue form, which is what lets both submission paths produce the
        // same document.
        let body = submission_body(&entry(), "");

        assert!(body.starts_with("### Summary\n\nFour mexes, then land."));
        assert!(body.contains("### Type\n\nBuild order"));
        assert!(body.contains("### Topics\n\n- [x] Build orders"));
        assert!(!body.contains("```"), "no code fences");
        assert!(!body.contains("\"id\""), "the id is never asked for");
    }

    #[test]
    fn a_field_the_author_left_blank_reads_as_absent() {
        // GitHub writes `_No response_` for an unanswered optional field, and
        // reading that as the literal string would put it in the catalogue.
        let body =
            "### Summary\n\nA pitch.\n\n### Link\n\n_No response_\n\n### Guide\n\n_No response_\n";
        let read = entry_from_body("Training submission: A guide", body).expect("it parses");

        assert_eq!(read.url, "");
        assert_eq!(guide_from_body(body), None);
        assert_eq!(read.level, None, "an unstated level is an open band");
    }

    #[test]
    fn a_dropdown_answer_is_matched_however_it_is_cased() {
        // The form's options and this parser come from one table, but a person
        // editing the body by hand types what looks right to them.
        let body = "### Summary\n\nx\n\n### Type\n\nbuild order\n\n### Level\n\nADVANCED\n";
        let read = entry_from_body("A guide", body).expect("it parses");
        assert_eq!(read.kind, TrainingKind::BuildOrder);
        assert_eq!(read.level, Some(TrainingLevel::Advanced));
    }

    #[test]
    fn an_unrecognised_answer_falls_back_rather_than_dropping_the_submission() {
        let body = "### Summary\n\nx\n\n### Type\n\nInterpretive dance\n\n### Level\n\nAny\n";
        let read = entry_from_body("A guide", body).expect("it still parses");
        assert_eq!(read.kind, TrainingKind::Guide, "the default kind");
        assert_eq!(read.level, None);
    }

    #[test]
    fn only_ticked_boxes_are_read() {
        let body = "### Summary\n\nx\n\n### Topics\n\n- [x] Economy\n- [ ] Micro\n- [X] Scouting\n";
        let read = entry_from_body("A guide", body).expect("it parses");
        assert_eq!(
            read.topics,
            vec![TrainingTopic::Economy, TrainingTopic::Scouting]
        );
    }

    #[test]
    fn the_id_comes_from_the_title_and_the_prefix_is_not_part_of_it() {
        // The title lives in one place, the issue's own, so the two can never
        // disagree. A curator who wants a different id edits the title.
        assert_eq!(
            catalogue_title("Training submission:  Seton's opening  "),
            "Seton's opening"
        );
        assert_eq!(catalogue_title("Just a title"), "Just a title");

        let read = entry_from_body("Training submission: Seton's opening", "### Summary\n\nx\n")
            .expect("it parses");
        assert_eq!(read.title, "Seton's opening");
        assert_eq!(read.id, "seton-s-opening");
    }

    #[test]
    fn an_issue_somebody_typed_freehand_is_listed_but_not_acceptable() {
        // Worth reading, and worth answering. There is simply nothing to
        // publish, so accepting in one step is not offered.
        let freehand = "I think you should add my video";
        assert_eq!(entry_from_body("Add my video", freehand), None);
        assert_eq!(prose_from_body(freehand), freehand);

        let listed = GuideSubmission {
            number: 4,
            entry: None,
            ..GuideSubmission::default()
        };
        assert!(!listed.is_acceptable());
    }

    #[test]
    fn a_form_with_every_field_blank_carries_nothing_to_publish() {
        let empty = "### Summary\n\n_No response_\n\n### Guide\n\n_No response_\n";
        assert_eq!(entry_from_body("Training submission: Nothing", empty), None);
    }

    #[test]
    fn the_guide_is_not_what_the_queue_shows_as_a_summary() {
        // A reviewer scanning the queue wants the pitch and opens the row to
        // read the guide.
        let body = submission_body(&entry(), "## Opening\n\nFour mexes everywhere.");
        let prose = prose_from_body(&body);
        assert_eq!(prose, "Four mexes, then land.");
        assert!(!prose.contains("Opening"));
    }

    #[test]
    fn a_heading_inside_an_answer_does_not_end_the_field() {
        // A written guide is Markdown and will contain headings of its own.
        let body = submission_body(
            &entry(),
            "### Step one\n\nBuild.\n\n### Step two\n\nAttack.",
        );
        assert_eq!(
            guide_from_body(&body).as_deref(),
            Some("### Step one\n\nBuild.\n\n### Step two\n\nAttack."),
            "only a heading that names a field ends one"
        );
        // And the field after it is still found.
        let read = entry_from_body(&submission_title(&entry()), &body).expect("it parses");
        assert_eq!(read.author, "Someone");
    }

    #[test]
    fn the_submission_form_becomes_an_entry_the_queue_can_accept() {
        let draft = ContributionDraft {
            title: "How to defend early T1 aggression".into(),
            summary: "What to build and where to stand.".into(),
            kind: TrainingKind::Guide,
            level: Some(TrainingLevel::Beginner),
            url: String::new(),
            body: "## Walls\n\nBuild them.".into(),
            topics: vec![TrainingTopic::Micro],
            game_modes: vec!["1v1".into()],
            maps: vec![],
            factions: vec![],
            rating_min: "800".into(),
            rating_max: "1200".into(),
        };

        let post = compose_submission(&draft, "someone", GUIDES_REPO);
        assert_eq!(
            post.title,
            "Training submission: How to defend early T1 aggression"
        );

        // The round trip is what makes one-press accept possible.
        let entry = entry_from_body(&post.title, &post.body).expect("it parses");
        assert_eq!(entry.id, "how-to-defend-early-t1-aggression");
        assert_eq!(entry.summary, "What to build and where to stand.");
        assert_eq!(entry.author, "someone");
        assert_eq!(entry.rating_min, Some(800));
        assert_eq!(
            guide_from_body(&post.body).as_deref(),
            Some("## Walls\n\nBuild them.")
        );
        assert!(post
            .url
            .starts_with("https://github.com/FAForeverRustClient/guides/issues/new?"));
    }

    #[test]
    fn a_rating_that_is_not_a_number_is_left_unset_rather_than_zero() {
        // The form's rating fields are text so they can be empty mid-edit.
        // Reading "" as 0 would publish a guide claiming to be for beginners
        // at zero rating.
        let draft = ContributionDraft {
            title: "A guide".into(),
            rating_min: String::new(),
            rating_max: "not a number".into(),
            ..ContributionDraft::default()
        };
        let entry = entry_from_draft(&draft, "");
        assert_eq!(entry.rating_min, None);
        assert_eq!(entry.rating_max, None);
    }

    #[test]
    fn without_a_repository_the_body_still_exists_and_only_the_link_is_missing() {
        let draft = ContributionDraft {
            title: "A guide".into(),
            body: "Words.".into(),
            ..ContributionDraft::default()
        };
        let post = compose_submission(&draft, "", "");
        assert!(post.url.is_empty());
        assert!(!post.body.is_empty());
    }

    // -- accepting ---------------------------------------------------------

    #[test]
    fn accepting_appends_the_entry_to_the_catalogue() {
        let current = r#"{"resources":[{"id":"existing","title":"Existing"}]}"#;
        let written = catalogue_with(current, &entry()).expect("it writes");

        let document: serde_json::Value = serde_json::from_str(&written).unwrap();
        let resources = document["resources"].as_array().unwrap();
        assert_eq!(resources.len(), 2);
        assert_eq!(resources[1]["id"], "setons-t1-build-order");
        assert_eq!(resources[1]["ratingMin"], 700);
        assert!(written.ends_with('\n'), "a text file ends with a newline");
    }

    #[test]
    fn re_accepting_a_corrected_submission_replaces_rather_than_duplicates() {
        // Two entries under one id would make `related` ambiguous, and a
        // corrected resubmission is the ordinary case, not an edge one.
        let current = r#"{"resources":[{"id":"setons-t1-build-order","title":"Old"}]}"#;
        let written = catalogue_with(current, &entry()).unwrap();
        let document: serde_json::Value = serde_json::from_str(&written).unwrap();
        let resources = document["resources"].as_array().unwrap();
        assert_eq!(resources.len(), 1);
        assert_eq!(resources[0]["title"], "Seton's Clutch T1 build order");
    }

    #[test]
    fn keys_this_client_does_not_model_survive_a_commit() {
        // The manifest carries `//` comment keys and a trainer list. A round
        // trip through the typed catalogue struct would delete both, and the
        // commit would silently be a deletion.
        let current = r#"{
            "//": "a note to maintainers",
            "links": {"discordUrl": "https://discord.gg/By9tNUAq8B"},
            "trainers": [{"name": "Someone"}],
            "resources": [],
            "futureField": 42
        }"#;
        let written = catalogue_with(current, &entry()).unwrap();

        assert!(written.contains("a note to maintainers"));
        assert!(written.contains("discord.gg/By9tNUAq8B"));
        assert!(written.contains("Someone"));
        assert!(written.contains("futureField"));
    }

    #[test]
    fn a_catalogue_without_a_resources_array_gains_one() {
        let written = catalogue_with("{}", &entry()).unwrap();
        let document: serde_json::Value = serde_json::from_str(&written).unwrap();
        assert_eq!(document["resources"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn a_broken_catalogue_refuses_the_commit_instead_of_replacing_it() {
        // The alternative is committing a file that discards whatever was
        // there, which is the one failure nobody could undo from the client.
        assert!(catalogue_with("{not json", &entry()).is_err());
        assert!(catalogue_with("[]", &entry()).is_err());
        assert!(catalogue_with(r#"{"resources":{}}"#, &entry()).is_err());
    }

    #[test]
    fn the_commit_message_names_the_guide_and_its_issue() {
        assert_eq!(
            accept_commit_message(&entry(), 12),
            "Add \"Seton's Clutch T1 build order\" to the training catalogue (#12)"
        );
    }

    // -- rejections --------------------------------------------------------

    #[test]
    fn a_rejection_carries_a_reason_the_author_can_act_on() {
        let comment = rejection_comment(RejectReason::WrongCategorisation, "It is a 1v1 guide.");
        assert!(comment.contains("the tags do not match the content"));
        assert!(comment.contains("It is a 1v1 guide."));

        // The note is optional; the reason is not.
        let bare = rejection_comment(RejectReason::Duplicate, "");
        assert!(bare.contains("already covers this"));
    }

    // -- reducer -----------------------------------------------------------

    #[test]
    fn a_missing_client_id_is_its_own_state_rather_than_a_missing_button() {
        // A maintainer looking for the accept button needs to know the client
        // was not told which OAuth app to use. That is a deployment fact, not
        // something they did wrong.
        let mut state = GuidesState::default();
        reduce(
            &mut state,
            &GuidesEvent::Configured {
                repo: GUIDES_REPO.into(),
                configured: false,
            },
        );
        assert_eq!(state.auth, GuidesAuthStatus::Unconfigured);
        assert_eq!(state.repo, GUIDES_REPO);
        assert!(!state.may_moderate());
    }

    #[test]
    fn a_restored_session_is_not_thrown_away_by_a_later_configuration_event() {
        let mut state = GuidesState::default();
        reduce(
            &mut state,
            &GuidesEvent::SignedIn {
                identity: Box::new(GuidesIdentity {
                    login: "someone".into(),
                    avatar_url: String::new(),
                    can_commit: true,
                }),
            },
        );
        reduce(
            &mut state,
            &GuidesEvent::Configured {
                repo: GUIDES_REPO.into(),
                configured: false,
            },
        );
        assert!(state.may_moderate(), "still signed in");
    }

    #[test]
    fn a_login_narrates_its_code_then_settles() {
        // The code has to be on screen the whole time it is valid: it is typed
        // by hand into GitHub, which is the point of the flow.
        let mut state = GuidesState::default();
        reduce(
            &mut state,
            &GuidesEvent::SignInStarted {
                login: Box::new(DeviceLogin {
                    user_code: "WDJB-MJHT".into(),
                    verification_uri: "https://github.com/login/device".into(),
                    expires_at: 1_800_000_900,
                }),
            },
        );
        match &state.auth {
            GuidesAuthStatus::Waiting { login } => assert_eq!(login.user_code, "WDJB-MJHT"),
            other => panic!("expected a waiting login, got {other:?}"),
        }
        assert!(!state.may_moderate(), "waiting is not signed in");

        reduce(
            &mut state,
            &GuidesEvent::SignedIn {
                identity: Box::new(GuidesIdentity {
                    login: "someone".into(),
                    avatar_url: String::new(),
                    can_commit: true,
                }),
            },
        );
        assert!(state.may_moderate());
        assert_eq!(
            state.identity().map(|me| me.login.as_str()),
            Some("someone")
        );
    }

    #[test]
    fn signing_out_takes_the_moderation_controls_with_it() {
        let mut state = GuidesState {
            auth: GuidesAuthStatus::SignedIn {
                identity: Box::new(GuidesIdentity::default()),
            },
            ..GuidesState::default()
        };
        reduce(&mut state, &GuidesEvent::SignedOut);
        assert_eq!(state.auth, GuidesAuthStatus::SignedOut);
        assert!(!state.may_moderate());
    }

    #[test]
    fn a_settled_verdict_drops_the_row_it_settled() {
        // The queue is "what is still open". Leaving a decided submission in it
        // until the next reload invites a second verdict on it.
        let mut state = GuidesState {
            submissions: vec![
                GuideSubmission {
                    number: 1,
                    ..GuideSubmission::default()
                },
                GuideSubmission {
                    number: 2,
                    ..GuideSubmission::default()
                },
            ],
            ..GuidesState::default()
        };

        reduce(&mut state, &GuidesEvent::Accepting { number: 1 });
        assert_eq!(state.write.busy_number(), Some(1));

        reduce(&mut state, &GuidesEvent::Accepted { number: 1 });
        assert_eq!(
            state
                .submissions
                .iter()
                .map(|s| s.number)
                .collect::<Vec<_>>(),
            vec![2]
        );
        assert_eq!(state.write, GuidesWrite::Accepted { number: 1 });
        assert_eq!(state.write.busy_number(), None, "nothing is in flight now");
    }

    #[test]
    fn a_decided_submission_does_not_come_back_on_the_next_read() {
        // Every verdict re-reads the queue, and GitHub's list can still show
        // an issue it closed a moment ago. Without this the row a maintainer
        // just declined reappears looking untouched.
        let mut state = GuidesState::default();
        reduce(
            &mut state,
            &GuidesEvent::QueueLoaded {
                submissions: vec![submission(1), submission(2)],
            },
        );
        reduce(&mut state, &GuidesEvent::Rejected { number: 1 });
        assert_eq!(state.submissions.len(), 1);

        // The reload that follows the verdict, with GitHub still listing it.
        reduce(
            &mut state,
            &GuidesEvent::QueueLoaded {
                submissions: vec![submission(1), submission(2)],
            },
        );
        assert_eq!(
            state
                .submissions
                .iter()
                .map(|s| s.number)
                .collect::<Vec<_>>(),
            vec![2],
            "the declined submission stays gone"
        );
    }

    #[test]
    fn a_failed_write_keeps_the_row_so_it_can_be_tried_again() {
        let mut state = GuidesState {
            submissions: vec![GuideSubmission {
                number: 7,
                ..GuideSubmission::default()
            }],
            ..GuidesState::default()
        };
        reduce(&mut state, &GuidesEvent::Rejecting { number: 7 });
        reduce(
            &mut state,
            &GuidesEvent::WriteFailed {
                number: 7,
                reason: "Resource not accessible by integration".into(),
            },
        );
        assert_eq!(state.submissions.len(), 1);
        match &state.write {
            GuidesWrite::Failed { number, reason } => {
                assert_eq!(*number, 7);
                assert!(reason.contains("not accessible"), "GitHub's own words");
            }
            other => panic!("expected a failure, got {other:?}"),
        }
    }

    #[test]
    fn only_the_row_being_written_is_busy() {
        // A global spinner would say "something is happening" beside four rows
        // where nothing is.
        let write = GuidesWrite::Accepting { number: 3 };
        assert_eq!(write.busy_number(), Some(3));
        assert_eq!(GuidesWrite::Idle.busy_number(), None);
        assert_eq!(GuidesWrite::Accepted { number: 3 }.busy_number(), None);
    }

    #[test]
    fn a_failed_queue_load_keeps_whatever_was_already_listed() {
        let mut state = GuidesState {
            submissions: vec![GuideSubmission::default()],
            status: GuidesStatus::Ready,
            ..GuidesState::default()
        };
        reduce(
            &mut state,
            &GuidesEvent::QueueLoadFailed {
                reason: "rate limited".into(),
            },
        );
        assert_eq!(state.submissions.len(), 1);
    }

    #[test]
    fn a_submission_of_our_own_reports_where_it_landed() {
        let mut state = GuidesState::default();
        reduce(&mut state, &GuidesEvent::Submitting);
        assert_eq!(state.submit, SubmitStatus::Sending);
        reduce(
            &mut state,
            &GuidesEvent::Submitted {
                url: "https://github.com/FAForeverRustClient/guides/issues/12".into(),
            },
        );
        match &state.submit {
            SubmitStatus::Sent { url } => assert!(url.ends_with("/12")),
            other => panic!("expected a sent submission, got {other:?}"),
        }
    }

    #[test]
    fn a_second_submission_does_not_answer_with_the_first_one_s_link() {
        // Writing two guides in one session is the ordinary case for anybody
        // who writes one. Without the reset the second composed post still
        // carried "submitted, open it" pointing at the first issue, and the
        // send button stayed hidden because the state said it was done.
        let mut state = GuidesState::default();
        reduce(
            &mut state,
            &GuidesEvent::Submitted {
                url: "https://github.com/FAForeverRustClient/guides/issues/12".into(),
            },
        );
        reduce(&mut state, &GuidesEvent::SubmitReset);
        assert_eq!(state.submit, SubmitStatus::Idle);
    }
}
