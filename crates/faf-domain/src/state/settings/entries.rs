//! Changes to one entry of a list or map: a star, a mute, a name colour, a
//! saved mod set. Each is worked out against the settings as the backend holds
//! them, never against a copy the webview last saw.

use super::*;

/// The string lists the webview changes one entry at a time: a star, a mute,
/// a collapsed roster category, a chip.
///
/// They get their own command, [`SettingsCommand::SetListMember`], rather than
/// a `Patch*` field, because a patch replaces the whole list and the webview
/// can only build that list from its last snapshot. Two stars inside one round
/// trip sent `[A]` and then `[B]`, and only B survived. Naming the one entry
/// and whether it belongs lets the service apply it to the list as the backend
/// holds it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PreferenceList {
    /// `browsing.favorite_maps`, by map folder name.
    FavoriteMaps,
    /// `browsing.favorite_mods`, by mod uid.
    FavoriteMods,
    /// `browsing.whitelisted_hosts`, by login.
    WhitelistedHosts,
    /// `browsing.leaderboard_rating_columns`.
    LeaderboardRatingColumns,
    /// `chat.muted_players`, by login.
    MutedPlayers,
    /// `chat.hidden_roster_categories`.
    HiddenRosterCategories,
    /// `chat.auto_join_channels`.
    AutoJoinChannels,
}

/// The same entry, whatever case or padding an older client stored it in. Every
/// list behind [`PreferenceList`] already treats entries this way when it is
/// normalised, so matching any looser or stricter would leave a duplicate the
/// normalisation then silently resolves the other way.
fn same_entry(left: &str, right: &str) -> bool {
    left.trim().to_lowercase() == right.trim().to_lowercase()
}

/// `value` added to (`member`) or removed from `list`, normalised as a whole.
///
/// An entry already present is left where it is rather than moved to the end,
/// so starring something twice does not reorder anybody's favourites.
fn with_member(mut list: Vec<String>, value: &str, member: bool) -> Vec<String> {
    let value = value.trim();
    if value.is_empty() {
        return list;
    }
    let present = list.iter().any(|entry| same_entry(entry, value));
    if member && !present {
        list.push(value.to_owned());
    } else if !member {
        list.retain(|entry| !same_entry(entry, value));
    }
    list
}

/// The event that adds `value` to or removes it from one list, worked out
/// against `settings` as they are now and normalised like any other write to
/// the group.
pub fn list_member_changed(
    settings: &SettingsState,
    list: PreferenceList,
    value: &str,
    member: bool,
) -> SettingsEvent {
    let mut next = settings.clone();
    match list {
        PreferenceList::FavoriteMaps => {
            next.browsing.favorite_maps = with_member(next.browsing.favorite_maps, value, member)
        }
        PreferenceList::FavoriteMods => {
            next.browsing.favorite_mods = with_member(next.browsing.favorite_mods, value, member)
        }
        PreferenceList::WhitelistedHosts => {
            next.browsing.whitelisted_hosts =
                with_member(next.browsing.whitelisted_hosts, value, member)
        }
        PreferenceList::LeaderboardRatingColumns => {
            next.browsing.leaderboard_rating_columns =
                with_member(next.browsing.leaderboard_rating_columns, value, member)
        }
        PreferenceList::MutedPlayers => {
            next.chat.muted_players = with_member(next.chat.muted_players, value, member)
        }
        PreferenceList::HiddenRosterCategories => {
            next.chat.hidden_roster_categories =
                with_member(next.chat.hidden_roster_categories, value, member)
        }
        PreferenceList::AutoJoinChannels => {
            next.chat.auto_join_channels = with_member(next.chat.auto_join_channels, value, member)
        }
    }
    let next = next.normalized();
    match list {
        PreferenceList::FavoriteMaps
        | PreferenceList::FavoriteMods
        | PreferenceList::WhitelistedHosts
        | PreferenceList::LeaderboardRatingColumns => SettingsEvent::BrowsingChanged {
            preferences: Box::new(next.browsing),
        },
        PreferenceList::MutedPlayers
        | PreferenceList::HiddenRosterCategories
        | PreferenceList::AutoJoinChannels => SettingsEvent::ChatChanged {
            preferences: Box::new(next.chat),
        },
    }
}

