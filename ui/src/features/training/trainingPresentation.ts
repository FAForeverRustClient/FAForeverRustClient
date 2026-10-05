// How the training hub words the catalogue's vocabulary.
//
// The domain has its own English labels (`kind_label` and friends) and they are
// deliberately not reused here: those go into a forum post read by whoever
// answers it, and they must not follow the client's language. These are the
// screen's labels, and they must.

import type { MessageKey } from "../../i18n";
import type { IconName } from "../../design-system/Icon";
import type {
  ContributionProblem,
  ReviewProblem,
  TrainingKind,
  TrainingLevel,
  TrainingResource,
  TrainingTopic,
} from "../../ipc/bindings";
import { resourceBand } from "../../shared/rules/trainingRules";
import {
  isGeneratedMapPlaceholderUrl,
  mapPresentation,
} from "../../shared/mapPresentation";
import type { VaultMap } from "../../ipc/bindings";

/** Every kind, in the order the filter offers them. Twin of `TrainingKind::ALL`. */
export const KINDS: TrainingKind[] = [
  "lesson",
  "video",
  "guide",
  "buildOrder",
  "replayAnalysis",
  "community",
];

/** Twin of `TrainingLevel::ALL`. */
export const LEVELS: TrainingLevel[] = ["beginner", "intermediate", "advanced"];

/** Twin of `TrainingTopic::ALL`. */
export const TOPICS: TrainingTopic[] = [
  "economy",
  "buildOrder",
  "micro",
  "strategy",
  "armyComposition",
  "mapControl",
  "scouting",
  "factions",
  "teamplay",
  "interface",
];

/** Twin of `TrainingTopic::BASICS`: the four the hub puts on its front page. */
export const BASIC_TOPICS: TrainingTopic[] = ["economy", "buildOrder", "micro", "mapControl"];

/**
 * The modes the mode filter offers.
 *
 * A mode is a matchmaker queue: "4v4" means the 4v4 queue, not any game with
 * eight players in it. Seton's Clutch is its own tag beside them rather than
 * a kind of 4v4, because it is a community format with its own slots, build
 * orders and meta, and a player looking for it is not looking for the queue.
 *
 * The catalogue's modes are still free text (a manifest can say `nomads`), so
 * this is a convenience list rather than the set of legal values. The filter
 * also accepts whatever the catalogue itself carries, which is where anything
 * not listed here comes from.
 */
export const COMMON_MODES = ["1v1", "2v2", "3v3", "4v4", "Seton's Clutch"];

/**
 * The embedded player for a video, when the address is one that can be.
 *
 * Presentation twin of `youtube_id`, kept here rather than asked of the
 * domain because the only thing it decides is what this pane draws. The
 * privacy-enhanced host is deliberate: it is the one the client's frame
 * policy allows, and it sets nothing until the reader presses play.
 *
 * `rel=0` keeps the end card to the same channel rather than offering
 * whatever YouTube would rather show next, which in a training tab is the
 * difference between finishing a build order and being handed an advert.
 */
/**
 * The address GitHub renders, for a raw one. Twin of
 * `HostedGuide::rendered_page`.
 *
 * The catalogue stores the raw address of a guide, because that is the one the
 * client fetches and renders itself. A reader who presses the button to open it
 * in a browser anyway must not be handed the same address: raw serves
 * `text/plain`, which is a build order as a wall of monospace. Anything that is
 * not a raw GitHub address is returned untouched, which is every other entry in
 * the library.
 */
export function renderedPage(url: string): string {
  const match =
    /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/.exec(url.trim());
  if (!match) return url;
  const [, owner, repo, reference, path] = match;
  return `https://github.com/${owner}/${repo}/blob/${reference}/${path}`;
}

export function videoEmbedUrl(url: string): string {
  const id = youtubeId(url);
  if (!id) return "";
  // The playlist travels with the video. A build order series is watched in
  // order, and without this the player treats each entry as a lone video: no
  // next, no queue, and the reader is back to the browser to find part two.
  const list = playlistId(url);
  const series = list ? `&list=${encodeURIComponent(list)}` : "";
  return `https://www.youtube-nocookie.com/embed/${id}?rel=0${series}`;
}

