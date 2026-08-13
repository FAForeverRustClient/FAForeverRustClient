//! Tutorials: the FAF Data API's guided lessons.
//!
//! `GET /data/tutorialCategory` with the tutorials, their map versions and the
//! maps themselves included. Mirrors the Java client's
//! `TutorialService.getTutorialCategories()`, which fetches the same nested
//! document in one call.

use async_trait::async_trait;
use faf_domain::protocol::tournaments::{first_link_url, to_plain_text};
use faf_domain::state::{Tutorial, TutorialCategory};

use crate::infra::env_or;
use crate::infra::jsonapi::{
    document_index, fetch_document, rel_one, rel_targets, value_bool, value_i32, value_string,
    JsonApiResource, ResourceIndex,
};
use crate::infra::session::TokenStore;
use crate::ports::TutorialsPort;

const PAGE_SIZE: u32 = 1000;

#[derive(Debug, Clone)]
pub struct TutorialsConfig {
    pub api_base: String,
}

impl TutorialsConfig {
    pub fn faf() -> Self {
        Self {
            api_base: env_or("FAF_API_BASE", "https://api.faforever.com"),
        }
    }
}

pub struct TutorialsClient {
    config: TutorialsConfig,
    tokens: TokenStore,
    http: reqwest::Client,
}

impl TutorialsClient {
    pub fn new(config: TutorialsConfig, tokens: TokenStore) -> Self {
        Self {
            config,
            tokens,
            http: super::http::shared_http_client(),
        }
    }

    pub fn faf(tokens: TokenStore) -> Self {
        Self::new(TutorialsConfig::faf(), tokens)
    }
}

#[async_trait]
impl TutorialsPort for TutorialsClient {
    async fn list_tutorials(&self) -> Result<(Vec<TutorialCategory>, Vec<Tutorial>), String> {
        let token = self
            .tokens
            .get()
            .ok_or_else(|| "not logged in".to_string())?;

        let mut url = url::Url::parse(&format!("{}/data/tutorialCategory", self.config.api_base))
            .map_err(|error| format!("invalid API base: {error}"))?;
        url.query_pairs_mut()
            .append_pair("page[size]", &PAGE_SIZE.to_string())
            // The map folder lives two hops down, and it is what has to be
            // downloaded before a lesson can start.
            .append_pair(
                "include",
                "tutorials,tutorials.mapVersion,tutorials.mapVersion.map",
            );

        let doc = fetch_document(&self.http, url, &token).await?;
        let index = document_index(&doc);

        let categories: Vec<TutorialCategory> =
            doc.data.iter().filter_map(parse_category).collect();

        // Categories own their tutorials; invert that so each lesson knows its
        // category, which is what the view groups by.
        let mut tutorials = Vec::new();
        for category in &doc.data {
            let category_id = category.id.parse::<i32>().ok();
            for key in rel_targets(&category.relationships, "tutorials") {
                let Some(resource) = index.get(&key).copied() else {
                    continue;
                };
                if let Some(mut tutorial) = parse_tutorial(resource, &index) {
                    tutorial.category_id = category_id;
                    tutorials.push(tutorial);
                }
            }
        }

        Ok((categories, tutorials))
    }
}

fn parse_category(resource: &JsonApiResource) -> Option<TutorialCategory> {
    let id = resource.id.parse::<i32>().ok()?;
    let attributes = &resource.attributes;
    // The API calls it `category`; older records carry `categoryKey` only.
    let name = {
        let category = value_string(attributes, "category");
        if category.is_empty() {
            value_string(attributes, "categoryKey")
        } else {
            category
        }
    };
    Some(TutorialCategory { id, name })
}

fn parse_tutorial(resource: &JsonApiResource, index: &ResourceIndex<'_>) -> Option<Tutorial> {
    let id = resource.id.parse::<i32>().ok()?;
    let attributes = &resource.attributes;

    // mapVersion carries the folder; the linked map carries it too on some
    // records, so fall through rather than giving up on the first miss.
    let map_version = rel_one(resource, "mapVersion").and_then(|key| index.get(&key).copied());
    let map_folder_name = map_version
        .map(|version| {
            let folder = value_string(&version.attributes, "folderName");
            if !folder.is_empty() {
                return folder;
            }
            rel_one(version, "map")
                .and_then(|key| index.get(&key).copied())
                .map(|map| value_string(&map.attributes, "folderName"))
                .unwrap_or_default()
        })
        .unwrap_or_default();

    let description_html = value_string(attributes, "description");

    Some(Tutorial {
        id,
        title: value_string(attributes, "title"),
        description: to_plain_text(&description_html),
        // Read before the tags are stripped: for the video and written-guide
        // categories the link is the whole entry.
        link_url: first_link_url(&description_html),
        // `image` is a bare filename on some records; `imageUrl` is the
        // resolvable one, so it wins.
        image_url: {
            let url = value_string(attributes, "imageUrl");
            if url.is_empty() {
                value_string(attributes, "image")
            } else {
                url
            }
        },
        ordinal: value_i32(attributes, "ordinal").unwrap_or(0),
        launchable: value_bool(attributes, "launchable"),
        map_folder_name,
        technical_name: value_string(attributes, "technicalName"),
        category_id: None, // filled in by the caller
    })
}

/// Inert tutorials client: used offline and in tests.
#[derive(Debug, Clone, Default)]
pub struct FakeTutorials;

