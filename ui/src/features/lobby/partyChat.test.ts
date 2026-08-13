import { describe, expect, it } from "vitest";
import type { PartyState } from "../../ipc/bindings";
import { partyChatChannel } from "./partyChat";

const party = (ownerId: number | null, members: PartyState["members"]): PartyState => ({
  ownerId,
  members,
});

describe("partyChatChannel", () => {
  it("uses the reference-client channel suffix and party owner's name", () => {
    expect(partyChatChannel(party(7, [
      { playerId: 4, name: "Wingmate", factions: [] },
      { playerId: 7, name: "Leader", factions: [] },
    ]))).toBe("#Leader'sParty");
  });

  it("does not create rooms for solo or incomplete party snapshots", () => {
    expect(partyChatChannel(party(7, [{ playerId: 7, name: "Leader", factions: [] }]))).toBeNull();
    expect(partyChatChannel(party(99, [
      { playerId: 7, name: "Leader", factions: [] },
      { playerId: 4, name: "Wingmate", factions: [] },
    ]))).toBeNull();
  });
});
