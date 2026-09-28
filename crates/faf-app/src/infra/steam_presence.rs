//! Steam's "playing Supreme Commander: Forged Alliance", for exactly as long as
//! a game runs (issue 364).
//!
//! Steam counts a process as playing app N once that process has called
//! `SteamAPI_Init` as app N through Valve's `steam_api64.dll`, and stops when it
//! calls `SteamAPI_Shutdown` or exits. The Java client makes that call from the
//! client itself, once, at startup (`SteamService`), which is why its status and
//! the hours Steam records cover the client being open rather than a game being
//! played. That is the complaint the issue was opened with.
//!
//! Here the call is made by a helper: this client's own executable started again
//! with [`HELPER_FLAG`], which loads the DLL, signs in as app
//! [`FORGED_ALLIANCE_APP_ID`], and waits on the game's process handle. When the
//! game exits, the helper shuts the API down and exits too, and the status goes
//! with it. A separate process rather than this one, for three reasons:
//!
//! * `SteamAPI_Init` loads Steam's own `steamclient64.dll` into whichever process
//!   calls it. That should not be the process holding the player's session and
//!   the webview.
//! * Valve does not support initialising again after a shutdown in the same
//!   process, and one client runs many games.
//! * A helper that dies for any reason takes the status with it. A flag in this
//!   process could outlive the game it was about.
//!
//! Off unless the player turns it on (`GamePreferences::steam_presence`),
//! Windows only, and quiet when it cannot work: no library in this build, Steam
//! not running, or Forged Alliance not in the signed-in account's library. Each
//! of those is a log line, never a message to the player, because none of them
//! is something going wrong with the game.
//!
//! The DLL is Valve's and is not covered by this client's MIT licence: it is
//! redistributed under the Steamworks SDK Access Agreement, see
//! `vendor/steamworks/README.md`. Nothing here talks to Steam except through
//! that library, which is what the agreement's section 2.4 asks.

/// Supreme Commander: Forged Alliance on Steam. The same id the Java client
/// signs in as, from its `steam_appid.txt`.
pub const FORGED_ALLIANCE_APP_ID: u32 = 9420;

/// The first argument that makes this executable the helper instead of the
/// client. See [`run_helper_if_asked`].
pub const HELPER_FLAG: &str = "--steam-presence";

/// Valve's library, as the SDK's `redistributable_bin/win64` names it.
#[cfg(windows)]
const LIBRARY_NAME: &str = "steam_api64.dll";

/// Where Valve's library is, if this build carries it.
///
/// `FAF_STEAM_API_PATH` first, which the shell sets to the copy bundled under
/// the resource directory, then the same few roots every other bundled helper
/// is searched in: `natives/steam/` is where the installer puts it, and
/// `vendor/steamworks/win64/` is where it is kept in the repository, which is
/// what a development build finds.
#[cfg(windows)]
pub(crate) fn library_path() -> Option<std::path::PathBuf> {
    use std::path::PathBuf;

    if let Some(path) = std::env::var_os("FAF_STEAM_API_PATH").filter(|path| !path.is_empty()) {
        let path = PathBuf::from(path);
        return path.is_file().then_some(path);
    }
    super::helper_search_roots()
        .into_iter()
        .flat_map(|root| {
            [
                root.join("natives").join("steam").join(LIBRARY_NAME),
                root.join("vendor")
                    .join("steamworks")
                    .join("win64")
                    .join(LIBRARY_NAME),
            ]
        })
        .find(|candidate| candidate.is_file())
}

/// Show the game running as `game_pid` on Steam until it exits.
///
/// Returns at once. The helper ends by itself when the game does, so nothing
/// has to stop it, and what it reported is logged when it has gone.
#[cfg(windows)]
pub(crate) fn start(game_pid: u32) {
    use std::process::Stdio;

    let Some(library) = library_path() else {
        tracing::info!("Steam status is on, but this build carries no Steamworks library");
        return;
    };
    let executable = match std::env::current_exe() {
        Ok(executable) => executable,
        Err(error) => {
            tracing::warn!(%error, "cannot start the Steam status helper");
            return;
        }
    };
    let mut command = tokio::process::Command::new(executable);
    command
        .arg(HELPER_FLAG)
        .arg(&library)
        .arg(game_pid.to_string())
        // How the library learns which app it is. Steam sets both for a game
        // it launches itself; `steam_appid.txt` is the other way, and would
        // have to be written beside a working directory.
        .env("SteamAppId", FORGED_ALLIANCE_APP_ID.to_string())
        .env("SteamGameId", FORGED_ALLIANCE_APP_ID.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    super::hide_console(&mut command);
    let child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            tracing::warn!(%error, "cannot start the Steam status helper");
            return;
        }
    };
    tracing::info!(game_pid, "Steam status helper started");
    tokio::spawn(async move {
        match child.wait_with_output().await {
            Ok(output) => {
                let reason = String::from_utf8_lossy(&output.stderr);
                match output.status.code() {
                    Some(0) => tracing::info!("Steam status cleared: the game ended"),
                    code => tracing::info!(
                        ?code,
                        reason = %reason.trim(),
                        "Steam status helper ended without showing a status"
                    ),
                }
            }
            Err(error) => tracing::warn!(%error, "lost track of the Steam status helper"),
        }
    });
}

