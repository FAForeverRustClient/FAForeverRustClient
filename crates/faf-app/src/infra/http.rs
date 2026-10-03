//! Shared HTTP transport policy for infrastructure adapters.
//!
//! `reqwest::Client` is deliberately cheap to clone: clones retain the same
//! connection pool and TLS state. Keeping one process-wide instance avoids a
//! separate idle pool for every FAF capability while the capability-specific
//! port traits remain small and independently testable.

use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

static HTTP: OnceLock<reqwest::Client> = OnceLock::new();

/// The whole-request deadline for an API call that fetches or writes a
/// document, as opposed to moving a file.
///
/// Without one, a server that accepted the connection and then stopped
/// answering held the request, and whatever serialization lock its caller
/// held, for as long as the socket stayed open: in practice, until the client
/// was restarted. Thirty seconds is far beyond a healthy API answer and well
/// inside the point where a person gives up on a spinner.
pub(crate) const REQUEST_DEADLINE: Duration = Duration::from_secs(30);

/// How long a transfer may go without receiving a byte before it is abandoned.
///
/// Downloads cannot have a total deadline: a 500 MB map on a slow line takes
/// as long as it takes. What they can have is a limit on *silence*, which is
/// what a stalled connection looks like. Applied to every client built here.
pub(crate) const TRANSFER_STALL_TIMEOUT: Duration = Duration::from_secs(60);

/// How long the server may take to answer once an upload's body is all sent.
/// The vault unpacks and validates the archive before it replies, so this is
/// generous, but it is a limit.
pub(crate) const UPLOAD_RESPONSE_DEADLINE: Duration = Duration::from_secs(10 * 60);

pub(crate) fn shared_http_client() -> reqwest::Client {
    HTTP.get_or_init(|| {
        client_builder()
            // Do not set a whole-request timeout here: the same transport is
            // used for large map/mod downloads. API operations impose
            // [`REQUEST_DEADLINE`] per request instead.
            .build()
            .expect("the shared HTTP client configuration is valid")
    })
    .clone()
}

/// A client for uploads: the shared policy minus the read timeout.
///
/// reqwest's read timeout is not only the gap between body chunks; until the
/// response headers arrive, it is one timer started when the request was. For
/// an upload that span covers sending the whole archive and the server
/// processing it, so a stall limit there would fail every upload that takes
/// longer than the limit to send. Uploads are watched with [`UploadWatch`]
/// instead, which measures the body actually leaving.
pub(crate) fn upload_http_client() -> reqwest::Client {
    base_builder()
        .build()
        .expect("the upload HTTP client configuration is valid")
}

/// A transport failure as text that says what happened.
///
/// reqwest's own message names only the phase ("error sending request for
/// url (...)", "request or response body error") and keeps the cause in its
/// source chain, so a timeout used to read as a generic network failure. The
/// UI recognises "timed out" and says so in a plain sentence.
pub(crate) fn describe_transport_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        format!("timed out: {error}")
    } else {
        error.to_string()
    }
}

/// Progress of a streamed upload body, for [`UploadWatch::guard`].
#[derive(Clone)]
pub(crate) struct UploadWatch {
    last_progress: Arc<Mutex<Instant>>,
    body_sent: Arc<AtomicBool>,
}

/// Why [`UploadWatch::guard`] gave up.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum UploadStalled {
    /// No body bytes went out for the stall limit.
    Sending,
    /// The body was all sent, and no answer came within the response deadline.
    Answering,
}

impl std::fmt::Display for UploadStalled {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Sending => write!(f, "upload timed out: no data could be sent for a while"),
            Self::Answering => write!(f, "upload timed out waiting for the server to answer"),
        }
    }
}

