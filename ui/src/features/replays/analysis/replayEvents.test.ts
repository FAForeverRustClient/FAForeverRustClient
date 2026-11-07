import { describe, expect, it } from "vitest";
import type { ReplayAnalysis, ReplayArmy } from "../../../ipc/bindings";
import { classifyReplayNotice, replayTimeline } from "./replayEvents";

const army = (source: number, faction = 1): ReplayArmy => ({ source, faction, name: `Player ${source}`, armyName: `ARMY_${source + 1}`, color: 1, team: source + 1, startSpot: source + 1, human: true, country: "", clan: "", rating: null });

describe("replay event classification", () => {
  it("identifies the faction's enhancement and HQ icons from notification text", () => {
    expect(classifyReplayNotice("Gun (Damage&Range) upgrade done!", army(0))).toEqual({ kind: "upgrade", unit: "UEL0001", enhancement: "hamc_btn_up" });
    expect(classifyReplayNotice("Tech 3 Land HQ done!", army(0, 3))).toEqual({ kind: "factory", unit: "URB0301" });
    expect(classifyReplayNotice("Teleporter готов!", army(0, 2))).toEqual({ kind: "upgrade", unit: "UAL0001", enhancement: "pqt_btn_up" });
  });
  it("identifies experimentals, artillery and nukes without interpreting unknown text as asset paths", () => {
    expect(classifyReplayNotice("Ythotha done!")).toEqual({ kind: "experimental", unit: "XSL0401" });
    expect(classifyReplayNotice("Tech 3 Static Artillery done!", army(0, 2))).toEqual({ kind: "experimental", unit: "UAB2302" });
    expect(classifyReplayNotice("Nuke Launcher done!", army(0, 4))).toEqual({ kind: "experimental", unit: "XSB2305" });
    expect(classifyReplayNotice("https://invalid.example/icon.png", army(0))).toEqual({ kind: "other" });
  });
  it("keeps unknown events, sorts all events and labels last activity separately from a confirmed death", () => {
    const analysis = { armies: [army(0), { ...army(1), human: false }], notices: [{ tick: 400, source: 0, text: "Unknown event" }], activity: [{ source: 0, commandTicks: [100], lastTick: 100 }, { source: 1, commandTicks: [200], lastTick: 200 }] } as ReplayAnalysis;
    expect(replayTimeline(analysis)).toEqual([
      { tick: 100, source: 0, text: "", kind: "lastCommand", unit: "UEL0001" },
      { tick: 400, source: 0, text: "Unknown event", kind: "other" },
    ]);
  });
});