/// Nowhere but Windows: the status comes from a Windows DLL, and a game run
/// through Wine is not a process Steam on the host would be watching anyway.
#[cfg(not(windows))]
pub(crate) fn start(_game_pid: u32) {}

/// Run as the helper if this process was started as one.
///
/// `arguments` is the process's own, program name first. `None` means this is
/// the client, which carries on starting; `Some` is the helper's exit code,
/// once the game it was watching has gone. The shell asks before anything else
/// it does, because the helper must neither open a window nor hand itself to a
/// running client as a second instance.
pub fn run_helper_if_asked(arguments: &[String]) -> Option<i32> {
    if arguments.get(1).map(String::as_str) != Some(HELPER_FLAG) {
        return None;
    }
    Some(helper::run(arguments.get(2), arguments.get(3)))
}

/// What the helper's exit code says. Only [`Exit::GameEnded`] ever showed a
/// status; the rest are the reasons it could not.
///
/// Each platform's helper constructs only its own half of these.
#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(i32)]
enum Exit {
    GameEnded = 0,
    Usage = 2,
    GameGone = 3,
    NoLibrary = 4,
    NoEntryPoint = 5,
    SteamRefused = 6,
    Unsupported = 7,
}

fn report(message: &str) {
    use std::io::Write as _;
    // The client reads this from the pipe and logs it. There is no console to
    // write to otherwise, so a failed write has nowhere better to go either.
    let _ = writeln!(std::io::stderr(), "{message}");
}

#[cfg(windows)]
mod helper {
    use std::ffi::{c_char, c_void, CStr};
    use std::os::windows::ffi::OsStrExt as _;
    use std::path::Path;

    use super::{report, Exit};

    type Handle = isize;