/// The event that gives one player's name a colour, or (`None`) takes it away.
///
/// Any entry for the same login in another case goes first: the map is keyed
/// by the spelling it was assigned under, and two spellings of one player would
/// leave which colour wins to the map's ordering.
pub fn player_name_color_changed(
    settings: &SettingsState,
    player: &str,
    color: Option<&str>,
) -> SettingsEvent {
    let mut next = settings.clone();
    let player = player.trim();
    if !player.is_empty() {
        let players = &mut next.chat.name_colors.players;
        players.retain(|existing, _| !same_entry(existing, player));
        if let Some(color) = color {
            players.insert(player.to_owned(), color.to_owned());
        }
    }
    SettingsEvent::ChatChanged {
        preferences: Box::new(next.normalized().chat),
    }
}

/// The event that saves one mod preset, replacing the one of the same name in
/// place (so a row of preset buttons does not reorder on every save) or adding
/// it at the end.
pub fn mod_preset_saved(settings: &SettingsState, preset: ModPreset) -> SettingsEvent {
    let mut next = settings.clone();
    let presets = &mut next.browsing.mod_presets;
    match presets
        .iter_mut()
        .find(|existing| same_entry(&existing.name, &preset.name))
    {
        Some(existing) => *existing = preset,
        None => presets.push(preset),
    }
    SettingsEvent::BrowsingChanged {
        preferences: Box::new(next.normalized().browsing),
    }
}

