// @vitest-environment happy-dom
//
// The vault card's picture: a base-game map's thumbnail out of the original
// game, with the record's own art and the icon behind it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import "../../testing/mounted";
import { MapPreview } from "./MapPreview";

const shell = vi.hoisted(() => ({ inside: false }));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  isTauri: () => shell.inside,
  convertFileSrc: (path: string, scheme = "asset") => `http://${scheme}.localhost/${encodeURIComponent(path)}`,
}));

const SETONS = {
  folderName: "scmp_009",
  displayName: "Seton's Clutch",
  thumbnailUrl: "https://content.faforever.com/maps/previews/small/scmp_009.png",
  thumbnailUrlLarge: "https://content.faforever.com/maps/previews/large/scmp_009.png",
};

const shown = (container: HTMLElement) => container.querySelector("img")?.getAttribute("src");

describe("MapPreview", () => {
  beforeEach(() => {
    shell.inside = true;
  });
  afterEach(() => {
    shell.inside = false;
  });

  it("draws a base-game map's thumbnail from the original game, then the record's art, then the icon", () => {
    const { container } = render(<MapPreview map={SETONS} />);
    expect(shown(container)).toBe("http://official-map.localhost/scmp_009");

    // No game or no such map: the shell answers 404.
    fireEvent.error(container.querySelector("img")!);
    expect(shown(container)).toBe(SETONS.thumbnailUrl);

    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".map-vault-preview-empty")).not.toBeNull();
  });

  it("keeps the record's art at detail size and for a vault map", () => {
    expect(shown(render(<MapPreview map={SETONS} large />).container)).toBe(SETONS.thumbnailUrlLarge);
    const vaultMap = { ...SETONS, folderName: "setons_clutch.v0002", thumbnailUrl: "https://example.test/small.png" };
    expect(shown(render(<MapPreview map={vaultMap} />).container)).toBe("https://example.test/small.png");
  });

  it("starts a new map's walk from its own first picture", () => {
    const { container, rerender } = render(<MapPreview map={SETONS} />);
    fireEvent.error(container.querySelector("img")!);
    rerender(<MapPreview map={{ ...SETONS, folderName: "scmp_001", thumbnailUrl: "https://example.test/burial.png" }} />);
    expect(shown(container)).toBe("http://official-map.localhost/scmp_001");
  });
});
