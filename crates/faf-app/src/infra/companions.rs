//! Companion programs: tools of the player's own started alongside Forged
//! Alliance (Settings, Game), such as a recording tool.
//!
//! The game launcher calls in here around every process it starts, games and
//! replays alike, so no launch path can forget them. Three rules hold
//! throughout:
//!
//! * A companion never holds up or fails a launch. Whatever goes wrong is a
//!   [`CompanionRun`] on the report channel: a line in the log, a result in
//!   Settings and at most a notification.
//! * What runs is only ever an entry from the settings. Nothing a game, a
//!   replay or the server sends names a program, and an entry is started
//!   with the player's own rights, without a shell and without a console
//!   window.
//! * The client keeps the process it started for each entry and starts the
//!   entry again only once that process has gone, and "close when the game
//!   exits" closes that process and nothing else. Another copy of the same
//!   program, started by anybody else, is never touched.
//!
//! The operating system's half is behind [`ProgramHost`], so the decisions
//! above are tested without starting anything.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use faf_domain::state::{
    CompanionLaunchKind, CompanionOutcome, CompanionProgram, CompanionRun, CompanionTiming,
};
use tokio::sync::mpsc;

use super::game::split_command;

/// What starting one entry means: the executable, its arguments, and where.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SpawnPlan {
    pub program: PathBuf,
    pub arguments: Vec<String>,
    pub working_dir: PathBuf,
}

/// The operating system, as far as companion programs need one.
pub(crate) trait ProgramHost: Send + Sync {
    /// Start the program, or say why it could not be started.
    fn spawn(&self, plan: &SpawnPlan) -> Result<Box<dyn RunningProgram>, String>;
    /// Whether a process with this executable file name is running.
    fn image_running(&self, image: &str) -> bool;
}

/// A program the client started and still holds.
///
/// Held by handle rather than by process id, so a process that exited and
/// whose id Windows handed to something else is never mistaken for it.
pub(crate) trait RunningProgram: Send {
    fn pid(&self) -> u32;
    fn is_running(&mut self) -> bool;
    /// Ask it to close, give it a moment, then end it. Blocks for up to a few
    /// seconds, so it is only called off the async runtime.
    fn close(&mut self);
}

/// One game or replay launch, as the launcher numbers them. A companion is
/// held by the launches that use it and closed with the last of them.
pub type LaunchId = u64;

/// A started program, shared so a close can wait for it without holding the
/// list.
type SharedProgram = Arc<Mutex<Box<dyn RunningProgram>>>;

/// One process the client started for an entry.
struct Tracked {
    /// Shared so a close can wait for the program without holding the list:
    /// a start for the next launch must not wait behind it.
    program: SharedProgram,
    pid: u32,
    /// The entry as it was when started, for when it has since been removed
    /// from the settings.
    entry: CompanionProgram,
    /// The launches using it right now. A Test start belongs to none until a
    /// launch that comes with it finds it running.
    owners: HashSet<LaunchId>,
    /// Being closed for the launch that last held it. Still tracked, so a
    /// start meanwhile does not put a second copy beside the one going away.
    closing: bool,
    /// Asked for while closing, by a launch or a Test start: started again
    /// once the old process has gone.
    wanted_again: bool,
}

/// The companion programs and the processes the client started for them.
pub struct Companions {
    host: Box<dyn ProgramHost>,
    entries: Mutex<Vec<CompanionProgram>>,
    tracked: Mutex<HashMap<String, Tracked>>,
    reports: mpsc::UnboundedSender<CompanionRun>,
    receiver: Mutex<Option<mpsc::UnboundedReceiver<CompanionRun>>>,
}

impl Companions {
    pub(crate) fn new(host: Box<dyn ProgramHost>) -> Self {
        let (reports, receiver) = mpsc::unbounded_channel();
        Self {
            host,
            entries: Mutex::new(Vec::new()),
            tracked: Mutex::new(HashMap::new()),
            reports,
            receiver: Mutex::new(Some(receiver)),
        }
    }

    /// Companions started on this machine.
    pub fn system() -> Self {
        Self::new(Box::new(SystemHost))
    }

    /// Replace the entries. A process already started for an entry stays
    /// tracked, under its id, whatever the entry now says.
    pub fn set_entries(&self, entries: Vec<CompanionProgram>) {
        *self.entries.lock().unwrap() = entries;
    }

    /// The reports of every start, skip, failure and close from here on.
    /// There is one receiver: a second call gets a channel that is already
    /// closed.
    pub fn take_reports(&self) -> mpsc::UnboundedReceiver<CompanionRun> {
        self.receiver.lock().unwrap().take().unwrap_or_else(|| {
            let (_closed, receiver) = mpsc::unbounded_channel();
            receiver
        })
    }

    /// Start every enabled entry that comes with this launch at this point
    /// of it, as `launch`'s, or take a running one over for it. Returns at
    /// once; each result goes to the report channel.
    ///
    /// An entry without a program is one still being filled in, and is
    /// skipped without a word: reporting it would raise a failure on every
    /// game until the player got round to it.
    pub fn start_with(&self, kind: CompanionLaunchKind, timing: CompanionTiming, launch: LaunchId) {
        let entries: Vec<CompanionProgram> = self
            .entries
            .lock()
            .unwrap()
            .iter()
            .filter(|entry| {
                entry.enabled
                    && entry.timing == timing
                    && entry.launches.covers(kind)
                    && !entry.program.trim().is_empty()
            })
            .cloned()
            .collect();
        for entry in entries {
            let run = self.start(&entry, HashSet::from([launch]), false);
            self.report(run);
        }
    }

    /// Start one entry now, whatever it is set to come with: Settings' "Test
    /// start". Tracked like any other start, so the next game does not start
    /// a second copy, and held by no launch until one finds it running. The
    /// result is returned rather than reported.
    pub fn start_now(&self, entry: &CompanionProgram) -> CompanionRun {
        let run = self.start(entry, HashSet::new(), true);
        log_run(&run);
        run
    }

