//! Unit history: what one unit's blueprint said in each game release.
//!
//! Three sources, read by `infra`: FAForever/fa's own copy of the blueprint at
//! each release tag, the base game's `units.scd`, and the installed FAF
//! `units.nx2` for the list of units. This module decides which of them a
//! release used, reads the values a player compares out of the blueprint, and
//! turns the releases into the two things the Changelog tab shows: one series
//! per value for the graph, and one row per release in which something
//! changed for the table.
//!
//! **Which blueprint a release used.** Until 3738 the repository held only
//! the units FAF had changed (before 3615 under `schook/units/`); the game
//! loaded every other unit from the base game's `units.scd`. From 3738 on it
//! holds all of them. So a release without the file is the base game's unit
//! before 3738, and a release in which the unit did not exist from then on.
//! The boundary was checked against the tags: 3737 lists 547 unit folders and
//! 3738 lists 605, and the 58 that appear are 57 base-game units FAF had never
//! touched plus one helper (`UES0302_SINK`). It is the rule faf-workshop's
//! generator applies (`tools/generate-unit-data.cs`, MIT).
//!
//! **Which differences count.** A blueprint is rewritten now and then without
//! a change in meaning: a value of 0 left out, `10/60` written as `0.1667`,
//! categories reordered. So numbers are rounded to four decimals, a 0 reads as
//! "not set" for the values where 0 means none (regeneration, shields, build
//! power, production, upkeep, speed, intel, damage area, minimum range, salvo
//! delay, damage over time), and categories are compared as a set. These are
//! faf-workshop's rules (`UnitSummary.cs`, MIT).
//!
//! **DPS** is what the game's own unit view prints (`lua/ui/game/
//! unitviewDetail.lua`): damage per firing cycle over the cycle's length, with
//! every delay rounded to whole ticks of 0.1 s the way the simulation fires.
//! The FAF unit database (`unitdb.faforever.com`, FAForever/etfreeman-db,
//! MIT) ports the same routine, and its test cases are this module's. A weapon
//! the view gives no DPS (nukes, manual fire, kamikaze, defences, death
//! weapons) gets none here either, and neither does one whose shell splits
//! into fragments: the fragment count is in the projectile's blueprint, which
//! this history does not read.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use specta::Type;

use super::blueprint::{merged, parse_blueprint, LuaTable, LuaValue};

/// From this release on, the FA repository holds every unit the game loads.
pub const EVERY_UNIT_FROM: u32 = 3738;
/// Before this release, FAF's unit blueprints lived under `schook/units/`.
pub const UNITS_FOLDER_FROM: u32 = 3615;

/// Where a release's copy of a blueprint lives, relative to the repository
/// root, in the order to try. Raw file URLs are case sensitive, and five units
/// (the `*LK*` anti-air) were kept in lower-case folders for a while, so the
/// lower-case folder is the fallback after the spelling the installed game
/// uses and the usual upper case.
pub fn blueprint_paths(release: u32, installed_path: &str) -> Vec<String> {
    let root = if release < UNITS_FOLDER_FROM {
        "schook/units"
    } else {
        "units"
    };
    let (folder, file) = installed_path
        .trim_start_matches('/')
        .strip_prefix("units/")
        .and_then(|rest| rest.split_once('/'))
        .unwrap_or(("", ""));
    let id = folder.to_ascii_uppercase();
    let mut paths = Vec::new();
    for candidate in [
        format!("{root}/{folder}/{file}"),
        format!("{root}/{id}/{id}_unit.bp"),
        format!("{root}/{}/{id}_unit.bp", id.to_ascii_lowercase()),
    ] {
        if !folder.is_empty() && !paths.contains(&candidate) {
            paths.push(candidate);
        }
    }
    paths
}

/// The release number of a tag, `"3837"` for 3837. `None` for anything else,
/// such as the rolling branches, which have no tag.
pub fn release_number(release: &str) -> Option<u32> {
    release.parse().ok()
}

/// One unit as the picker lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UnitSummary {
    /// Upper-case blueprint id, e.g. `UEL0201`.
    pub id: String,
    /// The blueprint's path inside the installed archive, e.g.
    /// `units/UEL0201/UEL0201_unit.bp`, kept for its exact spelling.
    pub path: String,
    /// `General.UnitName` without its localisation tag, e.g. "MA12 Striker".
    /// Many structures have none.
    pub name: Option<String>,
    /// `Description` without its localisation tag, e.g. "Medium Tank".
    pub description: Option<String>,
    /// `General.FactionName`: UEF, Aeon, Cybran or Seraphim.
    pub faction: Option<String>,
    /// 1 to 3, or 4 for an experimental; `None` for a commander.
    pub tech: Option<u8>,
}

/// Categories that mark a unit no player builds: campaign operations,
/// civilians, and helper entities the game spawns itself.
const UNLISTED_CATEGORIES: [&str; 4] = ["CIVILIAN", "OPERATION", "DUMMYUNIT", "INSIGNIFICANTUNIT"];
const FACTIONS: [&str; 4] = ["UEF", "Aeon", "Cybran", "Seraphim"];

/// The summary of a unit blueprint, or `None` for a unit the picker leaves
/// out: one with no faction of the four, or a campaign, civilian or helper
/// unit.
pub fn summarize(path: &str, blueprint: &LuaTable) -> Option<UnitSummary> {
    let id = path
        .trim_start_matches('/')
        .strip_prefix("units/")?
        .split('/')
        .next()?
        .to_ascii_uppercase();
    let faction = blueprint.string(&["General", "FactionName"])?;
    if !FACTIONS.contains(&faction) || id.starts_with("OP") {
        return None;
    }
    let categories = categories(blueprint);
    if UNLISTED_CATEGORIES
        .iter()
        .any(|unlisted| categories.contains(*unlisted))
    {
        return None;
    }
    Some(UnitSummary {
        id,
        path: path.trim_start_matches('/').to_owned(),
        name: without_localization(blueprint.string(&["General", "UnitName"])),
        description: without_localization(blueprint.string(&["Description"])),
        faction: Some(faction.to_owned()),
        tech: tech_level(&categories),
    })
}

