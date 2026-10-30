import type { CachedGameVersion, ChangelogRelease } from "../../ipc/bindings";

type Version = Pick<CachedGameVersion, "name" | "version" | "url">;
export type CachedVersionRelease = { kind: "dated"; date: string } | { kind: "development" } | { kind: "unknown" };

function isDevelopment(version: Version): boolean {
  // A cached branch can carry the engine's numbered version. Its branch
  // identity must not borrow that numbered release's date.
  return /^FAF (?:Develop|Beta)(?:\s|$)/i.test(version.name)
    || /^https:\/\/github\.com\/FAForever\/fa\/(?:commit|commits|tree)\//i.test(version.url ?? "");
}

export function cachedVersionReleaseId(version: Version): string | null {
  return !isDevelopment(version) && Number.isInteger(version.version) && version.version > 0
    ? String(version.version) : null;
}

/** Release dates come only from the changelog index, never file/cache times
 * or Git commit dates. Legacy notes do not identify a numbered FAF release. */
export function cachedVersionRelease(version: Version, releases: readonly ChangelogRelease[]): CachedVersionRelease {
  if (isDevelopment(version)) return { kind: "development" };
  const id = cachedVersionReleaseId(version);
  const release = id ? releases.find(candidate => candidate.id === id) : undefined;
  if (!release || release.kind === "Legacy notes" || !/^\d{4}-\d{2}-\d{2}$/.test(release.date)) return { kind: "unknown" };
  const date = new Date(`${release.date}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === release.date
    ? { kind: "dated", date: release.date } : { kind: "unknown" };
}
