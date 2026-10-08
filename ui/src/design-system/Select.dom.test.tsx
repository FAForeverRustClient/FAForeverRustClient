// @vitest-environment happy-dom
//
// The dropdown's keyboard contract, mounted. `Select.test.tsx` covers the
// index arithmetic and the closed markup; only a mounted list shows which key
// opens it, which option `aria-activedescendant` points at as the keys walk,
// what reaches `onChange`, where focus is once it closes, and that Escape
// inside a dialog closes the list and leaves the dialog alone.
//
// Not covered here, because happy-dom has no layout: keeping the highlighted
// option scrolled into view (`scrollIntoView` is a no-op), and where the
// popover is drawn.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { failOnConsoleError } from "../testing/consoleGuard";
import "../testing/mounted";
import { Modal } from "./Modal";
import { overlayStack } from "./overlayStack";
import { Select, type SelectOption } from "./Select";

vi.mock("../ipc/client");

failOnConsoleError();

const options: SelectOption<string>[] = [
  { value: "alpha", label: "Alpha" },
  { value: "beta", label: "Beta", disabled: true },
  { value: "gamma", label: "Gamma" },
  { value: "delta", label: "Delta" },
];

/** A controlled select between two other controls, the way a form holds one. */
function Harness({ initial = "gamma", onChange }: { initial?: string; onChange: (value: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <button type="button">Before</button>
      <Select
        label="Mode"
        value={value}
        options={options}
        onChange={(next) => {
          onChange(next);
          setValue(next);
        }}
      />
      <button type="button">After</button>
    </>
  );
}

function mount(initial?: string) {
  const onChange = vi.fn<(value: string) => void>();
  render(<Harness initial={initial} onChange={onChange} />);
  return { onChange, trigger: screen.getByRole("combobox", { name: "Mode" }) };
}

/** The label of the option the trigger currently points assistive tech at. */
function highlighted(trigger: HTMLElement): string | null {
  const id = trigger.getAttribute("aria-activedescendant");
  return id === null ? null : (document.getElementById(id)?.textContent ?? null);
}

describe("Select keyboard, mounted", () => {
  it("opens on Enter onto the current value, with focus staying on the trigger", async () => {
    const user = userEvent.setup();
    const { onChange, trigger } = mount();

    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    await user.keyboard("{Enter}");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const list = screen.getByRole("listbox");
    expect(trigger.getAttribute("aria-controls")).toBe(list.id);
    expect(highlighted(trigger)).toBe("Gamma");
    expect(screen.getByRole("option", { name: "Gamma" }).getAttribute("aria-selected")).toBe("true");
    // The select-only combobox keeps focus on the trigger the whole time.
    expect(document.activeElement).toBe(trigger);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("opens on Space and on either arrow without moving off the current value", async () => {
    const user = userEvent.setup();
    const { onChange, trigger } = mount();
    trigger.focus();

    for (const key of ["[Space]", "{ArrowDown}", "{ArrowUp}"]) {
      await user.keyboard(key);
      expect(trigger.getAttribute("aria-expanded"), key).toBe("true");
      expect(highlighted(trigger), key).toBe("Gamma");
      await user.keyboard("{Escape}");
      expect(trigger.getAttribute("aria-expanded"), key).toBe("false");
    }
    expect(onChange).not.toHaveBeenCalled();
  });

  it("walks the enabled options with the arrows, Home and End, stopping at the ends", async () => {
    const user = userEvent.setup();
    const { trigger } = mount();
    trigger.focus();
    await user.keyboard("{Enter}");

    await user.keyboard("{ArrowDown}");
    expect(highlighted(trigger)).toBe("Delta");
    // The last option: Down stays there rather than wrapping to the top.
    await user.keyboard("{ArrowDown}");
    expect(highlighted(trigger)).toBe("Delta");

    await user.keyboard("{ArrowUp}");
    expect(highlighted(trigger)).toBe("Gamma");
    // Beta is disabled, so Up steps over it.
    await user.keyboard("{ArrowUp}");
    expect(highlighted(trigger)).toBe("Alpha");
    await user.keyboard("{ArrowUp}");
    expect(highlighted(trigger)).toBe("Alpha");

    await user.keyboard("{End}");
    expect(highlighted(trigger)).toBe("Delta");
    await user.keyboard("{Home}");
    expect(highlighted(trigger)).toBe("Alpha");
    expect(document.activeElement).toBe(trigger);
  });

  it("commits the highlighted option on Enter, closes, and keeps focus on the trigger", async () => {
    const user = userEvent.setup();
    const { onChange, trigger } = mount();
    trigger.focus();

    await user.keyboard("{Enter}{Home}{Enter}");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("alpha");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(trigger.getAttribute("aria-activedescendant")).toBeNull();
    expect(trigger.textContent).toBe("Alpha");
    expect(document.activeElement).toBe(trigger);

    // Opening again starts from the new value.
    await user.keyboard("{ArrowDown}");
    expect(highlighted(trigger)).toBe("Alpha");
  });

  it("commits on Space and on Alt+ArrowUp as well", async () => {
    const user = userEvent.setup();
    const { onChange, trigger } = mount();
    trigger.focus();

    await user.keyboard("[Space]{ArrowDown}[Space]");
    expect(onChange).toHaveBeenLastCalledWith("delta");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    await user.keyboard("{ArrowDown}{Home}{Alt>}{ArrowUp}{/Alt}");
    expect(onChange).toHaveBeenLastCalledWith("alpha");
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on Escape without committing, and leaves the overlay stack empty", async () => {
    const user = userEvent.setup();
    const { onChange, trigger } = mount();
    trigger.focus();

    await user.keyboard("{Enter}{Home}");
    expect(overlayStack.size()).toBe(1);
    await user.keyboard("{Escape}");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger.textContent).toBe("Gamma");
    expect(document.activeElement).toBe(trigger);
    expect(overlayStack.size()).toBe(0);
  });

  it("closes without committing when Tab moves focus on, and the next control gets it", async () => {
    const user = userEvent.setup();
    const { onChange, trigger } = mount();
    trigger.focus();

    await user.keyboard("{Enter}{Home}");
    await user.tab();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "After" }));
    expect(onChange).not.toHaveBeenCalled();

    // Keys pressed on the next control no longer drive the closed list.
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps focus on the trigger when an option is clicked", async () => {
    const user = userEvent.setup();
    const { onChange, trigger } = mount();

    await user.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    await user.click(screen.getByRole("option", { name: "Delta" }));
    expect(onChange).toHaveBeenCalledWith("delta");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  it("starts on the first enabled option when the current value is disabled", async () => {
    const user = userEvent.setup();
    const { trigger } = mount("beta");
    trigger.focus();

    await user.keyboard("{Enter}");
    expect(highlighted(trigger)).toBe("Alpha");
  });

  it("inside a dialog, gives Escape to the open list first and the dialog only on the next press", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onChange = vi.fn();
    render(
      <Modal ariaLabel="Options" onClose={onClose}>
        <Select label="Mode" value="gamma" options={options} onChange={onChange} />
      </Modal>,
    );
    const trigger = screen.getByRole("combobox", { name: "Mode" });
    // The dialog put focus on its first control, which is the trigger.
    expect(document.activeElement).toBe(trigger);

    await user.keyboard("{Enter}");
    expect(overlayStack.size()).toBe(2);
    await user.keyboard("{Escape}");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Options" })).toBeDefined();
    expect(document.activeElement).toBe(trigger);
    expect(overlayStack.size()).toBe(1);

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });
});
