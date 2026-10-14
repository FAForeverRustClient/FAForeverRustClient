//! The live replay tab's filters.

use super::*;

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LiveReplayFilters {
    pub search: String,
    pub game_type: String,
    pub featured_mod: String,
    pub active_players: String,
    pub max_players: String,
    pub hide_modded: bool,
    pub hide_single_player: bool,
    /// Hides the games the client can tell will rate nobody: an unranked map
    /// or a sim mod that is not on the ranked list. Lobby settings are not
    /// visible to any client, so this is the same question the game browser's
    /// own "Hide unranked" asks, and the same answer.
    ///
    /// `default` on this field alone rather than on the struct: a settings
    /// file written before this filter existed has every other key and not
    /// this one, and without it that whole object fails to parse and takes
    /// the reader's other filters with it. On the struct it would instead
    /// make every field optional in the generated bindings.
    #[serde(default)]
    pub hide_unranked: bool,
    pub friends_only: bool,
}

preference_patch! {
    /// A change to [`LiveReplayFilters`].
    LiveReplayFiltersPatch for LiveReplayFilters {
        search: String,
        game_type: String,
        featured_mod: String,
        active_players: String,
        max_players: String,
        hide_modded: bool,
        hide_single_player: bool,
        hide_unranked: bool,
        friends_only: bool,
    }
}

/// A comma-separated list of player counts, since the live replay filters
/// became multi-select (#326): each count is checked on its own, and one bad
/// entry drops only itself. Twin of `normalizePlayerCount` in
/// `ui/src/shared/browsingPreferences.ts`.
pub(super) fn normalize_player_count(value: String) -> String {
    let mut counts: Vec<String> = Vec::new();
    for part in value.split(',') {
        let part = part.trim();
        if part.is_empty() || !part.chars().all(|character| character.is_ascii_digit()) {
            continue;
        }
        let Some(count) = part
            .parse::<u8>()
            .ok()
            .filter(|count| (1..=64).contains(count))
        else {
            continue;
        };
        let count = count.to_string();
        if !counts.contains(&count) {
            counts.push(count);
        }
    }
    counts.join(",")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn player_count_filters_hold_a_list_and_drop_only_bad_entries() {
        assert_eq!(normalize_player_count("2, 04,abc,999,2".into()), "2,4");
        assert_eq!(normalize_player_count("04".into()), "4");
        assert_eq!(normalize_player_count("999".into()), "");
    }
}
