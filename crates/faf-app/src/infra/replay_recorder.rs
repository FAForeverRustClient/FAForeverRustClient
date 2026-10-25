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
//! Two destinations, from the one stream FA sends. The local file is this
//! module's job; forwarding the same bytes on to FAF, which is what puts the
//! game in the vault and lets other people watch it, is
//! [`super::replay_relay`]'s. They are independent on purpose: the file is
//! written whether or not the upload worked, and the upload is attempted
//! whether or not the file could be written.

use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use tokio::io::AsyncReadExt;
use tokio::net::TcpListener;

use super::replay_spool::ReplaySpool;
use crate::infra::replay_relay::{ReplayRelay, ReplayRelayConfig};
use crate::ports::ReplayMetadata;

/// FA's "posting a replay" header prefix.
const POST_PREFIX: &[u8] = b"P/";
/// The header FA sends when *reading* a replay back (the playback path).
const GET_PREFIX: &[u8] = b"G/";

/// Disk budget for one raw replay, including its protocol prefix.
const MAX_REPLAY_BYTES: usize = 512 * 1024 * 1024;

/// How long the end of a game waits for the upload to be acknowledged.
///
/// Generous, because this is the last chance the stream gets and the game has
/// already exited, so nothing the user is looking at is being held up. Bounded,
/// because the recorder task ends here and something has to end it.
const UPLOAD_FLUSH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

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
        relay: Option<ReplayRelayConfig>,
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
                    if let Err(error) = record(stream, &directory, &metadata, relay).await {
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

    /// Whether the game's replay is done with: written, and its upload
    /// acknowledged or given up on ([`UPLOAD_FLUSH_TIMEOUT`]). Until then a
    /// client exiting by itself after the game would cut the upload short.
    pub(crate) fn is_finished(&self) -> bool {
        self.task.is_finished()
    }
}

impl Drop for ReplayRecorder {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Capture once to disk while the relay reads independently.
async fn record(
    mut stream: tokio::net::TcpStream,
    directory: &Path,
    metadata: &ReplayMetadata,
    relay: Option<ReplayRelayConfig>,
) -> Result<(), String> {
    // Started with the connection, not with the first chunk: the upload has an
    // access-token request and a TLS handshake to get through before it can
    // take a byte, and FA is already streaming.
    let (spool, mut writer) = ReplaySpool::create().await?;
    let relay = relay.map(|config| ReplayRelay::start(config, metadata.uid, spool.clone()));
    let mut buffer = vec![0u8; 64 * 1024];

    // When FA reached the recorder, which is within a second or two of the
    // game starting. It stands in for a launch time the lobby never reported,
    // and the point of it is that it is taken *now* rather than when the file
    // is written: the fallback used to be the write time, while `game_end` is
    // also the write time, so every replay this client recorded claimed to
    // have lasted no time at all and the archive showed it with no duration.
    let opened_at = unix_seconds();
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
        if spool.progress().len + read as u64 > MAX_REPLAY_BYTES as u64 {
            tracing::warn!(
                uid = metadata.uid,
                "replay exceeded the disk budget; truncating"
            );
            break;
        }
        if let Err(error) = writer.append(&buffer[..read]).await {
            tracing::warn!(%error, uid = metadata.uid, "could not append replay data");
            break;
        }
    }

    // Finalize the local copy independently of the relay's network progress.
    drop(writer);
    let written = write_local(directory, metadata, spool, complete, opened_at).await;

    // Awaited rather than detached: FA has exited, so nothing else is keeping
    // this stream's task alive, and dropping the relay here would cut the
    // upload off short of the very bytes that tell the server the game ended.
    if let Some(relay) = relay {
        relay.finish(UPLOAD_FLUSH_TIMEOUT).await;
    }

    written
}

