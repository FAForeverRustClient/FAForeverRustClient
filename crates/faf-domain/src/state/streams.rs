//! Streams slice: whether FAF's own channels are broadcasting right now.
//!
//! FAF has a Twitch channel that carries the tournaments and a YouTube channel
//! beside it, and until now the client's only relationship with either was a
//! row in the external links list. The request was for the client to say when
//! one of them goes live, the way a launcher says it: promotion of the thing the
//! client is a client for.
//!
//! Three decisions shape what is here, and the first two come straight from the
//! thread the request was made in.
//!
//! **It announces; it does not take the screen.** No strip across the top, no
//! indicator in the sidebar. A channel going live raises one notification, which
//! is the client's existing non-interrupting channel for "something happened
//! while you were looking elsewhere", and the External links tab marks the
//! channel live while it is. That is the whole surface. A stream is worth
//! knowing about and worth nobody's game being interrupted for, which is also
//! why [`crate::state::NotificationKind::StreamLive`] is not on the list of
//! kinds that reach the operating system.
//!
//! **It can be turned off.** One switch among the other notification kinds, on
//! by default, because somebody who does not watch FAF streams should not have
//! to read about them and should not have to hunt for the switch either.
//!
//! **A stream is identified, not just counted.** The platform's own id for the
//! broadcast is what decides whether this is news: a channel that has been live
//! for three hours is not an announcement every time the client looks, and a
//! second stream on the same day is. [`StreamsState::unannounced`] is that
//! question, asked of the current state rather than of a stream of deltas, which
//! is the same shape the calendar's reminders and the Discord presence use.
//!
//! What is deliberately *not* here is any knowledge of how "live" is discovered.
//! Twitch answers it only for an application with its own credentials, so the
//! port may legitimately answer "nothing is live" forever on a build that has
//! none: see `infra::streams`. That is a deployment fact, and a slice that held
//! an opinion about it would be holding an opinion about somebody's environment.

use serde::{Deserialize, Serialize};
use specta::Type;

/// Which service a broadcast is on.
///
/// An enum rather than a string because the UI picks an icon and a word from it,
/// and because "twitch" spelled two ways would be two platforms.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum StreamPlatform {
    #[default]
    Twitch,
    YouTube,
}

impl StreamPlatform {
    /// What to call it in a sentence the client composes.
    pub fn label(self) -> &'static str {
        match self {
            StreamPlatform::Twitch => "Twitch",
            StreamPlatform::YouTube => "YouTube",
        }
    }
}

/// One broadcast that is live now.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LiveStream {
    /// The platform's id for *this broadcast*, not for the channel.
    ///
    /// The difference is the whole announcement rule: a channel id is the same
    /// every time and would make the first announcement the only one, while a
    /// broadcast id changes when somebody starts streaming again.
    pub id: String,
    pub platform: StreamPlatform,
    /// The channel's login, e.g. `faflive`. Lower case, as the platform gives
    /// it.
    pub channel: String,
    /// The channel's display name, which differs from the login in case and
    /// sometimes in script. Falls back to the login when the platform gives
    /// none.
    pub display_name: String,
    /// The stream's title, as the broadcaster set it. Shown as-is.
    pub title: String,
    /// Where to watch. Always the channel page rather than a player URL: a
    /// client that is not a browser should hand the viewer to one.
    pub url: String,
    /// Concurrent viewers, or `None` when the platform did not say.
    pub viewers: Option<i32>,
    /// RFC 3339, as the platform reports it. Empty when unknown.
    #[serde(default)]
    pub started_at: String,
}

