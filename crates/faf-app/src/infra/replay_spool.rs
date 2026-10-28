//! One disk-backed replay stream shared by capture, compression and reconnects.
use std::sync::Arc;

use tokio::io::AsyncWriteExt;
use tokio::sync::watch;

#[derive(Clone, Copy, Default)]
pub(super) struct Progress {
    pub len: u64,
    pub finished: bool,
}

#[derive(Clone)]
pub(super) struct ReplaySpool {
    file: Arc<tempfile::NamedTempFile>,
    progress: watch::Receiver<Progress>,
}

pub(super) struct SpoolWriter {
    file: tokio::fs::File,
    progress: watch::Sender<Progress>,
    _spool: ReplaySpool,
}

impl ReplaySpool {
    pub async fn create() -> Result<(Self, SpoolWriter), String> {
        let (file, writer) = tokio::task::spawn_blocking(|| {
            let root = std::env::temp_dir().join(super::APP_SLUG);
            std::fs::create_dir_all(&root)?;
            let file = tempfile::Builder::new()
                .prefix(".faf-replay-")
                .rand_bytes(16)
                .tempfile_in(root)?;
            let writer = file.reopen()?;
            Ok::<_, std::io::Error>((file, writer))
        })
        .await
        .map_err(|_| "replay spool worker stopped".to_string())?
        .map_err(|error| format!("could not create replay spool: {error}"))?;
        let (tx, rx) = watch::channel(Progress::default());
        let spool = Self {
            file: Arc::new(file),
            progress: rx,
        };
        let writer = SpoolWriter {
            file: tokio::fs::File::from_std(writer),
            progress: tx,
            _spool: spool.clone(),
        };
        Ok((spool, writer))
    }

    pub fn progress(&self) -> Progress {
        *self.progress.borrow()
    }

    pub async fn changed(&mut self) {
        let _ = self.progress.changed().await;
    }

    pub fn open(&self) -> std::io::Result<std::fs::File> {
        // A separate open gives every reader its own cursor on all platforms.
        self.file.reopen()
    }

    pub async fn open_async(&self) -> std::io::Result<tokio::fs::File> {
        tokio::fs::File::open(self.file.path()).await
    }
}

impl SpoolWriter {
    pub async fn append(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        self.file.write_all(bytes).await?;
        // Publish only bytes already available to independent readers.
        self.file.flush().await?;
        self.progress
            .send_modify(|state| state.len += bytes.len() as u64);
        Ok(())
    }
}

impl Drop for SpoolWriter {
    fn drop(&mut self) {
        self.progress.send_modify(|state| state.finished = true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[tokio::test]
    async fn readers_reopen_the_complete_stream_with_independent_cursors() {
        let (spool, mut writer) = ReplaySpool::create().await.unwrap();
        writer.append(b"first").await.unwrap();
        let mut first = spool.open().unwrap();
        writer.append(b" second").await.unwrap();
        drop(writer);
        assert_eq!(spool.progress().len, 12);
        assert!(spool.progress().finished);
        for reader in [&mut first, &mut spool.open().unwrap()] {
            let mut bytes = Vec::new();
            reader.read_to_end(&mut bytes).unwrap();
            assert_eq!(bytes, b"first second");
        }
    }
}
