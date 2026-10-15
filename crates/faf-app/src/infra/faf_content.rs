//! Shared discovery of the FAF user-content vault.
//!
//! The Java client stores maps and mods below a configurable vault root. Reuse
//! that root when it is available so installing multiple FAF clients does not
//! split one user's content across otherwise identical default directories.

use std::path::{Path, PathBuf};

/// Resolve the shared FAF vault root.
///
/// An explicit override always wins. Otherwise, reuse the Java client's
/// configured vault when its preferences are present and point at an existing
/// content root. After that, the first of the reference clients' default
/// locations that already holds maps or mods, so content another client put
/// there is found rather than started over next to it (issue 564). With none
/// of them in use, FAF's conventional Documents location.
pub(crate) fn vault_dir() -> PathBuf {
    if let Some(path) = crate::infra::paths::vault_dir() {
        return path;
    }
    if let Some(path) = non_empty_env_path("FAF_VAULT_DIR") {
        return path;
    }

    let candidates = default_vault_dirs();
    java_client_vault_dir()
        .filter(|path| holds_content(path))
        .or_else(|| candidates.iter().find(|path| holds_content(path)).cloned())
        .or_else(|| candidates.into_iter().next())
        .unwrap_or_else(|| PathBuf::from("."))
}

fn holds_content(path: &Path) -> bool {
    path.join("maps").is_dir() || path.join("mods").is_dir()
}

fn non_empty_env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

/// Where the Java client keeps `client.prefs`.
///
/// `%APPDATA%\Forged Alliance Forever` on Windows, and `~/.faforever` on every
/// other system: the Java client's `OsPosix.getPreferencesDirectory` is the
/// home directory's `.faforever`, not an XDG directory. Every reader of the
/// Java client's settings asks here, so the two systems cannot drift apart
/// again the way three hand-written copies of this path did (issue 564).
pub(crate) fn java_client_prefs_path() -> Option<PathBuf> {
    let dirs = directories::BaseDirs::new()?;
    Some(if cfg!(windows) {
        windows_java_client_prefs(dirs.config_dir())
    } else {
        posix_java_client_prefs(dirs.home_dir())
    })
}

/// The Java client's `client.prefs` on Windows, below `%APPDATA%`.
pub(crate) fn windows_java_client_prefs(app_data: &Path) -> PathBuf {
    app_data
        .join("Forged Alliance Forever")
        .join("client.prefs")
}

/// The Java client's `client.prefs` everywhere else, below the home directory.
pub(crate) fn posix_java_client_prefs(home: &Path) -> PathBuf {
    home.join(".faforever").join("client.prefs")
}

/// The Java client's settings as a document, when it has any.
pub(crate) fn java_client_prefs() -> Option<serde_json::Value> {
    let contents = std::fs::read_to_string(java_client_prefs_path()?).ok()?;
    serde_json::from_str(&contents).ok()
}

/// An absolute path the Java client's settings hold at `pointer`.
pub(crate) fn java_client_prefs_dir(pointer: &str) -> Option<PathBuf> {
    absolute_path_at(&java_client_prefs()?, pointer)
}

fn absolute_path_at(document: &serde_json::Value, pointer: &str) -> Option<PathBuf> {
    let raw = document.pointer(pointer)?.as_str()?.trim();
    if raw.is_empty() {
        return None;
    }
    let path = PathBuf::from(raw);
    path.is_absolute().then_some(path)
}

fn java_client_vault_dir() -> Option<PathBuf> {
    java_client_prefs_dir("/forgedAlliance/vaultBaseDirectory")
}

#[cfg(test)]
fn java_client_vault_dir_from_json(contents: &str) -> Option<PathBuf> {
    let value: serde_json::Value = serde_json::from_str(contents).ok()?;
    absolute_path_at(&value, "/forgedAlliance/vaultBaseDirectory")
}

/// The reference clients' default vault roots, the first of them being the
/// one a new vault is made in.
///
/// The Python client and this one put it under Documents. The Java client
/// does the same on Windows, but on every other system it is
/// `~/My Games/...`, straight under the home directory (`OsPosix`), so a
/// player coming from the Java client on Linux had a vault this client never
/// looked at.
fn default_vault_dirs() -> Vec<PathBuf> {
    let documents =
        directories::UserDirs::new().and_then(|dirs| dirs.document_dir().map(PathBuf::from));
    let home = directories::BaseDirs::new().map(|dirs| dirs.home_dir().to_path_buf());
    default_vault_dirs_in(cfg!(windows), documents.as_deref(), home.as_deref())
}

fn default_vault_dirs_in(
    windows: bool,
    documents: Option<&Path>,
    home: Option<&Path>,
) -> Vec<PathBuf> {
    let vault = |root: &Path| {
        root.join("My Games")
            .join("Gas Powered Games")
            .join("Supreme Commander Forged Alliance")
    };
    let mut dirs = vec![vault(documents.unwrap_or(Path::new(".")))];
    if !windows {
        if let Some(home) = home {
            let java = vault(home);
            if !dirs.contains(&java) {
                dirs.push(java);
            }
        }
    }
    dirs
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_java_client_vault_path() {
        let root = if cfg!(windows) {
            r#"C:\FAF Vault"#
        } else {
            "/tmp/faf-vault"
        };
        let json = format!(r#"{{"forgedAlliance":{{"vaultBaseDirectory":{root:?}}}}}"#);
        assert_eq!(
            java_client_vault_dir_from_json(&json),
            Some(PathBuf::from(root))
        );
    }

    #[test]
    fn rejects_relative_or_missing_java_vault_paths() {
        assert_eq!(
            java_client_vault_dir_from_json(
                r#"{"forgedAlliance":{"vaultBaseDirectory":"relative/vault"}}"#,
            ),
            None
        );
        assert_eq!(java_client_vault_dir_from_json("{}"), None);
    }

    #[test]
    fn finds_the_java_client_prefs_where_each_system_keeps_them() {
        assert_eq!(
            windows_java_client_prefs(Path::new("C:/Users/me/AppData/Roaming")),
            PathBuf::from("C:/Users/me/AppData/Roaming/Forged Alliance Forever/client.prefs")
        );
        // Not `~/.config`: the Java client's posix preferences directory is
        // `~/.faforever`.
        assert_eq!(
            posix_java_client_prefs(Path::new("/home/player")),
            PathBuf::from("/home/player/.faforever/client.prefs")
        );
    }

    #[test]
    fn offers_the_java_clients_linux_vault_after_the_documents_one() {
        let documents = Path::new("/home/player/Documents");
        let home = Path::new("/home/player");
        assert_eq!(
            default_vault_dirs_in(false, Some(documents), Some(home)),
            vec![
                PathBuf::from("/home/player/Documents/My Games/Gas Powered Games/Supreme Commander Forged Alliance"),
                PathBuf::from("/home/player/My Games/Gas Powered Games/Supreme Commander Forged Alliance"),
            ]
        );
        // On Windows every client agrees on Documents.
        assert_eq!(
            default_vault_dirs_in(true, Some(documents), Some(home)).len(),
            1
        );
    }
}
