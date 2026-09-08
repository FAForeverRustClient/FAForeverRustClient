import { describe, expect, it } from "vitest";
import { validateHttpsUrl } from "../../shared/externalLinks";
import {
  countByOrigin,
  DIRECTORY,
  LINK_SECTIONS,
  sectionLinks,
} from "./linkDirectory";

describe("the link directory", () => {
  it("offers only ordinary HTTPS addresses", () => {
    // These are opened in the player's own browser, so the shape of every one
    // of them is checked here rather than at the click.
    for (const link of DIRECTORY) {
      expect(() => validateHttpsUrl(link.href)).not.toThrow();
    }
  });

  it("gives every entry an id of its own", () => {
    expect(new Set(DIRECTORY.map((link) => link.id)).size).toBe(DIRECTORY.length);
  });

  it("puts every entry in a section the page draws", () => {
    for (const link of DIRECTORY) {
      expect(LINK_SECTIONS).toContain(link.section);
    }
  });

  it("leaves no section empty, which would draw a heading over nothing", () => {
    for (const section of LINK_SECTIONS) {
      expect(sectionLinks(section, null).length).toBeGreaterThan(0);
    }
  });

  it("filters a section down to one origin", () => {
    const community = sectionLinks("watch", "community");
    expect(community.length).toBeGreaterThan(0);
    expect(community.every((link) => link.origin === "community")).toBe(true);
    expect(sectionLinks("watch", null).length).toBeGreaterThan(community.length);
  });

  it("keeps directory order inside a section", () => {
    const order = DIRECTORY.filter((link) => link.section === "tools").map((link) => link.id);
    expect(sectionLinks("tools", null).map((link) => link.id)).toEqual(order);
  });

  it("counts each origin for the filter chips", () => {
    expect(countByOrigin("official") + countByOrigin("community")).toBe(DIRECTORY.length);
  });

  it("still lists what the community hub leaves out", () => {
    // The issue's one concrete complaint about the hub page this replaces.
    expect(DIRECTORY.some((link) => link.id === "scribbl")).toBe(true);
  });

  it("opens with the four addresses a new player is given, in that order", () => {
    expect(sectionLinks("play", null).map((link) => link.id)).toEqual([
      "faforever",
      "forum",
      "wiki",
      "discord",
    ]);
  });

  it("does not link the hub it was built from, or a storefront", () => {
    // The hub is a longer way round to this page now that every destination on
    // it is here. The two storefronts were dropped as noise: somebody reading
    // this list inside the client already owns the game.
    const ids = DIRECTORY.map((link) => link.id);
    expect(ids).not.toContain("hub");
    expect(ids).not.toContain("steam");
    expect(ids).not.toContain("gog");
  });

  it("keeps the wiki as the only reference entry, since the units are a tab", () => {
    // The hub's other two reference links are covered elsewhere in the client:
    // the unit database is the Units tab, and the beginner guide is a page of
    // the wiki above.
    expect(DIRECTORY.filter((link) => link.href.includes("wiki.faforever.com"))).toHaveLength(1);
    expect(DIRECTORY.some((link) => link.id === "unitdb")).toBe(false);
  });
});