/// `<LOC uel0201_name>MA12 Striker` → "MA12 Striker": the English text the
/// game falls back to. Empty text is no text.
pub fn without_localization(text: Option<&str>) -> Option<String> {
    let mut text = text?;
    if text.len() > 4 && text[..4].eq_ignore_ascii_case("<LOC") {
        if let Some(end) = text.find('>') {
            text = &text[end + 1..];
        }
    }
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_owned())
}

fn categories(blueprint: &LuaTable) -> BTreeSet<String> {
    blueprint
        .table(&["Categories"])
        .map(|table| {
            table
                .sequence()
                .filter_map(LuaValue::as_str)
                .map(str::to_ascii_uppercase)
                .collect()
        })
        .unwrap_or_default()
}

fn tech_level(categories: &BTreeSet<String>) -> Option<u8> {
    [
        ("TECH1", 1),
        ("TECH2", 2),
        ("TECH3", 3),
        ("EXPERIMENTAL", 4),
    ]
    .into_iter()
    .find(|(category, _)| categories.contains(*category))
    .map(|(_, level)| level)
}

/// A value of the unit as a whole.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum UnitStat {
    MaxHealth,
    RegenRate,
    ShieldHealth,
    ShieldRegenRate,
    ShieldRadius,
    MassCost,
    EnergyCost,
    BuildTime,
    BuildRate,
    MassProduction,
    EnergyProduction,
    EnergyUpkeep,
    Speed,
    VisionRadius,
    WaterVisionRadius,
    RadarRadius,
    SonarRadius,
    OmniRadius,
}

/// A value of one weapon.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum WeaponStat {
    Dps,
    Damage,
    DamageRadius,
    Range,
    MinRange,
    /// Shots per second, as the game fires them: whole ticks between shots.
    RateOfFire,
    SalvoSize,
    SalvoDelay,
    DotPulses,
    DotTime,
}

/// Which value a series or a change is about.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum UnitValueKey {
    Unit {
        stat: UnitStat,
    },
    /// `weapon` is the weapon's key in [`UnitHistory::weapons`].
    Weapon {
        weapon: String,
        stat: WeaponStat,
    },
}

/// One weapon as the history names it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UnitWeapon {
    /// The blueprint's `Label` ("MainGun"), which keeps a weapon recognisable
    /// across releases that reorder the list. A weapon without one is keyed
    /// by its position.
    pub key: String,
    /// `DisplayName` as the newest release that has the weapon writes it.
    pub name: String,
    /// `WeaponCategory`, e.g. "Direct Fire" or "Anti Air".
    pub category: Option<String>,
}

/// Where a release's values came from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum UnitSource {
    /// FAF's own blueprint in the FA repository at that release.
    Repository,
    /// The base game's blueprint, which the release loaded because the
    /// repository did not have the unit yet.
    BaseGame,
    /// The unit did not exist in that release.
    Absent,
    /// The values could not be found out: a download failed, the blueprint did
    /// not parse, or the base game is not installed.
    Unavailable { reason: String },
}

/// One release of the history.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UnitRelease {
    /// The changelog's release id, e.g. `"3837"`.
    pub release: String,
    pub date: String,
    pub source: UnitSource,
}

/// One value over all releases, aligned with [`UnitHistory::releases`]. `None`
/// where the value is not set, or the release's values are unknown.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UnitSeries {
    pub key: UnitValueKey,
    pub values: Vec<Option<f64>>,
}

/// What changed in one release.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum UnitChange {
    /// The unit exists from this release on.
    Added,
    /// The unit no longer exists in this release.
    Removed,
    Value {
        key: UnitValueKey,
        before: Option<f64>,
        after: Option<f64>,
    },
    Categories {
        added: Vec<String>,
        removed: Vec<String>,
    },
}

/// One row of the change table: a release and everything it changed,
/// compared with the last release before it whose values are known.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UnitChangeRow {
    pub release: String,
    pub date: String,
    pub changes: Vec<UnitChange>,
}

/// A unit's history over every release of the changelog that has a tag,
/// oldest first.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UnitHistory {
    pub unit: UnitSummary,
    pub releases: Vec<UnitRelease>,
    pub weapons: Vec<UnitWeapon>,
    pub series: Vec<UnitSeries>,
    pub changes: Vec<UnitChangeRow>,
}

/// What `infra` found for one release.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReleaseBlueprint {
    /// The repository's file, as text.
    Found(String),
    /// No file for the unit at that tag.
    Missing,
    /// It could not be fetched.
    Failed(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseInput {
    pub release: String,
    pub date: String,
    pub blueprint: ReleaseBlueprint,
}

/// The base game's copy of the unit.
#[derive(Debug, Clone, PartialEq)]
pub enum BaseGameBlueprint {
    Found(LuaTable),
    /// The base game has no such unit: it is one FAF added.
    Missing,
    /// The base game could not be read (not installed, or the file is
    /// damaged), so a release that fell back to it has unknown values.
    Unknown(String),
}

/// The values one release's blueprint holds, evened out (see the module
/// header).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct UnitSnapshot {
    pub values: BTreeMap<UnitValueKey, f64>,
    pub categories: BTreeSet<String>,
    /// Weapon key, display name and category, in blueprint order.
    pub weapons: Vec<UnitWeapon>,
}

