import { useEffect, useRef, useState } from "react";
import { useRememberFilter } from "../filterMemory";

/** Draft fields change freely; only an applied snapshot owns results and paging. */
export function useVaultFilters<F extends { sort: string }, P extends string>({
  initial, initialPage, memoryKey, preset, presetSort,
}: {
  initial: F;
  initialPage: number;
  memoryKey: string;
  preset: P;
  presetSort: (preset: P) => F["sort"];
}) {
  const [draft, setDraft] = useState(initial);
  const [applied, setApplied] = useState(initial);
  const [page, setPage] = useState(initialPage);
  useRememberFilter(memoryKey, applied);

  const setFilter = <K extends keyof F>(key: K, value: F[K]) =>
    setDraft((previous) => ({ ...previous, [key]: value }));
  const patchDraft = (patch: Partial<F>) => setDraft((previous) => ({ ...previous, ...patch }));

  const lastPreset = useRef(preset);
  useEffect(() => {
    // A restored sort belongs to the reader. Only a changed preset replaces it.
    if (lastPreset.current === preset) return;
    lastPreset.current = preset;
    const sort = presetSort(preset);
    setDraft((previous) => ({ ...previous, sort }));
    setApplied((previous) => ({ ...previous, sort }));
  }, [preset, presetSort]);

  const applySearch = () => {
    setApplied(draft);
    setPage(1);
  };
  const applySort = (sort: F["sort"]) => {
    setFilter("sort", sort);
    setApplied((previous) => ({ ...previous, sort }));
    setPage(1);
  };
  const reset = (filters: F) => {
    setDraft(filters);
    setApplied(filters);
    setPage(1);
  };

  return { draft, setFilter, patchDraft, applied, setApplied, page, setPage, applySearch, applySort, reset };
}

/** Local catalogue presets never send a server search. Callers supply stable search functions. */
export function useVaultSearch<Q>(query: Q, local: boolean, search: (query: Q) => void) {
  useEffect(() => {
    if (!local) search(query);
  }, [local, query, search]);
}
