// `matchTitle` produces a lobby name every player on the server sees. Getting
// it wrong produces a lobby nobody can find, or one the server rejects for
// length.

import { describe, expect, it } from "vitest";
import { matchTitle } from "./matchTitle";
import { match, player, team, tourney } from "./fixtures";

const event = tourney({
  name: "Weekend Cup",
  players: [
    player({ id: "p1", name: "Nuggets", teamId: "t1" }),
    player({ id: "p2", name: "Ada", teamId: "t2" }),
  ],
  teams: [
    team({ id: "t1", playerIds: ["p1"] }),
    team({ id: "t2", playerIds: ["p2"], name: "Blue" }),
  ],
});

describe("matchTitle", () => {
  it("names the event, the round and both sides", () => {
    expect(matchTitle(event, match({ round: 2 }))).toBe("Weekend Cup R2: Nuggets vs Blue");
  });

  it("marks the losers' bracket, because both halves have a round 2", () => {
    // Someone scanning the custom-games list for their match has to be able to
    // tell the two apart.
    expect(matchTitle(event, match({ bracket: "losers", round: 2 }))).toContain("LR2");
    expect(matchTitle(event, match({ bracket: "grandFinal", round: 3 }))).toContain("GF:");
    expect(matchTitle(event, match({ bracket: "swiss", round: 4 }))).toContain("SR4");
  });

  it("falls back to the first player when a team never named itself", () => {
    // What an organiser expects for a solo event, and vastly better than `t1`.
    expect(matchTitle(event, match())).toContain("Nuggets");
  });

  it("calls an undecided slot TBD rather than leaving it blank", () => {
    expect(matchTitle(event, match({ team2: null }))).toBe("Weekend Cup R1: Nuggets vs TBD");
    // A team id that is not in the event is just as undecided as a null.
    expect(matchTitle(event, match({ team2: "t9" }))).toContain("vs TBD");
  });

  it("drops the event name before it truncates the pairing", () => {
    // The pairing is the half that tells the two players this is their game.
    const long = tourney({ ...event, name: "W".repeat(140) });
    const title = matchTitle(long, match());
    expect(title.length).toBeLessThanOrEqual(128);
    expect(title).toBe("R1: Nuggets vs Blue");
  });

  it("truncates a pairing that is somehow too long on its own", () => {
    const huge = tourney({
      name: "",
      players: [player({ id: "p1", name: "N".repeat(200), teamId: "t1" })],
      teams: [team({ id: "t1", playerIds: ["p1"] })],
    });
    expect(matchTitle(huge, match()).length).toBe(128);
  });
});
