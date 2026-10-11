// The pictures half of the submission form: the names it gives files, and
// what removing one does to the text that showed it.

import { describe, expect, it } from "vitest";
import { imageMarkdown, imageName, refersToImage, withoutImage } from "./contributionImages";

describe("a picture's name", () => {
  it("is one the repository and a URL both survive", () => {
    expect(imageName("Screenshot 2026-10-06 at 14.02.png", "png", new Set())).toBe(
      "screenshot-2026-10-06-at-14-02.png",
    );
    expect(imageName("Überblick Karte.JPG", "jpg", new Set())).toBe("uberblick-karte.jpg");
    expect(imageName("../../catalogue.json", "png", new Set())).toBe("catalogue.png");
  });

  it("falls back to something addressable when nothing usable is left", () => {
    expect(imageName("карта.png", "png", new Set())).toBe("picture.png");
    expect(imageName(".png", "png", new Set())).toBe("picture.png");
  });

  it("never takes a name another picture already has", () => {
    const taken = new Set(["image.png", "image-2.png"]);
    expect(imageName("image.png", "png", taken)).toBe("image-3.png");
    // The same stem as another type is a different file.
    expect(imageName("image.webp", "webp", taken)).toBe("image.webp");
  });

  it("matches the backend's rule for a name it will accept", () => {
    const backendRule = /^[a-z0-9][a-z0-9-]{0,79}\.(png|jpg|gif|webp)$/;
    for (const raw of ["A B.png", "___.png", "-lead.png", "x".repeat(200) + ".png"]) {
      expect(imageName(raw, "png", new Set())).toMatch(backendRule);
    }
  });
});

describe("removing a picture", () => {
  it("takes its line out of the text, and only its line", () => {
    const body = `Intro.\n\n${imageMarkdown("opening.png")}\n\nMore.\n\n![kept](images/other.png)`;
    expect(withoutImage(body, "opening.png")).toBe(
      "Intro.\n\n\nMore.\n\n![kept](images/other.png)",
    );
    expect(refersToImage(body, "opening.png")).toBe(true);
    expect(refersToImage(withoutImage(body, "opening.png"), "opening.png")).toBe(false);
  });

  it("takes out the HTML form the wiki writes too", () => {
    const body = 'Mass <img src="images/mass.png" width="20"/> and energy.';
    expect(withoutImage(body, "mass.png")).toBe("Mass and energy.");
  });

  it("treats a name with dots as text, not as a pattern", () => {
    const body = "![a](images/a-b.png)";
    expect(withoutImage(body, "a.b.png")).toBe(body);
  });
});
