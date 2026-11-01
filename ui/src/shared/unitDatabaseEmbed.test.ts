import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const script = readFileSync("src-tauri/src/unit_database_embed.js", "utf8");
const forumLink = "https://forum.faforever.com/post/72705";
const originalLink = "https://boosty.to/etfreeman";

interface DatabaseFrame {
  location: { origin: string };
  top?: unknown;
  authorLinkOverride?: string;
  authorLink?: unknown;
}

function frame(url = "https://unitdb.faforever.com/#/", embedded = true): DatabaseFrame {
  const window: DatabaseFrame = { location: { origin: new URL(url).origin } };
  window.top = embedded ? {} : window;
  return window;
}

function initialize(window: DatabaseFrame): void {
  runInNewContext(script, { window, document: { addEventListener() {} } });
}

describe("the embedded unit database's author link", () => {
  it("sets the override before the database creates its support component", () => {
    const window = frame();
    initialize(window);
    expect(window.authorLinkOverride).toBe(forumLink);
    // The database still creates and owns its reactive reference.
    expect(window.authorLink).toBeUndefined();
  });

  it("updates an existing reactive reference without replacing it", () => {
    const window = frame();
    const reference = { value: originalLink };
    window.authorLink = reference;
    initialize(window);
    expect(window.authorLinkOverride).toBe(forumLink);
    expect(window.authorLink).toBe(reference);
    expect(reference.value).toBe(forumLink);
  });

  it("overrides an existing donation override and is safe to run again", () => {
    const window = frame();
    window.authorLinkOverride = originalLink;
    initialize(window);
    initialize(window);
    expect(window.authorLinkOverride).toBe(forumLink);
  });

  it.each([undefined, null, "not a reference"])("tolerates a missing or unrelated ref: %s", (value) => {
    const window = frame();
    window.authorLink = value;
    initialize(window);
    expect(window.authorLinkOverride).toBe(forumLink);
    expect(window.authorLink).toBe(value);
  });

  it.each([
    "https://www.faforever.com/newshub",
    "http://localhost:5173/",
    "http://tauri.localhost/",
    "https://unitdb.faforever.com.example.com/",
    "http://unitdb.faforever.com/",
    "https://unitdb.faforever.com:8443/",
  ])("leaves other pages untouched: %s", (url) => {
    const window = frame(url);
    window.authorLinkOverride = originalLink;
    const reference = { value: originalLink };
    window.authorLink = reference;
    initialize(window);
    expect(window.authorLinkOverride).toBe(originalLink);
    expect(reference.value).toBe(originalLink);
  });

  it("does not change the database when opened as a top-level page", () => {
    const window = frame("https://unitdb.faforever.com/#/", false);
    initialize(window);
    expect(window.authorLinkOverride).toBeUndefined();
  });
});
