// @vitest-environment happy-dom
//
// The Training tab's two rows of tabs, mounted: the sections across the top
// and the library's kinds. Each tab names the panel it shows
// (`aria-controls`), and that panel is a tab panel named by the tab
// (`aria-labelledby`), so a screen reader can go from one to the other. The
// arrows already moved between the tabs; this is the half of the tabs
// pattern that says what they control.

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { failOnConsoleError } from "../../testing/consoleGuard";
import "../../testing/mounted";
import { TrainingView } from "./TrainingView";
import { useTrainingView } from "./trainingViewState";

vi.mock("../../ipc/client");

failOnConsoleError();

afterEach(() => {
  // The section outlives the view on purpose (see `trainingViewState`), so
  // one test's click must not decide where the next one starts.
  useTrainingView.setState({ section: "hub" });
});

/**
 * The selected tab in `tablist`, and the element its `aria-controls` names,
 * which must be the tab panel that names the tab back.
 */
function selectedTabAndPanel(tablist: HTMLElement) {
  const tab = within(tablist)
    .getAllByRole("tab")
    .find((element) => element.getAttribute("aria-selected") === "true");
  if (!tab) throw new Error("no selected tab");
  const controls = tab.getAttribute("aria-controls");
  expect(controls).toBeTruthy();
  const panel = document.getElementById(controls ?? "");
  expect(panel?.getAttribute("role")).toBe("tabpanel");
  expect(panel?.getAttribute("aria-labelledby")).toBe(tab.id);
  return { tab, panel };
}

describe("TrainingView tabs, mounted", () => {
  it("ties each section tab to the panel under it", async () => {
    const user = userEvent.setup();
    render(<TrainingView />);
    const sections = screen.getByRole("tablist", { name: "Training" });

    for (const name of ["Overview", "Library", "Lessons", "Trainers"]) {
      await user.click(within(sections).getByRole("tab", { name: new RegExp(`^${name}`) }));
      const { tab } = selectedTabAndPanel(sections);
      expect(tab.textContent).toMatch(new RegExp(`^${name}`));
    }
  });

  it("ties the library's kind tabs to the list under them", async () => {
    const user = userEvent.setup();
    render(<TrainingView />);
    await user.click(screen.getByRole("tab", { name: /^Library/ }));

    const kinds = screen.getByRole("tablist", { name: "Type" });
    const { panel } = selectedTabAndPanel(kinds);
    // The kind's list sits inside the section's panel, not in place of it.
    const sectionPanel = selectedTabAndPanel(screen.getByRole("tablist", { name: "Training" })).panel;
    expect(sectionPanel?.contains(panel ?? null)).toBe(true);
  });
});
