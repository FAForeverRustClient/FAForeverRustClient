//! Bounded, transactional installation of downloaded archives.
//!
//! Vault URLs cross the IPC boundary and zip metadata is remote input. Keep
//! the trust checks, body bound, path validation, expansion bound, and staging
//! rename in one place so maps and mods cannot drift apart.
//!
//! Two layouts are installed from here, sharing one safety envelope:
//!
//! * [`install_archive`] for the vault, where the archive's single top-level
//!   folder *is* the installed identity (a map or mod folder name).
//! * [`install_flat_archive`] for a publisher who ships loose files and lets
//!   the caller name the directory: the Galactic War client is exported this
//!   way, two files at the archive root.
//!
//! The per-entry checks live in [`check_entry`] so a second layout cannot be
//! added with a weaker envelope than the first.

use std::ffi::OsString;
use std::io::Write as _;
use std::path::{Component, Path, PathBuf};

use futures_util::StreamExt as _;

/// Generous enough for large content packages, bounded enough that a broken
/// or hostile server cannot consume all process memory.
pub const MAX_DOWNLOAD_BYTES: u64 = 512 * 1024 * 1024;
/// Zip bombs are constrained by both advertised expanded bytes and entries.
const MAX_EXPANDED_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 100_000;

/// Require a vault download to stay on the configured content origin and in
/// the owning category (`maps` or `mods`). The configured origin may be HTTP
/// for an explicit local test setup; production defaults to HTTPS.
pub fn validate_url(raw: &str, content_base: &str, category: &str) -> Result<(), String> {
    let (url, base) = same_origin_urls(raw, content_base)?;

    let base_path = base.path().trim_end_matches('/');
    let category_prefix = format!("{base_path}/{category}/");
    if !url.path().starts_with(&category_prefix) {
        return Err(format!(
            "refusing a vault download outside the {category} content path"
        ));
    }
    Ok(())
}

/// Require an ordinary HTTP(S) URL on the configured origin. Useful for
/// generated endpoints such as replay downloads that have no category path.
pub fn validate_origin_url(raw: &str, configured_base: &str) -> Result<(), String> {
    same_origin_urls(raw, configured_base).map(|_| ())
}

fn same_origin_urls(raw: &str, configured_base: &str) -> Result<(url::Url, url::Url), String> {
    let url = url::Url::parse(raw).map_err(|_| "vault download URL is invalid".to_string())?;
    let base = url::Url::parse(configured_base)
        .map_err(|_| "configured FAF content URL is invalid".to_string())?;
    let ordinary_origin = |value: &url::Url| {
        !value.cannot_be_a_base()
            && value.username().is_empty()
            && value.password().is_none()
            && matches!(value.scheme(), "http" | "https")
    };
    if !ordinary_origin(&url) || !ordinary_origin(&base) || url.origin() != base.origin() {
        return Err("refusing a vault download outside the configured FAF content origin".into());
    }
    Ok((url, base))
}

/// Read a response without trusting `Content-Length` or buffering forever.
pub async fn bounded_body(
    response: reqwest::Response,
    subject: &str,
    max_bytes: u64,
) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|size| size > max_bytes)
    {
        return Err(format!(
            "{subject} is larger than the allowed download size"
        ));
    }

    let mut body = Vec::new();
    let mut received = 0_u64;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("could not read {subject}: {error}"))?;
        received = received
            .checked_add(chunk.len() as u64)
            .ok_or_else(|| format!("{subject} is too large"))?;
        if received > max_bytes {
            return Err(format!(
                "{subject} is larger than the allowed download size"
            ));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// Validate and extract one top-level folder into a private staging directory,
/// validate its contents, then rename it into place. The destination is never
/// left half-installed and an existing folder is never overwritten.
pub fn install_archive<F>(
    bytes: &[u8],
    destination: &Path,
    expected_root: Option<&str>,
    validate_contents: F,
) -> Result<PathBuf, String>
where
    F: FnOnce(&Path) -> Result<(), String>,
{
    let root_name = inspect_archive(bytes, expected_root)?;
    std::fs::create_dir_all(destination)
        .map_err(|error| format!("could not create {}: {error}", destination.display()))?;

    let target = destination.join(&root_name);
    if target.exists() {
        return Err(format!("{} is already installed", target.display()));
    }

    let staging = unique_staging_path(destination);
    std::fs::create_dir(&staging)
        .map_err(|error| format!("could not create install staging folder: {error}"))?;
    let outcome = (|| {
        extract_archive(bytes, &staging, "vault archive")?;
        let staged_root = staging.join(&root_name);
        validate_contents(&staged_root)?;
        std::fs::rename(&staged_root, &target).map_err(|error| {
            format!("could not finish installing {}: {error}", target.display())
        })?;
        Ok(target.clone())
    })();
    let _ = std::fs::remove_dir_all(&staging);
    outcome
}

/// Install an archive that has no wrapping folder into a directory the caller
/// names.
///
/// Same envelope as [`install_archive`]: bounded expansion, no symbolic links,
/// no path escaping the destination, and an extraction into staging that is
/// renamed into place, so a failure leaves nothing half-installed. The
/// difference is only the layout: here the archive's entries land directly in
/// `target`, which must not already exist.
///
/// `validate_contents` is handed the staged directory before it is renamed, so
/// a caller can insist the files it expects are actually in there.
pub fn install_flat_archive<F>(
    bytes: &[u8],
    target: &Path,
    subject: &str,
    validate_contents: F,
) -> Result<(), String>
where
    F: FnOnce(&Path) -> Result<(), String>,
{
    inspect_flat_archive(bytes, subject)?;

    let parent = target
        .parent()
        .ok_or_else(|| format!("{} is not a usable install location", target.display()))?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("could not create {}: {error}", parent.display()))?;
    if target.exists() {
        return Err(format!("{} is already installed", target.display()));
    }

    // Staged beside the target so the rename stays on one filesystem.
    let staging = unique_staging_path(parent);
    std::fs::create_dir(&staging)
        .map_err(|error| format!("could not create install staging folder: {error}"))?;
    let outcome = (|| {
        extract_archive(bytes, &staging, subject)?;
        validate_contents(&staging)?;
        std::fs::rename(&staging, target)
            .map_err(|error| format!("could not finish installing {}: {error}", target.display()))
    })();
    if outcome.is_err() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    outcome
}

