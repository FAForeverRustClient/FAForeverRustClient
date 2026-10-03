//! The sounds a player added for notifications, as the settings service needs
//! them when one is removed: is a name one of ours, and delete its file.
//!
//! A port so the service never builds a path into the client's data directory
//! itself, and so a test removing a sound cannot delete a real one.

pub trait NotificationSoundsPort: Send + Sync {
    /// Whether `name` could be a sound this client stored: exactly one plain
    /// file name. A name out of a settings file is untrusted text.
    fn accepts(&self, name: &str) -> bool;

    /// Delete the stored sound. A sound that is already gone is not an error.
    fn remove(&self, name: &str) -> Result<(), String>;

    /// Whether the stored sound's file is there, for refusing a setting that
    /// would name one that is not. Defaults to "any acceptable name", which is
    /// what a port with no directory behind it can say.
    fn exists(&self, name: &str) -> bool {
        self.accepts(name)
    }
}
