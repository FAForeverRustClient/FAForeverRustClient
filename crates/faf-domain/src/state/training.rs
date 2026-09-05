//! Training slice: the client's side of learning FAF.
//!
//! FAF does not lack training material. It lacks a place where a player can
//! find out that the material exists, where it is, and which of it applies to
//! them. Videos are spread over a dozen YouTube channels, guides over the wiki
//! and the forum, and the human half (replay reviews, trainers) lives in
//! Discord behind a channel you have to know the name of. None of that is a
//! problem the wiki can solve, because the missing ingredient is knowing *who
//! the reader is*, and the client is the only piece of FAF that already does.
//!
//! So this slice is a discovery and routing layer, not a content store:
//!
//! - a **catalogue** of resources with enough metadata to be filtered and
//!   recommended: rating band, game modes, maps, factions, topics, level;
//! - a **profile** derived from state the client already holds (rating, the
//!   maps and modes recently played, factions used), which turns the catalogue
//!   into "recommended for you";
//! - two **routing** paths back out to the community: a replay review request
//!   and a content submission, both composed here as a ready forum post so the
//!   player does not have to find a channel, read a template and fill it in by
//!   hand.
//!
//! Deliberately *not* here: a moderation queue. Accepting or rejecting a
//! submission is a server-side decision with no FAF endpoint behind it yet, and
//! a queue that cannot record its own verdict is a screen that lies. See
//! `docs/training-features.md`.
//!
//! The catalogue itself is small on purpose. Two sources fill it: FAF's own
//! tutorial API (already modelled in [`crate::state::tutorials`]) and an
//! optional remote manifest. Nothing about the shape here assumes which.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::state::{AppState, Tutorial};

/// The FAF forum, which is where both routing paths land.
pub const FORUM_BASE: &str = "https://forum.faforever.com";

/// How many resources the hub's "recommended for you" rail asks for.
pub const RECOMMENDED_LIMIT: usize = 6;

/// What kind of thing a resource is, as the reader experiences it.
///
/// Distinct from [`TrainingTopic`] (what it is about) and [`TrainingLevel`]
/// (who it is for), because a player filters on all three independently: "a
/// video about economy for beginners" is three separate choices.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TrainingKind {
    Video,
    /// The default, and what an untagged manifest entry becomes: most of what
    /// the community writes down is a guide of some sort, and calling an
    /// untyped entry a video or a lesson would be a claim the manifest did not
    /// make.
    #[default]
    Guide,
    BuildOrder,
    ReplayAnalysis,
    /// A playable FAF lesson: the tutorials API's own entries.
    Lesson,
    /// A place rather than a document: a Discord server, a forum category.
    Community,
}

impl TrainingKind {
    /// Every kind, in the order a filter offers them.
    pub const ALL: [TrainingKind; 6] = [
        TrainingKind::Lesson,
        TrainingKind::Video,
        TrainingKind::Guide,
        TrainingKind::BuildOrder,
        TrainingKind::ReplayAnalysis,
        TrainingKind::Community,
    ];
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TrainingLevel {
    Beginner,
    Intermediate,
    Advanced,
}

impl TrainingLevel {
    pub const ALL: [TrainingLevel; 3] = [
        TrainingLevel::Beginner,
        TrainingLevel::Intermediate,
        TrainingLevel::Advanced,
    ];

    /// The rating band a level implies when a resource states no numbers.
    ///
    /// Rough by design, and only ever used as a fallback: an author who cares
    /// about the boundary states it. The bands follow how FAF talks about its
    /// own ladder rather than any server-side definition.
    pub fn implied_band(self) -> (Option<i32>, Option<i32>) {
        match self {
            TrainingLevel::Beginner => (None, Some(1000)),
            TrainingLevel::Intermediate => (Some(800), Some(1600)),
            TrainingLevel::Advanced => (Some(1400), None),
        }
    }
}

/// What a resource teaches.
///
/// A closed set rather than free tags: the point of the hub is that a player
/// can scan the whole of it, and free tags produce forty near-synonyms nobody
/// can filter by. A resource that fits none of these is simply untagged.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TrainingTopic {
    Economy,
    BuildOrder,
    Micro,
    Strategy,
    ArmyComposition,
    MapControl,
    Scouting,
    Factions,
    Teamplay,
    /// The client and the game's own interface: hotkeys, templates, options.
    Interface,
}

impl TrainingTopic {
    pub const ALL: [TrainingTopic; 10] = [
        TrainingTopic::Economy,
        TrainingTopic::BuildOrder,
        TrainingTopic::Micro,
        TrainingTopic::Strategy,
        TrainingTopic::ArmyComposition,
        TrainingTopic::MapControl,
        TrainingTopic::Scouting,
        TrainingTopic::Factions,
        TrainingTopic::Teamplay,
        TrainingTopic::Interface,
    ];

    /// The four the hub offers as "learn the basics", in reading order.
    ///
    /// Not the first four of [`Self::ALL`] by accident: these are the ones a
    /// new player is told to learn first, and the order is the order they
    /// build on each other.
    pub const BASICS: [TrainingTopic; 4] = [
        TrainingTopic::Economy,
        TrainingTopic::BuildOrder,
        TrainingTopic::Micro,
        TrainingTopic::MapControl,
    ];
}

/// One piece of training material.
///
/// Complete by the time it reaches here: a manifest states only what it knows,
/// and filling in the rest is the job of the wire DTO at the boundary
/// (`faf_app::infra::training`) rather than of every reader of this type.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TrainingResource {
    /// Stable across catalogue reloads: it is what `related` points at, what
    /// the recommendation list carries, and what the UI keys rows by.
    pub id: String,
    pub title: String,
    pub summary: String,
    pub kind: TrainingKind,
    pub level: Option<TrainingLevel>,
    /// Where it lives. Empty for a playable lesson, which is launched rather
    /// than opened.
    pub url: String,
    /// Set when this entry *is* a FAF tutorial, which is what makes a manifest
    /// able to add tags to a lesson the API describes without tags.
    /// A picture for the card, when there is one to be had.
    ///
    /// The grid is pictures with captions, because a player recognises a map or
    /// a creator's thumbnail long before they read a title. Three sources, in
    /// order: what the manifest states, what FAF's tutorial API already gives a
    /// lesson, and [`video_still`] for a video whose host publishes one. An
    /// entry with none of those falls back to a mark saying what it is, which
    /// is honest and still scannable.
    pub image_url: String,
    pub tutorial_id: Option<i32>,
    pub author: String,
    pub rating_min: Option<i32>,
    pub rating_max: Option<i32>,
    /// Free text on purpose (`1v1`, `2v2`, `4v4`, `coop`): the matchmaker's
    /// queue names change with the season and a closed enum here would have to
    /// be edited to describe an event that already exists.
    pub game_modes: Vec<String>,
    pub topics: Vec<TrainingTopic>,
    /// Map names as a player reads them, matched case-insensitively and by
    /// substring, because the same map is `Setons Clutch`, `SCMP_009` and
    /// "Seton's" depending on who wrote it down.
    pub maps: Vec<String>,
    pub factions: Vec<String>,
    pub duration_minutes: Option<i32>,
    /// Other resource ids worth reading next. The reason the library is a graph
    /// rather than a list: a guide about a mistake can point at the lesson that
    /// fixes it.
    pub related: Vec<String>,
    /// Who vouched for it, when anyone has. Deliberately not "official": a
    /// trainer clicking accept has not checked every sentence, and a label that
    /// implies they did is worse than no label.
    pub approved_by: String,
    pub updated_at: String,
    /// Whether this entry's text can be read in the tab rather than opened in a
    /// browser.
    ///
    /// Set where the catalogue is parsed, because only there is it known which
    /// repository this build trusts; see [`hosted_guide`]. Derived rather than
    /// stated, for the same reason `image_url` is: a manifest claiming a
    /// document is readable would not make it so.
    pub readable: bool,
}

/// Whether `rating` falls inside `[min, max]`.
///
/// An unstated bound is open, and a band with neither bound is everyone's:
/// absence of a claim is not a claim of exclusion. Shared by resources and
/// trainers so the two cannot disagree about what a band means, and pinned by
/// the library filter's conformance cases through
/// [`TrainingResource::covers_rating`].
pub fn within_band(min: Option<i32>, max: Option<i32>, rating: i32) -> bool {
    min.is_none_or(|min| rating >= min) && max.is_none_or(|max| rating <= max)
}

impl TrainingResource {
    /// Whether this resource is meant for a player at `rating`.
    pub fn covers_rating(&self, rating: i32) -> bool {
        let (min, max) = self.band();
        within_band(min, max, rating)
    }

    /// The stated band, falling back to the one the level implies.
    pub fn band(&self) -> (Option<i32>, Option<i32>) {
        if self.rating_min.is_some() || self.rating_max.is_some() {
            return (self.rating_min, self.rating_max);
        }
        self.level
            .map(TrainingLevel::implied_band)
            .unwrap_or((None, None))
    }

    /// Whether this is a lesson the client can start rather than a link.
    pub fn is_lesson(&self) -> bool {
        self.tutorial_id.is_some() && self.kind == TrainingKind::Lesson
    }

    /// Whether `needle` (already lowercased) appears in the text of the entry.
    pub fn matches_text(&self, needle: &str) -> bool {
        if needle.is_empty() {
            return true;
        }
        let haystacks = [
            self.title.as_str(),
            self.summary.as_str(),
            self.author.as_str(),
        ];
        if haystacks
            .iter()
            .any(|text| text.to_lowercase().contains(needle))
        {
            return true;
        }
        self.maps
            .iter()
            .chain(self.game_modes.iter())
            .any(|tag| tag.to_lowercase().contains(needle))
    }

    /// Whether this entry claims `map`, matched loosely in both directions.
    ///
    /// An entry that names no map at all matches every map filter. That is the
    /// difference between a map filter that narrows the library and one that
    /// empties it: most of the catalogue is about the game rather than about one
    /// map, and "economy fundamentals" is not the wrong thing to read because
    /// the player asked about Seton's.
    pub fn covers_map(&self, map: &str) -> bool {
        let wanted = normalise_map(map);
        if wanted.is_empty() || self.maps.is_empty() {
            return true;
        }
        self.maps.iter().any(|mine| {
            let mine = normalise_map(mine);
            !mine.is_empty() && (mine.contains(&wanted) || wanted.contains(&mine))
        })
    }

    /// Whether this entry claims `mode`.
    ///
    /// An entry claiming no mode matches every mode filter, for the same reason
    /// [`Self::covers_map`] does: most material is about the game rather than
    /// about one queue.
    pub fn covers_mode(&self, mode: &str) -> bool {
        if mode.is_empty() || self.game_modes.is_empty() {
            return true;
        }
        let wanted = leaderboard_word(mode);
        self.game_modes
            .iter()
            .any(|mine| leaderboard_word(mine).eq_ignore_ascii_case(wanted))
    }
}

/// A Markdown document in a GitHub repository, as a raw address names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HostedGuide<'a> {
    pub owner: &'a str,
    pub repo: &'a str,
    pub reference: &'a str,
    pub path: &'a str,
}

impl HostedGuide<'_> {
    /// `owner/repo`, for comparing against the repository a build trusts.
    pub fn repository(&self) -> String {
        format!("{}/{}", self.owner, self.repo)
    }

    /// The address GitHub renders, for a reader who wants a browser anyway.
    ///
    /// The catalogue stores the raw address, because that is the one the client
    /// reads itself. Handing that same address to a browser would show a build
    /// order as a wall of monospace: `raw.githubusercontent.com` serves
    /// `text/plain`, and only the `blob` address is rendered.
    pub fn rendered_page(&self) -> String {
        format!(
            "https://github.com/{}/{}/blob/{}/{}",
            self.owner, self.repo, self.reference, self.path
        )
    }
}

