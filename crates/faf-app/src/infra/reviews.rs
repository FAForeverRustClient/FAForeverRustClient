//! Vault reviews: the FAF Data API, read and write.
//!
//! Reads mirror the Java client's `ReviewService.getMapReviews`/`getModReviews`:
//! walk the subject's *versions* and collect the reviews hanging off each,
//! with the reviewer resolved.
//!
//! ```text
//! GET /data/{map|mod}/{id}/versions?include=reviews,reviews.player
//! ```
//!
//! Writes are the same shape Java uses, and are the only writes this client
//! makes anywhere:
//!
//! ```text
//! POST   /data/{map|mod}Version/{versionId}/reviews
//! PATCH  /data/{map|mod}VersionReview/{reviewId}
//! DELETE /data/{map|mod}VersionReview/{reviewId}
//! ```

use async_trait::async_trait;
use faf_domain::state::{clamp_score, Review, ReviewKind};
use serde_json::json;

use crate::infra::env_or;
use crate::infra::jsonapi::{
    delete_resource, document_index, fetch_document, patch_resource, post_resource, rel_one,
    rel_targets, value_i32, value_string, JsonApiResource, ResourceIndex,
};
use crate::infra::session::TokenStore;
use crate::ports::{ReviewPage, ReviewsPort};

#[derive(Debug, Clone)]
pub struct ReviewsConfig {
    pub api_base: String,
}

impl ReviewsConfig {
    pub fn faf() -> Self {
        Self {
            api_base: env_or("FAF_API_BASE", "https://api.faforever.com"),
        }
    }
}

pub struct ReviewsClient {
    config: ReviewsConfig,
    tokens: TokenStore,
    http: reqwest::Client,
}

impl ReviewsClient {
    pub fn new(config: ReviewsConfig, tokens: TokenStore) -> Self {
        Self {
            config,
            tokens,
            http: super::http::shared_http_client(),
        }
    }

    pub fn faf(tokens: TokenStore) -> Self {
        Self::new(ReviewsConfig::faf(), tokens)
    }

    fn token(&self) -> Result<String, String> {
        self.tokens.get().ok_or_else(|| "not logged in".to_string())
    }

    fn url(&self, path: &str) -> Result<url::Url, String> {
        url::Url::parse(&format!("{}/data/{path}", self.config.api_base))
            .map_err(|error| format!("invalid API base: {error}"))
    }
}

#[async_trait]
impl ReviewsPort for ReviewsClient {
    async fn list(&self, kind: ReviewKind, subject_id: i32) -> Result<ReviewPage, String> {
        let token = self.token()?;
        let mut url = self.url(&format!(
            "{}/{subject_id}/versions",
            kind.subject_resource()
        ))?;
        url.query_pairs_mut()
            .append_pair("include", "reviews,reviews.player")
            .append_pair("page[size]", "100");

        let doc = fetch_document(&self.http, url, &token).await?;
        let index = document_index(&doc);

        let mut reviews = Vec::new();
        let mut latest_version_id = None;
        let mut latest_version = i32::MIN;

        for version in &doc.data {
            let Ok(version_id) = version.id.parse::<i32>() else {
                continue;
            };
            let number = value_i32(&version.attributes, "version").unwrap_or(0);
            if number > latest_version || latest_version_id.is_none() {
                latest_version = number;
                latest_version_id = Some(version_id);
            }

            let label = number.to_string();
            for key in rel_targets(&version.relationships, "reviews") {
                let Some(resource) = index.get(&key).copied() else {
                    continue;
                };
                if let Some(review) = parse_review(resource, &index, &label) {
                    reviews.push(review);
                }
            }
        }

        Ok(ReviewPage {
            reviews,
            latest_version_id,
        })
    }

    async fn create(
        &self,
        kind: ReviewKind,
        version_id: i32,
        score: i32,
        text: String,
    ) -> Result<Review, String> {
        let token = self.token()?;
        // Posting to the version's own reviews collection is what associates
        // the two: the body carries no relationship of its own, matching
        // Java, which nulls the subject before sending.
        let url = self.url(&format!("{}/{version_id}/reviews", kind.version_resource()))?;

        let doc = post_resource(
            &self.http,
            url,
            &token,
            kind.review_resource(),
            json!({ "score": clamp_score(score), "text": text }),
        )
        .await?;

        // The echoed document is the created review, but it carries no player
        // relationship: the caller re-reads the list anyway, so a best-effort
        // shape is enough here.
        let index = document_index(&doc);
        doc.data
            .first()
            .and_then(|resource| parse_review(resource, &index, ""))
            .ok_or_else(|| "the server accepted the review but did not return it".to_string())
    }

