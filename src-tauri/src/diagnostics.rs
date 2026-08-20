//! Process-wide diagnostics for packaged builds.
//!
//! Windows release builds have no console, so diagnostics must go to a file.
//! Files rotate daily or when they reach the byte limit and are capped to seven
//! entries. The non-blocking guard is held by Tauri managed state for the
//! process lifetime so shutdown flushes pending records.

use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::filter::EnvFilter;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

const MAX_LOG_FILES: usize = 7;
const MAX_LOG_FILE_BYTES: u64 = 10 * 1024 * 1024;
const LOG_FILE_PREFIX: &str = "faforever-client.";
const LOG_FILE_SUFFIX: &str = ".log";

pub struct DiagnosticsGuard {
    _writer: WorkerGuard,
}

pub fn init(log_dir: &Path) -> Result<DiagnosticsGuard, String> {
    let appender = build_appender(log_dir)?;
    let (writer, guard) = tracing_appender::non_blocking(appender);
    let filter = EnvFilter::try_from_env("FAF_LOG")
        .unwrap_or_else(|_| EnvFilter::new("faf_app=info,faforever_rust_client_lib=info,warn"));
    let file = tracing_subscriber::fmt::layer()
        .with_ansi(false)
        .with_target(true)
        .with_writer(writer);

    #[cfg(debug_assertions)]
    tracing_subscriber::registry()
        .with(filter)
        .with(file)
        .with(tracing_subscriber::fmt::layer().compact())
        .try_init()
        .map_err(|error| format!("could not install the diagnostics subscriber: {error}"))?;

    #[cfg(not(debug_assertions))]
    tracing_subscriber::registry()
        .with(filter)
        .with(file)
        .try_init()
        .map_err(|error| format!("could not install the diagnostics subscriber: {error}"))?;

    tracing::info!(
        retained_files = MAX_LOG_FILES,
        max_file_bytes = MAX_LOG_FILE_BYTES,
        "client diagnostics initialized"
    );
    Ok(DiagnosticsGuard { _writer: guard })
}

fn build_appender(log_dir: &Path) -> Result<SizeAndDateRollingAppender, String> {
    SizeAndDateRollingAppender::new(
        log_dir,
        MAX_LOG_FILE_BYTES,
        MAX_LOG_FILES,
        utc_today as DateClock,
    )
    .map_err(|error| format!("could not open the rolling client log: {error}"))
}

type DateClock = fn() -> time::Date;

struct SizeAndDateRollingAppender<C = DateClock> {
    directory: PathBuf,
    current_date: time::Date,
    current_segment: u32,
    current_path: PathBuf,
    current_size: u64,
    max_file_bytes: u64,
    max_files: usize,
    file: File,
    clock: C,
}

