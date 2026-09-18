// The filter form the vault and the installed library share.
//
// Both views ask the same nine questions about a map (name, author, ranked,
// rating range, player range, width, height) and used to keep two copies of
// the answers, one `useState` per field per view: twenty-two hooks that had
// to be kept in step by hand. The fields each view adds on top (the vault's
// sort, install filter and upload dates; the library's preset and sort) stay
// in the view, because they are not the same question.

import { useCallback, useState } from "react";

export type RankedFilter = "all" | "ranked" | "unranked";

export interface MapFilterDraft {
  search: string;
  author: string;
  ranked: RankedFilter;
  /** In stars; the domain keeps tenths. `null` is "no bound". */
  minimumRating: number | null;
  maximumRating: number | null;
  minimumPlayers: number | null;
  maximumPlayers: number | null;
  /** In map units; `0` is "any". */
  width: number;
  height: number;
}

export const EMPTY_MAP_FILTER_DRAFT: MapFilterDraft = {
  search: "",
  author: "",
  ranked: "all",
  minimumRating: null,
  maximumRating: null,
  minimumPlayers: null,
  maximumPlayers: null,
  width: 0,
  height: 0,
};

export function useMapFilterDraft() {
  const [draft, setDraft] = useState<MapFilterDraft>(EMPTY_MAP_FILTER_DRAFT);
  const setFilter = useCallback((patch: Partial<MapFilterDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
  }, []);
  const resetFilters = useCallback(() => setDraft(EMPTY_MAP_FILTER_DRAFT), []);
  return { draft, setFilter, resetFilters };
}
