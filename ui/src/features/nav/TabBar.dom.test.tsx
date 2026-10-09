// @vitest-environment happy-dom
//
// Where focus goes when a sidebar entry is chosen, mounted.
//
// A clicked entry used to keep the focus, and the first key pressed after it
// (an arrow to scroll the page, Escape, Alt+Tab back into the window) put the
// keyboard focus ring on that entry, long after the reader had moved on to
// the page it opened. A click now asks the shell to focus the page. A choice
// made from the keyboard leaves the focus where it is, so the sidebar can
// still be walked entry by entry.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { failOnConsoleError } from "../../testing/consoleGuard";
import { sentCommands } from "../../testing/mounted";
import { TabBar } from "./TabBar";

vi.mock("../../ipc/client");

failOnConsoleError();

const selectMods = { kind: "Nav", command: { type: "select", payload: { tab: "mods" } } };

describe("choosing a sidebar entry", () => {
  it("hands the focus to the page when the pointer chose it", () => {
    const onPointerSelect = vi.fn();
    render(<TabBar onPointerSelect={onPointerSelect} />);

    // A mouse click: `detail` counts the clicks.
    fireEvent.click(screen.getByRole("button", { name: "Mods" }), { detail: 1 });

    expect(sentCommands()).toContainEqual(selectMods);
    expect(onPointerSelect).toHaveBeenCalledTimes(1);
  });

  it("leaves the focus on the entry when the keyboard chose it", () => {
    const onPointerSelect = vi.fn();
    render(<TabBar onPointerSelect={onPointerSelect} />);

    // Enter or Space on a button: a click with no pointer behind it.
    fireEvent.click(screen.getByRole("button", { name: "Mods" }), { detail: 0 });

    expect(sentCommands()).toContainEqual(selectMods);
    expect(onPointerSelect).not.toHaveBeenCalled();
  });
});
