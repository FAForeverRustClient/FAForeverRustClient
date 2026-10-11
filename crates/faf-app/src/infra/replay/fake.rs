//! The offline replay client.
//!
//! Separate from the real one because it shares nothing with it but the port:
//! no IO, no state, and canned answers for the views that still have to render.

use std::path::PathBuf;

use async_trait::async_trait;
use faf_domain::state::{
    LiveReplayTarget, LocalReplay, ReplayChatMessage, ReplayCommandStats, ReplayDetails,
    ReplayGameOption, ReplayQuery,
};

use crate::ports::replay::VaultSearchResult;
use crate::ports::{ReplayDetailsPort, ReplayLibraryPort, ReplayPlaybackPort, ReplayVaultPort};

/// Inert replay client: used offline and in tests, for all four replay ports.
/// Every call fails cleanly (mirrors [`crate::infra::FakeGame`]'s posture: no
/// game installed, no IO).
#[derive(Debug, Clone, Default)]
pub struct FakeReplay;

#[async_trait]
impl ReplayPlaybackPort for FakeReplay {
    async fn watch_live(
        &self,
        _target: LiveReplayTarget,
        _player: String,
    ) -> Result<Option<String>, String> {
        Err("replay watching is unavailable in offline mode".to_string())
    }

    async fn play_file(&self, _path: PathBuf) -> Result<Option<String>, String> {
        Err("replay playback is unavailable in offline mode".to_string())
    }

    async fn watch_vault(&self, _uid: i32) -> Result<Option<String>, String> {
        Err("no game install configured: set it in Settings → Paths".to_string())
    }

    fn set_install_dir(&self, _dir: Option<PathBuf>) {}
}

#[async_trait]
impl ReplayVaultPort for FakeReplay {
    async fn search_vault(&self, _query: ReplayQuery) -> Result<VaultSearchResult, String> {
        Ok(VaultSearchResult::default())
    }

    async fn list_featured_mods(&self) -> Result<Vec<String>, String> {
        // The well-known set, so the offline path still exercises the filter.
        Ok(["faf", "ladder1v1", "coop", "fafbeta", "nomads"]
            .map(String::from)
            .to_vec())
    }

    async fn download_vault(&self, _uid: i32) -> Result<LocalReplay, String> {
        Err("replay downloading is unavailable in offline mode".to_string())
    }
}

#[async_trait]
impl ReplayDetailsPort for FakeReplay {
    async fn load_details(
        &self,
        _uid: i32,
        _local_path: Option<PathBuf>,
    ) -> Result<ReplayDetails, String> {
        Ok(ReplayDetails {
            game_options: vec![
                ReplayGameOption {
                    key: "FAF Version".to_string(),
                    value: "3837".to_string(),
                },
                ReplayGameOption {
                    key: "AllowObservers".to_string(),
                    value: "true".to_string(),
                },
                ReplayGameOption {
                    key: "AutoTeams".to_string(),
                    value: "tvsb".to_string(),
                },
                ReplayGameOption {
                    key: "CheatsEnabled".to_string(),
                    value: "false".to_string(),
                },
                ReplayGameOption {
                    key: "UnitCap".to_string(),
                    value: "1000".to_string(),
                },
            ],
            chat_messages: vec![
                ReplayChatMessage {
                    time_seconds: 13,
                    sender: "Downlord".to_string(),
                    message: "gl hf".to_string(),
                    to: "all".to_string(),
                },
                ReplayChatMessage {
                    time_seconds: 599,
                    sender: "Nojoke".to_string(),
                    message: "gg".to_string(),
                    to: "allies".to_string(),
                },
            ],
            command_stats: vec![
                ReplayCommandStats {
                    player: "Downlord".to_string(),
                    commands: 1_240,
                },
                ReplayCommandStats {
                    player: "Nojoke".to_string(),
                    commands: 980,
                },
            ],
            sim_seconds: 600,
            sim_mods: vec!["No Rush Timer".to_string()],
            game_version: Some(3837),
        })
    }

    async fn load_analysis(
        &self,
        uid: i32,
        _local_path: Option<PathBuf>,
    ) -> Result<faf_domain::state::ReplayAnalysis, String> {
        Ok(faf_domain::state::ReplayAnalysis {
            uid,
            ticks: 6_000,
            game_version: "Supreme Commander v1.50.3839".to_string(),
            ..Default::default()
        })
    }
}

#[async_trait]
impl ReplayLibraryPort for FakeReplay {
    async fn list_local(&self, _limit: usize) -> Result<Vec<LocalReplay>, String> {
        Ok(Vec::new())
    }

    async fn delete_local(&self, _path: PathBuf) -> Result<(), String> {
        Err("local replay deletion is disabled".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn fake_replay_fails_cleanly() {
        let fake = FakeReplay;
        let target = LiveReplayTarget {
            uid: 1,
            mod_name: "faf".into(),
            map: "scmp_007".into(),
        };
        assert!(fake.watch_live(target, "spectator".into()).await.is_err());
        assert!(fake.play_file(PathBuf::from("x.fafreplay")).await.is_err());
    }
}
