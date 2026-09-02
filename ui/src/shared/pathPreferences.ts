// The TypeScript twin of `PathPreferences::normalized` in faf-domain.
//
// The store applies the same reducer the backend does, so a path that arrives
// with a trailing space - which is how one pasted out of a file manager
// routinely arrives - has to be trimmed on both sides or the two states drift
// and the conformance fixture says so.

import type { PathPreferences } from "../ipc/bindings";

const FIELDS = [
  "vaultDir",
  "mapsDir",
  "modsDir",
  "replaysDir",
  "gamePrefsPath",
  "mapGeneratorDir",
  "javaPath",
] as const;

export function normalizePathPreferences(preferences: PathPreferences): PathPreferences {
  const normalized: PathPreferences = {};
  for (const field of FIELDS) {
    normalized[field] = (preferences[field] ?? "").trim();
  }
  return normalized;
}

/**
 * Add generated maps to the keep list, matching the backend's reducer.
 *
 * Additive and case-insensitive: a later run that keeps nothing must not
 * release what an earlier one kept, and the same map arriving twice must not
 * be listed twice.
 */
export function withKeptGeneratedMaps(kept: string[], mapNames: string[]): string[] {
  const next = [...kept];
  for (const raw of mapNames) {
    const name = raw.trim();
    if (!name || next.some((existing) => existing.toLowerCase() === name.toLowerCase())) continue;
    next.push(name);
  }
  return next;
}
