import { describe, expect, it } from "vitest";
import type { PartyState, Player, PlayerProfile, SocialState } from "../../ipc/bindings";
import { partyChatChannel } from "./partyChat";

const party = (ownerId: number | null, members: PartyState["members"]): PartyState => ({
  ownerId,
  members,
});

const online = (id: number, login: string): PlayerProfile => ({
  id,
  login,
  globalRating: 0,
  ratings: [],
  country: "",
  clan: "",
  avatarUrl: "",
  avatarTooltip: "",
});

const directory = (...players: PlayerProfile[]): SocialState => ({
  friends: [],
  foes: [],
  players,
});

const signedIn = (id: number, name: string): Player => ({ id, name, roles: [] });

// The lobby's `update_party` carries player ids and factions only, so every
// member arrives labelled with the adapter's "Player <id>" placeholder.
const placeholder = (playerId: number) => ({ playerId, name: `Player ${playerId}`, factions: [] });

describe("partyChatChannel", () => {
  it("uses the reference-client channel suffix and the owner's login from the directory", () => {
    expect(partyChatChannel(
      party(7, [placeholder(4), placeholder(7)]),
      directory(online(4, "Wingmate"), online(7, "Leader")),
      null,
    )).toBe("#Leader'sParty");
  });

  it("answers a signed-in owner from the session when the directory has not caught up", () => {
    expect(partyChatChannel(
      party(7, [placeholder(4), placeholder(7)]),
      directory(online(4, "Wingmate")),
      signedIn(7, "Leader"),
    )).toBe("#Leader'sParty");
  });

  // The bug this guards: the placeholder contains a space, so the room name did
  // too, and the server answered the JOIN with `403 No such channel` while the
  // party panel waited on it forever.
  it("refuses to build a room name out of the adapter's placeholder label", () => {
    expect(partyChatChannel(
      party(42707, [placeholder(4), placeholder(42707)]),
      directory(online(4, "Wingmate")),
      signedIn(4, "Wingmate"),
    )).toBeNull();
  });

  it("does not create rooms for solo or incomplete party snapshots", () => {
    expect(partyChatChannel(
      party(7, [placeholder(7)]),
      directory(online(7, "Leader")),
      null,
    )).toBeNull();
    expect(partyChatChannel(
      party(99, [placeholder(7), placeholder(4)]),
      directory(online(7, "Leader"), online(4, "Wingmate")),
      null,
    )).toBeNull();
  });
});
