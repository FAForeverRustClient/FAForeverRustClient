//! Vault reviews: the community's rating and comments on a map or mod.
//!
//! Until now the client showed a review *average* and nothing else. Both
//! reference clients show the reviews themselves, the score distribution, and
//! let you write your own: Java's `vault/review/` (`ReviewService`,
//! `ReviewsController`, `StarsController`) and the Python client's
//! `vaults/reviewwidget.py` (`RatingDistribution`, `CommentWidget`).
//!
//! This is also the client's first *write* path: every other API client in
//! the project is read-only.

use serde::{Deserialize, Serialize};
use specta::Type;

/// Scores are whole stars, one to five. The API rejects anything else, and
/// both reference clients present exactly five stars.
pub const MIN_SCORE: i32 = 1;
pub const MAX_SCORE: i32 = 5;

/// What is being reviewed. Maps and mods have separate API resources with
/// identical shapes, so the kind travels with the id rather than forking every
/// type in this module.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ReviewKind {
    Map,
    Mod,
}

impl ReviewKind {
    /// The JSON:API resource type for a review of this kind.
    pub fn review_resource(&self) -> &'static str {
        match self {
            Self::Map => "mapVersionReview",
            Self::Mod => "modVersionReview",
        }
    }

    /// The resource owning the reviews: a *version*, not the map or mod.
    pub fn version_resource(&self) -> &'static str {
        match self {
            Self::Map => "mapVersion",
            Self::Mod => "modVersion",
        }
    }

    /// The top-level resource, whose versions carry the reviews.
    pub fn subject_resource(&self) -> &'static str {
        match self {
            Self::Map => "map",
            Self::Mod => "mod",
        }
    }
}

/// Which map or mod's reviews are open.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReviewTarget {
    pub kind: ReviewKind,
    pub id: i32,
    /// Shown in the panel heading so it can open before the reviews arrive.
    pub name: String,
}

/// One person's review.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub id: i32,
    /// 1–5.
    pub score: i32,
    pub text: String,
    /// The reviewer's login. Empty when the API did not resolve the player.
    pub player: String,
    /// Which version of the map or mod was reviewed: a two-year-old review of
    /// version 1 says little about version 9.
    pub version: String,
}

/// The score distribution, as both reference clients present it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReviewSummary {
    pub total: i32,
    /// Mean score in tenths: `43` is 4.3 stars.
    ///
    /// An integer rather than a float because specta cannot express a plain
    /// `f32` across the IPC boundary (it becomes `number | null`, since JSON
    /// has no NaN), and because the codebase already carries averages this way
    ///: see `VaultMap::rating_tenths`. Zero when nothing has been reviewed.
    pub average_tenths: i32,
    /// How many reviews gave each score, indexed one star to five.
    pub counts: Vec<i32>,
}

impl Default for ReviewSummary {
    fn default() -> Self {
        Self {
            total: 0,
            average_tenths: 0,
            // Not the derived empty `Vec`. `summarize` always emits one bucket
            // per score, so a differently-sized `counts` was a shape that
            // existed *only* in the default: and the frontend's initial state
            // already assumed five. One length, everywhere.
            counts: vec![0; (MAX_SCORE - MIN_SCORE + 1) as usize],
        }
    }
}

impl ReviewSummary {
    /// Share of reviews at `score`, 0–100. Zero when nobody has reviewed,
    /// mirrors `RatingDistribution.get_percentage`, which guards the same
    /// division.
    pub fn percentage(&self, score: i32) -> f32 {
        let count = self.count(score);
        if self.total == 0 {
            return 0.0;
        }
        (count as f32 / self.total as f32) * 100.0
    }

    pub fn count(&self, score: i32) -> i32 {
        if !(MIN_SCORE..=MAX_SCORE).contains(&score) {
            return 0;
        }
        self.counts
            .get((score - MIN_SCORE) as usize)
            .copied()
            .unwrap_or(0)
    }
}

