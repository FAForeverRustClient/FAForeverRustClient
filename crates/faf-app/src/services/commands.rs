//! Service-owned work is claimed before the executor can poll another command.
//! The runtime schedules the resulting work without knowing feature variants.
use super::{replays, unit_history};
use crate::runtime::{request_order::ReadIntent, EventSink, ServiceCtx};
use faf_domain::{
    state::{ReplayCommand, UnitHistoryCommand},
    AppCommand,
};

pub(crate) enum PreparedCommand {
    Dispatch(Box<AppCommand>),
    Analysis(Option<replays::AnalysisWork>),
    Details(replays::DetailsWork),
    UnitSelection(unit_history::SelectionWork),
}

pub(crate) fn prepare(command: AppCommand, ctx: &ServiceCtx, out: &EventSink) -> PreparedCommand {
    match command {
        AppCommand::Replays(ReplayCommand::LoadAnalysis {
            uid,
            local_path,
            request_id,
        }) => PreparedCommand::Analysis(replays::begin_analysis(
            uid, local_path, request_id, ctx, out,
        )),
        AppCommand::Replays(ReplayCommand::LoadDetails {
            uid,
            local_path,
            request_id,
        }) => PreparedCommand::Details(replays::begin_details(
            uid, local_path, request_id, ctx, out,
        )),
        AppCommand::UnitHistory(UnitHistoryCommand::Select { id }) => {
            PreparedCommand::UnitSelection(unit_history::begin_selection(vec![id], ctx, out))
        }
        AppCommand::UnitHistory(UnitHistoryCommand::SetSelection { ids }) => {
            PreparedCommand::UnitSelection(unit_history::begin_selection(ids, ctx, out))
        }
        command => PreparedCommand::Dispatch(Box::new(command)),
    }
}

impl PreparedCommand {
    pub(crate) async fn run(self, ctx: &ServiceCtx, out: &EventSink) {
        match self {
            Self::Dispatch(command) => crate::runtime::dispatch(*command, ctx, out).await,
            Self::Analysis(Some(work)) => replays::run_analysis(work, ctx, out).await,
            Self::Analysis(None) => {}
            Self::Details(work) => replays::run_details(work, ctx, out).await,
            Self::UnitSelection(work) => unit_history::run_selection(work, ctx, out).await,
        }
    }
}

/// Features declare their replaceable read lanes and cancellation identities.
/// These are operational metadata, never part of the wire command format.
pub(crate) fn read_intent(command: &AppCommand) -> Option<ReadIntent> {
    use faf_domain::state::replay_read_key;
    match command {
        AppCommand::Replays(ReplayCommand::LoadAnalysis {
            uid,
            local_path,
            request_id,
        }) => Some(ReadIntent::Start {
            lane: "replay-analysis",
            key: replay_read_key(*uid, local_path.as_deref()),
            request_id: *request_id,
        }),
        AppCommand::Replays(ReplayCommand::LoadDetails {
            uid,
            local_path,
            request_id,
        }) => Some(ReadIntent::Start {
            lane: "replay-details",
            key: replay_read_key(*uid, local_path.as_deref()),
            request_id: *request_id,
        }),
        AppCommand::Replays(ReplayCommand::CancelReads {
            uid,
            local_path,
            request_id,
        }) => Some(ReadIntent::Cancel {
            lanes: &["replay-analysis", "replay-details"],
            key: replay_read_key(*uid, local_path.as_deref()),
            request_id: *request_id,
        }),
        _ => None,
    }
}
