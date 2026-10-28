// Presentation state only, scoped to the two changelog readers for this
// session. Which release is selected remains backend-owned.
export type ChangelogReader = "game" | "client";

interface ReadingPosition {
  selection: string;
  top: number;
  section: string | null;
}

interface ViewMemory {
  position: ReadingPosition | null;
  listTop: number;
  years: Set<string>;
}

export const changelogViewMemory: Record<ChangelogReader, ViewMemory> = {
  game: { position: null, listTop: 0, years: new Set() },
  client: { position: null, listTop: 0, years: new Set() },
};
