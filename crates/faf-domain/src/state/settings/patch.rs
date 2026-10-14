//! Preference patches: the change a settings section sends for one group,
//! naming only the fields it touched. Every group's `Patch` type is declared
//! with the macro here, beside the group it changes.

use super::*;

/// Serde glue for one field of a preference patch.
///
/// A patch has to tell "leave this alone" from "set this to nothing", because
/// some preferences are themselves optional: clearing the cache lifetime is
/// `cacheLifetimeDays: null`, and that must not read as "unchanged". Plain
/// `Option<Option<T>>` cannot say it, since serde reads `null` as the outer
/// `None`. So a field that is present at all, `null` included, is `Some`, and
/// only a missing one falls back to the `#[serde(default)]` of `None`.
///
/// Writing a patch back out is the mirror image, and is done by hand in
/// `preference_patch!` rather than derived: an untouched field has to be left
/// out, not written as `null`, or the patch would read back as one that
/// clears it. `skip_serializing_if` would say that, but the bindings exporter
/// cannot represent a field that is only sometimes written, so the derive is
/// not available here.
pub(super) fn patch_field<'de, T: Deserialize<'de>, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}

/// serde's `rename_all = "camelCase"` for one field name, for the hand-written
/// `Serialize` of a patch. `use_24_hour_time` is `use24HourTime` either way.
pub(super) fn camel_case(snake: &str) -> String {
    let mut out = String::with_capacity(snake.len());
    let mut upper = false;
    for character in snake.chars() {
        if character == '_' {
            upper = true;
        } else if upper {
            out.extend(character.to_uppercase());
            upper = false;
        } else {
            out.push(character);
        }
    }
    out
}

