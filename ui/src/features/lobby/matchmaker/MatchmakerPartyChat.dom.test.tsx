// @vitest-environment happy-dom
//
// The party chat beside the queues, mounted against a seeded party and its
// room. A name in it answers the two gestures the Chat tab's names answer: a
// click opens the conversation with that player, and a right-click opens the
// player menu, with the name marked as the one the menu is about until it
// closes. The right-click used to open the conversation as well.

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ChatMessage, PartyState } from "../../../ipc/bindings";
import { failOnConsoleError } from "../../../testing/consoleGuard";
import { clearSentCommands, seedStore, sentCommands } from "../../../testing/mounted";
import { MatchmakerPartyChat } from "./MatchmakerPartyChat";

vi.mock("../../../ipc/client");

failOnConsoleError();

const ME = { id: 7, name: "Me", roles: [] };
const ROOM = "#Me'sParty";

const PARTY: PartyState = {
  ownerId: ME.id,
  members: [
    { playerId: ME.id, name: "Me", factions: [] },
    { playerId: 8, name: "Buddy", factions: [] },
  ],
};

const message = (id: string, sender: string, content: string): ChatMessage => ({
  id,
  sender,
  content,
  timestamp: "2026-10-08T20:00:00Z",
  kind: "message",
});

function mount() {
  seedStore((state) => ({
    ...state,
    auth: { ...state.auth, status: "loggedIn", player: ME },
    chat: {
      ...state.chat,
      status: "connected",
      username: "Me",
      channels: [
        {
          name: ROOM,
          topic: "",
          messages: [message("1", "Buddy", "ready when you are")],
          users: [
            { name: "Buddy", elevation: "" },
            { name: "Me", elevation: "" },
          ],
          unread: 0,
          unreadMentions: 0,
        },
      ],
    },
    lobby: { ...state.lobby, party: PARTY },
  }));
  render(<MatchmakerPartyChat party={PARTY} />);
  clearSentCommands();
}

/** Buddy's name on their line, the control both gestures are made on. */
const buddy = () => screen.getByText("Buddy", { selector: ".chat-nick" });

/** What the panel sent to the chat and the navigation, which a menu must not. */
const conversationCommands = () =>
  sentCommands().filter((command) => command.kind === "Chat" || command.kind === "Nav");

describe("MatchmakerPartyChat names, mounted", () => {
  it("opens the player menu on a right-click, marks the name, and opens no conversation", async () => {
    const user = userEvent.setup();
    mount();

    fireEvent.contextMenu(buddy());

    expect(screen.getByRole("menu")).toBeTruthy();
    expect(conversationCommands()).toEqual([]);
    expect(buddy().classList.contains("is-menu-open")).toBe(true);

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("menu")).toBeNull();
    expect(buddy().classList.contains("is-menu-open")).toBe(false);
    expect(conversationCommands()).toEqual([]);
  });

  it("still opens the conversation on a click", async () => {
    const user = userEvent.setup();
    mount();

    await user.click(buddy());

    expect(screen.queryByRole("menu")).toBeNull();
    expect(conversationCommands()).toEqual([
      { kind: "Chat", command: { type: "joinChannel", payload: { channel: "Buddy" } } },
      { kind: "Chat", command: { type: "selectChannel", payload: { channel: "Buddy" } } },
      { kind: "Nav", command: { type: "select", payload: { tab: "chat" } } },
    ]);
  });
});
