//! A map's or mod's rating over every version it has had (issue 356).
//!
//! A review is written against a version, and each version has its own summary.
//! The subject's summary, `mod_reviews_summary` or `map_reviews_summary`, is a
//! table FAF's database refills every ten minutes by adding the versions' up
//! (the `mod_reviews_summary` event in FAForever/db). The vault cards read it,
//! and on the live API it is not there for mods that plainly have reviews: a
//! mod at v25 with 21 reviews across its versions showed "5.0 (2)", the latest
//! version's two, while its reviews panel listed all 21.
//!
//! So the client adds the versions up itself, the same sum the database event
//! makes: every version of the subjects on screen that has a review, with its
//! summary, in as few requests as the API's page size allows. A total only ever
//! raises what the listing said. When the subject's own summary is present and
//! current it is at least as large and stays; when it is stale or missing, the
//! sum replaces it.
//!
//! Best effort by design: the cards are already drawn from the listing, and a
//! failed request here leaves them as they were rather than failing the search.

use std::collections::HashMap;

use crate::infra::jsonapi::{
    fetch_all_pages, rel_target, resource_index, value_f64, value_i32, JsonApiDoc,
};

/// The API clamps a page to a hundred, whatever is asked for.
const PAGE_SIZE: usize = 100;
/// Pages per request for one screen of subjects: two thousand reviewed
/// versions, far more than a hundred subjects have between them.
const MAX_PAGES: u32 = 20;
/// Pages for the whole vault at once, which is what the background crawl of
/// every mod asks for: five thousand reviewed versions.
const MAX_PAGES_WHOLE_VAULT: u32 = 50;
/// Ids per request. A hundred small numbers keep the URL well inside what any
/// server accepts.
const IDS_PER_REQUEST: usize = 100;

/// Which vault a total is for: the version resource to ask, and the name of the
/// relationship from a version back to its subject.
#[derive(Clone, Copy, Debug)]
pub(crate) enum Subject {
    Map,
    Mod,
}

impl Subject {
    fn version_resource(self) -> &'static str {
        match self {
            Self::Map => "mapVersion",
            Self::Mod => "modVersion",
        }
    }

    fn parent_relationship(self) -> &'static str {
        match self {
            Self::Map => "map",
            Self::Mod => "mod",
        }
    }
}

/// Every version's reviews of one subject, added up.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct ReviewTotal {
    /// The sum of the stars given, which is what a summary's `score` is.
    pub(crate) score: f64,
    pub(crate) reviews: i32,
}

impl ReviewTotal {
    /// The average in tenths of a star, the way the vault cards carry it.
    pub(crate) fn rating_tenths(self) -> i32 {
        if self.reviews <= 0 {
            return 0;
        }
        (self.score / f64::from(self.reviews) * 10.0).round() as i32
    }

    /// Replace `rating_tenths` and `reviews` when this total counts more
    /// reviews than they do, and leave them alone otherwise.
    pub(crate) fn raise(self, rating_tenths: &mut i32, reviews: &mut i32) {
        if self.reviews > *reviews {
            *rating_tenths = self.rating_tenths();
            *reviews = self.reviews;
        }
    }
}

/// Fetch the totals for `subject_ids`, keyed by subject id.
pub(crate) async fn fetch(
    http: &reqwest::Client,
    token: &str,
    api_base: &str,
    subject: Subject,
    subject_ids: &[i32],
) -> Result<HashMap<i32, ReviewTotal>, String> {
    let mut totals = HashMap::new();
    for chunk in subject_ids.chunks(IDS_PER_REQUEST) {
        let ids = chunk
            .iter()
            .map(i32::to_string)
            .collect::<Vec<_>>()
            .join(",");
        let filter = format!("{}.id=in=({ids});{REVIEWED}", subject.parent_relationship());
        fetch_filtered(
            http,
            token,
            api_base,
            subject,
            &filter,
            MAX_PAGES,
            &mut totals,
        )
        .await?;
    }
    Ok(totals)
}

/// Fetch the totals for every subject in the vault that has a review, for the
/// crawls that list the whole vault rather than a page of it.
pub(crate) async fn fetch_whole_vault(
    http: &reqwest::Client,
    token: &str,
    api_base: &str,
    subject: Subject,
) -> Result<HashMap<i32, ReviewTotal>, String> {
    let mut totals = HashMap::new();
    fetch_filtered(
        http,
        token,
        api_base,
        subject,
        REVIEWED,
        MAX_PAGES_WHOLE_VAULT,
        &mut totals,
    )
    .await?;
    Ok(totals)
}

/// Only the versions somebody reviewed: most versions of most subjects have
/// none, and a version without a summary adds nothing.
const REVIEWED: &str = "reviewsSummary.reviews=gt=0";