    /// `launch` has ended. It lets go of every companion it held, and each
    /// one no other launch still holds is closed if its entry asks for that.
    /// A program the next launch took over before this ran is that launch's
    /// now, and stays.
    ///
    /// Blocking: each close waits a moment for the program to go. The
    /// launcher calls this on a thread of its own.
    pub fn launch_ended(&self, launch: LaunchId) {
        let entries = self.entries.lock().unwrap().clone();
        let closing: Vec<(String, SharedProgram, CompanionProgram)> = {
            let mut tracked = self.tracked.lock().unwrap();
            tracked
                .iter_mut()
                .filter_map(|(id, started)| {
                    if !started.owners.remove(&launch)
                        || !started.owners.is_empty()
                        || started.closing
                    {
                        return None;
                    }
                    // The entry as it is now when it is still there, so
                    // turning the switch off during a game is honoured.
                    let entry = entries
                        .iter()
                        .find(|entry| &entry.id == id)
                        .unwrap_or(&started.entry);
                    if !entry.close_with_game {
                        return None;
                    }
                    started.closing = true;
                    Some((id.clone(), Arc::clone(&started.program), entry.clone()))
                })
                .collect()
        };
        for (id, program, entry) in closing {
            let closed = {
                let mut program = program.lock().unwrap();
                program.is_running().then(|| {
                    let pid = program.pid();
                    program.close();
                    pid
                })
            };
            // Decided under the list's lock, so a start racing this sees
            // either the closing entry or none, never a gap.
            let again = {
                let mut tracked = self.tracked.lock().unwrap();
                match tracked.get(&id) {
                    Some(started) if Arc::ptr_eq(&started.program, &program) => {
                        let started = tracked.remove(&id).expect("just looked up");
                        // The entry as it is saved now, not as it was when
                        // the close began: a program or arguments saved in
                        // between are what is started. Removed meanwhile, it
                        // is not started at all; switched off, only a Test
                        // start, which runs a switched-off entry too, brings
                        // it back.
                        let current = self
                            .entries
                            .lock()
                            .unwrap()
                            .iter()
                            .find(|saved| saved.id == id)
                            .cloned();
                        current
                            .filter(|saved| {
                                started.wanted_again
                                    || (saved.enabled && !started.owners.is_empty())
                            })
                            .map(|saved| (saved, started.owners))
                    }
                    _ => None,
                }
            };
            if let Some(pid) = closed {
                self.report(run_of(&entry, CompanionOutcome::Closed { pid }));
            }
            if let Some((entry, owners)) = again {
                let run = self.start(&entry, owners, false);
                self.report(run);
            }
        }
    }

    /// Start `entry` for `owners`, or add them to the process already
    /// running for it. `test` is a start from Settings, which holds no
    /// launch.
    fn start(
        &self,
        entry: &CompanionProgram,
        owners: HashSet<LaunchId>,
        test: bool,
    ) -> CompanionRun {
        let mut tracked = self.tracked.lock().unwrap();
        if let Some(started) = tracked.get_mut(&entry.id) {
            if started.closing {
                // Going away for a launch that ended. It is started again
                // for this one once it has: see `launch_ended`.
                started.owners.extend(owners);
                started.wanted_again |= test;
                return run_of(entry, CompanionOutcome::AlreadyRunning { pid: started.pid });
            }
            let running = {
                let mut program = started.program.lock().unwrap();
                program.is_running().then(|| program.pid())
            };
            if let Some(pid) = running {
                started.pid = pid;
                started.owners.extend(owners);
                return run_of(entry, CompanionOutcome::AlreadyRunning { pid });
            }
            tracked.remove(&entry.id);
        }
        let image = entry.skip_if_running.trim();
        if !image.is_empty() && self.host.image_running(image) {
            return run_of(
                entry,
                CompanionOutcome::SkippedRunningImage {
                    image: image.to_owned(),
                },
            );
        }
        let outcome = match plan(entry).and_then(|plan| self.host.spawn(&plan)) {
            Ok(program) => {
                let pid = program.pid();
                tracked.insert(
                    entry.id.clone(),
                    Tracked {
                        program: Arc::new(Mutex::new(program)),
                        pid,
                        entry: entry.clone(),
                        owners,
                        closing: false,
                        wanted_again: false,
                    },
                );
                CompanionOutcome::Started { pid }
            }
            Err(reason) => CompanionOutcome::Failed { reason },
        };
        run_of(entry, outcome)
    }

    fn report(&self, run: CompanionRun) {
        log_run(&run);
        // Nobody listening is a client without the report service, a test;
        // the log line above is then the whole report.
        let _ = self.reports.send(run);
    }
}

/// The report for `entry`, named as the settings name it, or by its
/// program's file name while it has no name of its own.
fn run_of(entry: &CompanionProgram, outcome: CompanionOutcome) -> CompanionRun {
    let name = match entry.name.trim() {
        "" => Path::new(entry.program.trim())
            .file_name()
            .map(|file| file.to_string_lossy().into_owned())
            .unwrap_or_default(),
        name => name.to_owned(),
    };
    CompanionRun {
        id: entry.id.clone(),
        name,
        outcome,
        at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|since| since.as_secs() as u32)
            .unwrap_or(0),
    }
}

/// One line in the client log per result, by entry id only. The log is a file
/// players hand around with bug reports, so it names no program, file or
/// folder: the reason a start failed is shown beside the entry in Settings.
fn log_run(run: &CompanionRun) {
    match &run.outcome {
        CompanionOutcome::Started { pid } => {
            tracing::info!(id = %run.id, pid, "companion program started")
        }
        CompanionOutcome::AlreadyRunning { pid } => {
            tracing::info!(id = %run.id, pid, "companion program still running; not started again")
        }
        CompanionOutcome::SkippedRunningImage { .. } => {
            tracing::info!(id = %run.id, "companion program not started: the program it waits for is running")
        }
        CompanionOutcome::Failed { .. } => {
            tracing::warn!(id = %run.id, "companion program could not be started")
        }
        CompanionOutcome::Closed { pid } => {
            tracing::info!(id = %run.id, pid, "companion program closed with the game")
        }
    }
}

