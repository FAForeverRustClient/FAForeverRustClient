import type { Review, ReviewsEvent, ReviewsState, ReviewSummary } from "../../ipc/bindings";

const EMPTY_SUMMARY: ReviewSummary = { total: 0, averageTenths: 0, counts: [0, 0, 0, 0, 0] };

const EMPTY: ReviewsState = {
  target: null,
  reviews: [],
  summary: EMPTY_SUMMARY,
  status: { type: "idle" },
  submit: { type: "idle" },
};

/** Twin of `faf_domain::state::reviews::summarize`. */
export function summarize(reviews: Review[]): ReviewSummary {
  const counts = [0, 0, 0, 0, 0];
  let sum = 0;
  for (const review of reviews) {
    // A score outside 1–5 is a server-side surprise: it counts toward the
    // total and the average, but has no bar to occupy.
    if (review.score >= 1 && review.score <= 5) counts[review.score - 1] += 1;
    sum += review.score;
  }
  return {
    total: reviews.length,
    // Rounded to the nearest tenth, as in the Rust twin.
    averageTenths: reviews.length === 0 ? 0 : Math.round((sum / reviews.length) * 10),
    counts,
  };
}

const sameTarget = (a: ReviewsState["target"], b: ReviewsState["target"]) =>
  a !== null && b !== null && a.kind === b.kind && a.id === b.id;

export function reduceReviews(state: ReviewsState, event: ReviewsEvent): ReviewsState {
  switch (event.type) {
    case "opened":
      // Clear rather than keep; the previous subject's reviews under this
      // subject's name is worse than an empty panel.
      return { ...EMPTY, target: event.payload.target };
    case "closed":
      return EMPTY;
    case "loading":
      return { ...state, status: { type: "loading" } };
    case "loaded": {
      if (!sameTarget(state.target, event.payload.target)) return state;
      return {
        ...state,
        reviews: event.payload.reviews,
        summary: summarize(event.payload.reviews),
        status: { type: "ready" },
      };
    }
    case "loadFailed":
      return { ...state, status: { type: "failed", payload: { reason: event.payload.reason } } };
    case "saving":
      return { ...state, submit: { type: "saving" } };
    case "saved":
      return {
        ...state,
        reviews: event.payload.reviews,
        summary: summarize(event.payload.reviews),
        submit: { type: "saved" },
        status: { type: "ready" },
      };
    case "saveFailed":
      return { ...state, submit: { type: "failed", payload: { reason: event.payload.reason } } };
  }
}