    async fn update(
        &self,
        kind: ReviewKind,
        review_id: i32,
        score: i32,
        text: String,
    ) -> Result<(), String> {
        let token = self.token()?;
        let url = self.url(&format!("{}/{review_id}", kind.review_resource()))?;
        patch_resource(
            &self.http,
            url,
            &token,
            kind.review_resource(),
            &review_id.to_string(),
            json!({ "score": clamp_score(score), "text": text }),
        )
        .await
    }

    async fn delete(&self, kind: ReviewKind, review_id: i32) -> Result<(), String> {
        let token = self.token()?;
        let url = self.url(&format!("{}/{review_id}", kind.review_resource()))?;
        delete_resource(&self.http, url, &token).await
    }
}

fn parse_review(
    resource: &JsonApiResource,
    index: &ResourceIndex<'_>,
    version: &str,
) -> Option<Review> {
    let id = resource.id.parse::<i32>().ok()?;
    let attributes = &resource.attributes;
    Some(Review {
        id,
        score: value_i32(attributes, "score").unwrap_or(0),
        // Deliberately *not* stripped as HTML: review text is plain prose that
        // the UI renders as text, so `<3` must survive as typed rather than
        // being read as a tag and swallowed.
        text: value_string(attributes, "text"),
        player: rel_one(resource, "player")
            .and_then(|key| index.get(&key).copied())
            .map(|player| value_string(&player.attributes, "login"))
            .unwrap_or_default(),
        version: version.to_string(),
    })
}

/// Inert reviews client: used offline and in tests. Reads serve a small
/// sample; writes succeed without leaving the machine.
#[derive(Debug, Default)]
pub struct FakeReviews {
    /// Lets the offline UI show a write actually landing.
    written: std::sync::Mutex<Vec<Review>>,
}

#[async_trait]
impl ReviewsPort for FakeReviews {
    async fn list(&self, _kind: ReviewKind, _subject_id: i32) -> Result<ReviewPage, String> {
        let mut reviews = vec![
            Review {
                id: 1,
                score: 5,
                text: "Still the best 8-player map in the vault.".into(),
                player: "Ada".into(),
                version: "3".into(),
            },
            Review {
                id: 2,
                score: 3,
                text: "Fine, but the reclaim is unbalanced.".into(),
                player: "Bob".into(),
                version: "2".into(),
            },
        ];
        reviews.extend(self.written.lock().unwrap().iter().cloned());
        Ok(ReviewPage {
            reviews,
            latest_version_id: Some(30),
        })
    }

    async fn create(
        &self,
        _kind: ReviewKind,
        _version_id: i32,
        score: i32,
        text: String,
    ) -> Result<Review, String> {
        let review = Review {
            id: 999,
            score: clamp_score(score),
            text,
            player: "You".into(),
            version: "3".into(),
        };
        self.written.lock().unwrap().push(review.clone());
        Ok(review)
    }

    async fn update(
        &self,
        _kind: ReviewKind,
        review_id: i32,
        score: i32,
        text: String,
    ) -> Result<(), String> {
        let mut written = self.written.lock().unwrap();
        if let Some(review) = written.iter_mut().find(|review| review.id == review_id) {
            review.score = clamp_score(score);
            review.text = text;
        }
        Ok(())
    }

