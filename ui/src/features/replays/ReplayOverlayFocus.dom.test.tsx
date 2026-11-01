// @vitest-environment happy-dom

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Modal } from "../../design-system/Modal";
import { overlayStack } from "../../design-system/overlayStack";
import type { Game } from "../../ipc/bindings";
import { en } from "../../i18n/catalog/en";
import { failOnConsoleError } from "../../testing/consoleGuard";
import "../../testing/mounted";
import { ReplayInsights } from "./analysis/ReplayInsights";
import { ReplayChartFrame } from "./analysis/ReplayChartFrame";
import { ReplayMapPreviewOverlay } from "./ReplayDetailHero";
import { LiveReplayDetail } from "./live/LiveReplayDetail";

vi.mock("../../ipc/client");
failOnConsoleError();
const originalOffsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetParent");

beforeEach(() => {
  // happy-dom has no layout. These fixtures contain no hidden controls;
  // expose their parent so the shared trap can exercise its visibility check.
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get(this: HTMLElement) { return this.parentElement; },
  });
});
afterEach(() => {
  if (originalOffsetParent) Object.defineProperty(HTMLElement.prototype, "offsetParent", originalOffsetParent);
  else Reflect.deleteProperty(HTMLElement.prototype, "offsetParent");
});

function Insights() {
  const [open, setOpen] = useState(false);
  return (
    <Modal ariaLabel="Replay details" onClose={vi.fn()}>
      <button onClick={() => setOpen(true)}>Open insights</button>
      {open && <ReplayInsights
        details={null} analysis={null} analysisLoading={false} analysisError=""
        teams={[]} title="A replay" loading={false} error="" onClose={() => setOpen(false)}
      />}
    </Modal>
  );
}

function Chart() {
  const [zoomed, setZoomed] = useState(false);
  return (
    <Modal ariaLabel="Replay details" onClose={vi.fn()}>
      <Modal ariaLabel="Replay analysis" onClose={vi.fn()}>
        <ReplayChartFrame title="Activity graph" zoomed={zoomed} onZoom={setZoomed}>
          <button>Chart control</button>
        </ReplayChartFrame>
      </Modal>
    </Modal>
  );
}

function RecordedMap() {
  const [open, setOpen] = useState(false);
  return (
    <Modal ariaLabel="Replay details" onClose={vi.fn()}>
      <button onClick={() => setOpen(true)}>Open map</button>
      {open && <ReplayMapPreviewOverlay
        mapThumbnailUrl="" effectiveMap="scmp_009" mapLabel="A map" cardTitle="A replay"
        copiedMapName={false} onCopyMapName={vi.fn()} onClose={() => setOpen(false)}
      />}
    </Modal>
  );
}

const live: Game = {
  id: 42, title: "Live game", map: "scmp_009", host: "Host", players: 2, maxPlayers: 2,
  modName: "faf", averageRating: 1500, ratingType: "global", passwordProtected: false,
  visibility: "public", gameType: "custom", launchedAt: null, hostedAt: null,
  ratingMin: null, ratingMax: null, enforceRatingRange: false, teams: {}, simMods: {},
};

describe("replay overlay focus", () => {
  it("moves focus into insights, contains Tab and returns to its opener on Escape", async () => {
    const user = userEvent.setup();
    render(<Insights />);
    const opener = screen.getByRole("button", { name: "Open insights" });
    await user.click(opener);
    const insights = screen.getByRole("dialog", { name: "What the replay file says about A replay" });
    expect(insights.contains(document.activeElement)).toBe(true);
    expect(overlayStack.topFocusTrap()?.element?.()).toBe(insights);
    const tab = within(insights).getByRole("tab", { selected: true });
    tab.focus();
    await user.tab();
    expect(insights.contains(document.activeElement)).toBe(true);
    // The loading panel is a Tab stop; inactive tab buttons are not.
    const graph = within(insights).getByRole("tab", { name: en["replays.insights.graph"] });
    await user.click(graph);
    await user.tab();
    const panel = within(insights).getByRole("tabpanel");
    expect(document.activeElement).toBe(panel);
    await user.tab();
    expect(document.activeElement).toBe(within(insights).getByRole("button", { name: "Close" }));
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(panel);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(graph);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "What the replay file says about A replay" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Replay details" })).toBeTruthy();
    expect(document.activeElement).toBe(opener);
  });

  it("contains a portalled chart above both parent dialogs and restores its enlarge button", async () => {
    const user = userEvent.setup();
    render(<Chart />);
    const opener = screen.getByRole("button", { name: "Enlarge: Activity graph" });
    await user.click(opener);
    const chart = screen.getByRole("dialog", { name: "Activity graph" });
    expect(chart.contains(document.activeElement)).toBe(true);
    expect(overlayStack.topFocusTrap()?.element?.()).toBe(chart);
    const control = within(chart).getByRole("button", { name: "Chart control" });
    expect(screen.getAllByRole("button", { name: "Chart control" })).toHaveLength(1);
    control.focus();
    await user.tab();
    expect(document.activeElement).toBe(within(chart).getByRole("button", { name: "Close" }));
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(control);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Activity graph" })).toBeNull();
    expect(screen.getAllByRole("dialog")).toHaveLength(2);
    expect(document.activeElement).toBe(opener);
  });

  it("gives the recorded map its own focus scope and restores the replay opener", async () => {
    const user = userEvent.setup();
    render(<RecordedMap />);
    const opener = screen.getByRole("button", { name: "Open map" });
    await user.click(opener);
    const preview = screen.getByRole("dialog", { name: "Enlarge the A map preview" });
    expect(preview.contains(document.activeElement)).toBe(true);
    expect(overlayStack.topFocusTrap()?.element?.()).toBe(preview);
    await user.keyboard("{Escape}");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(document.activeElement).toBe(opener);
  });

  it("gives a live map its own focus scope without closing the live game", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<LiveReplayDetail game={live} busy={false} tracking={null} waitSeconds={0} onClose={onClose} onPlayerMenu={vi.fn()} />);
    const opener = screen.getByRole("button", { name: /^Enlarge the .* preview$/ });
    await user.click(opener);
    const preview = screen.getByRole("dialog", { name: /^Enlarge the .* preview$/ });
    expect(preview.contains(document.activeElement)).toBe(true);
    expect(overlayStack.topFocusTrap()?.element?.()).toBe(preview);
    await user.keyboard("{Escape}");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(opener);
  });
});
