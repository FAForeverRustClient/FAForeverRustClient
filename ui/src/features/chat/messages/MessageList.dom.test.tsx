// @vitest-environment happy-dom
//
// The Search button counts its presses, and the list is mounted afresh for
// every conversation. A conversation opened after a press must not take that
// earlier press as its own and open its search with the caret in it.

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { initialState } from "../../../testing/mounted";
import { MessageList } from "./MessageList";

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
  });
});
