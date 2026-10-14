//! The host dialog's remembered form, kept once for custom games and once
//! for co-op.

use super::*;

/// Last successfully submitted custom-game form. Both reference clients retain
/// these values so reopening Host is a continuation rather than a reset.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HostGamePreferences {
    pub title: String,
    pub featured_mod: String,
    pub visibility: String,
    pub map: String,
    pub password_enabled: bool,
    pub password: String,
    pub enforce_rating_range: bool,
    /// `None` is an open end: no lower bound, "Any" in the field. A range
    /// could be typed but never taken away again, because the field put the
    /// last number back when it was emptied.
    pub rating_min: Option<i32>,
    /// `None` is an open end, as for [`Self::rating_min`].
    pub rating_max: Option<i32>,
}

impl<'de> Deserialize<'de> for HostGamePreferences {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", default)]
        struct Wire {
            title: String,
            featured_mod: String,
            visibility: String,
            map: String,
            password_enabled: bool,
            password: String,
            enforce_rating_range: bool,
            rating_min: Option<i32>,
            rating_max: Option<i32>,
        }

        impl Default for Wire {
            fn default() -> Self {
                let defaults = HostGamePreferences::default();
                Self {
                    title: defaults.title,
                    featured_mod: defaults.featured_mod,
                    visibility: defaults.visibility,
                    map: defaults.map,
                    password_enabled: defaults.password_enabled,
                    password: defaults.password,
                    enforce_rating_range: defaults.enforce_rating_range,
                    rating_min: defaults.rating_min,
                    rating_max: defaults.rating_max,
                }
            }
        }

        let wire = Wire::deserialize(deserializer)?;
        Ok(Self {
            title: wire.title,
            featured_mod: wire.featured_mod,
            visibility: wire.visibility,
            map: wire.map,
            password_enabled: wire.password_enabled,
            password: wire.password,
            enforce_rating_range: wire.enforce_rating_range,
            rating_min: wire.rating_min,
            rating_max: wire.rating_max,
        })
    }
}

impl Default for HostGamePreferences {
    fn default() -> Self {
        Self {
            title: String::new(),
            featured_mod: "faf".into(),
            visibility: "public".into(),
            map: String::new(),
            password_enabled: false,
            password: String::new(),
            enforce_rating_range: false,
            rating_min: Some(800),
            rating_max: Some(1_500),
        }
    }
}

impl HostGamePreferences {
    pub(super) fn normalized(mut self) -> Self {
        // The host dialog's own limit, so a remembered title never seeds the
        // form with one the backend would refuse to host.
        self.title = truncate_trimmed(self.title, super::lobby::HostGameConfig::MAX_TITLE_CHARS);
        self.featured_mod = truncate_trimmed(self.featured_mod, 128);
        if self.featured_mod.is_empty() {
            self.featured_mod = "faf".into();
        }
        self.visibility = match self.visibility.trim().to_ascii_lowercase().as_str() {
            "friends" => "friends".into(),
            _ => "public".into(),
        };
        self.map = truncate_trimmed(self.map, 256);
        self.password = self.password.chars().take(25).collect();
        self.rating_min = self.rating_min.map(|rating| rating.clamp(-9_999, 9_999));
        self.rating_max = self.rating_max.map(|rating| rating.clamp(-9_999, 9_999));
        if let (Some(min), Some(max)) = (self.rating_min, self.rating_max) {
            if min > max {
                self.rating_min = Some(max);
                self.rating_max = Some(min);
            }
        }
        self
    }
}

preference_patch! {
    /// A change to [`HostGamePreferences`]. Either rating bound may be `null`,
    /// which is an open end rather than "unchanged".
    HostGamePreferencesPatch for HostGamePreferences {
        title: String,
        featured_mod: String,
        visibility: String,
        map: String,
        password_enabled: bool,
        password: String,
        enforce_rating_range: bool,
        rating_min: Option<i32>,
        rating_max: Option<i32>,
    }
}
