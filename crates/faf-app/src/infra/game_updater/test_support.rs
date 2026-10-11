//! Fixtures the game updater submodules' tests share: a content store filled
//! under real checksums, and cache entries naming what is in it.
//!
//! One place rather than a copy per submodule, because staging, updating and
//! patching are tested against the same store layout.

use std::path::Path;

use super::{CacheManifestEntry, CachedFileInfo};

/// Writes `bytes` into the content store under their own MD5, returning it.
pub(super) fn put_in_store(cache_dir: &Path, group: &str, bytes: &[u8]) -> String {
    let md5 = format!("{:x}", md5::compute(bytes));
    let dir = cache_dir.join(group);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(&md5), bytes).unwrap();
    md5
}

pub(super) fn build_entry(version: i32, files: &[(&str, &str, &str)]) -> CacheManifestEntry {
    CacheManifestEntry {
        featured_mod: "faf".to_string(),
        version: Some(version),
        resolved_version: version,
        name: format!("FAF Build {version}"),
        url: None,
        git_short_sha: None,
        signature: None,
        files: files
            .iter()
            .map(|(group, name, md5)| CachedFileInfo {
                group: (*group).to_string(),
                md5: (*md5).to_string(),
                name: Some((*name).to_string()),
            })
            .collect(),
        updated_at: 0,
        base_version: None,
    }
}

/// The smallest file the version stamp accepts as an executable: the last of
/// its three offsets plus the four bytes written there. A fake executable any
/// smaller makes every stamp fail, which hides whether a caller checks it.
pub(super) const EXE_BYTES: usize = 0x476666 + 4;

/// A loopback HTTP server answering a fixed set of paths, and 404 to anything
/// else, for the tests whose code under test downloads something. Records the
/// path of every request, so a test can tell what was fetched and what was
/// not. One request per connection, answered and closed, the shape of the
/// fake API in `tests/replay_install.rs`.
pub(super) struct FakeServer {
    pub(super) base: String,
    requests: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
}

impl FakeServer {
    pub(super) async fn start(routes: Vec<(String, Vec<u8>)>) -> Self {
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let routes: std::sync::Arc<std::collections::HashMap<String, Vec<u8>>> =
            std::sync::Arc::new(routes.into_iter().collect());
        let requests = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = requests.clone();
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let (routes, log) = (routes.clone(), log.clone());
                tokio::spawn(async move {
                    let mut head = Vec::new();
                    let mut chunk = [0_u8; 4096];
                    while !head.windows(4).any(|window| window == b"\r\n\r\n") {
                        match stream.read(&mut chunk).await {
                            Ok(0) | Err(_) => return,
                            Ok(read) => head.extend_from_slice(&chunk[..read]),
                        }
                    }
                    let head = String::from_utf8_lossy(&head);
                    let target = head.split(' ').nth(1).unwrap_or_default();
                    let path = target.split('?').next().unwrap_or_default().to_string();
                    log.lock().unwrap().push(path.clone());
                    let response = match routes.get(&path) {
                        Some(body) => {
                            let mut response = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                body.len()
                            )
                            .into_bytes();
                            response.extend_from_slice(body);
                            response
                        }
                        None => {
                            b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                                .to_vec()
                        }
                    };
                    let _ = stream.write_all(&response).await;
                    let _ = stream.shutdown().await;
                });
            }
        });
        Self { base, requests }
    }

    /// The paths asked for so far, in order.
    pub(super) fn requests(&self) -> Vec<String> {
        self.requests.lock().unwrap().clone()
    }
}

/// Watching, and holding, the writes into one install directory from inside
/// the real write path, so a test can catch a blocking worker part-way
/// through an install pass and see what the next pass does meanwhile.
///
/// Keyed by directory, so tests running in parallel never see each other's
/// passes. A write nobody watches costs a look through the watched few.
pub(super) mod probe {
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;