/// What starting `entry` means, before anything on disk is looked at.
///
/// The program has to be a complete path: a bare name would be looked up on
/// `PATH`, and whatever answers there is not what somebody picked.
pub(crate) fn plan(entry: &CompanionProgram) -> Result<SpawnPlan, String> {
    let (program, arguments, working_dir) = entry.command();
    if program.is_empty() {
        return Err("no program is set".into());
    }
    let program = PathBuf::from(program);
    // Absolute in the platform's sense. On Windows that needs a drive or a
    // share: a path starting at a backslash is relative to the current drive.
    if !program.is_absolute() {
        return Err(format!(
            "the program has to be a complete path: {}",
            program.display()
        ));
    }
    let working_dir = if working_dir.is_empty() {
        program
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| format!("the program has no folder: {}", program.display()))?
    } else {
        PathBuf::from(working_dir)
    };
    Ok(SpawnPlan {
        program,
        arguments: split_command(arguments),
        working_dir,
    })
}

/// Starts companion programs on this machine.
struct SystemHost;

impl ProgramHost for SystemHost {
    fn spawn(&self, plan: &SpawnPlan) -> Result<Box<dyn RunningProgram>, String> {
        if !plan.program.is_file() {
            return Err(format!(
                "the program was not found: {}",
                plan.program.display()
            ));
        }
        if !plan.working_dir.is_dir() {
            return Err(format!(
                "the folder to run it in was not found: {}",
                plan.working_dir.display()
            ));
        }
        #[cfg(windows)]
        if !runs_directly(&plan.program) {
            return system::open_with_association(plan);
        }
        let mut command = std::process::Command::new(&plan.program);
        command
            .args(&plan.arguments)
            .current_dir(&plan.working_dir)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // A console program gets no window of its own; a windowed one
            // is not affected.
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let child = command
            .spawn()
            .map_err(|error| spawn_failure(&plan.program, &error))?;
        Ok(Box::new(SystemProgram { child }))
    }

    fn image_running(&self, image: &str) -> bool {
        #[cfg(windows)]
        {
            super::process_list::image_running(image)
        }
        #[cfg(not(windows))]
        {
            let _ = image;
            false
        }
    }
}

/// Whether Windows starts the file itself: a program, or a batch file it
/// hands to its command interpreter. Any other file is opened with the
/// program Windows associates with its kind, as a double-click would.
#[cfg(any(windows, test))]
fn runs_directly(program: &Path) -> bool {
    program
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            ["exe", "com", "bat", "cmd"]
                .iter()
                .any(|kind| extension.eq_ignore_ascii_case(kind))
        })
}

/// Arguments as one Windows command line, quoted the way programs read them
/// back (the Microsoft C runtime's rules), for a file opened through its
/// association, which takes its parameters as a single string.
#[cfg(any(windows, test))]
fn command_line(arguments: &[String]) -> String {
    arguments
        .iter()
        .map(|argument| quote_argument(argument))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(any(windows, test))]
fn quote_argument(argument: &str) -> String {
    if !argument.is_empty() && !argument.contains([' ', '\t', '"']) {
        return argument.to_owned();
    }
    let mut quoted = String::from('"');
    let mut backslashes = 0;
    for character in argument.chars() {
        match character {
            '\\' => backslashes += 1,
            '"' => {
                quoted.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
                quoted.push('"');
                backslashes = 0;
            }
            _ => {
                quoted.extend(std::iter::repeat_n('\\', backslashes));
                quoted.push(character);
                backslashes = 0;
            }
        }
    }
    quoted.extend(std::iter::repeat_n('\\', backslashes * 2));
    quoted.push('"');
    quoted
}

/// Why a program did not start, in the words that help. The two Windows
/// errors worth naming are a program that wants administrator rights, which
/// the client deliberately never grants, and a file that is not a program.
fn spawn_failure(program: &Path, error: &std::io::Error) -> String {
    const ERROR_BAD_EXE_FORMAT: i32 = 193;
    const ERROR_ELEVATION_REQUIRED: i32 = 740;
    match error.raw_os_error() {
        Some(ERROR_ELEVATION_REQUIRED) if cfg!(windows) => format!(
            "{} asks for administrator rights, and the client starts companion programs \
             with normal rights only",
            program.display()
        ),
        Some(ERROR_BAD_EXE_FORMAT) if cfg!(windows) => {
            format!("{} is not a program Windows can run", program.display())
        }
        _ => format!("could not start {}: {error}", program.display()),
    }
}

struct SystemProgram {
    child: std::process::Child,
}

/// How long a program asked to close gets before it is ended.
const CLOSE_GRACE: Duration = Duration::from_secs(3);

impl RunningProgram for SystemProgram {
    fn pid(&self) -> u32 {
        self.child.id()
    }

    fn is_running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    fn close(&mut self) {
        if !self.is_running() {
            return;
        }
        // Asked first, so a script runs its own exit handling and takes its
        // tray icon with it.
        #[cfg(windows)]
        let asked = system::ask_to_close(self.child.id());
        #[cfg(not(windows))]
        let asked = false;
        if asked {
            let step = Duration::from_millis(100);
            let mut waited = Duration::ZERO;
            while waited < CLOSE_GRACE {
                if !self.is_running() {
                    return;
                }
                std::thread::sleep(step);
                waited += step;
            }
        }
        if let Err(error) = self.child.kill() {
            tracing::warn!(%error, pid = self.child.id(), "could not end a companion program");
            return;
        }
        let _ = self.child.wait();
    }
}

#[cfg(windows)]
mod system {
    use std::ffi::{c_void, OsStr};
    use std::os::windows::ffi::OsStrExt;
    use std::time::Duration;

    use super::{command_line, RunningProgram, SpawnPlan, CLOSE_GRACE};

    type Hwnd = isize;
    type Handle = isize;

    /// From `winuser.h`.
    const WM_CLOSE: u32 = 0x0010;
    const SW_SHOWNORMAL: i32 = 1;
    /// From `shellapi.h`.
    const SEE_MASK_NOCLOSEPROCESS: u32 = 0x0000_0040;
    const SEE_MASK_NOASYNC: u32 = 0x0000_0100;
    const SEE_MASK_FLAG_NO_UI: u32 = 0x0000_0400;
    /// From `objbase.h`.
    const COINIT_APARTMENTTHREADED: u32 = 0x2;
    const COINIT_DISABLE_OLE1DDE: u32 = 0x4;
    /// From `winnt.h` and `winbase.h`.
    const SYNCHRONIZE: u32 = 0x0010_0000;
    const PROCESS_TERMINATE: u32 = 0x0001;
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const WAIT_TIMEOUT: u32 = 0x0000_0102;
    /// From `winerror.h`.
    const ERROR_NO_ASSOCIATION: i32 = 1155;

