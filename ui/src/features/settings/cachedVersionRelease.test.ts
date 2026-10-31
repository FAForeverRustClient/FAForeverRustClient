import { expect, it } from "vitest";
import type { CachedGameVersion, ChangelogRelease } from "../../ipc/bindings";
import { cachedVersionRelease, cachedVersionReleaseId } from "./cachedVersionRelease";

const version: CachedGameVersion = { name: "FAF Build 3840", version: 3840, url: "https://github.com/FAForever/fa/releases/tag/3840", fileCount: 4, sizeBytes: 1000 };
const release: ChangelogRelease = { id: "3840", kind: "Hotfix", date: "2026-10-20", year: "2026", sourceUrl: "https://patchnotes.faforever.com/3840", webUrl: "https://patchnotes.faforever.com/3840" };

it("uses the exact release metadata for the numbered build", () => {
  expect(cachedVersionRelease(version, [release])).toEqual({ kind: "dated", date: "2026-10-20" });
  expect(cachedVersionReleaseId(version)).toBe("3840");
});

it.each(["", "2026-2-20", "2026-02-31", "not a date"])("does not invent a date from unverified or invalid metadata: %s", date => {
  expect(cachedVersionRelease(version, [{ ...release, date }])).toEqual({ kind: "unknown" });
});

it("does not confuse legacy source notes with a numbered FAF release", () => {
  expect(cachedVersionRelease(version, [{ ...release, id: "legacy-3840" }])).toEqual({ kind: "unknown" });
  expect(cachedVersionRelease(version, [{ ...release, kind: "Legacy notes" }])).toEqual({ kind: "unknown" });
  expect(cachedVersionRelease(version, [])).toEqual({ kind: "unknown" });
});

it.each(["FAF Develop (c7d9d12)", "FAF Beta (c7d9d12)"])("does not reuse the engine release date for %s", name => {
  const branch = { ...version, name };
  expect(cachedVersionRelease(branch, [release])).toEqual({ kind: "development" });
  expect(cachedVersionReleaseId(branch)).toBeNull();
});

it("recognizes cached commit builds and keeps an unidentified engine undated", () => {
  expect(cachedVersionRelease({ ...version, url: "https://github.com/FAForever/fa/commit/c7d9d12" }, [release])).toEqual({ kind: "development" });
  expect(cachedVersionRelease({ ...version, name: "Unknown engine", version: 0, url: null }, [release])).toEqual({ kind: "unknown" });
});
