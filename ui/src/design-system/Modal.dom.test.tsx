// @vitest-environment happy-dom
//
// Two dialogs, one opened from the other, mounted for real: the static
// render in `Modal.test.tsx` runs no effects and no handlers, so it cannot
// see where focus goes or which dialog a press of Escape closes.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import "../testing/mounted";
import { Modal } from "./Modal";
import { overlayStack } from "./overlayStack";

vi.mock("../ipc/client");

function NestedDialogs({ innerDismissible = true }: { innerDismissible?: boolean }) {
  const [outer, setOuter] = useState(false);
  const [inner, setInner] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOuter(true)}>
        Open settings
      </button>
      {outer && (
        <Modal ariaLabel="Settings" onClose={() => setOuter(false)}>
          <input aria-label="Lobby name" />
          <button type="button" onClick={() => setInner(true)}>
            Delete preset
          </button>
          {inner && (
            <Modal ariaLabel="Confirm delete" dismissible={innerDismissible} onClose={() => setInner(false)}>
              <button type="button" onClick={() => setInner(false)}>
                Yes, delete
              </button>
            </Modal>
          )}
        </Modal>
      )}
    </>
  );
}

describe("Modal, mounted", () => {
  it("takes focus on open, gives it back on close, and Escape closes the topmost dialog only", async () => {
    const user = userEvent.setup();
    render(<NestedDialogs />);

    const opener = screen.getByRole("button", { name: "Open settings" });
    await user.click(opener);
    const settings = screen.getByRole("dialog", { name: "Settings" });
    // The first control of the caller's content, not the close button that
    // comes before it in the DOM.
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Lobby name" }));

    const deleteButton = screen.getByRole("button", { name: "Delete preset" });
    await user.click(deleteButton);
    expect(screen.getByRole("dialog", { name: "Confirm delete" })).toBeDefined();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Yes, delete" }));
    expect(overlayStack.size()).toBe(2);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Confirm delete" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Settings" })).toBe(settings);
    // Back on the control that opened it, inside the dialog still open.
    expect(document.activeElement).toBe(deleteButton);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
    // Both layers took themselves off the stack: nothing is left to swallow
    // the next Escape.
    expect(overlayStack.size()).toBe(0);
  });

  it("keeps Escape at a dialog that may not be dismissed, rather than closing the one under it", async () => {
    const user = userEvent.setup();
    render(<NestedDialogs innerDismissible={false} />);

    await user.click(screen.getByRole("button", { name: "Open settings" }));
    await user.click(screen.getByRole("button", { name: "Delete preset" }));

    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Confirm delete" })).toBeDefined();
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeDefined();

    // Its own button is still a way out, and then Escape reaches the next.
    await user.click(screen.getByRole("button", { name: "Yes, delete" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("leaves the stack empty when a dialog is unmounted while open", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<NestedDialogs />);
    await user.click(screen.getByRole("button", { name: "Open settings" }));
    await user.click(screen.getByRole("button", { name: "Delete preset" }));
    expect(overlayStack.size()).toBe(2);

    unmount();
    expect(overlayStack.size()).toBe(0);
  });
});
