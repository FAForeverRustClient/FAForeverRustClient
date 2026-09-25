//! Map pools: the maps a round is played on, how a pool is edited, and how a
//! tournament map is matched against the vault.

use super::*;

/// One map in a tournament's own map database.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TourneyMap {
    pub id: String,
    pub name: String,
    /// Preview image served by the tournament server, when it has one.
    ///
    /// Usually empty, and that is fine: the client prefers FAF's own vault
    /// preview anyway (see [`match_vault_map`]). The tournament server's copy
    /// exists for maps that are not in the vault at all.
    pub image_url: String,
    /// The organiser's note about it: a spawn count, a mod requirement, why it
    /// is in the pool at all.
    pub description: String,
    /// Whether players can see it.
    ///
    /// The service hides an unpublished map from everyone but the organisers,
    /// with one exception it makes itself: a map already on screen in a live
    /// veto or an assigned round keeps its name, or players would be looking at
    /// a raw id.
    pub published: bool,
}

/// Reduce a map name to something two spellings of it can be compared by.
///
/// Tournament organisers type map names by hand: `Seton's Clutch`,
/// `setons clutch`, `SCMP_009`, `Seton's Clutch.v0001`. The vault's own
/// `display_name` and `folder_name` are a third and fourth spelling again.
/// Comparing on letters and digits alone is what makes those the same map,
/// without needing a lookup table nobody would maintain.
pub fn map_key(name: &str) -> String {
    name.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// Strip a version suffix like `.v0001` before comparing.
fn without_version(folder: &str) -> &str {
    folder.split(".v").next().unwrap_or(folder)
}

/// Find the vault map a tournament map refers to.
///
/// Preferred over the tournament server's own image: the vault preview is the
/// picture players already recognise from the maps tab, it is served by FAF,
/// and it is there for every map in the vault whether or not an organiser
/// uploaded one.
///
/// Matches the display name first and the folder name second, so
/// `Seton's Clutch` and `scmp_009` both resolve. `None` when nothing matches,
/// which is a real case: a tournament may run a map that was never uploaded.
pub fn match_vault_map<'a, M>(
    tourney_map: &TourneyMap,
    vault: &'a [M],
    display_name: impl Fn(&M) -> &str,
    folder_name: impl Fn(&M) -> &str,
) -> Option<&'a M> {
    let wanted = map_key(&tourney_map.name);
    if wanted.is_empty() {
        return None;
    }
    // The version has to come off *both* sides for the folder comparison: an
    // organiser who copied `scmp_009.v0001` out of their maps directory is
    // naming the same map as the vault's `scmp_009.v0002`.
    let wanted_folder = map_key(without_version(tourney_map.name.trim()));
    vault
        .iter()
        .find(|candidate| map_key(display_name(candidate)) == wanted)
        .or_else(|| {
            vault
                .iter()
                .find(|candidate| map_key(without_version(folder_name(candidate))) == wanted_folder)
        })
}

/// A named set of maps, with the ban/pick order it is played in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MapPool {
    pub id: String,
    pub name: String,
    pub map_ids: Vec<String>,
    /// The ban/pick order, as the organiser arranged it.
    ///
    /// One step short of the pool's map count: every map but one is consumed,
    /// and the survivor is the decider.
    pub sequence: Vec<PoolStep>,
    pub best_of: Option<i32>,
    /// Whether players can see this pool. Publishing one also publishes every
    /// map in it, because a visible pool of invisible maps is a list of ids.
    pub published: bool,
    /// A scheduled reveal, in Unix seconds. Cleared once it fires, and ignored
    /// outright for a pool that is already out.
    pub publish_at: Option<u32>,
}

/// One step of a pool's ban/pick order.
///
/// Objects on the wire, not strings. Read as a flat list of names until a
/// recorded response showed otherwise, which silently emptied every sequence:
/// `lib/match.js::cleanSequence` keeps only `{action, team}` pairs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PoolStep {
    pub action: PoolAction,
    /// Which side takes the step. The service decides which team is A per
    /// match, from the pool's `abMode`.
    pub team: PoolSide,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PoolAction {
    #[default]
    Ban,
    Pick,
}

