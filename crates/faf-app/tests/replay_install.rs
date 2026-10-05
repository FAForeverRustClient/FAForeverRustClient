//! The replay install's download path, against a controlled FAF API.
//!
//! Before a replay launches, the replay install is brought to the exact build
//! the replay was recorded on: the featured mod's file list is asked of the
//! API, every outdated file is fetched from the content host, the engine
//! version is stamped into the executable and `fa_path.lua` is written. The
//! cached half of that (staging a build already in the content store) has
//! unit tests; the download half needs an API, and this file is one.
//!
//! The server below is a few dozen lines of `TcpListener`, the same shape the
//! unit tests in `infra::jsonapi` use: one request per connection, answered
//! and closed. It serves exactly the three routes the updater calls:
//!
//! - `GET /data/featuredMod?filter=technicalName=="<mod>"`: the mod's id;
//! - `GET /featuredMods/<id>/files/<version>`: the release's file list;
//! - `GET /content/<file>`: a file, which must carry the list's HMAC header.
//!
//! Nothing reaches the network. The retail install `fa_path.lua` points at is
//! a directory of the test's own (`FAF_GAME_INSTALL_DIR`), so the result does
//! not depend on whether the machine running it has the game installed.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use faf_app::infra::game_updater::{
    read_exe_version, resolve_and_stage_replay_version, ReplayVersionInfo,
};
use faf_app::ports::PreparationStep;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::TcpListener;

const TOKEN: &str = "test-token";
const HMAC_HEADER: &str = "verify";
const HMAC_TOKEN: &str = "signed-by-the-test";

/// The engine build the replay names, and the overlay revision its header
/// names. Deliberately different numbers: the bug this path once had was
/// asking for the overlay at the engine's number.
const ENGINE_BUILD: i32 = 3800;
const OVERLAY_REVISION: i32 = 52;

/// The smallest file the version stamp accepts as an executable: the last of
/// its three offsets plus the four bytes written there.
const EXE_BYTES: usize = 0x476666 + 4;

/// One request as the server saw it.
#[derive(Debug, Clone)]
struct Seen {
    path: String,
    query: HashMap<String, String>,
    headers: HashMap<String, String>,
}

/// One file of a featured mod's release, as served.
struct ServedFile {
    group: &'static str,
    name: &'static str,
    bytes: Vec<u8>,
}

/// The fake API: two featured mods, one release each, and the files behind
/// them. Answers 404 to anything else, so a request the updater should not
/// make fails the install rather than passing unnoticed.
struct FakeApi {
    base: String,
    seen: Arc<Mutex<Vec<Seen>>>,
}

impl FakeApi {
    async fn start(releases: Vec<(&'static str, &'static str, i32, Vec<ServedFile>)>) -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let seen = Arc::new(Mutex::new(Vec::new()));

        // Everything the routes answer with, computed once up front.
        let mut mod_ids = HashMap::new();
        let mut file_lists = HashMap::new();
        let mut contents = HashMap::new();
        for (technical_name, id, version, files) in releases {
            mod_ids.insert(technical_name.to_string(), id.to_string());
            let data: Vec<Value> = files
                .iter()
                .map(|file| {
                    let url = format!("{base}/content/{}", file.name);
                    json!({
                        "type": "featuredModFile",
                        "id": file.name,
                        "attributes": {
                            "group": file.group,
                            "name": file.name,
                            "md5": format!("{:x}", md5::compute(&file.bytes)),
                            "version": version.to_string(),
                            "cacheableUrl": url,
                            "hmacToken": HMAC_TOKEN,
                            "hmacParameter": HMAC_HEADER,
                        }
                    })
                })
                .collect();
            file_lists.insert(
                format!("/featuredMods/{id}/files/{version}"),
                json!({ "data": data }).to_string().into_bytes(),
            );
            for file in files {
                contents.insert(format!("/content/{}", file.name), file.bytes);
            }
        }
        let routes = Arc::new((mod_ids, file_lists, contents));

