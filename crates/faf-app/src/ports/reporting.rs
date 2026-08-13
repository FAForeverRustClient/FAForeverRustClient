use async_trait::async_trait;
use faf_domain::state::ModerationReportSummary;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReportPlayerRequest {
    pub reporter_id: i32,
    pub reported_player_id: i32,
    pub description: String,
    pub game_id: Option<i32>,
    pub incident_time: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GameParticipation {
    GameNotFound,
    PlayerAbsent,
    PlayerPresent,
}

#[async_trait]
pub trait ReportingPort: Send + Sync {
    async fn submit(&self, request: ReportPlayerRequest) -> Result<(), String>;
    async fn history(&self, reporter_id: i32) -> Result<Vec<ModerationReportSummary>, String>;
    async fn game_participation(
        &self,
        game_id: i32,
        player_id: i32,
    ) -> Result<GameParticipation, String>;
}
