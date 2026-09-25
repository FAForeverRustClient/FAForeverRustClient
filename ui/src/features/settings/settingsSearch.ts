// What the settings search looks at, collected from the rows that rendered it.
//
// The list used to be written a second time by hand, in a `labels` array beside
// the section table. It drifted, as a second copy of anything does: seven
// settings were rendered and never indexed, so typing "sidebar width" or "chat
// font size" hid the very section holding them. A row now contributes its own
// label and hint as it mounts, so a row that cannot be found is not something
// anyone can forget to prevent: it would have to render nothing.
//
// Every section stays mounted while the tab is open (only the active one is
// shown), which is what makes this complete rather than "complete for wherever
// the user has already been". That costs no more than the previous tab, which
// rendered all fourteen sections into one scroll at all times.
//
// The text collected is already translated, so the search matches what the
// reader sees rather than an English key they never do.

/** Section key -> the phrases its rows contributed, each with a use count. */
const entries = new Map<string, Map<string, number>>();

const listeners = new Set<() => void>();
/** Bumped on every change, so a subscriber can memo against it. */
let revision = 0;

function announce(): void {
  revision += 1;
  for (const listener of listeners) listener();
}

export function subscribeToSettingsIndex(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function settingsIndexRevision(): number {
  return revision;
}

/**
 * Record one phrase against a section.
 *
 * Reference counted rather than a plain set: the same phrase legitimately
 * appears in two rows (a label and the ARIA label of its own control), and two
 * rows mounting and one unmounting must not take the phrase away from the one
 * still on screen.
 */
export function addSettingsIndexEntry(section: string, text: string): void {
  const phrase = text.trim().toLocaleLowerCase();
  if (!phrase) return;
  let bucket = entries.get(section);
  if (!bucket) {
    bucket = new Map();
    entries.set(section, bucket);
  }
  bucket.set(phrase, (bucket.get(phrase) ?? 0) + 1);
  announce();
}

export function removeSettingsIndexEntry(section: string, text: string): void {
  const phrase = text.trim().toLocaleLowerCase();
  const bucket = entries.get(section);
  const count = bucket?.get(phrase);
  if (!bucket || count === undefined) return;
  if (count <= 1) bucket.delete(phrase);
  else bucket.set(phrase, count - 1);
  if (bucket.size === 0) entries.delete(section);
  announce();
}

/**
 * Does this section hold anything matching `query`?
 *
 * Hyphens and underscores are flattened on both sides so "auto join",
 * "auto-join" and "autojoin" all reach the same rows: people type a setting's
 * name the way they say it, not the way it is punctuated.
 */
export function sectionMatches(section: string, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  const bucket = entries.get(section);
  if (!bucket) return false;
  const flat = flatten(needle);
  for (const phrase of bucket.keys()) {
    if (phrase.includes(needle) || flatten(phrase).includes(flat)) return true;
  }
  return false;
}

function flatten(value: string): string {
  return value.replace(/[-_]/g, " ");
}

/** Test seam: the indexed phrases for one section. */
export function settingsIndexEntriesForTests(section: string): string[] {
  return [...(entries.get(section)?.keys() ?? [])].sort();
}

/** Test seam: forget everything, so one test cannot colour the next. */
export function resetSettingsIndexForTests(): void {
  entries.clear();
  revision = 0;
}
