//! The client's ties to services outside it: Discord Rich Presence, and the
//! client's own updates.

use super::*;

/// Discord Rich Presence: what the client tells Discord you are doing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DiscordPreferences {
    /// Publish presence at all.
    ///
    /// The Java client has no such switch: its only off-switch is shipping
    /// without a configured application id, which no user can do. Presence
    /// broadcasts your game title and lobby to a third party, so it gets a
    /// real toggle here: defaulted on, matching Java's effective behaviour.
    pub enabled: bool,
    /// Withhold the join secret, so nobody can jump into your lobby from your
    /// Discord status. Java's `disallowJoinsViaDiscord`, and it gates both
    /// ends there too: the secret is never published, and an inbound join is
    /// refused even if someone still holds one.
    pub disallow_joins: bool,
}

impl Default for DiscordPreferences {
    fn default() -> Self {
        Self {
            enabled: true,
            disallow_joins: false,
        }
    }
}

// Same reason as `ChatPreferences`: an existing settings file has a complete
// `discord` object once written, and must gain later fields at their defaults
// rather than at `false`.
impl<'de> Deserialize<'de> for DiscordPreferences {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", default)]
        struct Wire {
            enabled: bool,
            disallow_joins: bool,
        }

        impl Default for Wire {
            fn default() -> Self {
                let defaults = DiscordPreferences::default();
                Self {
                    enabled: defaults.enabled,
                    disallow_joins: defaults.disallow_joins,
                }
            }
        }

        let wire = Wire::deserialize(deserializer)?;
        Ok(Self {
            enabled: wire.enabled,
            disallow_joins: wire.disallow_joins,
        })
    }
}

/// Client self-update: whether to look for a newer build, and which ones count.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePreferences {
    /// Announce an optional update: the banner, and the notification.
    ///
    /// This used to decide whether the startup check ran at all, which made
    /// the update the client insists on into something a checkbox could
    /// switch off. The check is therefore unconditional now and this governs
    /// only what is *said* about an update the user is free to postpone. An
    /// update the client requires ignores it, and so does the Settings status
    /// line, which is an answer to a button the user just pressed.
    ///
    /// The cost is the privacy affordance this switch used to carry: the
    /// startup check is an outbound request to GitHub, and it is no longer
    /// avoidable. Nothing else about it changed - it still goes to the release
    /// page alone, still sends nothing about the user, and is still the only
    /// request made before login.
    pub automatic: bool,
    /// Also offer prereleases. Java's `preReleaseCheckEnabled`, where it picks
    /// between two entirely separate check tasks.
    ///
    /// On by default: every release of this client so far has been published
    /// as a prerelease, so a client on the stable channel was never offered
    /// one. A settings file that already stores the choice keeps it.
    pub pre_release: bool,
    /// Show what changed, once, on the first start after the client was
    /// updated. See `whats_new_on_startup` in the client-update slice.
    pub show_whats_new: bool,
    /// The newest version whose What's new popup was dismissed, or that was
    /// recorded without one: a fresh install, a downgrade, the popup turned
    /// off. A fresh install is recorded as the settings load finds no file,
    /// so `None` is a settings file written before this existed, and reads as
    /// an update from an older build.
    ///
    /// Written when the popup is dismissed rather than when it opens, so a
    /// start that never got to show it (offline, notes not loaded) shows it
    /// again next time instead of losing it.
    pub last_seen_version: Option<String>,
}

impl Default for UpdatePreferences {
    fn default() -> Self {
        Self {
            automatic: true,
            pre_release: true,
            show_whats_new: true,
            last_seen_version: None,
        }
    }
}

impl UpdatePreferences {
    pub fn channel(&self) -> super::ReleaseChannel {
        if self.pre_release {
            super::ReleaseChannel::PreRelease
        } else {
            super::ReleaseChannel::Stable
        }
    }
}

// Same reason as `ChatPreferences` and `DiscordPreferences`: a settings file
// written before a field existed must gain it at its default, not at `false`,
// which here would silently switch update checks off for every existing user.
impl<'de> Deserialize<'de> for UpdatePreferences {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", default)]
        struct Wire {
            automatic: bool,
            pre_release: bool,
            show_whats_new: bool,
            last_seen_version: Option<String>,
        }

        impl Default for Wire {
            fn default() -> Self {
                let defaults = UpdatePreferences::default();
                Self {
                    automatic: defaults.automatic,
                    pre_release: defaults.pre_release,
                    show_whats_new: defaults.show_whats_new,
                    last_seen_version: defaults.last_seen_version,
                }
            }
        }

        let wire = Wire::deserialize(deserializer)?;
        Ok(Self {
            automatic: wire.automatic,
            pre_release: wire.pre_release,
            show_whats_new: wire.show_whats_new,
            last_seen_version: wire.last_seen_version,
        })
    }
}

preference_patch! {
    /// A change to [`DiscordPreferences`].
    DiscordPreferencesPatch for DiscordPreferences {
        enabled: bool,
        disallow_joins: bool,
    }
}

preference_patch! {
    /// A change to [`UpdatePreferences`].
    UpdatePreferencesPatch for UpdatePreferences {
        automatic: bool,
        pre_release: bool,
        show_whats_new: bool,
        last_seen_version: Option<String>,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_settings_file_from_before_whats_new_shows_it_and_has_seen_nothing() {
        // `None` is how the update to the build that starts recording this is
        // told apart: it reads as an update from an older build, so that
        // update shows the popup (a fresh install is recorded at load).
        let settings: SettingsState =
            serde_json::from_str(r#"{"updates":{"automatic":true,"preRelease":false}}"#).unwrap();
        assert!(settings.updates.show_whats_new);
        assert_eq!(settings.updates.last_seen_version, None);

        let patch: UpdatePreferencesPatch =
            serde_json::from_str(r#"{"lastSeenVersion":"0.4.0"}"#).unwrap();
        let updated = patch.apply_to(settings.updates.clone());
        assert_eq!(updated.last_seen_version.as_deref(), Some("0.4.0"));
        assert!(!updated.pre_release, "an untouched field is left alone");
    }

    #[test]
    fn a_settings_file_that_turned_rich_presence_off_keeps_it_off() {
        // The custom reader defaults every *absent* field, so the one field
        // the user actually set has to survive alongside the defaults.
        let settings: SettingsState =
            serde_json::from_str(r#"{"discord":{"enabled":false}}"#).unwrap();
        assert!(!settings.discord.enabled);
        assert!(!settings.discord.disallow_joins);
    }

    #[test]
    fn an_older_settings_file_keeps_update_checks_switched_on() {
        // The failure this guards against is silent: reading a missing group
        // as `false` would turn automatic update checks off for every user who
        // has ever saved a setting, and nothing would ever say so.
        let settings: SettingsState = serde_json::from_str(r#"{"theme":"forgeDark"}"#).unwrap();
        assert!(settings.updates.automatic);
        // Prereleases are offered by default, so a file without the group
        // gains that too.
        assert!(settings.updates.pre_release);
        assert_eq!(
            settings.updates.channel(),
            super::super::ReleaseChannel::PreRelease
        );
    }

    #[test]
    fn opting_into_prereleases_survives_a_reload_and_selects_the_channel() {
        let settings: SettingsState =
            serde_json::from_str(r#"{"updates":{"preRelease":true}}"#).unwrap();
        assert!(settings.updates.pre_release);
        assert!(
            settings.updates.automatic,
            "the absent field still defaults"
        );
        assert_eq!(
            settings.updates.channel(),
            super::super::ReleaseChannel::PreRelease
        );
    }
}