fn round(value: f64) -> f64 {
    (value * 10_000.0).round() / 10_000.0
}

fn positive(value: Option<f64>) -> Option<f64> {
    value.filter(|value| *value > 0.0).map(round)
}

/// The game's `MATH_IRound`: to the nearest whole number, ties to even.
fn iround(value: f64) -> f64 {
    value.round_ties_even()
}

/// Read a unit blueprint's values. `fragments` says whether a projectile
/// blueprint id (as `ProjectileId` writes it) splits into fragments.
pub fn snapshot(blueprint: &LuaTable, fragments: &dyn Fn(&str) -> bool) -> UnitSnapshot {
    let mut snapshot = UnitSnapshot {
        categories: categories(blueprint),
        ..UnitSnapshot::default()
    };
    let mut unit = |stat: UnitStat, value: Option<f64>| {
        if let Some(value) = value {
            snapshot.values.insert(UnitValueKey::Unit { stat }, value);
        }
    };
    let number = |path: &[&str]| blueprint.number(path);
    unit(
        UnitStat::MaxHealth,
        number(&["Defense", "MaxHealth"]).map(round),
    );
    unit(
        UnitStat::RegenRate,
        positive(number(&["Defense", "RegenRate"])),
    );
    unit(
        UnitStat::ShieldHealth,
        positive(number(&["Defense", "Shield", "ShieldMaxHealth"])),
    );
    unit(
        UnitStat::ShieldRegenRate,
        positive(number(&["Defense", "Shield", "ShieldRegenRate"])),
    );
    unit(
        UnitStat::ShieldRadius,
        positive(number(&["Defense", "Shield", "ShieldSize"])),
    );
    unit(
        UnitStat::MassCost,
        number(&["Economy", "BuildCostMass"]).map(round),
    );
    unit(
        UnitStat::EnergyCost,
        number(&["Economy", "BuildCostEnergy"]).map(round),
    );
    unit(
        UnitStat::BuildTime,
        number(&["Economy", "BuildTime"]).map(round),
    );
    unit(
        UnitStat::BuildRate,
        positive(number(&["Economy", "BuildRate"])),
    );
    unit(
        UnitStat::MassProduction,
        positive(number(&["Economy", "ProductionPerSecondMass"])),
    );
    unit(
        UnitStat::EnergyProduction,
        positive(number(&["Economy", "ProductionPerSecondEnergy"])),
    );
    unit(
        UnitStat::EnergyUpkeep,
        positive(number(&[
            "Economy",
            "MaintenanceConsumptionPerSecondEnergy",
        ])),
    );
    let motion = blueprint.string(&["Physics", "MotionType"]);
    let speed = match motion {
        Some("RULEUMT_None") => None,
        Some("RULEUMT_Air") => number(&["Air", "MaxAirspeed"]),
        _ => number(&["Physics", "MaxSpeed"]),
    };
    unit(UnitStat::Speed, positive(speed));
    unit(
        UnitStat::VisionRadius,
        positive(number(&["Intel", "VisionRadius"])),
    );
    unit(
        UnitStat::WaterVisionRadius,
        positive(number(&["Intel", "WaterVisionRadius"])),
    );
    unit(
        UnitStat::RadarRadius,
        positive(number(&["Intel", "RadarRadius"])),
    );
    unit(
        UnitStat::SonarRadius,
        positive(number(&["Intel", "SonarRadius"])),
    );
    unit(
        UnitStat::OmniRadius,
        positive(number(&["Intel", "OmniRadius"])),
    );

    let weapons: Vec<&LuaTable> = blueprint
        .table(&["Weapon"])
        .map(|list| list.sequence().filter_map(LuaValue::as_table).collect())
        .unwrap_or_default();
    let mut seen: BTreeMap<String, usize> = BTreeMap::new();
    for (position, weapon) in weapons.into_iter().enumerate() {
        let label = weapon
            .string(&["Label"])
            .filter(|label| !label.trim().is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| format!("#{}", position + 1));
        let count = seen.entry(label.clone()).or_default();
        *count += 1;
        let key = if *count == 1 {
            label.clone()
        } else {
            format!("{label} #{count}")
        };
        let name = weapon
            .string(&["DisplayName"])
            .and_then(|name| without_localization(Some(name)))
            .unwrap_or_else(|| label.clone());
        snapshot.weapons.push(UnitWeapon {
            key: key.clone(),
            name,
            category: weapon.string(&["WeaponCategory"]).map(str::to_owned),
        });
        let mut stat = |stat: WeaponStat, value: Option<f64>| {
            if let Some(value) = value {
                snapshot.values.insert(
                    UnitValueKey::Weapon {
                        weapon: key.clone(),
                        stat,
                    },
                    value,
                );
            }
        };
        let number = |name: &str| weapon.number(&[name]);
        let fragmenting = weapon
            .string(&["ProjectileId"])
            .is_some_and(|projectile| fragments(projectile));
        stat(
            WeaponStat::Dps,
            (!fragmenting)
                .then(|| weapon_dps(weapon))
                .flatten()
                .map(round),
        );
        stat(WeaponStat::Damage, number("Damage").map(round));
        stat(WeaponStat::DamageRadius, positive(number("DamageRadius")));
        stat(WeaponStat::Range, number("MaxRadius").map(round));
        stat(WeaponStat::MinRange, positive(number("MinRadius")));
        stat(
            WeaponStat::RateOfFire,
            number("RateOfFire")
                .filter(|rate| *rate > 0.0)
                .map(|rate| round(1.0 / firing_cooldown(rate))),
        );
        stat(WeaponStat::SalvoSize, positive(number("MuzzleSalvoSize")));
        stat(WeaponStat::SalvoDelay, positive(number("MuzzleSalvoDelay")));
        stat(WeaponStat::DotPulses, positive(number("DoTPulses")));
        stat(WeaponStat::DotTime, positive(number("DoTTime")));
    }
    snapshot
}

