//! Installing the runtime: faf-linux's `setup.sh` and `update-component.sh`.
//!
//! The order is theirs: Proton and the Steam Runtime, `wineboot` to make the
//! prefix, the DirectX redistributable into it, DXVK last. Each part is
//! recorded in `installed.json` as soon as it is in place, so a run that stops
//! halfway resumes at the part it stopped in, and a part whose pin changed in
//! a client update is the only one installed again.
//!
//! Archives are unpacked by the system's `tar`, as faf-linux does. Every
//! distribution has it, it already knows gzip and (through `xz`, which the
//! prerequisites check) xz, and using it adds no decompression crate to the
//! client for the sake of three files.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use faf_domain::state::LinuxRuntimeStep;
use sha2::{Digest as _, Sha256};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::{launch, Layout, Manifest, Pin, DIRECTX, DXVK, PROTON, STEAM_RUNTIME};
use crate::ports::RuntimeProgress;

const CALLED_OFF: &str = "the Linux runtime installation was called off";

/// faf-linux's `dxvk.conf`, verbatim.
const DXVK_CONF: &str =
    "# This will hopefully help with crashes due to running out of address space\n\
d3d9.evictManagedOnUnlock = True\n\
# Fix some broken effects\n\
d3d9.floatEmulation = Strict\n";

/// The libraries `tools/dxvk-install.sh` installs, `dxgi` included as
/// `update-component.sh` asks it to.
const DXVK_LIBRARIES: [&str; 4] = ["d3d9", "d3d10core", "d3d11", "dxgi"];

pub(super) async fn install(
    layout: &Layout,
    progress: &mpsc::Sender<RuntimeProgress>,
    called_off: &CancellationToken,
) -> Result<(), String> {
    std::fs::create_dir_all(layout.root())
        .map_err(|e| format!("could not create {}: {e}", layout.root().display()))?;
    let http = crate::infra::http::https_only_download_client();
    let mut manifest = Manifest::read(layout);

    if manifest.proton != PROTON.version || !layout.proton_dir().join("files").is_dir() {
        let archive = download(&http, layout, &PROTON, progress, called_off).await?;
        step(progress, unpacking(&PROTON)).await;
        // Wine's Mono and Gecko are about 450 MB together and the prefix is
        // made without both; faf-linux leaves them, and protonfixes, out.
        let top = PROTON.version;
        let excludes = [
            format!("{top}/files/share/wine/mono"),
            format!("{top}/files/share/wine/gecko"),
            format!("{top}/protonfixes"),
        ];
        let staging = unpack(
            layout,
            &archive,
            Compression::Gzip,
            false,
            &excludes,
            called_off,
        )
        .await?;
        replace_dir(&staging.join(top), &layout.proton_dir())?;
        finish_part(layout, &archive, &staging);
        retire(&manifest.proton, PROTON.version, |v| {
            layout.proton_dir_for(v)
        });
        manifest.proton = PROTON.version.into();
        manifest.write(layout)?;
    }

    if manifest.steam_runtime != STEAM_RUNTIME.version
        || !layout.steam_runtime_dir().join("run").is_file()
    {
        let archive = download(&http, layout, &STEAM_RUNTIME, progress, called_off).await?;
        step(progress, unpacking(&STEAM_RUNTIME)).await;
        let staging = unpack(layout, &archive, Compression::Xz, true, &[], called_off).await?;
        replace_dir(&staging, &layout.steam_runtime_dir())?;
        finish_part(layout, &archive, &staging);
        retire(&manifest.steam_runtime, STEAM_RUNTIME.version, |v| {
            layout.steam_runtime_dir_for(v)
        });
        manifest.steam_runtime = STEAM_RUNTIME.version.into();
        manifest.write(layout)?;
    }

    // Small enough to write on every run, which also repairs them.
    write_executable(&layout.srt_wrapper(), launch::SRT_WRAPPER)?;
    std::fs::write(layout.dxvk_conf(), DXVK_CONF)
        .map_err(|e| format!("could not write dxvk.conf: {e}"))?;
    std::fs::create_dir_all(layout.dxvk_cache())
        .map_err(|e| format!("could not create the DXVK cache: {e}"))?;

    let around = super::surroundings(Vec::new());

    if !manifest.prefix || !layout.prefix().join("drive_c").is_dir() {
        step(progress, LinuxRuntimeStep::CreatingPrefix).await;
        wine(
            layout,
            &around,
            ["wineboot".into(), "-u".into()],
            called_off,
        )
        .await?;
        manifest.prefix = true;
        manifest.write(layout)?;
    }

    if manifest.direct_x != DIRECTX.version {
        let redist = download(&http, layout, &DIRECTX, progress, called_off).await?;
        step(progress, LinuxRuntimeStep::InstallingDirectX).await;
        let extracted = layout.root().join("directx");
        let _ = std::fs::remove_dir_all(&extracted);
        std::fs::create_dir_all(&extracted)
            .map_err(|e| format!("could not create {}: {e}", extracted.display()))?;
        // The redistributable unpacks itself into a folder named the Windows
        // way (`winepath -w` in `setup.sh`), then its DXSETUP installs D3DX9
        // and XACT into the prefix.
        let target = format!(
            "/T:{}",
            crate::infra::game::game_visible_path(&extracted, true)
        );
        wine(
            layout,
            &around,
            [
                redist.clone().into_os_string(),
                target.into(),
                "/Q".into(),
                "/C".into(),
            ],
            called_off,
        )
        .await?;
        wine(
            layout,
            &around,
            [
                extracted.join("DXSETUP.exe").into_os_string(),
                "/silent".into(),
            ],
            called_off,
        )
        .await?;
        let _ = std::fs::remove_dir_all(&extracted);
        let _ = std::fs::remove_file(&redist);
        manifest.direct_x = DIRECTX.version.into();
        manifest.write(layout)?;
    }

    if manifest.dxvk != DXVK.version || !layout.dxvk_dir().is_dir() {
        let archive = download(&http, layout, &DXVK, progress, called_off).await?;
        step(progress, unpacking(&DXVK)).await;
        let staging = unpack(layout, &archive, Compression::Gzip, false, &[], called_off).await?;
        replace_dir(
            &staging.join(format!("dxvk-{}", DXVK.version)),
            &layout.dxvk_dir(),
        )?;
        finish_part(layout, &archive, &staging);
        step(progress, LinuxRuntimeStep::InstallingDxvk).await;
        copy_dxvk_libraries(&layout.dxvk_dir(), &layout.prefix())?;
        for library in DXVK_LIBRARIES {
            wine(
                layout,
                &around,
                [
                    "reg".into(),
                    "add".into(),
                    r"HKEY_CURRENT_USER\Software\Wine\DllOverrides".into(),
                    "/v".into(),
                    library.into(),
                    "/d".into(),
                    "native".into(),
                    "/f".into(),
                ],
                called_off,
            )
            .await?;
        }
        retire(&manifest.dxvk, DXVK.version, |v| layout.dxvk_dir_for(v));
        manifest.dxvk = DXVK.version.into();
        manifest.write(layout)?;
    }

    let _ = std::fs::remove_dir_all(layout.downloads());
    Ok(())
}