    /// `SHELLEXECUTEINFOW`.
    #[repr(C)]
    struct ShellExecuteInfo {
        size: u32,
        mask: u32,
        window: Hwnd,
        verb: *const u16,
        file: *const u16,
        parameters: *const u16,
        directory: *const u16,
        show: i32,
        instance: isize,
        id_list: *mut c_void,
        class: *const u16,
        class_key: isize,
        hot_key: u32,
        icon_or_monitor: isize,
        process: Handle,
    }

    /// `FILETIME`, read as one number of 100 ns ticks.
    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct FileTime {
        low: u32,
        high: u32,
    }

    impl FileTime {
        fn ticks(self) -> u64 {
            (u64::from(self.high) << 32) | u64::from(self.low)
        }
    }

    #[link(name = "user32")]
    extern "system" {
        fn EnumWindows(callback: extern "system" fn(Hwnd, isize) -> i32, param: isize) -> i32;
        fn GetWindowThreadProcessId(window: Hwnd, process_id: *mut u32) -> u32;
        fn PostMessageW(window: Hwnd, message: u32, wparam: usize, lparam: isize) -> i32;
    }

    #[link(name = "shell32")]
    extern "system" {
        fn ShellExecuteExW(info: *mut ShellExecuteInfo) -> i32;
    }

    #[link(name = "ole32")]
    extern "system" {
        fn CoInitializeEx(reserved: *mut c_void, flags: u32) -> i32;
        fn CoUninitialize();
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetProcessId(process: Handle) -> u32;
        fn GetProcessTimes(
            process: Handle,
            creation: *mut FileTime,
            exit: *mut FileTime,
            kernel: *mut FileTime,
            user: *mut FileTime,
        ) -> i32;
        fn OpenProcess(access: u32, inherit: i32, process_id: u32) -> Handle;
        fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
        fn TerminateProcess(process: Handle, exit_code: u32) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
    }

    fn wide(text: &OsStr) -> Vec<u16> {
        text.encode_wide().chain(std::iter::once(0)).collect()
    }

    /// Open a file that is not a program with the program Windows associates
    /// with its kind, as a double-click would, and hold the process that
    /// opened it.
    pub(super) fn open_with_association(
        plan: &SpawnPlan,
    ) -> Result<Box<dyn RunningProgram>, String> {
        let verb = wide(OsStr::new("open"));
        let file = wide(plan.program.as_os_str());
        let parameters = wide(OsStr::new(&command_line(&plan.arguments)));
        let directory = wide(plan.working_dir.as_os_str());
        // On a thread of its own, set up for the shell the way it asks to be:
        // an association can be served by a shell extension, which needs COM
        // initialised on the calling thread, and the launcher's threads are
        // the async runtime's.
        let opened = std::thread::scope(|scope| {
            scope
                .spawn(|| {
                    // Sound: a null reserved pointer and plain flags.
                    let initialised = unsafe {
                        CoInitializeEx(
                            std::ptr::null_mut(),
                            COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE,
                        )
                    } >= 0;
                    let mut info = ShellExecuteInfo {
                        size: std::mem::size_of::<ShellExecuteInfo>() as u32,
                        mask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI,
                        window: 0,
                        verb: verb.as_ptr(),
                        file: file.as_ptr(),
                        parameters: parameters.as_ptr(),
                        directory: directory.as_ptr(),
                        show: SW_SHOWNORMAL,
                        instance: 0,
                        id_list: std::ptr::null_mut(),
                        class: std::ptr::null(),
                        class_key: 0,
                        hot_key: 0,
                        icon_or_monitor: 0,
                        process: 0,
                    };
                    // Sound: every string is a NUL-terminated buffer that
                    // outlives the call, and `size` is set.
                    let ok = unsafe { ShellExecuteExW(&mut info) } != 0;
                    let error = std::io::Error::last_os_error();
                    if initialised {
                        // Sound: paired with the successful call above.
                        unsafe { CoUninitialize() };
                    }
                    if ok {
                        Ok(info.process)
                    } else {
                        Err(error)
                    }
                })
                .join()
        });
        let shown = plan.program.display();
        match opened {
            Err(_) => Err(format!("could not open {shown}")),
            Ok(Err(error)) if error.raw_os_error() == Some(ERROR_NO_ASSOCIATION) => Err(format!(
                "{shown} is not a program, and Windows has no program set to open it"
            )),
            Ok(Err(error)) => Err(format!("could not open {shown}: {error}")),
            Ok(Ok(0)) => Err(format!(
                "{shown} was handed to a program that was already running, so the client \
                 cannot tell when it ends"
            )),
            Ok(Ok(handle)) => Ok(Box::new(HeldProcess::new(handle))),
        }
    }

    /// A process the client holds by handle, for a file opened through its
    /// association.
    struct HeldProcess {
        handle: Handle,
        pid: u32,
    }

    impl HeldProcess {
        fn new(handle: Handle) -> Self {
            // Sound: a process handle ShellExecuteExW just returned.
            let pid = unsafe { GetProcessId(handle) };
            Self { handle, pid }
        }

        fn alive(&self) -> bool {
            // Sound: an open process handle with `SYNCHRONIZE` access.
            unsafe { WaitForSingleObject(self.handle, 0) == WAIT_TIMEOUT }
        }

        /// When the process started and, once it has, when it ended.
        fn times(handle: Handle) -> Option<(u64, u64)> {
            let (mut creation, mut exit) = (FileTime::default(), FileTime::default());
            let (mut kernel, mut user) = (FileTime::default(), FileTime::default());
            // Sound: an open handle with query access and four valid out
            // pointers to locals.
            let ok = unsafe {
                GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user)
            } != 0;
            ok.then(|| (creation.ticks(), exit.ticks()))
        }

