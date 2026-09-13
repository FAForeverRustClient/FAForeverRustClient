// What the publish dialog knows about the thing being published.
//
// Separated from the dialog because both answers here are judgements rather
// than rendering, and both were reported wrong: a publish that replaced an
// existing entry announced itself as a brand new upload, and the dialog showed
// a name and a folder and nothing else an author could check against.

import type { InstalledMap, InstalledMod, UploadRequest } from "../../ipc/bindings";
import { kilometresLabel } from "../../shared/mapPresentation";

/**
 * Whether the vault already holds what is about to be published.
 *
 * `"unknown"` is a real answer and the important one: the catalogue is a
 * cache, and claiming "new upload" because it has not loaded yet is exactly
 * the mistake being fixed. The dialog says nothing at all in that case.
 */
export type VaultPresence = "new" | "update" | "unknown";

const same = (left: string, right: string) =>
  left.trim().localeCompare(right.trim(), undefined, { sensitivity: "accent" }) === 0;

/**
 * FAF identifies a map or a mod by its *display name*, and each upload under
 * that name becomes another version of the same entry. So the question "is
 * this an update" is answered by the name, not by the uid: a mod's uid is per
 * version and is supposed to change every time, which is why matching on it
 * would call every real update a new mod.
 *
 * A rename is the exception, and deliberately so: FAF has no rename, so
 * publishing under a new name genuinely is a new mod with a fresh uid, and
 * this is the last screen before that happens.
 */
export function vaultPresence(
  request: UploadRequest,
  catalogue: ReadonlyArray<{ displayName: string }>,
  loaded: boolean,
): VaultPresence {
  if (request.renameTo !== "") return "new";
  if (!loaded) return "unknown";
  return catalogue.some((entry) => same(entry.displayName, request.displayName))
    ? "update"
    : "new";
}

/** One labelled row of the details panel. Labels are message keys. */
export interface UploadFact {
  readonly labelKey: string;
  readonly value: string;
  /// The glyph in front of the label, so the rows read as facts about one
  /// thing rather than as a bare two-column list. Names from `design-system`'s
  /// `IconName`; kept as a string here so this stays a pure module.
  readonly icon: string;
}

function kilometres(width: number | undefined, height: number | undefined): string | null {
  if (!width || !height) return null;
  // One decimal was not enough: map sizes step by 64 units, which is 1.25 km,
  // so the smallest of them rounded to 1.3.
  const w = kilometresLabel(width);
  const h = kilometresLabel(height);
  return w === h ? `${w} km` : `${w} × ${h} km`;
}

/**
 * The facts an author can check before they publish, in reading order.
 *
 * Only what is actually known: a folder picked from disk has no installed
 * record behind it, and an empty row saying "Version: -" is worse than no row.
 * The size is absent until compression has measured the folder, which is the
 * first moment anybody knows it.
 */
export function uploadFacts(
  request: UploadRequest,
  installed: InstalledMod | InstalledMap | undefined,
  folderBytes: number | null,
  formatSize: (bytes: number) => string,
): UploadFact[] {
  const facts: UploadFact[] = [];
  const push = (labelKey: string, value: string | null | undefined, icon: string) => {
    if (value !== null && value !== undefined && value !== "") {
      facts.push({ labelKey, value, icon });
    }
  };

  push("uploads.fact.name", request.displayName, "edit");

  // Narrowed on `uid`, the one field only a mod has and always has: the two
  // shapes overlap everywhere else, and the request's kind is what says which
  // fields are worth printing.
  const mod = installed && "uid" in installed ? installed : undefined;
  const map = installed && !("uid" in installed) ? installed : undefined;

  if (request.kind === "mod") {
    push("uploads.fact.version", mod?.version, "changelog");
    push("uploads.fact.author", mod?.author, "users");
    // The uid is the one field an author cannot see anywhere else in the
    // client, and it is what the vault refuses a duplicate of.
    push("uploads.fact.uid", mod?.uid, "info");
  } else {
    push("uploads.fact.version", map?.version ?? undefined, "changelog");
    push("uploads.fact.mapSize", kilometres(map?.width, map?.height), "maps");
    push("uploads.fact.players", map?.maxPlayers ? String(map.maxPlayers) : null, "users");
  }

  push("uploads.fact.size", folderBytes === null ? null : formatSize(folderBytes), "download");
  push("uploads.fact.folder", request.sourcePath ?? request.folderName, "folder");
  return facts;
}

/** The description an installed entry carries, trimmed of empty values. */
export function uploadDescription(
  installed: InstalledMod | InstalledMap | undefined,
): string | null {
  const text = installed?.description ?? "";
  return text.trim() === "" ? null : text.trim();
}
