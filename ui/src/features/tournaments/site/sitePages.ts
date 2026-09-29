// The pages the website keeps beside its tournament list, and what the
// pending bar needs from the service's items.

import type { MessageKey, MessageValues } from "../../../i18n";
import type { PendingItem } from "../../../ipc/bindings";

type Translate = (key: MessageKey, values?: MessageValues) => string;

/** Which page of the Tournaments tab is showing. */
export type SitePage =
  | { kind: "events" }
  | { kind: "hall" }
  | { kind: "series"; seriesId: string | null }
  | { kind: "faq"; articleId: string | null }
  | { kind: "console" }
  | { kind: "access"; access: "editor" | "importer" };

/** The client section a website tab opens, for the pending bar's "Go". */
export function sectionForTab(item: PendingItem): string {
  if (item.kind === "draft") return "draft";
  switch (item.tab) {
    case "players":
    case "bracket":
    case "teams":
    case "vetoes":
      return item.tab;
    default:
      return "overview";
  }
}

/**
 * The pending item's sentence, in the reader's language: one per kind the
 * service sends, with the count it put in its own English sentence. A kind
 * the client does not know yet keeps the service's words.
 */
export function pendingText(item: PendingItem, t: Translate): string {
  const count = item.count ?? 1;
  switch (item.kind) {
    case "invite":
      return t("tournaments.pending.invite");
    case "requests":
      return t("tournaments.pending.requests", { count });
    case "confirm":
      return t("tournaments.pending.confirm");
    case "join":
      return t("tournaments.pending.join", { count });
    case "draft":
      return t("tournaments.pending.draft");
    case "veto":
      return t(item.text.toLowerCase().includes("ban") ? "tournaments.pending.vetoBan" : "tournaments.pending.vetoPick");
    case "fveto":
      return t("tournaments.pending.fveto", { count });
    case "checkin":
      return t("tournaments.pending.checkin");
    default:
      return item.text;
  }
}

/** The three official articles the website links from an official event. */
export const OFFICIAL_ARTICLES: { id: string; label: MessageKey }[] = [
  { id: "art33adc81d9f78", label: "tournaments.links.payout" },
  { id: "art8f783c6882c5", label: "tournaments.links.rules" },
  { id: "art7e0d7816a012", label: "tournaments.links.conduct" },
];
