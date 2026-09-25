//! Recurring tournaments: a series and its editions.

use super::*;

/// A named grouping of tournaments.
///
/// Only a label, and worth saying plainly because the name invites a stronger
/// reading: editions of a series are fully independent events. There is no
/// qualification between them, no fixed cadence and no shared bracket. A series
/// links them for browsing, which is why it lives at `GET /api/series` rather
/// than inside any one tournament.
///
/// Qualification is the separate mechanism below ([`Qualifier`]), and the two
/// are unrelated: a qualifier link can cross series, and editions of one series
/// usually feed nothing at all.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TourneySeries {
    pub id: String,
    pub name: String,
    /// Reduced to plain text on the way in, like every other field somebody
    /// else's editor produced.
    pub description: String,
    pub colour: SeriesColour,
    /// `Some` only where the site admin tagged it; a community series has none.
    pub category: Option<TourneyCategory>,
    /// Published, unarchived editions.
    pub editions: i32,
    /// How many of those are still open or being played. The service sorts
    /// running series first, so a dormant one falls to the bottom rather than
    /// being mixed in with the live ones.
    pub active: i32,
    /// The most recent edition's date, in Unix seconds, or its creation stamp
    /// where it has none. The service's own sort key, kept so the client can
    /// show what the order is built on.
    pub last_at: Option<u32>,
    pub latest_id: Option<String>,
    pub latest_name: String,
    pub latest_date: Option<u32>,
}

/// A series' colour, from the service's fixed palette.
///
/// Six named values rather than free-form hex, so a series can never end up
/// unreadable against the dark theme. The service picks one from the name when
/// a series is created and lets its owner change it; [`Self::Plain`] is never
/// picked automatically, so it means somebody chose it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum SeriesColour {
    Amber,
    Blue,
    Green,
    Red,
    Purple,
    #[default]
    Plain,
}

impl SeriesColour {
    /// Read leniently: an unknown colour is one we cannot draw, and
    /// [`Self::Plain`] draws correctly whatever the value was.
    pub fn from_wire(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "amber" => Self::Amber,
            "blue" => Self::Blue,
            "green" => Self::Green,
            "red" => Self::Red,
            "purple" => Self::Purple,
            _ => Self::Plain,
        }
    }

    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Amber => "amber",
            Self::Blue => "blue",
            Self::Green => "green",
            Self::Red => "red",
            Self::Purple => "purple",
            Self::Plain => "plain",
        }
    }

    /// The palette, in the service's own order, for a picker.
    pub const ALL: [Self; 6] = [
        Self::Amber,
        Self::Blue,
        Self::Green,
        Self::Red,
        Self::Purple,
        Self::Plain,
    ];
}

/// One tournament as a series lists it.
///
/// Deliberately not a [`Tourney`]: `GET /api/series/{id}` sends a dozen fields
/// per edition, not a whole event, and widening the tournament type to hold a
/// tenth of itself would leave every consumer asking which half is filled in.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SeriesEdition {
    pub id: String,
    pub name: String,
    pub status: TourneyStatus,
    pub category: Option<TourneyCategory>,
    /// Unpublished editions reach only their own organisers, site admins and
    /// directors: the service filters the list before sending it.
    pub published: bool,
    pub competition: Competition,
    pub bracket_kind: BracketKind,
    pub team_size: i32,
    pub player_count: i32,
    pub team_count: i32,
    pub event_date: Option<u32>,
    pub abandoned: bool,
    pub champion_team_id: Option<String>,
    /// The winning team's name, already resolved by the service.
    pub champion: String,
}

/// One series with its editions, from `GET /api/series/{id}`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SeriesDetail {
    pub id: String,
    pub name: String,
    pub description: String,
    pub colour: SeriesColour,
    pub category: Option<TourneyCategory>,
    /// Newest first.
    pub editions: Vec<SeriesEdition>,
    /// Whether this account may rename or delete it.
    ///
    /// Read from the service rather than worked out here, and that is the whole
    /// reason it is a field: the answer is "a site admin, a director, whoever
    /// created it, or an organiser of any edition in it", and the last of those
    /// needs every tournament in the database to decide. The client holds the
    /// list it was sent, not the database.
    pub can_edit: bool,
}

/// A series being created or renamed.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SeriesDraft {
    /// Empty to create; an existing id edits that one.
    pub id: String,
    pub name: String,
    pub description: String,
    pub colour: SeriesColour,
    pub category: Option<TourneyCategory>,
}

impl SeriesDraft {
    /// Whether the service would accept it. It insists on a name and nothing
    /// else; the duplicate-name check needs every series and stays server-side.
    pub fn is_submittable(&self) -> bool {
        !self.name.trim().is_empty()
    }
}
