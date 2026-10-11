// What the training tab remembers about how it was being looked at.
//
// None of this is domain state: the backend never acts on which section is
// open, how the shelves are sorted or where the page was scrolled to. It still
// has to outlive the components that draw it. Leaving the tab for the chat
// unmounts the whole view, and opening a guide replaces the library with the
// detail page; with all of this in component state, coming back from either
// put the reader on the overview with the sort, the filter panel and every
// opened shelf reset, scrolled to wherever the guide had been left.
//
// A store of its own rather than a slice of the app store, because the app
// store mirrors the backend and only changes through its events.

import { create } from "zustand";
import type { LibrarySort } from "./libraryGroups";

export type TrainingSection = "hub" | "library" | "lessons" | "trainers" | "contribute" | "pending";

interface TrainingViewState {
  /** The section on screen, or the one an open entry was opened from. */
  section: TrainingSection;
  /** The library's chosen order. */
  sort: LibrarySort;
  /** Whether the library's narrow filters are unfolded. */
  refining: boolean;
  /** Shelves the reader opened in full, keyed by `shelfKey`. */
  openShelves: string[];
  /**
   * Where each section's list was scrolled to while no entry was open, so
   * back from an entry lands where the reader left.
   */
  scroll: Partial<Record<TrainingSection, number>>;
  setSection: (section: TrainingSection) => void;
  setSort: (sort: LibrarySort) => void;
  setRefining: (refining: boolean) => void;
  toggleShelf: (key: string) => void;
  rememberScroll: (section: TrainingSection, top: number) => void;
}

/**
 * A shelf's identity across visits: which kind tab it sits under and which
 * mode it shelves. The same "1v1" heading under "Build orders" and under
 * "Videos" holds different cards and is opened separately.
 */
export function shelfKey(kind: string | null, collection: string): string {
  return `${kind ?? "all"}|${collection}`;
}

export const useTrainingView = create<TrainingViewState>((set) => ({
  section: "hub",
  sort: "forYou",
  refining: false,
  openShelves: [],
  scroll: {},
  setSection: (section) => set({ section }),
  setSort: (sort) => set({ sort }),
  setRefining: (refining) => set({ refining }),
  toggleShelf: (key) =>
    set((state) => ({
      openShelves: state.openShelves.includes(key)
        ? state.openShelves.filter((open) => open !== key)
        : [...state.openShelves, key],
    })),
  rememberScroll: (section, top) =>
    set((state) => ({ scroll: { ...state.scroll, [section]: top } })),
}));
