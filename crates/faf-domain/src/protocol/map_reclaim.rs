//! What there is to reclaim on a map at the start: every prop's mass and
//! energy, from its blueprint, added up and binned over the map.
//!
//! A prop's value is its blueprint's `Economy.ReclaimMassMax` and
//! `ReclaimEnergyMax`, the amount an engineer gets for reclaiming it whole.
//! Props whose blueprint is not found (a map shipping its own) count as
//! props without a value, and the caller says how many there were.

use super::blueprint::LuaTable;
use super::scmap::ScmapProp;

/// The value of one prop blueprint.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct PropValue {
    pub mass: f32,
    pub energy: f32,
}

/// A prop blueprint's reclaim value.
pub fn prop_value(blueprint: &LuaTable) -> PropValue {
    let number = |key: &str| {
        blueprint
            .number(&["Economy", key])
            .filter(|value| value.is_finite() && *value > 0.0)
            .unwrap_or(0.0) as f32
    };
    PropValue {
        mass: number("ReclaimMassMax"),
        energy: number("ReclaimEnergyMax"),
    }
}

/// How a prop's blueprint path is looked up: lower case, forward slashes, no
/// leading slash. `/env/Evergreen/Props/Trees/Pine06_s1_prop.bp` and the
/// archive's `env/evergreen/props/trees/pine06_s1_prop.bp` are one key.
pub fn prop_key(path: &str) -> String {
    path.replace('\\', "/")
        .trim_start_matches('/')
        .to_ascii_lowercase()
}

/// The map's reclaim, in total and binned.
#[derive(Debug, Clone, PartialEq)]
pub struct ReclaimSummary {
    pub mass: f64,
    pub energy: f64,
    /// Props on the map, and how many of them have a blueprint found.
    pub props: usize,
    pub valued: usize,
    /// Ogrids per side of one bin.
    pub bin: u32,
    pub columns: u32,
    pub rows: u32,
    /// Mass per bin, row by row.
    pub mass_bins: Vec<f32>,
}

/// Add up the props of a `width` by `height` map, binned `bin` ogrids a side.
pub fn summarize_reclaim(
    props: &[ScmapProp],
    width: u32,
    height: u32,
    bin: u32,
    value: impl Fn(&str) -> Option<PropValue>,
) -> ReclaimSummary {
    let bin = bin.max(1);
    let columns = width.div_ceil(bin).max(1);
    let rows = height.div_ceil(bin).max(1);
    let mut summary = ReclaimSummary {
        mass: 0.0,
        energy: 0.0,
        props: props.len(),
        valued: 0,
        bin,
        columns,
        rows,
        mass_bins: vec![0.0; (columns * rows) as usize],
    };
    for prop in props {
        let Some(worth) = value(&prop_key(&prop.blueprint)) else {
            continue;
        };
        summary.valued += 1;
        summary.mass += f64::from(worth.mass);
        summary.energy += f64::from(worth.energy);
        if !(prop.x.is_finite() && prop.z.is_finite()) || prop.x < 0.0 || prop.z < 0.0 {
            continue;
        }
        let (column, row) = (prop.x as u32 / bin, prop.z as u32 / bin);
        if column < columns && row < rows {
            summary.mass_bins[(row * columns + column) as usize] += worth.mass;
        }
    }
    summary
}

#[cfg(test)]
mod tests {
    use super::super::blueprint::parse_blueprint;
    use super::*;

    fn prop(blueprint: &str, x: f32, z: f32) -> ScmapProp {
        ScmapProp {
            blueprint: blueprint.into(),
            x,
            z,
        }
    }

    #[test]
    fn a_prop_blueprint_is_worth_its_reclaim_maxima() {
        let rock = parse_blueprint(
            "PropBlueprint { Economy = { ReclaimEnergyMax = 0, ReclaimMassMax = 24, ReclaimTime = 9 } }",
        )
        .unwrap();
        assert_eq!(
            prop_value(&rock),
            PropValue {
                mass: 24.0,
                energy: 0.0
            }
        );
    }

    #[test]
    fn props_add_up_and_fall_into_their_bins() {
        let props = [
            prop("/env/Evergreen/Props/Rocks/Rock01_prop.bp", 1.0, 1.0),
            prop("/env/Evergreen/Props/Rocks/Rock01_prop.bp", 20.0, 1.0),
            prop("/env/Evergreen/Props/Trees/Pine06_s1_prop.bp", 20.0, 3.0),
            prop("/maps/own/props/statue_prop.bp", 5.0, 5.0),
        ];
        let summary = summarize_reclaim(&props, 32, 16, 16, |key| match key {
            "env/evergreen/props/rocks/rock01_prop.bp" => Some(PropValue {
                mass: 10.0,
                energy: 0.0,
            }),
            "env/evergreen/props/trees/pine06_s1_prop.bp" => Some(PropValue {
                mass: 0.0,
                energy: 6.0,
            }),
            _ => None,
        });
        assert_eq!((summary.props, summary.valued), (4, 3));
        assert_eq!((summary.mass, summary.energy), (20.0, 6.0));
        assert_eq!((summary.columns, summary.rows), (2, 1));
        assert_eq!(summary.mass_bins, [10.0, 10.0]);
    }
}
