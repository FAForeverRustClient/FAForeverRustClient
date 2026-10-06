//! Staging a map from the vault CDN before a replay or a live game needs it.
//!
//! Separate from the game update because a map is in no featured mod's file
//! list: it comes from another host, lands in other folders, and is optional
//! for a replay but required for a live game.

use std::path::{Path, PathBuf};

use crate::infra::vault_install::{
    bounded_body, install_archive, validate_url, MAX_DOWNLOAD_BYTES,
};
use crate::ports::{PreparationPhase, PreparationStep};

use super::install::documents_vault_dir;

/// The two directories FA's replay-mode init scripts may search for maps:
/// the user's real vault ([`documents_vault_dir`], honored by
/// `custom_vault_path`-aware init scripts) plus a second, legacy hardcoded
/// fallback under the replay install itself: old replays' init scripts
/// predate the "custom vault path" feature and never consult
/// `fa_path.lua`'s `custom_vault_path` for map lookup at all. Mirrors the FAF
/// Discord-documented workaround of manually copying a map into both.
fn default_map_search_dirs(replay_target_dir: &Path) -> Vec<PathBuf> {
    const SUB: &str = "My Games/Gas Powered Games/Supreme Commander Forged Alliance/maps";
    let mut dirs = Vec::new();
    if let Some(vault_dir) = documents_vault_dir() {
        dirs.push(vault_dir.join("maps"));
    }
    dirs.push(replay_target_dir.join("user").join(SUB));
    dirs
}

/// Every FAF vault map folder is named `{slug}.v{NNNN}` (confirmed against
/// every real vault map this project has seen, e.g. `adaptive_gadostb.v0002`
///: the version suffix is how the vault disambiguates map revisions).
/// Official/base-game maps never carry that suffix (`scmp_002`, `X1MP_002`,
/// …): they ship inside the FA install itself, mounted by `init_<mod>.lua`
/// straight from `fa_path`, entirely independent of the vault/custom-vault
/// mechanism this module stages into. Used to skip the vault CDN lookup
/// entirely for base maps: confirmed live (`X1MP_002`) that hitting the CDN
/// for one is a guaranteed, harmless 404 that otherwise surfaces as a
/// misleading "could not stage map" warning for something that was never
/// broken in the first place.
fn is_vault_map_folder(map_folder: &str) -> bool {
    match map_folder.rsplit_once(".v") {
        Some((_, suffix)) => !suffix.is_empty() && suffix.bytes().all(|b| b.is_ascii_digit()),
        None => false,
    }
}

/// A map that ships inside Forged Alliance itself: `SCMP_001` to `SCMP_040`
/// and the `X1MP_` ones. Twin of `isOfficialMap` in `shared/mapPresentation.ts`.
///
/// The suffix rule above is not the whole vault (#385). Maps uploaded before
/// the vault versioned its folders kept the name their author gave them,
/// spaces and all: `Phenom Spartiate v2` is a vault map, served as
/// `phenom spartiate v2.zip`, with no `.vNNNN` anywhere. Taking every name
/// without a suffix for a base-game map skipped the download for all of them,
/// and the player was put into a lobby on a map they did not have. So a name
/// without a suffix is only skipped when it is one of these.
fn is_base_game_map(map_folder: &str) -> bool {
    let lower = map_folder.to_ascii_lowercase();
    let Some((prefix, digits)) = lower.split_once('_') else {
        return false;
    };
    if digits.len() != 3 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    let number: u32 = digits.parse().unwrap_or(0);
    match prefix {
        "scmp" => (1..=40).contains(&number),
        "x1mp" => (1..=12).contains(&number) || number == 14 || number == 17,
        _ => false,
    }
}

/// Makes sure `map_folder` (e.g. `adaptive_gadostb.v0002`) is present in
/// every directory FA's replay mode searches: downloading the map's zip
/// from the public vault CDN and extracting it into each if it's missing
/// everywhere. A no-op (not fatal) if the download fails: official/base-game
/// maps (`scmp_XXX`) never need this and simply won't be found remotely,
/// which shouldn't block playback of a replay that doesn't actually need a
/// custom map: recognized up front via [`is_vault_map_folder`] so those
/// never even attempt (and can't fail/warn about) a CDN lookup.
pub async fn ensure_map_available(
    http: &reqwest::Client,
    content_base: &str,
    replay_target_dir: &Path,
    map_folder: &str,
) -> Result<(), String> {
    stage_map(
        http,
        content_base,
        &default_map_search_dirs(replay_target_dir),
        map_folder,
    )
    .await
}

