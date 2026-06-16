//! In-memory settings store for tests and offline runs — no disk IO.

use async_trait::async_trait;
use faf_domain::state::SettingsState;

use crate::ports::SettingsPort;

/// Returns a fixed [`SettingsState`] on load; `save` is a no-op.
#[derive(Debug, Clone, Default)]
pub struct FakeSettings {
    pub initial: SettingsState,
}

#[async_trait]
impl SettingsPort for FakeSettings {
    async fn load(&self) -> SettingsState {
        self.initial.clone()
    }

    async fn save(&self, _settings: &SettingsState) {}
}