fn unpacking(pin: &Pin) -> LinuxRuntimeStep {
    LinuxRuntimeStep::Unpacking {
        component: pin.component,
    }
}

async fn step(progress: &mpsc::Sender<RuntimeProgress>, step: LinuxRuntimeStep) {
    let _ = progress.send(RuntimeProgress::Installing(step)).await;
}

/// Fetch `pin` into `downloads/` and check it against its digest.
///
/// Written to a `.partial` file and renamed only once the digest matched, so
/// nothing half-downloaded or altered is ever unpacked or run. A file already
/// complete from an earlier, interrupted run is checked and kept.
async fn download(
    http: &reqwest::Client,
    layout: &Layout,
    pin: &Pin,
    progress: &mpsc::Sender<RuntimeProgress>,
    called_off: &CancellationToken,
) -> Result<PathBuf, String> {
    use futures_util::StreamExt as _;
    use tokio::io::AsyncWriteExt as _;

    let directory = layout.downloads();
    tokio::fs::create_dir_all(&directory)
        .await
        .map_err(|e| format!("could not create the download directory: {e}"))?;
    let target = directory.join(pin.file_name);
    if target.is_file() {
        let existing = target.clone();
        let digest = tokio::task::spawn_blocking(move || file_sha256(&existing))
            .await
            .map_err(|e| e.to_string())?;
        if digest.as_deref() == Ok(pin.sha256) {
            return Ok(target);
        }
        let _ = tokio::fs::remove_file(&target).await;
    }
    let partial = directory.join(format!("{}.partial", pin.file_name));

    let _ = progress
        .send(RuntimeProgress::Downloading {
            component: pin.component,
            received_bytes: 0,
            total_bytes: clamp(pin.size),
        })
        .await;
    let response = tokio::select! {
        biased;
        () = called_off.cancelled() => return Err(CALLED_OFF.into()),
        response = http.get(pin.url).send() => response,
    }
    .map_err(|e| {
        format!(
            "could not download {}: {}",
            pin.file_name,
            crate::infra::http::describe_transport_error(&e)
        )
    })?;
    if !response.status().is_success() {
        return Err(format!(
            "downloading {} returned {}",
            pin.file_name,
            response.status()
        ));
    }
    if response
        .content_length()
        .is_some_and(|size| size != pin.size)
    {
        return Err(format!(
            "{} is not the size this client expects, so it is not the file it pins",
            pin.file_name
        ));
    }

    let mut file = tokio::fs::File::create(&partial)
        .await
        .map_err(|e| format!("could not write {}: {e}", partial.display()))?;
    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    let mut reported_percent = 0;
    let mut stream = response.bytes_stream();
    let written: Result<(), String> = async {
        loop {
            let chunk = tokio::select! {
                biased;
                () = called_off.cancelled() => return Err(CALLED_OFF.to_string()),
                chunk = stream.next() => chunk,
            };
            let Some(chunk) = chunk else { break };
            let chunk = chunk.map_err(|e| {
                format!(
                    "the download of {} broke off: {}",
                    pin.file_name,
                    crate::infra::http::describe_transport_error(&e)
                )
            })?;
            received += chunk.len() as u64;
            if received > pin.size {
                return Err(format!(
                    "{} is larger than the file this client pins",
                    pin.file_name
                ));
            }
            hasher.update(&chunk);
            file.write_all(&chunk)
                .await
                .map_err(|e| format!("could not write {}: {e}", partial.display()))?;
            // A whole percent at a time: every report is an event the state is
            // reduced by.
            let percent = received * 100 / pin.size;
            if percent > reported_percent {
                reported_percent = percent;
                let _ = progress
                    .send(RuntimeProgress::Downloading {
                        component: pin.component,
                        received_bytes: clamp(received),
                        total_bytes: clamp(pin.size),
                    })
                    .await;
            }
        }
        file.flush()
            .await
            .map_err(|e| format!("could not write {}: {e}", partial.display()))?;
        Ok(())
    }
    .await;
    drop(file);
    if let Err(reason) = written {
        let _ = tokio::fs::remove_file(&partial).await;
        return Err(reason);
    }

    let digest = format!("{:x}", hasher.finalize());
    if digest != pin.sha256 {
        let _ = tokio::fs::remove_file(&partial).await;
        return Err(format!(
            "{} did not match its checksum, so it was not installed",
            pin.file_name
        ));
    }
    tokio::fs::rename(&partial, &target)
        .await
        .map_err(|e| format!("could not keep {}: {e}", pin.file_name))?;
    Ok(target)
}

