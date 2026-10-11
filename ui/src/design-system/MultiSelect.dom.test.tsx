// @vitest-environment happy-dom
//
// The checkbox dropdown from the keyboard, mounted. It has no key handling of
// its own beyond Escape: the trigger is a button and each entry a checkbox, so
// Enter and Space open it and Tab and Space work through it the way they work
// anywhere. What it does own is Escape, through the overlay stack, and where
// focus goes when Escape takes the checkbox that had it away.

import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { failOnConsoleError } from "../testing/consoleGuard";
import "../testing/mounted";
import { Modal } from "./Modal";
import { MultiSelect, type MultiSelectOption } from "./MultiSelect";
import { overlayStack } from "./overlayStack";

vi.mock("../ipc/client");

failOnConsoleError();

const options: MultiSelectOption[] = [
  { value: "faf", label: "FAF" },
  { value: "nomads", label: "Nomads", detail: "12" },
  { value: "coop", label: "Co-op" },
];

function Harness({ onChange }: { onChange: (selected: string[]) => void }) {
  const [selected, setSelected] = useState<string[]>([]);
  return (
    <MultiSelect
      label="Mods"
      options={options}
      selected={selected}
      onChange={(next) => {
        onChange(next);
        setSelected(next);
      }}
    />
  );
}

function mount() {
  const onChange = vi.fn<(selected: string[]) => void>();
  render(<Harness onChange={onChange} />);
  return { onChange, trigger: screen.getByRole("button", { name: /^Mods:/ }) };
}

describe("MultiSelect keyboard, mounted", () => {
  it("opens on Enter and on Space, and closes on them again from the trigger", async () => {
    const user = userEvent.setup();
    const { trigger } = mount();
    trigger.focus();

    await user.keyboard("{Enter}");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("group", { name: "Mods" })).toBeDefined();
    await user.keyboard("{Enter}");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    await user.keyboard("[Space]");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    await user.keyboard("[Space]");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("group", { name: "Mods" })).toBeNull();
  });

  it("toggles entries with Tab and Space, and the trigger sums them up", async () => {
    const user = userEvent.setup();
    const { onChange, trigger } = mount();
    trigger.focus();
    await user.keyboard("{Enter}");

    const group = screen.getByRole("group", { name: "Mods" });
    await user.tab();
    expect(document.activeElement).toBe(within(group).getByRole("checkbox", { name: "FAF" }));
    await user.keyboard("[Space]");
    expect(onChange).toHaveBeenLastCalledWith(["faf"]);
    expect(trigger.getAttribute("aria-label")).toBe("Mods: FAF");

    await user.tab();
    await user.keyboard("[Space]");
    expect(onChange).toHaveBeenLastCalledWith(["faf", "nomads"]);
    expect(trigger.getAttribute("aria-label")).toBe("Mods: 2 selected");

    // Space again takes it back off.
    await user.keyboard("[Space]");
    expect(onChange).toHaveBeenLastCalledWith(["faf"]);
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it("closes on Escape from a checkbox and puts focus back on the trigger", async () => {
    const user = userEvent.setup();
    const { onChange, trigger } = mount();
    trigger.focus();
    await user.keyboard("{Enter}");
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("checkbox", { name: /^Nomads/ }));
    expect(overlayStack.size()).toBe(1);

    await user.keyboard("{Escape}");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("checkbox")).toBeNull();
    // Not dropped onto the page with the checkbox that had it.
    expect(document.activeElement).toBe(trigger);
    expect(overlayStack.size()).toBe(0);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("clears every entry from the keyboard with the clear button", async () => {
    const user = userEvent.setup();
    const { onChange, trigger } = mount();
    trigger.focus();
    await user.keyboard("{Enter}");
    await user.tab();
    await user.keyboard("[Space]");
    await user.tab();
    await user.keyboard("[Space]");

    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Clear selection" }));
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenLastCalledWith([]);
    expect(trigger.getAttribute("aria-label")).toBe("Mods: Any");
  });

  it("closes when Tab moves focus on past it, so a later Escape leaves focus where it is", async () => {
    const user = userEvent.setup();
    render(
      <>
        <Harness onChange={() => undefined} />
        <button type="button">After</button>
      </>,
    );
    const trigger = screen.getByRole("button", { name: /^Mods:/ });
    const after = screen.getByRole("button", { name: "After" });
    trigger.focus();
    await user.keyboard("{Enter}");

    // Back onto the trigger from the first entry is still inside the control.
    await user.tab();
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    // Through the three entries and on to the next control.
    await user.tab();
    await user.tab();
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(after);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(overlayStack.size()).toBe(0);

    // Left open, the list stayed on top of the overlay stack, and this Escape,
    // pressed on another control, closed it and pulled focus back to its
    // trigger.
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(after);
  });

  it("stays open when focus moves to nothing in particular, which a press inside it can do", async () => {
    const user = userEvent.setup();
    const { trigger } = mount();
    trigger.focus();
    await user.keyboard("{Enter}");
    await user.tab();

    // What a press on the popover's padding does in a browser: the checkbox
    // loses focus and nothing else receives it.
    act(() => (document.activeElement as HTMLElement).blur());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("inside a dialog, gives Escape to the open list first and the dialog only on the next press", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Modal ariaLabel="Filters" onClose={onClose}>
        <Harness onChange={() => undefined} />
      </Modal>,
    );
    const trigger = screen.getByRole("button", { name: /^Mods:/ });
    expect(document.activeElement).toBe(trigger);

    await user.keyboard("{Enter}");
    // Focused directly rather than tabbed to: the dialog keeps Tab inside it by
    // looking for visible controls through `offsetParent`, which happy-dom,
    // having no layout, never sets.
    screen.getByRole("checkbox", { name: "FAF" }).focus();
    expect(overlayStack.size()).toBe(2);
    await user.keyboard("{Escape}");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