    async fn delete(&self, _kind: ReviewKind, review_id: i32) -> Result<(), String> {
        self.written
            .lock()
            .unwrap()
            .retain(|review| review.id != review_id);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infra::jsonapi::{api_error_detail, JsonApiDoc};

    fn versions_document() -> JsonApiDoc {
        serde_json::from_value(json!({
            "data": [
                {
                    "type": "mapVersion", "id": "30",
                    "attributes": { "version": 3 },
                    "relationships": { "reviews": { "data": [
                        { "type": "mapVersionReview", "id": "1" }
                    ] } },
                },
                {
                    "type": "mapVersion", "id": "20",
                    "attributes": { "version": 2 },
                    "relationships": { "reviews": { "data": [
                        { "type": "mapVersionReview", "id": "2" }
                    ] } },
                },
            ],
            "included": [
                {
                    "type": "mapVersionReview", "id": "1",
                    "attributes": { "score": 5, "text": "Great" },
                    "relationships": { "player": { "data": { "type": "player", "id": "7" } } },
                },
                {
                    "type": "mapVersionReview", "id": "2",
                    "attributes": { "score": 2, "text": "Reclaim is <3 mass" },
                    "relationships": {},
                },
                { "type": "player", "id": "7", "attributes": { "login": "Ada" }, "relationships": {} },
            ],
        }))
        .expect("valid document")
    }

    #[test]
    fn a_review_resolves_its_author_and_keeps_its_text_verbatim() {
        let doc = versions_document();
        let index = document_index(&doc);
        let resource = index
            .get(&("mapVersionReview".into(), "1".into()))
            .copied()
            .unwrap();

        let parsed = parse_review(resource, &index, "3").unwrap();
        assert_eq!(parsed.score, 5);
        assert_eq!(parsed.text, "Great");
        assert_eq!(parsed.player, "Ada");
        assert_eq!(parsed.version, "3");
    }

    #[test]
    fn review_text_is_never_stripped_as_markup() {
        // Unlike a tournament or mission description, review text is prose the
        // UI renders as text. Stripping would eat "<3" and "rating < 1500".
        let doc = versions_document();
        let index = document_index(&doc);
        let resource = index
            .get(&("mapVersionReview".into(), "2".into()))
            .copied()
            .unwrap();

        let parsed = parse_review(resource, &index, "2").unwrap();
        assert_eq!(parsed.text, "Reclaim is <3 mass");
        assert_eq!(parsed.player, "", "no player relationship is not fatal");
    }

    #[test]
    fn an_api_error_document_yields_its_own_wording() {
        // "You have already submitted a review" beats "422".
        let body = r#"{"errors":[{"detail":"You have already reviewed this map."}]}"#;
        assert_eq!(
            api_error_detail(body).as_deref(),
            Some("You have already reviewed this map.")
        );

        let multiple = r#"{"errors":[{"detail":"a"},{"title":"b"}]}"#;
        assert_eq!(api_error_detail(multiple).as_deref(), Some("a; b"));
    }

    #[test]
    fn a_non_json_api_error_body_falls_back_to_the_status() {
        assert_eq!(api_error_detail("<html>502</html>"), None);
        assert_eq!(api_error_detail("{}"), None);
        assert_eq!(api_error_detail(r#"{"errors":[]}"#), None);
    }

    #[test]
    fn the_write_urls_match_the_apis_two_families() {
        let client = ReviewsClient::new(
            ReviewsConfig {
                api_base: "https://api.example.invalid".into(),
            },
            TokenStore::new(),
        );

        // A new review is posted against the *version*; an edit addresses the
        // review itself.
        assert_eq!(
            client
                .url(&format!(
                    "{}/30/reviews",
                    ReviewKind::Map.version_resource()
                ))
                .unwrap()
                .as_str(),
            "https://api.example.invalid/data/mapVersion/30/reviews"
        );
        assert_eq!(
            client
                .url(&format!("{}/5", ReviewKind::Mod.review_resource()))
                .unwrap()
                .as_str(),
            "https://api.example.invalid/data/modVersionReview/5"
        );
    }

    #[tokio::test]
    async fn the_fake_reflects_a_write_back_into_the_list() {
        // So the panel can be exercised offline without every write vanishing.
        let fake = FakeReviews::default();
        let before = fake.list(ReviewKind::Map, 1).await.unwrap().reviews.len();

        let created = fake
            .create(ReviewKind::Map, 30, 9, "Too good".into())
            .await
            .unwrap();
        assert_eq!(created.score, 5, "clamped to the API's range");

        let after = fake.list(ReviewKind::Map, 1).await.unwrap();
        assert_eq!(after.reviews.len(), before + 1);

        fake.delete(ReviewKind::Map, created.id).await.unwrap();
        assert_eq!(
            fake.list(ReviewKind::Map, 1).await.unwrap().reviews.len(),
            before
        );
    }

    #[tokio::test]
    async fn the_latest_version_is_what_a_new_review_targets() {
        let doc = versions_document();
        // Highest `version` wins regardless of document order: the API does
        // not promise one.
        let mut latest_id = None;
        let mut latest = i32::MIN;
        for version in &doc.data {
            let number = value_i32(&version.attributes, "version").unwrap_or(0);
            if number > latest {
                latest = number;
                latest_id = version.id.parse::<i32>().ok();
            }
        }
        assert_eq!(latest_id, Some(30));
    }
}