fn clamp(bytes: u64) -> u32 {
    u32::try_from(bytes).unwrap_or(u32::MAX)
}

fn file_sha256(path: &Path) -> Result<String, String> {
    use std::io::Read as _;
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let read = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[derive(Debug, Clone, Copy)]
enum Compression {
    Gzip,
    Xz,
}

/// `tar` the archive into a fresh `.staging/`, and return it.
async fn unpack(
    layout: &Layout,
    archive: &Path,
    compression: Compression,
    strip_top_directory: bool,
    excludes: &[String],
    called_off: &CancellationToken,
) -> Result<PathBuf, String> {
    let staging = layout.staging();
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging)
        .map_err(|e| format!("could not create {}: {e}", staging.display()))?;
    let args = tar_arguments(
        &staging,
        archive,
        compression,
        strip_top_directory,
        excludes,
    );
    let mut command = tokio::process::Command::new("tar");
    command.args(args);
    run(command, "tar", called_off).await?;
    Ok(staging)
}

/// GNU tar's options for one archive. Excludes come first, where every tar
/// that has them accepts them.
fn tar_arguments(
    staging: &Path,
    archive: &Path,
    compression: Compression,
    strip_top_directory: bool,
    excludes: &[String],
) -> Vec<OsString> {
    let mut args: Vec<OsString> = excludes
        .iter()
        .map(|pattern| format!("--exclude={pattern}").into())
        .collect();
    if strip_top_directory {
        args.push("--strip-components=1".into());
    }
    args.push("-C".into());
    args.push(staging.as_os_str().to_os_string());
    args.push(
        match compression {
            Compression::Gzip => "-xzf",
            Compression::Xz => "-xJf",
        }
        .into(),
    );
    args.push(archive.as_os_str().to_os_string());
    args
}

