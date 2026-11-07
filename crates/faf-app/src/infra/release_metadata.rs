//! Last successful copies of the public metadata used to build unit histories.

use std::future::Future;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{watch, Mutex};
use tokio::time::Instant;

use super::metadata_file::read_bounded_to_string;

const REFRESH_INTERVAL: Duration = Duration::from_secs(60 * 60);
const RETRY_DELAY: Duration = Duration::from_secs(60);

#[derive(Clone, Copy)]
pub(super) enum ReadMode {
    PreferCached,
    RequireFresh,
}

type Refresh<T> = watch::Receiver<Option<Result<T, String>>>;

pub(super) struct ReleaseMetadata<T> {
    path: Option<PathBuf>,
    limit: u64,
    parse: fn(&str) -> Result<T, String>,
    state: Arc<Mutex<State<T>>>,
}

struct State<T> {
    disk_checked: bool,
    cached: Option<(T, Instant)>,
    refresh: Option<Refresh<T>>,
}

impl<T: Clone + Send + Sync + 'static> ReleaseMetadata<T> {
    pub(super) fn new(
        path: Option<PathBuf>,
        limit: u64,
        parse: fn(&str) -> Result<T, String>,
    ) -> Self {
        Self {
            path,
            limit,
            parse,
            state: Arc::new(Mutex::new(State {
                disk_checked: false,
                cached: None,
                refresh: None,
            })),
        }
    }

    pub(super) async fn get(
        &self,
        mode: ReadMode,
        fetch: impl Future<Output = Result<(T, String), String>> + Send + 'static,
    ) -> Result<T, String> {
        let mut state = self.state.lock().await;
        if !state.disk_checked {
            if let Some(path) = self.path.clone() {
                let (limit, parse) = (self.limit, self.parse);
                state.cached = tokio::task::spawn_blocking(move || read(&path, limit, parse))
                    .await
                    .ok()
                    .flatten();
            }
            state.disk_checked = true;
        }
        let cached = match mode {
            ReadMode::RequireFresh => None,
            ReadMode::PreferCached => match &state.cached {
                Some((value, refresh_after)) if Instant::now() < *refresh_after => {
                    return Ok(value.clone());
                }
                Some((value, _)) => Some(value.clone()),
                None => None,
            },
        };

        // Let the refresh finish even when the caller changes selection. A cold
        // caller waits for the same result as every other caller in flight.
        let mut refresh = match &state.refresh {
            Some(refresh) if refresh.has_changed().is_ok() => refresh.clone(),
            _ => {
                let (sender, receiver) = watch::channel(None);
                state.refresh = Some(receiver.clone());
                let state = self.state.clone();
                let (path, limit) = (self.path.clone(), self.limit);
                tokio::spawn(async move {
                    let result = match fetch.await {
                        Ok((value, source)) => {
                            if let Some(path) = path.filter(|_| source.len() as u64 <= limit) {
                                let _ = tokio::task::spawn_blocking(move || {
                                    write_atomic(&path, source.as_bytes())
                                })
                                .await;
                            }
                            Ok(value)
                        }
                        Err(error) => Err(error),
                    };
                    let mut state = state.lock().await;
                    if let Ok(value) = &result {
                        state.cached = Some((value.clone(), Instant::now() + REFRESH_INTERVAL));
                    } else if let Some((_, refresh_after)) = &mut state.cached {
                        // Opening several histories offline should not keep
                        // restarting a failed request.
                        *refresh_after = Instant::now() + RETRY_DELAY;
                    }
                    sender.send_replace(Some(result));
                    state.refresh = None;
                });
                receiver
            }
        };
        drop(state);
        if let Some(cached) = cached {
            return Ok(cached);
        }
        let result = refresh
            .wait_for(Option::is_some)
            .await
            .map_err(|_| "release metadata refresh stopped".to_owned())?;
        result.as_ref().expect("refresh has a result").clone()
    }
}

fn read<T>(path: &Path, limit: u64, parse: fn(&str) -> Result<T, String>) -> Option<(T, Instant)> {
    let age = std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.elapsed().ok());
    let source = read_bounded_to_string(path, limit).ok()?;
    let refresh_after =
        Instant::now() + age.map_or(Duration::ZERO, |age| REFRESH_INTERVAL.saturating_sub(age));
    Some((parse(&source).ok()?, refresh_after))
}

pub(super) fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let directory = path.parent().ok_or(std::io::ErrorKind::InvalidInput)?;
    std::fs::create_dir_all(directory)?;
    let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
    temporary.write_all(bytes)?;
    temporary.persist(path).map_err(|error| error.error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_failed_refresh_keeps_the_last_successful_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("releases.txt");
        std::fs::write(&path, "3837").unwrap();
        std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(std::time::SystemTime::now() - REFRESH_INTERVAL * 2)
            .unwrap();
        let cache = ReleaseMetadata::new(Some(path.clone()), 32, |text| {
            text.parse::<u32>().map_err(|error| error.to_string())
        });

        assert_eq!(
            cache
                .get(ReadMode::RequireFresh, async { Err("offline".into()) })
                .await,
            Err("offline".into())
        );
        assert_eq!(
            cache
                .get(ReadMode::PreferCached, std::future::pending())
                .await,
            Ok(3837)
        );
        assert!(cache.state.lock().await.refresh.is_none());
        assert_eq!(std::fs::read_to_string(path).unwrap(), "3837");
    }
}
