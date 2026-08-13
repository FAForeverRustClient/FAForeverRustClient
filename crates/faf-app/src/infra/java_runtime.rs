//! Shared discovery of the Java runtime used by native FAF tools.
//!
//! Both the ICE adapter and current Neroxis generator require a modern JVM.
//! Looking up `java` independently made the adapter reuse the official FAF
//! client's runtime while map generation still found an obsolete system Java.

use std::path::{Path, PathBuf};

/// Resolve an explicit override, a bundled runtime, or a reference client's
/// runtime before falling back to `PATH`.
pub(crate) fn preferred_java_path() -> String {
    if let Ok(path) = std::env::var("FAF_JAVA_PATH") {
        if !path.trim().is_empty() {
            return path;
        }
    }

    let executable = std::env::current_exe().ok();
    let working_directory = std::env::current_dir().ok();
    let mut roots = executable
        .as_deref()
        .and_then(Path::parent)
        .into_iter()
        .flat_map(|directory| directory.ancestors().take(4))
        .map(Path::to_path_buf)
        .collect::<Vec<_>>();
    roots.extend(
        working_directory
            .as_deref()
            .into_iter()
            .flat_map(|directory| directory.ancestors().take(3))
            .map(Path::to_path_buf),
    );

    if cfg!(windows) {
        for variable in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(directory) = std::env::var_os(variable) {
                let directory = PathBuf::from(directory);
                roots.push(directory.join("FAF Client"));
                roots.push(directory.join("Downlord's FAF Client"));
            }
        }
        if let Some(directory) = std::env::var_os("LOCALAPPDATA") {
            roots.push(PathBuf::from(directory).join("Programs").join("FAF Client"));
        }
    }
    if let Some(java_home) = std::env::var_os("JAVA_HOME") {
        roots.push(PathBuf::from(java_home));
    }

    resolve_java_from_roots(&roots)
        .unwrap_or_else(|| PathBuf::from(if cfg!(windows) { "java.exe" } else { "java" }))
        .to_string_lossy()
        .into_owned()
}

fn resolve_java_from_roots(roots: &[PathBuf]) -> Option<PathBuf> {
    let executable = if cfg!(windows) { "java.exe" } else { "java" };
    roots
        .iter()
        .flat_map(|root| {
            [
                root.join("jre").join("bin").join(executable),
                root.join("natives")
                    .join("jre")
                    .join("bin")
                    .join(executable),
                root.join("resources")
                    .join("natives")
                    .join("jre")
                    .join("bin")
                    .join(executable),
                root.join("bin").join(executable),
            ]
        })
        .find(|candidate| candidate.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_a_runtime_bundled_like_the_reference_clients() {
        let directory = tempfile::tempdir().unwrap();
        let executable = if cfg!(windows) { "java.exe" } else { "java" };
        let java = directory.path().join("jre").join("bin").join(executable);
        std::fs::create_dir_all(java.parent().unwrap()).unwrap();
        std::fs::write(&java, b"test runtime").unwrap();

        assert_eq!(
            resolve_java_from_roots(&[directory.path().to_path_buf()]),
            Some(java)
        );
    }
}