        /// The program a file is handed to may hand it on in turn and exit,
        /// leaving the process that does the work as its child. Follow it,
        /// but only to a child started while this process was alive: once it
        /// has gone its id can be handed to an unrelated process, whose
        /// children must never be taken for ours.
        fn follow_child(&mut self) -> bool {
            let Some((started, ended)) = Self::times(self.handle) else {
                return false;
            };
            for process in crate::infra::process_list::all() {
                if process.parent != self.pid || process.id == self.pid {
                    continue;
                }
                // Sound: plain integer arguments; a failure returns null.
                let child = unsafe {
                    OpenProcess(
                        SYNCHRONIZE | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
                        0,
                        process.id,
                    )
                };
                if child == 0 {
                    continue;
                }
                let ours = Self::times(child)
                    .is_some_and(|(created, _)| created >= started && created <= ended);
                if ours {
                    // Sound: the old handle is ours and closed exactly once.
                    unsafe { CloseHandle(self.handle) };
                    self.handle = child;
                    self.pid = process.id;
                    return true;
                }
                // Sound: opened just above and not kept.
                unsafe { CloseHandle(child) };
            }
            false
        }
    }

    impl RunningProgram for HeldProcess {
        fn pid(&self) -> u32 {
            self.pid
        }

        fn is_running(&mut self) -> bool {
            // A few hand-overs at most; a chain longer than that is not one.
            for _ in 0..4 {
                if self.alive() {
                    return true;
                }
                if !self.follow_child() {
                    return false;
                }
            }
            self.alive()
        }

        fn close(&mut self) {
            if !self.is_running() {
                return;
            }
            if ask_to_close(self.pid) {
                let step = Duration::from_millis(100);
                let mut waited = Duration::ZERO;
                while waited < CLOSE_GRACE {
                    if !self.alive() {
                        return;
                    }
                    std::thread::sleep(step);
                    waited += step;
                }
            }
            // Sound: an open handle with `PROCESS_TERMINATE` access (the
            // shell's handle has full access).
            if unsafe { TerminateProcess(self.handle, 1) } == 0 {
                tracing::warn!(pid = self.pid, "could not end a companion program");
            }
        }
    }

    impl Drop for HeldProcess {
        fn drop(&mut self) {
            // Sound: the handle is ours and closed exactly once, here.
            unsafe { CloseHandle(self.handle) };
        }
    }

    struct Search {
        pid: u32,
        windows: Vec<Hwnd>,
    }

    extern "system" fn visit(window: Hwnd, param: isize) -> i32 {
        // Sound: `param` is the address of the `Search` that `ask_to_close`
        // keeps alive for the whole of the `EnumWindows` call.
        let search = unsafe { &mut *(param as *mut Search) };
        let mut owner = 0u32;
        // Sound: a window handle Windows just handed us and a valid out pointer.
        unsafe { GetWindowThreadProcessId(window, &mut owner) };
        if owner == search.pid {
            search.windows.push(window);
        }
        1
    }

    /// Send a close to every top-level window of the process, hidden ones
    /// included: a script's only window is usually hidden. Whether there was
    /// any window to ask.
    pub(super) fn ask_to_close(pid: u32) -> bool {
        let mut search = Search {
            pid,
            windows: Vec::new(),
        };
        // Sound: the callback only dereferences `param` during this call.
        unsafe { EnumWindows(visit, &mut search as *mut Search as isize) };
        for window in &search.windows {
            // Sound: a window handle from the enumeration and plain values; a
            // window that closed meanwhile makes the call fail, harmlessly.
            unsafe { PostMessageW(*window, WM_CLOSE, 0, 0) };
        }
        !search.windows.is_empty()
    }
}

/// A machine that starts nothing and remembers what it was asked, for the
/// tests here and the launcher's.
#[cfg(test)]
pub(crate) mod fake {
    use super::*;

    #[derive(Default)]
    pub(crate) struct FakeHost {
        pub state: Arc<Mutex<FakeState>>,
    }

    #[derive(Default)]
    pub(crate) struct FakeState {
        pub next_pid: u32,
        pub spawned: Vec<SpawnPlan>,
        /// Process id to running, for every process this host started.
        pub running: HashMap<u32, bool>,
        pub closed: Vec<u32>,
        pub images: Vec<String>,
        pub refuse: Option<String>,
        /// When set, the next close says it has begun and then waits to be
        /// let go, as a real one waits for the program.
        pub close_gate: Option<(std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>)>,
    }

    struct FakeProgram {
        pid: u32,
        state: Arc<Mutex<FakeState>>,
    }

    impl ProgramHost for FakeHost {
        fn spawn(&self, plan: &SpawnPlan) -> Result<Box<dyn RunningProgram>, String> {
            let mut state = self.state.lock().unwrap();
            if let Some(reason) = state.refuse.clone() {
                return Err(reason);
            }
            state.next_pid += 1;
            let pid = 1000 + state.next_pid;
            state.spawned.push(plan.clone());
            state.running.insert(pid, true);
            Ok(Box::new(FakeProgram {
                pid,
                state: self.state.clone(),
            }))
        }

        fn image_running(&self, image: &str) -> bool {
            self.state
                .lock()
                .unwrap()
                .images
                .iter()
                .any(|running| running.eq_ignore_ascii_case(image))
        }
    }

    impl RunningProgram for FakeProgram {
        fn pid(&self) -> u32 {
            self.pid
        }
        fn is_running(&mut self) -> bool {
            self.state.lock().unwrap().running[&self.pid]
        }
        fn close(&mut self) {
            let gate = self.state.lock().unwrap().close_gate.take();
            if let Some((begun, release)) = gate {
                let _ = begun.send(());
                let _ = release.recv();
            }
            let mut state = self.state.lock().unwrap();
            state.running.insert(self.pid, false);
            state.closed.push(self.pid);
        }
    }

    pub(crate) fn companions() -> (Companions, Arc<Mutex<FakeState>>) {
        let host = FakeHost::default();
        let state = host.state.clone();
        (Companions::new(Box::new(host)), state)
    }
}

#[cfg(test)]
mod tests {
    use super::fake::companions;
    use super::*;
    use faf_domain::state::CompanionLaunches;

    fn entry(id: &str) -> CompanionProgram {
        CompanionProgram {
            id: id.into(),
            name: format!("{id} tool"),
            program: absolute("Tools/Helper/helper.exe"),
            arguments: "\"My Settings/helper.ini\" /fast".into(),
            ..CompanionProgram::default()
        }
    }

    fn absolute(path: &str) -> String {
        if cfg!(windows) {
            format!("C:/{path}")
        } else {
            format!("/{path}")
        }
    }

