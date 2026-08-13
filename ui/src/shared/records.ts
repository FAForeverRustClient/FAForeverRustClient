/** Typed counterpart to Object.entries for exhaustive enum-backed records. */
export function recordEntries<Key extends string, Value>(
  record: Record<Key, Value>,
): Array<[Key, Value]> {
  return Object.entries(record) as Array<[Key, Value]>;
}
