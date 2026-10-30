import { describe, expect, it } from "vitest";
import type { ChangelogRelease } from "../../ipc/bindings";
import { historicalKindKey, isRollingRelease, releaseGroup, releaseLabel } from "./releasePresentation";

const release = (id: string, kind: string, year = "", date = ""): ChangelogRelease => ({
  id, kind, year, date, sourceUrl: "https://example.invalid/note", webUrl: "https://example.invalid/note",
});

describe("historical release presentation", () => {
  it("separates undated FAF notes, unverified legacy notes and rolling branches", () => {
    const undated = release("3616", "Historical FAF patch");
    expect(isRollingRelease(undated)).toBe(false);
    expect(releaseGroup(undated)).toBe("undated");
    expect(releaseGroup(release("legacy-3605", "Legacy notes"))).toBe("legacy");
    expect(releaseGroup(release("fafbeta", "FAF Beta"))).toBe("");
    expect(releaseGroup(release("fafdevelop", "FAF Develop"))).toBe("");
    expect(releaseGroup(release("3612", "Historical FAF patch", "2012", "2012-03-05"))).toBe("2012");
  });

  it("displays the original patch number without losing its distinct identity", () => {
    expect(releaseLabel("legacy-3605")).toBe("3605");
    expect(releaseLabel("3612")).toBe("3612");
    expect(releaseLabel("fafdevelop")).toBe("fafdevelop");
    expect(historicalKindKey("Legacy notes")).toBe("changelog.historical.kind.legacy");
    expect(historicalKindKey("Release candidate")).toBe("changelog.historical.kind.candidate");
    expect(historicalKindKey("Withdrawn patch")).toBe("changelog.historical.kind.withdrawn");
    expect(historicalKindKey("constructor")).toBeUndefined();
  });
});
