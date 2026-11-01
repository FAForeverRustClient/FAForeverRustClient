// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyEvent, clearSentCommands, initialState, seedStore, sentCommands } from "./mounted";
import { failOnConsoleError } from "./consoleGuard";
import { Composer } from "../features/chat/messages/Composer";
import { writeDraft } from "../shared/chatDrafts";
import { ReviewsPanel } from "../features/reviews/ReviewsPanel";
import { DisplaySettingsDialog } from "../features/tournaments/detail/DisplaySettingsDialog";
import { HOTKEY_ACTIONS, type HotkeyAction } from "../features/tournaments/display";
import { Modal } from "../design-system/Modal";
import { usePlayerMenu } from "../shared/hooks/usePlayerMenu";
import { MessageList } from "../features/chat/messages/MessageList";
import { MessageReactions } from "../features/chat/messages/MessageReactions";
import { ChatRoomView } from "../features/tournaments/detail/ChatRoomView";
import { player, match, tourney } from "../features/tournaments/fixtures";
import { FactionGame } from "../features/tournaments/bracket/FactionVeto";

vi.mock("../ipc/client");
failOnConsoleError();
afterEach(() => writeDraft("keyboard-layer-test", ""));

function ReplyWithMenu({ onCancelReply }: { onCancelReply: () => void }) {
  const { openPlayerMenu, playerMenu } = usePlayerMenu();
  const [reply, setReply] = useState<{ msgid: string; sender: string } | null>({ msgid: "message", sender: "Player" });
  return <>
    <span onContextMenu={(event) => openPlayerMenu("Player", event)}>Player menu source</span>
    <Composer channel="keyboard-layer-test" nicknames={[]} disabled={false} onSend={() => {}}
      replyTo={reply} onCancelReply={() => { setReply(null); onCancelReply(); }} />
    {playerMenu}
  </>;
}

function SearchWithMenu() {
  const { openPlayerMenu, playerMenu } = usePlayerMenu();
  const state = initialState();
  return <>
    <span onContextMenu={(event) => openPlayerMenu("Player", event)}>Player menu source</span>
    <MessageList messages={[]} self="Me" emptyLabel="Empty conversation" onNickClick={() => {}}
      onNickContextMenu={openPlayerMenu} showTimestamps={false} use24HourTime users={[]}
      social={state.social} preferences={state.settings.chat} />
    {playerMenu}
  </>;
}

