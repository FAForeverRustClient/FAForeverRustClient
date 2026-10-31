import type { ChangelogRelease } from "../../ipc/bindings";
import type { MessageKey } from "../../i18n";

export const UNDATED_GROUP = "undated";
export const LEGACY_GROUP = "legacy";

/** A deployment branch: named by anything but a patch number, as in
 * `ChangelogRelease::is_rolling`. Legacy notes (`legacy-3605`) are not. */
export function isRollingRelease(release: Pick<ChangelogRelease, "id">): boolean {
  return !release.id.startsWith("legacy-") && !/^\d+$/.test(release.id);
}

export function releaseLabel(id: string): string {
  return id.replace(/^legacy-(\d+)$/, "$1");
}

export function releaseGroup(release: ChangelogRelease): string {
  if (isRollingRelease(release)) return "";
  if (release.kind === "Legacy notes") return LEGACY_GROUP;
  return release.year || UNDATED_GROUP;
}

const HISTORICAL_KINDS: Record<string, MessageKey> = {
  "Historical FAF patch": "changelog.historical.kind.faf",
  "Legacy notes": "changelog.historical.kind.legacy",
  "Withdrawn patch": "changelog.historical.kind.withdrawn",
  "Release candidate": "changelog.historical.kind.candidate",
  "Beta patch": "changelog.historical.kind.beta",
};

export function historicalKindKey(kind: string): MessageKey | undefined {
  return Object.prototype.hasOwnProperty.call(HISTORICAL_KINDS, kind) ? HISTORICAL_KINDS[kind] : undefined;
}