/// Whether the last look succeeded.
///
/// `Idle` covers both "not asked yet" and "this build cannot ask", and those are
/// deliberately the same state: neither is a failure, and neither is worth a
/// message in the links list. A real failure is kept because a channel that
/// silently stops being marked live would otherwise be indistinguishable from a
/// channel that is off air.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum StreamsStatus {
    #[default]
    Idle,
    Checking,
    Ready,
    Failed {
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StreamsState {
    /// Everything live right now, in the order the port reported it.
    pub live: Vec<LiveStream>,
    pub status: StreamsStatus,
    /// Broadcast ids already announced this session.
    ///
    /// Not persisted. A client started while a stream is running announces it
    /// once, which is right: to that client it is news, and the alternative is
    /// remembering forever which broadcasts a machine has been told about.
    pub announced: Vec<String>,
}

/// How many announced ids are kept.
///
/// Only enough to outlive the streams they belong to. An id is dropped once it
/// has not been live for a while, which a list this short does by being a list.
pub const MAX_ANNOUNCED: usize = 64;

impl StreamsState {
    /// The live streams that have not been announced yet.
    ///
    /// Asked of the state rather than worked out while events go past, for the
    /// same reason the calendar's reminders are: "has this been announced" is a
    /// property of the snapshot, and rebuilding it from deltas only adds ways to
    /// announce twice or not at all.
    pub fn unannounced(&self) -> Vec<&LiveStream> {
        self.live
            .iter()
            .filter(|stream| !self.announced.iter().any(|id| id == &stream.id))
            .collect()
    }

    /// Whether a named channel is broadcasting, for the links list.
    ///
    /// Matched case-insensitively on the login, because the links list spells
    /// the channel the way a human wrote it into a URL.
    pub fn live_channel(&self, channel: &str) -> Option<&LiveStream> {
        self.live
            .iter()
            .find(|stream| stream.channel.eq_ignore_ascii_case(channel.trim()))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    content = "payload",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum StreamsEvent {
    Checking,
    Loaded {
        streams: Vec<LiveStream>,
    },
    LoadFailed {
        reason: String,
    },
    /// These broadcasts have been announced and must not be again.
    Announced {
        stream_ids: Vec<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(
    tag = "type",
    content = "payload",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum StreamsCommand {
    /// Look once. Sent by the ticker, and by the links tab when it opens so the
    /// badge is right without waiting for the next tick.
    Check,
}

pub fn reduce(state: &mut StreamsState, event: &StreamsEvent) {
    match event {
        StreamsEvent::Checking => state.status = StreamsStatus::Checking,
        StreamsEvent::Loaded { streams } => {
            state.live = streams.clone();
            state.status = StreamsStatus::Ready;
        }
        // The list is kept. A failed check is "we do not know any more", and
        // dropping a stream that is almost certainly still running would take
        // the badge off a live channel on one bad request.
        StreamsEvent::LoadFailed { reason } => {
            state.status = StreamsStatus::Failed {
                reason: reason.clone(),
            }
        }
        StreamsEvent::Announced { stream_ids } => {
            for id in stream_ids {
                if !state.announced.iter().any(|held| held == id) {
                    state.announced.push(id.clone());
                }
            }
            if state.announced.len() > MAX_ANNOUNCED {
                let excess = state.announced.len() - MAX_ANNOUNCED;
                state.announced.drain(..excess);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stream(id: &str, channel: &str) -> LiveStream {
        LiveStream {
            id: id.into(),
            platform: StreamPlatform::Twitch,
            channel: channel.into(),
            display_name: channel.into(),
            title: "FAF tournament".into(),
            url: format!("https://www.twitch.tv/{channel}"),
            viewers: Some(120),
            started_at: "2026-09-11T18:00:00Z".into(),
        }
    }

    #[test]
    fn nothing_is_live_and_nothing_has_been_asked_by_default() {
        let state = StreamsState::default();
        assert_eq!(state.status, StreamsStatus::Idle);
        assert!(state.live.is_empty());
        assert!(state.unannounced().is_empty());
        assert!(state.live_channel("faflive").is_none());
    }

    #[test]
    fn a_check_replaces_the_whole_list() {
        let mut state = StreamsState::default();
        reduce(&mut state, &StreamsEvent::Checking);
        assert_eq!(state.status, StreamsStatus::Checking);

        reduce(
            &mut state,
            &StreamsEvent::Loaded {
                streams: vec![stream("1", "faflive")],
            },
        );
        assert_eq!(state.status, StreamsStatus::Ready);
        assert_eq!(state.live.len(), 1);

        reduce(&mut state, &StreamsEvent::Loaded { streams: vec![] });
        assert!(
            state.live.is_empty(),
            "a channel that went off air stops being live",
        );
    }

    #[test]
    fn a_failed_check_keeps_what_was_live() {
        // One bad request must not take the badge off a stream that is still
        // running. "We do not know any more" is not "it ended".
        let mut state = StreamsState::default();
        reduce(
            &mut state,
            &StreamsEvent::Loaded {
                streams: vec![stream("1", "faflive")],
            },
        );
        reduce(
            &mut state,
            &StreamsEvent::LoadFailed {
                reason: "timed out".into(),
            },
        );

        assert_eq!(state.live.len(), 1);
        assert_eq!(
            state.status,
            StreamsStatus::Failed {
                reason: "timed out".into()
            },
        );
    }

    #[test]
    fn a_stream_is_announced_once_however_often_it_is_seen() {
        let mut state = StreamsState::default();
        let seen = vec![stream("abc", "faflive")];
        reduce(
            &mut state,
            &StreamsEvent::Loaded {
                streams: seen.clone(),
            },
        );
        assert_eq!(state.unannounced().len(), 1);

        reduce(
            &mut state,
            &StreamsEvent::Announced {
                stream_ids: vec!["abc".into()],
            },
        );
        // Three more hours of the same broadcast.
        for _ in 0..3 {
            reduce(
                &mut state,
                &StreamsEvent::Loaded {
                    streams: seen.clone(),
                },
            );
            assert!(state.unannounced().is_empty());
        }
    }

    #[test]
    fn a_second_broadcast_on_the_same_channel_is_news_again() {
        // Why the broadcast id is the key and the channel is not: going live
        // again is a new thing to say.
        let mut state = StreamsState::default();
        reduce(
            &mut state,
            &StreamsEvent::Loaded {
                streams: vec![stream("first", "faflive")],
            },
        );
        reduce(
            &mut state,
            &StreamsEvent::Announced {
                stream_ids: vec!["first".into()],
            },
        );
        reduce(
            &mut state,
            &StreamsEvent::Loaded {
                streams: vec![stream("second", "faflive")],
            },
        );

        assert_eq!(state.unannounced().len(), 1);
        assert_eq!(state.unannounced()[0].id, "second");
    }

    #[test]
    fn the_announced_list_is_bounded() {
        let mut state = StreamsState::default();
        let ids: Vec<String> = (0..MAX_ANNOUNCED + 10).map(|n| n.to_string()).collect();
        reduce(
            &mut state,
            &StreamsEvent::Announced {
                stream_ids: ids.clone(),
            },
        );

        assert_eq!(state.announced.len(), MAX_ANNOUNCED);
        assert_eq!(
            state.announced.last().unwrap(),
            ids.last().unwrap(),
            "the newest ids are the ones worth keeping",
        );
    }

    #[test]
    fn a_channel_is_matched_however_it_is_spelled() {
        let mut state = StreamsState::default();
        reduce(
            &mut state,
            &StreamsEvent::Loaded {
                streams: vec![stream("1", "faflive")],
            },
        );

        assert!(state.live_channel("FAFLive").is_some());
        assert!(state.live_channel("  faflive ").is_some());
        assert!(state.live_channel("someoneelse").is_none());
    }
}