impl<C> SizeAndDateRollingAppender<C>
where
    C: Fn() -> time::Date,
{
    fn new(directory: &Path, max_file_bytes: u64, max_files: usize, clock: C) -> io::Result<Self> {
        if max_file_bytes == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "log file byte limit must be greater than zero",
            ));
        }
        if max_files == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "retained log count must be greater than zero",
            ));
        }

        std::fs::create_dir_all(directory)?;
        let current_date = clock();
        let (current_segment, current_path, file, current_size) =
            Self::open_latest(directory, current_date, max_file_bytes)?;
        let mut appender = Self {
            directory: directory.to_path_buf(),
            current_date,
            current_segment,
            current_path,
            current_size,
            max_file_bytes,
            max_files,
            file,
            clock,
        };
        appender.prune_old_files()?;
        Ok(appender)
    }

    fn open_latest(
        directory: &Path,
        date: time::Date,
        max_file_bytes: u64,
    ) -> io::Result<(u32, PathBuf, File, u64)> {
        let mut segment = existing_segments(directory, date)?
            .into_iter()
            .max()
            .unwrap_or(0);
        let mut path = log_path(directory, date, segment);
        let existing_size = path.metadata().map(|metadata| metadata.len()).unwrap_or(0);
        if existing_size >= max_file_bytes {
            segment = segment.saturating_add(1);
            path = log_path(directory, date, segment);
        }
        let file = open_log_file(&path)?;
        let size = file.metadata()?.len();
        Ok((segment, path, file, size))
    }

    fn rotate_if_needed(&mut self) -> io::Result<()> {
        let today = (self.clock)();
        if today != self.current_date {
            let (segment, path, file, size) =
                Self::open_latest(&self.directory, today, self.max_file_bytes)?;
            self.current_date = today;
            self.current_segment = segment;
            self.current_path = path;
            self.file = file;
            self.current_size = size;
            self.prune_old_files()?;
        } else if self.current_size >= self.max_file_bytes {
            self.current_segment = self.current_segment.saturating_add(1);
            self.current_path = log_path(&self.directory, self.current_date, self.current_segment);
            self.file = open_log_file(&self.current_path)?;
            self.current_size = self.file.metadata()?.len();
            self.prune_old_files()?;
        }
        Ok(())
    }

    fn prune_old_files(&mut self) -> io::Result<()> {
        let mut files = client_log_files(&self.directory)?;
        files.sort_by(|left, right| {
            let left_is_current = left == &self.current_path;
            let right_is_current = right == &self.current_path;
            left_is_current
                .cmp(&right_is_current)
                .then_with(|| modified_time(left).cmp(&modified_time(right)))
                .then_with(|| left.cmp(right))
        });
        let remove_count = files.len().saturating_sub(self.max_files);
        for path in files.into_iter().take(remove_count) {
            std::fs::remove_file(path)?;
        }
        Ok(())
    }
}

impl<C> Write for SizeAndDateRollingAppender<C>
where
    C: Fn() -> time::Date,
{
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.rotate_if_needed()?;
        let remaining = self.max_file_bytes.saturating_sub(self.current_size);
        let write_len = usize::try_from(remaining)
            .unwrap_or(usize::MAX)
            .min(buffer.len());
        let written = self.file.write(&buffer[..write_len])?;
        self.current_size = self.current_size.saturating_add(written as u64);
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}

fn utc_today() -> time::Date {
    time::OffsetDateTime::now_utc().date()
}

fn log_path(directory: &Path, date: time::Date, segment: u32) -> PathBuf {
    let date = format!(
        "{:04}-{:02}-{:02}",
        date.year(),
        date.month() as u8,
        date.day()
    );
    let segment = if segment == 0 {
        String::new()
    } else {
        format!(".{segment}")
    };
    directory.join(format!("{LOG_FILE_PREFIX}{date}{segment}{LOG_FILE_SUFFIX}"))
}

fn open_log_file(path: &Path) -> io::Result<File> {
    OpenOptions::new().create(true).append(true).open(path)
}

fn existing_segments(directory: &Path, date: time::Date) -> io::Result<Vec<u32>> {
    let base_name = log_path(directory, date, 0)
        .file_name()
        .expect("generated log path has a file name")
        .to_string_lossy()
        .into_owned();
    let segment_prefix = base_name.trim_end_matches(LOG_FILE_SUFFIX);
    Ok(client_log_files(directory)?
        .into_iter()
        .filter_map(|path| {
            let name = path.file_name()?.to_str()?;
            if name == base_name {
                Some(0)
            } else {
                name.strip_prefix(segment_prefix)?
                    .strip_prefix('.')?
                    .strip_suffix(LOG_FILE_SUFFIX)?
                    .parse()
                    .ok()
            }
        })
        .collect())
}

fn client_log_files(directory: &Path) -> io::Result<Vec<PathBuf>> {
    Ok(std::fs::read_dir(directory)?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    name.starts_with(LOG_FILE_PREFIX) && name.ends_with(LOG_FILE_SUFFIX)
                })
        })
        .collect())
}

