// @vitest-environment happy-dom
//
// A failed game-history scan, on both tabs that read it: the reason in a
// plain sentence with the original on hover, and a Retry beside it, which
// asks for the same player's scan again. Reopening the tab also retried, but
// nothing on screen said so.

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { en } from "../../i18n/catalog/en";
import { failOnConsoleError } from "../../testing/consoleGuard";
import { clearSentCommands, seedStore, sentCommands } from "../../testing/mounted";
import { PlayerMapStatistics } from "./PlayerMapStatistics";
import { PlayerResults } from "./PlayerResults";

vi.mock("../../ipc/client");

failOnConsoleError();

const PLAYER = 11;

const REASON = "error sending request for url (https://api.faforever.com/data/gamePlayerStats)";

const scans = () =>
  sentCommands().filter((command) => command.kind === "PlayerCard" && command.command.type === "loadMapStats");

function failed(reason: string) {
  seedStore((state) => ({
    ...state,
    playerCard: {
      ...state.playerCard,
      mapStats: null,
      mapStatsStatus: "failed",
      mapStatsError: reason,
    },
  }));
}

describe("a failed game history", () => {
  for (const [tab, View] of [
    ["Results", PlayerResults],
    ["Maps", PlayerMapStatistics],
  ] as const) {
    it(`says it plainly on the ${tab} tab, and Retry scans the same player again`, async () => {
      const user = userEvent.setup();
      failed(REASON);
      render(<View playerId={PLAYER} />);
      clearSentCommands();

      const alert = screen.getByRole("alert");
      expect(within(alert).getByText(en["errors.cause.offline"]).getAttribute("title")).toBe(REASON);
      expect(alert.textContent).not.toContain("error sending request");
      await user.click(within(alert).getByRole("button", { name: en["common.retry"] }));

      expect(scans()).toEqual([
        { kind: "PlayerCard", command: { type: "loadMapStats", payload: { playerId: PLAYER } } },
      ]);
    });
  }

  it("names what failed when the backend gave no reason", () => {
    failed("");
    render(<PlayerResults playerId={PLAYER} />);
    expect(screen.getByRole("alert").textContent).toContain(en["playerCard.maps.failed"]);
  });
});
