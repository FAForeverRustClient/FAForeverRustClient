import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { FAF_LOGO_URL } from "./shared/branding";
import { installDesktopContextMenuPolicy } from "./shared/contextMenuPolicy";
import "./styles.css";
import "./design-system/patterns.css";
import "./design-system/vault.css";
import "./design-system/pagination.css";

const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
if (favicon) favicon.href = FAF_LOGO_URL;

installDesktopContextMenuPolicy(document);

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