    /// From `winnt.h`: the one right needed to wait on a process.
    const SYNCHRONIZE: u32 = 0x0010_0000;
    /// From `winbase.h`.
    const WAIT_TIMEOUT: u32 = 0x0000_0102;
    /// How often the helper looks up from waiting to let the library run its
    /// callbacks. The status needs none, but Valve asks every process that
    /// initialises the API to pump them, and once a second costs nothing.
    const POLL_MILLISECONDS: u32 = 1_000;
    /// `SteamErrMsg` in the SDK's `steam_api_common.h`.
    const ERROR_MESSAGE_LENGTH: usize = 1024;

    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, process_id: u32) -> Handle;
        fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
        fn CloseHandle(handle: Handle) -> i32;
        fn LoadLibraryW(file_name: *const u16) -> Handle;
        fn GetProcAddress(module: Handle, name: *const c_char) -> *mut c_void;
    }

    /// `SteamAPI_InitFlat`, the entry point of every SDK since 1.59: zero is
    /// success, anything else fills the message buffer with Steam's reason.
    type InitFlat = unsafe extern "C" fn(message: *mut c_char) -> i32;
    /// `SteamAPI_Init` as older libraries export it.
    type InitLegacy = unsafe extern "C" fn() -> bool;
    /// `SteamAPI_RunCallbacks` and `SteamAPI_Shutdown`.
    type Procedure = unsafe extern "C" fn();

    /// Closes the game handle however the helper leaves.
    struct Process(Handle);

    impl Drop for Process {
        fn drop(&mut self) {
            // Sound: the handle came from a successful `OpenProcess` and is
            // closed exactly once, here.
            unsafe { CloseHandle(self.0) };
        }
    }

    fn symbol(module: Handle, name: &CStr) -> Option<*mut c_void> {
        // Sound: `module` is a loaded library that is never unloaded, and
        // `name` is a nul-terminated string that outlives the call.
        let address = unsafe { GetProcAddress(module, name.as_ptr()) };
        (!address.is_null()).then_some(address)
    }

    pub(super) fn run(library: Option<&String>, game_pid: Option<&String>) -> i32 {
        let (Some(library), Some(game_pid)) =
            (library, game_pid.and_then(|pid| pid.parse::<u32>().ok()))
        else {
            report("usage: --steam-presence <steam_api64.dll> <game process id>");
            return Exit::Usage as i32;
        };

        // The game first. If it has already gone there is nothing to show, and
        // holding its handle from here on means a process id reused by
        // something else later cannot keep the status alive.
        //
        // Sound: plain integer arguments; a failure returns a null handle.
        let game = unsafe { OpenProcess(SYNCHRONIZE, 0, game_pid) };
        if game == 0 {
            report("the game is not running");
            return Exit::GameGone as i32;
        }
        let game = Process(game);

        let wide: Vec<u16> = Path::new(library)
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        // Sound: `wide` is a nul-terminated UTF-16 path that outlives the call.
        // The library stays loaded until the process exits.
        let module = unsafe { LoadLibraryW(wide.as_ptr()) };
        if module == 0 {
            report(&format!("cannot load {library}"));
            return Exit::NoLibrary as i32;
        }

        if let Some(init) = symbol(module, c"SteamAPI_InitFlat") {
            // Sound: the export has this signature in every SDK that has it.
            let init = unsafe { std::mem::transmute::<*mut c_void, InitFlat>(init) };
            let mut message: [c_char; ERROR_MESSAGE_LENGTH] = [0; ERROR_MESSAGE_LENGTH];
            // Sound: the buffer is the size the SDK declares for it, and the
            // library writes a nul-terminated message of at most that length.
            let result = unsafe { init(message.as_mut_ptr()) };
            if result != 0 {
                // Sound: zero-initialised and written nul-terminated, so a
                // terminator is always inside the buffer.
                let reason = unsafe { CStr::from_ptr(message.as_ptr()) };
                report(&format!(
                    "Steam refused (result {result}): {}",
                    reason.to_string_lossy()
                ));
                return Exit::SteamRefused as i32;
            }
        } else if let Some(init) = symbol(module, c"SteamAPI_Init") {
            // Sound: the export has this signature in every SDK that has it.
            let init = unsafe { std::mem::transmute::<*mut c_void, InitLegacy>(init) };
            // Sound: no arguments; the library reports failure as `false`.
            if !unsafe { init() } {
                report("Steam refused: it is not running, or Forged Alliance is not in this account's library");
                return Exit::SteamRefused as i32;
            }
        } else {
            report(&format!("{library} exports no Steam API entry point"));
            return Exit::NoEntryPoint as i32;
        }

        // Sound, for both: the exports take no arguments and have this
        // signature in every SDK; they are only called after a successful init.
        let run_callbacks = symbol(module, c"SteamAPI_RunCallbacks")
            .map(|address| unsafe { std::mem::transmute::<*mut c_void, Procedure>(address) });
        let shutdown = symbol(module, c"SteamAPI_Shutdown")
            .map(|address| unsafe { std::mem::transmute::<*mut c_void, Procedure>(address) });

        // Anything but a timeout ends the wait: the game exited, or the handle
        // stopped being waitable, and in both cases there is no game left to
        // show.
        //
        // Sound: `game.0` is an open process handle with `SYNCHRONIZE` access.
        while unsafe { WaitForSingleObject(game.0, POLL_MILLISECONDS) } == WAIT_TIMEOUT {
            if let Some(run_callbacks) = run_callbacks {
                // Sound: see above.
                unsafe { run_callbacks() };
            }
        }
        if let Some(shutdown) = shutdown {
            // Sound: see above; called once, after the last callback.
            unsafe { shutdown() };
        }
        Exit::GameEnded as i32
    }
}

#[cfg(not(windows))]
mod helper {
    use super::{report, Exit};

    pub(super) fn run(_library: Option<&String>, _game_pid: Option<&String>) -> i32 {
        report("Steam status is only available on Windows");
        Exit::Unsupported as i32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn arguments(list: &[&str]) -> Vec<String> {
        list.iter().map(|argument| argument.to_string()).collect()
    }

    #[test]
    fn the_client_is_not_the_helper() {
        assert_eq!(run_helper_if_asked(&arguments(&["faf.exe"])), None);
        assert_eq!(
            run_helper_if_asked(&arguments(&["faf.exe", "replay.fafreplay"])),
            None
        );
        // Only as the first argument: a replay path that happens to follow
        // the flag's spelling somewhere later is still the client.
        assert_eq!(
            run_helper_if_asked(&arguments(&["faf.exe", "x", HELPER_FLAG])),
            None
        );
    }

    #[test]
    fn a_helper_without_a_game_exits_without_showing_anything() {
        let code = run_helper_if_asked(&arguments(&["faf.exe", HELPER_FLAG]));
        assert!(matches!(code, Some(code) if code != Exit::GameEnded as i32));
    }
}
