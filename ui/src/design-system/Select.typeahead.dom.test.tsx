// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Select } from "./Select";

afterEach(cleanup);
const options = [
  { value: "alpha", label: "Alpha" },
  { value: "beta", label: "Beta", disabled: true },
  { value: "berlin", label: "Berlin" },
  { value: "boston", label: "Boston" },
  { value: "cape", label: "Cape Town" },
];
const highlighted = () => document.getElementById(screen.getByRole("combobox").getAttribute("aria-activedescendant") ?? "")?.textContent;

describe("Select type-ahead", () => {
  it("opens, skips disabled matches, cycles repeated letters and commits only on Enter", () => {
    const change = vi.fn();
    render(<Select value="alpha" options={options} onChange={change} />);
    const trigger = screen.getByRole("combobox");
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "b" });
    expect(highlighted()).toBe("Berlin");
    fireEvent.keyDown(trigger, { key: "b" });
    expect(highlighted()).toBe("Boston");
    fireEvent.keyDown(trigger, { key: "b" });
    expect(highlighted()).toBe("Berlin");
    expect(change).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(change).toHaveBeenCalledWith("berlin");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("matches multiword prefixes and expires the previous search", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    render(<Select value="alpha" options={options} onChange={() => { }} />);
    const trigger = screen.getByRole("combobox");
    for (const key of "cape t") fireEvent.keyDown(trigger, { key });
    expect(highlighted()).toBe("Cape Town");
    now.mockReturnValue(2000);
    fireEvent.keyDown(trigger, { key: "b" });
    expect(highlighted()).toBe("Berlin");
    now.mockRestore();
  });

  it("opens at Home/End and leaves shortcuts and the next field alone", () => {
    render(<Select value="berlin" options={options} onChange={() => { }} />);
    const trigger = screen.getByRole("combobox");
    fireEvent.keyDown(trigger, { key: "b", ctrlKey: true });
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.keyDown(trigger, { key: "End" });
    expect(highlighted()).toBe("Cape Town");
    fireEvent.keyDown(trigger, { key: "Tab" });
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.keyDown(trigger, { key: "Home" });
    expect(highlighted()).toBe("Alpha");
  });
});