/// Makes sure `map_folder` is in the user's maps folder before a *live* game.
///
/// The live counterpart to [`ensure_map_available`], differing in where the map
/// has to land: a live game reads `custom_vault_path` out of `fa_path.lua` and
/// looks under it, so the two extra legacy locations: which exist purely for
/// old replays' init scripts: are not needed.
///
/// `maps_dir` is where *this client* keeps maps, which is normally the same
/// directory. It can be repointed (`FAF_MAPS_DIR`) while `custom_vault_path`
/// stays derived from the user's Documents folder, so when the two differ the
/// map is staged into both: one is where FA will look, the other is where the
/// client's own installed-maps list looks, and a map visible in only one of
/// them is exactly the confusing half-state this avoids.
///
/// Unlike the replay path this is a *hard* requirement, because the server has
/// already put the player in a game on this map: launching without it is a
/// guaranteed failure to load. Base-game maps (`scmp_009`) are not vault maps
/// and return `Ok` untouched.
pub async fn ensure_live_map(
    http: &reqwest::Client,
    content_base: &str,
    maps_dir: &Path,
    map_folder: &str,
    progress: &(dyn Fn(PreparationStep) + Sync),
) -> Result<(), String> {
    let dirs = live_map_dirs(
        maps_dir,
        documents_vault_dir().map(|dir| dir.join("maps")),
        map_folder,
    );
    if dirs.is_empty() {
        return Ok(());
    }
    progress(PreparationStep::indeterminate(
        PreparationPhase::Map,
        format!("Downloading map {map_folder}…"),
    ));
    stage_map(http, content_base, &dirs, map_folder).await
}

/// The live destinations still missing `map_folder`.
///
/// Filtering here rather than letting [`stage_map`] skip on *any* directory
/// having the map: with two destinations, "present in one" is the half-state
/// [`ensure_live_map`] exists to avoid, not a reason to stop.
fn live_map_dirs(maps_dir: &Path, vault_maps: Option<PathBuf>, map_folder: &str) -> Vec<PathBuf> {
    let mut dirs = vec![maps_dir.to_path_buf()];
    if let Some(vault_maps) = vault_maps {
        if vault_maps != maps_dir {
            dirs.push(vault_maps);
        }
    }
    dirs.retain(|dir| !has_map_folder(dir, map_folder));
    dirs
}

/// Whether `dir` holds `map_folder`, in whatever letter case it was unpacked.
///
/// The lobby names a co-op map `scca_coop_e01.v0024` and the archive unpacks
/// it as `SCCA_Coop_E01.v0024`: the same capitalisation gap `vault_map_url`
/// already closes for the CDN. On Windows the two spellings are one folder.
/// On a case-sensitive filesystem the lower-case one does not exist, so every
/// launch after the first decided the map was missing, downloaded it again,
/// and failed on the folder the first launch had left: "is already installed"
/// (#283). The exact name is tried first; the directory is only read when it
/// is not there.
fn has_map_folder(dir: &Path, map_folder: &str) -> bool {
    if dir.join(map_folder).is_dir() {
        return true;
    }
    std::fs::read_dir(dir).is_ok_and(|entries| {
        entries.flatten().any(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .eq_ignore_ascii_case(map_folder)
                && entry.path().is_dir()
        })
    })
}

/// Where the vault keeps `map_folder`'s archive.
///
/// Lower-cased, because the vault stores every archive under a lower-case name
/// while folder names carry whatever capitalisation their author used - the
/// co-op missions are `SCCA_Coop_A03.v0023`. The CDN is case-sensitive, so
/// asking for the name as given is a 404 for every map with a capital letter
/// in it, which is most co-op missions and a large share of the vault.
///
/// Checked against the live CDN: `scca_coop_a03.v0023.zip` and
/// `africa.v0005.zip` answer 200, and neither answers to its mixed-case
/// spelling. The extracted folder keeps the archive's own capitalisation;
/// only the request is normalised.
fn vault_map_url(content_base: &str, map_folder: &str) -> String {
    format!(
        "{content_base}/maps/{}.zip",
        map_folder.to_ascii_lowercase()
    )
}