/// The document a raw GitHub address points at, when it is Markdown.
///
/// A guide this project hosts is read and rendered inside the tab rather than
/// handed to the reader's browser, because a build order is the one thing in
/// the library somebody wants open *while* they are playing. Everything else
/// the catalogue links is somebody else's page, behind their own styling,
/// their own login and their own frame policy; the honest thing to do with
/// those is still to open a browser.
///
/// The owner and repository come back rather than a bare yes, so that the
/// caller can insist the document is one this build was configured to trust. A
/// catalogue is remote content, and a url out of it must not become a request
/// to wherever it likes.
pub fn hosted_guide(url: &str) -> Option<HostedGuide<'_>> {
    let rest = url.strip_prefix("https://raw.githubusercontent.com/")?;
    if !rest.ends_with(".md") {
        return None;
    }
    let mut parts = rest.splitn(4, '/');
    let guide = HostedGuide {
        owner: parts.next()?,
        repo: parts.next()?,
        reference: parts.next()?,
        path: parts.next()?,
    };
    let empty = guide.owner.is_empty()
        || guide.repo.is_empty()
        || guide.reference.is_empty()
        || guide.path.is_empty();
    // `..` in the path would still resolve on GitHub's side, and a catalogue
    // entry has no business walking out of the directory it names.
    if empty || guide.path.contains("..") {
        return None;
    }
    Some(guide)
}

/// The leaderboard's word for a mode the catalogue speaks in.
///
/// A game played outside the matchmaker is rated on the leaderboard FAF calls
/// `global`, which is not the word anyone uses in a lobby. The catalogue says
/// `custom`, and this is the single place the two vocabularies meet, exactly as
/// [`mode_of_leaderboard`] is for the queue names. Every other mode is already
/// the same word on both sides and passes through untouched.
///
/// This matters more than a synonym usually would: most of what the community
/// teaches is for games that never go through the matchmaker, so without it a
/// Seton's build order is judged against a 4v4 ladder rating its reader may not
/// have, or against no rating at all.
pub fn leaderboard_word(mode: &str) -> &str {
    if mode.eq_ignore_ascii_case("custom") {
        "global"
    } else {
        mode
    }
}

/// Map names compared without the punctuation and prefixes that differ between
/// the vault, the replay header and the way people write them down.
///
/// `scmp_009`, `SCMP 009` and `Setons Clutch` all reach this function from real
/// data for the same map; folding case, dropping non-alphanumerics and dropping
/// the `scmp`/`x1mp` folder prefixes is what makes the loose match above catch
/// the cases a player would expect it to.
pub fn normalise_map(map: &str) -> String {
    let folded: String = map
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect();
    for prefix in ["scmp", "x1mp"] {
        if let Some(rest) = folded.strip_prefix(prefix) {
            return rest.to_string();
        }
    }
    folded
}

/// Where the shown catalogue came from.
///
/// Surfaced rather than hidden: a client running on the bundled seed is showing
/// a fraction of what a published manifest would carry, and telling the player
/// that is better than looking empty for no stated reason.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TrainingSource {
    /// Shipped with the client.
    #[default]
    Bundled,
    /// Fetched from the configured manifest.
    Remote,
}

/// The community destinations the hub routes to.
///
/// Carried by the catalogue rather than compiled in, because the one value that
/// matters most here (the training Discord invite) is not something a client
/// release should be needed to change.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TrainingLinks {
    /// The training community's Discord invite. Empty hides the button rather
    /// than sending anyone to a guess.
    pub discord_url: String,
    /// The exact Discord channel a replay review is asked in, as a
    /// `https://discord.com/channels/<guild>/<channel>` address.
    ///
    /// Worth its own field rather than reusing the invite: Discord's desktop
    /// application follows one of these straight to the channel, so the player
    /// lands where the request goes with it already on their clipboard,
    /// instead of in a server they then have to navigate. Empty falls back to
    /// the invite.
    pub replay_review_channel: String,
    /// The forum category where past replay reviews can be read. Not where a
    /// request goes: that is Discord.
    pub replay_review_url: String,
    /// The same category as a NodeBB id, which is what composing a prefilled
    /// post needs. Without it the client can still open the category.
    pub replay_review_category: Option<i32>,
    /// Where a content submission goes.
    pub contribute_url: String,
    pub contribute_category: Option<i32>,
    pub wiki_url: String,
}

/// One member of FAF's training team.
///
/// A list rather than a matching service, deliberately. Who is willing to
/// coach, what they are good at and roughly which players they coach are facts
/// that fit on a card, and the actual arrangement happens between two people
/// on Discord. Anything more (availability, scheduling, a request queue) needs
/// the trainer to keep a profile up to date, which is exactly the maintenance
/// burden the rest of this tab is built to avoid.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Trainer {
    pub id: String,
    /// What to call them. Usually their FAF login, but not necessarily.
    pub name: String,
    /// The FAF account, when the trainer has said which one it is.
    ///
    /// With it a tile stops being a string: the player card opens, their real
    /// rating and avatar resolve, and a private message can be sent from the
    /// client. This is the same reason a tournament entrant carries `fafId`.
    pub faf_id: Option<i32>,
    /// Free text: "Trainer", "Veteran Trainer", "Team Lead". The training team
    /// names its own roles and does not need this client's permission to invent
    /// another. Shown as the tile's one tag.
    pub role: String,
    /// What this person coaches, in a few words: "Team games", "Seton's
    /// Clutch", "1v1 up to 1800".
    ///
    /// The tile's heading, with [`Self::note`] underneath as the longer
    /// version. Written rather than assembled from the tags below, because the
    /// useful summary of somebody's area is a phrase and not a list: "1v1 up to
    /// 1800" reads as an answer where "1v1 · 0-1800" reads as a database row.
    pub focus: String,
    pub topics: Vec<TrainingTopic>,
    pub game_modes: Vec<String>,
    /// The rating range they coach, if they say. Read with [`within_band`].
    pub rating_min: Option<i32>,
    pub rating_max: Option<i32>,
    /// Languages they can teach in, as written by them ("English", "Deutsch").
    pub languages: Vec<String>,
    /// Discord handle, not an invite: the tile says who to look for in the
    /// training server the hero already links to.
    pub discord: String,
    pub note: String,
    pub avatar_url: String,
    /// Whether they are currently taking students. A tile stays listed when
    /// they are not, marked as such: "this person coaches, just not right now"
    /// is more useful than a name that vanishes.
    pub accepting: bool,
}

impl Trainer {
    /// Whether this trainer coaches players at `rating`.
    pub fn covers_rating(&self, rating: i32) -> bool {
        within_band(self.rating_min, self.rating_max, rating)
    }
}

/// A catalogue as a port hands it over.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TrainingCatalogue {
    pub resources: Vec<TrainingResource>,
    pub trainers: Vec<Trainer>,
    pub links: TrainingLinks,
    pub source: TrainingSource,
}

/// What the library is filtered to.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TrainingQuery {
    pub text: String,
    pub level: Option<TrainingLevel>,
    pub kind: Option<TrainingKind>,
    pub topic: Option<TrainingTopic>,
    pub game_mode: String,
    pub map: String,
    /// Hide anything whose band excludes this account's rating.
    pub my_rating_only: bool,
}

impl TrainingQuery {
    pub fn is_empty(&self) -> bool {
        *self == TrainingQuery::default()
    }
}

/// What the client knows about the player, reduced to what a recommendation
/// needs.
///
/// Derived from state that is already loaded, never fetched for this purpose:
/// see [`profile_from_state`].
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TrainingProfile {
    pub player: String,
    /// The overall rating, used when nothing more specific applies.
    ///
    /// Kept beside [`Self::ratings`] rather than replaced by it: a resource
    /// that names no mode is about the game, and the number to judge it
    /// against is the one FAF calls global.
    pub rating: Option<i32>,
    /// Every rating this account holds, keyed by game mode ("1v1", "2v2",
    /// "3v3", "4v4", "global").
    ///
    /// FAF keeps five, and collapsing them to one gets the answer wrong in
    /// the ordinary case rather than a rare one: a 1v1 guide written for
    /// 1000 to 1400 is exactly right for somebody who is 1800 global and 1200
    /// in the ladder, and judging it by their global rating hides it from the
    /// person it was written for.
    pub ratings: BTreeMap<String, i32>,
    /// Modes recently played, most played first.
    pub game_modes: Vec<String>,
    /// Maps recently played, most played first.
    pub maps: Vec<String>,
    /// Factions recently played, most played first.
    pub factions: Vec<String>,
    /// How many of this player's own games the above was read from. Shown so
    /// "recommended for you" can say what it is based on, and so a profile
    /// derived from nothing can say that instead of pretending.
    pub games_seen: i32,
}

impl TrainingProfile {
    pub fn is_empty(&self) -> bool {
        self.rating.is_none()
            && self.ratings.is_empty()
            && self.maps.is_empty()
            && self.game_modes.is_empty()
    }

    /// The rating to judge material for `mode` by.
    ///
    /// The mode's own rating when this account has one, and the overall rating
    /// otherwise. An unknown mode (a mod's own queue, a custom lobby) has no
    /// ladder behind it, so global is the only honest answer for it.
    pub fn rating_in(&self, mode: &str) -> Option<i32> {
        self.ratings.get(mode).copied().or(self.rating)
    }

    /// The rating to judge one resource by.
    ///
    /// A resource that names modes is judged by the reader's rating in the
    /// first of them the reader actually plays; one that names none is about
    /// the game and is judged by the overall rating. Taking the *first* match
    /// rather than the best is deliberate: a guide tagged `1v1, 2v2` is a 1v1
    /// guide that also applies to 2v2, and picking whichever rating happened
    /// to be flattering would defeat the point of filtering by rating at all.
    pub fn rating_for(&self, resource: &TrainingResource) -> Option<i32> {
        resource
            .game_modes
            .iter()
            .find_map(|mode| self.ratings.get(leaderboard_word(mode)).copied())
            .or(self.rating)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum TrainingStatus {
    #[default]
    Idle,
    Loading,
    Ready,
    Failed {
        reason: String,
    },
}

/// A post the client has written for the player to send.
///
/// Named for where it started. It now also carries a GitHub issue: both are
/// "a title, a body, and a prefilled address", and both are sent by the player
/// rather than by this client.
///
/// The client composes and the player posts, deliberately. Posting on someone's
/// behalf would need their forum session, and a request written by a bot in a
/// human's name is exactly the kind of thing a training community does not
/// want. What the client removes is the part that actually stops people: find
/// the channel, find the template, dig the replay id out of a file name.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ForumPost {
    pub title: String,
    pub body: String,
    /// The composer, prefilled. Empty when no category id is configured, in
    /// which case the body still stands on its own and can be copied.
    pub url: String,
}

/// A replay review request, as the player edits it.
///
/// `rating` is a string, not an `i32`: a number field the user is typing into
/// is empty for a keystroke, and modelling that as a number forces either a
/// zero or a field that fights back.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRequestDraft {
    pub replay_id: Option<i32>,
    /// The shareable replay link, when the game has one.
    pub replay_link: String,
    /// The local file, for a replay that was never uploaded.
    pub replay_file: String,
    pub player: String,
    pub rating: String,
    pub game_mode: String,
    pub map: String,
    pub faction: String,
    /// ISO or already-formatted; passed through to the post as written.
    pub played_at: String,
    /// "What would you like help with?"
    pub goal: String,
    /// "What did you struggle with?"
    pub struggle: String,
}

/// Why a review request is not ready to post.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ReviewProblem {
    /// Neither a link, an id nor a file: a reviewer would have nothing to watch.
    NoReplay,
    /// Nothing said about what help is wanted. The single most common reason a
    /// review request sits unanswered, so it is required rather than optional.
    NoGoal,
}

