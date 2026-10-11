//! Fixtures the replay submodules' tests share: a stub map generator, replay
//! preparation wired to it, and replay bodies built byte by byte.
//!
//! One place rather than a copy per submodule, because the bodies are only
//! trustworthy as long as every test builds them the same way.

use std::sync::Arc;

use async_trait::async_trait;
use faf_domain::state::{GeneratorOptionQuery, GeneratorOptions, GeneratorPreset, GeneratorStatus};
use tokio::sync::mpsc;

use crate::ports::GeneratorUpdate;

use super::preparation::ReplayPreparation;
use super::ReplayConfig;

/// Records what the launch path asked of the generator. Everything the
/// replay path never touches is left unimplemented rather than faked, so a
/// future call through one of those reads as a test bug, not as a pass.
pub(super) struct StubGenerator {
    installed: bool,
    outcome: GeneratorStatus,
    pub(super) asked_for: std::sync::Mutex<Vec<String>>,
}

impl StubGenerator {
    pub(super) fn new(installed: bool, outcome: GeneratorStatus) -> Self {
        Self {
            installed,
            outcome,
            asked_for: std::sync::Mutex::new(Vec::new()),
        }
    }
}

#[async_trait]
impl crate::ports::MapGeneratorPort for StubGenerator {
    fn is_installed(&self, _map_name: &str) -> bool {
        self.installed
    }

    async fn generate_named(&self, map_name: String) -> mpsc::Receiver<GeneratorUpdate> {
        self.asked_for.lock().unwrap().push(map_name);
        let (tx, rx) = mpsc::channel(4);
        let _ = tx.send(GeneratorUpdate::Status(self.outcome.clone())).await;
        rx
    }

    async fn generate(&self, _options: GeneratorOptions) -> mpsc::Receiver<GeneratorUpdate> {
        unimplemented!("the replay path never generates from options")
    }
    async fn query_options(
        &self,
        _query: GeneratorOptionQuery,
        _version: Option<String>,
        _progress: Option<mpsc::Sender<GeneratorUpdate>>,
    ) -> Result<Vec<String>, String> {
        unimplemented!()
    }
    async fn preflight(&self, _options: GeneratorOptions) -> Result<String, String> {
        unimplemented!()
    }
    async fn help(&self, _version: Option<String>) -> Result<String, String> {
        unimplemented!()
    }
    fn cancel(&self) {
        unimplemented!()
    }
    async fn save_preset(&self, _name: &str, _options: &GeneratorOptions) -> Result<(), String> {
        unimplemented!()
    }
    async fn list_presets(&self) -> Vec<GeneratorPreset> {
        unimplemented!()
    }
    async fn delete_preset(&self, _name: &str) -> Result<(), String> {
        unimplemented!()
    }
    async fn latest_version(&self) -> Result<String, String> {
        unimplemented!()
    }
    async fn available_versions(&self) -> Result<Vec<String>, String> {
        unimplemented!()
    }
    async fn clean_up(&self, _protected: &[String]) -> Result<usize, String> {
        unimplemented!()
    }
    async fn map_previews(
        &self,
        _map_names: &[String],
    ) -> std::collections::HashMap<String, String> {
        unimplemented!()
    }
}

/// Replay preparation on its own, with the stub as its map generator.
pub(super) fn preparation_with(generator: Arc<StubGenerator>) -> ReplayPreparation {
    ReplayPreparation::new(&replay_config(), generator)
}

pub(super) fn replay_config() -> ReplayConfig {
    ReplayConfig {
        user_api_base: "https://user.faforever.com".into(),
        api_base: "https://api.faforever.com".into(),
        vault_host: "https://replay.faforever.com".into(),
        replay_target_dir: None,
        exe_name: "ForgedAlliance.exe".into(),
        content_base: "https://content.faforever.com".into(),
    }
}

pub(super) fn lua_string(value: &str) -> Vec<u8> {
    let mut bytes = vec![1];
    bytes.extend_from_slice(value.as_bytes());
    bytes.push(0);
    bytes
}

pub(super) fn lua_number(value: f32) -> Vec<u8> {
    let mut bytes = vec![0];
    bytes.extend_from_slice(&value.to_le_bytes());
    bytes
}

/// One army of the replay body's table, the way the engine writes it:
/// the player's name, their seat's team, and the TrueSkill pair the
/// displayed rating is derived from.
fn lua_army_named(name: &str, team: f32, civilian: bool) -> Vec<u8> {
    let mut bytes = vec![4];
    bytes.extend(lua_string("PlayerName"));
    bytes.extend(lua_string(name));
    bytes.extend(lua_string("Team"));
    bytes.extend(lua_number(team));
    bytes.extend(lua_string("Civilian"));
    bytes.push(3);
    bytes.push(u8::from(civilian));
    bytes.extend(lua_string("Faction"));
    bytes.extend(lua_number(1.0));
    bytes.extend(lua_string("MEAN"));
    bytes.extend(lua_number(1500.0));
    bytes.extend(lua_string("DEV"));
    bytes.extend(lua_number(100.0));
    bytes.extend(lua_string("Country"));
    bytes.extend(lua_string("DE"));
    bytes.push(5);
    bytes
}

fn local_body_with_army() -> Vec<u8> {
    // Four bytes, as every real replay has here and as the reference
    // parser reads. This fixture used to carry a bare `\0`, which only
    // parsed because the reader looked for a NUL instead of a width.
    local_body_with_army_after(b"\r\n\x1a\0")
}

/// [`local_body_with_army`] with the four-byte field after the map string
/// filled by the caller, so a test can put bytes there that are not a
/// NUL-terminated string.
pub(super) fn local_body_with_army_after(gap: &[u8]) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(b"Supreme Commander v1.50.3764\0");
    body.extend_from_slice(b"\r\n\0");
    body.extend_from_slice(b"Replay v1.9\r\n/maps/SCMP_009/SCMP_009.scmap\0");
    body.extend_from_slice(gap);
    body.extend_from_slice(&0_u32.to_le_bytes());
    body.extend_from_slice(&[4, 5]);
    body.extend_from_slice(&0_u32.to_le_bytes());
    body.extend_from_slice(&[4, 5]);
    body.push(1);
    body.extend_from_slice(b"TestPlayer\0");
    body.extend_from_slice(&u32::MAX.to_le_bytes());
    body.push(0);
    // Three armies: the two players the envelope also knows about, on the
    // two teams the engine seated them in, and the neutral civilian army
    // every map carries and no listing should show.
    body.push(3);
    for army in [
        lua_army_named("TestPlayer", 2.0, false),
        lua_army_named("Guest", 3.0, false),
        lua_army_named("civilian", 1.0, true),
    ] {
        body.extend_from_slice(&1_u32.to_le_bytes());
        body.extend(army);
        body.extend_from_slice(&[0, 0]);
    }
    body
}

/// [`local_body_with_army`], framed the way a `.fafreplay` carries it:
/// zlib behind its uncompressed size, base64 over the pair.
pub(super) fn qcompressed_body() -> String {
    use base64::Engine as _;
    use std::io::Write as _;

    let body = local_body_with_army();
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(&body).unwrap();
    let mut qcompressed = (body.len() as u32).to_be_bytes().to_vec();
    qcompressed.extend(encoder.finish().unwrap());
    base64::engine::general_purpose::STANDARD.encode(qcompressed)
}