/// Download `map_folder` from the vault CDN and extract it into every
/// directory in `dirs`, unless it is already present in one of them.
async fn stage_map(
    http: &reqwest::Client,
    content_base: &str,
    dirs: &[PathBuf],
    map_folder: &str,
) -> Result<(), String> {
    let versioned = is_vault_map_folder(map_folder);
    if !versioned && is_base_game_map(map_folder) {
        return Ok(()); // base/official map: ships with FA, not the vault
    }

    let search_dirs = dirs.to_vec();
    if search_dirs
        .iter()
        .any(|dir| has_map_folder(dir, map_folder))
    {
        return Ok(()); // already somewhere FA will find it
    }

    let url = vault_map_url(content_base, map_folder);
    validate_url(&url, content_base, "maps")?;
    let resp = http
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("could not download map {map_folder}: {e}"))?;
    validate_url(resp.url().as_str(), content_base, "maps")?;
    // An unversioned name the vault does not have is most likely a scenario
    // that ships with the game under a name `is_base_game_map` does not know,
    // which is how every unversioned name used to be treated. A versioned one
    // is a vault map that failed to arrive, and that stays an error.
    if !versioned && resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(());
    }
    if !resp.status().is_success() {
        return Err(format!(
            "could not download map {map_folder}: {}",
            resp.status()
        ));
    }
    let bytes = bounded_body(resp, &format!("map {map_folder}"), MAX_DOWNLOAD_BYTES).await?;
    let expected_folder = map_folder.to_string();

    tokio::task::spawn_blocking(move || -> Result<(), String> {
        for dir in &search_dirs {
            install_archive(&bytes, dir, Some(&expected_folder), |_| Ok(()))?;
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("map extraction task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    #[test]
    fn a_map_folder_is_found_whatever_its_letter_case() {
        use super::{has_map_folder, live_map_dirs};
        let root = std::env::temp_dir().join(format!(
            "faf-map-case-{}-{}",
            std::process::id(),
            rand::random::<u32>()
        ));
        std::fs::create_dir_all(root.join("SCCA_Coop_E01.v0024")).unwrap();
        assert!(has_map_folder(&root, "scca_coop_e01.v0024"));
        assert!(has_map_folder(&root, "SCCA_Coop_E01.v0024"));
        assert!(!has_map_folder(&root, "scca_coop_e02.v0024"));
        assert!(live_map_dirs(&root, None, "scca_coop_e01.v0024").is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_vault_map_is_requested_under_its_lower_case_name() {
        // The reported failure: hosting never got its map. The vault serves
        // `scca_coop_a03.v0023.zip`, the co-op API names the folder
        // `SCCA_Coop_A03.v0023`, and the CDN is case-sensitive - so the
        // request 404'd for every map with a capital letter in its name.
        assert_eq!(
            vault_map_url("https://content.faforever.com", "SCCA_Coop_A03.v0023"),
            "https://content.faforever.com/maps/scca_coop_a03.v0023.zip"
        );
        // A name that is already lower case is untouched.
        assert_eq!(
            vault_map_url("https://content.faforever.com", "adaptive_gadostb.v0002"),
            "https://content.faforever.com/maps/adaptive_gadostb.v0002.zip"
        );
    }

    #[test]
    fn default_map_search_dirs_includes_replay_target_user_dir() {
        let target_dir = Path::new(r"C:\ProgramData\FAForever\replaydata");
        let dirs = default_map_search_dirs(target_dir);
        let expected_suffix =
            "user/My Games/Gas Powered Games/Supreme Commander Forged Alliance/maps"
                .replace('/', std::path::MAIN_SEPARATOR_STR);
        assert!(
            dirs.iter().any(|d| d.ends_with(&expected_suffix)),
            "{dirs:?} should include the replay-target user dir"
        );
    }

    #[test]
    fn a_live_map_already_in_place_needs_no_destinations() {
        let temp = std::env::temp_dir().join(format!("faf-live-dirs-{}", std::process::id()));
        let maps = temp.join("maps");
        std::fs::create_dir_all(maps.join("adaptive_gadostb.v0002")).unwrap();

        // Normal setup: the client's maps folder *is* the vault maps folder,
        // and the map is there: nothing left to do, so no download.
        assert!(live_map_dirs(&maps, Some(maps.clone()), "adaptive_gadostb.v0002").is_empty());

        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn a_map_present_in_only_one_live_destination_is_still_staged_into_the_other() {
        let temp = std::env::temp_dir().join(format!("faf-live-split-{}", std::process::id()));
        let maps = temp.join("maps");
        let vault = temp.join("vault-maps");
        std::fs::create_dir_all(maps.join("adaptive_gadostb.v0002")).unwrap();
        std::fs::create_dir_all(&vault).unwrap();

        // The client can list the map while the game cannot find it. Staging
        // has to close that gap rather than reporting success.
        assert_eq!(
            live_map_dirs(&maps, Some(vault.clone()), "adaptive_gadostb.v0002"),
            vec![vault],
        );

        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn one_destination_is_never_listed_twice() {
        let temp = std::env::temp_dir().join(format!("faf-live-dedup-{}", std::process::id()));
        let maps = temp.join("maps");

        // Extracting the same zip into the same directory twice is harmless
        // but pointless; the usual case is exactly this one directory.
        assert_eq!(
            live_map_dirs(&maps, Some(maps.clone()), "adaptive_gadostb.v0002"),
            vec![maps],
        );
    }

    #[tokio::test]
    async fn a_base_game_map_needs_no_staging_for_a_live_game() {
        // `scmp_009` ships inside the FA install; the vault has never heard of
        // it, so asking would be a guaranteed 404 that fails the launch.
        let result = ensure_live_map(
            &reqwest::Client::new(),
            "http://127.0.0.1:1",
            std::path::Path::new("definitely/not/here"),
            "scmp_009",
            &|_| {},
        )
        .await;
        assert!(result.is_ok(), "{result:?}");
    }

    /// Builds an in-memory zip shaped like a real vault map download,
    /// confirmed against `content.faforever.com/maps/adaptive_gadostb.v0002.zip`:
    /// a single top-level `{map_folder}/` directory containing the map's files.
    fn build_map_zip(map_folder: &str) -> Vec<u8> {
        let mut buf = std::io::Cursor::new(Vec::new());
        let mut writer = zip::ZipWriter::new(&mut buf);
        let options: zip::write::FileOptions<'_, ()> = zip::write::FileOptions::default();
        writer
            .start_file(format!("{map_folder}/{map_folder}.scmap"), options)
            .unwrap();
        writer.write_all(b"fake map bytes").unwrap();
        writer.finish().unwrap();
        buf.into_inner()
    }

    #[test]
    fn vault_install_places_files_under_the_map_folder() {
        let dir = std::env::temp_dir().join(format!("forge-mapzip-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        let zip_bytes = build_map_zip("adaptive_gadostb.v0002");
        install_archive(&zip_bytes, &dir, Some("adaptive_gadostb.v0002"), |_| Ok(()))
            .expect("should extract");

        let scmap = dir
            .join("adaptive_gadostb.v0002")
            .join("adaptive_gadostb.v0002.scmap");
        assert_eq!(std::fs::read(&scmap).unwrap(), b"fake map bytes");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn ensure_map_available_skips_download_when_already_staged() {
        let target_dir =
            std::env::temp_dir().join(format!("forge-maptarget-{}", std::process::id()));
        let user_maps = target_dir
            .join("user")
            .join("My Games")
            .join("Gas Powered Games")
            .join("Supreme Commander Forged Alliance")
            .join("maps")
            .join("adaptive_gadostb.v0002");
        tokio::fs::create_dir_all(&user_maps).await.unwrap();

        let http = reqwest::Client::new();
        // An unreachable content_base proves no network call was attempted,
        // this would error out immediately if the "already staged" short
        // circuit didn't fire.
        ensure_map_available(
            &http,
            "http://127.0.0.1:1",
            &target_dir,
            "adaptive_gadostb.v0002",
        )
        .await
        .expect("should skip the download entirely");

        let _ = tokio::fs::remove_dir_all(&target_dir).await;
    }

    #[test]
    fn recognizes_vault_map_folders_vs_base_game_maps() {
        assert!(is_vault_map_folder("adaptive_gadostb.v0002"));
        assert!(is_vault_map_folder("FAF_Coop_Operation_Rescue.v0008"));
        assert!(!is_vault_map_folder("scmp_009"));
        assert!(!is_vault_map_folder("X1MP_002"));
        assert!(!is_vault_map_folder("no_version_suffix"));
        assert!(!is_vault_map_folder("trailing_dot_v"));
    }

    /// #385: an old vault map has no version suffix, and is not a base map.
    #[test]
    fn only_the_shipped_maps_are_skipped_without_a_suffix() {
        assert!(is_base_game_map("scmp_009"));
        assert!(is_base_game_map("SCMP_040"));
        assert!(is_base_game_map("X1MP_017"));
        assert!(!is_base_game_map("scmp_041"));
        assert!(!is_base_game_map("x1mp_013"));
        assert!(!is_base_game_map("scmp_09"));
        assert!(!is_base_game_map("Phenom Spartiate v2"));
        assert!(!is_base_game_map("no_version_suffix"));
        assert_eq!(
            vault_map_url("https://content.faforever.com", "Phenom Spartiate v2"),
            "https://content.faforever.com/maps/phenom spartiate v2.zip"
        );
    }

    #[tokio::test]
    async fn ensure_map_available_skips_the_network_entirely_for_base_maps() {
        let target_dir = std::env::temp_dir().join(format!("forge-basemap-{}", std::process::id()));
        let http = reqwest::Client::new();
        // An unreachable content_base proves no network call was attempted,
        // confirmed live (X1MP_002 → guaranteed 404, wrongly surfaced as a
        // "could not stage map" warning before this fix.
        ensure_map_available(&http, "http://127.0.0.1:1", &target_dir, "X1MP_002")
            .await
            .expect("base maps should be skipped, not looked up");
    }
}
