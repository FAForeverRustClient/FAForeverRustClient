//! Live-broadcast boundary: FAF's own channels.
//!
//! One read, no writes, and one unusual property worth stating in the trait
//! rather than leaving to the implementation: **an empty answer is a normal
//! answer, and so is an answer that is always empty.**
//!
//! Twitch tells nobody whether a channel is live without an application's own
//! client id and secret, which are a deployment's credentials and cannot live in
//! a public repository. A build that has none cannot ask, and that is not a
//! failure to report to the user: it is a client that simply never announces a
//! stream. See `infra::streams` for how that is arranged, and
//! `docs/streams.md` for what an operator has to add.

use async_trait::async_trait;
use faf_domain::state::LiveStream;

#[async_trait]
pub trait StreamsPort: Send + Sync {
    /// Which of FAF's channels are broadcasting right now.
    ///
    /// `Ok(vec![])` means "nothing is live", including the case where this build
    /// has no way to find out. `Err` is reserved for a configured lookup that
    /// failed, which is worth showing, because a badge that quietly stops
    /// appearing is indistinguishable from a channel that is off air.
    async fn list_live(&self) -> Result<Vec<LiveStream>, String>;

    /// Whether this build can answer the question at all.
    ///
    /// The service asks before starting its ticker: polling a port that will
    /// answer "nothing" forever is a timer doing nothing every few minutes, and
    /// a log line once at startup is more use than that.
    fn can_check(&self) -> bool {
        true
    }
}