/// Write the player's own `.fafreplay`.
async fn write_local(
    directory: &Path,
    metadata: &ReplayMetadata,
    spool: ReplaySpool,
    complete: bool,
    opened_at: f64,
) -> Result<(), String> {
    let directory = directory.to_owned();
    let metadata = metadata.clone();
    tokio::task::spawn_blocking(move || {
        let mut source = spool
            .open()
            .map_err(|error| format!("could not read replay spool: {error}"))?;
        let mut prefix = vec![0; 64 * 1024];
        let read = source
            .read(&mut prefix)
            .map_err(|error| error.to_string())?;
        let body = strip_header(&prefix[..read]);
        let offset = read - body.len();
        if spool.progress().len <= offset as u64 {
            return Err("the game sent no replay data".into());
        }
        source
            .seek(SeekFrom::Start(offset as u64))
            .map_err(|error| error.to_string())?;
        std::fs::create_dir_all(&directory)
            .map_err(|error| format!("could not create replay directory: {error}"))?;
        let mut output = tempfile::NamedTempFile::new_in(&directory)
            .map_err(|error| format!("could not create replay file: {error}"))?;
        let header = replay_header(&metadata, complete, opened_at)?;
        output
            .write_all(&header)
            .map_err(|error| error.to_string())?;
        let mut encoder = zstd::stream::write::Encoder::new(output.as_file_mut(), 0)
            .map_err(|error| format!("could not compress replay: {error}"))?;
        std::io::copy(
            &mut source.take(spool.progress().len - offset as u64),
            &mut encoder,
        )
        .map_err(|error| error.to_string())?;
        encoder.finish().map_err(|error| error.to_string())?;
        output
            .persist(directory.join(replay_file_name(&metadata)))
            .map_err(|error| format!("could not save replay: {}", error.error))?;
        tracing::info!(
            uid = metadata.uid,
            raw_bytes = spool.progress().len,
            complete,
            "replay recorded"
        );
        Ok(())
    })
    .await
    .map_err(|_| "replay compression worker stopped".to_string())?
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
///
/// `started_at` is only reached for when the lobby never gave a launch time,
/// which is the matchmaker path and any game that had already left the public
/// listing. Taking it from the recorder rather than from this call is what
/// makes `game_end - launched_at` a duration rather than zero.
#[cfg(test)]
pub(crate) fn build_fafreplay(
    metadata: &ReplayMetadata,
    body: Vec<u8>,
    complete: bool,
    started_at: f64,
) -> Result<Vec<u8>, String> {
    let mut file = replay_header(metadata, complete, started_at)?;
    let compressed = zstd::stream::encode_all(&body[..], 0).map_err(|error| error.to_string())?;
    file.extend_from_slice(&compressed);
    Ok(file)
}

fn replay_header(
    metadata: &ReplayMetadata,
    complete: bool,
    started_at: f64,
) -> Result<Vec<u8>, String> {
    let now = unix_seconds();
    let mut header = serde_json::json!({
        "uid": metadata.uid,
        "recorder": metadata.recorder,
        "featured_mod": metadata.featured_mod,
        "title": metadata.title,
        "mapname": metadata.map_name,
        "game_type": metadata.game_type,
        "host": metadata.host,
        "launched_at": metadata.launched_at.map(f64::from).unwrap_or(started_at),
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
    if let Some(sha) = &metadata.git_sha {
        header["git_sha"] = serde_json::Value::String(sha.clone());
    }
    if let Some(short) = &metadata.git_short_sha {
        header["git_short_sha"] = serde_json::Value::String(short.clone());
    }
    if let Some(sig) = &metadata.signature {
        header["build_signature"] = serde_json::Value::String(sig.clone());
    }
    if let Some(name) = &metadata.version_name {
        header["version_name"] = serde_json::Value::String(name.clone());
    }

    let mut file = serde_json::to_vec(&header)
        .map_err(|error| format!("could not build the replay header: {error}"))?;
    file.push(b'\n');
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

    #[tokio::test]
    async fn performance_spooled_capture_strips_a_fragmented_prefix_and_compresses_all_chunks() {
        let root = tempfile::tempdir().unwrap();
        let (spool, mut writer) = ReplaySpool::create().await.unwrap();
        writer.append(b"P/4711/").await.unwrap();
        writer.append(b"Nory\0first ").await.unwrap();
        writer.append(b"second").await.unwrap();
        drop(writer);
        write_local(root.path(), &metadata(), spool, true, 1_788_000_000.0)
            .await
            .unwrap();
        let (header, body) =
            parse(&std::fs::read(root.path().join("4711-Nory.fafreplay")).unwrap());
        assert_eq!(body, b"first second");
        assert_eq!(header["complete"], true);
    }

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
            git_sha: None,
            git_short_sha: None,
            signature: None,
            version_name: None,
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
        let file =
            build_fafreplay(&metadata(), b"replay body".to_vec(), true, 1_788_000_000.0).unwrap();
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
        let file =
            build_fafreplay(&metadata(), b"partial".to_vec(), false, 1_788_000_000.0).unwrap();
        let (header, _) = parse(&file);
        assert_eq!(header["complete"], false);
    }

    /// Without a launch time from the lobby (the matchmaker path) the recording
    /// time stands in, so the entry still sorts and displays by date.
    #[test]
    fn a_missing_launch_time_falls_back_to_now() {
        let mut metadata = metadata();
        metadata.launched_at = None;
        let file = build_fafreplay(&metadata, b"body".to_vec(), true, 1_788_000_000.0).unwrap();
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
        // No relay: this is the local half of the recorder's job, and the
        // upload has its own end-to-end test in `replay_relay`.
        let recorder = ReplayRecorder::start(dir.clone(), metadata(), None)
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

    #[tokio::test]
    async fn is_finished_only_once_the_game_has_sent_everything_and_it_is_written() {
        use tokio::io::AsyncWriteExt as _;

        // The shell waits on this before exiting by itself after a game, so it
        // must not read as done while the game is still streaming.
        let dir = std::env::temp_dir().join(format!("faf-rec-done-{}", std::process::id()));
        let recorder = ReplayRecorder::start(dir.clone(), metadata(), None)
            .await
            .unwrap();
        assert!(!recorder.is_finished(), "listening for the game");

        let port = recorder.port;
        let mut client = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        client
            .write_all(b"P/4711/Nory\0still playing")
            .await
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(!recorder.is_finished(), "the game is still streaming");

        client.shutdown().await.unwrap();
        drop(client);
        for _ in 0..100 {
            if recorder.is_finished() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert!(
            recorder.is_finished(),
            "the stream ended and the file was written"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
