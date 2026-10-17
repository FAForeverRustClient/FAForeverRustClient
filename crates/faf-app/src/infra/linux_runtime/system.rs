//! What the system has to provide before the runtime can be installed.
//!
//! The same checks `setup.sh` runs before it downloads anything: a working
//! `bwrap`, and the 32- and 64-bit Vulkan loaders in the linker cache. Each one
//! needs the package manager or root, so all the client can do about a
//! missing one is say which and how.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use faf_domain::state::{LinuxDistribution, LinuxPrerequisite};

/// Everything missing, in the order the UI lists it. Empty means the runtime
/// can be installed.
pub(super) async fn missing_prerequisites(game_found: bool) -> Vec<LinuxPrerequisite> {
    let mut missing = Vec::new();
    match bubblewrap().await {
        Sandbox::Works => {}
        Sandbox::NotInstalled => missing.push(LinuxPrerequisite::Bubblewrap),
        Sandbox::Refused => missing.push(LinuxPrerequisite::UserNamespaces),
    }
    // A system without `ldconfig` (NixOS) cannot be asked; faf-linux stops
    // there, but the loaders may well be present, so this says nothing rather
    // than something false. A missing loader still shows up as the game
    // failing to create its Vulkan device, which the logs name.
    if let Some(cache) = linker_cache().await {
        let (has_64, has_32) = vulkan_loaders(&cache);
        if !has_64 {
            missing.push(LinuxPrerequisite::Vulkan64);
        }
        if !has_32 {
            missing.push(LinuxPrerequisite::Vulkan32);
        }
    }
    if !succeeds("xz", &["--version"]).await {
        missing.push(LinuxPrerequisite::Xz);
    }
    if !game_found {
        missing.push(LinuxPrerequisite::ForgedAlliance);
    }
    missing
}

enum Sandbox {
    Works,
    NotInstalled,
    Refused,
}

/// `bwrap --ro-bind / / true`, the probe `setup.sh` uses.
///
/// An installed `bwrap` that still fails is nearly always Ubuntu's AppArmor
/// rule against unprivileged user namespaces (`setup.sh` says as much), so
/// that is what it is reported as.
async fn bubblewrap() -> Sandbox {
    let probe = tokio::process::Command::new("bwrap")
        .args(["--ro-bind", "/", "/", "true"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await;
    match probe {
        Ok(status) if status.success() => Sandbox::Works,
        Ok(_) => Sandbox::Refused,
        Err(_) => Sandbox::NotInstalled,
    }
}

async fn succeeds(program: &str, args: &[&str]) -> bool {
    tokio::process::Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .is_ok_and(|status| status.success())
}

/// `ldconfig -p`, from `PATH` or from the two places distributions keep it
/// outside a user's `PATH`.
async fn linker_cache() -> Option<String> {
    let candidates = [
        PathBuf::from("ldconfig"),
        PathBuf::from("/usr/sbin/ldconfig"),
        PathBuf::from("/sbin/ldconfig"),
    ];
    for program in candidates {
        let output = tokio::process::Command::new(&program)
            .arg("-p")
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .await;
        if let Ok(output) = output {
            if output.status.success() {
                return Some(String::from_utf8_lossy(&output.stdout).into_owned());
            }
        }
    }
    None
}

/// Whether the linker cache lists a 64-bit and a 32-bit `libvulkan.so.1`.
///
/// `ldconfig -p` prints one library per line, tagged with its ABI:
/// `libvulkan.so.1 (libc6,x86-64) => /usr/lib/x86_64-linux-gnu/libvulkan.so.1`
/// for 64-bit and a bare `(libc6)` for 32-bit x86, which is how `setup.sh`
/// tells them apart.
pub(super) fn vulkan_loaders(cache: &str) -> (bool, bool) {
    let mut has_64 = false;
    let mut has_32 = false;
    for line in cache.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("libvulkan.so.1 ") else {
            continue;
        };
        if rest.starts_with("(libc6,x86-64)") {
            has_64 = true;
        } else if rest.starts_with("(libc6)") {
            has_32 = true;
        }
    }
    (has_64, has_32)
}

/// The distribution family, from `/etc/os-release`.
pub(super) fn distribution() -> LinuxDistribution {
    std::fs::read_to_string("/etc/os-release")
        .map(|text| distribution_from_os_release(&text))
        .unwrap_or_default()
}

/// `ID` first, then `ID_LIKE`, which is where derivatives name their parent
/// (`ID=linuxmint`, `ID_LIKE="ubuntu debian"`).
pub(super) fn distribution_from_os_release(text: &str) -> LinuxDistribution {
    let field = |key: &str| {
        text.lines()
            .find_map(|line| line.trim().strip_prefix(key))
            .map(|value| value.trim().trim_matches(['"', '\'']).to_ascii_lowercase())
            .unwrap_or_default()
    };
    let id = field("ID=");
    let like = field("ID_LIKE=");
    for name in std::iter::once(id.as_str()).chain(like.split_whitespace()) {
        match name {
            "debian" | "ubuntu" => return LinuxDistribution::Debian,
            "fedora" | "rhel" | "centos" => return LinuxDistribution::Fedora,
            "arch" | "archlinux" => return LinuxDistribution::Arch,
            _ => {}
        }
    }
    LinuxDistribution::Other
}

/// Whether a process called `steam` is running, which is when `launchwrapper`
/// loads Steam's overlay into the game (its `pgrep steam`).
pub(super) fn steam_is_running() -> bool {
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return false;
    };
    entries.flatten().any(|entry| {
        let is_process = entry
            .file_name()
            .to_str()
            .is_some_and(|name| name.bytes().all(|b| b.is_ascii_digit()));
        is_process
            && std::fs::read_to_string(entry.path().join("comm"))
                .is_ok_and(|comm| comm.trim() == "steam")
    })
}

