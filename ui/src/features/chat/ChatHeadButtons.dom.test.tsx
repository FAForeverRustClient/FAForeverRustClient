// @vitest-environment happy-dom
//
// The Chat head row is one strip of controls at one height. Contacts was added
// to it as a default button, a size larger than Search beside it, so every
// button in the row is checked for the class that sizes the strip.

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatChannel } from "../../ipc/bindings";
import { failOnConsoleError } from "../../testing/consoleGuard";
import { seedStore } from "../../testing/mounted";
import { ChatView } from "./ChatView";

vi.mock("../../ipc/client");

failOnConsoleError();

afterEach(cleanup);

const channel: ChatChannel = {
  name: "#aeolus",
  topic: "",
  messages: [],
  users: [{ name: "Me", elevation: "" }],
  unread: 0,
  unreadMentions: 0,
};

describe("the Chat head row", () => {
  it("draws every button at the head row's size", () => {
    seedStore((state) => ({
      ...state,
      chat: { ...state.chat, status: "connected", username: "Me", activeChannel: "#aeolus", channels: [channel] },
    }));
    const { container } = render(<ChatView />);
    const buttons = [...container.querySelectorAll(".chat-head-controls button")];
    expect(buttons.map((button) => button.textContent?.trim())).toEqual(["Contacts", "Search"]);
    for (const button of buttons) expect(button.classList.contains("chat-head-button")).toBe(true);
  });
});