/// Declare the patch type for one preference group.
///
/// Every control used to send its whole group, assembled from the snapshot the
/// webview last saw, and the service replaced the group with it. Two changes
/// inside one round trip therefore each carried the *old* value of the other
/// field, and the second reverted the first. A patch names only what changed
/// and is merged into the authoritative group in the backend, so it cannot
/// carry a stale copy of anything it did not mean to touch.
///
/// Plain fields are replaced when present. `nested` fields are groups of their
/// own and take a patch of their own, so changing one column width does not
/// rewrite the filter rules beside it. Lists and maps are replaced whole: they
/// are one value each, and the controls that edit them own all of it.
///
/// [`apply_to`] destructures the group without `..` on purpose. A field added
/// to the group and forgotten here is a compile error rather than a preference
/// no patch can reach.
///
/// [`apply_to`]: GeneralPreferencesPatch::apply_to
macro_rules! preference_patch {
    (
        $(#[$meta:meta])*
        $patch:ident for $base:ident {
            $($field:ident: $ty:ty),* $(,)?
        }
        $(nested { $($nested:ident: $nested_patch:ident),* $(,)? })?
    ) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, Default, Deserialize, Type)]
        #[serde(rename_all = "camelCase")]
        pub struct $patch {
            $(
                #[serde(default, deserialize_with = "patch_field")]
                #[specta(type = $ty)]
                pub $field: Option<$ty>,
            )*
            $($(
                #[serde(default)]
                #[specta(type = $nested_patch)]
                pub $nested: Option<$nested_patch>,
            )*)?
        }

        impl Serialize for $patch {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                use serde::ser::SerializeMap;
                let mut map = serializer.serialize_map(None)?;
                $(if let Some(value) = &self.$field {
                    map.serialize_entry(&camel_case(stringify!($field)), value)?;
                })*
                $($(if let Some(value) = &self.$nested {
                    map.serialize_entry(&camel_case(stringify!($nested)), value)?;
                })*)?
                map.end()
            }
        }

        impl $patch {
            /// `base` with every field this patch names replaced, and every
            /// other one exactly as it was. Not normalised: the caller does
            /// that once the whole group is merged, because several bounds
            /// depend on more than one field.
            pub fn apply_to(self, base: $base) -> $base {
                let $base { $($field,)* $($($nested,)*)? } = base;
                $base {
                    $($field: self.$field.unwrap_or($field),)*
                    $($($nested: match self.$nested {
                        Some(patch) => patch.apply_to($nested),
                        None => $nested,
                    },)*)?
                }
            }
        }

        /// A patch naming every field: the whole group, for the rare caller
        /// that really does mean to replace all of it.
        impl From<$base> for $patch {
            fn from(base: $base) -> Self {
                let $base { $($field,)* $($($nested,)*)? } = base;
                Self {
                    $($field: Some($field),)*
                    $($($nested: Some($nested.into()),)*)?
                }
            }
        }
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_patches_merged_one_after_another_keep_each_others_fields() {
        // The race in miniature: two patches built from the same snapshot,
        // applied in turn. Whole groups would have the second undo the first.
        let first: BrowsingPreferencesPatch =
            serde_json::from_str(r#"{"favoriteMaps":["gap"]}"#).unwrap();
        let second: BrowsingPreferencesPatch =
            serde_json::from_str(r#"{"vaultPageSize":48,"hostGame":{"title":"4v4"}}"#).unwrap();

        let merged = second.apply_to(first.apply_to(BrowsingPreferences::default()));
        assert_eq!(merged.favorite_maps, ["gap"]);
        assert_eq!(merged.vault_page_size, 48);
        assert_eq!(merged.host_game.title, "4v4");
        // A nested patch leaves the rest of its own group alone.
        assert_eq!(
            merged.host_game.featured_mod,
            HostGamePreferences::default().featured_mod
        );
        assert_eq!(
            merged.custom_games_browser,
            CustomGameBrowserPreferences::default()
        );
    }

    #[test]
    fn a_patch_tells_an_absent_field_from_a_null_one() {
        let base = GamePreferences {
            cache_lifetime_days: Some(30),
            cache_size_alert_gb: Some(40),
            ..GamePreferences::default()
        };
        // Absent: unchanged. `null`: the optional preference cleared.
        let patch: GamePreferencesPatch =
            serde_json::from_str(r#"{"cacheSizeAlertGb":null}"#).unwrap();
        let merged = patch.apply_to(base);
        assert_eq!(merged.cache_lifetime_days, Some(30));
        assert_eq!(merged.cache_size_alert_gb, None);

        // A `null` for a preference that cannot be empty is a broken command,
        // not a silent no-op.
        assert!(serde_json::from_str::<GamePreferencesPatch>(r#"{"steamPresence":null}"#).is_err());
    }

    #[test]
    fn a_patch_round_trips_with_untouched_fields_left_out() {
        let patch = ChatPreferencesPatch {
            use_24_hour_time: Some(true),
            name_colors: Some(ChatNameColorsPatch {
                self_color: Some("#112233".into()),
                ..ChatNameColorsPatch::default()
            }),
            ..ChatPreferencesPatch::default()
        };
        let json = serde_json::to_value(&patch).unwrap();
        // The same spelling serde gives the group itself.
        assert_eq!(
            json,
            serde_json::json!({"use24HourTime": true, "nameColors": {"selfColor": "#112233"}})
        );
        assert_eq!(
            serde_json::from_value::<ChatPreferencesPatch>(json).unwrap(),
            patch
        );

        let game = GamePreferencesPatch {
            cache_lifetime_days: Some(None),
            ..GamePreferencesPatch::default()
        };
        let json = serde_json::to_value(&game).unwrap();
        assert_eq!(json, serde_json::json!({"cacheLifetimeDays": null}));
        assert_eq!(
            serde_json::from_value::<GamePreferencesPatch>(json).unwrap(),
            game
        );
    }

    #[test]
    fn a_whole_group_converts_to_a_patch_that_reproduces_it() {
        let chat = ChatPreferences {
            font_size: 15,
            muted_players: vec!["Foe".into()],
            ..ChatPreferences::default()
        };
        let patch: ChatPreferencesPatch = chat.clone().into();
        let mut other = ChatPreferences::default();
        other.show_timestamps = !other.show_timestamps;
        assert_eq!(patch.apply_to(other), chat);
    }
}