    use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};

    /// What a pass into a watched directory reported.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub(in crate::infra::game_updater) enum Event {
        /// A file is about to be replaced inside the install.
        Writing,
        /// A pass found the install held by another and is waiting for it.
        WaitingForInstall,
    }

    struct Probe {
        events: UnboundedSender<Event>,
        /// Taken by the first write, which then waits on its blocking worker
        /// until the test sends or drops the other end.
        hold: Option<std::sync::mpsc::Receiver<()>>,
    }

    static PROBES: Mutex<Option<HashMap<PathBuf, Probe>>> = Mutex::new(None);

    /// Watch `dir`. The first write into it is held until the returned
    /// sender sends, or is dropped by a test that failed before it could.
    pub(in crate::infra::game_updater) fn watch(
        dir: &Path,
    ) -> (UnboundedReceiver<Event>, std::sync::mpsc::Sender<()>) {
        let (events, received) = unbounded_channel();
        let (release, hold) = std::sync::mpsc::channel();
        PROBES
            .lock()
            .unwrap()
            .get_or_insert_with(HashMap::new)
            .insert(
                dir.to_path_buf(),
                Probe {
                    events,
                    hold: Some(hold),
                },
            );
        (received, release)
    }

    /// Report `event` for `path`, anywhere inside a watched directory,
    /// handing back the hold when this is the first write into it.
    fn report(path: &Path, event: Event) -> Option<std::sync::mpsc::Receiver<()>> {
        let mut probes = PROBES.lock().unwrap();
        let probe = probes
            .as_mut()?
            .iter_mut()
            .find(|(dir, _)| path.starts_with(dir))
            .map(|(_, probe)| probe)?;
        let _ = probe.events.send(event);
        (event == Event::Writing)
            .then(|| probe.hold.take())
            .flatten()
    }

    /// Called by the write itself, on its blocking worker, with the file it
    /// is about to replace.
    pub(in crate::infra::game_updater) fn writing(file: &Path) {
        if let Some(hold) = report(file, Event::Writing) {
            let _ = hold.recv();
        }
    }

    /// Called by a pass that has to wait for the install.
    pub(in crate::infra::game_updater) fn waiting_for_install(dir: &Path) {
        report(dir, Event::WaitingForInstall);
    }

    /// The threads each lease key under a watched directory was worked out on,
    /// by watched directory.
    static KEYING: Mutex<Option<HashMap<PathBuf, Vec<std::thread::ThreadId>>>> = Mutex::new(None);

    /// Record which threads work out lease keys for directories in `dir`.
    pub(in crate::infra::game_updater) fn watch_keying(dir: &Path) {
        KEYING
            .lock()
            .unwrap()
            .get_or_insert_with(HashMap::new)
            .insert(dir.to_path_buf(), Vec::new());
    }

    /// Called by `lease_key` itself, on whichever thread it runs on.
    pub(in crate::infra::game_updater) fn keyed(dir: &Path) {
        let mut keying = KEYING.lock().unwrap();
        for (watched, threads) in keying.iter_mut().flatten() {
            if dir.starts_with(watched) {
                threads.push(std::thread::current().id());
            }
        }
    }

    /// The threads lease keys in `dir` were worked out on so far.
    pub(in crate::infra::game_updater) fn keyed_on(dir: &Path) -> Vec<std::thread::ThreadId> {
        KEYING
            .lock()
            .unwrap()
            .as_ref()
            .and_then(|keying| keying.get(dir).cloned())
            .unwrap_or_default()
    }

    /// The threads a map folder was looked for in a watched directory on, by
    /// watched directory. The same bookkeeping as [`KEYING`], for the look
    /// rather than the key.
    static LOOKING: Mutex<Option<HashMap<PathBuf, Vec<std::thread::ThreadId>>>> = Mutex::new(None);

    /// Record which threads look for map folders in `dir`.
    pub(in crate::infra::game_updater) fn watch_looking(dir: &Path) {
        LOOKING
            .lock()
            .unwrap()
            .get_or_insert_with(HashMap::new)
            .insert(dir.to_path_buf(), Vec::new());
    }

    /// Called by `has_map_folder` itself, on whichever thread it runs on.
    pub(in crate::infra::game_updater) fn looked_in(dir: &Path) {
        let mut looking = LOOKING.lock().unwrap();
        for (watched, threads) in looking.iter_mut().flatten() {
            if dir.starts_with(watched) {
                threads.push(std::thread::current().id());
            }
        }
    }

    /// The threads map folders in `dir` were looked for on so far.
    pub(in crate::infra::game_updater) fn looked_on(dir: &Path) -> Vec<std::thread::ThreadId> {
        LOOKING
            .lock()
            .unwrap()
            .as_ref()
            .and_then(|looking| looking.get(dir).cloned())
            .unwrap_or_default()
    }
}
