//! What a replay's file name and featured mod name say: whether a path is a
//! replay at all, the mod a legacy file names, and the mod name FA's `/init`
//! argument is built from.
//!
//! Its own module because the library, the detail reader, file playback and
//! live spectating all lean on these, and none of them owns the others. They
//! used to live in `library` and `playback`, which then had to import each
//! other.

use std::path::Path;

/// Whether a path names something this client will read as a replay.
///
/// The two extensions FA and FAF actually use, and the same pair file
/// playback accepts. Nothing about the directory: a replay opened from the
/// file picker is legitimately outside the library.
pub(super) fn is_replay_file_name(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("fafreplay")
                || extension.eq_ignore_ascii_case("scfareplay")
        })
}

/// Legacy `.scfareplay` files carry their mod in the filename, `<name>.<mod>.scfareplay`.
pub(super) fn guess_mod_from_filename(path: &Path) -> String {
    path.file_stem()
        .and_then(|s| s.to_str())
        .and_then(|stem| stem.rsplit_once('.'))
        .map(|(_, mod_name)| mod_name.to_string())
        .unwrap_or_else(|| "faf".to_string())
}

/// `ladder1v1` isn't a real mod: the Python client folds it to `faf` when
/// building `/init`.
pub(super) fn normalize_mod(mod_name: &str) -> String {
    if mod_name == "ladder1v1" {
        "faf".to_string()
    } else {
        mod_name.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guesses_mod_from_legacy_filename() {
        assert_eq!(
            guess_mod_from_filename(Path::new("12345.faf.scfareplay")),
            "faf"
        );
        // No embedded mod segment: falls back to "faf".
        assert_eq!(
            guess_mod_from_filename(Path::new("12345.scfareplay")),
            "faf"
        );
    }

    #[test]
    fn normalizes_ladder1v1_to_faf() {
        assert_eq!(normalize_mod("ladder1v1"), "faf");
        assert_eq!(normalize_mod("faf"), "faf");
        assert_eq!(normalize_mod("murderparty"), "murderparty");
    }
}