        let log = seen.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    return;
                };
                let (log, routes) = (log.clone(), routes.clone());
                tokio::spawn(async move {
                    let Some(request) = read_request(&mut stream).await else {
                        return;
                    };
                    log.lock().unwrap().push(request.clone());
                    let (mod_ids, file_lists, contents) = &*routes;
                    let body = match request.path.as_str() {
                        "/data/featuredMod" => request
                            .query
                            .get("filter")
                            .and_then(|filter| filter.strip_prefix("technicalName==\""))
                            .and_then(|rest| rest.strip_suffix('"'))
                            .and_then(|name| mod_ids.get(name))
                            .map(|id| {
                                json!({ "data": [{ "type": "featuredMod", "id": id, "attributes": {} }] })
                                    .to_string()
                                    .into_bytes()
                            }),
                        path if path.starts_with("/featuredMods/") => file_lists.get(path).cloned(),
                        path if path.starts_with("/content/")
                            && request.headers.get(HMAC_HEADER).map(String::as_str)
                                == Some(HMAC_TOKEN) =>
                        {
                            contents.get(path).cloned()
                        }
                        _ => None,
                    };
                    let response = match body {
                        Some(body) => {
                            let mut head = format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: application/vnd.api+json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                body.len()
                            )
                            .into_bytes();
                            head.extend(body);
                            head
                        }
                        None => b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                            .to_vec(),
                    };
                    let _ = stream.write_all(&response).await;
                    let _ = stream.shutdown().await;
                });
            }
        });

        Self { base, seen }
    }

    fn requests(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }

    fn clear(&self) {
        self.seen.lock().unwrap().clear();
    }
}

/// Read one request's head: the request line and headers, up to the blank
/// line. Every request the updater makes is a `GET`, so there is no body.
async fn read_request(stream: &mut tokio::net::TcpStream) -> Option<Seen> {
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 4096];
    while !buffer.windows(4).any(|window| window == b"\r\n\r\n") {
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
    let head = String::from_utf8_lossy(&buffer).to_string();
    let mut lines = head.split("\r\n");
    let target = lines.next()?.split(' ').nth(1)?.to_string();
    let url = url::Url::parse(&format!("http://server{target}")).ok()?;
    let headers = lines
        .take_while(|line| !line.is_empty())
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_string()))
        .collect();
    Some(Seen {
        path: url.path().to_string(),
        query: url.query_pairs().into_owned().collect(),
        headers,
    })
}

/// A stand-in for the retail game: the probe file `fa_path.lua`'s resolution
/// looks for, and nothing else.
fn retail_install(root: &Path) -> PathBuf {
    let retail = root.join("retail");
    std::fs::create_dir_all(retail.join("gamedata")).unwrap();
    std::fs::write(retail.join("gamedata").join("lua.scd"), b"retail").unwrap();
    retail
}

fn manifest_entries(cache: &Path) -> Vec<Value> {
    let manifest: Value =
        serde_json::from_slice(&std::fs::read(cache.join("cache_manifest.json")).unwrap()).unwrap();
    manifest["entries"].as_array().cloned().unwrap_or_default()
}

