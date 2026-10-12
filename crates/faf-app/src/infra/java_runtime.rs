//! Shared discovery of the Java runtime used by native FAF tools.
//!
//! Both the ICE adapter and current Neroxis generator require a modern JVM.
//! Looking up `java` independently made the adapter reuse the official FAF
//! client's runtime while map generation still found an obsolete system Java.

use std::path::PathBuf;

/// Resolve an explicit override, a bundled runtime, or a reference client's
/// runtime before falling back to `PATH`.
pub(crate) fn preferred_java_path() -> String {
    if let Some(path) = crate::infra::paths::java_path() {
        return path.to_string_lossy().into_owned();
    }
    if let Ok(path) = std::env::var("FAF_JAVA_PATH") {
        if !path.trim().is_empty() {
            return path;
        }
    }

    // Beside the client first, and nowhere the working directory can reach:
    // see `infra::helper_search_roots`. A `java.exe` in a folder the client
    // happened to be started from is not the one to run.
    let mut roots = crate::infra::helper_search_roots();

    // The named install locations below are the documented places a JRE lives,
    // and all of them are directories an ordinary user cannot write to (or, in
    // JAVA_HOME's case, one the user set themselves). They come after the
    // bundled candidates so a shipped runtime always wins.
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

/// The version a runtime reports, and its feature release.
///
/// `java -version` writes something like `openjdk version "21.0.2" 2024-01-16`
/// to stderr; the quoted part is the version on every vendor's build. Before
/// Java 9 it read `"1.8.0_292"`, where the feature release is the second
/// number.
pub(crate) fn parse_java_version(output: &str) -> Option<(String, Option<u32>)> {
    let (_, after) = output.split_once("version \"")?;
    let (version, _) = after.split_once('"')?;
    let mut parts = version.split(['.', '_', '-', '+']);
    let first = parts.next()?.parse::<u32>().ok();
    let major = match first {
        Some(1) => parts.next().and_then(|second| second.parse().ok()),
        other => other,
    };
    Some((version.to_string(), major))
}

/// Run `java -version` and read what it says.
///
/// Bounded, because a JVM that never starts must not hold the connectivity
/// check: ten seconds is several cold starts.
pub(crate) async fn query_java_version(
    path: &str,
) -> Result<(Option<String>, Option<u32>), String> {
    let mut command = tokio::process::Command::new(path);
    command.arg("-version").kill_on_drop(true);
    crate::infra::hide_console(&mut command);
    let output =
        match tokio::time::timeout(std::time::Duration::from_secs(10), command.output()).await {
            Err(_) => return Err("it did not answer within 10 seconds".into()),
            Ok(Err(error)) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err("no Java runtime was found there".into())
            }
            Ok(Err(error)) => return Err(error.to_string()),
            Ok(Ok(output)) => output,
        };
    if !output.status.success() {
        return Err(format!("it exited with {}", output.status));
    }
    // stderr by convention, stdout on the odd vendor build that differs.
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stderr),
        String::from_utf8_lossy(&output.stdout)
    );
    Ok(match parse_java_version(&text) {
        Some((version, major)) => (Some(version), major),
        None => (None, None),
    })
}

/// The Java feature release a class file was compiled for, from its header:
/// the `0xCAFEBABE` magic, then the minor and major version. Major 65 is
/// Java 21, and every release adds one.
pub(crate) fn class_file_java_version(header: &[u8]) -> Option<u32> {
    if header.len() < 8 || header[0..4] != [0xCA, 0xFE, 0xBA, 0xBE] {
        return None;
    }
    u32::from(u16::from_be_bytes([header[6], header[7]])).checked_sub(44)
}

/// The Java release a jar's main class needs, read from the jar itself so the
/// check follows whichever adapter build is installed.
pub(crate) fn jar_required_java(jar: &std::path::Path) -> Option<u32> {
    use std::io::Read;
    let file = std::fs::File::open(jar).ok()?;
    let mut archive = zip::ZipArchive::new(file).ok()?;
    let mut manifest = String::new();
    archive
        .by_name("META-INF/MANIFEST.MF")
        .ok()?
        .read_to_string(&mut manifest)
        .ok()?;
    let main = manifest
        .lines()
        .find_map(|line| line.strip_prefix("Main-Class:"))?
        .trim()
        .replace('.', "/");
    let mut header = [0u8; 8];
    archive
        .by_name(&format!("{main}.class"))
        .ok()?
        .read_exact(&mut header)
        .ok()?;
    class_file_java_version(&header)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_version_every_vendor_prints() {
        assert_eq!(
            parse_java_version("openjdk version \"25.0.3\" 2026-04-21 LTS\nOpenJDK Runtime"),
            Some(("25.0.3".into(), Some(25)))
        );
        assert_eq!(
            parse_java_version("java version \"1.8.0_292\"\nJava(TM) SE Runtime"),
            Some(("1.8.0_292".into(), Some(8)))
        );
        assert_eq!(
            parse_java_version("openjdk version \"21\" 2023-09-19"),
            Some(("21".into(), Some(21)))
        );
        assert_eq!(parse_java_version("Error: could not create the VM"), None);
    }

    #[test]
    fn a_class_header_says_which_java_it_needs() {
        assert_eq!(
            class_file_java_version(&[0xCA, 0xFE, 0xBA, 0xBE, 0, 0, 0, 65]),
            Some(21)
        );
        assert_eq!(
            class_file_java_version(&[0xCA, 0xFE, 0xBA, 0xBE, 0, 0, 0, 52]),
            Some(8)
        );
        assert_eq!(class_file_java_version(&[0, 0, 0, 0, 0, 0, 0, 65]), None);
        assert_eq!(class_file_java_version(&[0xCA, 0xFE]), None);
    }

    #[test]
    fn reads_the_required_java_out_of_a_jar() {
        use std::io::Write;
        let directory = tempfile::tempdir().unwrap();
        let jar = directory.path().join("adapter.jar");
        let mut writer = zip::ZipWriter::new(std::fs::File::create(&jar).unwrap());
        let options = zip::write::SimpleFileOptions::default();
        writer.start_file("META-INF/MANIFEST.MF", options).unwrap();
        writer
            .write_all(b"Manifest-Version: 1.0\r\nMain-Class: com.example.Main\r\n")
            .unwrap();
        writer
            .start_file("com/example/Main.class", options)
            .unwrap();
        writer
            .write_all(&[0xCA, 0xFE, 0xBA, 0xBE, 0, 0, 0, 65, 0, 0])
            .unwrap();
        writer.finish().unwrap();

        assert_eq!(jar_required_java(&jar), Some(21));
        assert_eq!(
            jar_required_java(&directory.path().join("missing.jar")),
            None
        );
    }

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
