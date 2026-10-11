import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Select, nextSelectIndex, selectOptionId } from "./Select";

const options = [
  { value: "a", label: "A" },
  { value: "b", label: "B", disabled: true },
  { value: "c", label: "C" },
  { value: "d", label: "D" },
];

describe("Select keyboard navigation", () => {
  it("steps over disabled options", () => {
    expect(nextSelectIndex(options, 0, "ArrowDown")).toBe(2);
    expect(nextSelectIndex(options, 2, "ArrowUp")).toBe(0);
  });

  it("stops at the ends rather than wrapping", () => {
    expect(nextSelectIndex(options, 3, "ArrowDown")).toBe(3);
    expect(nextSelectIndex(options, 0, "ArrowUp")).toBe(0);
  });

  it("jumps to the first and last enabled option", () => {
    const fenced = [{ disabled: true }, {}, {}, { disabled: true }];
    expect(nextSelectIndex(fenced, 2, "Home")).toBe(1);
    expect(nextSelectIndex(fenced, 1, "End")).toBe(2);
  });

  it("starts from the matching end when nothing is highlighted", () => {
    expect(nextSelectIndex(options, -1, "ArrowDown")).toBe(0);
    expect(nextSelectIndex(options, -1, "ArrowUp")).toBe(3);
  });

  it("ignores keys it does not navigate with, and lists with nothing to pick", () => {
    for (const key of ["Escape", "Tab", "Enter", " ", "a"]) {
      expect(nextSelectIndex(options, 1, key)).toBeNull();
    }
    expect(nextSelectIndex([{ disabled: true }], -1, "ArrowDown")).toBeNull();
  });

  it("gives every option its own id", () => {
    expect(selectOptionId("x", 0)).not.toBe(selectOptionId("x", 1));
  });

  it("renders a closed combobox with nothing for assistive tech to point at", () => {
    const markup = renderToStaticMarkup(
      <Select value="c" onChange={() => {}} options={options} label="Mode" />,
    );
    expect(markup).toContain('role="combobox"');
    expect(markup).toContain('aria-haspopup="listbox"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).not.toContain("aria-activedescendant");
    expect(markup).not.toContain('role="listbox"');
    expect(markup).toContain(">C<");
  });
});