/// A content submission, as the player edits it.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ContributionDraft {
    pub title: String,
    /// One line, which is what a card in the library shows under the title.
    /// Asked for because without it an accepted entry has nothing to say for
    /// itself, and a curator would have to write one on the author's behalf.
    pub summary: String,
    pub kind: TrainingKind,
    pub level: Option<TrainingLevel>,
    /// For a video or an existing page: the destination.
    pub url: String,
    /// For something written here: the body, as Markdown.
    pub body: String,
    pub topics: Vec<TrainingTopic>,
    pub game_modes: Vec<String>,
    pub maps: Vec<String>,
    pub factions: Vec<String>,
    pub rating_min: String,
    pub rating_max: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ContributionProblem {
    NoTitle,
    /// Neither a link nor any text: there is no submission.
    NoContent,
    /// A link that is not an ordinary `https://` URL.
    BadUrl,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TrainingState {
    pub resources: Vec<TrainingResource>,
    pub trainers: Vec<Trainer>,
    pub status: TrainingStatus,
    pub source: TrainingSource,
    pub links: TrainingLinks,
    pub query: TrainingQuery,
    /// Resource ids, best first. Recomputed in the service after a load, never
    /// in the view: a recommendation is a rule, and a rule written twice drifts.
    pub recommended: Vec<String>,
    /// What the profile behind `recommended` was, so the hub can say what it
    /// based them on.
    pub profile: TrainingProfile,
    pub selected_id: Option<String>,
    /// `Some` while the review request form is open.
    pub review: Option<ReviewRequestDraft>,
    /// The composed post, once the player has asked for it.
    pub review_post: Option<ForumPost>,
    pub contribution: Option<ContributionDraft>,
    pub contribution_post: Option<ForumPost>,
    /// The guide being read in the tab, when one is.
    pub document: TrainingDocument,
}

/// One guide's text, as the reader has it open.
///
/// Keyed by the resource it belongs to so that a reply arriving after the
/// reader has moved on is dropped rather than rendered under the wrong title.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TrainingDocument {
    pub resource_id: String,
    pub markdown: String,
    pub status: TrainingStatus,
}

impl TrainingState {
    pub fn selected(&self) -> Option<&TrainingResource> {
        let id = self.selected_id.as_deref()?;
        self.resources.iter().find(|resource| resource.id == id)
    }

    pub fn resource(&self, id: &str) -> Option<&TrainingResource> {
        self.resources.iter().find(|resource| resource.id == id)
    }
}

// ---------------------------------------------------------------------------
// Library: filtering
// ---------------------------------------------------------------------------

/// The resources a query selects, in catalogue order.
///
/// Order is the catalogue's own rather than a relevance sort: the library is
/// the "I want to find something specific" surface, and a stable order is what
/// makes narrowing a filter feel like narrowing rather than reshuffling.
/// The catalogue, narrowed by a query.
///
/// `profile` is only read for the "at my rating" switch, and it is a profile
/// rather than a number because the right number depends on the entry: FAF
/// keeps five ratings, and a 1v1 guide has to be judged by a 1v1 rating.
pub fn filter_resources<'a>(
    resources: &'a [TrainingResource],
    query: &TrainingQuery,
    profile: &TrainingProfile,
) -> Vec<&'a TrainingResource> {
    let needle = query.text.trim().to_lowercase();
    resources
        .iter()
        .filter(|resource| {
            resource.matches_text(&needle)
                && query
                    .level
                    .is_none_or(|level| resource.level == Some(level))
                && query.kind.is_none_or(|kind| resource.kind == kind)
                && query
                    .topic
                    .is_none_or(|topic| resource.topics.contains(&topic))
                && resource.covers_mode(query.game_mode.trim())
                && resource.covers_map(query.map.trim())
                && (!query.my_rating_only
                    || profile
                        .rating_for(resource)
                        .is_none_or(|rating| resource.covers_rating(rating)))
        })
        .collect()
}

/// How many resources each topic has, for the "learn the basics" cards.
pub fn topic_counts(resources: &[TrainingResource]) -> Vec<(TrainingTopic, usize)> {
    TrainingTopic::ALL
        .iter()
        .map(|topic| {
            let count = resources
                .iter()
                .filter(|resource| resource.topics.contains(topic))
                .count();
            (*topic, count)
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Recommendation
// ---------------------------------------------------------------------------

/// How well a resource fits a player, higher is better. Negative means "do not
/// recommend": the fit is actively wrong rather than merely unknown.
///
/// The weights say what the hub believes: a resource written for your rating
/// beats one about a map you happen to play, and a resource written for someone
/// four hundred points away is worse than one that says nothing at all.
pub fn score(resource: &TrainingResource, profile: &TrainingProfile) -> i32 {
    let mut total = 0;

    // The rating for *this resource's* mode, not the account's headline one. A
    // 1v1 guide written for 1000 to 1400 is exactly right for somebody who is
    // 1800 global and 1200 in the ladder, and scoring it against 1800 would
    // push it away from the person it was written for.
    if let Some(rating) = profile.rating_for(resource) {
        let (min, max) = resource.band();
        if resource.covers_rating(rating) {
            // A band that actually names a boundary is a real claim about the
            // reader; an open-ended one is nearly free.
            total += if min.is_some() || max.is_some() {
                40
            } else {
                5
            };
        } else {
            let distance = min
                .map(|min| min - rating)
                .filter(|gap| *gap > 0)
                .or_else(|| max.map(|max| rating - max).filter(|gap| *gap > 0))
                .unwrap_or(0);
            // Far outside is a strong no; just outside is a mild one, because
            // bands are written loosely and the edges are not meaningful.
            total -= 20 + distance / 20;
        }
    }

    // Recency-weighted: the front of each list is what the player has been
    // doing lately, and that is the material they will actually open.
    if let Some(position) = position_of(&profile.maps, &resource.maps, MatchMode::Map) {
        total += 30 - (position as i32 * 4).min(20);
    }
    if let Some(position) = position_of(&profile.game_modes, &resource.game_modes, MatchMode::Exact)
    {
        total += 18 - (position as i32 * 4).min(12);
    }
    if position_of(&profile.factions, &resource.factions, MatchMode::Exact).is_some() {
        total += 8;
    }

    // A lesson the client can start is worth more than a link, because it is
    // the one kind of material where the client removes every remaining step.
    if resource.is_lesson() {
        total += 6;
    }
    if !resource.approved_by.is_empty() {
        total += 4;
    }
    // Nothing to show for a "place to go" card in a recommendation rail: the
    // hero already offers the community.
    if resource.kind == TrainingKind::Community {
        total -= 50;
    }

    total
}

enum MatchMode {
    Exact,
    Map,
}

/// The index in `mine` of the first entry `theirs` claims, if any.
fn position_of(mine: &[String], theirs: &[String], mode: MatchMode) -> Option<usize> {
    if theirs.is_empty() {
        return None;
    }
    mine.iter().position(|ours| {
        theirs.iter().any(|other| match mode {
            MatchMode::Exact => other.eq_ignore_ascii_case(ours),
            MatchMode::Map => {
                let a = normalise_map(ours);
                let b = normalise_map(other);
                !a.is_empty() && !b.is_empty() && (a.contains(&b) || b.contains(&a))
            }
        })
    })
}

/// The ids to show as "recommended for you", best first.
///
/// Deterministic: equal scores fall back to catalogue order, so the rail does
/// not reshuffle itself between two loads that learned nothing new.
pub fn recommend(
    resources: &[TrainingResource],
    profile: &TrainingProfile,
    limit: usize,
) -> Vec<String> {
    let mut ranked: Vec<(usize, i32, &TrainingResource)> = resources
        .iter()
        .enumerate()
        .map(|(index, resource)| (index, score(resource, profile), resource))
        .filter(|(_, score, _)| *score > 0)
        .collect();
    ranked.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));
    ranked
        .into_iter()
        .take(limit)
        .map(|(_, _, resource)| resource.id.clone())
        .collect()
}

/// The resources `resource` points at, in the order it lists them.
///
/// Ids that no longer resolve are dropped rather than rendered as dead rows: a
/// manifest outlives the entries it cites.
pub fn related_resources<'a>(
    resources: &'a [TrainingResource],
    resource: &TrainingResource,
) -> Vec<&'a TrainingResource> {
    resource
        .related
        .iter()
        .filter_map(|id| resources.iter().find(|other| &other.id == id))
        .collect()
}

// ---------------------------------------------------------------------------
// Profile: what the client already knows about the player
// ---------------------------------------------------------------------------

/// How many of the newest local replays the profile is read from.
///
/// A window rather than the whole archive: what a player should learn next
/// follows from what they have been playing, and a year-old 4v4 phase says
/// nothing about the 1v1 ladder they are on this month.
pub const PROFILE_REPLAY_WINDOW: usize = 40;

/// Fold what the client already holds into a [`TrainingProfile`].
///
/// Every source here is state some other tab loaded for its own reasons:
///
/// - the account name and, when the matchmaker profile has been opened, the
///   per-leaderboard ratings;
/// - the local replay archive, which is this player's own recent games and
///   carries the map, the mod, their faction and their displayed rating in each
///   file's header.
///
/// Nothing is fetched for the sake of a recommendation. That is the point: a
/// hub that had to download a profile before it could suggest anything would be
/// blank for the first seconds of every visit.
pub fn profile_from_state(state: &AppState) -> TrainingProfile {
    let me = state
        .auth
        .player
        .as_ref()
        .map(|player| player.name.clone())
        .unwrap_or_default();

    let mut profile = TrainingProfile {
        player: me.clone(),
        rating: matchmaker_rating(state),
        ratings: ratings_by_mode(state),
        ..TrainingProfile::default()
    };

    let mut maps = Tally::default();
    let mut modes = Tally::default();
    let mut factions = Tally::default();
    let mut ratings: Vec<i32> = Vec::new();

    for replay in state.replays.local.iter().take(PROFILE_REPLAY_WINDOW) {
        profile.games_seen += 1;
        if !replay.map.is_empty() {
            maps.add(&replay.map);
        }
        modes.add(&game_mode_of(replay.num_players, &replay.mod_name));

        // The header records every player; only ours says anything about us.
        let mine = replay
            .teams
            .iter()
            .flat_map(|team| team.players.iter())
            .find(|player| !me.is_empty() && player.name.eq_ignore_ascii_case(&me));
        if let Some(mine) = mine {
            if let Some(faction) = mine.faction.and_then(faction_name) {
                factions.add(faction);
            }
            if let Some(rating) = mine.rating.filter(|value| *value > 0) {
                ratings.push(rating);
            }
        }
    }

    profile.maps = maps.ranked();
    profile.game_modes = modes.ranked();
    profile.factions = factions.ranked();

    // The matchmaker profile is the better answer when it has been loaded,
    // because it is the live rating rather than whatever was displayed when a
    // replay was recorded. The replays are the fallback, and for a player who
    // has never opened the matchmaker they are the only answer available.
    if profile.rating.is_none() && !ratings.is_empty() {
        // Newest first, so the median of the window is a current-form number
        // rather than an average dragged down by however the account started.
        ratings.sort_unstable();
        profile.rating = Some(ratings[ratings.len() / 2]);
    }

    profile
}

/// The signed-in account's headline rating, when the matchmaker profile for it
/// has been loaded.
///
/// Prefers the global (`global`) leaderboard, then 1v1 ladder, then whichever
/// has the most games: the same "what does this player's rating mean" order the
/// player card uses when it has to pick one number.
/// Which game mode a leaderboard is the rating for.
///
/// FAF's technical names are its own (`ladder_1v1`, `tmm_2v2`); the catalogue
/// and the replay headers speak in modes (`1v1`, `2v2`). This is the one place
/// the two vocabularies meet, so a manifest never has to know what a
/// leaderboard is called.
pub fn mode_of_leaderboard(technical_name: &str) -> Option<&'static str> {
    if technical_name == "global" {
        return Some("global");
    }
    // Read out of the name rather than matched against a table of them. FAF
    // names its leaderboards `ladder_1v1`, `tmm_2v2`, and also
    // `tmm_4v4_share_until_death` and whatever the next seasonal queue is
    // called; a fixed list silently loses a rating every time one is added,
    // which is how 4v4 went missing. The team size is the part of the name
    // that means something, so that is the part this reads.
    ["1v1", "2v2", "3v3", "4v4"]
        .into_iter()
        .find(|mode| technical_name.contains(mode))
}

/// This account's rating in each mode it has one for.
fn ratings_by_mode(state: &AppState) -> BTreeMap<String, i32> {
    let Some(me) = state.auth.player.as_ref() else {
        return BTreeMap::new();
    };
    let Some(profile) = state.player_card.matchmaker_profile.as_ref() else {
        return BTreeMap::new();
    };
    if profile.player_id != me.id {
        return BTreeMap::new(); // Someone else's card is open.
    }

    profile
        .ratings
        .iter()
        // A leaderboard nobody has played says nothing about them, and a zero
        // from an empty rating would read as "very bad at this".
        .filter(|rating| rating.games_played > 0)
        .filter_map(|rating| {
            mode_of_leaderboard(&rating.technical_name)
                .map(|mode| (mode.to_string(), rating.rating))
        })
        .collect()
}

