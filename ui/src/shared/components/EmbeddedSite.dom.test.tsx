// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import type { Window } from "happy-dom";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { EmbeddedSite } from "./EmbeddedSite";
import "../../testing/mounted";

const { openUrl } = vi.hoisted(() => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../ipc/native", () => ({ native: { openUrl } }));
vi.mock("../webviewEngine", () => ({ isDesktopShell: () => true }));
vi.mock("../../ipc/client");

// This test never loads the real database or opens the operating system browser.
const navigation = (window as unknown as Window).happyDOM.settings.navigation;
navigation.disableChildFrameNavigation = true;
navigation.disableChildPageNavigation = true;
navigation.disableMainFrameNavigation = true;
navigation.disableFallbackToSetURL = true;
afterEach(() => vi.clearAllMocks());

const script = readFileSync("src-tauri/src/unit_database_embed.js", "utf8");
const databaseUrl = "https://unitdb.faforever.com/";
const forumLink = "https://forum.faforever.com/post/72705";
const message = { type: "faf:open-external-link", url: forumLink };

it("opens a support-link click through the trusted frame bridge instead of a popup", async () => {
  const view = render(<EmbeddedSite url={databaseUrl} title="Unit database" />);
  const frame = view.getByTitle("Unit database") as HTMLIFrameElement;
  const databaseDocument = document.implementation.createHTMLDocument();
  const postMessage = vi.fn((data: unknown) => {
    window.dispatchEvent(new MessageEvent("message", {
      data, origin: new URL(databaseUrl).origin, source: frame.contentWindow,
    }));
  });
  const databaseWindow = {
    location: new URL(databaseUrl), top: { postMessage },
  };
  runInNewContext(script, { window: databaseWindow, document: databaseDocument, Element });
  runInNewContext(script, { window: databaseWindow, document: databaseDocument, Element });

  // The Vue component mounts after the initialization script; its text is nested.
  databaseDocument.body.innerHTML = `<a href="${forumLink}" target="_blank"><span>Support the author</span></a>`;
  const click = new MouseEvent("click", { button: 0, bubbles: true, cancelable: true });
  fireEvent(databaseDocument.querySelector("span")!, click);

  await waitFor(() => expect(openUrl).toHaveBeenCalledExactlyOnceWith(forumLink));
  expect(click.defaultPrevented).toBe(true);
  expect(postMessage).toHaveBeenCalledExactlyOnceWith(message, "*");
});

it("leaves unrelated database links and already-cancelled clicks alone", () => {
  const databaseDocument = document.implementation.createHTMLDocument();
  const postMessage = vi.fn();
  runInNewContext(script, {
    window: { location: new URL(databaseUrl), top: { postMessage } },
    document: databaseDocument, Element,
  });

  for (const href of ["#/units/UAL0001", "https://forum.faforever.com/topic/1", "https://example.org/"]) {
    databaseDocument.body.innerHTML = `<a href="${href}">Other link</a>`;
    const click = new MouseEvent("click", { button: 0, bubbles: true, cancelable: true });
    fireEvent(databaseDocument.querySelector("a")!, click);
    expect(click.defaultPrevented).toBe(false);
  }
  databaseDocument.body.innerHTML = `<a href="${forumLink}">Support the author</a>`;
  const click = new MouseEvent("click", { button: 0, bubbles: true, cancelable: true });
  click.preventDefault();
  fireEvent(databaseDocument.querySelector("a")!, click);
  expect(postMessage).not.toHaveBeenCalled();
});

it.each([
  { origin: "https://unitdb.faforever.com.example.com", currentFrame: true },
  { origin: "https://www.faforever.com", currentFrame: true },
  { origin: "https://unitdb.faforever.com", currentFrame: false },
])("rejects a link message from the wrong origin or frame: %j", ({ origin, currentFrame }) => {
  const view = render(<EmbeddedSite url={databaseUrl} title="Unit database" />);
  const frame = view.getByTitle("Unit database") as HTMLIFrameElement;
  window.dispatchEvent(new MessageEvent("message", {
    data: message, origin, source: currentFrame ? frame.contentWindow : window,
  }));
  expect(openUrl).not.toHaveBeenCalled();
});
