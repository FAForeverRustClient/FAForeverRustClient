use std::{path::PathBuf, sync::Arc, time::Duration};

use async_trait::async_trait;
use faf_app::{infra::fake_ports, ports::ReplayDetailsPort, App};
use faf_domain::state::{ReplayAnalysis, ReplayCommand, ReplayDetails};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

type Call = (
    CancellationToken,
    oneshot::Sender<Result<ReplayAnalysis, String>>,
);
struct HeldAnalysis(mpsc::UnboundedSender<Call>);

#[async_trait]
impl ReplayDetailsPort for HeldAnalysis {
    async fn load_details(&self, _: i32, _: Option<PathBuf>) -> Result<ReplayDetails, String> {
        unreachable!("details are not requested")
    }
    async fn load_analysis(&self, _: i32, _: Option<PathBuf>) -> Result<ReplayAnalysis, String> {
        unreachable!("the service must use the cancellable port")
    }
    async fn load_analysis_cancellable(
        &self,
        _: i32,
        _: Option<PathBuf>,
        cancel: CancellationToken,
    ) -> Result<ReplayAnalysis, String> {
        let (answer, wait) = oneshot::channel();
        self.0.send((cancel, answer)).unwrap();
        wait.await.unwrap()
    }
}

#[tokio::test]
async fn superseding_and_closing_analysis_cancel_only_the_owned_request() {
    let (calls, mut entered) = mpsc::unbounded_channel();
    let mut ports = fake_ports();
    ports.replay_details = Arc::new(HeldAnalysis(calls));
    let (app, app_loop) = App::new("test", ports);
    let runtime = tokio::spawn(app_loop.run());
    let load = |request_id| ReplayCommand::LoadAnalysis {
        uid: 7,
        local_path: None,
        request_id: Some(request_id),
    };
    let cancel = |request_id| ReplayCommand::CancelReads {
        uid: 7,
        local_path: None,
        request_id: Some(request_id),
    };

    app.dispatch(load(1).into()).await.unwrap();
    let (first, first_answer) = tokio::time::timeout(Duration::from_secs(2), entered.recv())
        .await
        .unwrap()
        .unwrap();
    app.dispatch(load(2).into()).await.unwrap();
    let (second, second_answer) = tokio::time::timeout(Duration::from_secs(2), entered.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(
        first.is_cancelled(),
        "superseding work reaches the parser token"
    );
    // A stale answer cannot replace the same UID's newer request.
    let _ = first_answer.send(Ok(ReplayAnalysis {
        uid: 7,
        ticks: 1,
        ..Default::default()
    }));
    app.dispatch_and_wait(cancel(1).into()).await.unwrap();
    assert!(
        !second.is_cancelled(),
        "a late close belongs to the older panel"
    );
    assert_eq!(
        app.snapshot().replays.analysis_loading,
        Some("uid:7".into())
    );
    app.dispatch_and_wait(cancel(2).into()).await.unwrap();
    assert!(second.is_cancelled());
    assert_eq!(app.snapshot().replays.analysis_loading, None);
    assert!(app.snapshot().replays.analysis_error.is_none());
    let _ = second_answer.send(Err("stale failure".into()));

    app.dispatch(load(3).into()).await.unwrap();
    let (_, answer) = tokio::time::timeout(Duration::from_secs(2), entered.recv())
        .await
        .unwrap()
        .unwrap();
    answer
        .send(Ok(ReplayAnalysis {
            uid: 7,
            ticks: 3,
            ..Default::default()
        }))
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while app
            .snapshot()
            .replays
            .analysis
            .as_ref()
            .map(|analysis| analysis.ticks)
            != Some(3)
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(app.snapshot().replays.analysis_error.is_none());
    runtime.abort();
}