    fn drain(receiver: &mut mpsc::UnboundedReceiver<CompanionRun>) -> Vec<CompanionOutcome> {
        let mut outcomes = Vec::new();
        while let Ok(run) = receiver.try_recv() {
            outcomes.push(run.outcome);
        }
        outcomes
    }

    #[test]
    fn an_entry_starts_with_its_launch_at_its_moment_and_only_then() {
        let (companions, state) = companions();
        let mut reports = companions.take_reports();
        companions.set_entries(vec![
            CompanionProgram {
                timing: CompanionTiming::Before,
                ..entry("before")
            },
            entry("after"),
            CompanionProgram {
                launches: CompanionLaunches::Replays,
                ..entry("replays")
            },
            CompanionProgram {
                enabled: false,
                ..entry("off")
            },
            CompanionProgram {
                program: String::new(),
                ..entry("unfinished")
            },
        ]);

        companions.start_with(CompanionLaunchKind::Game, CompanionTiming::Before, 1);
        assert_eq!(
            drain(&mut reports),
            [CompanionOutcome::Started { pid: 1001 }]
        );
        companions.start_with(CompanionLaunchKind::Game, CompanionTiming::After, 1);
        assert_eq!(
            drain(&mut reports),
            [CompanionOutcome::Started { pid: 1002 }]
        );
        companions.start_with(CompanionLaunchKind::Replay, CompanionTiming::After, 1);
        assert_eq!(
            drain(&mut reports),
            [CompanionOutcome::Started { pid: 1003 }]
        );
        assert_eq!(state.lock().unwrap().spawned.len(), 3);

        // The command line: the program, its arguments split on quotes, and
        // the program's own folder to run in.
        let spawned = state.lock().unwrap().spawned.clone();
        let plan = &spawned[0];
        assert_eq!(plan.arguments, ["My Settings/helper.ini", "/fast"]);
        assert_eq!(
            plan.working_dir,
            PathBuf::from(absolute("Tools/Helper/helper.exe"))
                .parent()
                .unwrap()
        );
    }

    #[test]
    fn an_entry_whose_process_still_runs_is_not_started_again() {
        let (companions, state) = companions();
        let mut reports = companions.take_reports();
        companions.set_entries(vec![entry("helper")]);

        companions.start_with(CompanionLaunchKind::Game, CompanionTiming::After, 1);
        companions.start_with(CompanionLaunchKind::Game, CompanionTiming::After, 1);
        assert_eq!(
            drain(&mut reports),
            [
                CompanionOutcome::Started { pid: 1001 },
                CompanionOutcome::AlreadyRunning { pid: 1001 },
            ]
        );

        // Once it has gone, by itself or otherwise, the next game starts it.
        state.lock().unwrap().running.insert(1001, false);
        companions.start_with(CompanionLaunchKind::Game, CompanionTiming::After, 1);
        assert_eq!(
            drain(&mut reports),
            [CompanionOutcome::Started { pid: 1002 }]
        );
    }

    #[test]
    fn a_running_program_of_the_named_file_holds_the_entry_back() {
        let (companions, state) = companions();
        let mut reports = companions.take_reports();
        state.lock().unwrap().images.push("OBS64.EXE".into());
        companions.set_entries(vec![CompanionProgram {
            skip_if_running: "obs64.exe".into(),
            ..entry("obs")
        }]);
        companions.start_with(CompanionLaunchKind::Game, CompanionTiming::After, 1);
        assert_eq!(
            drain(&mut reports),
            [CompanionOutcome::SkippedRunningImage {
                image: "obs64.exe".into()
            }]
        );
        assert!(state.lock().unwrap().spawned.is_empty());
    }

    #[test]
    fn a_program_that_cannot_start_is_reported_and_nothing_else_happens() {
        let (companions, state) = companions();
        let mut reports = companions.take_reports();
        state.lock().unwrap().refuse = Some("the program was not found".into());
        companions.set_entries(vec![entry("gone"), entry("also gone")]);
        companions.start_with(CompanionLaunchKind::Game, CompanionTiming::After, 1);
        let outcomes = drain(&mut reports);
        assert_eq!(
            outcomes.len(),
            2,
            "one failure does not stop the next entry"
        );
        assert!(outcomes.iter().all(CompanionOutcome::is_failure));
    }

    #[test]
    fn close_with_game_closes_only_the_process_started_for_that_entry() {
        let (companions, state) = companions();
        let mut reports = companions.take_reports();
        companions.set_entries(vec![
            CompanionProgram {
                close_with_game: true,
                ..entry("closes")
            },
            entry("stays"),
        ]);
        companions.start_with(CompanionLaunchKind::Game, CompanionTiming::After, 1);
        drain(&mut reports);

        companions.launch_ended(1);
        assert_eq!(
            drain(&mut reports),
            [CompanionOutcome::Closed { pid: 1001 }]
        );
        assert_eq!(state.lock().unwrap().closed, [1001]);
        // The one left running is still tracked, so the next game does not
        // start a second copy of it.
        companions.start_with(CompanionLaunchKind::Game, CompanionTiming::After, 1);
        assert_eq!(
            drain(&mut reports),
            [
                CompanionOutcome::Started { pid: 1003 },
                CompanionOutcome::AlreadyRunning { pid: 1002 },
            ]
        );
    }

    #[test]
    fn a_program_that_already_exited_is_not_reported_as_closed() {
        let (companions, state) = companions();
        let mut reports = companions.take_reports();
        companions.set_entries(vec![CompanionProgram {
            close_with_game: true,
            ..entry("short")
        }]);
        companions.start_with(CompanionLaunchKind::Game, CompanionTiming::After, 1);
        drain(&mut reports);
        state.lock().unwrap().running.insert(1001, false);
        companions.launch_ended(1);
        assert!(drain(&mut reports).is_empty());
        assert!(state.lock().unwrap().closed.is_empty());
    }

    #[test]
    fn an_entry_for_both_outlives_one_launch_while_the_other_holds_it() {
        let (companions, state) = companions();
        let mut reports = companions.take_reports();
        companions.set_entries(vec![CompanionProgram {
            close_with_game: true,
            launches: CompanionLaunches::Both,
            ..entry("both")
        }]);
        companions.start_with(CompanionLaunchKind::Game, CompanionTiming::After, 1);
        companions.start_with(CompanionLaunchKind::Replay, CompanionTiming::After, 2);
        assert_eq!(
            drain(&mut reports),
            [
                CompanionOutcome::Started { pid: 1001 },
                CompanionOutcome::AlreadyRunning { pid: 1001 },
            ]
        );

        // The replay ends while the game goes on: still held.
        companions.launch_ended(2);
        assert!(state.lock().unwrap().closed.is_empty());
        companions.launch_ended(1);
        assert_eq!(state.lock().unwrap().closed, [1001]);
    }

