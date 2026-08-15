//! Records the replay of a live game to disk.
//!
//! Forged Alliance does not write a replay file for a networked game by itself.
//! Given `/savereplay gpgnet://<host>:<port>/<uid>/<name>.SCFAreplay` it instead
//! *streams* the replay to that address as it plays, and the client is expected
//! to be listening. Without the flag, as this client shipped until now, a played
//! game leaves nothing behind at all.
//!
//! ## The wire format
//!
//! FA opens one TCP connection and sends a NUL-terminated header before the
//! replay body:
//!
//! ```text
//! P/4711/Nory\0<raw .scfareplay bytes…>
//! ```
//!
//! `P/` is "posting" in FA's live-replay protocol. The header belongs to the
//! protocol, not to the replay, so it is stripped before writing: keeping it
//! produces a file no replay parser will open. This mirrors the Python client's
//! `ReplayRecorder.read_from_game`, which strips exactly the same prefix for
//! exactly this reason.
//!
//! ## Scope
//!
//! This records locally. It deliberately does **not** relay the stream on to
//! FAF's live-replay service, which is what lets other people watch you play
//! while the game is running; that needs an authenticated websocket to the
//! relay and is tracked separately. The two are independent: the local file is
//! written whether or not a relay exists.

use std::path::{Path, PathBuf};

use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;

/// FA's "posting a replay" header prefix.
const POST_PREFIX: &[u8] = b"P/";
/// The header FA sends when *reading* a replay back (the playback path).
const GET_PREFIX: &[u8] = b"G/";

/// A listening recorder. Dropping it stops accepting new connections; the
/// in-flight write finishes on its own task.
pub(crate) struct ReplayRecorder {
    port: u16,
    task: tokio::task::JoinHandle<()>,
}

impl ReplayRecorder {
    /// Bind a loopback listener and accept a single game's replay stream.
    ///
    /// Bound before FA starts, so the address in `/savereplay` is already
    /// listening when the game reaches it.
    pub(crate) async fn start(directory: PathBuf, game_id: i32) -> Result<Self, String> {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|error| format!("could not open a replay recorder port: {error}"))?;
        let port = listener
            .local_addr()
            .map_err(|error| format!("could not read the replay recorder port: {error}"))?
            .port();

        let task = tokio::spawn(async move {
            // One game, one connection. Looping would only pick up a second
            // game's stream on a port that game was never told about.
            match listener.accept().await {
                Ok((stream, _)) => {
                    if let Err(error) = record(stream, &directory, game_id).await {
                        tracing::warn!(%error, game_id, "could not record the replay");
                    }
                }
                Err(error) => tracing::warn!(%error, game_id, "replay recorder stopped accepting"),
            }
        });

        tracing::info!(port, game_id, "recording this game's replay");
        Ok(Self { port, task })
    }

    /// The `/savereplay` target for this recorder.
    ///
    /// `player` only names the file on the server side of the protocol; the
    /// local name comes from the game id, so an odd login cannot produce an odd
    /// path.
    pub(crate) fn savereplay_url(&self, game_id: i32, player: &str) -> String {
        format!(
            "gpgnet://127.0.0.1:{}/{}/{}.SCFAreplay",
            self.port, game_id, player
        )
    }
}

