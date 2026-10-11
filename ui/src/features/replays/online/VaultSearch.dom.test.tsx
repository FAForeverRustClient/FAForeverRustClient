// @vitest-environment happy-dom
//
// The online replay search form against paging. Changing the results per page
// and turning a page both re-run the executed query; filters typed into the
// form but not searched for yet must survive that, and a new search must still
// replace the form with what was actually searched.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AppCommand, ReplayQuery } from "../../../ipc/bindings";
import { failOnConsoleError } from "../../../testing/consoleGuard";
import { applyEvent, clearSentCommands, seedStore, sentCommands } from "../../../testing/mounted";
import { EMPTY_REPLAY_QUERY } from "../../../shared/replayQuery";
import { ReplaysView } from "../ReplaysView";

vi.mock("../../../ipc/client");

failOnConsoleError();

const executed: ReplayQuery = { ...EMPTY_REPLAY_QUERY, title: "searched" };

function mountVault() {
  seedStore((state) => ({
    ...state,
    replays: { ...state.replays, vault: [], vaultStatus: { type: "ready" }, vaultQuery: executed },
  }));
  render(<ReplaysView />);
  clearSentCommands();
}

/** The backend's answer to a vault search: the query it ran, now on screen. */
function answer(query: ReplayQuery) {
  applyEvent({
    kind: "Replays",
    event: {
      type: "vaultLoaded",
      payload: { replays: [], query, hasMore: false, totalPages: 3, totalRecords: 0 },
    },
  });
}

const searches = () =>
  sentCommands().flatMap((command: AppCommand) =>
    command.kind === "Replays" && command.command.type === "searchVault"
      ? [command.command.payload.query]
      : [],
  );

const titleField = () => screen.getByPlaceholderText<HTMLInputElement>("Any title");

describe("Online replay search and paging", () => {
  it("keeps unsubmitted filters when the results per page change", async () => {
    const user = userEvent.setup();
    mountVault();
    await user.clear(titleField());
    await user.type(titleField(), "draft");

    await user.selectOptions(screen.getByRole("combobox", { name: "Results per page" }), "100");

    // The page size applies to the search on screen, not to the draft.
    expect(searches()).toEqual([{ ...executed, pageSize: 100, page: 1 }]);
    answer({ ...executed, pageSize: 100, page: 1 });
    expect(titleField().value).toBe("draft");
  });

  it("keeps unsubmitted filters when a page is turned", async () => {
    const user = userEvent.setup();
    mountVault();
    await user.clear(titleField());
    await user.type(titleField(), "draft");

    answer({ ...executed, page: 2 });

    expect(titleField().value).toBe("draft");
  });

  it("submits the kept draft with the new page size", async () => {
    const user = userEvent.setup();
    mountVault();
    await user.clear(titleField());
    await user.type(titleField(), "draft");
    await user.selectOptions(screen.getByRole("combobox", { name: "Results per page" }), "25");
    answer({ ...executed, pageSize: 25, page: 1 });
    clearSentCommands();

    await user.type(titleField(), "{Enter}");

    expect(searches()).toEqual([{ ...executed, title: "draft", pageSize: 25, page: 1 }]);
  });

  it("still takes over a search whose filters changed", async () => {
    const user = userEvent.setup();
    mountVault();
    await user.clear(titleField());
    await user.type(titleField(), "draft");

    answer({ ...executed, title: "from elsewhere" });

    expect(titleField().value).toBe("from elsewhere");
  });
});
