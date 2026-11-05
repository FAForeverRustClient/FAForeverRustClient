import { describe, expect, it } from "vitest";
import type { AppState, FrontendUpdate } from "../ipc/bindings";
import fixture from "./__fixtures__/reducer-conformance.json";
import { applyEvent } from "./reducer";

const initial = fixture.initial as unknown as AppState;
const cases = (fixture as unknown as { cases: Array<{ steps: Array<{ update?: FrontendUpdate }> }> }).cases;
const updates = cases.flatMap((testCase) => testCase.steps.flatMap((step) => step.update ? [step.update] : []));

describe("authoritative window updates", () => {
  it("assigns Rust-produced replacements idempotently without changing unrelated slices", () => {
    expect(updates.length).toBeGreaterThan(0);
    for (const update of updates) {
      const once = applyEvent(initial, update);
      const twice = applyEvent(once, update);
      expect(twice, update.kind).toEqual(once);
      const slice = update.kind[0].toLowerCase() + update.kind.slice(1);
      for (const other of Object.keys(initial) as Array<keyof AppState>) {
        if (other !== slice) expect(once[other], `${update.kind}: ${other}`).toBe(initial[other]);
      }
    }
  });

  it("updates one preference group without copying unrelated settings or catalogues", () => {
    const update = updates.find((update) => update.kind === "Settings" && update.event.field === "appearance");
    expect(update).toBeDefined();
    const social = { ...initial.settings.social, playerNotes: Array.from({ length: 1000 }, (_, id) => ({ playerId: id + 1, login: `Player${id}`, note: "A note" })) };
    const before = { ...initial, settings: { ...initial.settings, social } };
    const after = applyEvent(before, update!);
    expect(after.settings.social).toBe(social);
    expect(after.maps).toBe(before.maps);
    expect(after.settings.appearance).not.toBe(before.settings.appearance);
  });

  it("accepts the exact notification history supplied by Rust", () => {
    const snapshots = updates.filter((update) => update.kind === "Notifications");
    expect(snapshots.length).toBeGreaterThan(0);
    for (const update of snapshots) {
      const after = applyEvent(initial, update);
      expect(after.notifications).toBe(update.event);
    }
  });
});