/// The event that deletes the mod preset called `name`.
pub fn mod_preset_deleted(settings: &SettingsState, name: &str) -> SettingsEvent {
    let mut next = settings.clone();
    next.browsing
        .mod_presets
        .retain(|preset| !same_entry(&preset.name, name));
    SettingsEvent::BrowsingChanged {
        preferences: Box::new(next.normalized().browsing),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Apply one element change the way the reducer would, so each assertion
    /// reads the state a second change would be applied to.
    fn applied(mut settings: SettingsState, event: SettingsEvent) -> SettingsState {
        reduce(&mut settings, &event);
        settings
    }

    #[test]
    fn list_members_are_added_and_removed_one_at_a_time() {
        let settings = SettingsState::default();
        let settings = applied(
            settings.clone(),
            list_member_changed(&settings, PreferenceList::FavoriteMaps, "Gap.v0001", true),
        );
        let settings = applied(
            settings.clone(),
            list_member_changed(&settings, PreferenceList::FavoriteMaps, "dawn.v0003", true),
        );
        // The second star kept the first: this is the whole point.
        assert_eq!(settings.browsing.favorite_maps, ["gap.v0001", "dawn.v0003"]);

        // A star in another case is the same map, so nothing moves.
        let again = applied(
            settings.clone(),
            list_member_changed(&settings, PreferenceList::FavoriteMaps, "GAP.v0001", true),
        );
        assert_eq!(
            again.browsing.favorite_maps,
            settings.browsing.favorite_maps
        );

        // Removal matches any spelling an older client stored.
        let removed = applied(
            settings.clone(),
            list_member_changed(
                &settings,
                PreferenceList::FavoriteMaps,
                " GAP.V0001 ",
                false,
            ),
        );
        assert_eq!(removed.browsing.favorite_maps, ["dawn.v0003"]);
    }

    #[test]
    fn whitelisted_hosts_keep_their_spelling_and_take_members_one_at_a_time() {
        let settings = SettingsState::default();
        let settings = applied(
            settings.clone(),
            list_member_changed(
                &settings,
                PreferenceList::WhitelistedHosts,
                " Nuggets ",
                true,
            ),
        );
        let settings = applied(
            settings.clone(),
            list_member_changed(&settings, PreferenceList::WhitelistedHosts, "aurora", true),
        );
        // A login keeps its case, unlike a map folder, and the list is sorted.
        assert_eq!(settings.browsing.whitelisted_hosts, ["aurora", "Nuggets"]);

        // The same host in another case is not added twice.
        let again = applied(
            settings.clone(),
            list_member_changed(&settings, PreferenceList::WhitelistedHosts, "NUGGETS", true),
        );
        assert_eq!(again.browsing.whitelisted_hosts, ["aurora", "Nuggets"]);

        let removed = applied(
            settings.clone(),
            list_member_changed(
                &settings,
                PreferenceList::WhitelistedHosts,
                "nuggets",
                false,
            ),
        );
        assert_eq!(removed.browsing.whitelisted_hosts, ["aurora"]);
    }

    #[test]
    fn chat_lists_take_members_and_stay_normalised() {
        let mut settings = SettingsState::default();
        settings.chat.muted_players = vec!["Zed".into()];
        let settings = applied(
            settings.clone(),
            list_member_changed(&settings, PreferenceList::MutedPlayers, "aurora", true),
        );
        // Muted players are kept sorted by the group's own normalisation.
        assert_eq!(settings.chat.muted_players, ["aurora", "Zed"]);
        let settings = applied(
            settings.clone(),
            list_member_changed(&settings, PreferenceList::MutedPlayers, "zed", false),
        );
        assert_eq!(settings.chat.muted_players, ["aurora"]);

        let settings = applied(
            settings.clone(),
            list_member_changed(
                &settings,
                PreferenceList::HiddenRosterCategories,
                "ircOnly",
                true,
            ),
        );
        assert_eq!(settings.chat.hidden_roster_categories, ["ircOnly"]);
        // A blank value is not an entry.
        let unchanged = applied(
            settings.clone(),
            list_member_changed(&settings, PreferenceList::AutoJoinChannels, "  ", true),
        );
        assert_eq!(unchanged.chat, settings.chat);
    }

    #[test]
    fn a_player_colour_replaces_every_spelling_of_that_login() {
        let mut settings = SettingsState::default();
        settings.chat.name_colors.players = BTreeMap::from([
            ("Aurora".into(), "#112233".into()),
            ("Bo".into(), "#445566".into()),
        ]);
        let next = applied(
            settings.clone(),
            player_name_color_changed(&settings, "aurora", Some("#ABCDEF")),
        );
        assert_eq!(
            next.chat.name_colors.players,
            BTreeMap::from([
                ("Bo".into(), "#445566".into()),
                ("aurora".into(), "#abcdef".into())
            ])
        );
        let cleared = applied(
            next.clone(),
            player_name_color_changed(&next, "AURORA", None),
        );
        assert_eq!(
            cleared.chat.name_colors.players,
            BTreeMap::from([("Bo".into(), "#445566".into())])
        );
    }

    #[test]
    fn a_saved_mod_preset_replaces_its_namesake_in_place() {
        let mut settings = SettingsState::default();
        settings.browsing.mod_presets = vec![
            ModPreset {
                name: "Replay".into(),
                uids: vec!["a".into()],
            },
            ModPreset {
                name: "Team".into(),
                uids: vec!["b".into()],
            },
        ];
        let next = applied(
            settings.clone(),
            mod_preset_saved(
                &settings,
                ModPreset {
                    name: "replay".into(),
                    uids: vec!["c".into()],
                },
            ),
        );
        let names: Vec<_> = next.browsing.mod_presets.iter().map(|p| &p.name).collect();
        assert_eq!(names, ["replay", "Team"], "same slot, not moved to the end");
        assert_eq!(next.browsing.mod_presets[0].uids, ["c"]);

        let next = applied(next.clone(), mod_preset_deleted(&next, "TEAM"));
        assert_eq!(next.browsing.mod_presets.len(), 1);
    }
}
