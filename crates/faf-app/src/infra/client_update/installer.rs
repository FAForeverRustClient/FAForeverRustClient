//! Build arguments separately from starting a downloaded installer.
use std::{path::Path, process::Command};

pub(super) fn command(path: &Path, windows: bool) -> Command {
    if path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("msi"))
    {
        let mut command = Command::new("msiexec");
        command.arg("/i").arg(path);
        if windows {
            command.args(["/passive", "AUTOLAUNCHAPP=True"]);
        }
        command
    } else {
        let mut command = Command::new(path);
        if windows {
            command.args(["/P", "/UPDATE", "/R"]);
        }
        command
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    #[test]
    fn windows_setup_runs_passively_in_update_mode_and_reopens_the_client() {
        let path = Path::new("cache with spaces/faf-client-1.2.3-setup.exe");
        let command = command(path, true);
        assert_eq!(command.get_program(), path);
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            ["/P", "/UPDATE", "/R"]
        );
    }

    #[test]
    fn windows_msi_keeps_the_path_one_argument_and_requests_restart() {
        let path = Path::new("cache with spaces/faf-client-1.2.3.msi");
        let command = command(path, true);
        assert_eq!(command.get_program(), "msiexec");
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            [
                OsStr::new("/i"),
                path.as_os_str(),
                OsStr::new("/passive"),
                OsStr::new("AUTOLAUNCHAPP=True"),
            ]
        );
    }

    #[test]
    fn other_platforms_keep_the_existing_launch_arguments() {
        for name in [
            "faf-client.AppImage",
            "faf-client.dmg",
            "faf-client.app.tar.gz",
        ] {
            let path = Path::new(name);
            let command = command(path, false);
            assert_eq!(command.get_program(), path);
            assert_eq!(command.get_args().count(), 0);
        }
    }
}