impl Drop for ReplayRecorder {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Stream the connection to disk, minus the protocol header.
async fn record(
    mut stream: tokio::net::TcpStream,
    directory: &Path,
    game_id: i32,
) -> Result<(), String> {
    tokio::fs::create_dir_all(directory)
        .await
        .map_err(|error| format!("could not create {}: {error}", directory.display()))?;

    // `.scfareplay` rather than `.fafreplay`: this is the raw stream, and the
    // local library already lists both extensions. Wrapping it in the compressed
    // `.fafreplay` container would be a second, independent change.
    let path = directory.join(format!("{game_id}.scfareplay"));
    let mut file = tokio::fs::File::create(&path)
        .await
        .map_err(|error| format!("could not create {}: {error}", path.display()))?;

    let mut buffer = vec![0u8; 64 * 1024];
    let mut header_done = false;
    let mut written = 0u64;

    loop {
        let read = stream
            .read(&mut buffer)
            .await
            .map_err(|error| format!("replay stream failed: {error}"))?;
        if read == 0 {
            break;
        }
        let mut chunk = &buffer[..read];

        if !header_done {
            header_done = true;
            chunk = strip_header(chunk);
        }

        file.write_all(chunk)
            .await
            .map_err(|error| format!("could not write {}: {error}", path.display()))?;
        written += chunk.len() as u64;
    }

    file.flush()
        .await
        .map_err(|error| format!("could not flush {}: {error}", path.display()))?;
    drop(file);

    // A connection that opened and closed without a replay body leaves a zero
    // byte file that the local list would show as a broken entry.
    if written == 0 {
        let _ = tokio::fs::remove_file(&path).await;
        return Err("the game sent no replay data".into());
    }

    tracing::info!(path = %path.display(), bytes = written, "replay recorded");
    Ok(())
}

/// Drop FA's NUL-terminated protocol header from the first chunk.
///
/// Only `P/` is stripped. `G/` is the playback direction and carries no
/// trailing NUL header of this shape, and anything else is passed through
/// untouched rather than guessing: losing the start of a replay is worse than
/// keeping a few stray bytes, and it would be silent.
fn strip_header(chunk: &[u8]) -> &[u8] {
    if !chunk.starts_with(POST_PREFIX) {
        if !chunk.starts_with(GET_PREFIX) {
            tracing::warn!("unexpected replay stream header; writing the stream verbatim");
        }
        return chunk;
    }
    match chunk.iter().position(|byte| *byte == 0) {
        Some(end) => &chunk[end + 1..],
        // The header is split across reads. Vanishingly unlikely for a header
        // this short, and the alternative (buffering until a NUL arrives) adds
        // a failure mode of its own for no practical gain.
        None => {
            tracing::warn!("replay header spans reads; writing the stream verbatim");
            chunk
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_post_header_is_stripped() {
        let stream = b"P/4711/Nory\0\x01\x02\x03";
        assert_eq!(strip_header(stream), &[1, 2, 3]);
    }

    #[test]
    fn a_replay_body_without_a_known_header_is_kept_whole() {
        // Losing the first bytes of a replay would corrupt it silently, so an
        // unrecognised header is passed through rather than guessed at.
        let stream = b"\x01\x02\x03";
        assert_eq!(strip_header(stream), &[1, 2, 3]);
    }

    #[test]
    fn a_post_header_without_a_terminator_is_not_truncated() {
        let stream = b"P/4711/Nory";
        assert_eq!(strip_header(stream), stream);
    }

    #[test]
    fn the_url_addresses_this_recorder() {
        let url = format!("gpgnet://127.0.0.1:{}/{}/{}.SCFAreplay", 1234, 42, "Nory");
        assert_eq!(url, "gpgnet://127.0.0.1:1234/42/Nory.SCFAreplay");
    }

    #[tokio::test]
    async fn a_streamed_replay_lands_on_disk_without_its_header() {
        let dir = std::env::temp_dir().join(format!("faf-rec-{}", std::process::id()));
        let recorder = ReplayRecorder::start(dir.clone(), 4711).await.unwrap();
        let url = recorder.savereplay_url(4711, "Nory");
        let port: u16 = url
            .trim_start_matches("gpgnet://127.0.0.1:")
            .split('/')
            .next()
            .unwrap()
            .parse()
            .unwrap();

        let mut client = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        client
            .write_all(b"P/4711/Nory\0hello replay")
            .await
            .unwrap();
        client.shutdown().await.unwrap();
        drop(client);

        let path = dir.join("4711.scfareplay");
        for _ in 0..50 {
            if path.exists() && std::fs::read(&path).map(|b| !b.is_empty()).unwrap_or(false) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert_eq!(std::fs::read(&path).unwrap(), b"hello replay");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
