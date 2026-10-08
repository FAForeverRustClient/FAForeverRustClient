// Which entries are parts of one thing.
//
// A player browsing the library thinks of "Road to Grandmaster" as one series
// and arma473's ladder guide as one guide, not as thirteen videos and six
// pages. Shown one card per part, those two alone were a fifth of the library
// and pushed everything else off the first screen. So a series is one card on
// the shelf and its parts are listed where it is opened.
//
// Read off the catalogue rather than declared in it, the same way the video
// player's queue is: nothing for a curator to keep in step, and a new episode
// joins its series the day it is catalogued.
//
//   PLAYLIST  videos sharing a YouTube playlist. Never build orders: each of
//             those is about its own map, and a shelf of maps is exactly what
//             a player scans for the one they are about to play.
//   HUB       an entry whose `related` names two or more entries that each
//             name nothing but it back: an index and its parts, which is how
//             the catalogue already links arma473's guide and the Ultimate
//             Seton's Guide.

import type { TrainingKind, TrainingResource } from "../../ipc/bindings";
import { playlistId } from "./trainingPresentation";

export interface Series {
  /** The entry the series opens on, and whose picture its card shows. */
  head: TrainingResource;
  /** Every part in reading order, the head first. */
  parts: TrainingResource[];
  /** What the parts have in common, or the head's title when nothing is. */
  title: string;
  /** Episodes of a video, or parts of a text. */
  unit: "episodes" | "parts";
}

/** The kinds a playlist makes a series of. */
const WATCHED: TrainingKind[] = ["video", "replayAnalysis"];

/**
 * The words every title starts with, when they say something.
 *
 * "Road to Grandmaster: introduction" and "Road to Grandmaster, episode 1"
 * share "Road to Grandmaster", which is the series' name. Cut back to a word
 * boundary and stripped of the punctuation that joined it to the rest; under
 * six characters it is a coincidence rather than a name.
 */
function sharedTitle(titles: string[]): string {
  if (titles.length === 0) return "";
  let prefix = titles[0];
  for (const title of titles.slice(1)) {
    let length = 0;
    while (length < prefix.length && length < title.length && prefix[length] === title[length]) {
      length += 1;
    }
    prefix = prefix.slice(0, length);
  }
  // Back to the last whole word: a shared "Seton's: the " must not become a
  // name ending in half a word.
  if (titles.some((title) => title.length > prefix.length && /\w/.test(title[prefix.length]))) {
    prefix = prefix.replace(/\s*\S*$/, "");
  }
  const name = prefix.replace(/[\s,:;.\-]+$/, "").trim();
  return name.length >= 6 ? name : "";
}

function makeSeries(parts: TrainingResource[], unit: Series["unit"]): Series {
  const head = parts[0];
  return { head, parts, title: sharedTitle(parts.map((part) => part.title)) || head.title, unit };
}

/** Every series in the catalogue, keyed by the id of each of its parts. */
export function seriesIndex(resources: TrainingResource[]): Map<string, Series> {
  const index = new Map<string, Series>();
  const byId = new Map(resources.map((resource) => [resource.id, resource]));

  const playlists = new Map<string, TrainingResource[]>();
  for (const resource of resources) {
    if (!WATCHED.includes(resource.kind)) continue;
    const list = playlistId(resource.url);
    if (!list) continue;
    playlists.set(list, [...(playlists.get(list) ?? []), resource]);
  }
  for (const parts of playlists.values()) {
    if (parts.length < 2) continue;
    const series = makeSeries(parts, "episodes");
    for (const part of parts) index.set(part.id, series);
  }

  for (const hub of resources) {
    if (index.has(hub.id)) continue;
    const parts = hub.related
      .map((id) => byId.get(id))
      .filter(
        (part): part is TrainingResource =>
          part !== undefined &&
          part.kind === hub.kind &&
          !index.has(part.id) &&
          part.related.length === 1 &&
          part.related[0] === hub.id,
      );
    if (parts.length < 2) continue;
    const series = makeSeries([hub, ...parts], WATCHED.includes(hub.kind) ? "episodes" : "parts");
    for (const part of series.parts) index.set(part.id, series);
  }
  return index;
}

/**
 * A part's name inside its series: the title with the series' own name taken
 * off the front, so a list of parts reads "Part 1: a strong start" rather than
 * repeating "Ladder 1v1" six times.
 */
export function partTitle(series: Series, part: TrainingResource): string {
  if (series.title === part.title || !part.title.startsWith(series.title)) return part.title;
  const rest = part.title.slice(series.title.length).replace(/^[\s,:;.\-]+/, "");
  return rest ? rest[0].toUpperCase() + rest.slice(1) : part.title;
}

/**
 * The shelf with each series folded into its head.
 *
 * Parts are dropped wherever they stand and the head keeps its place; a
 * series whose head did not survive the filter is represented by its first
 * part that did, so folding never hides something the filter found.
 */
export function foldSeries(
  entries: TrainingResource[],
  index: Map<string, Series>,
): TrainingResource[] {
  const shown = new Set<Series>();
  const out: TrainingResource[] = [];
  for (const entry of entries) {
    const series = index.get(entry.id);
    if (!series) {
      out.push(entry);
      continue;
    }
    if (shown.has(series)) continue;
    shown.add(series);
    out.push(entry);
  }
  return out;
}
