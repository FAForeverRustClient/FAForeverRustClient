// @vitest-environment happy-dom
//
// The whole tab, mounted, against the answers that arrive out of turn: a
// failed first load and its retry, a detail for an event the reader has
// already left, a name search answered for a word the organiser has since
// typed past, and a search still waiting to go out when its section closes.
// What is on screen must always belong to what the reader is looking at now.

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { PlayerSummary, Tourney, TourneyCommand } from "../../ipc/bindings";
import { failOnConsoleError } from "../../testing/consoleGuard";
import { applyEvent, clearSentCommands, seedStore, sentCommands } from "../../testing/mounted";
import { player, tourney } from "./fixtures";
import { TournamentsView } from "./TournamentsView";

vi.mock("../../ipc/client");

failOnConsoleError();

const spring = tourney({ id: "e1", name: "Spring Cup", status: "signup" });
const autumn = tourney({ id: "e2", name: "Autumn Cup", status: "signup" });

function tourneyCommands(type: TourneyCommand["type"]) {
  return sentCommands().filter((command) => command.kind === "Tourney" && command.command.type === type);
}

function mountWith(events: Tourney[], selected: Tourney | null) {
  seedStore((state) => ({
    ...state,
    tourney: {
      ...state.tourney,
      status: { type: "ready" },
      events,
      selectedId: selected?.id ?? null,
      detail: selected,
    },
  }));
  return render(<TournamentsView />);
}

function account(id: number, login: string): PlayerSummary {
  return { id, login, avatarUrl: "", country: "", globalRating: null, ladderRating: null };
}

describe("TournamentsView, mounted", () => {
  it("offers a retry when the list fails to load, and the retry asks again", async () => {
    const user = userEvent.setup();
    render(<TournamentsView />);
    // The mount asks for the list once.
    expect(tourneyCommands("load")).toHaveLength(1);

    applyEvent({ kind: "Tourney", event: { type: "loading" } });
    applyEvent({ kind: "Tourney", event: { type: "loadFailed", payload: { reason: "connection reset", kind: "offline" } } });
    const retry = screen.getByRole("button", { name: "Retry" });
    expect(screen.getByText(/Could not load tournaments/)).toBeDefined();

    clearSentCommands();
    await user.click(retry);
    expect(tourneyCommands("load")).toHaveLength(1);
    expect(tourneyCommands("loadHosting")).toHaveLength(1);

    applyEvent({ kind: "Tourney", event: { type: "loading" } });
    applyEvent({ kind: "Tourney", event: { type: "loaded", payload: { events: [spring] } } });
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByText(/Could not load tournaments/)).toBeNull();
    expect(screen.getByRole("button", { name: /Spring Cup/ })).toBeDefined();
  });

  it("does not draw a late detail for the event the reader has already left", async () => {
    const user = userEvent.setup();
    mountWith([spring, autumn], spring);
    expect(screen.getByRole("heading", { name: "Spring Cup" })).toBeDefined();

    await user.click(screen.getByRole("button", { name: /Autumn Cup/ }));
    expect(tourneyCommands("select")).toEqual([
      { kind: "Tourney", command: { type: "select", payload: { tournamentId: "e2" } } },
    ]);
    applyEvent({ kind: "Tourney", event: { type: "selected", payload: { tournamentId: "e2" } } });
    applyEvent({ kind: "Tourney", event: { type: "detailLoading" } });
    // The previous event goes at once, rather than sitting under the new row.
    expect(screen.queryByRole("heading", { name: "Spring Cup" })).toBeNull();

    // The older request answers last.
    applyEvent({
      kind: "Tourney",
      event: { type: "detailLoaded", payload: { event: { ...spring, name: "Spring Cup (late)" } } },
    });
    expect(screen.queryByRole("heading", { name: /Spring Cup/ })).toBeNull();
    expect(screen.getByText("Loading the tournament…")).toBeDefined();

    applyEvent({ kind: "Tourney", event: { type: "detailLoaded", payload: { event: autumn } } });
    expect(screen.getByRole("heading", { name: "Autumn Cup" })).toBeDefined();
  });

  it("keeps the newest name search's matches when an older one answers after it", async () => {
    const user = userEvent.setup();
    const organised = { ...spring, viewer: { ...spring.viewer, organiser: true }, players: [player({ id: "p1", name: "Alpha" })] };
    mountWith([organised], organised);
    await user.click(within(screen.getByRole("navigation", { name: "Tournament sections" })).getByRole("button", { name: "Manage" }));
    await user.click(screen.getByRole("button", { name: /^Players.*entered/ }));

    const [addField] = screen.getAllByRole("textbox", { name: "FAF name" });
    await user.type(addField, "Brav");
    await waitFor(() => expect(tourneyCommands("searchAccounts")).toHaveLength(1));
    expect(tourneyCommands("searchAccounts")[0]).toEqual({
      kind: "Tourney",
      command: { type: "searchAccounts", payload: { query: "Brav" } },
    });

    // An earlier search for "Br" was still running when "Brav" started.
    applyEvent({ kind: "Tourney", event: { type: "accountSearchStarted", payload: { query: "Brav" } } });
    expect(screen.getByText("Searching FAF…")).toBeDefined();
    applyEvent({
      kind: "Tourney",
      event: { type: "accountSearchLoaded", payload: { query: "Br", matches: [account(7, "Brian")] } },
    });
    expect(screen.queryByText("Brian")).toBeNull();
    expect(screen.getByText("Searching FAF…")).toBeDefined();

    applyEvent({
      kind: "Tourney",
      event: { type: "accountSearchLoaded", payload: { query: "Brav", matches: [account(8, "Bravo")] } },
    });
    expect(screen.queryByText("Searching FAF…")).toBeNull();
    expect(screen.getByText("Bravo")).toBeDefined();
    expect(screen.queryByText("Brian")).toBeNull();
  });

  it("drops a name search still waiting to go out when its section is closed", async () => {
    const user = userEvent.setup();
    const organised = { ...spring, viewer: { ...spring.viewer, organiser: true } };
    mountWith([organised], organised);
    await user.click(within(screen.getByRole("navigation", { name: "Tournament sections" })).getByRole("button", { name: "Manage" }));
    await user.click(screen.getByRole("button", { name: /^Players.*entered/ }));

    const [addField] = screen.getAllByRole("textbox", { name: "FAF name" });
    await user.type(addField, "Brav");
    // Back to the board before the typing pause has run out.
    await user.click(screen.getByRole("button", { name: "All sections" }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(tourneyCommands("searchAccounts")).toHaveLength(0);
  });

  it("disables Refresh only once the service says it is loading, so a quick double click asks twice", async () => {
    const user = userEvent.setup();
    mountWith([spring], spring);
    clearSentCommands();

    const refresh = screen.getByRole("button", { name: "Refresh" });
    await user.dblClick(refresh);
    // Unguarded on the client: both clicks land before the backend's
    // `loading`. Reads are idempotent, so this costs a request, not a wrong
    // screen.
    expect(tourneyCommands("load")).toHaveLength(2);

    applyEvent({ kind: "Tourney", event: { type: "loading" } });
    expect(refresh.hasAttribute("disabled")).toBe(true);
    await user.click(refresh);
    expect(tourneyCommands("load")).toHaveLength(2);

    applyEvent({ kind: "Tourney", event: { type: "loaded", payload: { events: [spring] } } });
    expect(refresh.hasAttribute("disabled")).toBe(false);
  });
});
