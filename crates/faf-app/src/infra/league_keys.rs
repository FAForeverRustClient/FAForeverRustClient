//! League division and subdivision name keys, as identifiers for the UI.
//!
//! The API names a division by a localisation key (`bronze`, `grandmaster`)
//! and a subdivision by a Roman numeral (`I`, `II`). Both used to be turned
//! into English here ("Bronze II"), which no translation could reach. They now
//! cross the boundary as identifiers and the UI names them from its catalogue,
//! the way the Java client resolves `leagues.divisionName.<key>`.

/// A division's name key: the last segment of a dotted key, lower-case.
///
/// Keys arrive bare today, but the dotted form (`leagues.divisionName.bronze`)
/// is the one the Java bundle looks them up by, so either reaches the UI as
/// the same identifier.
pub(crate) fn division_key(value: &str) -> String {
    last_segment(value).to_ascii_lowercase()
}

/// A subdivision's name key: a Roman numeral, upper-case whatever case the
/// API sent it in.
pub(crate) fn subdivision_key(value: &str) -> String {
    last_segment(value).to_ascii_uppercase()
}

fn last_segment(value: &str) -> &str {
    value.rsplit('.').next().unwrap_or(value).trim()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_are_normalised_identifiers_and_not_labels() {
        assert_eq!(division_key("Bronze"), "bronze");
        assert_eq!(
            division_key("leagues.divisionName.grandmaster"),
            "grandmaster"
        );
        assert_eq!(subdivision_key("ii"), "II");
        assert_eq!(subdivision_key(""), "");
    }
}
