import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReplayList } from "./ReplayList";

describe("ReplayList", () => {
  it("uses the same compact columns for every replay source", () => {
    const markup = renderToStaticMarkup(
      <ReplayList
        groups={[{
          label: "Jul 21, 2026",
          rows: [{
            key: "1",
            mapName: "Seton's Clutch",
            mapThumbnailUrl: "",
            game: { primary: "private", secondary: "Seton's Clutch" },
            played: { primary: "05:26 PM", secondary: "23d ago" },
            players: { primary: "3" },
            rating: { primary: "1100" },
            mod: { primary: "faf", secondary: "No reviews" },
            duration: { primary: "5m 20s", secondary: "5m 57s real" },
            replay: { primary: "Available", secondary: "#1", tone: "ok" },
          }],
        }]}
        footer={<span>1 replay</span>}
      />,
    );

    expect(markup).toContain("Map");
    expect(markup).toContain("Game");
    expect(markup).toContain("Played");
    expect(markup).toContain("Players");
    expect(markup).toContain("Rating");
    expect(markup).toContain("Mod");
    expect(markup).toContain("Duration");
    expect(markup).toContain("Replay");
    expect(markup).not.toContain(">Date<");
    expect(markup.indexOf("Mod")).toBeLessThan(markup.indexOf("Played"));
  });
});
