//! The reducer — the entire mutation surface of the application.
//!
//! Pure, total, no IO, no async. Dispatches each [`AppEvent`] to the owning
//! slice reducer. To add a slice, add one match arm here (ARCHITECTURE.md §3.3).

use crate::state::{auth, lobby, nav, session, settings};
use crate::{AppEvent, AppState};

pub fn reduce(state: &mut AppState, event: &AppEvent) {
    match event {
        AppEvent::Session(e) => session::reduce(&mut state.session, e),
        AppEvent::Auth(e) => auth::reduce(&mut state.auth, e),
        AppEvent::Nav(e) => nav::reduce(&mut state.nav, e),
        AppEvent::Lobby(e) => lobby::reduce(&mut state.lobby, e),
        AppEvent::Settings(e) => settings::reduce(&mut state.settings, e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{ConnectionStatus, SessionEvent};

    #[test]
    fn routes_session_event_to_session_slice() {
        let mut state = AppState::default();
        reduce(
            &mut state,
            &SessionEvent::BackendReady {
                version: "9.9.9".into(),
            }
            .into(),
        );
        assert_eq!(state.session.status, ConnectionStatus::Connected);
        assert_eq!(state.session.backend_version, "9.9.9");
    }
}
