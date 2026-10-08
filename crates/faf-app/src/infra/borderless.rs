//! Forged Alliance in a borderless window that covers its monitor (#445).
//!
//! The game knows two modes: exclusive fullscreen, which alt-tabs badly, and
//! a window with a title bar and a frame. Players have long run a third-party
//! script between the two that takes the frame off the game's window and
//! stretches it over the screen, which is all a "borderless windowed" mode is.
//! This is that script, run by the client for the game it launched, so a new
//! player does not have to go and find one.
//!
//! It works on the window the game already has: Forged Alliance has to be set
//! to windowed in its own options. Exclusive fullscreen has no frame to take
//! off and is left alone, and so is a window that already is borderless and
//! fills its monitor.
//!
//! The game builds its window more than once (the lobby, then the match, then
//! the score screen), and each time puts the frame back, so the window is
//! checked every second for as long as the game runs rather than once.
//!
//! Windows only. On Linux the game is a Wine process whose windows belong to
//! the Wine server, and the window manager there has its own answer.

/// Keep the main window of the game process `pid` borderless for as long as
/// that process runs. Returns at once: the work happens on a thread of its own
/// that ends with the game.
pub fn start(pid: u32) {
    #[cfg(windows)]
    {
        let spawned = std::thread::Builder::new()
            .name("fa-borderless".into())
            .spawn(move || system::keep_borderless(pid));
        if let Err(error) = spawned {
            tracing::warn!(%error, "could not start the borderless window helper");
        }
    }
    #[cfg(not(windows))]
    {
        tracing::info!(pid, "a borderless game window is only applied on Windows");
    }
}

#[cfg(windows)]
mod system {
    type Handle = isize;
    type Hwnd = isize;

