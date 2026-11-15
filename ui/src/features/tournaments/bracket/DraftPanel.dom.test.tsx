// @vitest-environment happy-dom
//
// The live captains draft, which is a draft event's Teams section: the pool
// ranked by the event's rating, every name a way to the player's card, each
// captain's team so far as the Teams section's card, and who picks next.

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { failOnConsoleError } from "../../../testing/consoleGuard";
import { player, team, tourney } from "../fixtures";
import { DraftPanel, showsDraft } from "./DraftPanel";

vi.mock("../../../ipc/client");
const openPlayerCard = vi.hoisted(() => vi.fn());
vi.mock("../../../shared/playerCardActions", () => ({ openPlayerCard }));

failOnConsoleError();

afterEach(() => {
  cleanup();
  openPlayerCard.mockReset();
});

function draftEvent(organiser: boolean) {
  return tourney({
    status: "draft",
    teamSize: 2,
    players: [
      player({ id: "c1", name: "Ada", fafId: 1, rating: 2000, teamId: "t1" }),
      player({ id: "c2", name: "Bob", fafId: 2, rating: 1900, teamId: "t2" }),
      player({ id: "c3", name: "Cid", fafId: 3, rating: 1800, teamId: "t3" }),
      player({ id: "low", name: "Low", fafId: 4, rating: 900, teamId: null }),
      player({ id: "high", name: "High", fafId: 5, rating: 2300, teamId: null }),
      player({ id: "mid", name: "Mid", fafId: 6, rating: 1500, teamId: null }),
    ],
    teams: [
      team({ id: "t3", name: "", captainId: "c3", playerIds: ["c3"] }),
      team({ id: "t1", name: "", captainId: "c1", playerIds: ["c1"] }),
      team({ id: "t2", name: "", captainId: "c2", playerIds: ["c2"] }),
    ],
    draft: { order: ["t1", "t2", "t3", "t3", "t2", "t1"], current: 0, lastPick: null },
    viewer: { ...tourney().viewer, organiser },
  });
}

function teamActions() {
  return {
    create: vi.fn(),
    requestJoin: vi.fn(),
    cancelJoin: vi.fn(),
    respondJoin: vi.fn(),
    invite: vi.fn(),
    respondInvite: vi.fn(),
    leave: vi.fn(),
    disband: vi.fn(),
    rename: vi.fn(),
    setCaptain: vi.fn(),
    draftPick: vi.fn(),
    draftUndo: vi.fn(),
    setCaptains: vi.fn(),
  };
}

function renderDraft(organiser = false) {
  const teams = teamActions();
  render(
    <DraftPanel
      event={draftEvent(organiser)}
      profiles={[]}
      busy={false}
      teams={teams}
      organiser={{ advance: vi.fn(), admin: vi.fn() }}
    />,
  );
  return { draftPick: teams.draftPick };
}

describe("the live captains draft", () => {
  it("ranks the pool by rating, highest first", () => {
    renderDraft();
    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(rows.map((row) => within(row).getByRole("button").textContent)).toEqual(["High", "Mid", "Low"]);
  });

  it("opens a player's card from their name", () => {
    renderDraft();
    fireEvent.click(within(screen.getByRole("table")).getByRole("button", { name: /High/ }));
    expect(openPlayerCard).toHaveBeenCalledWith(5, "High");
  });

  it("shows every captain's team in pick order, and who picks next", () => {
    renderDraft();
    const cards = screen.getAllByRole("listitem").filter((item) => item.classList.contains("tournament-team-card"));
    expect(cards.map((card) => card.querySelector(".tournament-team-name")?.textContent)).toEqual(["Ada", "Bob", "Cid"]);
    expect(cards[0].classList.contains("is-on-clock")).toBe(true);
    expect(within(cards[0]).getByText("Open slot")).toBeTruthy();
    expect(screen.getByText("Up next: Bob → Cid → Cid")).toBeTruthy();
  });

  it("offers the pick only to whoever may make it", () => {
    renderDraft(false);
    expect(screen.queryByRole("button", { name: "Pick" })).toBeNull();
    cleanup();
    const { draftPick } = renderDraft(true);
    const high = within(screen.getByRole("table")).getAllByRole("row")[1];
    fireEvent.click(within(high).getByRole("button", { name: "Pick" }));
    expect(draftPick).toHaveBeenCalledWith("high");
  });
});

describe("where the draft is the Teams section", () => {
  const draftFormation = (status: "signup" | "draft" | "drafted" | "running", organiser: boolean, drafting: boolean) =>
    tourney({
      formation: "draft",
      status,
      draft: drafting ? { order: ["t1"], current: 0, lastPick: null } : null,
      viewer: { ...tourney().viewer, organiser },
    });

  it("is the captains setup for an organiser before the draft, and nothing for anyone else", () => {
    expect(showsDraft(draftFormation("signup", true, false))).toBe(true);
    expect(showsDraft(draftFormation("signup", false, false))).toBe(false);
  });

  it("is the draft while it runs and until the bracket is drawn", () => {
    expect(showsDraft(draftFormation("draft", false, true))).toBe(true);
    expect(showsDraft(draftFormation("drafted", false, true))).toBe(true);
    expect(showsDraft(draftFormation("running", false, true))).toBe(false);
  });

  it("is never the draft in an event whose teams are formed some other way", () => {
    expect(showsDraft(tourney({ formation: "open", status: "draft" }))).toBe(false);
  });
});