/// Seconds between two shots: the interval the rate of fire asks for, in
/// whole ticks, and never less than one.
fn firing_cooldown(rate_of_fire: f64) -> f64 {
    (iround(10.0 / rate_of_fire) / 10.0).max(0.1)
}

/// A delay in whole ticks, or 0 when there is none.
fn ticks(value: Option<f64>) -> f64 {
    match value {
        Some(value) if value > 0.0 => (iround(10.0 * value) / 10.0).max(0.1),
        _ => 0.0,
    }
}

const NUKE_FIELDS: [&str; 8] = [
    "NukeOuterRingDamage",
    "NukeOuterRingRadius",
    "NukeOuterRingTicks",
    "NukeOuterRingTotalTime",
    "NukeInnerRingDamage",
    "NukeInnerRingRadius",
    "NukeInnerRingTicks",
    "NukeInnerRingTotalTime",
];

/// The DPS the game's unit view prints for a weapon, unrounded, or `None` for
/// a weapon it prints none for. Fields the blueprint leaves out take the
/// engine's defaults: no delays, a salvo of one, no beam.
pub fn weapon_dps(weapon: &LuaTable) -> Option<f64> {
    let category = weapon.string(&["WeaponCategory"])?;
    let number = |name: &str| weapon.number(&[name]);
    if weapon.flag(&["FireOnDeath"])
        || matches!(category, "Death" | "Kamikaze" | "Defense")
        || weapon.flag(&["ManualFire"])
        || NUKE_FIELDS.iter().all(|field| weapon.get(field).is_some())
    {
        return None;
    }
    let rate_of_fire = number("RateOfFire").filter(|rate| *rate > 0.0)?;

    let mut damage = number("Damage").unwrap_or(0.0) + number("DamageToShields").unwrap_or(0.0);
    let beam_lifetime = number("BeamLifetime").unwrap_or(0.0);
    if beam_lifetime > 0.0 {
        let pulses = (iround(beam_lifetime * 10.0)
            / (iround(number("BeamCollisionDelay").unwrap_or(0.0) * 10.0) + 1.0))
            .floor();
        damage *= 1.0 + pulses;
    } else {
        damage =
            damage * number("DoTPulses").unwrap_or(1.0) + number("InitialDamage").unwrap_or(0.0);
    }

    // The firing cycle, simulated as the weapon fires it.
    let firing_cooldown = firing_cooldown(rate_of_fire);
    let charge_time = ticks(number("RackSalvoChargeTime"));
    let muzzle_delays = ticks(number("MuzzleSalvoDelay")) + ticks(number("MuzzleChargeDelay"));
    let reload_time = ticks(number("RackSalvoReloadTime"));
    let salvo_delay = number("MuzzleSalvoDelay").unwrap_or(0.0);
    let salvo_size = number("MuzzleSalvoSize").unwrap_or(1.0);
    let fire_together = weapon.flag(&["RackFireTogether"]);

    let mut cycle_projectiles = 0.0;
    let mut cycle_time = 0.0;
    let mut sub_cycle_time = 0.0;
    let racks: Vec<&LuaTable> = weapon
        .table(&["RackBones"])
        .map(|racks| racks.sequence().filter_map(LuaValue::as_table).collect())
        .unwrap_or_default();
    let rack_count = racks.len();
    for (index, rack) in racks.iter().enumerate() {
        let muzzles = if salvo_delay == 0.0 {
            rack.table(&["MuzzleBones"])
                .map_or(0, |bones| bones.sequence().count()) as f64
        } else {
            salvo_size
        };
        cycle_projectiles += muzzles;
        sub_cycle_time += muzzles * muzzle_delays;
        if !fire_together && index + 1 != rack_count {
            if firing_cooldown <= sub_cycle_time + charge_time {
                cycle_time += sub_cycle_time
                    + charge_time
                    + (firing_cooldown - sub_cycle_time - charge_time).max(0.1);
            } else {
                cycle_time += firing_cooldown;
            }
            sub_cycle_time = 0.0;
        }
    }
    if firing_cooldown <= sub_cycle_time + charge_time + reload_time {
        cycle_time += sub_cycle_time
            + reload_time
            + charge_time
            + (firing_cooldown - sub_cycle_time - charge_time - reload_time).max(0.1);
    } else {
        cycle_time += firing_cooldown;
    }
    (cycle_time > 0.0 && cycle_projectiles > 0.0).then(|| damage * cycle_projectiles / cycle_time)
}

/// The DPS as the unit view prints it: rounded to a whole number.
pub fn shown_dps(dps: f64) -> f64 {
    iround(dps)
}

