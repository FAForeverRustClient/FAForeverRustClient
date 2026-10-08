// @vitest-environment happy-dom
//
// The open chat room re-reads itself while it is on screen, since the
// tournament service pushes nothing. Mounted with the event's real command
// groups (`createTourneyActions`) and the IPC boundary mocked, so what is
// checked is the command that leaves the client: one every five seconds, not
// restarted by a redraw, and none once the room is gone. A room that could
// not be read says so plainly, with Retry sending that same read.

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatPost } from "../../../ipc/bindings";
import { en } from "../../../i18n/catalog/en";
import { clearSentCommands, sentCommands } from "../../../testing/mounted";
import { tourney } from "../fixtures";
import { createTourneyActions } from "../tourneyActions";
import { ChatRoomView } from "./ChatRoomView";

vi.mock("../../../ipc/client");

const event = tourney({ id: "e1a2b", name: "Spring Cup" });
const actions = createTourneyActions(event.id, { signUp: () => undefined, report: () => undefined });

const refreshes = () =>
  sentCommands().filter((command) => command.kind === "Tourney" && command.command.type === "refreshChat");

function room(posts: ChatPost[]) {
  return (
    <ChatRoomView
      event={event}
      roomId="global"
      posts={posts}
      status={{ type: "ready" }}
      busy={false}
      onPost={actions.chat.post}
      chat={actions.chat}
    />
  );
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ChatRoomView polling, mounted", () => {
  it("re-reads the open room every five seconds, through the event's own command", () => {
    render(room([]));
    clearSentCommands();

    advance(4_999);
    expect(refreshes()).toHaveLength(0);
    advance(1);
    expect(refreshes()).toEqual([
      { kind: "Tourney", command: { type: "refreshChat", payload: { tournamentId: "e1a2b", roomId: "global" } } },
    ]);
    advance(5_000);
    expect(refreshes()).toHaveLength(2);
  });

  it("keeps its clock across a redraw, since the command groups keep their identity", () => {
    const { rerender } = render(room([]));
    clearSentCommands();

    advance(4_000);
    // A redraw for something else, such as the posts the last read brought.
    rerender(room([]));
    advance(1_000);
    expect(refreshes()).toHaveLength(1);
  });

  it("stops polling the moment the room is unmounted", () => {
    const { unmount } = render(room([]));
    clearSentCommands();

    advance(5_000);
    expect(refreshes()).toHaveLength(1);
    unmount();
    advance(30_000);
    expect(refreshes()).toHaveLength(1);
  });
});

describe("ChatRoomView failure, mounted", () => {
  it("says a room that could not be read plainly, keeps the reason on hover, and reads it again from Retry", () => {
    const reason = "error sending request for url (https://tourney.faforever.com/api/chat/global)";
    render(
      <ChatRoomView
        event={event}
        roomId="global"
        posts={[]}
        status={{ type: "failed", payload: { reason, kind: "offline" } }}
        busy={false}
        onPost={actions.chat.post}
        chat={actions.chat}
      />,
    );
    clearSentCommands();

    const alert = screen.getByRole("alert");
    expect(within(alert).getByText(en["errors.cause.offline"]).getAttribute("title")).toBe(reason);
    fireEvent.click(within(alert).getByRole("button", { name: en["common.retry"] }));
    expect(refreshes()).toEqual([
      { kind: "Tourney", command: { type: "refreshChat", payload: { tournamentId: "e1a2b", roomId: "global" } } },
    ]);
  });
});