describe("Escape ownership in real overlays", () => {
  it("closes an emoji picker before the modal and restores its trigger", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Modal onClose={onClose} ariaLabel="Chat settings">
      <Composer channel="keyboard-layer-test" nicknames={[]} disabled={false} onSend={() => {}} />
    </Modal>);
    const trigger = screen.getByRole("button", { name: "Insert emoji" });
    await user.click(trigger);
    expect(screen.getAllByRole("dialog")).toHaveLength(2);
    await user.keyboard("{Escape}");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("lets an inline reply cancellation keep Escape without closing the modal", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onCancelReply = vi.fn();
    render(<Modal onClose={onClose} ariaLabel="Chat settings">
      <Composer channel="keyboard-layer-test" nicknames={[]} disabled={false} onSend={() => {}}
        replyTo={{ msgid: "message", sender: "Player" }} onCancelReply={onCancelReply} />
    </Modal>);
    await user.click(screen.getByRole("textbox"));
    await user.keyboard("{Escape}");
    expect(onCancelReply).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes a player menu above a focused reply before cancelling the reply", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onCancelReply = vi.fn();
    render(<Modal onClose={onClose} ariaLabel="Chat settings"><ReplyWithMenu onCancelReply={onCancelReply} /></Modal>);
    const input = screen.getByRole("textbox");
    await user.click(input);
    fireEvent.contextMenu(screen.getByText("Player menu source"));
    // The menu takes focus when it opens; Escape hands it back to the input.
    expect(screen.getByRole("menu").contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(onCancelReply).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
    await user.keyboard("{Escape}");
    expect(onCancelReply).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes a player menu before the focused search and returns focus to its log", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Modal onClose={onClose} ariaLabel="Chat settings"><SearchWithMenu /></Modal>);
    await user.keyboard("{Control>}f{/Control}");
    const search = screen.getByRole("search");
    const input = search.querySelector("input")!;
    input.focus();
    fireEvent.contextMenu(screen.getByText("Player menu source"));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("search")).toBe(search);
    fireEvent.keyDown(input, { key: "Escape", isComposing: true });
    expect(screen.getByRole("search")).toBe(search);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("search")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("log"));
    expect(onClose).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not open chat search behind a different dialog", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<><SearchWithMenu /><Modal onClose={onClose} ariaLabel="Other settings"><input aria-label="Setting" /></Modal></>);
    await user.click(screen.getByRole("textbox", { name: "Setting" }));
    await user.keyboard("{Control>}f{/Control}");
    expect(screen.queryByRole("search")).toBeNull();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("returns focus from a reaction menu to its trigger before closing the dialog", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Modal onClose={onClose} ariaLabel="Chat settings"><MessageReactions msgid="message" self="Me"
      reactions={[{ emoji: "👍", senders: ["Player"] }]} onReact={() => {}} onUnreact={() => {}} /></Modal>);
    const trigger = screen.getByRole("button", { name: "Add a reaction" });
    await user.click(trigger);
    await user.tab();
    expect(screen.getByRole("menu").contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(onClose).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("dismisses a tournament mention, then the reply, then the chat popup", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Modal onClose={onClose} ariaLabel="Match chat">
      <ChatRoomView event={tourney({ players: [player({ name: "Player" })] })} roomId="global" roomName="Global"
        posts={[{ id: "post", author: "Player", fafId: null, body: "Hello", at: null, system: false, replyTo: null, everyone: false }]}
        status={{ type: "ready" }} busy={false} onPost={() => {}} chat={{ refresh: () => {}, mute: () => {}, deletePost: () => {} }} />
    </Modal>);
    await user.click(screen.getByRole("button", { name: "Reply" }));
    const input = screen.getByRole<HTMLInputElement>("textbox");
    await user.type(input, "@Pl");
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Escape", isComposing: true });
    fireEvent.keyDown(input, { key: "Tab", isComposing: true });
    expect(input.value).toBe("@Pl");
    expect(screen.getByRole("listbox")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel the reply" })).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("button", { name: "Cancel the reply" })).toBeNull();
    expect(input.value).toBe("@Pl");
    expect(onClose).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("disarms a faction choice before closing its dialog, without sending the choice", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onChoose = vi.fn();
    render(<Modal onClose={onClose} ariaLabel="Faction veto">
      <FactionGame event={tourney()} entry={match()} busy={false} onChoose={onChoose}
        game={{ game: 1, team1Done: false, team2Done: false, result: null,
          mine: { bans: [], picks: [], done: false }, next: { action: "ban", index: 1, of: 1 } }} />
    </Modal>);
    const chip = screen.getByRole("button", { name: "UEF" });
    await user.click(chip);
    expect(chip.classList.contains("is-armed")).toBe(true);
    fireEvent.keyDown(chip, { key: "Escape", isComposing: true });
    expect(chip.classList.contains("is-armed")).toBe(true);
    await user.keyboard("{Escape}");
    expect(chip.classList.contains("is-armed")).toBe(false);
    expect(onChoose).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("leaves IME Escape alone in an emoji search and the surrounding modal", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Modal onClose={onClose} ariaLabel="Chat settings">
      <Composer channel="keyboard-layer-test" nicknames={[]} disabled={false} onSend={() => {}} />
    </Modal>);
    await user.click(screen.getByRole("button", { name: "Insert emoji" }));
    fireEvent.keyDown(document.activeElement!, { key: "Escape", isComposing: true });
    expect(screen.getAllByRole("dialog")).toHaveLength(2);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes reviews over a replay without also closing the replay", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    seedStore((state) => ({ ...state, reviews: {
      ...state.reviews, target: { kind: "game", id: 4242, name: "Test replay" }, status: { type: "ready" },
    } }));
    render(<Modal onClose={onClose} ariaLabel="Replay"><ReviewsPanel /></Modal>);
    clearSentCommands();
    await user.keyboard("{Escape}");
    expect(sentCommands()).toContainEqual({ kind: "Reviews", command: { type: "close" } });
    expect(onClose).not.toHaveBeenCalled();
    applyEvent({ kind: "Reviews", event: { type: "closed" } });
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("cancels choosing a shortcut before closing the shortcuts dialog", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const keys = Object.fromEntries(HOTKEY_ACTIONS.map((action, index) => [action.id, String(index)])) as Record<HotkeyAction, string>;
    render(<DisplaySettingsDialog keys={keys} onChange={() => {}} onClose={onClose} />);
    const trigger = screen.getByRole("button", { name: "0" });
    await user.click(trigger);
    expect(trigger.textContent).not.toBe("0");
    await user.keyboard("{Escape}");
    expect(trigger.textContent).toBe("0");
    expect(onClose).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