#[async_trait]
impl TutorialsPort for FakeTutorials {
    async fn list_tutorials(&self) -> Result<(Vec<TutorialCategory>, Vec<Tutorial>), String> {
        let tutorial = |id: i32, category_id: i32, ordinal: i32, title: &str| Tutorial {
            id,
            title: title.into(),
            description: "A short guided lesson.".into(),
            link_url: String::new(),
            image_url: String::new(),
            ordinal,
            launchable: true,
            map_folder_name: format!("scmp_tut_{id}"),
            technical_name: format!("tut_{id}"),
            category_id: Some(category_id),
        };
        Ok((
            vec![
                TutorialCategory {
                    id: 1,
                    name: "Basics".into(),
                },
                TutorialCategory {
                    id: 2,
                    name: "Economy".into(),
                },
            ],
            vec![
                tutorial(1, 1, 1, "Moving and selecting"),
                tutorial(2, 1, 2, "Your first factory"),
                tutorial(3, 2, 1, "Mass and energy"),
            ],
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A document shaped like the real nested response.
    fn document() -> crate::infra::jsonapi::JsonApiDoc {
        serde_json::from_value(json!({
            "data": [{
                "type": "tutorialCategory",
                "id": "1",
                "attributes": { "category": "Basics" },
                "relationships": { "tutorials": { "data": [
                    { "type": "tutorial", "id": "10" },
                    { "type": "tutorial", "id": "11" }
                ] } },
            }],
            "included": [
                {
                    "type": "tutorial", "id": "10",
                    "attributes": {
                        "title": "Moving", "description": "<p>Drag to select.</p>",
                        "ordinal": 1, "launchable": true, "technicalName": "tut_move",
                        "imageUrl": "https://content.example.invalid/tut_move.png",
                    },
                    "relationships": { "mapVersion": { "data": { "type": "mapVersion", "id": "50" } } },
                },
                {
                    "type": "tutorial", "id": "11",
                    "attributes": { "title": "Building", "ordinal": 2, "launchable": false },
                    "relationships": {},
                },
                {
                    "type": "mapVersion", "id": "50",
                    "attributes": { "folderName": "scmp_tut_move" },
                    "relationships": {},
                },
            ],
        }))
        .expect("valid document")
    }

    #[test]
    fn a_category_is_named_from_either_field() {
        let doc = document();
        assert_eq!(parse_category(&doc.data[0]).unwrap().name, "Basics");

        let fallback: JsonApiResource = serde_json::from_value(json!({
            "type": "tutorialCategory", "id": "2",
            "attributes": { "categoryKey": "tutorial.economy" },
            "relationships": {},
        }))
        .unwrap();
        assert_eq!(parse_category(&fallback).unwrap().name, "tutorial.economy");
    }

    #[test]
    fn a_tutorial_resolves_its_map_folder_through_the_map_version() {
        // Without the folder there is nothing to download, so this hop is the
        // difference between a playable lesson and a dead button.
        let doc = document();
        let index = document_index(&doc);
        let resource = index
            .get(&("tutorial".into(), "10".into()))
            .copied()
            .unwrap();

        let parsed = parse_tutorial(resource, &index).unwrap();
        assert_eq!(parsed.map_folder_name, "scmp_tut_move");
        assert_eq!(parsed.technical_name, "tut_move");
        assert_eq!(parsed.description, "Drag to select.", "markup stripped");
        assert_eq!(parsed.ordinal, 1);
        assert!(parsed.launchable);
        assert!(parsed.is_playable());
    }

    #[test]
    fn a_tutorial_without_a_map_is_listed_but_not_playable() {
        let doc = document();
        let index = document_index(&doc);
        let resource = index
            .get(&("tutorial".into(), "11".into()))
            .copied()
            .unwrap();

        let parsed = parse_tutorial(resource, &index).unwrap();
        assert_eq!(parsed.title, "Building");
        assert_eq!(parsed.map_folder_name, "");
        assert!(!parsed.is_playable());
    }

    #[test]
    fn the_map_folder_falls_through_to_the_linked_map() {
        // Some records carry the folder on the map rather than the version.
        let doc: crate::infra::jsonapi::JsonApiDoc = serde_json::from_value(json!({
            "data": [],
            "included": [
                {
                    "type": "tutorial", "id": "10",
                    "attributes": { "title": "T", "technicalName": "t", "launchable": true },
                    "relationships": { "mapVersion": { "data": { "type": "mapVersion", "id": "50" } } },
                },
                {
                    "type": "mapVersion", "id": "50", "attributes": {},
                    "relationships": { "map": { "data": { "type": "map", "id": "60" } } },
                },
                {
                    "type": "map", "id": "60",
                    "attributes": { "folderName": "scmp_tut_alt" }, "relationships": {},
                },
            ],
        }))
        .unwrap();
        let index = document_index(&doc);
        let resource = index
            .get(&("tutorial".into(), "10".into()))
            .copied()
            .unwrap();
        assert_eq!(
            parse_tutorial(resource, &index).unwrap().map_folder_name,
            "scmp_tut_alt"
        );
    }

    #[tokio::test]
    async fn the_fake_groups_lessons_under_their_categories() {
        let (categories, tutorials) = FakeTutorials.list_tutorials().await.unwrap();
        assert_eq!(categories.len(), 2);
        assert_eq!(faf_domain::state::tutorials_of(&tutorials, 1).len(), 2);
        assert_eq!(faf_domain::state::tutorials_of(&tutorials, 2).len(), 1);
    }
}
