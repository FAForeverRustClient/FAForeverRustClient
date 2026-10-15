//! Handing a URL to the system browser.
//!
//! `open::that` is right on Windows and macOS and wrong twice over on Linux,
//! which is where a sign-in sat on "Signing in..." with no browser and no
//! error (issue 560):
//!
//! - It waits for the launcher to exit. `xdg-open` returns at once when it
//!   hands the URL to a running browser, but when it starts the browser itself
//!   it can stay until the browser closes, and the sign-in waited with it.
//! - From an AppImage the launcher inherits the bundle's environment: its
//!   `GTK_PATH`, `GIO_MODULE_DIR`, `GDK_PIXBUF_MODULE_FILE` and the rest point
//!   the system's browser at the bundle's GTK modules, built against other
//!   library versions, and `GDK_BACKEND=x11` forces it off Wayland. The player
//!   ran `xdg-open` from a terminal and it worked: that shell did not have any
//!   of it.
//!
//! So on Linux the launcher gets the environment the player's session had,
//! and a launcher that is still running after a moment is left to it: it has
//! the URL either way.

use std::io;

/// Open `url` in the user's browser.
pub(crate) fn open_url(url: &str) -> io::Result<()> {
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        linux::open_url(url)
    }
    #[cfg(not(all(unix, not(target_os = "macos"))))]
    {
        open::that(url)
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
mod linux {
    use std::ffi::{OsStr, OsString};
    use std::io;
    use std::path::{Path, PathBuf};
    use std::process::Stdio;
    use std::time::{Duration, Instant};

    /// How long a launcher has to say it failed before it is taken to have
    /// started the browser in the foreground.
    const LAUNCHER_VERDICT: Duration = Duration::from_secs(3);

    /// What an AppImage's own start-up sets for the bundle alone: the
    /// linuxdeploy GTK hook's variables, the loader's, and the runtime's
    /// markers. None of it means anything to a program outside the bundle.
    const BUNDLE_VARIABLES: &[&str] = &[
        "LD_LIBRARY_PATH",
        "LD_PRELOAD",
        "GTK_PATH",
        "GTK_EXE_PREFIX",
        "GTK_DATA_PREFIX",
        "GTK_THEME",
        "GTK_IM_MODULE_FILE",
        "GDK_PIXBUF_MODULE_FILE",
        "GDK_BACKEND",
        "GIO_MODULE_DIR",
        "GSETTINGS_SCHEMA_DIR",
        "GI_TYPELIB_PATH",
        "PYTHONHOME",
        "PYTHONPATH",
        "PERLLIB",
        "QT_PLUGIN_PATH",
        "APPDIR",
        "APPIMAGE",
        "ARGV0",
        "OWD",
    ];

    /// Search paths the bundle put its own directories in front of. Its
    /// entries come out and the player's stay, so the system's `xdg-open`
    /// finds the system's handlers.
    const BUNDLE_SEARCH_PATHS: &[&str] = &["PATH", "XDG_DATA_DIRS", "XDG_CONFIG_DIRS"];

    pub(super) fn open_url(url: &str) -> io::Result<()> {
        let bundle = bundle_dir();
        let changes = bundle
            .as_deref()
            .map(|bundle| environment_outside(bundle, std::env::vars_os()))
            .unwrap_or_default();

        let mut last_error = None;
        for mut command in open::commands(url) {
            for (name, value) in &changes {
                match value {
                    Some(value) => command.env(name, value),
                    None => command.env_remove(name),
                };
            }
            command
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            let program = command.get_program().to_string_lossy().into_owned();
            let mut child = match command.spawn() {
                Ok(child) => child,
                // Not installed: the next launcher.
                Err(error) => {
                    last_error = Some(error);
                    continue;
                }
            };
            let deadline = Instant::now() + LAUNCHER_VERDICT;
            loop {
                match child.try_wait() {
                    Ok(Some(status)) if status.success() => return Ok(()),
                    Ok(Some(status)) => {
                        last_error = Some(io::Error::other(format!("{program} failed: {status}")));
                        break;
                    }
                    Ok(None) if Instant::now() >= deadline => {
                        // Still running, so it is the browser or is waiting on
                        // it. Reaped when it ends, without holding sign-in.
                        std::thread::spawn(move || {
                            let _ = child.wait();
                        });
                        return Ok(());
                    }
                    Ok(None) => std::thread::sleep(Duration::from_millis(50)),
                    Err(error) => {
                        last_error = Some(error);
                        break;
                    }
                }
            }
        }
        Err(last_error.unwrap_or_else(|| io::Error::other("no launcher could open the link")))
    }

    /// The AppImage this client runs from, when it does: `APPDIR` set by the
    /// AppImage runtime (or the extracted `AppRun`) and this executable inside
    /// it. A stray `APPDIR` in an ordinary session changes nothing.
    fn bundle_dir() -> Option<PathBuf> {
        let dir = PathBuf::from(std::env::var_os("APPDIR")?);
        let exe = std::env::current_exe().ok()?;
        exe.starts_with(&dir).then_some(dir)
    }

    /// What to change in `environment` for a program outside `bundle`: each
    /// variable to set to a new value, or to remove (`None`).
    pub(super) fn environment_outside(
        bundle: &Path,
        environment: impl IntoIterator<Item = (OsString, OsString)>,
    ) -> Vec<(OsString, Option<OsString>)> {
        let mut changes = Vec::new();
        for (name, value) in environment {
            let Some(key) = name.to_str() else { continue };
            if BUNDLE_VARIABLES.contains(&key) {
                changes.push((name, None));
            } else if BUNDLE_SEARCH_PATHS.contains(&key) {
                let mut joined = OsString::new();
                for entry in split_search_path(&value)
                    .filter(|entry| !entry.is_empty() && !Path::new(entry).starts_with(bundle))
                {
                    if !joined.is_empty() {
                        joined.push(":");
                    }
                    joined.push(entry);
                }
                if joined != value {
                    changes.push((name, (!joined.is_empty()).then_some(joined)));
                }
            }
        }
        changes
    }

    fn split_search_path(value: &OsStr) -> impl Iterator<Item = &OsStr> {
        use std::os::unix::ffi::OsStrExt;
        value
            .as_bytes()
            .split(|byte| *byte == b':')
            .map(OsStr::from_bytes)
    }
}

#[cfg(all(test, unix, not(target_os = "macos")))]
mod tests {
    use super::linux::environment_outside;
    use std::ffi::OsString;
    use std::path::Path;

    fn pair(name: &str, value: &str) -> (OsString, OsString) {
        (name.into(), value.into())
    }

    #[test]
    fn the_browser_gets_the_session_without_the_bundle() {
        let bundle = Path::new("/tmp/.mount_FAForeABC");
        let changes = environment_outside(
            bundle,
            [
                pair("GTK_PATH", "/tmp/.mount_FAForeABC/usr/lib/gtk-3.0"),
                pair("GDK_BACKEND", "x11"),
                pair("APPDIR", "/tmp/.mount_FAForeABC"),
                pair(
                    "PATH",
                    "/tmp/.mount_FAForeABC/usr/bin:/usr/local/bin:/usr/bin",
                ),
                pair(
                    "XDG_DATA_DIRS",
                    "/tmp/.mount_FAForeABC/usr/share:/usr/share",
                ),
                pair("HOME", "/home/player"),
                pair("BROWSER", "zen-browser"),
            ],
        );
        let get = |name: &str| {
            changes
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.clone())
        };
        assert_eq!(get("GTK_PATH"), Some(None));
        assert_eq!(get("GDK_BACKEND"), Some(None));
        assert_eq!(get("APPDIR"), Some(None));
        assert_eq!(get("PATH"), Some(Some("/usr/local/bin:/usr/bin".into())));
        assert_eq!(get("XDG_DATA_DIRS"), Some(Some("/usr/share".into())));
        // The player's own settings stay as they are.
        assert_eq!(get("HOME"), None);
        assert_eq!(get("BROWSER"), None);
    }

    #[test]
    fn a_search_path_of_bundle_entries_only_is_removed() {
        let changes = environment_outside(
            Path::new("/opt/app"),
            [pair("XDG_CONFIG_DIRS", "/opt/app/etc/xdg")],
        );
        assert_eq!(changes, vec![("XDG_CONFIG_DIRS".into(), None)]);
    }
}
