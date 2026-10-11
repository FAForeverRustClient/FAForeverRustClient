import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SectionTabs, nextTabIndex, sectionPanelProps, sectionTabId } from "./SectionTabs";

const items = [
  { id: "options", label: "Options" },
  { id: "chat", label: "Chat" },
  { id: "mods", label: "Mods" },
] as const;

describe("SectionTabs", () => {
  it("moves with the arrows and wraps at the ends", () => {
    expect(nextTabIndex("ArrowRight", 0, 3)).toBe(1);
    expect(nextTabIndex("ArrowLeft", 1, 3)).toBe(0);
    expect(nextTabIndex("ArrowRight", 2, 3)).toBe(0);
    expect(nextTabIndex("ArrowLeft", 0, 3)).toBe(2);
  });

  it("jumps to the ends with Home and End", () => {
    expect(nextTabIndex("Home", 2, 3)).toBe(0);
    expect(nextTabIndex("End", 0, 3)).toBe(2);
  });

  it("leaves other keys to the page", () => {
    for (const key of ["ArrowDown", "ArrowUp", "Enter", " ", "Tab"]) {
      expect(nextTabIndex(key, 1, 3)).toBeNull();
    }
    expect(nextTabIndex("ArrowRight", 0, 0)).toBeNull();
  });

  it("is one tab stop, on the active tab", () => {
    const markup = renderToStaticMarkup(
      <SectionTabs active="chat" ariaLabel="Sections" items={items} onChange={() => {}} />,
    );
    expect(markup.match(/tabindex="0"/g)).toHaveLength(1);
    expect(markup.match(/tabindex="-1"/g)).toHaveLength(2);
    expect(markup).toMatch(/aria-selected="true"[^>]*tabindex="0"/);
  });

  it("puts the tab stop on the first tab when none is active", () => {
    const markup = renderToStaticMarkup(
      <SectionTabs active={null} ariaLabel="Sections" items={items} onChange={() => {}} />,
    );
    expect(markup.indexOf('tabindex="0"')).toBeLessThan(markup.indexOf("Chat"));
  });

  it("points tabs at their panels only when the caller labels them", () => {
    const bare = renderToStaticMarkup(
      <SectionTabs active="chat" ariaLabel="Sections" items={items} onChange={() => {}} />,
    );
    expect(bare).not.toContain("aria-controls");

    const wired = renderToStaticMarkup(
      <SectionTabs active="chat" ariaLabel="Sections" items={items} onChange={() => {}} idPrefix="insights" />,
    );
    expect(wired).toContain('id="insights-tab-chat"');
    expect(wired).toContain('aria-controls="insights-panel-chat"');
  });

  it("labels a panel by its tab", () => {
    expect(sectionPanelProps("insights", "chat")).toEqual({
      id: "insights-panel-chat",
      role: "tabpanel",
      "aria-labelledby": sectionTabId("insights", "chat"),
      tabIndex: 0,
    });
  });
});
