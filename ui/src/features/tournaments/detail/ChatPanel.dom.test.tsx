// @vitest-environment happy-dom
//
// Opening the chat tab is asking for the chat: the event-wide room opens by
// itself, and a room already open stays the one shown.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatRoom } from "../../../ipc/bindings";
import { tourney } from "../fixtures";
import type { ChatActions } from "../tourneyActions";
import { ChatPanel } from "./ChatPanel";

vi.mock("../../../ipc/client");

afterEach(cleanup);

const room = (id: string, name: string): ChatRoom => ({
  id,
  name,
  unread: 0,
  done: false,
  mentioned: false,
  needsOrganiser: false,
  count: 0,
});

function actions(): ChatActions {
  return {
    load: vi.fn(),
    openRoom: vi.fn(),
    post: vi.fn(),
    postTo: vi.fn(),
    deletePost: vi.fn(),
    mute: vi.fn(),
    refresh: vi.fn(),
    pin: vi.fn(),
  };
}

function renderChat(openRoomId: string | null, chat: ChatActions) {
  render(
    <ChatPanel
      event={tourney()}
      rooms={[room("match:m1", "Ada vs Bob"), room("global", "Global")]}
      openRoomId={openRoomId}
      posts={[]}
      status={{ type: "ready" }}
      busy={false}
      chat={chat}
      pinnedRoomId={null}
    />,
  );
}

describe("the tournament chat tab", () => {
  it("opens the global room by itself", () => {
    const chat = actions();
    renderChat(null, chat);
    expect(chat.openRoom).toHaveBeenCalledWith("global");
  });

  it("leaves a room that is already open alone", () => {
    const chat = actions();
    renderChat("match:m1", chat);
    expect(chat.openRoom).not.toHaveBeenCalled();
  });
});