/// Build the distribution from the reviews themselves.
///
/// Derived rather than taken from the API's own summary: the client already
/// has every review in hand, and computing it here means the histogram cannot
/// disagree with the list under it after someone posts or deletes one.
pub fn summarize(reviews: &[Review]) -> ReviewSummary {
    let mut counts = vec![0; (MAX_SCORE - MIN_SCORE + 1) as usize];
    let mut total = 0;
    let mut sum = 0;
    for review in reviews {
        // A score outside the range is a server-side surprise; count it in the
        // total and the average, but it has no bar to occupy.
        if let Some(slot) = counts.get_mut((review.score - MIN_SCORE).max(0) as usize) {
            if (MIN_SCORE..=MAX_SCORE).contains(&review.score) {
                *slot += 1;
            }
        }
        total += 1;
        sum += review.score;
    }
    ReviewSummary {
        total,
        // Rounded to the nearest tenth, matching how the vault already
        // reports a rating.
        average_tenths: if total == 0 {
            0
        } else {
            ((sum as f32 / total as f32) * 10.0).round() as i32
        },
        counts,
    }
}

/// The signed-in player's own review, if they have written one.
///
/// Case-insensitive because logins round-trip through several systems and the
/// casing is not guaranteed to survive; matching exactly would silently offer
/// to write a second review.
pub fn own_review<'a>(reviews: &'a [Review], login: &str) -> Option<&'a Review> {
    if login.is_empty() {
        return None;
    }
    reviews
        .iter()
        .find(|review| review.player.eq_ignore_ascii_case(login))
}

