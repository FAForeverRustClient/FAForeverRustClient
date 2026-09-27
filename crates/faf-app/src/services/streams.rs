//! Live-stream orchestration: look, and say so once.
//!
//! Two jobs, and the second one is the feature.
//!
//! 1. **Look.** One command, handled by one port call. The links tab sends it
//!    when it opens so the badge is right without waiting for a tick.
//!
//! 2. **Announce.** A ticker, because a channel going live is the one thing here
//!    that happens while the player is looking at something else. State-driven,
//!    like the calendar's reminders and the Discord presence: "this broadcast is
//!    live and has not been announced" is a property of the snapshot, and
//!    rebuilding it from a stream of deltas would only add ways to announce
//!    twice or not at all.
//!
//! The ticker does not start when the port cannot answer. A build with no Twitch
//! credentials would otherwise run a timer that makes no request every few
//! minutes for the life of the process.

use std::sync::Arc;
use std::time::Duration;

use faf_domain::state::{
    LiveStream, NotificationAction, NotificationKind, StreamsCommand, StreamsEvent,
};

use crate::runtime::{EventSink, ServiceCtx};
use crate::services;

pub async fn handle(cmd: StreamsCommand, ctx: &ServiceCtx, out: &EventSink) {
    match cmd {
        StreamsCommand::Check => check(ctx, out).await,
    }
}

/// Ask the port once, and announce anything new.
async fn check(ctx: &ServiceCtx, out: &EventSink) {
    if !ctx.ports.streams.can_check() {
        return;
    }
    out.emit(StreamsEvent::Checking);
    match ctx.ports.streams.list_live().await {
        Ok(streams) => {
            out.emit(StreamsEvent::Loaded { streams });
            announce(out);
        }
        // Logged rather than notified. Nobody asked to be told that a poll they
        // never started failed; the slice records it so the links tab can stop
        // claiming a channel is live on stale information.
        Err(reason) => {
            tracing::debug!(%reason, "could not check whether FAF is live");
            out.emit(StreamsEvent::LoadFailed { reason });
        }
    }
}

/// Raise one notification per broadcast not yet announced.
///
/// Reads the post-reduce slice through the sink rather than the list that just
/// arrived, because "which of these is new" is a question about the state, and
/// the state is where the answer is kept.
fn announce(out: &EventSink) {
    let (wanted, new): (bool, Vec<LiveStream>) = out.with_state(|state| {
        (
            state.settings.notifications.stream_live,
            state
                .streams
                .unannounced()
                .into_iter()
                .cloned()
                .collect::<Vec<_>>(),
        )
    });
    if new.is_empty() {
        return;
    }

    // The ids are recorded whether or not anything is said. Turning the switch
    // back on must not produce a backlog of announcements about streams that
    // were running while it was off.
    out.emit(StreamsEvent::Announced {
        stream_ids: new.iter().map(|stream| stream.id.clone()).collect(),
    });
    if !wanted {
        return;
    }

    for stream in &new {
        services::notifications::add(
            out,
            NotificationKind::StreamLive,
            title(stream),
            body(stream),
            Some(NotificationAction::OpenStream {
                url: stream.url.clone(),
            }),
        );
    }
}

/// The notification's title: "FAF Live: " and the stream's own title (#155).
///
/// The broadcaster's words rather than the client's, because they are the only
/// thing that says whether this is a grand final or somebody testing their
/// encoder. A stream with no title is just "FAF Live". Which platform it is on
/// is the icon the card carries, not a word in the title.
fn title(stream: &LiveStream) -> String {
    let title = stream.title.trim();
    if title.is_empty() {
        "FAF Live".to_string()
    } else {
        format!("FAF Live: {title}")
    }
}

/// What the notification says under the title: how many are watching, when
/// the platform said, and where.
fn body(stream: &LiveStream) -> String {
    match stream.viewers {
        Some(viewers) => format!("{viewers} watching on {}.", stream.platform.label()),
        None => format!("Live on {}.", stream.platform.label()),
    }
}

/// How often the ticker looks.
///
/// Five minutes. A stream runs for hours, so nothing is lost by hearing about it
/// a few minutes in, and Twitch's rate limit is per application rather than per
/// client: every FAF client sharing one set of credentials makes this a number
/// worth being conservative about.
const TICK: Duration = Duration::from_secs(5 * 60);

/// Start the ticker. Called once from the runtime loop; lives for the process.
pub fn spawn(ctx: Arc<ServiceCtx>, sink: EventSink) {
    if !ctx.ports.streams.can_check() {
        return;
    }
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(TICK);
        loop {
            ticker.tick().await;
            check(&ctx, &sink).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use faf_domain::state::StreamPlatform;

    fn stream(title: &str, viewers: Option<i32>) -> LiveStream {
        LiveStream {
            id: "twitch:1".into(),
            platform: StreamPlatform::Twitch,
            channel: "faflive".into(),
            display_name: "FAFLive".into(),
            title: title.into(),
            url: "https://www.twitch.tv/faflive".into(),
            viewers,
            started_at: String::new(),
        }
    }

    #[test]
    fn the_broadcasters_own_title_follows_faf_live() {
        assert_eq!(
            title(&stream("Setons Summer Slam: Grand Final", Some(412))),
            "FAF Live: Setons Summer Slam: Grand Final",
        );
        assert_eq!(
            body(&stream("Setons Summer Slam: Grand Final", Some(412))),
            "412 watching on Twitch.",
        );
        assert_eq!(body(&stream("Ladder night", None)), "Live on Twitch.");
    }

    #[test]
    fn a_stream_with_no_title_still_says_something() {
        assert_eq!(title(&stream("   ", None)), "FAF Live");
    }
}