/// Put `unpacked` where `target` is, removing whatever was there.
fn replace_dir(unpacked: &Path, target: &Path) -> Result<(), String> {
    if !unpacked.is_dir() {
        return Err(format!(
            "the archive did not hold {}",
            unpacked
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default()
        ));
    }
    if target.exists() {
        std::fs::remove_dir_all(target)
            .map_err(|e| format!("could not replace {}: {e}", target.display()))?;
    }
    std::fs::rename(unpacked, target)
        .map_err(|e| format!("could not move {} into place: {e}", target.display()))
}

/// The archive and the staging folder are spent once their contents moved.
fn finish_part(layout: &Layout, archive: &Path, staging: &Path) {
    let _ = std::fs::remove_file(archive);
    if staging != layout.root() {
        let _ = std::fs::remove_dir_all(staging);
    }
}

/// Remove the directory of a version that was replaced. The version comes from
/// `installed.json`, a file on disk, so it is used only when it is a plain
/// folder name.
fn retire(previous: &str, current: &str, dir: impl Fn(&str) -> PathBuf) {
    let plain = !previous.is_empty()
        && previous != "."
        && previous != ".."
        && !previous.contains(['/', '\\']);
    if plain && previous != current {
        let _ = std::fs::remove_dir_all(dir(previous));
    }
}

#[cfg(unix)]
fn write_executable(path: &Path, content: &str) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::write(path, content)
        .and_then(|()| std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)))
        .map_err(|e| format!("could not write {}: {e}", path.display()))
}

#[cfg(not(unix))]
fn write_executable(path: &Path, content: &str) -> Result<(), String> {
    std::fs::write(path, content).map_err(|e| format!("could not write {}: {e}", path.display()))
}

/// `tools/dxvk-install.sh`: the 64-bit libraries into `system32` and the
/// 32-bit ones into `syswow64` in a 64-bit prefix, or the 32-bit ones into
/// `system32` in a 32-bit one.
fn copy_dxvk_libraries(dxvk: &Path, prefix: &Path) -> Result<(), String> {
    let windows = prefix.join("drive_c").join("windows");
    let system32 = windows.join("system32");
    let syswow64 = windows.join("syswow64");
    if !system32.is_dir() {
        return Err("the Wine prefix has no system32 folder".into());
    }
    let pairs: Vec<(&str, &Path)> = if syswow64.is_dir() {
        vec![("x64", system32.as_path()), ("x32", syswow64.as_path())]
    } else {
        vec![("x32", system32.as_path())]
    };
    for library in DXVK_LIBRARIES {
        let file = format!("{library}.dll");
        for (architecture, into) in &pairs {
            let from = dxvk.join(architecture).join(&file);
            std::fs::copy(&from, into.join(&file))
                .map_err(|e| format!("could not install DXVK's {file}: {e}"))?;
        }
    }
    Ok(())
}

/// `launchwrapper-env wine <args>`: one program inside the container.
async fn wine(
    layout: &Layout,
    around: &launch::Surroundings,
    args: impl IntoIterator<Item = OsString>,
    called_off: &CancellationToken,
) -> Result<(), String> {
    let planned = launch::wine_command(layout, around, args);
    let label = planned
        .args
        .get(3)
        .map(|program| {
            Path::new(program)
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default()
        })
        .unwrap_or_else(|| "wine".into());
    run(
        tokio::process::Command::from(planned.std_command()),
        &label,
        called_off,
    )
    .await
}

/// Run to the end, or kill it when called off. Its output goes to the log and,
/// on failure, the last of it into the reason.
async fn run(
    mut command: tokio::process::Command,
    label: &str,
    called_off: &CancellationToken,
) -> Result<(), String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let child = command
        .spawn()
        .map_err(|e| format!("could not start {label}: {e}"))?;
    let output = tokio::select! {
        biased;
        () = called_off.cancelled() => return Err(CALLED_OFF.into()),
        output = child.wait_with_output() => output,
    }
    .map_err(|e| format!("{label} did not finish: {e}"))?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    tracing::info!(
        step = label,
        status = %output.status,
        stdout = %tail(&String::from_utf8_lossy(&output.stdout), 2000),
        stderr = %tail(&stderr, 4000),
        "Linux runtime step finished"
    );
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "{label} failed ({}): {}",
            output.status,
            tail(&stderr, 400).trim()
        ))
    }
}

