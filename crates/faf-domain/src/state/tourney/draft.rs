//! Creating and editing a tournament: the draft, its format, seeding and
//! sign-up rules, qualifiers, and what the service rejects.

use super::*;

/// How entrants get in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SignupMode {
    /// Anyone signed in may enter.
    #[default]
    Open,
    /// The organiser invites; nobody else can enter.
    Invite,
    /// Anyone may ask, and the organiser approves each one.
    Request,
}

impl SignupMode {
    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Invite => "invite",
            Self::Request => "request",
        }
    }

    pub fn from_wire(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "invite" => Self::Invite,
            "request" => Self::Request,
            _ => Self::Open,
        }
    }
}

/// Which FAF rating decides seeding, and whether one is used at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum RatingKind {
    #[default]
    Global,
    Ladder1v1,
    Team2v2,
    Team3v3,
    Team4v4,
    /// The combined figure the tournament team calls RC.
    Combined,
    /// Unrated: nobody's rating is fetched, and no gate can apply.
    None,
}

impl RatingKind {
    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Global => "global",
            Self::Ladder1v1 => "1v1",
            Self::Team2v2 => "2v2",
            Self::Team3v3 => "3v3",
            Self::Team4v4 => "4v4",
            Self::Combined => "rc",
            Self::None => "none",
        }
    }

    pub fn from_wire(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "1v1" => Self::Ladder1v1,
            "2v2" => Self::Team2v2,
            "3v3" => Self::Team3v3,
            "4v4" => Self::Team4v4,
            "rc" => Self::Combined,
            "none" => Self::None,
            _ => Self::Global,
        }
    }
}

/// How the bracket is seeded once teams are formed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Seeding {
    #[default]
    Rating,
    Random,
    Manual,
}

impl Seeding {
    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Rating => "rating",
            Self::Random => "random",
            Self::Manual => "manual",
        }
    }

    pub fn from_wire(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "random" => Self::Random,
            "manual" => Self::Manual,
            _ => Self::Rating,
        }
    }
}

/// A tournament as the organiser filled it in.
///
/// The whole of what `POST /api/tournaments` accepts for a team event, which it
/// was not always: the first version left the rich fields, the prize, the
/// streams and the best-of plan to the service's defaults, on the reasoning that
/// six best-of numbers are the wrong first question. That reasoning was wrong
/// about where the answers come from. Everything the overview shows is typed
/// here, so a create form that skips a field is an overview with a hole in it
/// and an organiser sent to the website to fill it.
///
/// Two things are still not here, and for the same reason as before: the
/// free-for-all configuration, which has a shape of its own, and per-round
/// best-of overrides, which cannot be asked about before the rounds exist.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TourneyDraft {
    pub name: String,
    /// The briefing, as markdown source. See [`Tourney::description`].
    pub description: String,
    pub rewards: String,
    pub sponsors: String,
    pub lobby_options: String,
    pub mods: String,
    /// The headline cash prize, or `None` for an event without one.
    pub prize: Option<Prize>,
    /// Up to ten stream links. Anything that is not `http(s)` is dropped by the
    /// service without a word, so the form refuses it first.
    pub streams: Vec<Stream>,
    /// The series this edition belongs to, where the organiser picked one.
    pub series_id: Option<String>,
    /// The best-of template. `None` for a free-for-all, which has no bracket.
    pub plan: Option<MatchPlan>,
    /// Whether the captains ban and pick maps, and how.
    pub veto: VetoConfig,
    /// The lower bound the organiser wants, or 0. Display only.
    pub min_teams: i32,
    /// Whether the draft snakes back on every other pass. Only read for a
    /// captains draft, and sent only then.
    pub draft_snakes: bool,
    pub category: TourneyCategory,
    pub competition: Competition,
    /// 1 to 6. A size of one makes the formation solo whatever is asked for.
    pub team_size: i32,
    /// Only consulted above a team size of one.
    pub formation: Formation,
    pub bracket_kind: BracketKind,
    pub seeding: Seeding,
    pub rating_kind: RatingKind,
    pub signup_mode: SignupMode,
    /// Unix seconds; sent as an ISO instant, which is what the server stores.
    pub event_date: Option<u32>,
    pub signup_opens_at: Option<u32>,
    pub signup_closes_at: Option<u32>,
    /// The instant every entrant's rating is taken from, or `None` to use
    /// whatever it is when they sign up.
    ///
    /// The third date an event needs, and the one that is not about scheduling:
    /// it stops an entrant signing up on a peak rating and playing weeks later
    /// on a lower one. The service freezes against it when it fetches a rating
    /// from FAF, so it has to be set before signups open to mean anything.
    pub rating_date: Option<u32>,
    pub rating: RatingGate,
    /// Entrant cap. Zero means no cap, which is the server's own convention.
    pub max_teams: i32,
}

