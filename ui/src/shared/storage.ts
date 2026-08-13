type StoredSetValue = string | number;

/** Read a set defensively; corrupt or unavailable storage behaves like an empty set. */
export function loadStoredSet<T extends StoredSetValue>(
  key: string,
  isValue: (value: unknown) => value is T,
): Set<T> {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter(isValue)) : new Set();
  } catch {
    return new Set();
  }
}

/** Storage is a convenience and must never make the primary interaction fail. */
export function saveStoredSet<T extends StoredSetValue>(key: string, values: Set<T>): void {
  try {
    window.localStorage.setItem(key, JSON.stringify([...values]));
  } catch {
    // The in-memory state remains authoritative for this session.
  }
}
