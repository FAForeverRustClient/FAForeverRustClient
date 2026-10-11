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
// text of a post. The one exception is `recommendationReason`, which explains a
// card the slice already ranked; it reads the same terms as `score` so the
// sentence under a card cannot name a reason the ranking did not weigh.

import type {
  ContributionDraft,
  ContributionProblem,
  ReviewProblem,
  ReviewRequestDraft,
  TrainingLevel,
  TrainingProfile,
  TrainingQuery,
  TrainingResource,
} from "../../ipc/bindings";
import { OFFICIAL_BASE_MAPS } from "../mapPresentation";

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

/**
 * Rust's `str::eq_ignore_ascii_case` and `to_ascii_lowercase`: only A to Z fold.
 *
 * `toLowerCase` folds the whole of Unicode, which is not what the Rust side
 * does for modes and map names, and the two disagreed on input like the Kelvin
 * sign (which lowercases to an ASCII `k`).
 */
export function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/** Twin of `str::eq_ignore_ascii_case`. */
export function eqIgnoreAsciiCase(left: string, right: string): boolean {
  return left.length === right.length && asciiLower(left) === asciiLower(right);
}

/**
 * Twin of Rust's `str::trim`, which strips Unicode `White_Space`.
 *
 * Not `String.prototype.trim`: that one also strips U+FEFF and keeps U+0085,
 * so a pasted byte-order mark filtered differently on the two sides.
 */
export function rustTrim(text: string): string {
  let start = 0;
  let end = text.length;
  // Every member of the set is in the Basic Multilingual Plane, so code units
  // are code points here.
  while (start < end && isRustWhitespace(text.charCodeAt(start))) start += 1;
  while (end > start && isRustWhitespace(text.charCodeAt(end - 1))) end -= 1;
  return text.slice(start, end);
}

