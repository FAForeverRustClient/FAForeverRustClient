// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

// Execute the actual script embedded by the native window builder.
const script = readFileSync("src-tauri/src/unit_database_embed.js", "utf8");

function page(url = "https://unitdb.faforever.com/", embedded = true) {
  const window = new Window({ url });
  const frame: { location: URL; top?: unknown } = { location: new URL(url) };
  frame.top = embedded ? {} : frame;
  const run = () => { runInNewContext(script, { window: frame, document: window.document }); };
  return { window, document: window.document, run };
}

function supportBlock(document: Window["document"]) {
  const block = document.createElement("div");
  block.className = "author";
  block.innerHTML = '<a class="author__link" href="https://boosty.to/etfreeman">support<br>the author</a>';
  document.body.appendChild(block);
  return block;
}

describe("the unit database's embedded support control", () => {
  it("hides both support blocks while keeping search and other links visible", () => {
    const { window, document, run } = page();
    const desktop = supportBlock(document);
    const mobile = supportBlock(document);
    mobile.classList.add("app__author");
    const search = document.createElement("input");
    const link = document.createElement("a");
    link.href = "https://forum.faforever.com/";
    link.textContent = "Feedback";
    document.body.append(search, link);
    run();
    expect(window.getComputedStyle(desktop).display).toBe("none");
    expect(window.getComputedStyle(mobile).display).toBe("none");
    expect(window.getComputedStyle(search).display).not.toBe("none");
    expect(window.getComputedStyle(link).display).not.toBe("none");
    expect(link.getAttribute("href")).toBe("https://forum.faforever.com/");
  });

  it("also hides support controls mounted after the page initializes", () => {
    const { window, document, run } = page();
    run();
    expect(window.getComputedStyle(supportBlock(document)).display).toBe("none");
  });

  it.each([
    "https://www.faforever.com/newshub",
    "http://localhost:5173/",
    "http://tauri.localhost/",
    "https://unitdb.faforever.com.example.com/",
    "https://example.com/unitdb.faforever.com/",
    "http://unitdb.faforever.com/",
  ])("does not change another page: %s", (url) => {
    const { window, document, run } = page(url);
    const block = supportBlock(document);
    run();
    expect(window.getComputedStyle(block).display).not.toBe("none");
    expect(document.querySelector("style")).toBeNull();
  });

  it("does not change the unit database when it is not embedded", () => {
    const { window, document, run } = page("https://unitdb.faforever.com/", false);
    const block = supportBlock(document);
    run();
    expect(window.getComputedStyle(block).display).not.toBe("none");
    expect(document.querySelector("style")).toBeNull();
  });

  it("waits for a document root if the native initialization runs before it exists", () => {
    const { window, document, run } = page();
    document.documentElement.remove();
    run();
    const root = document.createElement("html");
    root.innerHTML = "<head></head><body></body>";
    document.appendChild(root);
    const block = supportBlock(document);
    document.dispatchEvent(new window.Event("DOMContentLoaded"));
    document.dispatchEvent(new window.Event("DOMContentLoaded"));
    expect(window.getComputedStyle(block).display).toBe("none");
    expect(document.querySelectorAll("style")).toHaveLength(1);
  });
});
