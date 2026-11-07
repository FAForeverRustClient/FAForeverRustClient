export interface VaultSearch<F, P extends string> {
  category: P;
  filters: F;
}

export function encodeVaultSearch<F, P extends string>(value: VaultSearch<F, P>): string {
  return JSON.stringify({ version: 1, category: value.category, filters: Object.fromEntries(Object.entries(value.filters as object).sort(([left], [right]) => left.localeCompare(right))) });
}

/** Read only known fields, with typed defaults for future filter additions. */
export function decodeVaultSearch<F extends object, P extends string>(
  saved: string,
  defaults: F,
  categories: readonly P[],
  choices: Partial<Record<keyof F, readonly string[]>>,
): VaultSearch<F, P> | null {
  try {
    const value: unknown = JSON.parse(saved);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (record.version !== 1 || !categories.includes(record.category as P)) return null;
    if (!record.filters || typeof record.filters !== "object" || Array.isArray(record.filters)) return null;
    const stored = record.filters as Record<string, unknown>;
    const filters = { ...defaults };
    for (const key of Object.keys(defaults) as (keyof F & string)[]) {
      if (!Object.prototype.hasOwnProperty.call(stored, key)) continue;
      const field = stored[key];
      const fallback = defaults[key];
      if (choices[key]) {
        if (typeof field !== "string" || !choices[key]?.includes(field)) return null;
      } else if (fallback === null) {
        if (field !== null && (typeof field !== "number" || !Number.isFinite(field) || field < 0 || field > 1e7)) return null;
      } else if (typeof field !== typeof fallback) return null;
      if (typeof field === "number" && (!Number.isFinite(field) || field < 0 || field > 1e7)) return null;
      if (typeof field === "number" && !/Rating$/.test(key) && !Number.isInteger(field)) return null;
      if (/Rating$/.test(key) && typeof field === "number" && field > 5) return null;
      if (typeof field === "string" && (field.length > 4096 || (/After$|Before$/.test(key) && field !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(field)))) return null;
      filters[key] = field as F[typeof key];
    }
    return { category: record.category as P, filters };
  } catch { return null; }
}
