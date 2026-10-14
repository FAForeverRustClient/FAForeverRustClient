//! The game's GPGNet port, held by the client while the Java adapter starts.
//!
//! Forged Alliance is launched with `/gpgnet 127.0.0.1:<port>` and connects to
//! that port once it has loaded, eleven to thirteen seconds later. The Java
//! adapter takes about two seconds to bind it. Waiting for the adapter before
//! launching the game put those two seconds in front of the whole load (#511),
//! so the game is launched at once on a port this client opens itself, and the
//! connection is passed through to the adapter's own GPGNet port when the game
//! makes it.
//!
//! The game therefore never finds the port closed, whatever the adapter is
//! doing: a slow JVM, or a retry on other ports (`spawn_on_free_ports`), only
//! makes the connection wait. What Forged Alliance does with a refused GPGNet
//! connection is engine behaviour no reference client relies on, and this
//! means nothing here has to.
//!
//! Loopback only, so no firewall prompt, and the bytes are passed through
//! untouched: GPGNet is the adapter's protocol, not this client's.

use std::time::Instant;

use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tokio::task::{AbortHandle, JoinSet};

/// A GPGNet port open for one game. Dropping it closes the port and every
/// connection through it.
pub(crate) struct GpgNetProxy {
    port: u16,
    adapter: watch::Sender<Option<u16>>,
    serving: AbortHandle,
}

impl GpgNetProxy {
    /// Open a port for the game.
    pub(crate) async fn open() -> std::io::Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let port = listener.local_addr()?.port();
        let (adapter, adapter_port) = watch::channel(None);
        let serving = tokio::spawn(serve(listener, adapter_port, Instant::now())).abort_handle();
        Ok(Self {
            port,
            adapter,
            serving,
        })
    }

    /// The port the game is launched with.
    pub(crate) fn port(&self) -> u16 {
        self.port
    }

    /// Where to say which port the adapter's GPGNet server listens on, once
    /// it does. A connection the game made before that waits for it.
    pub(crate) fn adapter_port(&self) -> watch::Sender<Option<u16>> {
        self.adapter.clone()
    }
}

impl Drop for GpgNetProxy {
    fn drop(&mut self) {
        self.serving.abort();
    }
}

/// Accept the game's connections and pass each one through to the adapter.
///
/// The connections live in a `JoinSet` owned by this task, so stopping the
/// task closes them too.
async fn serve(listener: TcpListener, adapter_port: watch::Receiver<Option<u16>>, opened: Instant) {
    let mut connections = JoinSet::new();
    loop {
        let accepted = tokio::select! {
            accepted = listener.accept() => accepted,
            Some(_) = connections.join_next(), if !connections.is_empty() => continue,
        };
        let game = match accepted {
            Ok((game, _)) => game,
            Err(error) => {
                tracing::warn!(%error, "the game's GPGNet port could not accept a connection");
                continue;
            }
        };
        let adapter_port = adapter_port.clone();
        connections.spawn(pass_through(game, adapter_port, opened));
    }
}

/// One connection from the game, joined to the adapter's GPGNet server as
/// soon as that is known.
async fn pass_through(
    mut game: TcpStream,
    mut adapter_port: watch::Receiver<Option<u16>>,
    opened: Instant,
) {
    let connected = Instant::now();
    let Ok(port) = adapter_port
        .wait_for(Option::is_some)
        .await
        .map(|port| port.unwrap_or_default())
    else {
        // The adapter never came up; the launcher stops the game for that.
        return;
    };
    tracing::info!(
        milliseconds = opened.elapsed().as_millis() as u64,
        waited_for_the_adapter_ms = connected.elapsed().as_millis() as u64,
        "the game connected to GPGNet"
    );
    let mut adapter = match TcpStream::connect(("127.0.0.1", port)).await {
        Ok(adapter) => adapter,
        Err(error) => {
            tracing::warn!(%error, port, "the adapter's GPGNet port refused the game's connection");
            return;
        }
    };
    // GPGNet is a handful of small messages, each of which someone waits on.
    let _ = game.set_nodelay(true);
    let _ = adapter.set_nodelay(true);
    if let Err(error) = tokio::io::copy_bidirectional(&mut game, &mut adapter).await {
        tracing::debug!(%error, "the GPGNet connection ended");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// The adapter's side: answers what it reads with `reply`.
    async fn adapter_answering(reply: &'static [u8]) -> (u16, tokio::task::JoinHandle<Vec<u8>>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let answering = tokio::spawn(async move {
            let (mut game, _) = listener.accept().await.unwrap();
            let mut heard = vec![0; 4];
            game.read_exact(&mut heard).await.unwrap();
            game.write_all(reply).await.unwrap();
            heard
        });
        (port, answering)
    }

    #[tokio::test]
    async fn a_game_that_connects_before_the_adapter_is_up_waits_for_it() {
        let proxy = GpgNetProxy::open().await.unwrap();
        let mut game = TcpStream::connect(("127.0.0.1", proxy.port()))
            .await
            .expect("the port is open before the adapter exists");
        game.write_all(b"Idle").await.unwrap();

        // The adapter comes up afterwards, on a port of its own.
        tokio::time::sleep(Duration::from_millis(100)).await;
        let (port, adapter) = adapter_answering(b"CreateLobby").await;
        proxy.adapter_port().send(Some(port)).unwrap();

        let mut answer = vec![0; b"CreateLobby".len()];
        tokio::time::timeout(Duration::from_secs(5), game.read_exact(&mut answer))
            .await
            .expect("the adapter's answer reaches the game")
            .unwrap();
        assert_eq!(answer, b"CreateLobby");
        assert_eq!(
            adapter.await.unwrap(),
            b"Idle",
            "what the game said before is not lost"
        );
    }

    #[tokio::test]
    async fn a_game_that_connects_after_the_adapter_is_up_goes_straight_through() {
        let proxy = GpgNetProxy::open().await.unwrap();
        let (port, adapter) = adapter_answering(b"ok").await;
        proxy.adapter_port().send(Some(port)).unwrap();

        let mut game = TcpStream::connect(("127.0.0.1", proxy.port()))
            .await
            .unwrap();
        game.write_all(b"Idle").await.unwrap();
        let mut answer = vec![0; 2];
        tokio::time::timeout(Duration::from_secs(5), game.read_exact(&mut answer))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(answer, b"ok");
        assert_eq!(adapter.await.unwrap(), b"Idle");
    }

    #[tokio::test]
    async fn closing_the_proxy_closes_the_games_connection() {
        let proxy = GpgNetProxy::open().await.unwrap();
        let mut game = TcpStream::connect(("127.0.0.1", proxy.port()))
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        drop(proxy);

        let mut byte = [0; 1];
        let read = tokio::time::timeout(Duration::from_secs(5), game.read(&mut byte))
            .await
            .expect("the connection is closed, not left waiting");
        assert!(matches!(read, Ok(0) | Err(_)));
    }
}
