//! Text values from the Windows registry, behind a trait the tests can fake.
//!
//! Only the original game's discovery reads it (see
//! `game_updater::install`): Steam names its own folder there when it is not
//! under Program Files, and GOG names the folder each of its games went to.
//! Neither is a file the client could look at instead.
//!
//! Outside Windows there is no registry, and [`SystemRegistry`] answers
//! nothing, so the callers need no platform switches of their own.

/// The two registry roots the discovery reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Hive {
    /// `HKEY_CURRENT_USER`: Steam writes its folder here per user.
    CurrentUser,
    /// `HKEY_LOCAL_MACHINE`: installers write here for every user.
    LocalMachine,
}

/// Reads one text value. `None` for a key or value that does not exist, is
/// not text, or cannot be read: to the discovery all of those mean "not
/// here".
pub(crate) trait Registry {
    fn text(&self, hive: Hive, key: &str, value: &str) -> Option<String>;
}

/// This machine's registry.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct SystemRegistry;

impl Registry for SystemRegistry {
    fn text(&self, hive: Hive, key: &str, value: &str) -> Option<String> {
        system::text(hive, key, value)
    }
}

#[cfg(windows)]
mod system {
    use super::Hive;
    use std::ffi::c_void;

    /// `HKEY_CURRENT_USER` and `HKEY_LOCAL_MACHINE` from `winreg.h`: the
    /// 32-bit constants, sign-extended to the handle's width as the header's
    /// `(HKEY)(ULONG_PTR)((LONG)0x80000001)` does.
    const HKEY_CURRENT_USER: isize = 0x8000_0001_u32 as i32 as isize;
    const HKEY_LOCAL_MACHINE: isize = 0x8000_0002_u32 as i32 as isize;
    /// `RRF_RT_REG_SZ`: text only. A `REG_EXPAND_SZ` value is expanded and
    /// handed back as `REG_SZ`, so it is accepted too.
    const RRF_RT_REG_SZ: u32 = 0x0000_0002;
    const ERROR_SUCCESS: i32 = 0;
    /// No value the discovery reads is a path longer than this, in bytes.
    const MAX_BYTES: u32 = 64 * 1024;

    #[link(name = "advapi32")]
    extern "system" {
        fn RegGetValueW(
            key: isize,
            sub_key: *const u16,
            value: *const u16,
            flags: u32,
            kind: *mut u32,
            data: *mut c_void,
            data_bytes: *mut u32,
        ) -> i32;
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub(super) fn text(hive: Hive, key: &str, value: &str) -> Option<String> {
        let root = match hive {
            Hive::CurrentUser => HKEY_CURRENT_USER,
            Hive::LocalMachine => HKEY_LOCAL_MACHINE,
        };
        let key = wide(key);
        let value = wide(value);
        let mut bytes: u32 = 0;
        // SAFETY: both names are NUL-terminated and outlive the call; a null
        // buffer with a size pointer asks only for the size.
        let status = unsafe {
            RegGetValueW(
                root,
                key.as_ptr(),
                value.as_ptr(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut bytes,
            )
        };
        if status != ERROR_SUCCESS || bytes == 0 || bytes > MAX_BYTES {
            return None;
        }
        // The size can grow between the two calls; the second one then fails
        // and the value is taken as absent, which costs one candidate.
        let mut buffer = vec![0_u16; (bytes as usize).div_ceil(2)];
        let mut written = bytes;
        // SAFETY: `buffer` holds `written` bytes, which the call is told.
        let status = unsafe {
            RegGetValueW(
                root,
                key.as_ptr(),
                value.as_ptr(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                buffer.as_mut_ptr().cast(),
                &mut written,
            )
        };
        if status != ERROR_SUCCESS {
            return None;
        }
        buffer.truncate((written as usize) / 2);
        let end = buffer
            .iter()
            .position(|&unit| unit == 0)
            .unwrap_or(buffer.len());
        let text = String::from_utf16(&buffer[..end]).ok()?;
        (!text.trim().is_empty()).then_some(text)
    }
}

#[cfg(not(windows))]
mod system {
    use super::Hive;

    pub(super) fn text(_hive: Hive, _key: &str, _value: &str) -> Option<String> {
        None
    }
}

#[cfg(test)]
pub(crate) mod fake {
    use super::{Hive, Registry};
    use std::collections::HashMap;

    /// A registry holding exactly the values a test put in it. Keys and
    /// value names are matched without case, as Windows matches them.
    #[derive(Debug, Default)]
    pub(crate) struct FakeRegistry {
        values: HashMap<(bool, String, String), String>,
    }

    impl FakeRegistry {
        pub(crate) fn with(mut self, hive: Hive, key: &str, value: &str, text: &str) -> Self {
            self.values.insert(
                (
                    hive == Hive::CurrentUser,
                    key.to_lowercase(),
                    value.to_lowercase(),
                ),
                text.to_string(),
            );
            self
        }
    }

    impl Registry for FakeRegistry {
        fn text(&self, hive: Hive, key: &str, value: &str) -> Option<String> {
            self.values
                .get(&(
                    hive == Hive::CurrentUser,
                    key.to_lowercase(),
                    value.to_lowercase(),
                ))
                .cloned()
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    /// A value every Windows installation has, read through the real API:
    /// the only check that the declaration and the two-call dance are right.
    #[test]
    fn reads_a_value_every_windows_has() {
        let root = SystemRegistry.text(
            Hive::LocalMachine,
            r"SOFTWARE\Microsoft\Windows NT\CurrentVersion",
            "SystemRoot",
        );
        assert!(root.is_some_and(|root| root.len() > 2));
        assert_eq!(
            SystemRegistry.text(Hive::CurrentUser, r"Software\No Such Key Here", "Nothing"),
            None
        );
    }
}
