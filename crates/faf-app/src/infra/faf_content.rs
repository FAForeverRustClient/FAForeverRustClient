//! Shared discovery of the FAF user-content vault.
//!
//! The Java client stores maps and mods below a configurable vault root. Reuse
//! that root when it is available so installing multiple FAF clients does not
//! split one user's content across otherwise identical default directories.

use std::path::PathBuf;

/// Resolve the shared FAF vault root.
///
/// An explicit override always wins. Otherwise, reuse the Java client's
/// configured vault when its preferences are present and point at an existing
/// content root. The final fallback is FAF's conventional Documents location.
pub(crate) fn vault_dir() -> PathBuf {
    if let Some(path) = non_empty_env_path("FAF_VAULT_DIR") {
        return path;
    }

    java_client_vault_dir()
        .filter(|path| path.join("maps").is_dir() || path.join("mods").is_dir())
        .unwrap_or_else(default_vault_dir)
}

fn non_empty_env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn java_client_vault_dir() -> Option<PathBuf> {
    let prefs = directories::BaseDirs::new()?
        .config_dir()
        .join("Forged Alliance Forever")
        .join("client.prefs");
    let contents = std::fs::read_to_string(prefs).ok()?;
    java_client_vault_dir_from_json(&contents)
}

fn java_client_vault_dir_from_json(contents: &str) -> Option<PathBuf> {
    let value: serde_json::Value = serde_json::from_str(contents).ok()?;
    let raw = value
        .get("forgedAlliance")?
        .get("vaultBaseDirectory")?
        .as_str()?
        .trim();
    if raw.is_empty() {
        return None;
    }
    let path = PathBuf::from(raw);
    path.is_absolute().then_some(path)
}

fn default_vault_dir() -> PathBuf {
    let documents = directories::UserDirs::new()
        .and_then(|dirs| dirs.document_dir().map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("."));
    documents
        .join("My Games")
        .join("Gas Powered Games")
        .join("Supreme Commander Forged Alliance")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_java_client_vault_path() {
        let root = if cfg!(windows) {
            r#"C:\FAF Vault"#
        } else {
            "/tmp/faf-vault"
        };
        let json = format!(r#"{{"forgedAlliance":{{"vaultBaseDirectory":{root:?}}}}}"#);
        assert_eq!(
            java_client_vault_dir_from_json(&json),
            Some(PathBuf::from(root))
        );
    }

    #[test]
    fn rejects_relative_or_missing_java_vault_paths() {
        assert_eq!(
            java_client_vault_dir_from_json(
                r#"{"forgedAlliance":{"vaultBaseDirectory":"relative/vault"}}"#,
            ),
            None
        );
        assert_eq!(java_client_vault_dir_from_json("{}"), None);
    }
}
