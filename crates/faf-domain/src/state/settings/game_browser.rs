//! The custom game browser: how it is sorted, what it hides, its filter
//! rules, and the layout of its list view and detail panel.

use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum CustomGameSort {
    #[default]
    Players,
    Rating,
    Map,
    Host,
    Age,
    /// The lobby's own title, which is the list's first column and was the one
    /// thing it could not be ordered by.
    Title,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum CustomGameFilterField {
    TitleOrMap,
    Title,
    Host,
    Map,
    Mod,
    Rating,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum CustomGameFilterConstraint {
    Contains,
    Starts,
    Ends,
    Equals,
    NotEquals,
    Above,
    Below,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CustomGameFilterRule {
    pub field: CustomGameFilterField,
    pub constraint: CustomGameFilterConstraint,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CustomGameBrowserPreferences {
    pub sort: CustomGameSort,
    /// The order against the sorted column's own, rather than a direction.
    ///
    /// `false` is what every column has always done: the most players first,
    /// the highest rating first, the newest lobby first, maps and hosts and
    /// titles from A to Z. Storing "reversed" rather than "descending" is what
    /// lets one flag serve six columns whose natural orders disagree, and it
    /// is also why a settings file written before this existed reads back as
    /// exactly the order it had.
    pub sort_reversed: bool,
    pub hide_private: bool,
    pub hide_modded: bool,
    pub hide_unranked: bool,
    pub hide_foes: bool,
    pub apply_filters: bool,
    pub rules: Vec<CustomGameFilterRule>,
    /// The other direction from `rules`: a game matching any of these stays
    /// in the list whatever the hide switches and the rules say (#593). The
    /// same builder, so "always show games with mod X" is one rule rather
    /// than a list per field. Not a filter in `FilterMemory`'s sense, since
    /// it narrows nothing, so `without_filters` leaves it as it is. Holds the
    /// former always-shown hosts as `Host equals` rules.
    pub allow_rules: Vec<CustomGameFilterRule>,
    /// Pixel widths of the list view's columns, left to right.
    ///
    /// Empty means "the stylesheet decides", which is both the default and
    /// what a reset goes back to. A short list is padded the same way: a
    /// column the user never dragged keeps its designed width rather than
    /// collapsing because a neighbour was resized.
    pub column_widths: Vec<u32>,
    /// The list view's columns in the order they are drawn, as indexes into
    /// the designed order (game, tags, map, players, rating, age).
    ///
    /// Empty means the designed order, which is the default and what a file
    /// written before columns could be moved reads back as. Anything that is
    /// not exactly one of each column is dropped to empty rather than
    /// repaired: a half-valid order has no obvious meaning.
    pub column_order: Vec<u32>,
    /// Pixel width of the detail panel beside the game list, or `0` for the
    /// designed default.
    ///
    /// The tiles already resize (`gameTileColumns`); the panel beside them did
    /// not, so a wider preview could only be had by making the browser
    /// narrower and nothing offered that trade.
    pub detail_width: u32,
    /// Whether the detail panel is folded away (#370, #377).
    ///
    /// Kept apart from `detail_width` so folding it and unfolding it again
    /// brings back the width somebody dragged it to, rather than the default.
    pub detail_hidden: bool,
}

impl<'de> Deserialize<'de> for CustomGameBrowserPreferences {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Default, Deserialize)]
        #[serde(rename_all = "camelCase", default)]
        struct Wire {
            sort: CustomGameSort,
            sort_reversed: bool,
            hide_private: bool,
            hide_modded: bool,
            hide_unranked: bool,
            hide_foes: bool,
            apply_filters: bool,
            rules: Vec<CustomGameFilterRule>,
            allow_rules: Vec<CustomGameFilterRule>,
            column_widths: Vec<u32>,
            column_order: Vec<u32>,
            detail_width: u32,
            detail_hidden: bool,
        }

        let wire = Wire::deserialize(deserializer)?;
        Ok(Self {
            sort: wire.sort,
            sort_reversed: wire.sort_reversed,
            hide_private: wire.hide_private,
            hide_modded: wire.hide_modded,
            hide_unranked: wire.hide_unranked,
            hide_foes: wire.hide_foes,
            apply_filters: wire.apply_filters,
            rules: wire.rules,
            allow_rules: wire.allow_rules,
            column_widths: wire.column_widths,
            column_order: wire.column_order,
            detail_width: wire.detail_width,
            detail_hidden: wire.detail_hidden,
        })
    }
}

impl CustomGameBrowserPreferences {
    pub(super) fn normalized(mut self) -> Self {
        self.rules = normalize_rules(self.rules);
        self.allow_rules = normalize_rules(self.allow_rules);
        // A settings file is a file, so every bound here is against a corrupt
        // or hand-edited one rather than against anything a drag can produce.
        // Count only. There is no bound left to put on a width: a column is
        // dragged to whatever anybody wants it to be, there is no ceiling, and
        // a `u32` that is not zero is already at least one pixel. Zero keeps
        // meaning "no width stored, use the designed one".
        self.column_widths.truncate(MAX_BROWSER_COLUMNS);
        let mut sorted = self.column_order.clone();
        sorted.sort_unstable();
        if !sorted.iter().copied().eq(0..MAX_BROWSER_COLUMNS as u32) {
            self.column_order.clear();
        }
        if self.detail_width != 0 {
            self.detail_width = self.detail_width.clamp(MIN_DETAIL_PX, MAX_DETAIL_PX);
        }
        self
    }
}

/// A rule list as stored: trimmed, empty values and repeats dropped, at most
/// 64 rules.
pub(super) fn normalize_rules(candidates: Vec<CustomGameFilterRule>) -> Vec<CustomGameFilterRule> {
    let mut rules: Vec<CustomGameFilterRule> = Vec::new();
    for mut rule in candidates {
        rule.value = truncate_trimmed(rule.value, 128);
        if rule.value.is_empty()
            || rules.iter().any(|existing| {
                existing.field == rule.field
                    && existing.constraint == rule.constraint
                    && existing.value.eq_ignore_ascii_case(&rule.value)
            })
        {
            continue;
        }
        rules.push(rule);
        if rules.len() == 64 {
            break;
        }
    }
    rules
}

/// The list view has six columns, and a saved width past these bounds is a
/// column that cannot be dragged back into view.
pub const MAX_BROWSER_COLUMNS: usize = 6;

/// The detail panel's bounds. The floor is where the map preview stops being
/// a preview; the ceiling leaves the game list usable on a small window.
pub const MIN_DETAIL_PX: u32 = 220;
pub const MAX_DETAIL_PX: u32 = 720;

preference_patch! {
    /// A change to [`CustomGameBrowserPreferences`].
    CustomGameBrowserPreferencesPatch for CustomGameBrowserPreferences {
        sort: CustomGameSort,
        sort_reversed: bool,
        hide_private: bool,
        hide_modded: bool,
        hide_unranked: bool,
        hide_foes: bool,
        apply_filters: bool,
        rules: Vec<CustomGameFilterRule>,
        allow_rules: Vec<CustomGameFilterRule>,
        column_widths: Vec<u32>,
        column_order: Vec<u32>,
        detail_width: u32,
        detail_hidden: bool,
    }
}
