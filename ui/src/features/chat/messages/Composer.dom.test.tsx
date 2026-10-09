// @vitest-environment happy-dom
//
// The message box from the keyboard, mounted inside the Chat tab so the line
// goes out through the view's real wiring and is read back off the mocked IPC
// boundary: Enter sends, a blank line does not, Tab completes a nickname and
// otherwise moves focus on like anywhere else, and each conversation keeps its
// own unsent line across a switch.
//
// The box is a single-line `<input>`: there is no multi-line message, so
// Shift+Enter has no newline to insert and is not tested here.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatChannel } from "../../../ipc/bindings";
import { failOnConsoleError } from "../../../testing/consoleGuard";
import { applyEvent, clearSentCommands, seedStore, sentCommands } from "../../../testing/mounted";
import { ChatView } from "../ChatView";
import { writeDraft } from "./composerDrafts";

vi.mock("../../../ipc/client");

failOnConsoleError();

function channel(name: string, users: string[]): ChatChannel {
  return {
    name,
    topic: "",
    messages: [],
    users: users.map((user) => ({ name: user, elevation: "" })),
    unread: 0,
    unreadMentions: 0,
  };
}

// Drafts outlive the composer on purpose (see `composerDrafts.ts`), so they
// outlive a test as well unless they are put back.
afterEach(() => {
  for (const key of ["#aeolus", "#other"]) writeDraft(key, "");
});

function mount() {
  seedStore((state) => ({
    ...state,
    chat: {
      ...state.chat,
      status: "connected",
      username: "Me",
      activeChannel: "#aeolus",
      channels: [channel("#aeolus", ["Me", "Albert", "alice", "Bob"]), channel("#other", ["Me", "Zed"])],
    },
  }));
  render(<ChatView />);
  clearSentCommands();
  return screen.getByRole<HTMLInputElement>("textbox", { name: "Message #aeolus" });
}

const sentLines = () =>
  sentCommands().flatMap((command) =>
    command.kind === "Chat" && command.command.type === "sendMessage" ? [command.command.payload] : [],
  );

const select = (name: string) =>
  applyEvent({ kind: "Chat", event: { type: "channelSelected", payload: { channel: name } } });

describe("chat composer keyboard, mounted", () => {
  it("sends the line to the open channel on Enter, trimmed, and empties the box", async () => {
    const user = userEvent.setup();
    const input = mount();

    await user.click(input);
    await user.keyboard("  gl hf  {Enter}");
    expect(sentLines()).toEqual([{ channel: "#aeolus", content: "gl hf", replyTo: "" }]);
    // The typing notice is taken down along with it.
    expect(sentCommands()).toContainEqual({
      kind: "Chat",
      command: { type: "setTyping", payload: { channel: "#aeolus", composing: false } },
    });
    expect(input.value).toBe("");
    expect(document.activeElement).toBe(input);
  });

  it("sends nothing for an empty or blank line", async () => {
    const user = userEvent.setup();
    const input = mount();
    const send = screen.getByRole<HTMLButtonElement>("button", { name: "Send" });

    await user.click(input);
    await user.keyboard("{Enter}");
    expect(send.disabled).toBe(true);
    await user.keyboard("   {Enter}");
    expect(send.disabled).toBe(true);
    expect(sentLines()).toEqual([]);
    // The blank line is left where it was, to be finished or cleared.
    expect(input.value).toBe("   ");
  });

  it("completes a nickname on Tab, cycles on further presses, and keeps focus in the box", async () => {
    const user = userEvent.setup();
    const input = mount();

    await user.click(input);
    await user.keyboard("thanks al");
    await user.keyboard("{Tab}");
    // Matched without regard to case and offered in alphabetical order.
    expect(input.value).toBe("thanks Albert");
    expect(document.activeElement).toBe(input);

    await user.keyboard("{Tab}");
    expect(input.value).toBe("thanks alice");
    await user.keyboard("{Tab}");
    expect(input.value).toBe("thanks Albert");
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(input.value).toBe("thanks alice");
    expect(document.activeElement).toBe(input);

    await user.keyboard("!{Enter}");
    expect(sentLines()).toEqual([{ channel: "#aeolus", content: "thanks alice!", replyTo: "" }]);
  });

  it("lets Tab move focus on when there is nothing to complete", async () => {
    const user = userEvent.setup();
    const input = mount();
    const emoji = screen.getByRole("button", { name: "Insert emoji" });

    // An empty line.
    await user.click(input);
    await user.tab();
    expect(document.activeElement).toBe(emoji);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(input);

    // A word nobody here is called.
    await user.keyboard("zz");
    await user.tab();
    expect(document.activeElement).toBe(emoji);
    expect(input.value).toBe("zz");

    // A name already typed out in full.
    await user.click(input);
    await user.clear(input);
    await user.keyboard("Bob");
    await user.tab();
    expect(document.activeElement).toBe(emoji);
    expect(input.value).toBe("Bob");

    // And after completing the only candidate, the next press moves on.
    await user.click(input);
    await user.clear(input);
    await user.keyboard("Bo{Tab}");
    expect(input.value).toBe("Bob");
    expect(document.activeElement).toBe(input);
    await user.tab();
    expect(document.activeElement).toBe(emoji);
  });

  it("keeps an unsent line per conversation across a switch", async () => {
    const user = userEvent.setup();
    const input = mount();

    await user.click(input);
    await user.keyboard("half a thought");

    // The tab asks the backend; the switch happens when it answers.
    await user.click(screen.getByRole("tab", { name: /#other/ }));
    expect(sentCommands()).toContainEqual({
      kind: "Chat",
      command: { type: "selectChannel", payload: { channel: "#other" } },
    });
    select("#other");

    const other = screen.getByRole<HTMLInputElement>("textbox", { name: "Message #other" });
    expect(other.value).toBe("");
    // Leaving the channel mid-line retracts the typing notice there.
    expect(sentCommands()).toContainEqual({
      kind: "Chat",
      command: { type: "setTyping", payload: { channel: "#aeolus", composing: false } },
    });

    await user.click(other);
    await user.keyboard("elsewhere");
    select("#aeolus");
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Message #aeolus" }).value).toBe(
      "half a thought",
    );

    select("#other");
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Message #other" }).value).toBe("elsewhere");
    expect(sentLines()).toEqual([]);
  });

  it("walks the lines already sent with Up and Down", async () => {
    const user = userEvent.setup();
    const input = mount();

    await user.click(input);
    await user.keyboard("first{Enter}second{Enter}");
    await user.keyboard("{ArrowUp}");
    expect(input.value).toBe("second");
    await user.keyboard("{ArrowUp}");
    expect(input.value).toBe("first");
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(input.value).toBe("");
  });
});