fn matchmaker_rating(state: &AppState) -> Option<i32> {
    let me = state.auth.player.as_ref()?;
    let profile = state.player_card.matchmaker_profile.as_ref()?;
    if profile.player_id != me.id {
        return None; // Someone else's card is open; it says nothing about us.
    }
    let by_name = |wanted: &str| {
        profile
            .ratings
            .iter()
            .find(|rating| rating.technical_name == wanted)
    };
    by_name("global")
        .or_else(|| by_name("ladder_1v1"))
        .or_else(|| {
            profile
                .ratings
                .iter()
                .max_by_key(|rating| rating.games_played)
        })
        .map(|rating| rating.rating)
}

/// The mode a game of this size and mod counts as.
///
/// Read off the player count because that is what a replay header states; a
/// non-`faf` featured mod names itself instead, since "4v4" says nothing useful
/// about a co-op mission or a survival map.
pub fn game_mode_of(num_players: i32, mod_name: &str) -> String {
    if !mod_name.is_empty() && !mod_name.eq_ignore_ascii_case("faf") {
        return mod_name.to_lowercase();
    }
    match num_players {
        2 => "1v1".to_string(),
        4 => "2v2".to_string(),
        6 => "3v3".to_string(),
        8 => "4v4".to_string(),
        other if other > 8 => "large".to_string(),
        _ => "custom".to_string(),
    }
}

/// Faction ids as the replay header records them.
fn faction_name(faction: i32) -> Option<&'static str> {
    match faction {
        1 => Some("uef"),
        2 => Some("aeon"),
        3 => Some("cybran"),
        4 => Some("seraphim"),
        // 5 is Random, which resolves to a real faction in game and therefore
        // says nothing about what the player practises.
        _ => None,
    }
}

/// Counts of case-insensitive keys, ranked by count and then by first sighting.
#[derive(Default)]
struct Tally {
    entries: Vec<(String, i32, usize)>,
}

impl Tally {
    fn add(&mut self, value: &str) {
        let value = value.trim();
        if value.is_empty() {
            return;
        }
        if let Some(entry) = self
            .entries
            .iter_mut()
            .find(|(key, _, _)| key.eq_ignore_ascii_case(value))
        {
            entry.1 += 1;
            return;
        }
        let seen = self.entries.len();
        self.entries.push((value.to_string(), 1, seen));
    }

    fn ranked(mut self) -> Vec<String> {
        self.entries
            .sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.2.cmp(&right.2)));
        self.entries.into_iter().map(|(key, _, _)| key).collect()
    }
}

// ---------------------------------------------------------------------------
// Lessons: FAF's tutorial API as catalogue entries
// ---------------------------------------------------------------------------

/// Prefix for ids derived from a FAF tutorial, so a manifest can address one.
pub const LESSON_ID_PREFIX: &str = "faf-tutorial-";

/// Turn FAF's own tutorial catalogue into training resources.
///
/// The tutorials API carries a title, a briefing, a category and, for the
/// video and written-guide categories, a link. What it does not carry is any of
/// the metadata this hub filters and recommends on, so the tags are inferred
/// from the words the author already wrote. That is a fallback and is meant to
/// be overridden: a manifest entry naming the same `tutorialId` replaces the
/// derived one wholesale (see [`merge_catalogue`]).
/// The still image a video host publishes for a link, if this is one.
///
/// YouTube only, and deliberately: it is where practically all of FAF's video
/// material lives, its thumbnail address is derivable from the id without an
/// API key or a request, and guessing at other hosts would produce broken
/// images rather than missing ones. `mqdefault` because the card is 148px
/// wide at its narrowest and the larger sizes are not published for every
/// video.
pub fn video_still(url: &str) -> String {
    let Some(id) = youtube_id(url) else {
        return String::new();
    };
    format!("https://img.youtube.com/vi/{id}/mqdefault.jpg")
}

/// The eleven-character video id in a YouTube address, in any of the shapes
/// people paste: `watch?v=`, `youtu.be/`, `embed/`, `shorts/`.
fn youtube_id(url: &str) -> Option<&str> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let rest = rest.strip_prefix("www.").unwrap_or(rest);

    let candidate = if let Some(after) = rest.strip_prefix("youtu.be/") {
        after
    } else if let Some(after) = rest.strip_prefix("youtube.com/watch?v=") {
        after
    } else if let Some(after) = rest.strip_prefix("youtube.com/embed/") {
        after
    } else if let Some(after) = rest.strip_prefix("youtube.com/shorts/") {
        after
    } else if let Some(after) = rest.strip_prefix("m.youtube.com/watch?v=") {
        after
    } else {
        // `watch?…&v=…`, where the id is not the first parameter.
        rest.strip_prefix("youtube.com/watch?")?
            .split('&')
            .find_map(|pair| pair.strip_prefix("v="))?
    };

    let id = candidate
        .split(['&', '?', '#', '/'])
        .next()
        .unwrap_or_default();
    // Ids are a fixed length and a fixed alphabet. Anything else is a URL that
    // merely looked like one, and a guessed thumbnail address is a broken
    // image on somebody's card.
    (id.len() == 11
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'))
    .then_some(id)
}

pub fn lesson_resources(
    tutorials: &[Tutorial],
    category_name: impl Fn(Option<i32>) -> String,
) -> Vec<TrainingResource> {
    tutorials
        .iter()
        .map(|tutorial| {
            let category = category_name(tutorial.category_id);
            let text = format!("{} {} {}", tutorial.title, tutorial.description, category);
            let playable = tutorial.is_playable();
            TrainingResource {
                id: format!("{LESSON_ID_PREFIX}{}", tutorial.id),
                title: tutorial.title.clone(),
                summary: tutorial.description.clone(),
                kind: if playable {
                    TrainingKind::Lesson
                } else if is_video_link(&tutorial.link_url) {
                    TrainingKind::Video
                } else {
                    TrainingKind::Guide
                },
                level: derive_level(&text),
                url: if playable {
                    String::new()
                } else {
                    tutorial.link_url.clone()
                },
                // FAF's tutorial API already publishes a map preview for a
                // lesson, which is the best picture available for it.
                image_url: tutorial.image_url.clone(),
                tutorial_id: Some(tutorial.id),
                author: String::new(),
                topics: derive_topics(&text),
                maps: Vec::new(),
                game_modes: Vec::new(),
                factions: derive_factions(&text),
                ..TrainingResource::default()
            }
        })
        .collect()
}

fn is_video_link(url: &str) -> bool {
    let url = url.to_lowercase();
    ["youtube.com", "youtu.be", "twitch.tv", "vimeo.com"]
        .iter()
        .any(|host| url.contains(host))
}

/// Topics inferred from the words an author used.
///
/// A keyword table, and openly a heuristic: it exists so a catalogue that
/// carries no tags is still filterable on the day it loads, not as a substitute
/// for tags. Each group is the vocabulary FAF itself uses for that subject.
pub fn derive_topics(text: &str) -> Vec<TrainingTopic> {
    const TABLE: [(TrainingTopic, &[&str]); 10] = [
        (
            TrainingTopic::Economy,
            &["eco", "mass", "energy", "power", "extractor", "fabricator"],
        ),
        (
            TrainingTopic::BuildOrder,
            &["build order", "buildorder", "opening", "template", "queue"],
        ),
        (
            TrainingTopic::Micro,
            &["micro", "dodge", "kiting", "control group", "reclaim"],
        ),
        (
            TrainingTopic::Strategy,
            &[
                "strategy",
                "tactic",
                "snipe",
                "turtle",
                "rush",
                "transition",
            ],
        ),
        (
            TrainingTopic::ArmyComposition,
            &[
                "composition",
                "counter",
                "unit mix",
                "t2",
                "t3",
                "experimental",
            ],
        ),
        (
            TrainingTopic::MapControl,
            &[
                "map control",
                "expansion",
                "territory",
                "spread",
                "position",
            ],
        ),
        (
            TrainingTopic::Scouting,
            &["scout", "intel", "radar", "vision", "omni"],
        ),
        (
            TrainingTopic::Factions,
            &["uef", "aeon", "cybran", "seraphim", "faction"],
        ),
        (
            TrainingTopic::Teamplay,
            &["team", "2v2", "3v3", "4v4", "ally", "share"],
        ),
        (
            TrainingTopic::Interface,
            &["hotkey", "keybind", "interface", "ui", "camera", "option"],
        ),
    ];

    let text = text.to_lowercase();
    TABLE
        .iter()
        .filter(|(_, words)| words.iter().any(|word| text.contains(word)))
        .map(|(topic, _)| *topic)
        .collect()
}

/// A level inferred from the words an author used, when they are explicit
/// enough to be worth acting on.
pub fn derive_level(text: &str) -> Option<TrainingLevel> {
    let text = text.to_lowercase();
    let has = |words: &[&str]| words.iter().any(|word| text.contains(word));
    if has(&["advanced", "high level", "expert", "1800", "2000"]) {
        return Some(TrainingLevel::Advanced);
    }
    if has(&["intermediate", "improve", "next step"]) {
        return Some(TrainingLevel::Intermediate);
    }
    if has(&[
        "beginner",
        "basics",
        "getting started",
        "introduction",
        "first",
        "new player",
    ]) {
        return Some(TrainingLevel::Beginner);
    }
    None
}

fn derive_factions(text: &str) -> Vec<String> {
    let text = text.to_lowercase();
    ["uef", "aeon", "cybran", "seraphim"]
        .iter()
        .filter(|faction| text.contains(*faction))
        .map(|faction| faction.to_string())
        .collect()
}

/// The library: manifest entries first, then every lesson the manifest did not
/// already describe.
///
/// A manifest entry naming a `tutorialId` wins outright rather than merging
/// field by field. Half a merge would be worse than either half: an entry whose
/// tags come from a curator and whose level comes from a keyword table is not
/// something anyone can reason about.
pub fn merge_catalogue(
    catalogue: &[TrainingResource],
    lessons: Vec<TrainingResource>,
) -> Vec<TrainingResource> {
    let described: Vec<i32> = catalogue
        .iter()
        .filter_map(|entry| entry.tutorial_id)
        .collect();
    let mut merged = catalogue.to_vec();
    merged.extend(
        lessons
            .into_iter()
            .filter(|lesson| lesson.tutorial_id.is_none_or(|id| !described.contains(&id))),
    );
    merged
}

// ---------------------------------------------------------------------------
// Routing out: composing a post
// ---------------------------------------------------------------------------

/// Percent-encode for a URL query value, RFC 3986 unreserved set.
///
/// Written here rather than pulled in: the domain crate is dependency-free by
/// design, and this is twenty lines of table lookup.
pub fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// The NodeBB composer, prefilled.
///
/// `forum.faforever.com` runs NodeBB, whose composer reads `cid`, `title` and
/// `body` off the query string (`nodebb-plugin-composer-default`, its
/// `filter:composer.build` hook). So a prefilled post needs no API access and
/// no credentials: the player lands in their own composer with everything
/// filled in and presses submit themselves.
pub fn compose_url(category: Option<i32>, title: &str, body: &str) -> String {
    let Some(category) = category else {
        return String::new();
    };
    format!(
        "{FORUM_BASE}/compose?cid={category}&title={}&body={}",
        percent_encode(title),
        percent_encode(body)
    )
}

/// Why this request cannot be posted yet, if anything.
pub fn review_problem(draft: &ReviewRequestDraft) -> Option<ReviewProblem> {
    if draft.replay_id.is_none()
        && draft.replay_link.trim().is_empty()
        && draft.replay_file.trim().is_empty()
    {
        return Some(ReviewProblem::NoReplay);
    }
    if draft.goal.trim().is_empty() {
        return Some(ReviewProblem::NoGoal);
    }
    None
}

/// The replay, however it can be named.
fn replay_reference(draft: &ReviewRequestDraft) -> String {
    if !draft.replay_link.trim().is_empty() {
        return draft.replay_link.trim().to_string();
    }
    if let Some(id) = draft.replay_id {
        return format!("#{id}");
    }
    draft.replay_file.trim().to_string()
}

