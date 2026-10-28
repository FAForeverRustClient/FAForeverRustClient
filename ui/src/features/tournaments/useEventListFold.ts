// Whether the event list's archive is unfolded and how much of each year it
// draws. Held by the view rather than by the list, so it survives a visit to
// another of the site's pages, which unmounts the list.

import { useCallback, useEffect, useState } from "react";
import { loadStoredSet, saveStoredSet } from "../../shared/storage";
import { useAppStore } from "../../store/store";
import { groupOf } from "./tourneyPresentation";

/** The list's groups that fold away on request, as the website's sections. */
export type FoldableGroup = "myDrafts" | "drafts";

const FOLDABLE: readonly FoldableGroup[] = ["myDrafts", "drafts"];

/**
 * Which of them are folded, kept across restarts like the website's
 * `faf_home_sections`: somebody who folded away the drafts did it so as not
 * to see them every time (issue 610).
 */
const FOLDED_KEY = "faf.tournaments.foldedGroups";

const isFoldable = (value: unknown): value is FoldableGroup =>
  FOLDABLE.includes(value as FoldableGroup);

export type EventListFold = ReturnType<typeof useEventListFold>;

export function useEventListFold() {
  const events = useAppStore((store) => store.state.tourney.events);
  const selectedId = useAppStore((store) => store.state.tourney.selectedId);
  const [showPast, setShowPast] = useState(false);
  /** How many of each archive year are drawn, keyed by year (0 for undated). */
  const [pastShown, setPastShown] = useState<Record<number, number>>({});
  const [folded, setFolded] = useState<Set<FoldableGroup>>(() => loadStoredSet(FOLDED_KEY, isFoldable));
  const toggleFolded = useCallback((group: FoldableGroup) => {
    setFolded((current) => {
      const next = new Set(current);
      if (!next.delete(group)) next.add(group);
      saveStoredSet(FOLDED_KEY, next);
      return next;
    });
  }, []);

  // An event that was running when it was opened moves into the archive the
  // moment it finishes. Folding it away under the reader, with its own detail
  // still on screen beside the gap, reads as the row having vanished.
  const selectedIsPast =
    selectedId !== null &&
    events.some((event) => event.id === selectedId && groupOf(event) === "past");
  useEffect(() => {
    if (selectedIsPast) setShowPast(true);
  }, [selectedIsPast]);

  return { showPast, setShowPast, pastShown, setPastShown, folded, toggleFolded };
}