// Rust's `White_Space` set, by code point so nothing invisible sits in the source.
const RUST_WHITESPACE: [number, number][] = [
  [0x09, 0x0d],
  [0x20, 0x20],
  [0x85, 0x85],
  [0xa0, 0xa0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x2028, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
];
const isRustWhitespace = (code: number) =>
  RUST_WHITESPACE.some(([low, high]) => code >= low && code <= high);

/**
 * Twin of `OFFICIAL_MAPS`: the maps that ship with the game, by the folder a
 * replay names them by. Without it `scmp_009` never matched "Seton's Clutch".
 *
 * Read from the client's one table of them rather than a second copy: the
 * folders are the same 54 as Rust's, and only folded names are ever compared,
 * so the two tables' capitalisation cannot make the twins disagree.
 */
export const OFFICIAL_MAPS: [string, string][] = OFFICIAL_BASE_MAPS.map((map) => [
  map.folderName,
  map.displayName,
]);

/** Twin of `fold_map`: ASCII letters and digits only, in Rust's order. */
function foldMap(map: string): string {
  return asciiLower(map.replace(/[^A-Za-z0-9]/g, ""));
}

/** Twin of `official_map_name`. */
export function officialMapName(folder: string): string | null {
  const folded = foldMap(folder);
  if (folded === "") return null;
  return OFFICIAL_MAPS.find(([id]) => foldMap(id) === folded)?.[1] ?? null;
}

/**
 * Twin of `normalise_map`: an official map's folder becomes its name, then
 * drop everything but ASCII letters and digits, fold case, drop the folder
 * prefix. Filtered before folding, in Rust's order, so a non-ASCII letter that
 * lowercases to ASCII is still dropped.
 */
export function normaliseMap(map: string): string {
  const official = officialMapName(map);
  if (official !== null) return foldMap(official);
  const folded = foldMap(map);
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

/**
 * Twin of `leaderboard_word`: what the leaderboard calls a mode the catalogue
 * speaks in. A game outside the matchmaker is rated on `global`, which is not
 * the word anyone uses in a lobby, so the catalogue says `custom`.
 */
export function leaderboardWord(mode: string): string {
  return eqIgnoreAsciiCase(mode, "custom") ? "global" : mode;
}

/**
 * Twin of `TrainingResource::covers_mode`. ASCII case only, as in Rust, and
 * `custom` and `global` are the same mode in either direction.
 */
export function coversMode(resource: TrainingResource, mode: string): boolean {
  if (mode === "" || resource.gameModes.length === 0) return true;
  const wanted = leaderboardWord(mode);
  return resource.gameModes.some((mine) => eqIgnoreAsciiCase(leaderboardWord(mine), wanted));
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
  return ratingSource(profile, resource)?.rating ?? profile.rating;
}

/**
 * Which of the profile's per-mode ratings `ratingFor` used, when it used one.
 *
 * An exact key lookup, as `BTreeMap::get` is: "1V1" does not find a "1v1"
 * rating on either side. Own-property only, so a mode called `constructor`
 * does not find `Object.prototype`'s.
 */
function ratingSource(
  profile: TrainingProfile,
  resource: TrainingResource,
): { mode: string; rating: number } | null {
  for (const mode of resource.gameModes) {
    const key = leaderboardWord(mode);
    if (Object.prototype.hasOwnProperty.call(profile.ratings, key)) {
      const rating = profile.ratings[key];
      if (rating !== undefined) return { mode: key, rating };
    }
  }
  return null;
}

export function filterResources(
  resources: TrainingResource[],
  query: TrainingQuery,
  profile: TrainingProfile,
): TrainingResource[] {
  const needle = rustTrim(query.text).toLowerCase();
  return resources.filter(
    (resource) =>
      matchesText(resource, needle) &&
      (query.level === null || resource.level === query.level) &&
      (query.kind === null || resource.kind === query.kind) &&
      (query.topic === null || resource.topics.includes(query.topic)) &&
      coversMode(resource, rustTrim(query.gameMode)) &&
      coversMap(resource, rustTrim(query.map)) &&
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
 * Twin of `position_of`: the index in `mine` of the first entry `theirs`
 * claims. Modes compare exactly (ASCII case aside, and with no `custom` to
 * `global` mapping, as in Rust); maps compare through `normaliseMap`, loosely
 * in both directions.
 */
export function positionOf(
  mine: string[],
  theirs: string[],
  mode: "exact" | "map",
): number {
  if (theirs.length === 0) return -1;
  return mine.findIndex((ours) => theirs.some((other) => claims(ours, other, mode)));
}

function claims(ours: string, other: string, mode: "exact" | "map"): boolean {
  if (mode === "exact") return eqIgnoreAsciiCase(other, ours);
  const a = normaliseMap(ours);
  const b = normaliseMap(other);
  return a !== "" && b !== "" && (a.includes(b) || b.includes(a));
}

/**
 * Why a card is in the recommendation rail, in a form the player can check.
 *
 * `rating` names the mode whose rating was used, or `null` for the overall
 * one; `map` and `mode` carry the entry's own spelling, which is a name the
 * catalogue wrote for people rather than a folder id out of a replay header.
 */
export type RecommendationReason =
  | { type: "rating"; rating: number; mode: string | null }
  | { type: "map"; map: string }
  | { type: "mode"; mode: string };

/**
 * The single strongest overlap behind a recommendation, read off the same
 * terms `score` adds up, or `null` when none of them is one a player could
 * agree or disagree with.
 *
 * Each candidate carries the weight `score` gives it: a stated band that
 * covers the reader's rating (40), the newest matching map (30, less 4 per
 * place down the player's list, at most 20 off) and the newest matching mode
 * (18, less 4 per place, at most 12 off). The heaviest wins, and a tie goes to
 * the earlier of rating, map, mode. An open band (worth 5) and factions are
 * not offered: "fits everyone" explains nothing, and faction names have no
 * phrasing here yet.
 */
export function recommendationReason(
  resource: TrainingResource,
  profile: TrainingProfile,
): RecommendationReason | null {
  // In tie-break order: the first of two equal weights wins.
  const candidates: { weight: number; reason: RecommendationReason }[] = [];

  const rating = ratingFor(profile, resource);
  if (rating !== null) {
    const [min, max] = resourceBand(resource);
    if ((min !== null || max !== null) && coversRating(resource, rating)) {
      const mode = ratingSource(profile, resource)?.mode ?? null;
      candidates.push({ weight: 40, reason: { type: "rating", rating, mode } });
    }
  }

  const mapAt = positionOf(profile.maps, resource.maps, "map");
  if (mapAt >= 0) {
    const played = profile.maps[mapAt];
    const map = resource.maps.find((theirs) => claims(played, theirs, "map")) ?? played;
    candidates.push({ weight: 30 - Math.min(mapAt * 4, 20), reason: { type: "map", map } });
  }

  const modeAt = positionOf(profile.gameModes, resource.gameModes, "exact");
  if (modeAt >= 0) {
    const played = profile.gameModes[modeAt];
    const mode = resource.gameModes.find((theirs) => claims(played, theirs, "exact")) ?? played;
    candidates.push({ weight: 18 - Math.min(modeAt * 4, 12), reason: { type: "mode", mode } });
  }

  let best: { weight: number; reason: RecommendationReason } | null = null;
  for (const candidate of candidates) {
    if (best === null || candidate.weight > best.weight) best = candidate;
  }
  return best?.reason ?? null;
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