/// Clamp a score into the range the API accepts.
pub fn clamp_score(score: i32) -> i32 {
    score.clamp(MIN_SCORE, MAX_SCORE)
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum ReviewsStatus {
    #[default]
    Idle,
    Loading,
    Ready,
    Failed {
        reason: String,
    },
}

/// Whether a write is in flight. Separate from the read status so a failed
/// submission does not blank the list the user is looking at.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum ReviewSubmitStatus {
    #[default]
    Idle,
    Saving,
    Saved,
    Failed {
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReviewsState {
    /// `None` when the panel is closed.
    pub target: Option<ReviewTarget>,
    pub reviews: Vec<Review>,
    pub summary: ReviewSummary,
    pub status: ReviewsStatus,
    pub submit: ReviewSubmitStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum ReviewsEvent {
    Opened {
        target: ReviewTarget,
    },
    Closed,
    Loading,
    Loaded {
        target: ReviewTarget,
        reviews: Vec<Review>,
    },
    LoadFailed {
        reason: String,
    },
    Saving,
    /// The write landed; `reviews` is the refreshed list.
    Saved {
        reviews: Vec<Review>,
    },
    SaveFailed {
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
pub enum ReviewsCommand {
    /// Open the panel for a map or mod and load its reviews.
    Open {
        target: ReviewTarget,
    },
    Close,
    /// Write or replace the signed-in player's review.
    Submit {
        score: i32,
        text: String,
    },
    /// Withdraw the signed-in player's review.
    Delete,
}

pub fn reduce(state: &mut ReviewsState, event: &ReviewsEvent) {
    match event {
        ReviewsEvent::Opened { target } => {
            // Clear rather than keep: showing the previous map's reviews under
            // this map's name for the length of a request is worse than an
            // empty panel.
            *state = ReviewsState {
                target: Some(target.clone()),
                ..ReviewsState::default()
            };
        }
        ReviewsEvent::Closed => *state = ReviewsState::default(),
        ReviewsEvent::Loading => state.status = ReviewsStatus::Loading,
        ReviewsEvent::Loaded { target, reviews } => {
            // Drop a reply for something the user has already navigated away
            // from.
            if state.target.as_ref() != Some(target) {
                return;
            }
            state.reviews = reviews.clone();
            state.summary = summarize(reviews);
            state.status = ReviewsStatus::Ready;
        }
        ReviewsEvent::LoadFailed { reason } => {
            state.status = ReviewsStatus::Failed {
                reason: reason.clone(),
            }
        }
        ReviewsEvent::Saving => state.submit = ReviewSubmitStatus::Saving,
        ReviewsEvent::Saved { reviews } => {
            state.reviews = reviews.clone();
            state.summary = summarize(reviews);
            state.submit = ReviewSubmitStatus::Saved;
            state.status = ReviewsStatus::Ready;
        }
        ReviewsEvent::SaveFailed { reason } => {
            state.submit = ReviewSubmitStatus::Failed {
                reason: reason.clone(),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn review(id: i32, score: i32, player: &str) -> Review {
        Review {
            id,
            score,
            text: String::new(),
            player: player.into(),
            version: "1".into(),
        }
    }

    fn target() -> ReviewTarget {
        ReviewTarget {
            kind: ReviewKind::Map,
            id: 42,
            name: "Seton's Clutch".into(),
        }
    }

    #[test]
    fn a_distribution_counts_each_star_and_averages() {
        let summary = summarize(&[
            review(1, 5, "Ada"),
            review(2, 5, "Bob"),
            review(3, 3, "Cid"),
            review(4, 1, "Dee"),
        ]);
        assert_eq!(summary.total, 4);
        assert_eq!(summary.count(5), 2);
        assert_eq!(summary.count(3), 1);
        assert_eq!(summary.count(1), 1);
        assert_eq!(summary.count(2), 0);
        assert_eq!(summary.average_tenths, 35);
        assert_eq!(summary.percentage(5), 50.0);
    }

    #[test]
    fn an_unreviewed_subject_has_no_average_and_no_division_by_zero() {
        // The guard both reference clients have; without it the panel shows
        // NaN stars.
        let summary = summarize(&[]);
        assert_eq!(summary.total, 0);
        assert_eq!(summary.average_tenths, 0);
        assert_eq!(summary.percentage(5), 0.0);
        assert_eq!(summary.count(5), 0);
    }

    #[test]
    fn a_score_outside_the_range_still_counts_toward_the_total() {
        // A server-side surprise should not silently vanish from the count,
        // but it has no bar to occupy either.
        let summary = summarize(&[review(1, 5, "Ada"), review(2, 9, "Bob")]);
        assert_eq!(summary.total, 2);
        assert_eq!(summary.counts.iter().sum::<i32>(), 1, "only the valid one");
        assert_eq!(summary.count(9), 0);
        assert_eq!(summary.average_tenths, 70);
    }

    #[test]
    fn asking_for_an_impossible_star_is_zero_not_a_panic() {
        let summary = summarize(&[review(1, 5, "Ada")]);
        assert_eq!(summary.count(0), 0);
        assert_eq!(summary.count(6), 0);
        assert_eq!(summary.count(-1), 0);
    }

    #[test]
    fn your_own_review_is_found_regardless_of_login_casing() {
        // Logins round-trip through the lobby, IRC and the API; matching
        // exactly would offer to write a second review.
        let reviews = [review(1, 5, "Ada"), review(2, 3, "Bob")];
        assert_eq!(own_review(&reviews, "ada").map(|r| r.id), Some(1));
        assert_eq!(own_review(&reviews, "ADA").map(|r| r.id), Some(1));
        assert_eq!(own_review(&reviews, "Cid"), None);
        assert_eq!(own_review(&reviews, ""), None, "not signed in");
    }

    #[test]
    fn scores_are_clamped_to_the_range_the_api_accepts() {
        assert_eq!(clamp_score(0), 1);
        assert_eq!(clamp_score(3), 3);
        assert_eq!(clamp_score(99), 5);
    }

    #[test]
    fn resource_names_match_the_apis_two_families() {
        assert_eq!(ReviewKind::Map.review_resource(), "mapVersionReview");
        assert_eq!(ReviewKind::Map.version_resource(), "mapVersion");
        assert_eq!(ReviewKind::Map.subject_resource(), "map");
        assert_eq!(ReviewKind::Mod.review_resource(), "modVersionReview");
        assert_eq!(ReviewKind::Mod.version_resource(), "modVersion");
        assert_eq!(ReviewKind::Mod.subject_resource(), "mod");
    }

    #[test]
    fn opening_a_subject_clears_the_previous_one() {
        let mut state = ReviewsState {
            target: Some(target()),
            reviews: vec![review(1, 5, "Ada")],
            summary: summarize(&[review(1, 5, "Ada")]),
            status: ReviewsStatus::Ready,
            submit: ReviewSubmitStatus::Saved,
        };

        let other = ReviewTarget {
            id: 43,
            name: "Astro Crater".into(),
            ..target()
        };
        reduce(
            &mut state,
            &ReviewsEvent::Opened {
                target: other.clone(),
            },
        );

        assert_eq!(state.target, Some(other));
        assert!(
            state.reviews.is_empty(),
            "no stale reviews under a new name"
        );
        assert_eq!(state.summary.total, 0);
        assert_eq!(state.status, ReviewsStatus::Idle);
        assert_eq!(state.submit, ReviewSubmitStatus::Idle);
    }

    #[test]
    fn a_reply_for_a_subject_we_left_is_dropped() {
        let mut state = ReviewsState::default();
        reduce(&mut state, &ReviewsEvent::Opened { target: target() });

        reduce(
            &mut state,
            &ReviewsEvent::Loaded {
                target: ReviewTarget { id: 99, ..target() },
                reviews: vec![review(1, 5, "Ada")],
            },
        );
        assert!(state.reviews.is_empty(), "wrong subject");

        reduce(
            &mut state,
            &ReviewsEvent::Loaded {
                target: target(),
                reviews: vec![review(1, 5, "Ada")],
            },
        );
        assert_eq!(state.reviews.len(), 1);
        assert_eq!(state.summary.average_tenths, 50);
    }

    #[test]
    fn saving_refreshes_the_list_and_the_histogram_together() {
        // The whole reason the summary is derived: after posting, the bars and
        // the list beneath them must agree.
        let mut state = ReviewsState::default();
        reduce(&mut state, &ReviewsEvent::Opened { target: target() });
        reduce(
            &mut state,
            &ReviewsEvent::Loaded {
                target: target(),
                reviews: vec![review(1, 5, "Ada")],
            },
        );

        reduce(&mut state, &ReviewsEvent::Saving);
        assert_eq!(state.submit, ReviewSubmitStatus::Saving);

        reduce(
            &mut state,
            &ReviewsEvent::Saved {
                reviews: vec![review(1, 5, "Ada"), review(2, 1, "Bob")],
            },
        );
        assert_eq!(state.reviews.len(), 2);
        assert_eq!(state.summary.total, 2);
        assert_eq!(state.summary.average_tenths, 30);
        assert_eq!(state.submit, ReviewSubmitStatus::Saved);
    }

    #[test]
    fn a_failed_save_keeps_the_reviews_on_screen() {
        let mut state = ReviewsState::default();
        reduce(&mut state, &ReviewsEvent::Opened { target: target() });
        reduce(
            &mut state,
            &ReviewsEvent::Loaded {
                target: target(),
                reviews: vec![review(1, 5, "Ada")],
            },
        );
        reduce(
            &mut state,
            &ReviewsEvent::SaveFailed {
                reason: "403".into(),
            },
        );

        assert_eq!(state.reviews.len(), 1, "the list survives a failed write");
        assert_eq!(state.status, ReviewsStatus::Ready);
        assert_eq!(
            state.submit,
            ReviewSubmitStatus::Failed {
                reason: "403".into()
            }
        );
    }

    #[test]
    fn closing_resets_everything() {
        let mut state = ReviewsState {
            target: Some(target()),
            reviews: vec![review(1, 5, "Ada")],
            ..ReviewsState::default()
        };
        reduce(&mut state, &ReviewsEvent::Closed);
        assert_eq!(state, ReviewsState::default());
    }
}
