import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parseOutcome, outcomeLabel, ReplayDetailRoster } from "./ReplayRoster";
import type { ReplayTeam } from "../../ipc/bindings";

describe("ReplayRoster outcomes", () => {
  it("parses victory, defeat, draw, and mutual draw correctly", () => {
    expect(parseOutcome("VICTORY")).toBe("victory");
    expect(parseOutcome("victory")).toBe("victory");
    expect(parseOutcome("DEFEAT")).toBe("defeat");
    expect(parseOutcome("defeat")).toBe("defeat");
    expect(parseOutcome("DRAW")).toBe("draw");
    expect(parseOutcome("draw")).toBe("draw");
    expect(parseOutcome("MUTUAL_DRAW")).toBe("draw");
    expect(parseOutcome("mutual_draw")).toBe("draw");
    expect(parseOutcome("UNKNOWN")).toBe("");
    expect(parseOutcome("")).toBe("");
  });

  it("translates outcome kinds to localized labels", () => {
    expect(outcomeLabel("victory")).toBe("Victory");
    expect(outcomeLabel("defeat")).toBe("Defeat");
    expect(outcomeLabel("draw")).toBe("Draw");
    expect(outcomeLabel("MUTUAL_DRAW")).toBe("Draw");
    expect(outcomeLabel("")).toBe("");
  });

  it("renders draw outcome on team headers when revealed", () => {
    const teams: ReplayTeam[] = [
      {
        team: 2,
        players: [
          {
            name: "Player1",
            faction: 1,
            rating: 1500,
            outcome: "DRAW",
            score: 0,
          },
        ],
      },
      {
        team: 3,
        players: [
          {
            name: "Player2",
            faction: 2,
            rating: 1500,
            outcome: "MUTUAL_DRAW",
            score: 0,
          },
        ],
      },
    ];

    const markup = renderToStaticMarkup(
      <ReplayDetailRoster teams={teams} showResults={true} />,
    );

    expect(markup).toContain('class="replay-team-outcome draw"');
    expect(markup).toContain("Draw");
  });
});