fn unique_staging_path(destination: &Path) -> PathBuf {
    loop {
        let candidate = destination.join(format!(".faf-install-{:016x}", rand::random::<u64>()));
        if !candidate.exists() {
            return candidate;
        }
    }
}

/// Bounds every archive must respect before a single entry is read.
fn check_archive_shape(len: usize, subject: &str) -> Result<(), String> {
    if len == 0 {
        return Err(format!("{subject} is empty"));
    }
    if len > MAX_ARCHIVE_ENTRIES {
        return Err(format!("{subject} contains too many entries"));
    }
    Ok(())
}

/// The per-entry checks every layout shares: no symbolic links, a bounded
/// total expansion, and a path that cannot escape the destination.
///
/// Takes the entry's properties rather than the entry, so both callers can use
/// it without either naming the zip crate's borrow-bound reader type.
fn check_entry(
    unix_mode: Option<u32>,
    size: u64,
    enclosed_name: Option<PathBuf>,
    expanded: &mut u64,
    subject: &str,
) -> Result<PathBuf, String> {
    if unix_mode.is_some_and(|mode| mode & 0o170000 == 0o120000) {
        return Err(format!("{subject} contains a symbolic link"));
    }
    *expanded = expanded
        .checked_add(size)
        .ok_or_else(|| format!("{subject} expands beyond the allowed size"))?;
    if *expanded > MAX_EXPANDED_BYTES {
        return Err(format!("{subject} expands beyond the allowed size"));
    }
    enclosed_name.ok_or_else(|| format!("{subject} contains an unsafe path"))
}

/// Validate an archive whose entries sit at the top level, with no wrapping
/// folder. The caller owns the destination directory name.
fn inspect_flat_archive(bytes: &[u8], subject: &str) -> Result<(), String> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|error| format!("not a valid zip archive: {error}"))?;
    check_archive_shape(archive.len(), subject)?;

    let mut expanded = 0_u64;
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| format!("could not inspect archive entry: {error}"))?;
        check_entry(
            entry.unix_mode(),
            entry.size(),
            entry.enclosed_name(),
            &mut expanded,
            subject,
        )?;
    }
    Ok(())
}

fn inspect_archive(bytes: &[u8], expected_root: Option<&str>) -> Result<OsString, String> {
    const SUBJECT: &str = "vault archive";
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|error| format!("not a valid zip archive: {error}"))?;
    check_archive_shape(archive.len(), SUBJECT)?;

    let mut root: Option<OsString> = None;
    let mut expanded = 0_u64;
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| format!("could not inspect archive entry: {error}"))?;
        let relative = check_entry(
            entry.unix_mode(),
            entry.size(),
            entry.enclosed_name(),
            &mut expanded,
            SUBJECT,
        )?;
        let mut components = relative.components();
        let Some(Component::Normal(first)) = components.next() else {
            return Err("vault archive contains an unsafe path".into());
        };
        if components.next().is_none() && !entry.is_dir() {
            return Err("vault archive must contain one top-level folder".into());
        }
        match &root {
            Some(existing) if existing != first => {
                return Err("vault archive contains more than one top-level folder".into())
            }
            None => root = Some(first.to_os_string()),
            _ => {}
        }
    }

    let root = root.ok_or_else(|| "vault archive has no install folder".to_string())?;
    if let Some(expected) = expected_root {
        if !root.to_string_lossy().eq_ignore_ascii_case(expected) {
            return Err(format!(
                "vault archive installs {:?}, expected {expected:?}",
                root.to_string_lossy()
            ));
        }
    }
    Ok(root)
}