/// Resolve every release to its values and build the history.
///
/// `releases` must be oldest first. A release whose values cannot be found
/// out is shown as such and left out of the comparison, so the next known
/// release is compared with the last known one before it.
pub fn build_history(
    unit: UnitSummary,
    releases: Vec<ReleaseInput>,
    base: &BaseGameBlueprint,
    fragments: &dyn Fn(&str) -> bool,
) -> UnitHistory {
    let mut resolved: Vec<(UnitRelease, Option<UnitSnapshot>)> = Vec::with_capacity(releases.len());
    for input in releases {
        let number = release_number(&input.release).unwrap_or(u32::MAX);
        let (source, blueprint) = match input.blueprint {
            ReleaseBlueprint::Failed(reason) => (UnitSource::Unavailable { reason }, None),
            ReleaseBlueprint::Found(text) => match parse_blueprint(&text) {
                Err(error) => (
                    UnitSource::Unavailable {
                        reason: format!("the blueprint could not be read: {error}"),
                    },
                    None,
                ),
                Ok(blueprint) => match (blueprint.flag(&["Merge"]), base) {
                    (true, BaseGameBlueprint::Found(original)) => {
                        (UnitSource::Repository, Some(merged(original, &blueprint)))
                    }
                    (true, BaseGameBlueprint::Unknown(reason)) => (
                        UnitSource::Unavailable {
                            reason: reason.clone(),
                        },
                        None,
                    ),
                    _ => (UnitSource::Repository, Some(blueprint)),
                },
            },
            ReleaseBlueprint::Missing if number >= EVERY_UNIT_FROM => (UnitSource::Absent, None),
            ReleaseBlueprint::Missing => match base {
                BaseGameBlueprint::Found(original) => {
                    (UnitSource::BaseGame, Some(original.clone()))
                }
                BaseGameBlueprint::Missing => (UnitSource::Absent, None),
                BaseGameBlueprint::Unknown(reason) => (
                    UnitSource::Unavailable {
                        reason: reason.clone(),
                    },
                    None,
                ),
            },
        };
        let snapshot = blueprint.map(|blueprint| snapshot(&blueprint, fragments));
        resolved.push((
            UnitRelease {
                release: input.release,
                date: input.date,
                source,
            },
            snapshot,
        ));
    }

    // Weapons in the order they first appear, named as the newest release
    // that has them names them.
    let mut weapons: Vec<UnitWeapon> = Vec::new();
    for (_, snapshot) in &resolved {
        for weapon in snapshot.iter().flat_map(|snapshot| &snapshot.weapons) {
            match weapons.iter_mut().find(|known| known.key == weapon.key) {
                Some(known) => *known = weapon.clone(),
                None => weapons.push(weapon.clone()),
            }
        }
    }

    let keys: BTreeSet<UnitValueKey> = resolved
        .iter()
        .flat_map(|(_, snapshot)| snapshot.iter().flat_map(|snapshot| snapshot.values.keys()))
        .cloned()
        .collect();
    let mut series: Vec<UnitSeries> = keys
        .iter()
        .map(|key| UnitSeries {
            key: key.clone(),
            values: resolved
                .iter()
                .map(|(_, snapshot)| snapshot.as_ref().and_then(|s| s.values.get(key).copied()))
                .collect(),
        })
        .collect();
    // Unit values first, then each weapon in its own order.
    let weapon_position = |key: &UnitValueKey| match key {
        UnitValueKey::Unit { .. } => 0,
        UnitValueKey::Weapon { weapon, .. } => {
            1 + weapons
                .iter()
                .position(|known| &known.key == weapon)
                .unwrap_or(weapons.len())
        }
    };
    series.sort_by(|left, right| {
        weapon_position(&left.key)
            .cmp(&weapon_position(&right.key))
            .then_with(|| left.key.cmp(&right.key))
    });

    let mut changes = Vec::new();
    let mut previous: Option<(bool, Option<&UnitSnapshot>)> = None;
    for (release, snapshot) in &resolved {
        let present = match release.source {
            UnitSource::Unavailable { .. } => continue,
            UnitSource::Absent => false,
            UnitSource::Repository | UnitSource::BaseGame => true,
        };
        let Some((was_present, before)) = previous else {
            // The first known release is the starting point, not a change;
            // a unit that exists in it is simply there from the start.
            previous = Some((present, snapshot.as_ref()));
            continue;
        };
        let mut row = Vec::new();
        match (was_present, present) {
            (false, true) => row.push(UnitChange::Added),
            (true, false) => row.push(UnitChange::Removed),
            _ => {}
        }
        if let (Some(before), Some(after)) = (before, snapshot.as_ref()) {
            for key in &keys {
                let (old, new) = (before.values.get(key), after.values.get(key));
                if old != new {
                    row.push(UnitChange::Value {
                        key: key.clone(),
                        before: old.copied(),
                        after: new.copied(),
                    });
                }
            }
            let added: Vec<String> = after
                .categories
                .difference(&before.categories)
                .cloned()
                .collect();
            let removed: Vec<String> = before
                .categories
                .difference(&after.categories)
                .cloned()
                .collect();
            if !added.is_empty() || !removed.is_empty() {
                row.push(UnitChange::Categories { added, removed });
            }
        }
        if !row.is_empty() {
            changes.push(UnitChangeRow {
                release: release.release.clone(),
                date: release.date.clone(),
                changes: row,
            });
        }
        previous = Some((present, snapshot.as_ref()));
    }

    UnitHistory {
        unit,
        releases: resolved.into_iter().map(|(release, _)| release).collect(),
        weapons,
        series,
        changes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn weapon(source: &str) -> LuaTable {
        parse_blueprint(&format!("UnitBlueprint {{ {source} }}")).unwrap()
    }

    /// One rack per entry, each with the given muzzle count.
    fn racks(muzzles: &[usize]) -> String {
        let racks: Vec<String> = muzzles
            .iter()
            .map(|count| {
                let bones: Vec<String> = (0..*count).map(|i| format!("'Muzzle{i}'")).collect();
                format!("{{ MuzzleBones = {{ {} }} }}", bones.join(", "))
            })
            .collect();
        format!("RackBones = {{ {} }}", racks.join(", "))
    }

    fn dps(source: &str) -> f64 {
        weapon_dps(&weapon(source)).expect("a DPS")
    }

    // The cases of FAForever/etfreeman-db's `dpsCalculator.spec.js` (MIT),
    // which ports the same unit view routine; the shown value is what the
    // game prints.

    #[test]
    fn mantis_alternates_two_racks() {
        let value = dps(&format!(
            "WeaponCategory = 'Direct Fire', Damage = 8, RateOfFire = 10/3, {}, MuzzleSalvoSize = 1, MuzzleSalvoDelay = 0",
            racks(&[1, 1])
        ));
        assert!((value - 26.6667).abs() < 0.01, "{value}");
        assert_eq!(shown_dps(value), 27.0);
    }

    #[test]
    fn exodus_waits_a_tick_for_its_muzzle_charge() {
        let value = dps(&format!(
            "WeaponCategory = 'Direct Fire Naval', Damage = 1060, RateOfFire = 0.2, {}, MuzzleSalvoSize = 1, MuzzleSalvoDelay = 0, MuzzleChargeDelay = 0.1",
            racks(&[1])
        ));
        assert!((value - 212.0).abs() < 0.01, "{value}");
    }

    #[test]
    fn a_beam_hits_once_per_collision_interval() {
        let front = dps(&format!(
            "WeaponCategory = 'Direct Fire Naval', Damage = 45, BeamLifetime = 1, BeamCollisionDelay = 0, RateOfFire = 0.25, {}",
            racks(&[1])
        ));
        assert!((front - 123.75).abs() < 0.01, "{front}");
        let rear = dps(&format!(
            "WeaponCategory = 'Direct Fire Naval', Damage = 26, BeamLifetime = 1, BeamCollisionDelay = 0, RateOfFire = 0.25, {}",
            racks(&[1])
        ));
        assert!((rear - 71.5).abs() < 0.01, "{rear}");
    }

    #[test]
    fn racks_firing_together_count_as_one_shot() {
        let value = dps(&format!(
            "WeaponCategory = 'Direct Fire Naval', Damage = 305, RateOfFire = 0.25, RackFireTogether = true, {}, MuzzleSalvoSize = 1, MuzzleSalvoDelay = 0",
            racks(&[1, 1])
        ));
        assert!((value - 152.5).abs() < 0.01, "{value}");
    }

    #[test]
    fn a_muzzle_salvo_spreads_over_its_delays() {
        let cooper = dps(&format!(
            "WeaponCategory = 'Anti Navy', Damage = 80, RateOfFire = 0.3125, {}, MuzzleSalvoSize = 4, MuzzleSalvoDelay = 0.4",
            racks(&[1])
        ));
        assert!((cooper - 100.0).abs() < 0.01, "{cooper}");
        let vesper = dps(&format!(
            "WeaponCategory = 'Anti Navy', Damage = 90, RateOfFire = 0.25, {}, MuzzleSalvoSize = 4, MuzzleSalvoDelay = 0.4",
            racks(&[2])
        ));
        assert!((vesper - 90.0).abs() < 0.01, "{vesper}");
    }

    #[test]
    fn wailer_alternates_two_muzzles() {
        let value = dps(&format!(
            "WeaponCategory = 'Direct Fire', Damage = 140, RateOfFire = 10/6, {}, MuzzleSalvoSize = 1, MuzzleSalvoDelay = 0",
            racks(&[1, 1])
        ));
        assert!((value - 233.3333).abs() < 0.01, "{value}");
    }

    #[test]
    fn delays_round_to_whole_ticks_like_the_simulation() {
        // 10 / 0.15 is 66.7 ticks, which the game fires as 67: 6.7 s, not 6.67.
        let value = dps(&format!(
            "WeaponCategory = 'Artillery', Damage = 670, RateOfFire = 0.15, {}",
            racks(&[1])
        ));
        assert!((value - 100.0).abs() < 1e-9, "{value}");
    }

    #[test]
    fn weapons_the_view_prints_no_dps_for_get_none() {
        for source in [
            "WeaponCategory = 'Death', Damage = 100, RateOfFire = 1",
            "WeaponCategory = 'Kamikaze', Damage = 100, RateOfFire = 1",
            "WeaponCategory = 'Defense', Damage = 1, RateOfFire = 1",
            "WeaponCategory = 'Direct Fire', Damage = 100, RateOfFire = 1, FireOnDeath = true",
            "WeaponCategory = 'Missile', Damage = 100, RateOfFire = 1, ManualFire = true",
            "Damage = 100, RateOfFire = 1",
            "WeaponCategory = 'Direct Fire', Damage = 100",
            "WeaponCategory = 'Missile', Damage = 0, RateOfFire = 1, NukeOuterRingDamage = 1, NukeOuterRingRadius = 1, NukeOuterRingTicks = 1, NukeOuterRingTotalTime = 1, NukeInnerRingDamage = 1, NukeInnerRingRadius = 1, NukeInnerRingTicks = 1, NukeInnerRingTotalTime = 1",
        ] {
            assert_eq!(weapon_dps(&weapon(source)), None, "{source}");
        }
    }

    const STRIKER: &str = "UnitBlueprint{
    Description = \"<LOC uel0201_desc>Medium Tank\",
    Categories = { \"TECH1\", \"LAND\", \"UEF\", \"MOBILE\" },
    Defense = { Health = 300, MaxHealth = 300 },
    Economy = { BuildCostEnergy = 266, BuildCostMass = 56, BuildTime = 300 },
    General = { FactionName = \"UEF\", UnitName = \"<LOC uel0201_name>MA12 Striker\" },
    Intel = { VisionRadius = 20 },
    Physics = { MaxSpeed = 3.4, MotionType = \"RULEUMT_Land\" },
    Weapon = {
        {
            Label = \"MainGun\",
            DisplayName = \"Gauss Cannon\",
            WeaponCategory = \"Direct Fire\",
            Damage = 24, DamageRadius = 0, MaxRadius = 18,
            RateOfFire = 10/15,
            MuzzleSalvoDelay = 0, MuzzleSalvoSize = 1,
            RackBones = { { MuzzleBones = { \"Turret_Muzzle\" } } },
            ProjectileId = \"/projectiles/TDFGauss01/TDFGauss01_proj.bp\",
        },
        { Label = \"DeathWeapon\", WeaponCategory = \"Death\", Damage = 15 },
    },
}";

    fn striker() -> LuaTable {
        parse_blueprint(STRIKER).unwrap()
    }

    fn summary() -> UnitSummary {
        summarize("units/UEL0201/UEL0201_unit.bp", &striker()).unwrap()
    }

    fn no_fragments(_: &str) -> bool {
        false
    }

    fn found(text: &str) -> ReleaseBlueprint {
        ReleaseBlueprint::Found(text.to_owned())
    }

    fn input(release: &str, blueprint: ReleaseBlueprint) -> ReleaseInput {
        ReleaseInput {
            release: release.into(),
            date: format!("date of {release}"),
            blueprint,
        }
    }

    fn unit_key(stat: UnitStat) -> UnitValueKey {
        UnitValueKey::Unit { stat }
    }

    fn gun(stat: WeaponStat) -> UnitValueKey {
        UnitValueKey::Weapon {
            weapon: "MainGun".into(),
            stat,
        }
    }

    fn series<'a>(history: &'a UnitHistory, key: &UnitValueKey) -> &'a [Option<f64>] {
        &history
            .series
            .iter()
            .find(|series| &series.key == key)
            .expect("a series")
            .values
    }

    #[test]
    fn the_summary_names_the_unit_as_the_game_falls_back_to() {
        assert_eq!(
            summary(),
            UnitSummary {
                id: "UEL0201".into(),
                path: "units/UEL0201/UEL0201_unit.bp".into(),
                name: Some("MA12 Striker".into()),
                description: Some("Medium Tank".into()),
                faction: Some("UEF".into()),
                tech: Some(1),
            }
        );
        let civilian = parse_blueprint(
            "UnitBlueprint { Categories = { 'CIVILIAN' }, General = { FactionName = 'UEF' } }",
        )
        .unwrap();
        assert_eq!(summarize("units/UEC1101/UEC1101_unit.bp", &civilian), None);
        assert_eq!(
            summarize("units/OPE2001/OPE2001_unit.bp", &striker()),
            None,
            "a campaign operation unit"
        );
    }

    #[test]
    fn a_snapshot_reads_the_compared_values() {
        let snapshot = snapshot(&striker(), &no_fragments);
        let value = |key: UnitValueKey| snapshot.values.get(&key).copied();
        assert_eq!(value(unit_key(UnitStat::MaxHealth)), Some(300.0));
        assert_eq!(value(unit_key(UnitStat::MassCost)), Some(56.0));
        assert_eq!(value(unit_key(UnitStat::Speed)), Some(3.4));
        assert_eq!(
            value(unit_key(UnitStat::RegenRate)),
            None,
            "unset reads as unset"
        );
        assert_eq!(value(gun(WeaponStat::Damage)), Some(24.0));
        assert_eq!(value(gun(WeaponStat::DamageRadius)), None, "0 means none");
        assert_eq!(value(gun(WeaponStat::RateOfFire)), Some(0.6667));
        assert_eq!(value(gun(WeaponStat::Dps)), Some(16.0));
        assert_eq!(
            value(UnitValueKey::Weapon {
                weapon: "DeathWeapon".into(),
                stat: WeaponStat::Dps
            }),
            None
        );
        assert_eq!(snapshot.weapons[0].name, "Gauss Cannon");
        assert_eq!(
            snapshot.weapons[1].name, "DeathWeapon",
            "no display name falls back to the label"
        );

        let fragmenting = snapshot_with(&striker(), |projectile| projectile.contains("TDFGauss01"));
        assert_eq!(fragmenting.values.get(&gun(WeaponStat::Dps)), None);
        assert_eq!(
            fragmenting.values.get(&gun(WeaponStat::Damage)),
            Some(&24.0)
        );
    }

    fn snapshot_with(blueprint: &LuaTable, fragments: impl Fn(&str) -> bool) -> UnitSnapshot {
        snapshot(blueprint, &fragments)
    }

    #[test]
    fn a_blueprint_rewritten_without_a_change_in_meaning_is_no_change() {
        let rewritten = STRIKER
            .replace("RateOfFire = 10/15", "RateOfFire = 0.6667")
            .replace(
                "{ \"TECH1\", \"LAND\", \"UEF\", \"MOBILE\" }",
                "{ \"UEF\", \"MOBILE\", \"LAND\", \"TECH1\" }",
            )
            .replace("DamageRadius = 0, ", "");
        let history = build_history(
            summary(),
            vec![
                input("3800", found(STRIKER)),
                input("3801", found(&rewritten)),
            ],
            &BaseGameBlueprint::Missing,
            &no_fragments,
        );
        assert!(history.changes.is_empty(), "{:?}", history.changes);
    }

    #[test]
    fn a_change_is_reported_once_and_every_release_keeps_its_value() {
        let buffed = STRIKER.replace("Damage = 24", "Damage = 26");
        let history = build_history(
            summary(),
            vec![
                input("3800", found(STRIKER)),
                input("3801", found(&buffed)),
                input("3802", found(&buffed)),
            ],
            &BaseGameBlueprint::Missing,
            &no_fragments,
        );
        assert_eq!(
            series(&history, &gun(WeaponStat::Damage)),
            [Some(24.0), Some(26.0), Some(26.0)]
        );
        assert_eq!(history.changes.len(), 1);
        let row = &history.changes[0];
        assert_eq!(row.release, "3801");
        assert!(row.changes.contains(&UnitChange::Value {
            key: gun(WeaponStat::Damage),
            before: Some(24.0),
            after: Some(26.0),
        }));
        assert!(
            row.changes.iter().any(|change| matches!(
                change,
                UnitChange::Value { key, .. } if *key == gun(WeaponStat::Dps)
            )),
            "the DPS moves with the damage"
        );
    }

    #[test]
    fn before_3738_a_missing_file_is_the_base_game_unit() {
        let base = parse_blueprint(&STRIKER.replace("MaxHealth = 300", "MaxHealth = 270")).unwrap();
        let history = build_history(
            summary(),
            vec![
                input("3700", ReleaseBlueprint::Missing),
                input("3701", found(STRIKER)),
                // FAF reverted its change by deleting the file: the game took
                // the base game's unit again, not the previous release's.
                input("3702", ReleaseBlueprint::Missing),
                input("3738", found(STRIKER)),
            ],
            &BaseGameBlueprint::Found(base),
            &no_fragments,
        );
        let sources: Vec<_> = history
            .releases
            .iter()
            .map(|release| &release.source)
            .collect();
        assert_eq!(
            sources,
            [
                &UnitSource::BaseGame,
                &UnitSource::Repository,
                &UnitSource::BaseGame,
                &UnitSource::Repository
            ]
        );
        assert_eq!(
            series(&history, &unit_key(UnitStat::MaxHealth)),
            [Some(270.0), Some(300.0), Some(270.0), Some(300.0)]
        );
        let releases: Vec<_> = history
            .changes
            .iter()
            .map(|row| row.release.as_str())
            .collect();
        assert_eq!(releases, ["3701", "3702", "3738"]);
    }

    #[test]
    fn from_3738_a_missing_file_means_the_unit_is_not_in_the_release() {
        let history = build_history(
            summary(),
            vec![
                input("3738", ReleaseBlueprint::Missing),
                input("3800", found(STRIKER)),
                input("3801", ReleaseBlueprint::Missing),
            ],
            &BaseGameBlueprint::Missing,
            &no_fragments,
        );
        assert_eq!(history.releases[0].source, UnitSource::Absent);
        assert_eq!(history.changes[0].changes[0], UnitChange::Added);
        assert_eq!(history.changes[1].changes, [UnitChange::Removed]);
        assert_eq!(series(&history, &unit_key(UnitStat::MaxHealth))[2], None);
    }

    #[test]
    fn an_unknown_release_is_shown_and_skipped_in_the_comparison() {
        let buffed = STRIKER.replace("MaxHealth = 300", "MaxHealth = 320");
        let history = build_history(
            summary(),
            vec![
                input("3700", found(STRIKER)),
                input("3701", ReleaseBlueprint::Failed("offline".into())),
                input("3702", ReleaseBlueprint::Missing),
                input("3703", found(&buffed)),
            ],
            &BaseGameBlueprint::Unknown("the base game is not installed".into()),
            &no_fragments,
        );
        assert_eq!(
            history.releases[1].source,
            UnitSource::Unavailable {
                reason: "offline".into()
            }
        );
        assert!(matches!(
            history.releases[2].source,
            UnitSource::Unavailable { .. }
        ));
        assert_eq!(history.changes.len(), 1);
        assert_eq!(history.changes[0].release, "3703", "compared with 3700");
    }

    #[test]
    fn a_merge_blueprint_is_laid_over_the_base_game_unit() {
        let base = striker();
        let history = build_history(
            summary(),
            vec![input(
                "3610",
                found("UnitBlueprint { Merge = true, BlueprintId = 'uel0201', Defense = { MaxHealth = 310 } }"),
            )],
            &BaseGameBlueprint::Found(base),
            &no_fragments,
        );
        assert_eq!(
            series(&history, &unit_key(UnitStat::MaxHealth)),
            [Some(310.0)]
        );
        assert_eq!(
            series(&history, &unit_key(UnitStat::MassCost)),
            [Some(56.0)]
        );
    }

    #[test]
    fn category_changes_are_listed_as_added_and_removed() {
        let changed = STRIKER
            .replace("\"MOBILE\"", "\"MOBILE\", \"SNIPEMODE\"")
            .replace("\"LAND\", ", "");
        let history = build_history(
            summary(),
            vec![
                input("3800", found(STRIKER)),
                input("3801", found(&changed)),
            ],
            &BaseGameBlueprint::Missing,
            &no_fragments,
        );
        assert_eq!(
            history.changes[0].changes,
            [UnitChange::Categories {
                added: vec!["SNIPEMODE".into()],
                removed: vec!["LAND".into()],
            }]
        );
    }

    #[test]
    fn paths_follow_the_repository_layout_of_the_release() {
        assert_eq!(
            blueprint_paths(3800, "units/UEL0201/UEL0201_unit.bp"),
            [
                "units/UEL0201/UEL0201_unit.bp",
                "units/uel0201/UEL0201_unit.bp"
            ]
        );
        assert_eq!(
            blueprint_paths(3610, "units/ope2003/OPE2003_unit.bp")[0],
            "schook/units/ope2003/OPE2003_unit.bp"
        );
        assert_eq!(
            blueprint_paths(3800, "units/ope2003/OPE2003_unit.bp"),
            [
                "units/ope2003/OPE2003_unit.bp",
                "units/OPE2003/OPE2003_unit.bp"
            ]
        );
        assert!(blueprint_paths(3800, "garbage").is_empty());
    }
}
