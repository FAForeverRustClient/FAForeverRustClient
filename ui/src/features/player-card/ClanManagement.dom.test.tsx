// @vitest-environment happy-dom
//
// Clan management's two failures, mounted against the store: the clan that
// could not be read, and a write the server refused. The first says so in a
// plain sentence and reads the clan again from Retry; the second keeps the
// server's own sentence, which is written for a player, and rewords only a
// transport failure. Both keep the reason as it was sent on hover.

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ClanEvent, ClanIdentity } from "../../ipc/bindings";
import { en } from "../../i18n/catalog/en";
import { failOnConsoleError } from "../../testing/consoleGuard";
import { applyEvent, clearSentCommands, sentCommands } from "../../testing/mounted";
import { ClanManagement } from "./ClanManagement";

vi.mock("../../ipc/client");

failOnConsoleError();

const clanEvent = (event: ClanEvent) => applyEvent({ kind: "Clan", event });

/** An account in no clan: the tab offers to found one or to join one. */
const clanless: ClanIdentity = {
  playerId: 7,
  login: "Nory",
  clanId: "",
  clanName: "",
  clanTag: "",
  isLeader: false,
};

/** The tab as it opens, with the load it sent on mounting set aside. */
function mountClan() {
  render(<ClanManagement />);
  expect(sentCommands()).toEqual([{ kind: "Clan", command: { type: "load" } }]);
  clearSentCommands();
}

describe("Clan management failures, mounted", () => {
  it("says a clan that could not be read plainly, with the reason on hover, and reads it again", async () => {
    const user = userEvent.setup();
    mountClan();
    const reason = "request could not be completed: error sending request for url (https://api.faforever.com/clans/me)";
    clanEvent({ type: "loading" });
    clanEvent({ type: "loadFailed", payload: { reason } });

    const alert = screen.getByRole("alert");
    expect(within(alert).getByText(en["errors.cause.offline"]).getAttribute("title")).toBe(reason);
    expect(alert.textContent).not.toContain("error sending request");

    await user.click(within(alert).getByRole("button", { name: en["common.retry"] }));
    expect(sentCommands()).toEqual([{ kind: "Clan", command: { type: "load" } }]);

    clanEvent({ type: "loading" });
    clanEvent({ type: "loaded", payload: { identity: clanless, clan: null } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(en["clan.create.title"])).toBeTruthy();
  });

  it("keeps the server's own sentence for a refused write, and can be dismissed", async () => {
    const user = userEvent.setup();
    mountClan();
    clanEvent({ type: "loaded", payload: { identity: clanless, clan: null } });
    const reason = "the clan tag BRO is already taken";
    clanEvent({ type: "actionStarted", payload: { action: "creating" } });
    clanEvent({ type: "actionFailed", payload: { action: "creating", reason, kind: "rejected" } });

    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("The clan tag BRO is already taken.").getAttribute("title")).toBe(reason);

    await user.click(within(alert).getByRole("button", { name: en["common.dismiss"] }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("rewords a write that never reached the server", () => {
    mountClan();
    clanEvent({ type: "loaded", payload: { identity: clanless, clan: null } });
    const reason = "The request to FAF services timed out. Check your connection and try again.";
    clanEvent({ type: "actionFailed", payload: { action: "joining", reason, kind: "offline" } });

    const alert = screen.getByRole("alert");
    expect(within(alert).getByText(en["errors.cause.timeout"]).getAttribute("title")).toBe(reason);
  });
});
