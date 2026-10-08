// @vitest-environment happy-dom
//
// The tab row's keyboard contract, mounted. `SectionTabs.test.tsx` covers the
// index arithmetic and the static markup; only a mounted row shows the focus
// and the selection moving together, the single tab stop following the
// active tab, and Tab leaving the row for the panel rather than walking it.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { failOnConsoleError } from "../testing/consoleGuard";
import "../testing/mounted";
import { SectionTabs, sectionPanelProps } from "./SectionTabs";

vi.mock("../ipc/client");

failOnConsoleError();

type Section = "options" | "chat" | "mods";

const items = [
  { id: "options", label: "Options" },
  { id: "chat", label: "Chat", count: 3 },
  { id: "mods", label: "Mods" },
] as const;

/** A controlled row over the panel it shows, between two other controls. */
function Harness({ initial, onChange }: { initial: Section | null; onChange: (id: Section) => void }) {
  const [active, setActive] = useState<Section | null>(initial);
  return (
    <>
      <button type="button">Before</button>
      <SectionTabs
        ariaLabel="Sections"
        idPrefix="lobby"
        active={active}
        items={items}
        onChange={(id) => {
          onChange(id);
          setActive(id);
        }}
      />
      {active && (
        <div {...sectionPanelProps("lobby", active)}>
          <p>{active} panel</p>
        </div>
      )}
      <button type="button">After</button>
    </>
  );
}

function mount(initial: Section | null = "chat") {
  const onChange = vi.fn<(id: Section) => void>();
  render(<Harness initial={initial} onChange={onChange} />);
  return { onChange };
}

const tab = (name: string) => screen.getByRole("tab", { name: new RegExp(`^${name}`) });

/** The one tab in the tab order, and which tabs are announced as selected. */
function rowState() {
  const tabs = screen.getAllByRole("tab");
  return {
    tabStops: tabs.filter((element) => element.tabIndex === 0).map((element) => element.textContent),
    selected: tabs
      .filter((element) => element.getAttribute("aria-selected") === "true")
      .map((element) => element.textContent),
  };
}

describe("SectionTabs keyboard, mounted", () => {
  it("is one tab stop, on the active tab rather than the first", async () => {
    const user = userEvent.setup();
    mount("chat");

    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(tab("Chat"));
    expect(rowState()).toEqual({ tabStops: ["Chat3"], selected: ["Chat3"] });

    // Tab leaves the row for the panel the active tab shows, not the next tab.
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("tabpanel", { name: /^Chat/ }));
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(tab("Chat"));
  });

  it("moves focus and selection together with the arrows, wrapping at the ends", async () => {
    const user = userEvent.setup();
    const { onChange } = mount("chat");
    tab("Chat").focus();

    await user.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenLastCalledWith("mods");
    expect(document.activeElement).toBe(tab("Mods"));
    expect(rowState()).toEqual({ tabStops: ["Mods"], selected: ["Mods"] });
    expect(screen.getByRole("tabpanel").textContent).toBe("mods panel");

    // From the last tab, Right comes round to the first.
    await user.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenLastCalledWith("options");
    expect(document.activeElement).toBe(tab("Options"));
    expect(rowState()).toEqual({ tabStops: ["Options"], selected: ["Options"] });

    // And from the first, Left goes round to the last.
    await user.keyboard("{ArrowLeft}");
    expect(onChange).toHaveBeenLastCalledWith("mods");
    expect(document.activeElement).toBe(tab("Mods"));

    await user.keyboard("{ArrowLeft}");
    expect(onChange).toHaveBeenLastCalledWith("chat");
    expect(document.activeElement).toBe(tab("Chat"));
    expect(rowState()).toEqual({ tabStops: ["Chat3"], selected: ["Chat3"] });
    expect(onChange).toHaveBeenCalledTimes(4);
  });

  it("jumps to the first and last tab with Home and End", async () => {
    const user = userEvent.setup();
    const { onChange } = mount("chat");
    tab("Chat").focus();

    await user.keyboard("{End}");
    expect(onChange).toHaveBeenLastCalledWith("mods");
    expect(document.activeElement).toBe(tab("Mods"));
    expect(rowState().tabStops).toEqual(["Mods"]);

    await user.keyboard("{Home}");
    expect(onChange).toHaveBeenLastCalledWith("options");
    expect(document.activeElement).toBe(tab("Options"));
    expect(rowState()).toEqual({ tabStops: ["Options"], selected: ["Options"] });
  });

  it("ties the panel to the active tab as the selection moves", async () => {
    const user = userEvent.setup();
    mount("options");
    tab("Options").focus();

    expect(tab("Options").getAttribute("aria-controls")).toBe("lobby-panel-options");
    expect(screen.getByRole("tabpanel", { name: "Options" }).id).toBe("lobby-panel-options");

    await user.keyboard("{ArrowRight}");
    const panel = screen.getByRole("tabpanel", { name: /^Chat/ });
    expect(panel.id).toBe(tab("Chat").getAttribute("aria-controls"));
  });

  it("leaves the vertical arrows and modified arrows to the page", async () => {
    const user = userEvent.setup();
    const { onChange } = mount("chat");
    tab("Chat").focus();

    await user.keyboard("{ArrowDown}{ArrowUp}");
    await user.keyboard("{Alt>}{ArrowRight}{/Alt}");
    await user.keyboard("{Control>}{ArrowLeft}{/Control}");
    await user.keyboard("{Meta>}{End}{/Meta}");
    expect(onChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(tab("Chat"));
    expect(rowState().selected).toEqual(["Chat3"]);
  });

  it("puts the tab stop on the first tab when none is active, and the arrows start from the focused one", async () => {
    const user = userEvent.setup();
    const { onChange } = mount(null);

    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(tab("Options"));
    expect(rowState()).toEqual({ tabStops: ["Options"], selected: [] });

    await user.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenCalledWith("chat");
    expect(document.activeElement).toBe(tab("Chat"));
  });

  it("selects a tab on Enter or Space as well, the way any button does", async () => {
    const user = userEvent.setup();
    const { onChange } = mount("chat");

    // A tab reached without the arrows (here, focused directly) still answers
    // the keys every button answers.
    tab("Mods").focus();
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenLastCalledWith("mods");
    tab("Options").focus();
    await user.keyboard("[Space]");
    expect(onChange).toHaveBeenLastCalledWith("options");
    expect(rowState().selected).toEqual(["Options"]);
  });
});