impl UploadWatch {
    pub(crate) fn new() -> Self {
        Self {
            last_progress: Arc::new(Mutex::new(Instant::now())),
            body_sent: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Record that a chunk of the body was taken by the transport.
    pub(crate) fn progressed(&self) {
        if let Ok(mut last) = self.last_progress.lock() {
            *last = Instant::now();
        }
    }

    /// Record that the whole body was taken; from here the server is answering.
    pub(crate) fn body_sent(&self) {
        self.progressed();
        self.body_sent.store(true, Ordering::SeqCst);
    }

    /// Run `upload`, failing if its body stops moving for `stall`, or if the
    /// answer takes longer than `answer` once the body is all sent.
    ///
    /// The transport only takes the next chunk when the socket has room for
    /// it, so a gap between chunks is a gap on the wire, which is exactly the
    /// silence a stall limit is for.
    pub(crate) async fn guard<T>(
        &self,
        stall: Duration,
        answer: Duration,
        upload: impl Future<Output = T>,
    ) -> Result<T, UploadStalled> {
        let check_every = (stall / 4).clamp(Duration::from_millis(10), Duration::from_secs(5));
        let mut ticks = tokio::time::interval(check_every);
        tokio::pin!(upload);
        loop {
            tokio::select! {
                output = &mut upload => return Ok(output),
                _ = ticks.tick() => {
                    let quiet = self
                        .last_progress
                        .lock()
                        .map(|last| last.elapsed())
                        .unwrap_or_default();
                    if self.body_sent.load(Ordering::SeqCst) {
                        if quiet > answer {
                            return Err(UploadStalled::Answering);
                        }
                    } else if quiet > stall {
                        return Err(UploadStalled::Sending);
                    }
                }
            }
        }
    }
}

/// A separate client for downloads whose redirects must be inspected one hop
/// at a time. Using `Policy::none` lets the owning adapter reject an untrusted
/// destination before any request reaches it.
pub(crate) fn no_redirect_http_client() -> reqwest::Client {
    client_builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("the no-redirect HTTP client configuration is valid")
}

/// A client for the two downloads whose bytes end up being executed: the client
/// installer and the map generator's JAR.
///
/// FAF decided against signing these, on the grounds that fetching them over
/// HTTPS from GitHub is enough: a man in the middle would need a valid
/// certificate for github.com, and anybody who has that can already run code on
/// the machine without bothering to fake a map generator. That reasoning is
/// sound, and it rests entirely on the connection actually staying HTTPS.
///
/// It did not. Both downloads start at a pinned `https://github.com/...` URL
/// and are then followed through redirects by a client using reqwest's default
/// policy, which does not refuse a downgrade. GitHub redirects release assets
/// to its own CDN, so the hop is expected and has to be allowed; what must not
/// be allowed is a hop to plain HTTP, where there is no certificate to present
/// and the argument collapses.
///
/// This policy follows redirects, and refuses any hop that is not HTTPS before
/// the request is sent rather than after the bytes have arrived.
pub(crate) fn https_only_download_client() -> reqwest::Client {
    client_builder()
        .redirect(reqwest::redirect::Policy::custom(
            |attempt| match redirect_verdict(attempt.url().scheme(), attempt.previous().len()) {
                RedirectVerdict::Follow => attempt.follow(),
                RedirectVerdict::TooManyHops => attempt.stop(),
                RedirectVerdict::LeavesHttps => {
                    let refused = HttpsDowngrade(attempt.url().to_string());
                    attempt.error(refused)
                }
            },
        ))
        .build()
        .expect("the HTTPS-only download client configuration is valid")
}

#[derive(Debug, PartialEq, Eq)]
enum RedirectVerdict {
    Follow,
    TooManyHops,
    LeavesHttps,
}

/// The decision itself, apart from reqwest's types.
///
/// `reqwest::redirect::Attempt` has no public constructor, so a test cannot
/// build one to hand to the policy. Taking the two things the decision actually
/// depends on makes the rule testable without pretending to be reqwest.
fn redirect_verdict(scheme: &str, hops: usize) -> RedirectVerdict {
    if scheme != "https" {
        return RedirectVerdict::LeavesHttps;
    }
    // The same ceiling reqwest's default policy uses.
    if hops >= 10 {
        return RedirectVerdict::TooManyHops;
    }
    RedirectVerdict::Follow
}

#[derive(Debug)]
struct HttpsDowngrade(String);

impl std::fmt::Display for HttpsDowngrade {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "refusing a redirect that leaves HTTPS, to {}", self.0)
    }
}

impl std::error::Error for HttpsDowngrade {}

/// Every client here except the upload one: the base policy plus a limit on
/// how long a response may go silent. See [`TRANSFER_STALL_TIMEOUT`].
fn client_builder() -> reqwest::ClientBuilder {
    stalling_after(TRANSFER_STALL_TIMEOUT)
}

