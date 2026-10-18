import { describe, expect, it } from "vitest";
import type { TourneyProposal } from "../../ipc/bindings";
import { tourney } from "./fixtures";
import { groupOf, groupedEvents } from "./tourneyPresentation";
import {
  lockSentenceKey,
  proposalChip,
  proposalDaysLeft,
  proposalHoldsPublishing,
  proposalPendingKey,
} from "./proposals";

function proposal(over: Partial<TourneyProposal> = {}): TourneyProposal {
  return {
    state: "draft",
    byName: "Nuggets",
    proposedAt: null,
    until: null,
    days: 28,
    lockMaps: false,
    lockFormat: false,
    keep: false,
    note: "",
    takenByName: "",
    takenAt: null,
    takeNote: "",
    last: null,
    mine: false,
    organizer: false,
    canSubmit: false,
    canWithdraw: false,
    canDecide: false,
    canDrop: false,
    canRelease: false,
    canUnlock: false,
    credit: "",
    ...over,
  };
}

describe("tournament proposals (#569)", () => {
  it("hold publishing back while they are built or wait, not once taken over", () => {
    expect(proposalHoldsPublishing(tourney({ proposal: proposal({ state: "draft" }) }))).toBe(true);
    expect(proposalHoldsPublishing(tourney({ proposal: proposal({ state: "proposed" }) }))).toBe(true);
    expect(proposalHoldsPublishing(tourney({ proposal: proposal({ state: "taken" }) }))).toBe(false);
    expect(proposalHoldsPublishing(tourney({ proposal: null }))).toBe(false);
  });

  it("count the days left as the website does: up, and never below zero", () => {
    expect(proposalDaysLeft(null, 0)).toBeNull();
    expect(proposalDaysLeft(86_400 * 3, 0)).toBe(3);
    expect(proposalDaysLeft(86_400 * 3 - 10, 0)).toBe(3);
    expect(proposalDaysLeft(100, 0)).toBe(1);
    expect(proposalDaysLeft(100, 200)).toBe(0);
  });

  it("say in the take dialog what the proposer asked to keep", () => {
    expect(lockSentenceKey({ lockMaps: true, lockFormat: true })).toBe("tournaments.proposal.takeLocksBoth");
    expect(lockSentenceKey({ lockMaps: true, lockFormat: false })).toBe("tournaments.proposal.takeLocksMaps");
    expect(lockSentenceKey({ lockMaps: false, lockFormat: true })).toBe("tournaments.proposal.takeLocksFormat");
    expect(lockSentenceKey({ lockMaps: false, lockFormat: false })).toBe("tournaments.proposal.takeFree");
  });

  it("chip a list row by where its proposal stands", () => {
    expect(proposalChip(proposal({ state: "proposed" }))?.key).toBe("tournaments.proposal.chipProposed");
    expect(proposalChip(proposal({ state: "taken" }))?.tone).toBe("ok");
    expect(
      proposalChip(proposal({ state: "draft", last: { act: "declined", byName: "", at: null, reason: "" } }))?.key,
    ).toBe("tournaments.proposal.chipDeclined");
    expect(proposalChip(proposal({ state: "draft" }))?.key).toBe("tournaments.proposal.chip");
    expect(proposalChip(proposal({ state: null }))).toBeNull();
  });

  it("list the ones a director may decide on apart from the drafts, the soonest first", () => {
    const waiting = (id: string, until: number) =>
      tourney({ id, published: false, proposal: proposal({ state: "proposed", canDecide: true, until }) });
    const later = waiting("later", 2_000);
    const sooner = waiting("sooner", 1_000);
    const own = tourney({ id: "own", published: false, proposal: proposal({ state: "proposed", mine: true }) });
    expect(groupOf(sooner)).toBe("proposals");
    expect(groupOf(own)).toBe("drafts");
    expect(groupedEvents([later, own, sooner]).proposals.map((event) => event.id)).toEqual(["sooner", "later"]);
  });

  it("tell a proposer's pending items apart by the server's sentence", () => {
    expect(proposalPendingKey("Sheikah took over your proposal: see you Saturday")).toBe("tournaments.pending.propTaken");
    expect(proposalPendingKey("Sheikah declined your proposal: no maps")).toBe("tournaments.pending.propDeclined");
    expect(proposalPendingKey("Sheikah gave your proposal back: no time")).toBe("tournaments.pending.propGivenBack");
    // The timeout's reason says "took it over": only the part before the
    // colon is read.
    expect(proposalPendingKey("Your proposal came back: no tournament director took it over within 28 days")).toBe(
      "tournaments.pending.propCameBack",
    );
    expect(proposalPendingKey("Sheikah declined your proposal: it gave no date")).toBe("tournaments.pending.propDeclined");
  });
});
