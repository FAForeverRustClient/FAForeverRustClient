//! Full Rust catalogue records with a compact, lossless presentation on the wire.
use std::{
    ops::{Deref, DerefMut},
    sync::Arc,
};

use serde::{Deserialize, Serialize};
use specta::Type;

use super::VaultMap;

const SMALL: &str = "https://content.faforever.com/maps/previews/small/";
const LARGE: &str = "https://content.faforever.com/maps/previews/large/";
const DOWNLOAD: &str = "https://content.faforever.com/maps/";

/// Exact exceptions to the catalogue's folder-based content URLs. Empty URLs
/// are exceptions too; an absent override means the canonical URL, not no art.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MapUrls {
    #[serde(default)]
    #[specta(optional)]
    pub thumbnail_url: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub thumbnail_url_large: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub download_url: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BorrowedUrls<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    thumbnail_url: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    thumbnail_url_large: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    download_url: Option<&'a str>,
}

impl BorrowedUrls<'_> {
    fn is_empty(&self) -> bool {
        self.thumbnail_url.is_none()
            && self.thumbnail_url_large.is_none()
            && self.download_url.is_none()
    }
}

fn override_url<'a>(url: &'a str, prefix: &str, folder: &str, suffix: &str) -> Option<&'a str> {
    // Match exactly, without normalizing or encoding. The API's URLs append
    // the raw folder, including punctuation and spaces. Anything different
    // stays an override, including a future CDN, escaping rule or empty URL.
    (url.strip_prefix(prefix)
        .and_then(|path| path.strip_suffix(suffix))
        != Some(folder))
    .then_some(url)
}

// One field list defines the generated contract and its borrowed serializer.
// Destructuring VaultMap exhaustively forces new fields to be classified here.
macro_rules! catalogue_fields {
    ($($field:ident: $ty:ty),+ $(,)?) => {
        /// Map metadata used by catalogue consumers. URL exceptions are sparse;
        /// paged vault searches still carry complete VaultMap records.
        #[derive(Debug, Clone, PartialEq, Eq, Deserialize, Type)]
        #[serde(rename_all = "camelCase")]
        pub struct MapSummary {
            $(pub $field: $ty,)+
            #[serde(default)]
            #[specta(optional)]
            pub urls: MapUrls,
        }

        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct BorrowedSummary<'a> {
            $($field: &'a $ty,)+
            #[serde(skip_serializing_if = "BorrowedUrls::is_empty")]
            urls: BorrowedUrls<'a>,
        }

        fn project(map: &VaultMap) -> BorrowedSummary<'_> {
            let VaultMap { $($field,)+ thumbnail_url, thumbnail_url_large, download_url } = map;
            BorrowedSummary {
                $($field,)+
                urls: BorrowedUrls {
                    thumbnail_url: override_url(thumbnail_url, SMALL, &map.folder_name, ".png"),
                    thumbnail_url_large: override_url(thumbnail_url_large, LARGE, &map.folder_name, ".png"),
                    download_url: override_url(download_url, DOWNLOAD, &map.folder_name, ".zip"),
                },
            }
        }

        impl From<MapSummary> for VaultMap {
            fn from(summary: MapSummary) -> Self {
                let thumbnail_url = summary.urls.thumbnail_url.unwrap_or_else(|| format!("{SMALL}{}.png", summary.folder_name));
                let thumbnail_url_large = summary.urls.thumbnail_url_large.unwrap_or_else(|| format!("{LARGE}{}.png", summary.folder_name));
                let download_url = summary.urls.download_url.unwrap_or_else(|| format!("{DOWNLOAD}{}.zip", summary.folder_name));
                Self { $($field: summary.$field,)+ thumbnail_url, thumbnail_url_large, download_url }
            }
        }
    };
}

catalogue_fields! {
    map_id: i32,
    version_id: i32,
    display_name: String,
    author: Option<String>,
    author_id: Option<i32>,
    folder_name: String,
    version: String,
    description: String,
    map_type: String,
    max_players: i32,
    width: i32,
    height: i32,
    games_played: i32,
    version_games_played: i32,
    ranked: bool,
    hidden: bool,
    recommended: bool,
    rating_tenths: i32,
    reviews: i32,
    created_at: String,
}

/// Rust retains the full record. Snapshot and event clones share it; a reducer
/// mutation copies only the changed record. Serialization borrows its fields
/// rather than allocating a second presentation catalogue under the state lock.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogueMap(Arc<VaultMap>);

impl From<VaultMap> for CatalogueMap {
    fn from(map: VaultMap) -> Self {
        Self(Arc::new(map))
    }
}