    #[repr(C)]
    #[derive(Default, Clone, Copy, PartialEq, Eq)]
    struct Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }

    #[repr(C)]
    struct MonitorInfo {
        size: u32,
        monitor: Rect,
        work: Rect,
        flags: u32,
    }

    /// From `winnt.h`: the one right needed to wait on a process.
    const SYNCHRONIZE: u32 = 0x0010_0000;
    /// From `winbase.h`.
    const WAIT_TIMEOUT: u32 = 0x0000_0102;
    /// From `winuser.h`.
    const GWL_STYLE: i32 = -16;
    const GW_OWNER: u32 = 4;
    const WS_CAPTION: isize = 0x00C0_0000;
    const WS_THICKFRAME: isize = 0x0004_0000;
    const WS_MINIMIZEBOX: isize = 0x0002_0000;
    const WS_MAXIMIZEBOX: isize = 0x0001_0000;
    const WS_SYSMENU: isize = 0x0008_0000;
    const FRAME: isize = WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU;
    const MONITOR_DEFAULTTONEAREST: u32 = 2;
    const SWP_NOZORDER: u32 = 0x0004;
    const SWP_FRAMECHANGED: u32 = 0x0020;
    const SWP_NOOWNERZORDER: u32 = 0x0200;

    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, process_id: u32) -> Handle;
        fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
        fn CloseHandle(handle: Handle) -> i32;
    }

    #[link(name = "user32")]
    extern "system" {
        fn EnumWindows(callback: extern "system" fn(Hwnd, isize) -> i32, param: isize) -> i32;
        fn GetWindowThreadProcessId(window: Hwnd, process_id: *mut u32) -> u32;
        fn IsWindowVisible(window: Hwnd) -> i32;
        fn GetWindow(window: Hwnd, command: u32) -> Hwnd;
        fn GetWindowLongPtrW(window: Hwnd, index: i32) -> isize;
        fn SetWindowLongPtrW(window: Hwnd, index: i32, value: isize) -> isize;
        fn GetWindowRect(window: Hwnd, rect: *mut Rect) -> i32;
        fn MonitorFromWindow(window: Hwnd, flags: u32) -> Handle;
        fn GetMonitorInfoW(monitor: Handle, info: *mut MonitorInfo) -> i32;
        fn SetWindowPos(
            window: Hwnd,
            insert_after: Hwnd,
            x: i32,
            y: i32,
            width: i32,
            height: i32,
            flags: u32,
        ) -> i32;
    }

    /// The game, by handle, so a process id reused later cannot keep this
    /// going after the game is gone. The same pattern as `steam_presence`.
    struct Game(Handle);

    impl Game {
        fn open(pid: u32) -> Option<Self> {
            // Sound: plain integer arguments; a failure returns a null handle.
            let handle = unsafe { OpenProcess(SYNCHRONIZE, 0, pid) };
            (handle != 0).then_some(Self(handle))
        }

        fn still_running_after(&self, milliseconds: u32) -> bool {
            // Sound: an open process handle with `SYNCHRONIZE` access.
            unsafe { WaitForSingleObject(self.0, milliseconds) == WAIT_TIMEOUT }
        }
    }

    impl Drop for Game {
        fn drop(&mut self) {
            // Sound: the handle came from a successful `OpenProcess` and is
            // closed exactly once, here.
            unsafe { CloseHandle(self.0) };
        }
    }

    pub(super) fn keep_borderless(pid: u32) {
        let Some(game) = Game::open(pid) else {
            tracing::warn!(
                pid,
                "could not open the game process to make its window borderless"
            );
            return;
        };
        while game.still_running_after(1_000) {
            if let Some(window) = main_window(pid) {
                make_borderless(window);
            }
        }
    }

    struct Search {
        pid: u32,
        found: Hwnd,
    }

    extern "system" fn visit(window: Hwnd, param: isize) -> i32 {
        // Sound: `param` is the address of the `Search` that `main_window`
        // keeps alive for the whole of the `EnumWindows` call.
        let search = unsafe { &mut *(param as *mut Search) };
        let mut owner_pid = 0u32;
        // Sound: a window handle Windows just handed us and a valid out pointer.
        unsafe { GetWindowThreadProcessId(window, &mut owner_pid) };
        // The game's own top-level window: visible, and not a dialog it owns.
        let main = owner_pid == search.pid
            && unsafe { IsWindowVisible(window) } != 0
            && unsafe { GetWindow(window, GW_OWNER) } == 0;
        if main {
            search.found = window;
            0
        } else {
            1
        }
    }

    fn main_window(pid: u32) -> Option<Hwnd> {
        let mut search = Search { pid, found: 0 };
        // Sound: the callback only dereferences `param` during this call.
        unsafe { EnumWindows(visit, &mut search as *mut Search as isize) };
        (search.found != 0).then_some(search.found)
    }

    fn make_borderless(window: Hwnd) {
        // Sound: every call below takes the window handle found above and
        // plain values or pointers to locals; a window that closed meanwhile
        // makes them fail, which is harmless.
        unsafe {
            let style = GetWindowLongPtrW(window, GWL_STYLE);
            let framed = style & FRAME != 0;
            let monitor = MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST);
            let mut info = MonitorInfo {
                size: std::mem::size_of::<MonitorInfo>() as u32,
                monitor: Rect::default(),
                work: Rect::default(),
                flags: 0,
            };
            if monitor == 0 || GetMonitorInfoW(monitor, &mut info) == 0 {
                return;
            }
            let screen = info.monitor;
            let mut current = Rect::default();
            GetWindowRect(window, &mut current);
            if !framed && current == screen {
                return;
            }
            if framed {
                SetWindowLongPtrW(window, GWL_STYLE, style & !FRAME);
            }
            SetWindowPos(
                window,
                0,
                screen.left,
                screen.top,
                screen.right - screen.left,
                screen.bottom - screen.top,
                SWP_FRAMECHANGED | SWP_NOZORDER | SWP_NOOWNERZORDER,
            );
        }
    }
}
