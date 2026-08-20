import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { mergeReplayTeamsWithLocal, parseOutcome, outcomeLabel, ReplayDetailRoster } from "./ReplayRoster";
import type { LocalReplayTeam, ReplayTeam } from "../../ipc/bindings";

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

  it("renders a player's avatar before the faction marker", () => {
    const teams: ReplayTeam[] = [
      {
        team: 2,
        players: [
          {
            name: "Player1",
            avatarUrl: "https://example.test/player1.png",
            faction: 1,
            rating: 1500,
            outcome: "",
            score: null,
          },
        ],
      },
    ];

    const markup = renderToStaticMarkup(<ReplayDetailRoster teams={teams} />);

    expect(markup).toContain('class="replay-player-avatar"');
    expect(markup).toContain('src="https://example.test/player1.png"');
    expect(markup.indexOf("replay-player-avatar")).toBeLessThan(markup.indexOf("replay-player-faction"));
  });

  it("fills missing player ratings from matching local replay metadata", () => {
    const teams: ReplayTeam[] = [{
      team: 2,
      players: [
        { name: "Player1", faction: 1, rating: null, outcome: "", score: null },
        { name: "Player2", faction: 1, rating: 1500, outcome: "", score: null },
      ],
    }];
    const localTeams: LocalReplayTeam[] = [{
      // Local replay headers and the vault API can number the same team
      // differently. The player-name fallback should still merge the rating.
      team: "1",
      players: [
        { name: "player1", faction: 1, rating: 1200 },
        { name: "Player2", faction: 1, rating: 1400 },
      ],
    }];

    const merged = mergeReplayTeamsWithLocal(teams, localTeams);

    expect(merged[0].players[0].rating).toBe(1200);
    expect(merged[0].players[1].rating).toBe(1500);
  });

  it("renders a player rating in the detail lineup", () => {
    const teams: ReplayTeam[] = [{
      team: 2,
      players: [{ name: "Player1", faction: 1, rating: 1500, outcome: "", score: null }],
    }];

    const markup = renderToStaticMarkup(<ReplayDetailRoster teams={teams} />);

    expect(markup).toContain('class="replay-player-rating"');
    expect(markup).toContain(">(1500)</span>");
  });
});