fn extract_archive(bytes: &[u8], destination: &Path, subject: &str) -> Result<(), String> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|error| format!("not a valid zip archive: {error}"))?;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("could not read archive entry: {error}"))?;
        let relative = entry
            .enclosed_name()
            .ok_or_else(|| format!("{subject} contains an unsafe path"))?;
        let output = destination.join(relative);
        if entry.is_dir() {
            std::fs::create_dir_all(&output)
                .map_err(|error| format!("could not create {}: {error}", output.display()))?;
            continue;
        }
        if let Some(parent) = output.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("could not create {}: {error}", parent.display()))?;
        }
        let mut file = std::fs::File::create(&output)
            .map_err(|error| format!("could not create {}: {error}", output.display()))?;
        std::io::copy(&mut entry, &mut file)
            .map_err(|error| format!("could not write {}: {error}", output.display()))?;
        file.flush()
            .map_err(|error| format!("could not finish {}: {error}", output.display()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut bytes = std::io::Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut bytes);
            for (name, contents) in entries {
                writer
                    .start_file(*name, zip::write::SimpleFileOptions::default())
                    .unwrap();
                writer.write_all(contents).unwrap();
            }
            writer.finish().unwrap();
        }
        bytes.into_inner()
    }

    #[test]
    fn content_downloads_stay_on_the_configured_category() {
        assert!(validate_url(
            "https://content.faforever.com/maps/test.zip",
            "https://content.faforever.com",
            "maps"
        )
        .is_ok());
        for hostile in [
            "http://content.faforever.com/maps/test.zip",
            "https://evil.invalid/maps/test.zip",
            "https://content.faforever.com/mods/test.zip",
            "file:///maps/test.zip",
        ] {
            assert!(
                validate_url(hostile, "https://content.faforever.com", "maps").is_err(),
                "{hostile} must be refused"
            );
        }
    }

    #[test]
    fn archive_requires_one_expected_root() {
        let bytes = zip(&[("wanted/file.txt", b"ok")]);
        assert_eq!(
            inspect_archive(&bytes, Some("wanted")).unwrap(),
            OsString::from("wanted")
        );
        assert!(inspect_archive(&bytes, Some("other")).is_err());

        let multiple = zip(&[("one/a", b"a"), ("two/b", b"b")]);
        assert!(inspect_archive(&multiple, None).is_err());
    }

    fn temp_dir(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("faf-{tag}-test-{}", rand::random::<u64>()))
    }

    #[test]
    fn a_flat_archive_installs_into_the_directory_the_caller_names() {
        // The shape the Galactic War client ships in: loose files, no root.
        let bytes = zip(&[
            ("faf_galactic_war_client.exe", b"binary"),
            ("faf_galactic_war_client.pck", b"content"),
        ]);
        let root = temp_dir("flat");
        let target = root.join("v2026.04.04.1");

        install_flat_archive(&bytes, &target, "the Galactic War archive", |_| Ok(())).unwrap();

        assert!(target.join("faf_galactic_war_client.exe").is_file());
        assert!(target.join("faf_galactic_war_client.pck").is_file());
        // The staging directory is gone, not left beside the install.
        let entries = std::fs::read_dir(&root).unwrap().count();
        assert_eq!(entries, 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn the_vault_installer_still_refuses_what_the_flat_one_accepts() {
        let flat = zip(&[("faf_galactic_war_client.exe", b"binary")]);
        assert!(inspect_archive(&flat, None).is_err());
        assert!(inspect_flat_archive(&flat, "archive").is_ok());
    }

    #[test]
    fn a_flat_archive_cannot_escape_its_directory() {
        let escaping = zip(&[("../escaped.txt", b"nope")]);
        assert!(inspect_flat_archive(&escaping, "archive").is_err());
    }

    #[test]
    fn a_flat_install_refuses_to_overwrite_an_existing_version() {
        let bytes = zip(&[("faf_galactic_war_client.exe", b"binary")]);
        let root = temp_dir("flat-existing");
        let target = root.join("v1");
        std::fs::create_dir_all(&target).unwrap();

        let result = install_flat_archive(&bytes, &target, "archive", |_| Ok(()));

        assert!(result.is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_flat_validation_leaves_nothing_behind() {
        let bytes = zip(&[("faf_galactic_war_client.exe", b"binary")]);
        let root = temp_dir("flat-invalid");
        let target = root.join("v1");

        let result = install_flat_archive(&bytes, &target, "archive", |_| {
            Err("the content pack is missing".into())
        });

        assert!(result.is_err());
        assert!(!target.exists());
        let entries = std::fs::read_dir(&root).unwrap().count();
        assert_eq!(entries, 0, "no staging folder is left behind");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_content_validation_leaves_no_installed_or_staging_folder() {
        let temp = std::env::temp_dir().join(format!("faf-vault-test-{}", rand::random::<u64>()));
        let bytes = zip(&[("mod/mod_info.lua", b"uid = 'wrong'")]);
        let result = install_archive(&bytes, &temp, None, |_| Err("wrong uid".into()));

        assert!(result.is_err());
        let entries = std::fs::read_dir(&temp)
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(entries.is_empty());
        std::fs::remove_dir_all(temp).unwrap();
    }
}
