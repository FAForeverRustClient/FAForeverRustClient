//! In-memory settings store for tests and offline runs: no disk IO.

use async_trait::async_trait;
use faf_domain::state::SettingsState;

use crate::ports::SettingsPort;

/// Returns a fixed [`SettingsState`] on load, as a settings file holding it
/// would: always found, so never a first start. `save` is a no-op that
/// succeeds.
#[derive(Debug, Clone, Default)]
pub struct FakeSettings {
    pub initial: SettingsState,
}

#[async_trait]
impl SettingsPort for FakeSettings {
    async fn load(&self) -> Option<SettingsState> {
        Some(self.initial.clone())
    }

    async fn save(&self, _settings: &SettingsState) -> Result<(), String> {
        Ok(())
    }
}