    #[test]
    fn a_launch_that_does_not_come_with_an_entry_never_holds_it() {
        let (companions, state) = companions();
        companions.set_entries(vec![CompanionProgram {
            close_with_game: true,
            ..entry("games only")
        }]);
        companions.start_with(CompanionLaunchKind::Game, CompanionTiming::After, 1);
        companions.start_with(CompanionLaunchKind::Replay, CompanionTiming::After, 2);
        companions.launch_ended(2);
        assert!(state.lock().unwrap().closed.is_empty());
        companions.launch_ended(1);
        assert_eq!(state.lock().unwrap().closed, [1001]);
    }

    /// The previous game's exit is handled on a thread of its own, and the
    /// next game can start before that thread runs. The program it found
    /// running is that game's now; the late cleanup must leave it alone.
    #[test]
    fn a_late_cleanup_does_not_close_what_the_next_game_took_over() {
        let (companions, state) = companions();
        let mut reports = companions.take_reports();
        companions.set_entries(vec![CompanionProgram {
            close_with_game: true,
            ..entry("helper")
        }]);
        companions.start_with(CompanionLaunchKind::Game, CompanionTiming::After, 1);
        companions.start_with(CompanionLaunchKind::Game, CompanionTiming::After, 2);
        companions.launch_ended(1);
        assert!(state.lock().unwrap().closed.is_empty());
        assert_eq!(state.lock().unwrap().spawned.len(), 1);
        assert_eq!(
            drain(&mut reports),
            [
                CompanionOutcome::Started { pid: 1001 },
                CompanionOutcome::AlreadyRunning { pid: 1001 },
            ]
        );
        companions.launch_ended(2);
        assert_eq!(state.lock().unwrap().closed, [1001]);
    }

    /// A launch that starts while the last one's companion is still being
    /// closed gets no second copy beside it, and gets a fresh one once the
    /// old one has gone.
    #[test]
    fn a_launch_during_a_close_waits_for_it_and_then_gets_its_own_copy() {
        let (companions, state) = companions();
        let companions = Arc::new(companions);
        let mut reports = companions.take_reports();
        companions.set_entries(vec![CompanionProgram {
            close_with_game: true,
            ..entry("helper")
        }]);
        companions.start_with(CompanionLaunchKind::Game, CompanionTiming::After, 1);
        drain(&mut reports);

        let (begun_tx, begun) = std::sync::mpsc::channel();
        let (release, release_rx) = std::sync::mpsc::channel();
        state.lock().unwrap().close_gate = Some((begun_tx, release_rx));
        let closer = {
            let companions = Arc::clone(&companions);
            std::thread::spawn(move || companions.launch_ended(1))
        };
        begun.recv().unwrap();

        // The next game starts mid-close: told it runs, nothing spawned.
        companions.start_with(CompanionLaunchKind::Game, CompanionTiming::After, 2);
        assert_eq!(state.lock().unwrap().spawned.len(), 1);
        assert_eq!(
            drain(&mut reports),
            [CompanionOutcome::AlreadyRunning { pid: 1001 }]
        );

        release.send(()).unwrap();
        closer.join().unwrap();
        assert_eq!(
            drain(&mut reports),
            [
                CompanionOutcome::Closed { pid: 1001 },
                CompanionOutcome::Started { pid: 1002 },
            ]
        );
        // The new copy is the new game's, and goes with it.
        companions.launch_ended(2);
        assert_eq!(state.lock().unwrap().closed, [1001, 1002]);
    }

    /// Close the entry for launch 1 on another thread, hold the close
    /// half-way, run `meanwhile`, then let it finish. What was spawned,
    /// in order.
    fn during_a_close(
        entry: CompanionProgram,
        meanwhile: impl FnOnce(&Companions),
    ) -> Vec<SpawnPlan> {
        let (companions, state) = companions();
        let companions = Arc::new(companions);
        companions.set_entries(vec![entry]);
        companions.start_with(CompanionLaunchKind::Game, CompanionTiming::After, 1);
        let (begun_tx, begun) = std::sync::mpsc::channel();
        let (release, release_rx) = std::sync::mpsc::channel();
        state.lock().unwrap().close_gate = Some((begun_tx, release_rx));
        let closer = {
            let companions = Arc::clone(&companions);
            std::thread::spawn(move || companions.launch_ended(1))
        };
        begun.recv().unwrap();
        meanwhile(&companions);
        release.send(()).unwrap();
        closer.join().unwrap();
        let spawned = state.lock().unwrap().spawned.clone();
        spawned
    }

    #[test]
    fn a_restart_after_a_close_runs_the_entry_as_saved_now() {
        let old = CompanionProgram {
            close_with_game: true,
            arguments: "old-arguments".into(),
            ..entry("helper")
        };
        let edited = CompanionProgram {
            arguments: "new-arguments".into(),
            ..old.clone()
        };

        // Edited and Test started while the close was under way.
        let spawned = during_a_close(old.clone(), |companions| {
            companions.set_entries(vec![edited.clone()]);
            companions.start_now(&edited);
        });
        assert_eq!(spawned.len(), 2);
        assert_eq!(spawned[1].arguments, ["new-arguments"]);

        // Removed meanwhile: a launch that wanted it does not bring it back.
        let spawned = during_a_close(old.clone(), |companions| {
            companions.start_with(CompanionLaunchKind::Game, CompanionTiming::After, 2);
            companions.set_entries(Vec::new());
        });
        assert_eq!(spawned.len(), 1);

        // Switched off meanwhile: not for a launch, but for a Test start.
        let off = CompanionProgram {
            enabled: false,
            ..old.clone()
        };
        let spawned = during_a_close(old.clone(), |companions| {
            companions.start_with(CompanionLaunchKind::Game, CompanionTiming::After, 2);
            companions.set_entries(vec![off.clone()]);
        });
        assert_eq!(spawned.len(), 1);
        let spawned = during_a_close(old, |companions| {
            companions.set_entries(vec![off.clone()]);
            companions.start_now(&off);
        });
        assert_eq!(spawned.len(), 2);
    }

