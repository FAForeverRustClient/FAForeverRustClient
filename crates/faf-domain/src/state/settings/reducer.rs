//! The slice's reducer.

use super::*;

pub fn reduce(state: &mut SettingsState, event: &SettingsEvent) {
    match event {
        SettingsEvent::Loaded { settings } => *state = settings.as_ref().clone(),
        SettingsEvent::ThemeChanged { theme } => state.theme = *theme,
        SettingsEvent::GamePathChanged { path } => state.game_path = path.clone(),
        SettingsEvent::ReplayGamePathChanged { path } => state.replay_game_path = path.clone(),
        // Normalised here rather than trusting the emitter: a path pasted
        // with a trailing space resolves to nothing, and the state is the
        // last place that can still be true regardless of who wrote it.
        SettingsEvent::PathsChanged { preferences } => {
            state.paths = preferences.clone().normalized()
        }
        SettingsEvent::KeptGeneratedMaps { map_names } => {
            for name in map_names {
                let name = name.trim();
                if name.is_empty()
                    || state
                        .kept_generated_maps
                        .iter()
                        .any(|kept| kept.eq_ignore_ascii_case(name))
                {
                    continue;
                }
                state.kept_generated_maps.push(name.to_owned());
            }
            // Oldest first, so the cap makes this a cache rather than a quota
            // that starts refusing maps once it is full. Which names fell off
            // is the caller's business: the service compares the list either
            // side of this event and deletes the folders, because a name that
            // is merely unprotected still occupies the disk it was capped to
            // protect.
            state.trim_kept_generated_maps();
        }
        SettingsEvent::MatchmakerVetoesChanged { vetoes } => {
            state.matchmaker_vetoes = vetoes.clone()
        }
        SettingsEvent::MapPoolsSeen { seen } => state.map_pools_seen = seen.clone(),
        SettingsEvent::AvatarHistoryChanged { history } => state.avatar_history = history.clone(),
        SettingsEvent::GeneralChanged { preferences } => state.general = preferences.clone(),
        SettingsEvent::AppearanceChanged { preferences } => {
            state.appearance = preferences.clone().normalized()
        }
        SettingsEvent::SocialChanged { preferences } => {
            state.social = preferences.clone().normalized()
        }
        SettingsEvent::NotificationsChanged { preferences } => {
            state.notifications = preferences.clone()
        }
        SettingsEvent::ChatChanged { preferences } => state.chat = preferences.as_ref().clone(),
        SettingsEvent::GameChanged { preferences } => state.game = preferences.clone(),
        SettingsEvent::DiscordChanged { preferences } => state.discord = *preferences,
        SettingsEvent::ConnectivityChanged { preferences } => state.connectivity = *preferences,
        SettingsEvent::DebugChanged { preferences } => state.debug = *preferences,
        SettingsEvent::UpdatesChanged { preferences } => state.updates = preferences.clone(),
        SettingsEvent::BrowsingChanged { preferences } => {
            state.browsing = preferences.as_ref().clone().normalized()
        }
        SettingsEvent::MapGeneratorChanged { preferences } => {
            state.map_generator = preferences.as_ref().clone()
        }
        SettingsEvent::EventsChanged { preferences } => {
            state.events = preferences.as_ref().clone().pruned(0)
        }
        SettingsEvent::CacheInfoUpdated { info } => {
            state.cache_info = info.clone();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_veto_selection_replaces_the_last_one_rather_than_joining_it() {
        // The opposite of `KeptGeneratedMaps`, deliberately: this is one whole
        // selection as the server holds it, so removing a veto has to be able
        // to remove it, and clearing them all has to clear them all.
        let mut settings = SettingsState::default();
        let veto = |map: i32, tokens: i32| PlayerVeto {
            matchmaker_queue_map_pool_id: 4,
            map_pool_map_version_id: map,
            veto_tokens_applied: tokens,
        };

        reduce(
            &mut settings,
            &SettingsEvent::MatchmakerVetoesChanged {
                vetoes: vec![veto(91, 2), veto(92, 1)],
            },
        );
        assert_eq!(settings.matchmaker_vetoes.len(), 2);

        // The shape of a server correction: a pool shrank, so one veto is
        // capped and the other is gone.
        reduce(
            &mut settings,
            &SettingsEvent::MatchmakerVetoesChanged {
                vetoes: vec![veto(91, 1)],
            },
        );
        assert_eq!(settings.matchmaker_vetoes, vec![veto(91, 1)]);

        reduce(
            &mut settings,
            &SettingsEvent::MatchmakerVetoesChanged { vetoes: Vec::new() },
        );
        assert!(settings.matchmaker_vetoes.is_empty());
    }
}
