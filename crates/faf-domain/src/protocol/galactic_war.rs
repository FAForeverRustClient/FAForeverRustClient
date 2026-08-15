//! Galactic War gateway payloads: season statistics and the client version pointer.
//!
//! Two plain-JSON documents over HTTP, `GET /statistics` and
//! `GET /client/<name>/version`, plus the naming rules for the published
//! client archive. Pure decode and pure URL construction live here; `infra`
//! does the request.
//!
//! ## Why every field is optional
//!
//! The gateway is developed alongside Galactic War itself and its schema will
//! move. A strict decode would turn every added or renamed field into a dead
//! tab and would force a client release for a change that does not concern us.
//! So nothing is `deny_unknown_fields`, every field carries `#[serde(default)]`,
//! and a missing number reads as zero. A statistics document we only half
//! understand is still worth showing.
//!
//! ## Two things the published spec and the running server disagree on
//!
//! Both were observed in material from the same week, so neither is stale:
//!
//! * `season.startedAt` is `2026-01-01T00:00:00.000Z` in the spec and
//!   `2026-03-15 22:55:15` in a sample from the live server. Neither format
//!   parses as the other, so this stays a `String` and the UI formats it.
//! * Faction ids are 1-based in the spec (`UEF` = 1) and 0-based in that
//!   sample (`UEF` = 0). Nothing here keys on the id: factions are rendered in
//!   the order they arrive, under the names the server sends.

use serde::{Deserialize, Serialize};
use specta::Type;

/// The name the gateway knows this application by, used as the `:name` path
/// segment of the version endpoint.
pub const CLIENT_NAME: &str = "faf-gw-client";

/// The archive published for this platform.
///
/// The Galactic War client is a Godot export and ships exactly two files per
/// platform, at the *top level* of the archive: no wrapping folder. That is
/// why installing it cannot reuse the vault's archive installer, which
/// requires a single root directory.
#[cfg(target_os = "windows")]
pub const ASSET_NAME: &str = "faf_galactic_war_client_win.zip";
#[cfg(not(target_os = "windows"))]
pub const ASSET_NAME: &str = "faf_galactic_war_client_linux.zip";

/// The executable inside that archive.
#[cfg(target_os = "windows")]
pub const EXECUTABLE_NAME: &str = "faf_galactic_war_client.exe";
#[cfg(not(target_os = "windows"))]
pub const EXECUTABLE_NAME: &str = "faf_galactic_war_client.x86_64";

/// The Godot content pack shipped beside the executable.
///
/// Godot locates it by the executable's own base name, so neither file may be
/// renamed and the two may not be separated. An installer must place both, or
/// the client starts into an empty engine.
pub const CONTENT_PACK_NAME: &str = "faf_galactic_war_client.pck";

/// Counts that outlive the current season.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GalacticWarAlltime {
    #[serde(default)]
    pub num_players: u32,
}

/// The current season's headline numbers.
///
/// Counts are `u32` rather than `u64`: specta forbids 64-bit integers across
/// the JS boundary (precision loss), and no count here approaches four
/// billion.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GalacticWarSeason {
    /// Kept as text on purpose: see the module doc: the server has been seen
    /// sending two mutually unparseable timestamp formats.
    #[serde(default)]
    pub started_at: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub num_players: u32,
    #[serde(default)]
    pub num_online_players: u32,
    #[serde(default)]
    pub num_battles: u32,
    #[serde(default)]
    pub num_planets: u32,
    #[serde(default)]
    pub num_factions: u32,
    #[serde(default)]
    pub num_active_attacks: u32,
    #[serde(default)]
    pub num_active_battles: u32,
    #[serde(default)]
    pub num_avatars: u32,
    #[serde(default)]
    pub num_alive_avatars: u32,
}

/// One faction's standing this season.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GalacticWarFaction {
    /// Carried through for display only. Never used to look a faction up: the
    /// numbering is not agreed on (see the module doc).
    #[serde(default)]
    pub id: i32,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub long_name: String,
    #[serde(default)]
    pub num_avatars: u32,
    #[serde(default)]
    pub num_alive_avatars: u32,
    #[serde(default)]
    pub num_online_avatars: u32,
    #[serde(default)]
    pub num_planets: u32,
}

/// The whole `GET /statistics` document.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GalacticWarStatistics {
    #[serde(default)]
    pub alltime: GalacticWarAlltime,
    #[serde(default)]
    pub season: GalacticWarSeason,
    #[serde(default)]
    pub factions: Vec<GalacticWarFaction>,
}

/// What the gateway says about client versions.
///
/// `requiredVersion` is a **minimum**: the oldest build the server still
/// accepts. It is therefore the wrong thing to install, because a client that
/// always installs the minimum never receives a fix. `latestVersion` is the
/// version to install: it does not exist yet, and is decoded now so that it
/// takes effect the day the gateway starts sending it, with no client release.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClientVersions {
    #[serde(default)]
    pub required_version: String,
    #[serde(default)]
    pub latest_version: Option<String>,
}