/// The last `limit` bytes of `text`, cut at a character boundary.
fn tail(text: &str, limit: usize) -> &str {
    if text.len() <= limit {
        return text;
    }
    let mut start = text.len() - limit;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    &text[start..]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proton_is_unpacked_without_mono_gecko_and_protonfixes() {
        let args = tar_arguments(
            Path::new("staging"),
            Path::new("GE-Proton10-34.tar.gz"),
            Compression::Gzip,
            false,
            &["GE-Proton10-34/files/share/wine/mono".into()],
        );
        assert_eq!(
            args,
            vec![
                OsString::from("--exclude=GE-Proton10-34/files/share/wine/mono"),
                "-C".into(),
                "staging".into(),
                "-xzf".into(),
                "GE-Proton10-34.tar.gz".into(),
            ]
        );
    }

    #[test]
    fn the_steam_runtime_loses_its_top_directory_and_is_read_as_xz() {
        let args = tar_arguments(
            Path::new("staging"),
            Path::new("SteamLinuxRuntime_4.tar.xz"),
            Compression::Xz,
            true,
            &[],
        );
        assert_eq!(
            args,
            vec![
                OsString::from("--strip-components=1"),
                "-C".into(),
                "staging".into(),
                "-xJf".into(),
                "SteamLinuxRuntime_4.tar.xz".into(),
            ]
        );
    }

    #[test]
    fn a_replaced_version_is_removed_but_never_by_a_path_from_the_record() {
        let temp = tempfile::tempdir().unwrap();
        let old = temp.path().join("dxvk-2.6");
        std::fs::create_dir_all(&old).unwrap();
        retire("2.6", "2.7.1", |v| temp.path().join(format!("dxvk-{v}")));
        assert!(!old.exists());

        let outside = temp.path().join("keep");
        std::fs::create_dir_all(&outside).unwrap();
        for hostile in ["../keep", "..", "", "a/b", r"a\b"] {
            retire(hostile, "2.7.1", |v| temp.path().join(v));
        }
        assert!(outside.exists());
        // The current version is never removed.
        let current = temp.path().join("dxvk-2.7.1");
        std::fs::create_dir_all(&current).unwrap();
        retire("2.7.1", "2.7.1", |v| temp.path().join(format!("dxvk-{v}")));
        assert!(current.exists());
    }

    #[test]
    fn dxvk_goes_into_both_system_folders_of_a_64_bit_prefix() {
        let temp = tempfile::tempdir().unwrap();
        let dxvk = temp.path().join("dxvk");
        for architecture in ["x64", "x32"] {
            std::fs::create_dir_all(dxvk.join(architecture)).unwrap();
            for library in DXVK_LIBRARIES {
                std::fs::write(
                    dxvk.join(architecture).join(format!("{library}.dll")),
                    architecture,
                )
                .unwrap();
            }
        }
        let prefix = temp.path().join("prefix");
        let windows = prefix.join("drive_c").join("windows");
        std::fs::create_dir_all(windows.join("system32")).unwrap();
        std::fs::create_dir_all(windows.join("syswow64")).unwrap();

        copy_dxvk_libraries(&dxvk, &prefix).unwrap();

        for library in DXVK_LIBRARIES {
            let file = format!("{library}.dll");
            assert_eq!(
                std::fs::read(windows.join("system32").join(&file)).unwrap(),
                b"x64"
            );
            assert_eq!(
                std::fs::read(windows.join("syswow64").join(&file)).unwrap(),
                b"x32"
            );
        }
    }

    #[test]
    fn a_32_bit_prefix_gets_the_32_bit_libraries_in_system32() {
        let temp = tempfile::tempdir().unwrap();
        let dxvk = temp.path().join("dxvk");
        std::fs::create_dir_all(dxvk.join("x32")).unwrap();
        for library in DXVK_LIBRARIES {
            std::fs::write(dxvk.join("x32").join(format!("{library}.dll")), b"x32").unwrap();
        }
        let prefix = temp.path().join("prefix");
        let system32 = prefix.join("drive_c").join("windows").join("system32");
        std::fs::create_dir_all(&system32).unwrap();

        copy_dxvk_libraries(&dxvk, &prefix).unwrap();

        assert_eq!(std::fs::read(system32.join("d3d9.dll")).unwrap(), b"x32");
    }

    #[test]
    fn a_prefix_without_system32_is_refused() {
        let temp = tempfile::tempdir().unwrap();
        assert!(copy_dxvk_libraries(temp.path(), temp.path()).is_err());
    }

    #[test]
    fn the_tail_of_a_long_log_starts_on_a_character() {
        assert_eq!(tail("short", 10), "short");
        assert_eq!(tail("abcdef", 3), "def");
        // "é" is two bytes; a cut through it moves forward.
        assert_eq!(tail("aéb", 2), "b");
    }

    #[test]
    fn a_file_digest_is_lowercase_hex() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("x");
        std::fs::write(&file, b"abc").unwrap();
        assert_eq!(
            file_sha256(&file).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
