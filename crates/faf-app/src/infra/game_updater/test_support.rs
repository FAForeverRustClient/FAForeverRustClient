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
}