/// Write the replay review request the player sends.
///
/// It goes to the training Discord rather than to the forum, because that is
/// where reviews are actually answered. Discord cannot be handed a prefilled
/// message, so the client writes the request in full and the player pastes it:
/// the value is in never having to find the channel, read the pinned template
/// and remember which fields it wants, not in saving the paste.
///
/// The shape follows what a reviewer needs before they can start: which replay,
/// who to watch, roughly how strong they are, and what the player wants out of
/// it. Fields the client could not fill are left out rather than printed empty,
/// because a template full of blanks reads as an unfinished request.
pub fn compose_review_request(draft: &ReviewRequestDraft, links: &TrainingLinks) -> ForumPost {
    let who = if draft.player.trim().is_empty() {
        "Replay review request".to_string()
    } else {
        format!("Replay review request: {}", draft.player.trim())
    };
    let title = match (draft.map.trim(), draft.game_mode.trim()) {
        ("", "") => who,
        ("", mode) => format!("{who} ({mode})"),
        (map, "") => format!("{who} on {map}"),
        (map, mode) => format!("{who} on {map} ({mode})"),
    };

    let mut body = String::new();
    let mut line = |label: &str, value: &str| {
        let value = value.trim();
        if !value.is_empty() {
            body.push_str(&format!("**{label}:** {value}\n"));
        }
    };
    line("Replay", &replay_reference(draft));
    line("Player", &draft.player);
    line("Rating", &draft.rating);
    line("Game mode", &draft.game_mode);
    line("Map", &draft.map);
    line("Faction", &draft.faction);
    line("Played", &draft.played_at);

    body.push_str("\n**What I would like help with**\n");
    body.push_str(draft.goal.trim());
    body.push('\n');
    if !draft.struggle.trim().is_empty() {
        body.push_str("\n**What I struggled with**\n");
        body.push_str(draft.struggle.trim());
        body.push('\n');
    }
    body.push_str("\n*Requested from the FAF client's Training tab.*\n");

    ForumPost {
        // Discord, and the exact channel when the catalogue names one: its
        // desktop application follows a channel address straight there. No URL
        // can prefill the message itself, so the client writes the request,
        // copies it, and opens the place it is pasted. That is one paste
        // instead of finding the channel, reading the pinned template and
        // filling it in from memory.
        url: if links.replay_review_channel.is_empty() {
            links.discord_url.clone()
        } else {
            links.replay_review_channel.clone()
        },
        title,
        body,
    }
}

pub fn contribution_problem(draft: &ContributionDraft) -> Option<ContributionProblem> {
    if draft.title.trim().is_empty() {
        return Some(ContributionProblem::NoTitle);
    }
    let url = draft.url.trim();
    if !url.is_empty() && !looks_like_https(url) {
        return Some(ContributionProblem::BadUrl);
    }
    if url.is_empty() && draft.body.trim().is_empty() {
        return Some(ContributionProblem::NoContent);
    }
    None
}

/// A cheap shape test, not a parser.
///
/// The domain crate has no URL type and does not want one; whether a link
/// resolves is not knowable here anyway. This rejects the mistake people
/// actually make, which is pasting something that is not a link at all.
fn looks_like_https(url: &str) -> bool {
    let rest = match url.strip_prefix("https://") {
        Some(rest) => rest,
        None => return false,
    };
    !rest.is_empty() && !rest.starts_with('/') && rest.contains('.') && !rest.contains(' ')
}

/// Write a submission out as a forum post, tags included.
///
/// The tag block is the part that matters: it is what lets a curator move the
/// entry into the catalogue manifest without asking the author a second round
/// of questions.
pub fn compose_contribution(draft: &ContributionDraft, links: &TrainingLinks) -> ForumPost {
    let title = format!("Training submission: {}", draft.title.trim());

    let mut body = String::new();
    if !draft.url.trim().is_empty() {
        body.push_str(&format!("**Link:** {}\n", draft.url.trim()));
    }
    if !draft.summary.trim().is_empty() {
        body.push_str(&format!("{}\n\n", draft.summary.trim()));
    }
    body.push_str(&format!("**Type:** {}\n", kind_label(draft.kind)));
    if let Some(level) = draft.level {
        body.push_str(&format!("**Level:** {}\n", level_label(level)));
    }
    let band = match (draft.rating_min.trim(), draft.rating_max.trim()) {
        ("", "") => String::new(),
        ("", max) => format!("up to {max}"),
        (min, "") => format!("{min} and up"),
        (min, max) => format!("{min} to {max}"),
    };
    if !band.is_empty() {
        body.push_str(&format!("**Rating:** {band}\n"));
    }
    let tag_line = |label: &str, values: &[String]| {
        if values.is_empty() {
            return String::new();
        }
        format!("**{label}:** {}\n", values.join(", "))
    };
    body.push_str(&tag_line("Game modes", &draft.game_modes));
    body.push_str(&tag_line("Maps", &draft.maps));
    body.push_str(&tag_line("Factions", &draft.factions));
    if !draft.topics.is_empty() {
        let topics: Vec<String> = draft.topics.iter().map(|t| topic_label(*t)).collect();
        body.push_str(&format!("**Topics:** {}\n", topics.join(", ")));
    }

    if !draft.body.trim().is_empty() {
        body.push('\n');
        body.push_str(draft.body.trim());
        body.push('\n');
    }
    body.push_str("\n*Submitted from the FAF client's Training tab.*\n");

    ForumPost {
        url: compose_url(links.contribute_category, &title, &body),
        title,
        body,
    }
}

/// Stable, English labels for the post body.
///
/// Not translated on purpose: the post is read by whoever answers it on an
/// English-language forum, and a request whose field names arrive in a language
/// the reviewer does not read is harder to answer, not easier.
pub fn kind_label(kind: TrainingKind) -> String {
    match kind {
        TrainingKind::Video => "Video",
        TrainingKind::Guide => "Guide",
        TrainingKind::BuildOrder => "Build order",
        TrainingKind::ReplayAnalysis => "Replay analysis",
        TrainingKind::Lesson => "Lesson",
        TrainingKind::Community => "Community",
    }
    .to_string()
}

pub fn level_label(level: TrainingLevel) -> String {
    match level {
        TrainingLevel::Beginner => "Beginner",
        TrainingLevel::Intermediate => "Intermediate",
        TrainingLevel::Advanced => "Advanced",
    }
    .to_string()
}

pub fn topic_label(topic: TrainingTopic) -> String {
    match topic {
        TrainingTopic::Economy => "Economy",
        TrainingTopic::BuildOrder => "Build orders",
        TrainingTopic::Micro => "Micro",
        TrainingTopic::Strategy => "Strategy",
        TrainingTopic::ArmyComposition => "Army composition",
        TrainingTopic::MapControl => "Map control",
        TrainingTopic::Scouting => "Scouting",
        TrainingTopic::Factions => "Factions",
        TrainingTopic::Teamplay => "Teamplay",
        TrainingTopic::Interface => "Interface",
    }
    .to_string()
}

