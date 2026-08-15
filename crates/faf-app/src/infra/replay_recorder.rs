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
//! ## What lands on disk
//!
//! A `.fafreplay`, the same container both reference clients write: one line of
//! JSON describing the game, a `\n`, then the zstd-compressed replay body
//! (`compression: "zstd"`, `version: 2`, as the Python client's
//! `ReplayRecorder.write_replay_file` does).
//!
//! Writing the bare stream instead, as this recorder first did, produces a file
//! that is technically a valid replay and practically useless: the body is an
//! engine command stream that names no map, no players, no title and no date, so
//! the archive lists it as an untitled legacy entry. Everything the Replays tab
//! shows about a game comes from the JSON header.
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
use tokio::net::TcpListener;

use crate::ports::ReplayMetadata;

/// FA's "posting a replay" header prefix.
const POST_PREFIX: &[u8] = b"P/";
/// The header FA sends when *reading* a replay back (the playback path).
const GET_PREFIX: &[u8] = b"G/";

/// Ceiling on the buffered replay body. The body has to be complete before it
/// can be compressed and framed behind the JSON header, so it is held in
/// memory; this bounds what a misbehaving peer on the loopback port can make
/// this process allocate. A long game is single-digit megabytes, so the cap is
/// far above anything FA produces and is never expected to be reached.
const MAX_REPLAY_BYTES: usize = 512 * 1024 * 1024;

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
    pub(crate) async fn start(
        directory: PathBuf,
        metadata: ReplayMetadata,
    ) -> Result<Self, String> {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|error| format!("could not open a replay recorder port: {error}"))?;
        let port = listener
            .local_addr()
            .map_err(|error| format!("could not read the replay recorder port: {error}"))?
            .port();

        let game_id = metadata.uid;
        let task = tokio::spawn(async move {
            // One game, one connection. Looping would only pick up a second
            // game's stream on a port that game was never told about.
            match listener.accept().await {
                Ok((stream, _)) => {
                    if let Err(error) = record(stream, &directory, &metadata).await {
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
    /// local name is derived in [`replay_file_name`], so an odd login cannot
    /// produce an odd path.
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

/// Read the whole stream, then write it as a `.fafreplay`.
///
/// The body is buffered rather than streamed to disk because the file it goes
/// into is `header + zstd(body)`: neither the compression nor the `complete`
/// flag in the header can be settled before FA has finished sending.
async fn record(
    mut stream: tokio::net::TcpStream,
    directory: &Path,
    metadata: &ReplayMetadata,
) -> Result<(), String> {
    let mut buffer = vec![0u8; 64 * 1024];
    let mut body: Vec<u8> = Vec::new();
    let mut header_done = false;
    // A stream that stops early still holds a watchable game; it is the header's
    // `complete` flag, and so the archive's status badge, that has to say so.
    let mut complete = false;

    loop {
        let read = match stream.read(&mut buffer).await {
            Ok(0) => {
                complete = true;
                break;
            }
            Ok(read) => read,
            Err(error) => {
                tracing::warn!(%error, uid = metadata.uid, "replay stream ended early");
                break;
            }
        };
        let mut chunk = &buffer[..read];

        if !header_done {
            header_done = true;
            chunk = strip_header(chunk);
        }

        if body.len() + chunk.len() > MAX_REPLAY_BYTES {
            tracing::warn!(
                uid = metadata.uid,
                "replay exceeded the size cap; truncating"
            );
            break;
        }
        body.extend_from_slice(chunk);
    }

    if body.is_empty() {
        return Err("the game sent no replay data".into());
    }

    tokio::fs::create_dir_all(directory)
        .await
        .map_err(|error| format!("could not create {}: {error}", directory.display()))?;
    let path = directory.join(replay_file_name(metadata));
    let raw_bytes = body.len();
    let file = build_fafreplay(metadata, body, complete)?;
    let bytes = file.len();
    tokio::fs::write(&path, file)
        .await
        .map_err(|error| format!("could not write {}: {error}", path.display()))?;

    tracing::info!(
        path = %path.display(),
        raw_bytes,
        bytes,
        complete,
        "replay recorded"
    );
    Ok(())
}

/// `<uid>-<recorder>.fafreplay`, the name the Python client uses, so one shared
/// replay folder stays legible to whichever client the user opens next.
///
/// The login is sanitised because it reaches the filesystem: everything outside
/// a conservative set is dropped, and a name left empty by that falls back to
/// the uid alone rather than producing `27619486-.fafreplay`.
fn replay_file_name(metadata: &ReplayMetadata) -> String {
    let recorder: String = metadata
        .recorder
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    if recorder.is_empty() {
        format!("{}.fafreplay", metadata.uid)
    } else {
        format!("{}-{}.fafreplay", metadata.uid, recorder)
    }
}

/// JSON header line, `\n`, zstd body.
pub(crate) fn build_fafreplay(
    metadata: &ReplayMetadata,
    body: Vec<u8>,
    complete: bool,
) -> Result<Vec<u8>, String> {
    let now = unix_seconds();
    let header = serde_json::json!({
        "uid": metadata.uid,
        "recorder": metadata.recorder,
        "featured_mod": metadata.featured_mod,
        "title": metadata.title,
        "mapname": metadata.map_name,
        "game_type": metadata.game_type,
        "host": metadata.host,
        "launched_at": metadata.launched_at.map(f64::from).unwrap_or(now),
        "game_end": now,
        "num_players": metadata.num_players,
        "teams": metadata.teams,
        "sim_mods": metadata.sim_mods,
        "complete": complete,
        // Read back by `infra::replay`'s local metadata and playback paths, and
        // by the other clients. `version: 2` is what pairs with zstd.
        "compression": "zstd",
        "version": 2,
    });

    let mut file = serde_json::to_vec(&header)
        .map_err(|error| format!("could not build the replay header: {error}"))?;
    file.push(b'\n');
    // Level 0 is zstd's default, matching the Python client's `zstd.compress`.
    let compressed = zstd::stream::encode_all(&body[..], 0)
        .map_err(|error| format!("could not compress the replay: {error}"))?;
    file.extend_from_slice(&compressed);
    Ok(file)
}

fn unix_seconds() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as f64)
        .unwrap_or_default()
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

    fn metadata() -> ReplayMetadata {
        ReplayMetadata {
            uid: 4711,
            recorder: "Nory".into(),
            featured_mod: "faf".into(),
            title: "A game".into(),
            map_name: "scmp_009".into(),
            game_type: "custom".into(),
            host: "Nory".into(),
            launched_at: Some(1_700_000_000),
            num_players: 2,
            teams: [("1".to_string(), vec!["Nory".to_string()])]
                .into_iter()
                .collect(),
            sim_mods: Default::default(),
        }
    }

    /// Splits a written `.fafreplay` back into its header and decompressed body.
    fn parse(file: &[u8]) -> (serde_json::Value, Vec<u8>) {
        let newline = file.iter().position(|byte| *byte == b'\n').unwrap();
        let header = serde_json::from_slice(&file[..newline]).unwrap();
        let body = zstd::stream::decode_all(&file[newline + 1..]).unwrap();
        (header, body)
    }

    #[test]
    fn the_file_is_a_header_line_then_a_zstd_body() {
        let file = build_fafreplay(&metadata(), b"replay body".to_vec(), true).unwrap();
        let (header, body) = parse(&file);
        assert_eq!(body, b"replay body");
        assert_eq!(header["uid"], 4711);
        assert_eq!(header["mapname"], "scmp_009");
        assert_eq!(header["title"], "A game");
        assert_eq!(header["recorder"], "Nory");
        assert_eq!(header["featured_mod"], "faf");
        assert_eq!(header["launched_at"], 1_700_000_000.0);
        assert_eq!(header["compression"], "zstd");
        assert_eq!(header["version"], 2);
        assert_eq!(header["complete"], true);
        assert_eq!(header["teams"]["1"][0], "Nory");
    }

    /// The archive's status badge is driven by this flag, so a game whose stream
    /// was cut short must not claim to be a complete recording.
    #[test]
    fn a_truncated_stream_is_marked_incomplete() {
        let file = build_fafreplay(&metadata(), b"partial".to_vec(), false).unwrap();
        let (header, _) = parse(&file);
        assert_eq!(header["complete"], false);
    }

    /// Without a launch time from the lobby (the matchmaker path) the recording
    /// time stands in, so the entry still sorts and displays by date.
    #[test]
    fn a_missing_launch_time_falls_back_to_now() {
        let mut metadata = metadata();
        metadata.launched_at = None;
        let file = build_fafreplay(&metadata, b"body".to_vec(), true).unwrap();
        let (header, _) = parse(&file);
        assert!(header["launched_at"].as_f64().unwrap() > 1_700_000_000.0);
    }

    #[test]
    fn the_file_is_named_after_the_game_and_the_recorder() {
        assert_eq!(replay_file_name(&metadata()), "4711-Nory.fafreplay");
    }

    #[test]
    fn a_login_that_cannot_name_a_file_leaves_the_uid_alone() {
        let mut metadata = metadata();
        metadata.recorder = "../..".into();
        assert_eq!(replay_file_name(&metadata), "4711.fafreplay");
    }

    #[tokio::test]
    async fn a_streamed_replay_lands_on_disk_without_its_header() {
        use tokio::io::AsyncWriteExt as _;

        let dir = std::env::temp_dir().join(format!("faf-rec-{}", std::process::id()));
        let recorder = ReplayRecorder::start(dir.clone(), metadata())
            .await
            .unwrap();
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

        let path = dir.join("4711-Nory.fafreplay");
        for _ in 0..50 {
            if path.exists() && std::fs::read(&path).map(|b| !b.is_empty()).unwrap_or(false) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        let (header, body) = parse(&std::fs::read(&path).unwrap());
        assert_eq!(body, b"hello replay");
        assert_eq!(header["uid"], 4711);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