async fn fetch_filtered(
    http: &reqwest::Client,
    token: &str,
    api_base: &str,
    subject: Subject,
    filter: &str,
    max_pages: u32,
    totals: &mut HashMap<i32, ReviewTotal>,
) -> Result<(), String> {
    let docs = fetch_all_pages(http, token, max_pages, PAGE_SIZE, |page| {
        let mut url = url::Url::parse(&format!("{api_base}/data/{}", subject.version_resource()))
            .map_err(|error| format!("invalid API base: {error}"))?;
        url.query_pairs_mut()
            .append_pair("filter", filter)
            .append_pair("include", "reviewsSummary")
            .append_pair("page[size]", &PAGE_SIZE.to_string())
            .append_pair("page[number]", &page.to_string())
            .append_key_only("page[totals]");
        Ok(url)
    })
    .await?;
    for doc in &docs {
        add_versions(doc, subject, totals);
    }
    Ok(())
}

/// Add every version in `doc` to its subject's total.
fn add_versions(doc: &JsonApiDoc, subject: Subject, totals: &mut HashMap<i32, ReviewTotal>) {
    let index = resource_index(&doc.included);
    for version in &doc.data {
        let Some(subject_id) = rel_target(&version.relationships, subject.parent_relationship())
            .and_then(|(_, id)| id.parse::<i32>().ok())
        else {
            continue;
        };
        // By type and id both: the summary and the version can share an id,
        // and a match on the id alone would read one as the other.
        let Some(summary) = rel_target(&version.relationships, "reviewsSummary")
            .and_then(|target| index.get(&target).copied())
        else {
            continue;
        };
        let reviews = value_i32(&summary.attributes, "reviews").unwrap_or(0);
        if reviews <= 0 {
            continue;
        }
        let Some(score) = value_f64(&summary.attributes, "score").or_else(|| {
            value_f64(&summary.attributes, "averageScore")
                .map(|average| average * f64::from(reviews))
        }) else {
            continue;
        };
        let total = totals.entry(subject_id).or_default();
        total.score += score;
        total.reviews = total.reviews.saturating_add(reviews);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(value: serde_json::Value) -> JsonApiDoc {
        serde_json::from_value(value).expect("valid document")
    }

    #[test]
    fn every_version_of_a_mod_adds_up_to_one_rating() {
        let doc = doc(serde_json::json!({
            "data": [
                {
                    "type": "modVersion", "id": "250",
                    "relationships": {
                        "mod": { "data": { "type": "mod", "id": "7" } },
                        "reviewsSummary": { "data": { "type": "modVersionReviewsSummary", "id": "250" } }
                    }
                },
                {
                    "type": "modVersion", "id": "180",
                    "relationships": {
                        "mod": { "data": { "type": "mod", "id": "7" } },
                        "reviewsSummary": { "data": { "type": "modVersionReviewsSummary", "id": "180" } }
                    }
                },
                {
                    "type": "modVersion", "id": "90",
                    "relationships": {
                        "mod": { "data": { "type": "mod", "id": "8" } },
                        "reviewsSummary": { "data": { "type": "modVersionReviewsSummary", "id": "90" } }
                    }
                }
            ],
            "included": [
                { "type": "modVersionReviewsSummary", "id": "250", "attributes": { "score": 10.0, "reviews": 2 } },
                { "type": "modVersionReviewsSummary", "id": "180", "attributes": { "score": 76.0, "reviews": 19 } },
                { "type": "modVersionReviewsSummary", "id": "90", "attributes": { "averageScore": 3.0, "reviews": 4 } }
            ]
        }));
        let mut totals = HashMap::new();
        add_versions(&doc, Subject::Mod, &mut totals);

        assert_eq!(
            totals[&7],
            ReviewTotal {
                score: 86.0,
                reviews: 21
            }
        );
        assert_eq!(totals[&7].rating_tenths(), 41);
        // A summary without a score is read from its average.
        assert_eq!(
            totals[&8],
            ReviewTotal {
                score: 12.0,
                reviews: 4
            }
        );
    }

    #[test]
    fn a_version_whose_summary_is_not_in_the_document_adds_nothing() {
        let doc = doc(serde_json::json!({
            "data": [{
                "type": "modVersion", "id": "5",
                "relationships": {
                    "mod": { "data": { "type": "mod", "id": "7" } },
                    "reviewsSummary": { "data": { "type": "modVersionReviewsSummary", "id": "5" } }
                }
            }],
            // Same id, different type: not the summary.
            "included": [{ "type": "modVersion", "id": "5", "attributes": { "reviews": 9, "score": 45.0 } }]
        }));
        let mut totals = HashMap::new();
        add_versions(&doc, Subject::Mod, &mut totals);
        assert!(totals.is_empty());
    }

    #[test]
    fn a_total_only_ever_raises_the_listing() {
        let total = ReviewTotal {
            score: 86.0,
            reviews: 21,
        };
        let (mut rating, mut reviews) = (50, 2);
        total.raise(&mut rating, &mut reviews);
        assert_eq!((rating, reviews), (41, 21));

        // The subject's own summary counted more: it stays.
        let (mut rating, mut reviews) = (45, 30);
        total.raise(&mut rating, &mut reviews);
        assert_eq!((rating, reviews), (45, 30));
    }
}