/// A path the way the container will be asked to share it: resolved through
/// symlinks, because `~/.steam/steam` is one and pressure-vessel shares what a
/// path names, not the link. Missing paths are left out, since there is nothing
/// to share.
pub(super) fn resolved(path: &Path) -> Option<PathBuf> {
    std::fs::canonicalize(path).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_vulkan_loaders_are_told_apart_by_their_abi_tag() {
        let cache = "1234 libs found in cache `/etc/ld.so.cache'\n\
            \tlibvulkan.so.1 (libc6,x86-64) => /lib/x86_64-linux-gnu/libvulkan.so.1\n\
            \tlibvulkan.so.1 (libc6) => /lib/i386-linux-gnu/libvulkan.so.1\n\
            \tlibvulkan.so (libc6,x86-64) => /lib/x86_64-linux-gnu/libvulkan.so\n";
        assert_eq!(vulkan_loaders(cache), (true, true));
    }

    #[test]
    fn a_system_with_only_the_64_bit_loader_lacks_the_32_bit_one() {
        let cache = "\tlibvulkan.so.1 (libc6,x86-64) => /usr/lib/libvulkan.so.1\n\
            \tlibvulkan_radeon.so (libc6) => /usr/lib32/libvulkan_radeon.so\n";
        assert_eq!(vulkan_loaders(cache), (true, false));
        assert_eq!(vulkan_loaders(""), (false, false));
    }

    #[test]
    fn derivatives_are_found_through_id_like() {
        let mint = "NAME=\"Linux Mint\"\nID=linuxmint\nID_LIKE=\"ubuntu debian\"\n";
        assert_eq!(
            distribution_from_os_release(mint),
            LinuxDistribution::Debian
        );
        let ubuntu = "ID=ubuntu\nID_LIKE=debian\n";
        assert_eq!(
            distribution_from_os_release(ubuntu),
            LinuxDistribution::Debian
        );
        let bazzite = "ID=bazzite\nID_LIKE=\"fedora\"\n";
        assert_eq!(
            distribution_from_os_release(bazzite),
            LinuxDistribution::Fedora
        );
        let cachy = "ID=cachyos\nID_LIKE=arch\n";
        assert_eq!(distribution_from_os_release(cachy), LinuxDistribution::Arch);
        let arch = "ID=arch\n";
        assert_eq!(distribution_from_os_release(arch), LinuxDistribution::Arch);
        let gentoo = "ID=gentoo\n";
        assert_eq!(
            distribution_from_os_release(gentoo),
            LinuxDistribution::Other
        );
    }

    #[test]
    fn version_id_is_not_mistaken_for_id() {
        // `VERSION_ID=` ends in `ID=` too, and comes first in some files.
        let text = "VERSION_ID=\"40\"\nID=fedora\n";
        assert_eq!(
            distribution_from_os_release(text),
            LinuxDistribution::Fedora
        );
    }
}