/**
 * The playlist an address belongs to, if it names one.
 *
 * What makes a series visible in the tab: two catalogue entries carrying the
 * same one are two parts of the same thing, and that is the whole of the
 * relationship. No key, no API call, and it stays true as entries are added,
 * which a hand-maintained list of siblings would not.
 */
export function playlistId(url: string): string {
  const match = /[?&]list=([A-Za-z0-9_-]+)/.exec(url.trim());
  return match ? match[1] : "";
}

/**
 * The still YouTube publishes for a video, derived from its id.
 *
 * Two thirds of the catalogue is a YouTube address and not one entry in it
 * carries a picture, so without this the library is a wall of empty tiles.
 * Nothing is fetched until a tile is near the viewport (`loading="lazy"` on
 * the card), but this is still the one place the tab reaches Google's servers
 * before the reader has pressed play, which the embedded player deliberately
 * does not.
 *
 * `mqdefault` and not `hqdefault`, which is the obvious choice and the wrong
 * one: it is a 4:3 image with the 16:9 frame letterboxed inside it, so every
 * card would carry a black bar top and bottom baked into the picture. This one
 * is 320x180, is the widest size YouTube guarantees exists for every video,
 * and is exactly the shape the tile is.
 */
export function videoThumbnailUrl(url: string): string {
  const id = youtubeId(url);
  return id ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : "";
}

/** The eleven-character id in a YouTube address, in the shapes people paste. */
function youtubeId(url: string): string {
  const match =
    /^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|embed\/|shorts\/)|youtu\.be\/)([^&?#/]+)/.exec(
      url.trim(),
    );
  const id = match?.[1] ?? "";
  // A fixed length and a fixed alphabet. Anything else is an address that
  // merely looked like one, and a guessed embed is a blank box on the page.
  return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : "";
}

/**
 * The real preview art for the first map an entry names, if it can be found.
 *
 * Resolved through the same vault index the lobby rows and the replay list
 * use, so a build order's card shows the map a player has actually seen, not
 * a picture somebody remembered to attach. The catalogue names maps the way a
 * player reads them, and that lookup already falls back to the base game's own
 * table, which is where Seton's Clutch and Syrtis Major come from.
 *
 * The generator placeholder is not a preview: an entry that resolved to it
 * found nothing, and saying so lets the caller fall back.
 */
export function mapPreviewUrl(vault: VaultMap[], maps: string[]): string {
  const name = maps.find((map) => map.trim() !== "");
  if (!name) return "";
  const { thumbnailUrl } = mapPresentation(vault, name);
  return isGeneratedMapPlaceholderUrl(thumbnailUrl) ? "" : thumbnailUrl;
}

/**
 * The map art an entry is about, at the size a tile or a run map wants.
 *
 * The catalogue's own picture first, when the entry is about one piece of
 * ground: a build order names its map the way a player reads it ("Setons
 * Clutch"), and that name can resolve to the wrong vault folder entirely. More
 * than one vault map is called Seton's, and the one the name finds is a yellow
 * remake rather than the map the build was played on. An `imageUrl` in the
 * catalogue is the exact preview of the folder the author's replays were
 * recorded on, so nothing has to guess.
 */
export function mapArtUrl(vault: VaultMap[], resource: TrainingResource): string {
  // The backend fills an empty `imageUrl` with the video's still, so a build
  // order on video carries one it never stated. That is a face cam, not ground.
  const stated = resource.imageUrl && !isVideoStill(resource.imageUrl) ? resource.imageUrl : "";
  if (stated && resource.maps.length > 0) return stated;
  return mapPreviewUrl(vault, resource.maps);
}

/** Whether an address is a still YouTube publishes for a video. */
function isVideoStill(url: string): boolean {
  return /^https:\/\/(?:img\.youtube\.com|i\.ytimg\.com)\/vi\//.test(url);
}

/**
 * Every picture a card could lead with, best first.
 *
 * A list rather than one address, because most of the library is a link to
 * somebody else's video or page and any one of these can be gone: the card
 * steps down the list as each fails, and lands on its drawn cover rather than
 * on the browser's broken-picture glyph.
 *
 * A build order shows its map and never a video frame, even when its address
 * is a video, which seven of them are: a still of somebody's face cam
 * identifies the author, which the caption already says, while the map is
 * what a reader recognises the entry by. Everything else leads with its own
 * picture, then the frame YouTube publishes for it. A map is not guessed for
 * those from the names they list: a channel that mostly plays Seton's is not a
 * picture of Seton's, and a guide that should carry its map says so with an
 * `imageUrl`.
 */