impl Deref for CatalogueMap {
    type Target = VaultMap;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl DerefMut for CatalogueMap {
    fn deref_mut(&mut self) -> &mut Self::Target {
        Arc::make_mut(&mut self.0)
    }
}

impl PartialEq<VaultMap> for CatalogueMap {
    fn eq(&self, other: &VaultMap) -> bool {
        self.deref() == other
    }
}

impl PartialEq<CatalogueMap> for VaultMap {
    fn eq(&self, other: &CatalogueMap) -> bool {
        self == other.deref()
    }
}

impl Serialize for CatalogueMap {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        project(self).serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for CatalogueMap {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        MapSummary::deserialize(deserializer).map(|summary| VaultMap::from(summary).into())
    }
}

impl Type for CatalogueMap {
    fn definition(types: &mut specta::Types) -> specta::datatype::DataType {
        MapSummary::definition(types)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn full(folder: &str) -> VaultMap {
        VaultMap {
            map_id: 1,
            version_id: 2,
            display_name: "A map".into(),
            author: Some("Uploader".into()),
            author_id: Some(3),
            folder_name: folder.into(),
            version: "2".into(),
            description: "Text used by local search".into(),
            map_type: "skirmish".into(),
            max_players: 8,
            width: 512,
            height: 1024,
            games_played: 100,
            version_games_played: 12,
            ranked: true,
            hidden: false,
            recommended: true,
            rating_tenths: 45,
            reviews: 10,
            created_at: "2026-01-02T00:00:00Z".into(),
            download_url: format!("{DOWNLOAD}{folder}.zip"),
            thumbnail_url: format!("{SMALL}{folder}.png"),
            thumbnail_url_large: format!("{LARGE}{folder}.png"),
        }
    }

    #[test]
    fn compact_catalogue_round_trips_every_field_and_exact_url_exception() {
        for folder in [
            "normal.v0001",
            "Map (one), [two] & café.v0002",
            "../literal%20folder",
        ] {
            for mask in 0..8 {
                let mut map = full(folder);
                if mask & 1 != 0 {
                    map.thumbnail_url = String::new();
                }
                if mask & 2 != 0 {
                    map.thumbnail_url_large = "https://other.invalid/art?size=large".into();
                }
                if mask & 4 != 0 {
                    map.download_url = "https://content.faforever.com/maps/different.zip".into();
                }
                let compact: CatalogueMap = map.clone().into();
                let json = serde_json::to_value(&compact).unwrap();
                assert!(json.get("downloadUrl").is_none());
                assert!(json.get("thumbnailUrl").is_none());
                assert!(json.get("thumbnailUrlLarge").is_none());
                assert_eq!(json.get("urls").is_some(), mask != 0);
                let decoded: CatalogueMap = serde_json::from_value(json).unwrap();
                assert_eq!(decoded, map);
                // The disk/API DTO remains full and unchanged.
                let full_json = serde_json::to_value(&map).unwrap();
                assert_eq!(full_json["downloadUrl"], map.download_url);
                assert_eq!(full_json["thumbnailUrlLarge"], map.thumbnail_url_large);
            }
        }
    }

    #[test]
    fn compact_catalogue_snapshots_share_records_and_visibility_is_copy_on_write() {
        use super::super::{reduce, MapsEvent, MapsState};
        let first: CatalogueMap = full("one.v0001").into();
        let second: CatalogueMap = VaultMap {
            version_id: 3,
            ..full("two.v0001")
        }
        .into();
        let mut state = MapsState {
            vault: vec![first, second],
            ..Default::default()
        };
        let snapshot = state.clone();
        assert!(Arc::ptr_eq(&state.vault[0].0, &snapshot.vault[0].0));
        reduce(
            &mut state,
            &MapsEvent::MapVisibilityChanged {
                version_id: 2,
                hidden: true,
            },
        );
        assert!(!snapshot.vault[0].hidden);
        assert!(state.vault[0].hidden);
        assert!(!Arc::ptr_eq(&state.vault[0].0, &snapshot.vault[0].0));
        assert!(Arc::ptr_eq(&state.vault[1].0, &snapshot.vault[1].0));
        assert_eq!(state.vault[0].description, snapshot.vault[0].description);
    }

    #[test]
    fn compact_catalogue_events_and_snapshots_use_the_same_wire_projection() {
        use super::super::{MapsEvent, MapsState};
        let record: CatalogueMap = full("map.v0001").into();
        let state = MapsState {
            vault: vec![record.clone()],
            ..Default::default()
        };
        let expected = serde_json::to_value(&state).unwrap()["vault"].clone();
        for event in [
            MapsEvent::VaultLoaded {
                maps: vec![record.clone()],
            },
            MapsEvent::VaultUpdated {
                maps: vec![record.clone()],
            },
            MapsEvent::VaultFoldersResolved {
                maps: vec![record.clone()],
            },
        ] {
            let json = serde_json::to_value(&event).unwrap();
            assert_eq!(json["payload"]["maps"], expected);
            assert_eq!(serde_json::from_value::<MapsEvent>(json).unwrap(), event);
        }
        assert_eq!(
            serde_json::from_value::<MapsState>(serde_json::to_value(&state).unwrap()).unwrap(),
            state
        );
    }
}
