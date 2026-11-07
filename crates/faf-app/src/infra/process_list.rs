//! The processes running on this machine, as a Toolhelp snapshot names them.
//!
//! Shared by the borderless window, which looks for the game below a launch
//! command, and the companion programs, which can wait for a program of a
//! given name to stop running. Windows only: nothing else here needs to look.

/// A running process, as a snapshot names it.
pub(crate) struct Process {
    pub id: u32,
    pub parent: u32,
    /// The executable's file name, lowercase.
    pub file: String,
}

/// Every process running right now, or none when the snapshot fails.
pub(crate) fn all() -> Vec<Process> {
    system::all()
}

/// Whether a process with this executable file name is running. Compared
/// without regard to case, and with `.exe` added to a name that has no
/// extension, which is how people type them.
pub(crate) fn image_running(image: &str) -> bool {
    let wanted = image.trim().to_lowercase();
    if wanted.is_empty() {
        return false;
    }
    let with_exe = if wanted.contains('.') {
        wanted.clone()
    } else {
        format!("{wanted}.exe")
    };
    all()
        .iter()
        .any(|process| process.file == wanted || process.file == with_exe)
}

mod system {
    use super::Process;

    type Handle = isize;

    /// From `tlhelp32.h`.
    const TH32CS_SNAPPROCESS: u32 = 0x0000_0002;
    const INVALID_HANDLE_VALUE: Handle = -1;
    const MAX_PATH: usize = 260;

    /// `PROCESSENTRY32W`.
    #[repr(C)]
    struct ProcessEntry {
        size: u32,
        usage: u32,
        process_id: u32,
        default_heap_id: usize,
        module_id: u32,
        threads: u32,
        parent_process_id: u32,
        priority_class_base: i32,
        flags: u32,
        exe_file: [u16; MAX_PATH],
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CloseHandle(handle: Handle) -> i32;
        fn CreateToolhelp32Snapshot(flags: u32, process_id: u32) -> Handle;
        fn Process32FirstW(snapshot: Handle, entry: *mut ProcessEntry) -> i32;
        fn Process32NextW(snapshot: Handle, entry: *mut ProcessEntry) -> i32;
    }

    pub(super) fn all() -> Vec<Process> {
        // Sound: plain integer arguments; a failure returns
        // `INVALID_HANDLE_VALUE`.
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return Vec::new();
        }
        let mut entry = ProcessEntry {
            size: std::mem::size_of::<ProcessEntry>() as u32,
            usage: 0,
            process_id: 0,
            default_heap_id: 0,
            module_id: 0,
            threads: 0,
            parent_process_id: 0,
            priority_class_base: 0,
            flags: 0,
            exe_file: [0; MAX_PATH],
        };
        let mut processes = Vec::new();
        // Sound: a snapshot handle from the call above and a pointer to a
        // local entry whose `size` is set, which is what both calls require.
        let mut more = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
        while more {
            let length = entry
                .exe_file
                .iter()
                .position(|&unit| unit == 0)
                .unwrap_or(MAX_PATH);
            processes.push(Process {
                id: entry.process_id,
                parent: entry.parent_process_id,
                file: String::from_utf16_lossy(&entry.exe_file[..length]).to_lowercase(),
            });
            // Sound: as for `Process32FirstW` above.
            more = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
        }
        // Sound: the snapshot handle came from a successful call and is
        // closed exactly once, here.
        unsafe { CloseHandle(snapshot) };
        processes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn this_test_finds_its_own_process_by_file_name() {
        let me = std::env::current_exe().unwrap();
        let file = me.file_name().unwrap().to_string_lossy().into_owned();
        assert!(image_running(&file.to_uppercase()));
        let stem = me.file_stem().unwrap().to_string_lossy().into_owned();
        assert!(image_running(&stem), "a name without .exe is read as one");
        assert!(!image_running(""));
        assert!(!image_running("no-such-program-faf-companion.exe"));
    }
}
