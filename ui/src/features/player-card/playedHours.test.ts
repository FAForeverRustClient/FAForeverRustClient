import { describe, expect, it } from "vitest";
import { playedHours } from "./playerActivity";

// Issue 748: the time played, as the Statistics tab prints it.
describe("playedHours", () => {
  it("keeps a tenth below ten hours and whole hours above", () => {
    expect(playedHours(0)).toBe("0.0");
    expect(playedHours(90)).toBe("1.5");
    expect(playedHours(9 * 60 + 56)).toBe("9.9");
    expect(playedHours(1234 * 60 + 20)).toBe("1,234");
  });
});
