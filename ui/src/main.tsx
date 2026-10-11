import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AppErrorBoundary } from "./shared/components/ErrorBoundary";
import { FAF_LOGO_URL } from "./shared/branding";
import { installDesktopContextMenuPolicy } from "./shared/contextMenuPolicy";
import { installStallReporter } from "./shared/stallReporter";
import { loadSystemDatePattern } from "./shared/format/systemDate";
import "./styles.css";
import "./design-system/patterns.css";
import "./design-system/vault.css";
import "./design-system/pagination.css";
import "./design-system/resize-handle.css";
import "./design-system/list-head.css";

const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
if (favicon) favicon.href = FAF_LOGO_URL;

installDesktopContextMenuPolicy(document);
installStallReporter();

// Fixed-viewport desktop app: lock document scroll coordinates to 0,0
// to prevent any native browser focus actions from scrolling the root window.
window.addEventListener("scroll", () => {
  if (window.scrollX !== 0 || window.scrollY !== 0) {
    window.scrollTo(0, 0);
  }
});

// Before the first render, so no date is drawn in one order and then redrawn
// in the other. It is one synchronous call in the shell and never rejects.
void loadSystemDatePattern().then(() => {
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <AppErrorBoundary>
        <App />
      </AppErrorBoundary>
    </React.StrictMode>,
  );
});