impl TourneyDraft {
    /// The defaults a new event starts from: a 2v2 community cup with open
    /// signups, single elimination, and the service's own best-of template.
    pub fn new() -> Self {
        Self {
            team_size: 2,
            plan: Some(MatchPlan::default_for(BracketKind::default())),
            ..Self::default()
        }
    }

    /// The formation the server will actually use.
    ///
    /// A team of one is always solo, whatever the form said. Mirrored here so
    /// the form can stop offering a choice that has no effect rather than
    /// letting the organiser make one and quietly overriding it.
    pub fn effective_formation(&self) -> Formation {
        if self.team_size <= 1 || self.competition == Competition::FreeForAll {
            Formation::Solo
        } else {
            self.formation
        }
    }

    /// Why the server would refuse this, if it would.
    ///
    /// Checked here so the submit button can say what is missing, rather than
    /// the organiser filling in a long form and being told "Name required".
    pub fn rejection(&self) -> Option<DraftRejection> {
        if self.name.trim().is_empty() {
            return Some(DraftRejection::NameRequired);
        }
        if !(1..=6).contains(&self.team_size) {
            return Some(DraftRejection::TeamSizeOutOfRange);
        }
        if let (Some(min), Some(max)) = (self.rating.min, self.rating.max) {
            if min > max {
                return Some(DraftRejection::RatingRangeInverted);
            }
        }
        // A gate needs a rating to compare against, and an unrated event never
        // fetches one, so the two together can only ever refuse every signup.
        if self.rating_kind == RatingKind::None
            && (self.rating.min.is_some() || self.rating.max.is_some())
        {
            return Some(DraftRejection::RatingGateWithoutRating);
        }
        if let (Some(opens), Some(closes)) = (self.signup_opens_at, self.signup_closes_at) {
            if opens >= closes {
                return Some(DraftRejection::SignupWindowInverted);
            }
        }
        None
    }

    pub fn is_submittable(&self) -> bool {
        self.rejection().is_none()
    }
}

/// Why a [`TourneyDraft`] is not submittable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum DraftRejection {
    NameRequired,
    TeamSizeOutOfRange,
    RatingRangeInverted,
    RatingGateWithoutRating,
    SignupWindowInverted,
}

/// The shape of the competition, changed after the event was created.
///
/// A narrower set than the service's `edit_format` accepts. The best-of plan
/// per round stays on the website, being a dozen numbers whose meaning changes
/// with the bracket type; the seeding policy and the entrant cap are absent for
/// a harder reason, which is that the client never reads either off the event,
/// so it has nothing to put in the field but a guess.
///
/// What is here is what an organiser gets wrong at creation and then has to
/// undo: the wrong bracket, a team size of one where two was meant, an open
/// field where a draft was meant.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FormatDraft {
    pub competition: Competition,
    /// 1 to 6 for a team event, 1 to 3 for a free-for-all: the service clamps
    /// each to its own range.
    pub team_size: i32,
    pub formation: Formation,
    pub bracket_kind: BracketKind,
    /// Whether the draft order snakes back on every other pass.
    pub draft_snakes: bool,
}

impl FormatDraft {
    /// The event's current format, as the starting point for editing it.
    pub fn of(event: &Tourney) -> Self {
        Self {
            competition: event.competition,
            team_size: event.team_size,
            formation: event.formation,
            bracket_kind: event.bracket_kind,
            draft_snakes: event.draft_snakes,
        }
    }

