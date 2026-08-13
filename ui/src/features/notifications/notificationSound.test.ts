import { describe, expect, it } from "vitest";
import { notificationTonePlan } from "./notificationSound";

describe("notificationTonePlan", () => {
  it("uses a short soft envelope with quiet harmonic partials", () => {
    const tone = notificationTonePlan(false);

    expect(tone.attackSeconds).toBeGreaterThan(0);
    expect(tone.attackSeconds).toBeLessThan(0.03);
    expect(tone.durationSeconds).toBeLessThanOrEqual(0.24);
    expect(tone.partials).toHaveLength(3);
    expect(tone.partials.map((partial) => partial.gain)).toEqual([1, 0.2, 0.06]);
  });

  it("makes important alerts distinct without extending the tail", () => {
    const normal = notificationTonePlan(false);
    const important = notificationTonePlan(true);

    expect(important.frequency).toBeGreaterThan(normal.frequency);
    expect(important.peakGain).toBeGreaterThan(normal.peakGain);
    expect(important.durationSeconds).toBeLessThanOrEqual(0.24);
  });
});
