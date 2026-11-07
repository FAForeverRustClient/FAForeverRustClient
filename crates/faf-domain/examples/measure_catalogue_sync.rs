//! Aggregate-only measurements from decoded catalogue caches, without their paths or content in output.
//! Usage: cargo run -p faf-domain --example measure_catalogue_sync -- maps.json mods.json
use std::{collections::BTreeMap, error::Error};

use faf_domain::{
    state::{CatalogueMap, MapsEvent, VaultMap, VaultMod},
    AppEvent, AppState,
};
use serde::Serialize;
use serde_json::{json, Value};

fn bytes(value: &impl Serialize) -> usize {
    serde_json::to_vec(value).expect("serializable").len()
}

fn fields(rows: &Value) -> BTreeMap<String, usize> {
    let mut fields = BTreeMap::new();
    for row in rows.as_array().expect("catalogue entries") {
        for (field, value) in row.as_object().expect("catalogue record") {
            // JSON key, colon and value, without commas, braces or array delimiters.
            *fields.entry(field.clone()).or_default() += bytes(field) + 1 + bytes(value);
        }
    }
    fields
}

fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if !(2..=3).contains(&args.len()) {
        return Err("expected decoded map and mod catalogue JSON files".into());
    }
    let maps_cache: Value = serde_json::from_slice(&std::fs::read(&args[0])?)?;
    let mods_cache: Value = serde_json::from_slice(&std::fs::read(&args[1])?)?;
    let maps: Vec<VaultMap> = serde_json::from_value(maps_cache["entries"].clone())?;
    let mods: Vec<VaultMod> = serde_json::from_value(mods_cache["entries"].clone())?;
    let records: Vec<CatalogueMap> = maps.iter().cloned().map(Into::into).collect();
    // Check the real catalogue, not only the hand-written unit examples.
    let compact = serde_json::to_value(&records)?;
    let recovered: Vec<CatalogueMap> = serde_json::from_value(compact.clone())?;
    assert_eq!(records, recovered);
    for (actual, original) in recovered.iter().zip(&maps) {
        assert_eq!(actual, original);
    }

    let mut state = AppState::default();
    state.maps.vault = records.clone();
    state.mods.vault = mods;
    let after = serde_json::to_value(&state)?;
    let mut before = after.clone();
    before["maps"]["vault"] = maps_cache["entries"].clone();
    if let Some(directory) = args.get(2) {
        let directory = std::path::Path::new(directory);
        std::fs::create_dir_all(directory)?;
        std::fs::write(
            directory.join("snapshot-before.json"),
            serde_json::to_vec(&json!({ "state": &before, "revision": 1 }))?,
        )?;
        std::fs::write(
            directory.join("snapshot-after.json"),
            serde_json::to_vec(&json!({ "state": &after, "revision": 1 }))?,
        )?;
    }
    let mut events = Vec::new();
    for (label, event) in [
        (
            "VaultLoaded",
            MapsEvent::VaultLoaded {
                maps: records.clone(),
            },
        ),
        (
            "VaultUpdated_all_records",
            MapsEvent::VaultUpdated {
                maps: records.clone(),
            },
        ),
        (
            "VaultUpdated_one_real_record",
            MapsEvent::VaultUpdated {
                maps: records.first().cloned().into_iter().collect(),
            },
        ),
    ] {
        let wire = serde_json::to_value(AppEvent::Maps(event))?;
        let mut full = wire.clone();
        full["event"]["payload"]["maps"] = if label.ends_with("one_real_record") {
            serde_json::to_value(maps.first().into_iter().collect::<Vec<_>>())?
        } else {
            maps_cache["entries"].clone()
        };
        events.push(json!({"event":label,"before":bytes(&full),"after":bytes(&wire)}));
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "maps": {"records": records.len(), "catalogueBefore": bytes(&maps_cache["entries"]), "catalogueAfter": bytes(&compact), "fieldBytesBefore": fields(&maps_cache["entries"]), "sliceBefore": bytes(&before["maps"]), "sliceAfter": bytes(&after["maps"])},
            "mods": {"records": state.mods.vault.len(), "catalogueBytes": bytes(&after["mods"]["vault"]), "fieldBytes": fields(&mods_cache["entries"]), "sliceBytes": bytes(&after["mods"])},
            "cataloguePopulatedDefaultSnapshot": {"before":bytes(&before),"after":bytes(&after)},
        "lagRecoveryMessage": {"before":bytes(&json!({"kind":"snapshot","revision":1,"state":&before})),"after":bytes(&json!({"kind":"snapshot","revision":1,"state":&after}))},
            "localPreviewsBytes": bytes(&after["maps"]["localPreviews"]),
            "replaysDefaultBytes": bytes(&after["replays"]),
            "events": events,
            "allRecordsRoundTrip": true,
        }))?
    );
    Ok(())
}