    /// Whether this changes anything the service calls structural.
    ///
    /// Those four are refused outside signups, because they decide what a team
    /// *is*: everything already built out of teams would have to be thrown
    /// away. The bracket type and the seeding are not structural and can be
    /// changed right up to the draw.
    pub fn is_structural(&self, event: &Tourney) -> bool {
        self.competition != event.competition
            || self.team_size != event.team_size
            || self.formation != event.formation
            || self.draft_snakes != event.draft_snakes
    }
}

// ---------------------------------------------------------------------------
// Series and qualification: how one event relates to another.
// ---------------------------------------------------------------------------

/// A tournament whose result feeds entrants into another one.
///
/// The link lives on the *parent* alone, and a child derives "feeds into X" by
/// lookup, so the two sides can never disagree. Qualifying does not sign anyone
/// up: the service sends each qualified account a normal invite, which they
/// still have to accept.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Qualifier {
    /// The link's own id, which is what removes it.
    pub id: String,
    /// The child event this draws from.
    pub tournament_id: String,
    /// Its name, or the service's placeholder where it has since been deleted.
    pub name: String,
    /// `None` where the child is gone.
    pub status: Option<TourneyStatus>,
    pub rule: QualifierRule,
    /// When the link was applied, in Unix seconds, or `None` while the child is
    /// still being played. The service sweeps lazily, on read, so a finished
    /// child can sit unapplied for as long as nobody asks for the list.
    pub applied: Option<u32>,
    /// The teams that qualified, by name, filled in once applied.
    pub qualified: Vec<String>,
    /// Teams that qualified and could not be invited, because no member has a
    /// FAF account: a manually added entrant has none, and an invite is
    /// addressed to an account. Worth showing rather than swallowing, since it
    /// is the organiser who then has to add them by hand.
    pub unreachable: Vec<String>,
}

/// How many of a child's entrants go through, and by what measure.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct QualifierRule {
    pub kind: QualifierKind,
    /// The cutoff: how many for [`QualifierKind::Top`], the lowest qualifying
    /// score for [`QualifierKind::Points`]. At least 1 either way.
    pub n: i32,
}

impl Default for QualifierRule {
    /// The service's own default, which it reaches by clamping: anything that
    /// is not `points` is `top`, and any count below 1 becomes 1.
    fn default() -> Self {
        Self {
            kind: QualifierKind::Top,
            n: 1,
        }
    }
}

/// Which measure a qualifier link ranks by.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum QualifierKind {
    /// The best N, however the child's format ranks its entrants: champion
    /// first in an elimination bracket, standings order in Swiss, points order
    /// in a free-for-all.
    #[default]
    Top,
    /// Everyone who reached N points, which only Swiss and free-for-all can
    /// answer.
    Points,
}

impl QualifierKind {
    pub fn from_wire(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "points" => Self::Points,
            _ => Self::Top,
        }
    }

    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Top => "top",
            Self::Points => "points",
        }
    }

    /// Whether a child in this format can be ranked by this measure.
    ///
    /// [`Self::Points`] needs a score per entrant, which only Swiss and
    /// free-for-all keep. Set against an elimination bracket the service takes
    /// the link and then qualifies nobody, silently: the organiser finds out
    /// when the invites they were waiting for never arrive. Caught here so the
    /// combination is never offered.
    pub fn suits(self, competition: Competition, bracket: BracketKind) -> bool {
        match self {
            Self::Top => true,
            Self::Points => competition == Competition::FreeForAll || bracket == BracketKind::Swiss,
        }
    }
}

/// The parent this tournament feeds, where it feeds one.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FeedsInto {
    pub parent_id: String,
    pub parent_name: String,
    pub rule: QualifierRule,
    /// Unix seconds, once the parent has taken its entrants.
    pub applied: Option<u32>,
}

/// Why the service would refuse a qualifier link, in the order it checks.
///
/// Its remaining check, "that tournament already draws its qualifiers from this
/// one", needs the *candidate's* own qualifier list, which a list row does not
/// carry. That one stays with the service.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum QualifierRejection {
    /// A tournament cannot qualify into itself.
    SameEvent,
    /// This child is already linked.
    AlreadyLinked,
    /// The cutoff has to be at least 1.
    CutoffTooLow,
    /// A points rule against a format that keeps no score. The service accepts
    /// this and then qualifies nobody, so it is refused here instead.
    PointsWithoutScores,
}
