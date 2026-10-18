// Tournament proposals (#569), as the website's `app.propose.js` decides
// them: what a proposal's box says, and whether its event's publish banner
// shows at all. Pure, so the decisions are tested apart from the boxes.

import type { ProposalDecision, Tourney, TourneyProposal } from "../../ipc/bindings";
import type { MessageKey, MessageValues } from "../../i18n";

/**
 * Whether the proposal holds the event back from publishing.
 *
 * Its proposer builds it and a director publishes it once taken over, so
 * the publish banner is left out while it is being built or waits (the
 * website's `draftBannerHTML` is the same). Taken over, it is an ordinary
 * draft of the director's again.
 */
export function proposalHoldsPublishing(event: Tourney): boolean {
  const state = event.proposal?.state ?? null;
  return state === "draft" || state === "proposed";
}

/**
 * The days a proposal has left before it goes back, rounded up as the
 * website rounds them, never below zero. `null` without a deadline.
 */
export function proposalDaysLeft(until: number | null, nowSeconds: number): number | null {
  if (until === null) return null;
  return Math.max(0, Math.ceil((until - nowSeconds) / 86_400));
}

/** "less than a day left", "3 days left". */
export function daysLeftText(
  until: number | null,
  nowSeconds: number,
  t: (key: MessageKey, values?: MessageValues) => string,
): string {
  const left = proposalDaysLeft(until, nowSeconds);
  if (left === null) return "";
  return left < 1 ? t("tournaments.proposal.lessThanADay") : t("tournaments.proposal.daysLeft", { count: left });
}

/** What came of the proposal last, shown while it is a draft again. */
export function lastStepKey(proposal: TourneyProposal): MessageKey | null {
  switch (proposal.last?.act) {
    case "declined":
      return "tournaments.proposal.lastDeclined";
    case "timeout":
      return "tournaments.proposal.lastTimeout";
    case "released":
      return "tournaments.proposal.lastReleased";
    case "withdrawn":
      return "tournaments.proposal.lastWithdrawn";
    default:
      return null;
  }
}

/** The take dialog's sentence about what the proposer asked to keep. */
export function lockSentenceKey(proposal: Pick<TourneyProposal, "lockMaps" | "lockFormat">): MessageKey {
  if (proposal.lockMaps && proposal.lockFormat) return "tournaments.proposal.takeLocksBoth";
  if (proposal.lockMaps) return "tournaments.proposal.takeLocksMaps";
  if (proposal.lockFormat) return "tournaments.proposal.takeLocksFormat";
  return "tournaments.proposal.takeFree";
}

/** A decision's word in the console's "Recent decisions". */
export function decisionKey(decision: Pick<ProposalDecision, "act">): MessageKey | null {
  switch (decision.act) {
    case "taken":
      return "tournaments.proposal.actTaken";
    case "declined":
      return "tournaments.proposal.actDeclined";
    case "timeout":
      return "tournaments.proposal.actTimeout";
    case "withdrawn":
      return "tournaments.proposal.actWithdrawn";
    case "released":
      return "tournaments.proposal.actReleased";
    case "unlocked maps":
      return "tournaments.proposal.actUnlockedMaps";
    case "unlocked format":
      return "tournaments.proposal.actUnlockedFormat";
    default:
      return null;
  }
}

/**
 * The chip on an unpublished event in the list, as the website's
 * `propChipHTML` words it, and how it is coloured.
 */
export function proposalChip(proposal: TourneyProposal): { key: MessageKey; tone: "wait" | "ok" | "no" | "warn" | "plain" } | null {
  switch (proposal.state) {
    case "proposed":
      return { key: "tournaments.proposal.chipProposed", tone: "wait" };
    case "taken":
      return { key: "tournaments.proposal.chipTaken", tone: "ok" };
    case "draft":
      switch (proposal.last?.act) {
        case "declined":
          return { key: "tournaments.proposal.chipDeclined", tone: "no" };
        case "timeout":
          return { key: "tournaments.proposal.chipCameBack", tone: "warn" };
        case "released":
          return { key: "tournaments.proposal.chipGivenBack", tone: "warn" };
        default:
          return { key: "tournaments.proposal.chip", tone: "plain" };
      }
    default:
      return null;
  }
}

/**
 * A proposer's pending item, by the server sentence it came with: "X took
 * over your proposal", "X declined ...", "X gave your proposal back", or
 * "Your proposal came back". Matched on the one word that tells them apart,
 * before the colon: what follows it is a note or a reason in anybody's words,
 * and the timeout's own reason says "took it over".
 */
export function proposalPendingKey(text: string): MessageKey {
  const words = (text.split(":")[0] ?? "").toLowerCase().split(/\W+/);
  if (words.includes("took")) return "tournaments.pending.propTaken";
  if (words.includes("declined")) return "tournaments.pending.propDeclined";
  if (words.includes("gave")) return "tournaments.pending.propGivenBack";
  return "tournaments.pending.propCameBack";
}
