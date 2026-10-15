//! Training catalogue boundary.
//!
//! Reads, plus the lessons: installing one into the maps folder, and the
//! results the player keeps on this machine. The two write-shaped things the
//! training hub does (requesting a replay review, submitting content) do not
//! cross a port at all: they compose a forum post the player sends
//! themselves, because FAF has no endpoint that would accept either and
//! posting in someone's name is not something this client does. See
//! `faf_domain::state::training`.

use std::collections::BTreeMap;
use std::path::PathBuf;

use async_trait::async_trait;
use faf_domain::state::{LessonPackage, LessonRecord, TrainingCatalogue};

#[async_trait]
pub trait TrainingPort: Send + Sync {
    /// The catalogue of training material and the community destinations.
    ///
    /// Infallible in practice: an implementation that cannot reach its manifest
    /// falls back to the last copy it fetched, or to what shipped with the
    /// client, and says which through [`TrainingCatalogue::source`]. The
    /// `Result` is here for the case where even that is unusable, which is a
    /// packaging bug rather than a runtime condition.
    ///
    /// `refresh` is the player asking for the newest document: an
    /// implementation goes past any cache between it and the source, which an
    /// ordinary visit does not.
    async fn list_catalogue(&self, refresh: bool) -> Result<TrainingCatalogue, String>;

    /// The Markdown of a guide this build hosts, by its catalogue url.
    ///
    /// Fallible where [`Self::list_catalogue`] is not: there is no shipped copy
    /// of somebody's guide to fall back to, and a reader who is told the fetch
    /// failed can still press the button that opens it in a browser.
    ///
    /// The url is checked against the repository this build trusts before any
    /// request is made. It arrives from a manifest, and a manifest is remote
    /// content: without that check an entry could name any address it liked and
    /// have the client fetch it.
    async fn read_guide(&self, url: String) -> Result<String, String>;

    /// The `faf-bo/1` envelope of a recorded run, by its catalogue url.
    ///
    /// Guarded exactly as [`Self::read_guide`] is, and separate from it so the
    /// two cannot be served in each other's place: one is rendered as prose and
    /// the other as a chart. A run is also allowed to be much larger, because a
    /// recording of a long game is a position sample per second per unit.
    async fn read_recording(&self, url: String) -> Result<String, String>;

    /// Put a catalogue lesson's files where the game looks for maps.
    ///
    /// Downloaded fresh on every start, so a lesson fixed in the repository is
    /// fixed for the next run. Addresses are built from the package's names
    /// inside the repository this build trusts, never taken from the manifest.
    ///
    /// The default refuses, which is the honest answer for a double that has
    /// nowhere to put a map.
    async fn install_lesson(&self, _lesson: LessonPackage) -> Result<(), String> {
        Err("this build cannot install lessons".into())
    }

    /// The player's lesson results kept on this machine, by resource id.
    async fn lesson_records(&self) -> Result<BTreeMap<String, LessonRecord>, String> {
        Ok(BTreeMap::new())
    }

    /// Replace the kept lesson results.
    async fn save_lesson_records(
        &self,
        _records: BTreeMap<String, LessonRecord>,
    ) -> Result<(), String> {
        Ok(())
    }

    /// The text of the game log a lesson run wrote, for its result line.
    async fn read_lesson_log(&self, _path: PathBuf) -> Result<String, String> {
        Err("this build cannot read game logs".into())
    }
}