impl PoolAction {
    pub fn from_wire(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "pick" => Self::Pick,
            _ => Self::Ban,
        }
    }

    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Ban => "ban",
            Self::Pick => "pick",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PoolSide {
    #[default]
    A,
    B,
}

impl PoolSide {
    pub fn from_wire(raw: &str) -> Self {
        match raw.trim().to_ascii_uppercase().as_str() {
            "B" => Self::B,
            _ => Self::A,
        }
    }

    /// Upper case, and that is not cosmetic: `lib/match.js::cleanSequence`
    /// compares against `'A'` and `'B'` exactly and drops any step that matches
    /// neither, so a lower-case side loses the step without an error.
    pub fn as_wire(self) -> &'static str {
        match self {
            Self::A => "A",
            Self::B => "B",
        }
    }
}

/// A map pool as the organiser assembled it.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PoolDraft {
    /// Empty to create a new pool; an existing id replaces that pool.
    pub id: String,
    pub name: String,
    /// Map ids from the tournament's own map database, in play order.
    pub map_ids: Vec<String>,
    /// The series length this pool is built for. The server welds the ban/pick
    /// order to it, so a pool saved without one is a plain list of maps.
    pub best_of: Option<i32>,
    /// The ban/pick order. Either empty, or exactly one step short of the map
    /// count with `best_of - 1` picks among them: the service refuses anything
    /// else, naming the numbers it wanted.
    pub sequence: Vec<PoolStep>,
}

/// A map being added to or edited in a tournament's own map database.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MapDraft {
    /// Empty to add a new map; an existing id edits that one.
    pub id: String,
    pub name: String,
    pub description: String,
    pub published: bool,
}

impl MapDraft {
    /// Whether the service would accept it. It insists on a name and nothing
    /// else, so this is the whole rule.
    pub fn is_submittable(&self) -> bool {
        !self.name.trim().is_empty()
    }
}

impl PoolDraft {
    /// Why the service would refuse this pool.
    ///
    /// Its two rules read as arithmetic but are a real constraint: every map but
    /// one is consumed by a step, and every pick is a game, so a Bo3 needs four
    /// maps and three steps of which two are picks. Checked here because the
    /// refusal names numbers the organiser then has to work backwards from.
    pub fn rejection(&self) -> Option<PoolRejection> {
        if self.name.trim().is_empty() {
            return Some(PoolRejection::NameRequired);
        }
        if self.map_ids.is_empty() {
            return Some(PoolRejection::MapsRequired);
        }
        if self.sequence.is_empty() {
            // A pool without an order is legal: it is a plain list of maps.
            return None;
        }
        if self.sequence.len() != self.map_ids.len() - 1 {
            return Some(PoolRejection::StepCountWrong {
                wanted: self.map_ids.len() as i32 - 1,
                got: self.sequence.len() as i32,
            });
        }
        let picks = self
            .sequence
            .iter()
            .filter(|step| step.action == PoolAction::Pick)
            .count() as i32;
        let wanted = self.best_of.unwrap_or(1) - 1;
        if picks != wanted {
            return Some(PoolRejection::PickCountWrong { wanted, got: picks });
        }
        None
    }
}

/// Why a pool cannot be saved, in the order the service checks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PoolRejection {
    NameRequired,
    MapsRequired,
    #[serde(rename_all = "camelCase")]
    StepCountWrong {
        wanted: i32,
        got: i32,
    },
    #[serde(rename_all = "camelCase")]
    PickCountWrong {
        wanted: i32,
        got: i32,
    },
}

/// A map pool bound to a round.
///
/// A list rather than a map because the state crosses into TypeScript, where an
/// object with server-chosen keys is far more awkward to iterate than an array.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PoolAssignment {
    /// The server's own key for the round or stage.
    pub round: String,
    pub pool_id: String,
}
