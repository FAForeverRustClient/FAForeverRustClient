//! How the client looks: the theme, the density and zoom of the interface,
//! the sidebar, the hover panels and the picture behind it all.

use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Theme {
    #[default]
    ForgeDark,
    ForgeLight,
    JavaClient,
    PythonClient,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum UiDensity {
    Compact,
    #[default]
    Comfortable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AppearancePreferences {
    pub density: UiDensity,
    pub reduce_motion: bool,
    /// Whole-interface zoom, as a percentage. Applied by the shell as a real
    /// webview zoom rather than a CSS transform, so layout, hit testing and
    /// `window.innerWidth` all stay in one coordinate space.
    ///
    /// This client's dimensions are in CSS pixels throughout, so on a large
    /// high-resolution display running at 100% desktop scaling every control is
    /// physically tiny. Neither reference client offers this (the Java client
    /// zooms only its chat), but neither is a fixed-pixel web UI.
    ///
    /// Settings files written before this existed still load: see the `Wire`
    /// reader below, which is how every other preference block in this module
    /// gains a field without making the generated IPC type optional.
    pub ui_scale: u16,
    /// Number of columns to render in the custom games tile browser.
    /// `0` means automatic / responsive (adapting dynamically to window width).
    /// `1..=6` specifies a fixed column count.
    pub game_tile_columns: u8,
    /// Width of the sidebar in pixels, remembered across restarts.
    ///
    /// The window's own geometry has been persisted for a while; the panel
    /// inside it was not, so every start put it back at 224 px. Clamped on the
    /// way in, because a settings file is a file somebody can edit.
    pub sidebar_width: u16,
    /// Whether the detail panels that appear on hover are shown at all.
    ///
    /// Off leaves every list's own row intact and simply never opens the
    /// overlay. Reported by people who move the pointer across the game list on
    /// the way to somewhere else and collect four or five panels doing it.
    pub hover_panels: bool,
    /// How long the pointer has to rest on something before its hover panel
    /// opens, in milliseconds.
    ///
    /// Zero is the behaviour this client shipped with: the panel is up before
    /// the pointer has stopped, which is what made crossing the list expensive.
    /// A second was tried and drew the opposite complaint, so this is a
    /// preference rather than a better constant.
    ///
    /// The delay applies to the *first* panel only: once one is open, moving to
    /// another opens it at once, so a delay long enough to stop accidents does
    /// not also make browsing slow.
    pub hover_open_delay_ms: u16,
    /// How long a hover panel survives the pointer leaving it, in milliseconds.
    ///
    /// Not merely symmetry with [`Self::hover_open_delay_ms`]: the panels are
    /// interactive, so reaching one means crossing the gap between the row and
    /// the panel, and a zero here makes everything in them unclickable.
    pub hover_close_delay_ms: u16,
    /// Whether players' flags are drawn in replay lineups (#328).
    ///
    /// Off by default: the lineup already carries a faction, a rating and a
    /// result per player, and a flag is mostly wanted by people preparing a
    /// cast. The country comes from the replay file itself, and for an online
    /// replay from players who are online right now, which is all the API
    /// offers: it has no country for an account.
    pub replay_flags: bool,
    /// The picture behind the interface, as the name it was stored under in
    /// the client's `backgrounds` folder (#439). Empty is the theme's own
    /// background.
    pub background_image: String,
    /// How far the picture is darkened under the interface, in percent, so
    /// text stays readable over a bright one. Clamped to `0..=90`.
    pub background_dim: u8,
}

// A field-level `#[serde(default)]` would have been shorter, but specta turns
// it into an *optional* TS property, and the field is never actually absent in
// a serialized snapshot. That would push a `?? 100` onto every use site to
// satisfy a case that cannot happen.
impl<'de> Deserialize<'de> for AppearancePreferences {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", default)]
        struct Wire {
            density: UiDensity,
            reduce_motion: bool,
            ui_scale: u16,
            game_tile_columns: u8,
            sidebar_width: u16,
            hover_panels: bool,
            hover_open_delay_ms: u16,
            hover_close_delay_ms: u16,
            replay_flags: bool,
            background_image: String,
            background_dim: u8,
        }

        impl Default for Wire {
            fn default() -> Self {
                let defaults = AppearancePreferences::default();
                Self {
                    density: defaults.density,
                    reduce_motion: defaults.reduce_motion,
                    ui_scale: defaults.ui_scale,
                    game_tile_columns: defaults.game_tile_columns,
                    sidebar_width: defaults.sidebar_width,
                    hover_panels: defaults.hover_panels,
                    hover_open_delay_ms: defaults.hover_open_delay_ms,
                    hover_close_delay_ms: defaults.hover_close_delay_ms,
                    replay_flags: defaults.replay_flags,
                    background_image: defaults.background_image,
                    background_dim: defaults.background_dim,
                }
            }
        }

        let wire = Wire::deserialize(deserializer)?;
        Ok(Self {
            density: wire.density,
            reduce_motion: wire.reduce_motion,
            ui_scale: wire.ui_scale,
            game_tile_columns: wire.game_tile_columns.min(6),
            sidebar_width: wire
                .sidebar_width
                .clamp(MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH),
            hover_panels: wire.hover_panels,
            hover_open_delay_ms: wire.hover_open_delay_ms.min(MAX_HOVER_DELAY_MS),
            hover_close_delay_ms: wire.hover_close_delay_ms.min(MAX_HOVER_DELAY_MS),
            replay_flags: wire.replay_flags,
            background_image: wire.background_image,
            background_dim: wire.background_dim.min(MAX_BACKGROUND_DIM),
        })
    }
}

/// 100% means "one CSS pixel per desktop pixel", matching the desktop's own
/// scaling rather than second-guessing it.
fn default_ui_scale() -> u16 {
    100
}

/// Bounds for [`AppearancePreferences::ui_scale`]. Below the minimum text stops
/// being legible; above the maximum the narrowest supported layout no longer
/// fits, and the sidebar starts colliding with content.
pub const MIN_UI_SCALE: u16 = 80;
pub const MAX_UI_SCALE: u16 = 200;

/// How narrow the sidebar may be dragged, and how wide.
///
/// The floor used to be 176 px, which is a sidebar with the labels still in it
/// and a lot of empty space to their right: shrinking it did not buy anything.
/// 64 px is the icon rail the client already draws when the *window* is narrow,
/// so the two ways of arriving at it look the same.
pub const MIN_SIDEBAR_WIDTH: u16 = 64;
pub const MAX_SIDEBAR_WIDTH: u16 = 400;
/// Below this the labels come off. Well clear of both ends, so neither dragging
/// slightly off the default nor pulling all the way in is ambiguous.
pub const SIDEBAR_RAIL_BELOW: u16 = 150;

/// The longest either hover delay may be set to.
///
/// A ceiling rather than a list, because the settings file is a file somebody
/// can edit and a panel that takes a minute to appear reads as one that is
/// broken. The tab itself offers a handful of steps inside this range.
pub const MAX_HOVER_DELAY_MS: u16 = 2000;

impl Default for AppearancePreferences {
    fn default() -> Self {
        Self {
            density: UiDensity::Comfortable,
            reduce_motion: false,
            ui_scale: default_ui_scale(),
            game_tile_columns: 0,
            sidebar_width: 224,
            hover_panels: true,
            // Long enough that crossing the list on the way somewhere else does
            // not open anything, short enough to feel like an answer rather
            // than a wait. Zero was the old behaviour and is still available;
            // so is a full second, which is what this was before and what drew
            // the complaint in the other direction.
            hover_open_delay_ms: 500,
            // The gap between a row and its panel is about six pixels, which a
            // pointer crosses in well under 50 ms. A sixth of a second covers
            // that without the panel trailing the pointer down the list.
            hover_close_delay_ms: 160,
            replay_flags: false,
            background_image: String::new(),
            // Enough that the interface's own surfaces read as surfaces over a
            // busy picture; the slider goes either way.
            background_dim: 60,
        }
    }
}

/// The most a background may be darkened. Past this it is a black screen.
pub const MAX_BACKGROUND_DIM: u8 = 90;

impl AppearancePreferences {
    pub fn normalized(mut self) -> Self {
        self.ui_scale = self.ui_scale.clamp(MIN_UI_SCALE, MAX_UI_SCALE);
        self.game_tile_columns = self.game_tile_columns.min(6);
        self.sidebar_width = self
            .sidebar_width
            .clamp(MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH);
        self.hover_open_delay_ms = self.hover_open_delay_ms.min(MAX_HOVER_DELAY_MS);
        self.hover_close_delay_ms = self.hover_close_delay_ms.min(MAX_HOVER_DELAY_MS);
        self.background_dim = self.background_dim.min(MAX_BACKGROUND_DIM);
        self
    }
}

preference_patch! {
    /// A change to [`AppearancePreferences`].
    AppearancePreferencesPatch for AppearancePreferences {
        density: UiDensity,
        reduce_motion: bool,
        ui_scale: u16,
        game_tile_columns: u8,
        sidebar_width: u16,
        hover_panels: bool,
        hover_open_delay_ms: u16,
        hover_close_delay_ms: u16,
        replay_flags: bool,
        background_image: String,
        background_dim: u8,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn game_tile_columns_defaults_to_auto_and_is_bounded() {
        let default_pref = AppearancePreferences::default();
        assert_eq!(default_pref.game_tile_columns, 0);

        let parsed: AppearancePreferences =
            serde_json::from_str(r#"{"density":"compact","reduceMotion":true,"uiScale":125}"#)
                .unwrap();
        assert_eq!(parsed.game_tile_columns, 0);

        let parsed_with_cols: AppearancePreferences = serde_json::from_str(
            r#"{"density":"compact","reduceMotion":true,"uiScale":125,"gameTileColumns":4}"#,
        )
        .unwrap();
        assert_eq!(parsed_with_cols.game_tile_columns, 4);

        let parsed_exceeding: AppearancePreferences = serde_json::from_str(
            r#"{"density":"compact","reduceMotion":true,"uiScale":125,"gameTileColumns":99}"#,
        )
        .unwrap();
        assert_eq!(parsed_exceeding.game_tile_columns, 6);
    }
}
