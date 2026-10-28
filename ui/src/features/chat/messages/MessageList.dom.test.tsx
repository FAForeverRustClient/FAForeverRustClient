// @vitest-environment happy-dom
//
// The Search button counts its presses, and the list is mounted afresh for
// every conversation. A conversation opened after a press must not take that
// earlier press as its own and open its search with the caret in it.

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { initialState } from "../../../testing/mounted";
import { MessageList } from "./MessageList";
import * as format from "./chatFormat";
import type { ChatMessage } from "../../../ipc/bindings";

vi.mock("../../../ipc/client");

function List({ searchRequest }: { searchRequest: number }) {
  const state = initialState();
  return (
    <MessageList messages={[]} self="Me" emptyLabel="Empty conversation" onNickClick={() => {}}
      onNickContextMenu={() => {}} showTimestamps={false} use24HourTime users={[]}
      social={state.social} preferences={state.settings.chat} searchRequest={searchRequest} />
  );
}

describe("the conversation search", () => {
  it("stays closed in a conversation opened after an earlier press, and opens on a new one", () => {
    const { rerender } = render(<List searchRequest={3} />);
    expect(screen.queryByRole("search")).toBeNull();
    rerender(<List searchRequest={4} />);
    expect(screen.getByRole("search")).toBeTruthy();
    // The log makes room above its first line, so the bar covers no match.
    expect(screen.getByRole("log").classList.contains("is-finding")).toBe(true);
  });
});

it("skips rows for unrelated profiles and redraws them when relationships change", () => {
  const state = initialState();
  const messages: ChatMessage[] = [{ id: "one", sender: "Sender", content: "hello", kind: "message", timestamp: "2026-01-01T12:00:00Z" }];
  const users: never[] = [];
  const noop = () => {};
  const list = (social: typeof state.social) => <MessageList messages={messages} self="Self"
    emptyLabel="Empty" onNickClick={noop} onNickContextMenu={noop} showTimestamps use24HourTime
    users={users} social={social} preferences={state.settings.chat} />;
  const row = vi.spyOn(format, "renderBody");
  const view = render(list(state.social));
  row.mockClear();
  view.rerender(list({ ...state.social, players: [...state.social.players] }));
  expect(row).not.toHaveBeenCalled();
  view.rerender(list({ ...state.social, friends: [...state.social.friends, "Sender"] }));
  expect(row).toHaveBeenCalledOnce();
  row.mockRestore();
});
