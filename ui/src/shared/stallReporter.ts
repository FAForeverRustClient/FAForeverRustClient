// Tells the client log when the page was too busy to answer a click.
//
// A tab that would not change for ten seconds left nothing behind: the backend
// log can say a command waited, but not that the page itself was busy drawing.
// The browser reports every task that held the main thread for 50 ms or more;
// this adds them up over a few seconds and writes one line when they come to
// enough that a click would have waited, with the tab that was open.

import { ipc } from "../ipc/client";
import { useAppStore } from "../store/store";

/** How often the busy time is added up and judged. */
const WINDOW_MS = 5_000;

/** Busy time within one window worth a line: clicks were waiting by then. */
const REPORT_ABOVE_MS = 1_500;

export function installStallReporter(): void {
  if (typeof PerformanceObserver === "undefined") return;
  if (!PerformanceObserver.supportedEntryTypes?.includes("longtask")) return;

  let busy = 0;
  let longest = 0;
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      busy += entry.duration;
      longest = Math.max(longest, entry.duration);
    }
  }).observe({ type: "longtask" });

  window.setInterval(() => {
    if (busy >= REPORT_ABOVE_MS) {
      const nav = useAppStore.getState().state.nav;
      const place = nav.activeTab === "replays" ? `replays/${nav.replaysSection}` : nav.activeTab;
      ipc.reportStall(busy, longest, place);
    }
    busy = 0;
    longest = 0;
  }, WINDOW_MS);
}
