// @vitest-environment happy-dom
//
// "… is typing" in the Chat tab expires on the reader's clock. That clock's
// tick sleeps while a game runs, so the notice has to be checked against the
// time the view is drawn, or it stays up for the rest of the game.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatChannel } from "../../ipc/bindings";
import { failOnConsoleError } from "../../testing/consoleGuard";
import { applyEvent, seedStore } from "../../testing/mounted";
import { TYPING_TIMEOUT_SECONDS } from "../../store/reducers/chat";
import { ChatView } from "./ChatView";

vi.mock("../../ipc/client");

failOnConsoleError();

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function channel(name: string, users: string[], typing: ChatChannel["typing"] = []): ChatChannel {
  return {
    name,
    topic: "",
    messages: [],
    users: users.map((user) => ({ name: user, elevation: "" })),
    unread: 0,
    unreadMentions: 0,
    typing,
  };
}

describe("typing notices during a game", () => {
  it("expire on the next redraw even while the clock's tick sleeps", () => {
    const start = 1_800_000_000;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(start * 1000);
    seedStore((state) => ({
      ...state,
      lobby: { ...state.lobby, join: { type: "inGame" } },
      chat: {
        ...state.chat,
        status: "connected",
        username: "Me",
        activeChannel: "#aeolus",
        channels: [
          channel("#aeolus", ["Me", "Albert"], [{ nickname: "Albert", atSeconds: start }]),
          channel("#other", ["Me", "Zed"]),
        ],
      },
    }));
    render(<ChatView />);
    expect(screen.getByText(/Albert is typing/)).toBeTruthy();

    // Albert stopped long ago; something unrelated redraws the view. A notice
    // in another channel, because one in this channel would retire Albert's
    // in the reducer and prove nothing about the view's clock.
    vi.setSystemTime((start + TYPING_TIMEOUT_SECONDS + 4) * 1000);
    applyEvent({
      kind: "Chat",
      event: {
        type: "typingChanged",
        payload: { channel: "#other", nickname: "Zed", composing: true, atSeconds: start + TYPING_TIMEOUT_SECONDS + 4 },
      },
    });
    expect(screen.queryByText(/is typing/)).toBeNull();
  });
});