impl ClientVersions {
    /// The version to install: the newest the gateway advertises, falling back
    /// to the minimum while `latestVersion` is absent.
    ///
    /// Conservative rather than broken: installing the minimum always yields a
    /// client that can connect, it just may not be the newest one published.
    pub fn install_target(&self) -> Option<&str> {
        let candidate = self
            .latest_version
            .as_deref()
            .filter(|value| !value.is_empty())
            .unwrap_or(self.required_version.as_str());
        (!candidate.is_empty()).then_some(candidate)
    }
}

/// Whether a version string is safe to paste into a URL path and a directory
/// name.
///
/// Deliberately **not** [`crate::state::is_release_version`]. That one demands
/// a numeric dotted core, which today's `v2026.04.04.1` tags satisfy by
/// coincidence and a future scheme need not: refusing to install because the
/// publisher renamed their tags would be a self-inflicted outage. This asks
/// only for what safety actually requires: no path separators, no traversal,
/// nothing that reads as a command-line flag, and a bounded length.
pub fn is_safe_version(version: &str) -> bool {
    !version.is_empty()
        && version.len() <= 64
        && version != "."
        && version != ".."
        && !version.starts_with('-')
        && version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// Build the download URL for `version` under the configured download root.
///
/// The URL is *derived*, never taken from a response body. The only remote
/// input is the version string, and it must pass [`is_safe_version`] first.
/// Same posture as `infra::client_update` takes for the client's own
/// installer, and for the same reason: what comes back is executed.
pub fn download_url(base: &str, version: &str) -> Result<String, String> {
    if !is_safe_version(version) {
        return Err(format!("{version:?} is not a usable client version"));
    }
    let base = base.trim_end_matches('/');
    Ok(format!("{base}/{CLIENT_NAME}/{version}/{ASSET_NAME}"))
}

/// The path of the version endpoint for this client, relative to the API root.
pub fn version_path() -> String {
    format!("client/{CLIENT_NAME}/version")
}

pub fn parse_statistics(body: &str) -> Result<GalacticWarStatistics, String> {
    serde_json::from_str(body)
        .map_err(|error| format!("could not read Galactic War statistics: {error}"))
}

/// Decode the version document.
///
/// Errors when it carries no version at all, which is what the endpoint's
/// `404 {"error": …}` body decodes to under the tolerant rules above. A
/// version document with no version in it is not a version document, and
/// reporting that is more useful than an empty install target three layers up.
pub fn parse_client_versions(body: &str) -> Result<ClientVersions, String> {
    let versions: ClientVersions = serde_json::from_str(body)
        .map_err(|error| format!("could not read the Galactic War client version: {error}"))?;
    if versions.install_target().is_none() {
        return Err("the gateway returned no Galactic War client version".into());
    }
    Ok(versions)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The example from the gateway's published API spec.
    const SPEC_STATISTICS: &str = r#"{
      "alltime": { "numPlayers": 15230 },
      "season": {
        "startedAt": "2026-01-01T00:00:00.000Z",
        "name": "Season 7",
        "numPlayers": 4210,
        "numOnlinePlayers": 42,
        "numBattles": 981,
        "numPlanets": 64,
        "numFactions": 4,
        "numActiveAttacks": 3,
        "numActiveBattles": 1,
        "numAvatars": 5230,
        "numAliveAvatars": 4880
      },
      "factions": [
        {
          "id": 1,
          "name": "UEF",
          "longName": "United Earth Federation",
          "numAvatars": 1300,
          "numAliveAvatars": 1210,
          "numOnlineAvatars": 11,
          "numPlanets": 16
        }
      ]
    }"#;

    /// A sample taken from the running test server, which differs from the
    /// spec in timestamp format and faction numbering.
    const LIVE_STATISTICS: &str = r#"{
      "alltime": { "numPlayers": 82 },
      "season": {
        "startedAt": "2026-03-15 22:55:15",
        "name": "Testing Season 4",
        "numPlayers": 16,
        "numBattles": 28,
        "numOnlinePlayers": 4,
        "numPlanets": 1000,
        "numFactions": 4,
        "numActiveAttacks": 2,
        "numActiveBattles": 0,
        "numAvatars": 24,
        "numAliveAvatars": 16
      },
      "factions": [
        { "id": 0, "name": "UEF", "longName": "United Earth Federation",
          "numAvatars": 7, "numAliveAvatars": 5, "numOnlineAvatars": 1, "numPlanets": 254 },
        { "id": 3, "name": "Seraphim", "longName": "Seraphim Army",
          "numAvatars": 4, "numAliveAvatars": 4, "numOnlineAvatars": 1, "numPlanets": 252 }
      ]
    }"#;

    #[test]
    fn decodes_the_published_spec_example() {
        let stats = parse_statistics(SPEC_STATISTICS).unwrap();
        assert_eq!(stats.alltime.num_players, 15230);
        assert_eq!(stats.season.name, "Season 7");
        assert_eq!(stats.season.started_at, "2026-01-01T00:00:00.000Z");
        assert_eq!(stats.season.num_online_players, 42);
        assert_eq!(stats.factions.len(), 1);
        assert_eq!(stats.factions[0].long_name, "United Earth Federation");
        assert_eq!(stats.factions[0].num_planets, 16);
    }

    #[test]
    fn decodes_the_live_server_sample_despite_both_disagreements() {
        let stats = parse_statistics(LIVE_STATISTICS).unwrap();
        // A timestamp format no ISO parser accepts, kept verbatim.
        assert_eq!(stats.season.started_at, "2026-03-15 22:55:15");
        // Zero-based ids where the spec is one-based: carried, never keyed on.
        assert_eq!(stats.factions[0].id, 0);
        assert_eq!(stats.factions[0].name, "UEF");
        assert_eq!(stats.factions[1].id, 3);
        assert_eq!(stats.factions[1].name, "Seraphim");
    }

    #[test]
    fn tolerates_added_and_missing_fields() {
        let stats = parse_statistics(
            r#"{"season":{"name":"S1","somethingNew":{"nested":true}},"unknownTop":[1,2]}"#,
        )
        .unwrap();
        assert_eq!(stats.season.name, "S1");
        // Absent counts read as zero rather than failing the document.
        assert_eq!(stats.season.num_battles, 0);
        assert_eq!(stats.alltime.num_players, 0);
        assert!(stats.factions.is_empty());
    }

    #[test]
    fn an_empty_document_is_still_a_document() {
        assert_eq!(
            parse_statistics("{}").unwrap(),
            GalacticWarStatistics::default()
        );
    }

    #[test]
    fn malformed_json_is_an_error() {
        assert!(parse_statistics("not json").is_err());
    }

    #[test]
    fn the_minimum_is_the_install_target_until_latest_exists() {
        let versions = parse_client_versions(r#"{"requiredVersion":"v2026.04.04.1"}"#).unwrap();
        assert_eq!(versions.required_version, "v2026.04.04.1");
        assert_eq!(versions.latest_version, None);
        assert_eq!(versions.install_target(), Some("v2026.04.04.1"));
    }

    #[test]
    fn latest_wins_over_the_minimum_once_the_gateway_sends_it() {
        let versions = parse_client_versions(
            r#"{"requiredVersion":"v2026.03.01.1","latestVersion":"v2026.04.04.1"}"#,
        )
        .unwrap();
        assert_eq!(versions.install_target(), Some("v2026.04.04.1"));
    }

    #[test]
    fn an_empty_latest_falls_back_instead_of_installing_nothing() {
        let versions =
            parse_client_versions(r#"{"requiredVersion":"v2026.03.01.1","latestVersion":""}"#)
                .unwrap();
        assert_eq!(versions.install_target(), Some("v2026.03.01.1"));
    }

    #[test]
    fn a_document_without_a_version_is_rejected() {
        // What the endpoint's 404 body decodes to under the tolerant rules.
        assert!(parse_client_versions(r#"{"error":"Client not found: faf-gw-client"}"#).is_err());
        assert!(parse_client_versions("{}").is_err());
    }

    #[test]
    fn accepts_the_current_and_plausible_future_version_schemes() {
        for version in [
            "v2026.04.04.1",
            "2026.04.04.1",
            "1.4.2",
            "v1.4.2-rc1",
            "build-42",
            "2026_04_04",
        ] {
            assert!(is_safe_version(version), "{version} should be usable");
        }
    }

    #[test]
    fn rejects_versions_that_could_escape_a_path() {
        for version in [
            "",
            ".",
            "..",
            "../../etc/passwd",
            "v1/../../evil",
            "v1\\evil",
            "v1 2",
            "-rf",
            "v1;rm",
            "https://elsewhere/x",
        ] {
            assert!(!is_safe_version(version), "{version:?} should be refused");
        }
        assert!(!is_safe_version(&"v".repeat(65)));
    }

    #[test]
    fn builds_the_download_url_from_the_version_alone() {
        let url = download_url("https://downloads.faforever.com", "v2026.04.04.1").unwrap();
        assert_eq!(
            url,
            format!("https://downloads.faforever.com/faf-gw-client/v2026.04.04.1/{ASSET_NAME}")
        );
    }

    #[test]
    fn a_trailing_slash_on_the_base_does_not_double_up() {
        let url = download_url("https://downloads.faforever.com/", "v1.0").unwrap();
        assert!(!url.contains("//faf-gw-client"));
    }

    #[test]
    fn an_unsafe_version_never_reaches_a_url() {
        assert!(download_url("https://downloads.faforever.com", "../../evil").is_err());
    }

    #[test]
    fn the_version_path_names_this_client() {
        assert_eq!(version_path(), "client/faf-gw-client/version");
    }
}
