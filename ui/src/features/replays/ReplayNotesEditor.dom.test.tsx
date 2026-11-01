// @vitest-environment happy-dom

import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Modal } from "../../design-system/Modal";
import { overlayStack } from "../../design-system/overlayStack";
import { en } from "../../i18n/catalog/en";
import { failOnConsoleError } from "../../testing/consoleGuard";
import { seedStore, sentCommands } from "../../testing/mounted";
import { ReplayNotesDialog } from "./ReplayNotesEditor";

vi.mock("../../ipc/client");
failOnConsoleError();

const tenTags = Array.from({ length: 10 }, (_, index) => `tag${index + 1}`);
const tagsField = () => screen.getByRole<HTMLInputElement>("textbox", { name: en["replays.notes.tags"] });
const commentField = () => screen.getByRole<HTMLTextAreaElement>("textbox", { name: en["replays.notes.comment"] });
const saveButton = () => screen.getByRole<HTMLButtonElement>("button", { name: en["replays.notes.save"] });
const writes = () => sentCommands().filter(command => command.kind === "Settings" && command.command.type === "setReplayNote");

function mount(onClose = vi.fn()) {
  render(<ReplayNotesDialog replayId={42} title="A replay" onClose={onClose} />);
  return onClose;
}

describe("replay notes editor", () => {
  it("keeps unsaved notes when a selection ends outside the dialog", () => {
    const onClose = mount();
    const comment = commentField();
    fireEvent.change(comment, { target: { value: "Unfinished notes" } });
    const backdrop = screen.getByRole("dialog", { name: en["replays.notes.title"] }).parentElement!;
    fireEvent.pointerDown(comment);
    fireEvent.pointerUp(backdrop);
    fireEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();
    expect(comment.value).toBe("Unfinished notes");
    expect(writes()).toEqual([]);

    fireEvent.pointerDown(backdrop);
    fireEvent.pointerUp(backdrop);
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("rejects more than ten different tags on both Save and Enter", () => {
    const onClose = mount();
    fireEvent.change(commentField(), { target: { value: "Keep this comment" } });
    fireEvent.change(tagsField(), { target: { value: [...tenTags, "tag11"].join(", ") } });
    expect(saveButton().disabled).toBe(true);
    expect(tagsField().getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert").textContent).toContain("10");
    expect(within(screen.getByRole("list", { name: en["replays.notes.tags"] })).getAllByRole("listitem")).toHaveLength(10);
    fireEvent.click(saveButton());
    fireEvent.keyDown(tagsField(), { key: "Enter" });
    expect(writes()).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();
    expect(tagsField().value).toContain("tag11");

    fireEvent.change(tagsField(), { target: { value: tenTags.join(", ") } });
    expect(saveButton().disabled).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(saveButton());
    expect(writes()).toEqual([{
      kind: "Settings",
      command: { type: "setReplayNote", payload: { replayId: 42, localPath: null, comment: "Keep this comment", tags: tenTags } },
    }]);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("counts duplicate tags once and previews exactly what Enter saves", () => {
    mount();
    fireEvent.change(tagsField(), { target: { value: [...tenTags, " TAG1 ", "tag2", " "].join(", ") } });
    const preview = within(screen.getByRole("list", { name: en["replays.notes.tags"] })).getAllByRole("listitem");
    expect(preview.map(tag => tag.textContent)).toEqual(tenTags);
    expect(saveButton().disabled).toBe(false);
    fireEvent.keyDown(tagsField(), { key: "Enter" });
    expect(writes()).toEqual([{
      kind: "Settings",
      command: { type: "setReplayNote", payload: { replayId: 42, localPath: null, comment: "", tags: tenTags } },
    }]);
  });

  it("still clears an existing note while the new tag input is invalid", () => {
    seedStore(state => ({
      ...state,
      settings: { ...state.settings, social: { ...state.settings.social, replayNotes: [{ replayId: 42, path: null, comment: "Old note", tags: [] }] } },
    }));
    const onClose = mount();
    fireEvent.change(tagsField(), { target: { value: [...tenTags, "tag11"].join(", ") } });
    fireEvent.click(screen.getByRole("button", { name: en["replays.notes.clear"] }));
    expect(writes()).toEqual([{
      kind: "Settings",
      command: { type: "setReplayNote", payload: { replayId: 42, localPath: null, comment: "", tags: [] } },
    }]);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("takes focus above the replay and restores it after Escape closes only the notes", async () => {
    function Replay() {
      const [open, setOpen] = useState(false);
      return (
        <Modal ariaLabel="Replay details" onClose={vi.fn()}>
          <button onClick={() => setOpen(true)}>Edit notes</button>
          {open && <ReplayNotesDialog replayId={42} title="A replay" onClose={() => setOpen(false)} />}
        </Modal>
      );
    }
    const user = userEvent.setup();
    render(<Replay />);
    const opener = screen.getByRole("button", { name: "Edit notes" });
    await user.click(opener);
    const notes = screen.getByRole("dialog", { name: en["replays.notes.title"] });
    expect(document.activeElement).toBe(commentField());
    expect(overlayStack.topFocusTrap()?.element?.()).toBe(notes);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: en["replays.notes.title"] })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Replay details" })).toBeTruthy();
    expect(document.activeElement).toBe(opener);
    expect(writes()).toEqual([]);
  });
});