// ---------------------------------------------------------------------------
// Commands, events, reducer
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum TrainingCommand {
    /// Fetch the catalogue and recompute the recommendations.
    Load,
    SetQuery {
        query: Box<TrainingQuery>,
    },
    #[serde(rename_all = "camelCase")]
    Select {
        resource_id: Option<String>,
    },
    /// Read a guide this project hosts, for rendering in the tab.
    ///
    /// By resource id rather than by url: the url is remote content, and a
    /// command carrying one would let a catalogue entry choose where the client
    /// sends a request. The service looks the entry up and decides for itself.
    #[serde(rename_all = "camelCase")]
    ReadGuide {
        resource_id: String,
    },
    /// Open the review request form.
    ///
    /// The prefill is asked for by *reference*, not passed in: which replay,
    /// and the service reads the rest out of the state that already lists it.
    /// A caller in the replays tab therefore cannot fill the form in with
    /// something the client does not actually know.
    #[serde(rename_all = "camelCase")]
    OpenReview {
        replay_uid: Option<i32>,
        local_path: Option<String>,
    },
    /// Write the post, from the draft the form settled on.
    ///
    /// The draft travels with the command rather than being pushed field by
    /// field as it is typed. A command per keystroke would put an IPC round
    /// trip between a key and the character appearing, which for a controlled
    /// text field is how typed characters get dropped. So the form owns the
    /// draft while it is being edited, and the state learns it at the one
    /// moment it matters.
    ///
    /// Composing is a separate step from opening the post so the player reads
    /// what they are about to post before a forum sees it.
    ComposeReview {
        draft: Box<ReviewRequestDraft>,
    },
    CloseReview,
    OpenContribution,
    ComposeContribution {
        draft: Box<ContributionDraft>,
    },
    CloseContribution,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum TrainingEvent {
    Loading,
    Loaded {
        resources: Vec<TrainingResource>,
        trainers: Vec<Trainer>,
        links: TrainingLinks,
        source: TrainingSource,
    },
    LoadFailed {
        reason: String,
    },
    QueryChanged {
        query: Box<TrainingQuery>,
    },
    #[serde(rename_all = "camelCase")]
    Selected {
        resource_id: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Recommended {
        resource_ids: Vec<String>,
        profile: Box<TrainingProfile>,
    },
    #[serde(rename_all = "camelCase")]
    GuideReading {
        resource_id: String,
    },
    #[serde(rename_all = "camelCase")]
    GuideRead {
        resource_id: String,
        markdown: String,
    },
    #[serde(rename_all = "camelCase")]
    GuideFailed {
        resource_id: String,
        reason: String,
    },
    ReviewOpened {
        draft: Box<ReviewRequestDraft>,
    },
    ReviewChanged {
        draft: Box<ReviewRequestDraft>,
    },
    ReviewComposed {
        post: Box<ForumPost>,
    },
    ReviewClosed,
    ContributionOpened {
        draft: Box<ContributionDraft>,
    },
    ContributionChanged {
        draft: Box<ContributionDraft>,
    },
    ContributionComposed {
        post: Box<ForumPost>,
    },
    ContributionClosed,
}

pub fn reduce(state: &mut TrainingState, event: &TrainingEvent) {
    match event {
        TrainingEvent::Loading => state.status = TrainingStatus::Loading,
        TrainingEvent::Loaded {
            resources,
            trainers,
            links,
            source,
        } => {
            state.resources = resources.clone();
            state.trainers = trainers.clone();
            state.links = links.clone();
            state.source = *source;
            state.status = TrainingStatus::Ready;
            // A detail pane open on an entry the reload dropped would keep
            // showing a resource that is no longer in the catalogue.
            let still_present = state
                .selected_id
                .as_deref()
                .is_some_and(|id| resources.iter().any(|resource| resource.id == id));
            if !still_present {
                state.selected_id = None;
            }
        }
        TrainingEvent::LoadFailed { reason } => {
            state.status = TrainingStatus::Failed {
                reason: reason.clone(),
            }
        }
        TrainingEvent::QueryChanged { query } => state.query = (**query).clone(),
        TrainingEvent::Selected { resource_id } => {
            state.selected_id = resource_id.clone();
            // A document belongs to the entry it was opened from. Leaving the
            // last one in place would render one guide's text under the next
            // one's title for as long as the read takes.
            if state.document.resource_id.as_str() != resource_id.as_deref().unwrap_or_default() {
                state.document = TrainingDocument::default();
            }
        }
        TrainingEvent::GuideReading { resource_id } => {
            state.document = TrainingDocument {
                resource_id: resource_id.clone(),
                markdown: String::new(),
                status: TrainingStatus::Loading,
            };
        }
        TrainingEvent::GuideRead {
            resource_id,
            markdown,
        } => {
            // A reply for an entry the reader has already left is dropped
            // rather than shown: by the time it arrives the title above it
            // belongs to something else.
            if state.document.resource_id == *resource_id {
                state.document.markdown = markdown.clone();
                state.document.status = TrainingStatus::Ready;
            }
        }
        TrainingEvent::GuideFailed {
            resource_id,
            reason,
        } => {
            if state.document.resource_id == *resource_id {
                state.document.status = TrainingStatus::Failed {
                    reason: reason.clone(),
                };
            }
        }
        TrainingEvent::Recommended {
            resource_ids,
            profile,
        } => {
            state.recommended = resource_ids.clone();
            state.profile = (**profile).clone();
        }
        TrainingEvent::ReviewOpened { draft } => {
            state.review = Some((**draft).clone());
            // A post composed for the previous request must not survive into
            // the next one: it names a different replay.
            state.review_post = None;
        }
        TrainingEvent::ReviewChanged { draft } => {
            state.review = Some((**draft).clone());
            // Editing after composing invalidates what was composed.
            state.review_post = None;
        }
        TrainingEvent::ReviewComposed { post } => state.review_post = Some((**post).clone()),
        TrainingEvent::ReviewClosed => {
            state.review = None;
            state.review_post = None;
        }
        TrainingEvent::ContributionOpened { draft } => {
            state.contribution = Some((**draft).clone());
            state.contribution_post = None;
        }
        TrainingEvent::ContributionChanged { draft } => {
            state.contribution = Some((**draft).clone());
            state.contribution_post = None;
        }
        TrainingEvent::ContributionComposed { post } => {
            state.contribution_post = Some((**post).clone())
        }
        TrainingEvent::ContributionClosed => {
            state.contribution = None;
            state.contribution_post = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{
        AuthState, LocalReplay, LocalReplayPlayer, LocalReplayStatus, LocalReplayTeam,
        MatchmakerPlayerProfile, Player, PlayerCardState, PlayerRatingSummary, ReplayState,
    };

    fn resource(id: &str) -> TrainingResource {
        TrainingResource {
            id: id.into(),
            title: format!("Resource {id}"),
            ..TrainingResource::default()
        }
    }

    // -- rating bands ------------------------------------------------------

    #[test]
    fn an_unstated_bound_is_open_rather_than_exclusive() {
        // A guide that says "up to 1200" says nothing about a floor, and
        // treating a missing floor as zero-and-therefore-no-match would hide
        // most of the catalogue from everyone.
        let beginner = TrainingResource {
            rating_max: Some(1200),
            ..resource("a")
        };
        assert!(beginner.covers_rating(400));
        assert!(beginner.covers_rating(1200));
        assert!(!beginner.covers_rating(1201));

        assert!(resource("b").covers_rating(2500), "no band is everyone's");
    }

    #[test]
    fn a_level_supplies_a_band_when_no_numbers_were_given() {
        let advanced = TrainingResource {
            level: Some(TrainingLevel::Advanced),
            ..resource("a")
        };
        assert!(advanced.covers_rating(1700));
        assert!(!advanced.covers_rating(700));
    }

    #[test]
    fn stated_numbers_win_over_the_level_they_contradict() {
        // The author knows more about their own material than the label does.
        let odd = TrainingResource {
            level: Some(TrainingLevel::Beginner),
            rating_min: Some(1500),
            ..resource("a")
        };
        assert!(odd.covers_rating(1600));
        assert!(!odd.covers_rating(500));
    }

    // -- map matching ------------------------------------------------------

    #[test]
    fn a_map_matches_across_the_three_ways_it_is_written() {
        // The vault says `scmp_009`, a replay header says `SCMP 009`, and an
        // author writes "Setons Clutch". A filter that only did equality would
        // match none of them against each other.
        assert_eq!(normalise_map("SCMP_009"), "009");
        assert_eq!(normalise_map("scmp 009"), "009");
        assert_eq!(normalise_map("Seton's Clutch"), "setonsclutch");

        let guide = TrainingResource {
            maps: vec!["Setons Clutch".into()],
            ..resource("a")
        };
        assert!(guide.covers_map("setons clutch"));
        assert!(guide.covers_map("Setons"), "a prefix a player would type");
        assert!(!guide.covers_map("Astro Crater"));
    }

    #[test]
    fn a_resource_naming_no_map_is_not_filtered_out_by_a_map() {
        // "Economy fundamentals" is not about Seton's, but it is not *wrong*
        // for someone playing Seton's either.
        let general = resource("a");
        assert!(
            general.covers_map("Setons"),
            "an empty claim excludes nobody"
        );
    }

    // -- filtering ---------------------------------------------------------

    #[test]
    fn filters_combine_and_keep_catalogue_order() {
        let resources = vec![
            TrainingResource {
                level: Some(TrainingLevel::Beginner),
                topics: vec![TrainingTopic::Economy],
                kind: TrainingKind::Video,
                ..resource("eco-video")
            },
            TrainingResource {
                level: Some(TrainingLevel::Beginner),
                topics: vec![TrainingTopic::Economy],
                kind: TrainingKind::Guide,
                ..resource("eco-guide")
            },
            TrainingResource {
                level: Some(TrainingLevel::Advanced),
                topics: vec![TrainingTopic::Micro],
                ..resource("micro")
            },
        ];

        let query = TrainingQuery {
            level: Some(TrainingLevel::Beginner),
            topic: Some(TrainingTopic::Economy),
            ..TrainingQuery::default()
        };
        let found = filter_resources(&resources, &query, &at_rating(None));
        assert_eq!(
            found.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            vec!["eco-video", "eco-guide"]
        );

        let narrowed = filter_resources(
            &resources,
            &TrainingQuery {
                kind: Some(TrainingKind::Guide),
                ..query
            },
            &at_rating(None),
        );
        assert_eq!(narrowed.len(), 1);
    }

    #[test]
    fn the_rating_filter_only_applies_when_a_rating_is_known() {
        // A logged-out client has no rating, and "for my rating" must not then
        // silently mean "for nobody".
        let resources = vec![TrainingResource {
            rating_min: Some(1500),
            ..resource("a")
        }];
        let query = TrainingQuery {
            my_rating_only: true,
            ..TrainingQuery::default()
        };
        assert_eq!(
            filter_resources(&resources, &query, &at_rating(None)).len(),
            1
        );
        assert_eq!(
            filter_resources(&resources, &query, &at_rating(Some(800))).len(),
            0
        );
        assert_eq!(
            filter_resources(&resources, &query, &at_rating(Some(1600))).len(),
            1
        );
    }

    #[test]
    fn free_text_searches_the_tags_as_well_as_the_prose() {
        let resources = vec![TrainingResource {
            title: "Opening moves".into(),
            maps: vec!["Astro Crater".into()],
            ..resource("a")
        }];
        for needle in ["opening", "astro"] {
            let query = TrainingQuery {
                text: needle.into(),
                ..TrainingQuery::default()
            };
            assert_eq!(
                filter_resources(&resources, &query, &at_rating(None)).len(),
                1,
                "{needle}"
            );
        }
    }

    // -- recommendation ----------------------------------------------------

    fn profile(rating: i32, maps: &[&str], modes: &[&str]) -> TrainingProfile {
        TrainingProfile {
            player: "Ada".into(),
            rating: Some(rating),
            maps: maps.iter().map(|m| m.to_string()).collect(),
            game_modes: modes.iter().map(|m| m.to_string()).collect(),
            games_seen: 10,
            ..TrainingProfile::default()
        }
    }

    #[test]
    fn a_resource_for_your_rating_and_your_map_outranks_a_general_one() {
        let resources = vec![
            resource("general"),
            TrainingResource {
                rating_min: Some(800),
                rating_max: Some(1200),
                maps: vec!["Setons Clutch".into()],
                game_modes: vec!["4v4".into()],
                ..resource("setons")
            },
        ];
        let me = profile(1100, &["Setons Clutch"], &["4v4"]);
        assert_eq!(recommend(&resources, &me, 5).first().unwrap(), "setons");
    }

    #[test]
    fn material_written_for_a_far_stronger_player_is_not_recommended_at_all() {
        // The rail is the one surface a new player reads as advice. Filling it
        // with 1800+ analysis is worse than filling it with less.
        let resources = vec![TrainingResource {
            rating_min: Some(1800),
            ..resource("advanced")
        }];
        assert!(recommend(&resources, &profile(700, &[], &[]), 5).is_empty());
    }

    #[test]
    fn recommendations_are_stable_when_nothing_distinguishes_two_entries() {
        // A rail that reshuffles on every load looks broken and teaches the
        // player that its order means nothing.
        let resources = vec![resource("a"), resource("b"), resource("c")];
        let me = profile(1000, &[], &[]);
        let first = recommend(&resources, &me, 3);
        assert_eq!(first, recommend(&resources, &me, 3));
        assert_eq!(first, vec!["a", "b", "c"]);
    }

    #[test]
    fn a_community_destination_never_fills_a_recommendation_slot() {
        // The hero already offers Discord and the forum; a rail slot spent on
        // "go and ask someone" is a slot not spent on something to learn.
        let resources = vec![
            TrainingResource {
                kind: TrainingKind::Community,
                ..resource("discord")
            },
            resource("guide"),
        ];
        assert_eq!(
            recommend(&resources, &profile(1000, &[], &[]), 5),
            vec!["guide"]
        );
    }

    #[test]
    fn the_most_played_map_outweighs_one_played_once() {
        let resources = vec![
            TrainingResource {
                maps: vec!["Astro Crater".into()],
                ..resource("astro")
            },
            TrainingResource {
                maps: vec!["Setons Clutch".into()],
                ..resource("setons")
            },
        ];
        // `maps` arrives most-played first, so Seton's is the recent habit.
        let me = profile(1000, &["Setons Clutch", "Astro Crater"], &[]);
        assert_eq!(recommend(&resources, &me, 1), vec!["setons"]);
    }

    #[test]
    fn related_entries_that_no_longer_exist_are_dropped() {
        let resources = vec![
            TrainingResource {
                related: vec!["b".into(), "gone".into()],
                ..resource("a")
            },
            resource("b"),
        ];
        let found = related_resources(&resources, &resources[0]);
        assert_eq!(
            found.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            vec!["b"]
        );
    }

    // -- profile -----------------------------------------------------------

    fn local(
        map: &str,
        players: i32,
        me_faction: Option<i32>,
        me_rating: Option<i32>,
    ) -> LocalReplay {
        LocalReplay {
            path: format!("C:/replays/{map}.fafreplay"),
            file_name: format!("{map}.fafreplay"),
            uid: Some(1),
            map: map.into(),
            mod_name: "faf".into(),
            title: "game".into(),
            recorder: "Ada".into(),
            start_time: Some(1_800_000_000),
            modified_time: 1_800_000_000,
            file_size_bytes: 1,
            num_players: players,
            teams: vec![LocalReplayTeam {
                team: "1".into(),
                players: vec![
                    LocalReplayPlayer {
                        name: "Ada".into(),
                        faction: me_faction,
                        rating: me_rating,
                    },
                    LocalReplayPlayer {
                        name: "Bob".into(),
                        faction: Some(2),
                        rating: Some(2000),
                    },
                ],
            }],
            average_rating: Some(1100),
            sim_mods: Vec::new(),
            status: LocalReplayStatus::Complete,
            watchable: true,
            game_version: None,
        }
    }

    fn state_with(local_replays: Vec<LocalReplay>) -> AppState {
        AppState {
            auth: AuthState {
                player: Some(Player::new(7, "Ada")),
                ..AuthState::default()
            },
            replays: ReplayState {
                local: local_replays,
                ..ReplayState::default()
            },
            ..AppState::default()
        }
    }

    #[test]
    fn the_profile_reads_recent_habits_out_of_the_local_replay_archive() {
        // Nothing is fetched for this: these files are already on disk and the
        // replay tab already lists them.
        let state = state_with(vec![
            local("Setons Clutch", 8, Some(1), Some(1150)),
            local("Setons Clutch", 8, Some(1), Some(1150)),
            local("Astro Crater", 2, Some(3), Some(1100)),
        ]);
        let me = profile_from_state(&state);

        assert_eq!(me.player, "Ada");
        assert_eq!(me.maps, vec!["Setons Clutch", "Astro Crater"]);
        assert_eq!(me.game_modes, vec!["4v4", "1v1"]);
        assert_eq!(me.factions, vec!["uef", "cybran"]);
        assert_eq!(me.games_seen, 3);
        assert_eq!(me.rating, Some(1150), "the median of what the headers said");
    }

    #[test]
    fn only_this_account_s_own_rows_shape_the_profile() {
        // The header lists everyone in the game. Reading the opponent's faction
        // and rating would describe the wrong player entirely.
        let state = state_with(vec![local("Astro Crater", 2, Some(1), Some(900))]);
        let me = profile_from_state(&state);
        assert_eq!(me.factions, vec!["uef"], "not Bob's Aeon");
        assert_eq!(me.rating, Some(900), "not Bob's 2000");
    }

    #[test]
    fn the_live_matchmaker_rating_wins_over_what_a_replay_recorded() {
        let mut state = state_with(vec![local("Astro Crater", 2, Some(1), Some(900))]);
        state.player_card = PlayerCardState {
            matchmaker_profile: Some(MatchmakerPlayerProfile {
                player_id: 7,
                login: "Ada".into(),
                country: String::new(),
                clan_tag: String::new(),
                avatar_url: String::new(),
                avatar_tooltip: String::new(),
                games_played: 40,
                ratings: vec![PlayerRatingSummary {
                    leaderboard_id: 1,
                    technical_name: "global".into(),
                    name: "Global".into(),
                    rating: 1320,
                    mean: 1400.0,
                    deviation: 80.0,
                    games_played: 40,
                    won_games: 20,
                    update_time: String::new(),
                }],
                league_placements: Vec::new(),
                warnings: Vec::new(),
            }),
            ..PlayerCardState::default()
        };
        assert_eq!(profile_from_state(&state).rating, Some(1320));
    }

    #[test]
    fn another_player_s_open_card_does_not_become_our_rating() {
        // The player card is one slot, and clicking a name in chat fills it
        // with a stranger. Reading their rating as ours would recommend for the
        // wrong person entirely.
        let mut state = state_with(vec![]);
        state.player_card = PlayerCardState {
            matchmaker_profile: Some(MatchmakerPlayerProfile {
                player_id: 99,
                login: "Someone".into(),
                country: String::new(),
                clan_tag: String::new(),
                avatar_url: String::new(),
                avatar_tooltip: String::new(),
                games_played: 400,
                ratings: vec![PlayerRatingSummary {
                    leaderboard_id: 1,
                    technical_name: "global".into(),
                    name: "Global".into(),
                    rating: 2100,
                    mean: 2100.0,
                    deviation: 40.0,
                    games_played: 400,
                    won_games: 300,
                    update_time: String::new(),
                }],
                league_placements: Vec::new(),
                warnings: Vec::new(),
            }),
            ..PlayerCardState::default()
        };
        assert_eq!(profile_from_state(&state).rating, None);
    }

    #[test]
    fn a_non_faf_featured_mod_names_the_mode_itself() {
        // "4v4" would be a lie about a co-op mission with four players in it.
        assert_eq!(game_mode_of(8, "faf"), "4v4");
        assert_eq!(game_mode_of(4, "coop"), "coop");
        assert_eq!(game_mode_of(3, "faf"), "custom");
        assert_eq!(game_mode_of(12, "faf"), "large");
    }

    #[test]
    fn a_profile_from_an_empty_client_says_so() {
        assert!(profile_from_state(&AppState::default()).is_empty());
    }

    // -- lessons -----------------------------------------------------------

    fn tutorial(id: i32, title: &str, description: &str, playable: bool, link: &str) -> Tutorial {
        Tutorial {
            id,
            title: title.into(),
            description: description.into(),
            link_url: link.into(),
            image_url: String::new(),
            ordinal: 1,
            launchable: playable,
            map_folder_name: if playable {
                "scmp_tut".into()
            } else {
                String::new()
            },
            technical_name: if playable {
                "tut".into()
            } else {
                String::new()
            },
            category_id: Some(1),
        }
    }

    #[test]
    fn a_faf_lesson_becomes_a_catalogue_entry_with_inferred_tags() {
        let lessons = lesson_resources(
            &[tutorial(
                7,
                "Economy basics",
                "Learn how mass and energy work for a new player.",
                true,
                "",
            )],
            |_| "Basics".to_string(),
        );
        let entry = &lessons[0];
        assert_eq!(entry.id, "faf-tutorial-7");
        assert_eq!(entry.kind, TrainingKind::Lesson);
        assert_eq!(entry.tutorial_id, Some(7));
        assert_eq!(entry.level, Some(TrainingLevel::Beginner));
        assert!(entry.topics.contains(&TrainingTopic::Economy));
        assert!(entry.is_lesson());
    }

    #[test]
    fn a_tutorial_that_is_really_a_youtube_link_is_catalogued_as_a_video() {
        // FAF publishes whole tutorial categories that are pointers to videos.
        // Listing those as lessons would offer a start button for something the
        // client cannot start.
        let lessons = lesson_resources(
            &[tutorial(
                9,
                "Advanced eco management",
                "A video by a high level player.",
                false,
                "https://www.youtube.com/watch?v=abc",
            )],
            |_| "Video tutorials".to_string(),
        );
        assert_eq!(lessons[0].kind, TrainingKind::Video);
        assert_eq!(lessons[0].url, "https://www.youtube.com/watch?v=abc");
        assert_eq!(lessons[0].level, Some(TrainingLevel::Advanced));
        assert!(!lessons[0].is_lesson());
    }

    #[test]
    fn a_curated_entry_replaces_the_lesson_it_describes() {
        // The whole reason a manifest entry carries `tutorialId`: a curator's
        // tags must not be merged with a keyword table's guesses.
        let curated = vec![TrainingResource {
            id: "setons-build".into(),
            title: "Seton's build order".into(),
            tutorial_id: Some(7),
            maps: vec!["Setons Clutch".into()],
            ..TrainingResource::default()
        }];
        let lessons = lesson_resources(
            &[
                tutorial(7, "Lesson", "", true, ""),
                tutorial(8, "Other", "", true, ""),
            ],
            |_| String::new(),
        );

        let merged = merge_catalogue(&curated, lessons);
        assert_eq!(
            merged.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            vec!["setons-build", "faf-tutorial-8"]
        );
    }

    // -- composing a post --------------------------------------------------

    /// A profile that knows one number and nothing else, for the filter tests
    /// that predate ratings being per mode.
    fn at_rating(rating: Option<i32>) -> TrainingProfile {
        TrainingProfile {
            rating,
            ..TrainingProfile::default()
        }
    }

    #[test]
    fn a_guide_is_judged_by_the_rating_for_its_own_mode() {
        // The case that made this necessary: 1800 global, 1200 in the ladder.
        // A 1v1 guide written for 1000 to 1400 is exactly right for them, and
        // judging it by the headline rating hides it from the person it was
        // written for.
        let profile = TrainingProfile {
            rating: Some(1800),
            ratings: BTreeMap::from([("1v1".to_string(), 1200), ("global".to_string(), 1800)]),
            ..TrainingProfile::default()
        };

        let ladder = TrainingResource {
            id: "ladder".into(),
            title: "1v1 fundamentals".into(),
            game_modes: vec!["1v1".into()],
            rating_min: Some(1000),
            rating_max: Some(1400),
            level: None,
            ..TrainingResource::default()
        };
        assert_eq!(profile.rating_for(&ladder), Some(1200));
        assert!(ladder.covers_rating(profile.rating_for(&ladder).unwrap()));

        // Something about the game rather than a queue is judged by global.
        let general = TrainingResource {
            id: "general".into(),
            title: "Economy".into(),
            rating_min: Some(1600),
            level: None,
            ..TrainingResource::default()
        };
        assert_eq!(profile.rating_for(&general), Some(1800));
        assert!(general.covers_rating(profile.rating_for(&general).unwrap()));

        // A mode this account has never played falls back to global rather
        // than claiming a rating it does not have.
        let coop = TrainingResource {
            id: "coop".into(),
            title: "Co-op".into(),
            game_modes: vec!["coop".into()],
            level: None,
            ..TrainingResource::default()
        };
        assert_eq!(profile.rating_for(&coop), Some(1800));
    }

    #[test]
    fn a_leaderboard_name_maps_to_the_mode_the_catalogue_speaks_in() {
        assert_eq!(mode_of_leaderboard("ladder_1v1"), Some("1v1"));
        assert_eq!(mode_of_leaderboard("tmm_2v2"), Some("2v2"));
        assert_eq!(mode_of_leaderboard("tmm_3v3"), Some("3v3"));
        assert_eq!(mode_of_leaderboard("tmm_4v4"), Some("4v4"));
        assert_eq!(mode_of_leaderboard("global"), Some("global"));

        // The reason this reads the name instead of matching a list: FAF names
        // a queue after what it is, and a decorated name is still that queue.
        // A fixed table dropped this one, which is how 4v4 went missing.
        assert_eq!(
            mode_of_leaderboard("tmm_4v4_share_until_death"),
            Some("4v4")
        );

        // Nothing recognisable, so nothing claimed.
        assert_eq!(mode_of_leaderboard("tmm_5v5"), None);
        assert_eq!(mode_of_leaderboard("some_new_board"), None);
    }

    #[test]
    fn a_custom_game_is_judged_by_the_global_rating() {
        let mut profile = profile(1200, &["Setons Clutch"], &["4v4"]);
        profile.ratings = BTreeMap::from([("global".into(), 1500), ("4v4".into(), 900)]);

        // Seton's is played in a lobby, not in the matchmaker, so a build order
        // for it is written for a global rating. Reading it off the 4v4 board
        // would judge it by a queue its reader may never have entered.
        let setons = TrainingResource {
            game_modes: vec!["custom".into(), "4v4".into()],
            ..resource("setons")
        };
        assert_eq!(profile.rating_for(&setons), Some(1500));

        // The order in the entry decides, and a matchmaker entry is unaffected.
        let ladder = TrainingResource {
            game_modes: vec!["4v4".into()],
            ..resource("ladder")
        };
        assert_eq!(profile.rating_for(&ladder), Some(900));

        // And the filter treats the two words as one, in both directions, so
        // choosing either does not split the library in half.
        assert!(setons.covers_mode("custom"));
        assert!(setons.covers_mode("global"));
        assert!(setons.covers_mode("4v4"));
        assert!(!ladder.covers_mode("custom"));
    }

    fn links() -> TrainingLinks {
        TrainingLinks {
            replay_review_category: Some(4),
            contribute_category: Some(4),
            // Both Discord destinations, so a test can tell which one a review
            // chose rather than passing because they are equally empty.
            discord_url: "https://discord.gg/example".into(),
            replay_review_channel: "https://discord.com/channels/1/2".into(),
            ..TrainingLinks::default()
        }
    }

    #[test]
    fn a_review_request_needs_a_replay_and_a_question() {
        // Both are the difference between a request someone can answer and one
        // that sits there. The form refuses rather than posting either.
        let empty = ReviewRequestDraft::default();
        assert_eq!(review_problem(&empty), Some(ReviewProblem::NoReplay));

        let no_goal = ReviewRequestDraft {
            replay_id: Some(27_456_965),
            ..ReviewRequestDraft::default()
        };
        assert_eq!(review_problem(&no_goal), Some(ReviewProblem::NoGoal));

        let ready = ReviewRequestDraft {
            goal: "Where did I lose the eco lead?".into(),
            ..no_goal
        };
        assert_eq!(review_problem(&ready), None);
    }

    #[test]
    fn a_local_file_counts_as_a_replay_when_nothing_was_uploaded() {
        let draft = ReviewRequestDraft {
            replay_file: "2026-09-04 setons.fafreplay".into(),
            goal: "help".into(),
            ..ReviewRequestDraft::default()
        };
        assert_eq!(review_problem(&draft), None);
    }

    #[test]
    fn the_composed_request_names_the_replay_the_map_and_the_question() {
        let draft = ReviewRequestDraft {
            replay_id: Some(27_456_965),
            replay_link: "https://replay.faforever.com/27456965".into(),
            player: "Ada".into(),
            rating: "1150".into(),
            game_mode: "1v1".into(),
            map: "Setons Clutch".into(),
            faction: "UEF".into(),
            played_at: "2026-09-04".into(),
            goal: "Where did I lose the eco lead?".into(),
            struggle: "I never had enough mass by ten minutes.".into(),
            replay_file: String::new(),
        };
        let post = compose_review_request(&draft, &links());

        assert_eq!(
            post.title,
            "Replay review request: Ada on Setons Clutch (1v1)"
        );
        assert!(post.body.contains("https://replay.faforever.com/27456965"));
        assert!(post.body.contains("**Rating:** 1150"));
        assert!(post.body.contains("Where did I lose the eco lead?"));
        assert!(post.body.contains("ten minutes"));
        // Discord, not the forum: a review is answered by people in a channel,
        // and no URL can prefill a message there, so the client writes the
        // request and the player pastes it.
        assert_eq!(
            post.url,
            links().replay_review_channel,
            "the named channel wins over the invite"
        );
    }

    #[test]
    fn a_field_the_client_could_not_fill_is_left_out_rather_than_left_blank() {
        // A template full of empty labels reads as an abandoned request.
        let draft = ReviewRequestDraft {
            replay_id: Some(1),
            goal: "help".into(),
            ..ReviewRequestDraft::default()
        };
        let post = compose_review_request(&draft, &links());
        assert!(!post.body.contains("**Map:**"));
        assert!(!post.body.contains("**Rating:**"));
        assert_eq!(post.title, "Replay review request");
    }

    #[test]
    fn without_a_category_the_post_still_exists_and_only_the_link_is_missing() {
        // A deployment that has not been told which forum category to use must
        // not lose the composed text: it can still be copied.
        let draft = ReviewRequestDraft {
            replay_id: Some(1),
            goal: "help".into(),
            ..ReviewRequestDraft::default()
        };
        let post = compose_review_request(&draft, &TrainingLinks::default());
        assert!(post.url.is_empty());
        assert!(!post.body.is_empty());
    }

    #[test]
    fn the_composer_link_percent_encodes_everything_a_body_can_contain() {
        // Markdown bodies contain newlines, `#`, `&` and `*`, every one of
        // which would otherwise end the parameter early or start a new one.
        let encoded = percent_encode("a&b #1\n*x*");
        assert_eq!(encoded, "a%26b%20%231%0A%2Ax%2A");
        assert!(!encoded.contains('&'));

        let url = compose_url(Some(4), "T&T", "line one\nline two");
        assert!(url.contains("title=T%26T"));
        assert!(url.contains("body=line%20one%0Aline%20two"));
    }

    #[test]
    fn a_submission_needs_a_title_and_either_a_link_or_a_body() {
        let empty = ContributionDraft::default();
        assert_eq!(
            contribution_problem(&empty),
            Some(ContributionProblem::NoTitle)
        );

        let titled = ContributionDraft {
            title: "T1 tank micro".into(),
            ..ContributionDraft::default()
        };
        assert_eq!(
            contribution_problem(&titled),
            Some(ContributionProblem::NoContent)
        );

        let linked = ContributionDraft {
            url: "https://www.youtube.com/watch?v=abc".into(),
            ..titled.clone()
        };
        assert_eq!(contribution_problem(&linked), None);

        let written = ContributionDraft {
            body: "Split your tanks before they are shot.".into(),
            ..titled
        };
        assert_eq!(contribution_problem(&written), None);
    }

    #[test]
    fn something_that_is_not_a_link_is_rejected_before_it_is_posted_as_one() {
        for bad in [
            "youtube.com/watch",
            "http://example.invalid",
            "https://",
            "https://a b.com",
        ] {
            let draft = ContributionDraft {
                title: "T".into(),
                url: bad.into(),
                ..ContributionDraft::default()
            };
            assert_eq!(
                contribution_problem(&draft),
                Some(ContributionProblem::BadUrl),
                "{bad}"
            );
        }
    }

    #[test]
    fn a_submission_carries_its_tags_so_a_curator_need_not_ask_again() {
        let draft = ContributionDraft {
            title: "Seton's opening".into(),
            summary: "Four mexes, then a land factory.".into(),
            kind: TrainingKind::BuildOrder,
            level: Some(TrainingLevel::Beginner),
            url: String::new(),
            body: "Four mexes, then a land factory.".into(),
            topics: vec![TrainingTopic::BuildOrder, TrainingTopic::Economy],
            game_modes: vec!["4v4".into()],
            maps: vec!["Setons Clutch".into()],
            factions: vec!["uef".into()],
            rating_min: "800".into(),
            rating_max: "1200".into(),
        };
        let post = compose_contribution(&draft, &links());

        assert_eq!(post.title, "Training submission: Seton's opening");
        assert!(post.body.contains("Four mexes, then a land factory."));
        assert!(post.body.contains("**Type:** Build order"));
        assert!(post.body.contains("**Level:** Beginner"));
        assert!(post.body.contains("**Rating:** 800 to 1200"));
        assert!(post.body.contains("**Maps:** Setons Clutch"));
        assert!(post.body.contains("**Topics:** Build orders, Economy"));
        assert!(post.body.contains("Four mexes"));
    }

    // -- reducer -----------------------------------------------------------

    #[test]
    fn loading_replaces_the_catalogue_and_drops_a_selection_that_vanished() {
        let mut state = TrainingState {
            selected_id: Some("gone".into()),
            ..TrainingState::default()
        };
        reduce(&mut state, &TrainingEvent::Loading);
        assert_eq!(state.status, TrainingStatus::Loading);

        reduce(
            &mut state,
            &TrainingEvent::Loaded {
                resources: vec![resource("a")],
                trainers: Vec::new(),
                links: links(),
                source: TrainingSource::Remote,
            },
        );
        assert_eq!(state.status, TrainingStatus::Ready);
        assert_eq!(state.source, TrainingSource::Remote);
        assert_eq!(state.selected_id, None);

        state.selected_id = Some("a".into());
        reduce(
            &mut state,
            &TrainingEvent::Loaded {
                resources: vec![resource("a")],
                trainers: Vec::new(),
                links: links(),
                source: TrainingSource::Remote,
            },
        );
        assert_eq!(
            state.selected_id,
            Some("a".into()),
            "still there, still open"
        );
    }

    #[test]
    fn a_failed_load_keeps_whatever_was_already_listed() {
        let mut state = TrainingState {
            resources: vec![resource("a")],
            status: TrainingStatus::Ready,
            ..TrainingState::default()
        };
        reduce(
            &mut state,
            &TrainingEvent::LoadFailed {
                reason: "offline".into(),
            },
        );
        assert_eq!(state.resources.len(), 1);
    }

    #[test]
    fn editing_a_request_invalidates_the_post_already_composed_from_it() {
        // Otherwise the preview and the buttons describe the previous answer,
        // and the player posts the version they just changed away from.
        let mut state = TrainingState::default();
        let draft = ReviewRequestDraft {
            replay_id: Some(1),
            goal: "help".into(),
            ..ReviewRequestDraft::default()
        };
        reduce(
            &mut state,
            &TrainingEvent::ReviewOpened {
                draft: Box::new(draft.clone()),
            },
        );
        reduce(
            &mut state,
            &TrainingEvent::ReviewComposed {
                post: Box::new(compose_review_request(&draft, &links())),
            },
        );
        assert!(state.review_post.is_some());

        reduce(
            &mut state,
            &TrainingEvent::ReviewChanged {
                draft: Box::new(ReviewRequestDraft {
                    goal: "different question".into(),
                    ..draft
                }),
            },
        );
        assert!(state.review_post.is_none());
    }

    #[test]
    fn opening_a_second_request_never_shows_the_first_one_s_post() {
        let mut state = TrainingState {
            review_post: Some(ForumPost {
                title: "old".into(),
                ..ForumPost::default()
            }),
            ..TrainingState::default()
        };
        reduce(
            &mut state,
            &TrainingEvent::ReviewOpened {
                draft: Box::new(ReviewRequestDraft::default()),
            },
        );
        assert!(state.review_post.is_none());
    }

    #[test]
    fn closing_a_form_clears_both_the_draft_and_the_post() {
        let mut state = TrainingState {
            review: Some(ReviewRequestDraft::default()),
            review_post: Some(ForumPost::default()),
            contribution: Some(ContributionDraft::default()),
            contribution_post: Some(ForumPost::default()),
            ..TrainingState::default()
        };
        reduce(&mut state, &TrainingEvent::ReviewClosed);
        reduce(&mut state, &TrainingEvent::ContributionClosed);
        assert!(state.review.is_none() && state.review_post.is_none());
        assert!(state.contribution.is_none() && state.contribution_post.is_none());
    }

    #[test]
    fn recommendations_carry_the_profile_they_were_computed_from() {
        // The hub says what it based them on, and a rail that cannot explain
        // itself is indistinguishable from a random one.
        let mut state = TrainingState::default();
        reduce(
            &mut state,
            &TrainingEvent::Recommended {
                resource_ids: vec!["a".into()],
                profile: Box::new(profile(1100, &["Setons Clutch"], &["4v4"])),
            },
        );
        assert_eq!(state.recommended, vec!["a"]);
        assert_eq!(state.profile.rating, Some(1100));
    }

    #[test]
    fn a_trainer_reads_the_same_band_a_resource_does() {
        // One arithmetic for both, so a tile and a card cannot disagree about
        // who a rating range includes.
        let trainer = Trainer {
            rating_min: Some(1000),
            rating_max: Some(1800),
            ..Trainer::default()
        };
        assert!(trainer.covers_rating(1200));
        assert!(!trainer.covers_rating(900));

        let open = Trainer {
            rating_min: Some(1000),
            ..Trainer::default()
        };
        assert!(open.covers_rating(2500), "an unstated ceiling is open");
        assert!(
            Trainer::default().covers_rating(400),
            "a trainer who states no range coaches anyone"
        );
    }

    #[test]
    fn loading_replaces_the_trainer_list() {
        let mut state = TrainingState::default();
        reduce(
            &mut state,
            &TrainingEvent::Loaded {
                resources: Vec::new(),
                trainers: vec![Trainer {
                    id: "seraphim-noob".into(),
                    name: "Seraphim-Noob".into(),
                    accepting: true,
                    ..Trainer::default()
                }],
                links: links(),
                source: TrainingSource::Remote,
            },
        );
        assert_eq!(state.trainers.len(), 1);

        reduce(
            &mut state,
            &TrainingEvent::Loaded {
                resources: Vec::new(),
                trainers: Vec::new(),
                links: links(),
                source: TrainingSource::Remote,
            },
        );
        assert!(
            state.trainers.is_empty(),
            "a trainer who left the manifest leaves the tab"
        );
    }

    #[test]
    fn a_youtube_link_carries_its_own_thumbnail_in_every_shape_people_paste() {
        // Most of FAF's video material is on YouTube, and the grid is only
        // worth having if the cards are pictures rather than ten identical
        // marks. The address is derivable, so no key and no request.
        let expected = "https://img.youtube.com/vi/dQw4w9WgXcQ/mqdefault.jpg";
        for url in [
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://youtube.com/watch?v=dQw4w9WgXcQ",
            "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://youtu.be/dQw4w9WgXcQ",
            "https://www.youtube.com/embed/dQw4w9WgXcQ",
            "https://www.youtube.com/shorts/dQw4w9WgXcQ",
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s",
            "https://www.youtube.com/watch?list=PL123&v=dQw4w9WgXcQ",
            "https://youtu.be/dQw4w9WgXcQ?t=42",
        ] {
            assert_eq!(video_still(url), expected, "{url}");
        }
    }

    #[test]
    fn anything_that_is_not_a_video_gets_no_guessed_picture() {
        // A guessed thumbnail address is a broken image on somebody's card,
        // which is worse than the mark that says what the entry is.
        for url in [
            "",
            "https://wiki.faforever.com",
            "https://forum.faforever.com/topic/1",
            "https://www.youtube.com/watch?v=short",
            "https://www.youtube.com/watch?v=way-too-long-to-be-an-id",
            "https://www.youtube.com/@somechannel",
            "https://notyoutube.com/watch?v=dQw4w9WgXcQ",
            "ftp://youtu.be/dQw4w9WgXcQ",
        ] {
            assert_eq!(video_still(url), "", "{url}");
        }
    }

    #[test]
    fn topic_counts_cover_every_topic_including_the_empty_ones() {
        // The basics cards are drawn from this, and a topic with nothing in it
        // has to be able to say so rather than being absent.
        let counts = topic_counts(&[TrainingResource {
            topics: vec![TrainingTopic::Economy],
            ..resource("a")
        }]);
        assert_eq!(counts.len(), TrainingTopic::ALL.len());
        assert_eq!(
            counts
                .iter()
                .find(|(topic, _)| *topic == TrainingTopic::Economy)
                .unwrap()
                .1,
            1
        );
        assert_eq!(
            counts
                .iter()
                .find(|(topic, _)| *topic == TrainingTopic::Micro)
                .unwrap()
                .1,
            0
        );
    }
}
