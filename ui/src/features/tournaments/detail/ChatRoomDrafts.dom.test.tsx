// @vitest-environment happy-dom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { en } from "../../../i18n/catalog/en";
import { failOnConsoleError } from "../../../testing/consoleGuard";
import { applyEvent } from "../../../testing/mounted";
import { tourney } from "../fixtures";
import { ChatRoomView } from "./ChatRoomView";

vi.mock("../../../ipc/client");

failOnConsoleError();

describe("tournament room drafts", () => {
  it("keeps independent drafts when switching rooms and tournaments", () => {
    const onPost = vi.fn();
    const chat = { refresh: vi.fn(), deletePost: vi.fn(), mute: vi.fn() };
    const room = (eventId: string, roomId: string) => (
      <ChatRoomView
        event={tourney({ id: eventId })}
        roomId={roomId}
        roomName={roomId}
        posts={[]}
        status={{ type: "ready" }}
        busy={false}
        onPost={(body, replyTo) => { onPost(eventId, roomId, body, replyTo); }}
        chat={chat}
      />
    );
    const input = () => screen.getByRole<HTMLInputElement>("textbox", { name: en["tournaments.chat.placeholder"] });
    const { rerender, unmount } = render(room("first", "match:1"));
    fireEvent.change(input(), { target: { value: "For match one" } });
    rerender(room("first", "global"));
    expect(input().value).toBe("");
    fireEvent.change(input(), { target: { value: "For everyone" } });
    rerender(room("second", "global"));
    expect(input().value).toBe("");
    fireEvent.change(input(), { target: { value: "For another tournament" } });

    rerender(room("first", "match:1"));
    expect(input().value).toBe("For match one");
    fireEvent.submit(input().closest("form")!);
    expect(onPost).toHaveBeenCalledExactlyOnceWith("first", "match:1", "For match one", null);
    expect(input().value).toBe("");
    rerender(room("first", "global"));
    expect(input().value).toBe("For everyone");
    rerender(room("second", "global"));
    expect(input().value).toBe("For another tournament");
    rerender(room("first", "match:1"));
    expect(input().value).toBe("");
    unmount();
    render(room("first", "global"));
    expect(input().value).toBe("For everyone");
  });

  it("clears a visible room and its saved draft after logout and remount", () => {
    const chat = { refresh: vi.fn(), deletePost: vi.fn(), mute: vi.fn() };
    const onPost = vi.fn();
    const room = (
      <ChatRoomView
        event={tourney()}
        roomId="global"
        roomName="Global"
        posts={[]}
        status={{ type: "ready" }}
        busy={false}
        onPost={onPost}
        chat={chat}
      />
    );
    const login = () => applyEvent({
      kind: "Auth",
      event: { type: "loggedIn", payload: { player: { id: 1, name: "First", roles: [] } } },
    });
    login();
    const { unmount } = render(room);
    const input = screen.getByRole<HTMLInputElement>("textbox", { name: en["tournaments.chat.placeholder"] });
    fireEvent.change(input, { target: { value: "Private tournament draft" } });
    applyEvent({ kind: "Auth", event: { type: "loggedOut" } });
    expect(input.value).toBe("");
    unmount();
    login();
    render(room);
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: en["tournaments.chat.placeholder"] }).value).toBe("");
    expect(onPost).not.toHaveBeenCalled();
  });
});
