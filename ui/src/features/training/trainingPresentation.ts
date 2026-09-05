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
import { resourceBand } from "../../shared/trainingRules";

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
 * The catalogue's modes are free text (a manifest can say `coop` or `nomads`),
 * so this is a convenience list rather than the set of legal values. The filter
 * also accepts whatever the catalogue itself carries, which is where anything
 * not listed here comes from.
 */
export const COMMON_MODES = ["1v1", "2v2", "3v3", "4v4", "coop"];

export function kindLabel(kind: TrainingKind): MessageKey {
  return `training.kind.${kind}`;
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

/** What a card's action does, which differs by kind rather than by url. */
export function actionLabel(resource: TrainingResource): MessageKey {
  if (resource.kind === "lesson" && resource.tutorialId !== null) return "training.action.start";
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