    #[test]
    fn a_test_start_is_held_by_the_game_that_finds_it_and_closed_with_it() {
        let (companions, state) = companions();
        let helper = CompanionProgram {
            close_with_game: true,
            ..entry("helper")
        };
        companions.set_entries(vec![helper.clone()]);
        companions.start_now(&helper);
        // A launch that never held it ending changes nothing.
        companions.launch_ended(9);
        assert!(state.lock().unwrap().closed.is_empty());
        companions.start_with(CompanionLaunchKind::Game, CompanionTiming::After, 1);
        companions.launch_ended(1);
        assert_eq!(state.lock().unwrap().closed, [1001]);
    }

    #[test]
    fn switching_close_with_game_off_during_a_game_is_honoured() {
        let (companions, state) = companions();
        companions.set_entries(vec![CompanionProgram {
            close_with_game: true,
            ..entry("helper")
        }]);
        companions.start_with(CompanionLaunchKind::Game, CompanionTiming::After, 1);
        companions.set_entries(vec![entry("helper")]);
        companions.launch_ended(1);
        assert!(state.lock().unwrap().closed.is_empty());

        // An entry removed during the game goes by what it said when started.
        let (companions, state) = self::companions();
        companions.set_entries(vec![CompanionProgram {
            close_with_game: true,
            ..entry("helper")
        }]);
        companions.start_with(CompanionLaunchKind::Game, CompanionTiming::After, 1);
        companions.set_entries(Vec::new());
        companions.launch_ended(1);
        assert_eq!(state.lock().unwrap().closed, [1001]);
    }

    #[test]
    fn a_test_start_is_tracked_and_returned_rather_than_reported() {
        let (companions, _state) = companions();
        let mut reports = companions.take_reports();
        let helper = CompanionProgram {
            enabled: false,
            ..entry("helper")
        };
        companions.set_entries(vec![helper.clone()]);
        let run = companions.start_now(&helper);
        assert_eq!(run.outcome, CompanionOutcome::Started { pid: 1001 });
        assert_eq!(run.name, "helper tool");
        assert!(drain(&mut reports).is_empty());
        assert_eq!(
            companions.start_now(&helper).outcome,
            CompanionOutcome::AlreadyRunning { pid: 1001 }
        );
    }

    #[test]
    fn the_report_channel_has_one_receiver() {
        let (companions, _state) = companions();
        let _first = companions.take_reports();
        let mut second = companions.take_reports();
        assert!(second.try_recv().is_err());
        assert!(second.is_closed());
    }

    #[test]
    fn what_cannot_be_started_is_refused_before_anything_runs() {
        let with = |program: &str| CompanionProgram {
            program: program.into(),
            ..entry("x")
        };
        assert!(plan(&with("")).is_err());
        assert!(plan(&with("helper.exe"))
            .unwrap_err()
            .contains("complete path"));

        let elsewhere = CompanionProgram {
            working_dir: absolute("Work"),
            ..entry("x")
        };
        assert_eq!(
            plan(&elsewhere).unwrap().working_dir,
            PathBuf::from(absolute("Work"))
        );
    }

    /// The real thing, with a program every machine has that waits without
    /// doing anything: started without a console, tracked, and ended.
    #[test]
    fn a_real_program_is_started_held_and_closed() {
        let (program, arguments) = if cfg!(windows) {
            let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
            (
                format!("{root}\\System32\\PING.EXE"),
                "-n 30 127.0.0.1".to_string(),
            )
        } else {
            ("/bin/sleep".to_string(), "30".to_string())
        };
        if !Path::new(&program).is_file() {
            return;
        }
        let companions = Companions::system();
        let mut reports = companions.take_reports();
        companions.set_entries(vec![CompanionProgram {
            program,
            arguments,
            close_with_game: true,
            ..entry("waits")
        }]);
        companions.start_with(CompanionLaunchKind::Game, CompanionTiming::After, 1);
        let Some(CompanionOutcome::Started { pid }) = drain(&mut reports).pop() else {
            panic!("the program did not start");
        };
        companions.start_with(CompanionLaunchKind::Game, CompanionTiming::After, 1);
        assert_eq!(
            drain(&mut reports),
            [CompanionOutcome::AlreadyRunning { pid }]
        );
        companions.launch_ended(1);
        assert_eq!(drain(&mut reports), [CompanionOutcome::Closed { pid }]);
    }

    #[test]
    fn a_file_that_is_not_a_program_is_opened_through_its_association() {
        for direct in [
            "C:/Tools/a.exe",
            "C:/Tools/b.CMD",
            "C:/Tools/c.bat",
            "C:/Tools/d.com",
        ] {
            assert!(runs_directly(Path::new(direct)), "{direct}");
        }
        for opened in [
            "C:/Scripts/helper.py",
            "C:/Scripts/helper",
            "C:/Docs/notes.txt",
        ] {
            assert!(!runs_directly(Path::new(opened)), "{opened}");
        }
    }

    #[test]
    fn arguments_for_an_association_are_quoted_the_way_programs_read_them() {
        let line = |arguments: &[&str]| {
            command_line(&arguments.iter().map(|a| a.to_string()).collect::<Vec<_>>())
        };
        assert_eq!(
            line(&["/fast", "C:/My Settings/helper.ini"]),
            r#"/fast "C:/My Settings/helper.ini""#
        );
        assert_eq!(line(&[""]), r#""""#);
        assert_eq!(line(&[r#"say "hi""#]), r#""say \"hi\"""#);
        assert_eq!(line(&[r"C:\with space\"]), r#""C:\with space\\""#);
        assert_eq!(line(&[r"C:\plain\"]), r"C:\plain\");
    }

    #[test]
    fn a_missing_program_on_this_machine_is_a_failure_not_a_panic() {
        let companions = Companions::system();
        let run = companions.start_now(&CompanionProgram {
            program: absolute("no/such/folder/faf-companion.exe"),
            ..entry("missing")
        });
        assert!(
            matches!(&run.outcome, CompanionOutcome::Failed { reason } if reason.contains("not found")),
            "{run:?}"
        );
    }
}
