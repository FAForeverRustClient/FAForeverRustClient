import { describe, expect, it } from "vitest";
import { linkifyText } from "./linkify";

describe("linkifyText", () => {
  it("keeps text without links whole", () => {
    expect(linkifyText("A mod that does things.")).toEqual([
      { text: "A mod that does things.", href: null },
    ]);
  });

  it("marks the readme URL an author put in a description", () => {
    // The complaint this answers: the URL was drawn as flat text, so reaching
    // it meant typing it out.
    expect(linkifyText("Docs: https://github.com/user/mod thanks!")).toEqual([
      { text: "Docs: ", href: null },
      { text: "https://github.com/user/mod", href: "https://github.com/user/mod" },
      { text: " thanks!", href: null },
    ]);
  });

  it("leaves the punctuation that follows a URL out of it", () => {
    const [, link] = linkifyText("See (https://example.com/a).");
    expect(link).toEqual({
      text: "https://example.com/a",
      href: "https://example.com/a",
    });
  });

  it("does not link a scheme the opener would refuse", () => {
    // `openHttpsUrl` rejects anything but plain HTTPS, and a link that is
    // drawn and then refused is worse than text.
    expect(linkifyText("http://example.com and ftp://example.com")).toEqual([
      { text: "http://example.com and ftp://example.com", href: null },
    ]);
  });

  it("handles a description that is nothing but a link", () => {
    expect(linkifyText("https://example.com/x")).toEqual([
      { text: "https://example.com/x", href: "https://example.com/x" },
    ]);
  });
});
