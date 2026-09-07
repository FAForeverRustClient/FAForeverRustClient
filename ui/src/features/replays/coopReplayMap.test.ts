import { describe, expect, it } from "vitest";
import type { CoopMission, VaultMap } from "../../ipc/bindings";
import { effectiveReplayMapName } from "../../shared/mapPresentation";
import { coopMissionByTitle, replayMapKey, replayMapPresentation } from "./coopReplayMap";

function mission(overrides: Partial<CoopMission> = {}): CoopMission {
  return {
    id: 1,
    name: "Fear No Evil",
    description: "",
    version: 21,
    downloadUrl: "",
    thumbnailUrlSmall: "https://content.faforever.com/faf/vault/map_previews/small/scca_coop_r03.png",
    thumbnailUrlLarge: "",
    mapFolderName: "SCCA_Coop_R03.v0021",
    scenarioId: 3,
    order: 3,
    ...overrides,
  };
}

const missions = [
  mission(),
  mission({ id: 2, name: "The Hunt", mapFolderName: "SCCA_Coop_R04.v0010" }),
  mission({ id: 3, name: "Prime Target", mapFolderName: "X1CA_Coop_006.v0009" }),
];

const vault: VaultMap[] = [];
const coop = { map: "unknown map", title: "Fear No Evil", modName: "coop" };

describe("a co-op replay's mission", () => {
  it("comes from the replay file when the client has the game on disk", () => {
    expect(effectiveReplayMapName("unknown map", "scca_coop_r03.v0021")).toBe("scca_coop_r03.v0021");
    expect(effectiveReplayMapName("scmp_009", "scca_coop_r03.v0021")).toBe("scmp_009");
    expect(effectiveReplayMapName("unknown map", undefined)).toBe("unknown map");
  });

  it("is recognised from the game's title, which is the mission's name unless the host retyped it", () => {
    expect(coopMissionByTitle("Fear No Evil", missions)?.id).toBe(1);
    expect(coopMissionByTitle("  fear no evil!  ", missions)?.id).toBe(1);
    expect(coopMissionByTitle("Operation Prime Target 3/4", missions)?.id).toBe(3);
    expect(replayMapKey(missions, coop)).toBe("SCCA_Coop_R03.v0021");
    expect(replayMapPresentation(vault, missions, coop).displayName).toBe("Fear No Evil");
  });

  it("stays unclaimed when the title names no mission", () => {
    const renamed = { ...coop, title: "coop pros only" };
    expect(coopMissionByTitle(renamed.title, missions)).toBeUndefined();
    expect(replayMapKey(missions, renamed)).toBe("unknown map");
    // Still a mission rather than an unknown map, which is what the vault
    // listing itself said before this.
    expect(replayMapPresentation(vault, missions, renamed).isCoop).toBe(true);
    expect(replayMapPresentation(vault, missions, renamed).displayName).toBe("Co-op mission");
  });

  it("leaves an ordinary game's map alone", () => {
    const custom = { map: "scmp_009", title: "Fear No Evil", modName: "faf" };
    expect(replayMapKey(missions, custom)).toBe("scmp_009");
    expect(replayMapPresentation(vault, missions, custom).displayName).toBe("Seton's Clutch");
    const noMap = { map: "unknown map", title: "whatever", modName: "faf" };
    expect(replayMapPresentation(vault, missions, noMap).isCoop).toBeUndefined();
  });

  it("takes what the replay file said over what the title suggested", () => {
    // The file is read from the vault, 64 KiB of it, and it names the scenario
    // the engine actually loaded. A host who titled the game after a different
    // mission does not get to overrule that.
    const misnamed = { ...coop, title: "The Hunt" };
    expect(replayMapKey(missions, misnamed)).toBe("SCCA_Coop_R04.v0010");
    expect(replayMapKey(missions, misnamed, "SCCA_Coop_R03.v0021")).toBe("SCCA_Coop_R03.v0021");
    expect(
      replayMapPresentation(vault, missions, misnamed, "SCCA_Coop_R03.v0021").displayName,
    ).toBe("Fear No Evil");
  });

  it("names a renamed mission the file could be read for, and only says 'mission' when it could not", () => {
    const renamed = { ...coop, title: "coop pros only" };
    expect(replayMapKey(missions, renamed, "X1CA_Coop_006.v0009")).toBe("X1CA_Coop_006.v0009");
    expect(
      replayMapPresentation(vault, missions, renamed, "X1CA_Coop_006.v0009").displayName,
    ).toBe("Prime Target");
    // An empty answer is the file having been read and named nothing, which is
    // the only case left that falls back to the generic label.
    expect(replayMapPresentation(vault, missions, renamed, "").isCoop).toBe(true);
  });

  it("fills in a custom game whose vault map is gone, which is the same hole", () => {
    const lost = { map: "unknown map", title: "whatever", modName: "faf" };
    expect(replayMapKey(missions, lost, "scmp_009")).toBe("scmp_009");
    expect(replayMapPresentation(vault, missions, lost, "scmp_009").displayName).toBe(
      "Seton's Clutch",
    );
  });

  it("does not let a short mission name match a fragment of an unrelated title", () => {
    const shortNamed = [mission({ id: 9, name: "Hunt", mapFolderName: "SCCA_Coop_X.v0001" })];
    expect(coopMissionByTitle("Bug hunting practice", shortNamed)).toBeUndefined();
  });
});