fn modified_time(path: &Path) -> Option<std::time::SystemTime> {
    path.metadata()
        .and_then(|metadata| metadata.modified())
        .ok()
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::sync::{Arc, Mutex};
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    #[test]
    fn rolling_writer_creates_a_client_log() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp_root = std::env::temp_dir();
        let directory = temp_root.join(format!(
            "faforever-client-diagnostics-test-{}-{unique}",
            std::process::id()
        ));
        let mut appender = build_appender(&directory).expect("appender");
        writeln!(appender, "diagnostic probe").expect("write log");
        appender.flush().expect("flush log");
        drop(appender);

        let files = std::fs::read_dir(&directory)
            .expect("log directory")
            .map(|entry| entry.unwrap().path())
            .collect::<Vec<_>>();
        assert_eq!(files.len(), 1);
        assert!(files[0]
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("faforever-client."));
        assert_eq!(
            files[0].extension().and_then(|ext| ext.to_str()),
            Some("log")
        );
        assert!(std::fs::read_to_string(&files[0])
            .expect("read log")
            .contains("diagnostic probe"));

        assert!(directory.starts_with(&temp_root));
        std::fs::remove_dir_all(directory).expect("remove isolated test directory");
    }

    #[test]
    fn rolling_writer_rotates_before_exceeding_the_byte_limit() {
        let directory = test_directory("size");
        let date = time::Date::from_calendar_date(2026, time::Month::August, 9).unwrap();
        let mut appender =
            SizeAndDateRollingAppender::new(&directory, 12, 7, move || date).expect("appender");

        appender.write_all(b"1234567890abcdefghijklmnop").unwrap();
        appender.flush().unwrap();
        drop(appender);

        let mut files = client_log_files(&directory).unwrap();
        files.sort();
        assert_eq!(files.len(), 3);
        assert!(files
            .iter()
            .all(|path| path.metadata().unwrap().len() <= 12));
        assert_eq!(
            files
                .iter()
                .map(|path| path.metadata().unwrap().len())
                .sum::<u64>(),
            26
        );
        remove_test_directory(directory);
    }

    #[test]
    fn rolling_writer_rotates_when_the_utc_date_changes() {
        let directory = test_directory("date");
        let first = time::Date::from_calendar_date(2026, time::Month::August, 9).unwrap();
        let second = first.next_day().unwrap();
        let clock = Arc::new(Mutex::new(first));
        let read_clock = Arc::clone(&clock);
        let mut appender = SizeAndDateRollingAppender::new(&directory, 100, 7, move || {
            *read_clock.lock().unwrap()
        })
        .expect("appender");

        appender.write_all(b"first day\n").unwrap();
        *clock.lock().unwrap() = second;
        appender.write_all(b"second day\n").unwrap();
        appender.flush().unwrap();
        drop(appender);

        let files = client_log_files(&directory).unwrap();
        assert_eq!(files.len(), 2);
        assert!(files
            .iter()
            .any(|path| path.to_string_lossy().contains("2026-08-09")));
        assert!(files
            .iter()
            .any(|path| path.to_string_lossy().contains("2026-08-10")));
        remove_test_directory(directory);
    }

    #[test]
    fn rolling_writer_retains_only_the_newest_seven_files() {
        let directory = test_directory("retention");
        std::fs::create_dir_all(&directory).unwrap();
        for day in 1..=9 {
            let path = directory.join(format!("faforever-client.2026-07-{day:02}.log"));
            std::fs::write(path, format!("day {day}")).unwrap();
        }
        let date = time::Date::from_calendar_date(2026, time::Month::August, 9).unwrap();
        let appender =
            SizeAndDateRollingAppender::new(&directory, 100, 7, move || date).expect("appender");
        let current = appender.current_path.clone();
        drop(appender);

        let files = client_log_files(&directory).unwrap();
        assert_eq!(files.len(), 7);
        assert!(files.contains(&current));
        remove_test_directory(directory);
    }

    fn test_directory(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "faforever-client-diagnostics-{label}-{}-{unique}",
            std::process::id()
        ))
    }

    fn remove_test_directory(directory: PathBuf) {
        assert!(directory.starts_with(std::env::temp_dir()));
        std::fs::remove_dir_all(directory).expect("remove isolated test directory");
    }
}
