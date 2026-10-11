// @vitest-environment happy-dom
//
// The matchmaker search in the status bar: the Play tab's dot leads the line
// in the same states, and the stop control is an icon named for what it does,
// which stops every queue the search covers.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { MatchmakerQueue } from "../../ipc/bindings";
import { failOnConsoleError } from "../../testing/consoleGuard";
import { sentCommands } from "../../testing/mounted";
import { MatchmakingTask } from "./ClientStatusBar";

vi.mock("../../ipc/client");

failOnConsoleError();

const queues = [
  { queueName: "tmm3v3", teamSize: 3 },
  { queueName: "tmm4v4", teamSize: 4 },
] as MatchmakerQueue[];

const dot = (container: HTMLElement) => container.querySelector(".client-status-search-dot");

describe("MatchmakingTask", () => {
  it("leads a running search with the pulsing dot and stops every queue from its icon", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <MatchmakingTask state={{ type: "searching", payload: { queueNames: ["tmm3v3", "tmm4v4"] } }} queues={queues} />,
    );

    expect(dot(container)?.getAttribute("data-state")).toBe("searching");
    expect(screen.getByText("Searching 3 vs 3, 4 vs 4")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Stop searching" }));
    expect(sentCommands()).toEqual([
      { kind: "Lobby", command: { type: "matchmake", payload: { queueName: "tmm3v3", start: false } } },
      { kind: "Lobby", command: { type: "matchmake", payload: { queueName: "tmm4v4", start: false } } },
    ]);
  });

  it("keeps the dot without a stop control once the game is launching", () => {
    const { container } = render(
      <MatchmakingTask state={{ type: "launching", payload: { queueName: "tmm3v3" } }} queues={queues} />,
    );

    expect(dot(container)?.getAttribute("data-state")).toBe("launching");
    expect(screen.queryByRole("button")).toBeNull();
  });
});