export function artCandidates(vault: VaultMap[], resource: TrainingResource): string[] {
  const ordered =
    resource.kind === "buildOrder"
      ? [mapArtUrl(vault, resource)]
      : [resource.imageUrl, videoThumbnailUrl(resource.url)];
  return [...new Set(ordered.filter((url) => url !== ""))];
}

/**
 * The hue a drawn cover is tinted with, the same for everything one author
 * or source wrote.
 *
 * A series then reads as a series on the shelf (five parts of arma473's
 * ladder guide in one colour, the wiki's three in another) without anybody
 * maintaining a palette. Hashed rather than looked up, so a new author gets a
 * colour of their own on the day they are catalogued.
 */
export function coverHue(resource: TrainingResource): number {
  // An entry naming no author is keyed by its id's first word, which is the
  // source the catalogue files it under (`wiki-…`, `forum-…`).
  const source = resource.author || resource.id.split("-")[0];
  let hash = 0;
  for (const char of source) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 360;
}

export function kindLabel(kind: TrainingKind): MessageKey {
  return `training.kind.${kind}`;
}

/**
 * The same word, in the plural.
 *
 * For the library's kind tabs and its collection headings, which name a shelf
 * rather than one entry: "Build order 35" beside a count reads as an
 * identifier, and "Sladow-Noob · Build order" describes twenty-one things as
 * one. Singular stays the default because that is what a card carries.
 */
export function kindPluralLabel(kind: TrainingKind): MessageKey {
  return `training.kindPlural.${kind}`;
}

export function levelLabel(level: TrainingLevel): MessageKey {
  return `training.level.${level}`;
}

export function topicLabel(topic: TrainingTopic): MessageKey {
  return `training.topic.${topic}`;
}

export function topicHint(topic: TrainingTopic): MessageKey {
  return `training.topicHint.${topic}`;
}

/** The glyph a card leads with, so a kind is recognisable before it is read. */
export function kindIcon(kind: TrainingKind): IconName {
  switch (kind) {
    case "lesson":
      return "play";
    case "video":
      return "eye";
    case "guide":
      return "book";
    case "buildOrder":
      return "list";
    case "replayAnalysis":
      return "replays";
    case "community":
      return "users";
  }
}

/**
 * What a card's action does, which differs by kind rather than by url.
 *
 * A lesson's button opens its page. The client has no way to start one, so a
 * label saying "start" promised something the button never did.
 */
export function actionLabel(resource: TrainingResource): MessageKey {
  if (resource.kind === "lesson" && resource.tutorialId !== null) return "training.action.openLesson";
  if (resource.kind === "video") return "training.action.watch";
  if (resource.kind === "community") return "training.action.visit";
  return "training.action.read";
}

/**
 * The rating band as a phrase, or `null` when the entry names no audience.
 *
 * Resolved through `resourceBand`, so a level with no numbers still shows the
 * band it implies: which is what the filter uses, and a card that showed
 * nothing there would be describing a different rule from the one applied.
 */
export function bandKey(
  resource: TrainingResource,
): { key: MessageKey; values: Record<string, number> } | null {
  const [min, max] = resourceBand(resource);
  if (min === null && max === null) return null;
  if (min === null) return { key: "training.band.upTo", values: { max: max as number } };
  if (max === null) return { key: "training.band.from", values: { min } };
  return { key: "training.band.between", values: { min, max } };
}

/** Whether this entry is something the client itself can start. */
export function isPlayableLesson(resource: TrainingResource): boolean {
  return resource.kind === "lesson" && resource.tutorialId !== null;
}

/** How a refused review request is worded. */
export function reviewProblemLabel(problem: ReviewProblem): MessageKey {
  return `training.review.problem.${problem}`;
}

/** How a refused submission is worded. */
export function contributionProblemLabel(problem: ContributionProblem): MessageKey {
  return `training.contribute.problem.${problem}`;
}
