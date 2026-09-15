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

  it("carries no per-row Details button, because the row itself opens", () => {
    // The vault list used to put a Details button at the far end of every row,
    // and a plain click only highlighted. One click opens now, in both the
    // online and the local library, so the control has nothing left to do.
    const markup = renderToStaticMarkup(
      <ReplayList
        groups={[{
          label: "Jul 21, 2026",
          rows: [{
            key: "1",
            mapName: "Seton's Clutch",
            mapThumbnailUrl: "",
            game: { primary: "private" },
            played: { primary: "05:26 PM" },
            players: { primary: "3" },
            rating: { primary: "1100" },
            mod: { primary: "faf" },
            duration: { primary: "5m 20s" },
            replay: { primary: "Available", tone: "ok" },
            onSelect: () => undefined,
            iconActions: [{
              icon: "play",
              ariaLabel: "Watch",
              title: "Watch",
              onClick: () => undefined,
            }],
          }],
        }]}
        footer={<span>1 replay</span>}
      />,
    );

    expect(markup).not.toContain("replay-list-action\"");
    // The row is reachable and operable from the keyboard, and the icon
    // actions beside it are untouched.
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain('aria-label="Watch"');
  });
});
