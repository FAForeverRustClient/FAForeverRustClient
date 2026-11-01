// @vitest-environment happy-dom

import { useState } from "react";
import { readFileSync } from "node:fs";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { Switch } from "./Switch";
import "../testing/mounted";

const baseCss = readFileSync("ui/src/styles.css", "utf8");
const switchCss = readFileSync("ui/src/design-system/switch.css", "utf8");
const checkboxCss = baseCss.slice(baseCss.indexOf('html input[type="checkbox"]'), baseCss.indexOf('html[data-density="compact"]'));

afterEach(() => {
  document.head.querySelectorAll("style[data-switch-regression]").forEach(style => style.remove());
});

it.each([false, true])("keeps switch inputs invisible and full-size regardless of stylesheet order (%s)", switchFirst => {
  const style = document.createElement("style");
  style.dataset.switchRegression = "true";
  style.textContent = switchFirst ? switchCss + checkboxCss : checkboxCss + switchCss;
  document.head.appendChild(style);
  render(<>
    <Switch checked disabled onChange={vi.fn()} label="Friends' games only" />
    <input type="checkbox" disabled aria-label="Ordinary checkbox" />
  </>);
  const hidden = getComputedStyle(screen.getByRole("checkbox", { name: "Friends' games only" }));
  expect(hidden.opacity).toBe("0");
  expect(hidden.width).toBe("100%");
  expect(hidden.height).toBe("100%");
  const ordinary = getComputedStyle(screen.getByRole("checkbox", { name: "Ordinary checkbox" }));
  expect(ordinary.width).toBe("16px");
  expect(ordinary.opacity).toBe("0.5");
});

it("changes an enabled switch by click and keyboard, and keeps a disabled one inactive", async () => {
  const changed = vi.fn();
  function Control({ disabled = false }: { disabled?: boolean }) {
    const [checked, setChecked] = useState(false);
    return <Switch checked={checked} disabled={disabled} label="New games" onChange={next => {
      setChecked(next);
      changed(next);
    }} />;
  }
  const user = userEvent.setup();
  const view = render(<Control />);
  const input = screen.getByRole<HTMLInputElement>("checkbox", { name: "New games" });
  await user.click(input.closest("label")!);
  expect(input.checked).toBe(true);
  await user.click(input);
  expect(input.checked).toBe(false);
  await user.keyboard("[Space]");
  expect(input.checked).toBe(true);
  expect(changed.mock.calls).toEqual([[true], [false], [true]]);
  view.rerender(<Control disabled />);
  await user.click(input);
  expect(changed).toHaveBeenCalledTimes(3);
});