/// An overlay replay with an empty cache: `faf` at the replay's engine build
/// goes in first, the overlay at its own revision on top, and the result is
/// what FA needs to load the replay. Then the same replay again, which must
/// come entirely from the cache the first run filled.
#[tokio::test]
async fn an_overlay_replay_installs_its_base_build_and_overlay_revision_from_the_api() {
    let root = tempfile::tempdir().unwrap();
    let cache = root.path().join("game_files");
    let target = root.path().join("replaydata");
    let retail = retail_install(root.path());
    // Read when `fa_path.lua` is written, and only by this test binary: it is
    // a process of its own, and this is its only test.
    std::env::set_var("FAF_GAME_INSTALL_DIR", &retail);

    let exe = vec![0_u8; EXE_BYTES];
    let base_units = b"faf units for build 3800".to_vec();
    let overlay_units = b"nomads units, revision 52".to_vec();
    let api = FakeApi::start(vec![
        (
            "faf",
            "1",
            ENGINE_BUILD,
            vec![
                ServedFile {
                    group: "bin",
                    name: "ForgedAlliance.exe",
                    bytes: exe,
                },
                ServedFile {
                    group: "gamedata",
                    name: "units.nx2",
                    bytes: base_units.clone(),
                },
            ],
        ),
        (
            "nomads",
            "7",
            OVERLAY_REVISION,
            vec![ServedFile {
                group: "gamedata",
                name: "nomads.nx2",
                bytes: overlay_units.clone(),
            }],
        ),
    ])
    .await;

    let replay = ReplayVersionInfo {
        mod_name: "nomads".into(),
        game_version: Some(ENGINE_BUILD),
        featured_mod_version: Some(OVERLAY_REVISION),
        ..ReplayVersionInfo::default()
    };
    let steps = Arc::new(Mutex::new(Vec::<PreparationStep>::new()));
    let record = steps.clone();
    let progress = move |step: PreparationStep| record.lock().unwrap().push(step);
    // No proxy: a developer's `HTTP_PROXY` must not route a loopback test.
    let http = reqwest::Client::builder().no_proxy().build().unwrap();

    let warning = resolve_and_stage_replay_version(
        &http,
        TOKEN,
        &api.base,
        &cache,
        &target,
        &replay,
        "ForgedAlliance.exe",
        &progress,
    )
    .await
    .expect("the install must succeed against a complete API");
    assert_eq!(
        warning, None,
        "a numbered build is exact, never approximated"
    );

    // What the updater asked: each mod's id, then each release's list at the
    // number the replay named for it, not the latest and not each other's.
    let requests = api.requests();
    let lists: Vec<&str> = requests
        .iter()
        .map(|request| request.path.as_str())
        .filter(|path| path.starts_with("/featuredMods/"))
        .collect();
    assert_eq!(
        lists,
        [
            format!("/featuredMods/1/files/{ENGINE_BUILD}"),
            format!("/featuredMods/7/files/{OVERLAY_REVISION}"),
        ]
    );
    // The API is asked with the session's token; the content host is not
    // handed it, only the per-file HMAC the list came with.
    for request in &requests {
        let authorization = request.headers.get("authorization").map(String::as_str);
        if request.path.starts_with("/content/") {
            assert_eq!(authorization, None, "{}", request.path);
        } else {
            let expected = format!("Bearer {TOKEN}");
            assert_eq!(authorization, Some(expected.as_str()), "{}", request.path);
        }
    }

    // On disk: both releases' files, the executable stamped with the engine
    // build (never the overlay's revision), and `fa_path.lua` naming the
    // overlay at that engine build over the retail install.
    assert_eq!(
        std::fs::read(target.join("gamedata").join("units.nx2")).unwrap(),
        base_units
    );
    assert_eq!(
        std::fs::read(target.join("gamedata").join("nomads.nx2")).unwrap(),
        overlay_units
    );
    assert_eq!(
        read_exe_version(&target.join("bin").join("ForgedAlliance.exe")),
        Some(ENGINE_BUILD)
    );
    let fa_path = std::fs::read_to_string(target.join("fa_path.lua")).unwrap();
    assert!(fa_path.contains("GameType = \"nomads\""), "{fa_path}");
    assert!(
        fa_path.contains(&format!("GameVersion = \"{ENGINE_BUILD}\"")),
        "{fa_path}"
    );
    let retail_slashed = retail.display().to_string().replace('\\', "/");
    assert!(
        fa_path.contains(&format!("fa_path = \"{retail_slashed}\"")),
        "{fa_path}"
    );

    // The cache records both, and the overlay records the base it was
    // installed over: that is what lets the next run stage this pair again.
    let entries = manifest_entries(&cache);
    let entry = |featured_mod: &str| {
        entries
            .iter()
            .find(|entry| entry["featuredMod"] == featured_mod)
            .unwrap_or_else(|| panic!("no cache entry for {featured_mod}: {entries:?}"))
            .clone()
    };
    assert_eq!(entry("faf")["resolvedVersion"], ENGINE_BUILD);
    assert_eq!(entry("faf")["baseVersion"], Value::Null);
    assert_eq!(entry("nomads")["resolvedVersion"], OVERLAY_REVISION);
    assert_eq!(entry("nomads")["baseVersion"], ENGINE_BUILD);

    assert!(
        !steps.lock().unwrap().is_empty(),
        "the preparation dialog must have been told what was happening"
    );

    // The same replay again: the cache holds the pair, so the API is not
    // asked anything and the install ends up the same.
    api.clear();
    std::fs::remove_file(target.join("fa_path.lua")).unwrap();
    let warning = resolve_and_stage_replay_version(
        &http,
        TOKEN,
        &api.base,
        &cache,
        &target,
        &replay,
        "ForgedAlliance.exe",
        &progress,
    )
    .await
    .expect("the cached pair must stage");
    assert_eq!(warning, None);
    assert!(
        api.requests().is_empty(),
        "a cached build must not touch the API: {:?}",
        api.requests()
    );
    let fa_path = std::fs::read_to_string(target.join("fa_path.lua")).unwrap();
    assert!(fa_path.contains("GameType = \"nomads\""), "{fa_path}");
    assert!(
        fa_path.contains(&format!("GameVersion = \"{ENGINE_BUILD}\"")),
        "{fa_path}"
    );
    assert_eq!(
        read_exe_version(&target.join("bin").join("ForgedAlliance.exe")),
        Some(ENGINE_BUILD)
    );
}