fn stalling_after(stall: Duration) -> reqwest::ClientBuilder {
    base_builder().read_timeout(stall)
}

fn base_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        // FAF's own services see this, so it is the most visible place the old
        // name was still showing. A User-Agent product token cannot contain a
        // space, hence the slug rather than the display name.
        .user_agent(concat!("FAForeverClient/", env!("CARGO_PKG_VERSION")))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// This policy is the whole of the mitigation FAF chose over signing the
    /// map generator and the installer, so it is asserted rather than assumed.
    #[test]
    fn a_redirect_may_not_leave_https() {
        // GitHub redirects a release asset to its own CDN, so an https hop has
        // to keep working.
        assert_eq!(redirect_verdict("https", 0), RedirectVerdict::Follow);
        assert_eq!(redirect_verdict("https", 3), RedirectVerdict::Follow);

        // The case the default policy allows and this one does not. Without a
        // certificate to present there is nothing left of the argument that
        // fetching over HTTPS from GitHub is enough.
        assert_eq!(redirect_verdict("http", 0), RedirectVerdict::LeavesHttps);
        assert_eq!(redirect_verdict("ftp", 0), RedirectVerdict::LeavesHttps);

        // A redirect loop is still a redirect loop.
        assert_eq!(redirect_verdict("https", 10), RedirectVerdict::TooManyHops);
    }

    /// A server that sends its headers and then goes quiet. Returns its URL;
    /// the connection is held open, silent, until the test ends.
    async fn silent_after_headers() -> String {
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test server");
        let address = listener.local_addr().expect("test server address");
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept request");
            let mut request = [0_u8; 2048];
            let _ = socket.read(&mut request).await;
            let _ = socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\npartial")
                .await;
            std::future::pending::<()>().await;
        });
        format!("http://{address}/file.zip")
    }

    /// A download that stops arriving fails after the stall limit, instead of
    /// holding the transfer open for as long as the socket lives, and the
    /// failure reads as a timeout rather than a generic network error.
    #[tokio::test]
    async fn a_stalled_download_times_out_and_says_so() {
        let url = silent_after_headers().await;
        let client = stalling_after(Duration::from_millis(200))
            .build()
            .expect("test client");

        let response = client.get(url).send().await.expect("headers arrive");
        let error = tokio::time::timeout(Duration::from_secs(10), response.bytes())
            .await
            .expect("the stall limit fires well before the test's own")
            .expect_err("a silent body must fail");

        assert!(error.is_timeout());
        assert!(describe_transport_error(&error).contains("timed out"));
    }

    #[tokio::test]
    async fn an_upload_whose_body_stops_moving_is_abandoned() {
        let watch = UploadWatch::new();
        let stalled = watch
            .guard(
                Duration::from_millis(100),
                Duration::from_secs(60),
                std::future::pending::<()>(),
            )
            .await;
        assert_eq!(stalled, Err(UploadStalled::Sending));
        assert!(UploadStalled::Sending.to_string().contains("timed out"));
    }

    #[tokio::test]
    async fn an_upload_gets_its_own_deadline_for_the_answer() {
        let watch = UploadWatch::new();
        watch.body_sent();
        let stalled = watch
            .guard(
                Duration::from_secs(60),
                Duration::from_millis(100),
                std::future::pending::<()>(),
            )
            .await;
        assert_eq!(stalled, Err(UploadStalled::Answering));
    }

    /// Steady progress keeps an upload alive past the stall limit; only
    /// silence ends it.
    #[tokio::test]
    async fn a_moving_upload_is_left_alone() {
        let watch = UploadWatch::new();
        let feeder = watch.clone();
        let upload = async move {
            for _ in 0..8 {
                tokio::time::sleep(Duration::from_millis(40)).await;
                feeder.progressed();
            }
            "done"
        };
        let result = watch
            .guard(Duration::from_millis(150), Duration::from_secs(60), upload)
            .await;
        assert_eq!(result, Ok("done"));
    }

    /// A downgrade is refused before the request goes out, and says so.
    #[test]
    fn the_refusal_names_the_url_it_refused() {
        let refused = HttpsDowngrade("http://elsewhere.invalid/a.jar".to_string());
        assert!(refused
            .to_string()
            .contains("http://elsewhere.invalid/a.jar"));
        assert!(refused.to_string().contains("leaves HTTPS"));
    }
}
