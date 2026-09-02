import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { mergeReplayTeamsWithLocal, parseOutcome, outcomeLabel, ReplayCardRoster, ReplayDetailRoster } from "./ReplayRoster";
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

  it("splits single-team rosters with more than 4 players into 2 balanced columns", () => {
    const teams: ReplayTeam[] = [{
      team: 1,
      players: [
        { name: "P1", faction: 1, rating: 1000, outcome: "", score: null },
        { name: "P2", faction: 2, rating: 1100, outcome: "", score: null },
        { name: "P3", faction: 3, rating: 1200, outcome: "", score: null },
        { name: "P4", faction: 4, rating: 1300, outcome: "", score: null },
        { name: "P5", faction: 1, rating: 1400, outcome: "", score: null },
        { name: "P6", faction: 2, rating: 1500, outcome: "", score: null },
        { name: "P7", faction: 3, rating: 1600, outcome: "", score: null },
        { name: "P8", faction: 4, rating: 1700, outcome: "", score: null },
      ],
    }];

    const cardMarkup = renderToStaticMarkup(<ReplayCardRoster teams={teams} />);
    expect(cardMarkup).toContain('data-sole-team="true"');
    expect(cardMarkup).toContain('class="replay-card-team-roster is-split"');
    expect(cardMarkup).toContain('grid-template-rows:repeat(4, auto)');

    const detailMarkup = renderToStaticMarkup(<ReplayDetailRoster teams={teams} />);
    expect(detailMarkup).toContain('data-sole-team="true"');
    expect(detailMarkup).toContain('class="replay-detail-roster is-split"');
    expect(detailMarkup).toContain('grid-template-rows:repeat(4, auto)');
    expect(detailMarkup).not.toContain('class="replay-detail-team-title"');
  });

  it("omits inner team header in single-team replays without results, but shows outcome when revealed", () => {
    const teams: ReplayTeam[] = [{
      team: 2,
      players: [
        { name: "P1", faction: 1, rating: 1000, outcome: "VICTORY", score: 100 },
      ],
    }];

    const hiddenMarkup = renderToStaticMarkup(<ReplayDetailRoster teams={teams} showResults={false} />);
    expect(hiddenMarkup).not.toContain('class="replay-detail-team-title"');
    expect(hiddenMarkup).not.toContain("Team 1");

    const revealedMarkup = renderToStaticMarkup(<ReplayDetailRoster teams={teams} showResults={true} />);
    expect(revealedMarkup).toContain('class="replay-detail-team-title"');
    expect(revealedMarkup).toContain('class="replay-team-outcome victory"');
    expect(revealedMarkup).not.toContain("Team 1");
  });

  it("labels the sole player team as Players when observers are present", () => {
    const teams: ReplayTeam[] = [
      {
        team: 2,
        players: [{ name: "Player1", faction: 1, rating: 1500, outcome: "", score: null }],
      },
      {
        team: -1,
        players: [{ name: "Obs1", faction: 0, rating: null, outcome: "", score: null }],
      },
    ];

    const markup = renderToStaticMarkup(<ReplayDetailRoster teams={teams} />);
    expect(markup).toContain("Players");
    expect(markup).toContain("Observers");
    expect(markup).not.toContain("Team 1");
  });
});
