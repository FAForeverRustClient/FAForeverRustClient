// Twins of the training hub's per-keystroke rules
// (`faf_domain::state::training`), pinned by the `trainingFilters` and
// `trainingFormProblems` cases in the conformance fixture.
//
// Two kinds live here, and they have the same excuse: the library filter runs
// on every character typed into the search box, and the form validators decide
// on every keystroke whether the submit button is enabled. A round trip for
// either would make the tab feel like the network.
//
// Everything that is not per-keystroke stays in Rust and arrives through the
// slice: which resources are recommended and in what order, and the composed
// text of a post.

import type {
  ContributionDraft,
  ContributionProblem,
  ReviewProblem,
  ReviewRequestDraft,
  TrainingLevel,
  TrainingProfile,
  TrainingQuery,
  TrainingResource,
} from "../ipc/bindings";

/** Twin of `TrainingLevel::implied_band`. */
export function impliedBand(level: TrainingLevel): [number | null, number | null] {
  switch (level) {
    case "beginner":
      return [null, 1000];
    case "intermediate":
      return [800, 1600];
    case "advanced":
      return [1400, null];
  }
}

/** Twin of `TrainingResource::band`: stated numbers win over the level's. */
export function resourceBand(resource: TrainingResource): [number | null, number | null] {
  if (resource.ratingMin !== null || resource.ratingMax !== null) {
    return [resource.ratingMin, resource.ratingMax];
  }
  return resource.level ? impliedBand(resource.level) : [null, null];
}

/**
 * Twin of `within_band`: whether `rating` falls inside `[min, max]`.
 *
 * An unstated bound is open, and a band with neither bound is everyone's.
 * Shared by resources and trainers, exactly as in Rust, so a card and a tile
 * cannot disagree about what a range means.
 */
export function withinBand(
  min: number | null,
  max: number | null,
  rating: number,
): boolean {
  return (min === null || rating >= min) && (max === null || rating <= max);
}

/** Twin of `TrainingResource::covers_rating`. */
export function coversRating(resource: TrainingResource, rating: number): boolean {
  const [min, max] = resourceBand(resource);
  return withinBand(min, max, rating);
}

/** Twin of `normalise_map`: fold case, drop punctuation and the folder prefix. */
export function normaliseMap(map: string): string {
  const folded = map.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const prefix of ["scmp", "x1mp"]) {
    if (folded.startsWith(prefix)) return folded.slice(prefix.length);
  }
  return folded;
}

/** Twin of `TrainingResource::covers_map`: an entry naming no map matches any. */
export function coversMap(resource: TrainingResource, map: string): boolean {
  const wanted = normaliseMap(map);
  if (wanted === "" || resource.maps.length === 0) return true;
  return resource.maps.some((mine) => {
    const folded = normaliseMap(mine);
    return folded !== "" && (folded.includes(wanted) || wanted.includes(folded));
  });
}

/** Twin of `TrainingResource::covers_mode`. */
export function coversMode(resource: TrainingResource, mode: string): boolean {
  if (mode === "" || resource.gameModes.length === 0) return true;
  return resource.gameModes.some((mine) => mine.toLowerCase() === mode.toLowerCase());
}

/** Twin of `TrainingResource::matches_text`, with `needle` already lowercased. */
export function matchesText(resource: TrainingResource, needle: string): boolean {
  if (needle === "") return true;
  const prose = [resource.title, resource.summary, resource.author];
  if (prose.some((text) => text.toLowerCase().includes(needle))) return true;
  return [...resource.maps, ...resource.gameModes].some((tag) =>
    tag.toLowerCase().includes(needle),
  );
}

/**
 * Twin of `filter_resources`. Catalogue order, so narrowing a filter narrows
 * the list rather than reshuffling it.
 */
/**
 * Twin of `TrainingProfile::rating_for`: the rating to judge one entry by.
 *
 * FAF keeps five ratings, and which one applies depends on the entry. A 1v1
 * guide written for 1000 to 1400 is exactly right for somebody who is 1800
 * global and 1200 in the ladder; judging it by the headline number hides it
 * from the reader it was written for. An entry that names no mode is about the
 * game, so the overall rating is the honest answer for it.
 */
export function ratingFor(
  profile: TrainingProfile,
  resource: TrainingResource,
): number | null {
  for (const mode of resource.gameModes) {
    const rating = profile.ratings[mode];
    if (rating !== undefined) return rating;
  }
  return profile.rating;
}

export function filterResources(
  resources: TrainingResource[],
  query: TrainingQuery,
  profile: TrainingProfile,
): TrainingResource[] {
  const needle = query.text.trim().toLowerCase();
  return resources.filter(
    (resource) =>
      matchesText(resource, needle) &&
      (query.level === null || resource.level === query.level) &&
      (query.kind === null || resource.kind === query.kind) &&
      (query.topic === null || resource.topics.includes(query.topic)) &&
      coversMode(resource, query.gameMode.trim()) &&
      coversMap(resource, query.map.trim()) &&
      (!query.myRatingOnly ||
        ratingFor(profile, resource) === null ||
        coversRating(resource, ratingFor(profile, resource) as number)),
  );
}

/** Twin of `related_resources`: ids that no longer resolve are dropped. */
export function relatedResources(
  resources: TrainingResource[],
  resource: TrainingResource,
): TrainingResource[] {
  return resource.related
    .map((id) => resources.find((other) => other.id === id))
    .filter((other): other is TrainingResource => other !== undefined);
}

/** The resources the hub's rail names, in the order Rust ranked them. */
export function recommendedResources(
  resources: TrainingResource[],
  recommended: string[],
): TrainingResource[] {
  return recommended
    .map((id) => resources.find((resource) => resource.id === id))
    .filter((resource): resource is TrainingResource => resource !== undefined);
}

/**
 * Twin of `review_problem`: why a review request cannot be posted yet.
 *
 * Both conditions are the difference between a request someone can answer and
 * one that sits there, which is why the form refuses rather than posting a
 * half-written question.
 */
export function reviewProblem(draft: ReviewRequestDraft): ReviewProblem | null {
  if (
    draft.replayId === null &&
    draft.replayLink.trim() === "" &&
    draft.replayFile.trim() === ""
  ) {
    return "noReplay";
  }
  if (draft.goal.trim() === "") return "noGoal";
  return null;
}

/** Twin of `contribution_problem`. */
export function contributionProblem(draft: ContributionDraft): ContributionProblem | null {
  if (draft.title.trim() === "") return "noTitle";
  const url = draft.url.trim();
  if (url !== "" && !looksLikeHttps(url)) return "badUrl";
  if (url === "" && draft.body.trim() === "") return "noContent";
  return null;
}

/**
 * Twin of `looks_like_https`: a shape test, not a parser.
 *
 * It rejects the mistake people actually make, which is pasting something that
 * is not a link at all. Whether a link resolves is not knowable here.
 */
export function looksLikeHttps(url: string): boolean {
  if (!url.startsWith("https://")) return false;
  const rest = url.slice("https://".length);
  return rest !== "" && !rest.startsWith("/") && rest.includes(".") && !rest.includes(" ");
}
