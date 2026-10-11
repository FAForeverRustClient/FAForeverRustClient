// Whether the event list's archive is unfolded and how much of each year it
// draws. Held by the view rather than by the list, so it survives a visit to
// another of the site's pages, which unmounts the list.

import { useEffect, useState } from "react";
import { useAppStore } from "../../store/store";
import { groupOf } from "./tourneyPresentation";

export type EventListFold = ReturnType<typeof useEventListFold>;

export function useEventListFold() {
  const events = useAppStore((store) => store.state.tourney.events);
  const selectedId = useAppStore((store) => store.state.tourney.selectedId);
  const [showPast, setShowPast] = useState(false);
  /** How many of each archive year are drawn, keyed by year (0 for undated). */
  const [pastShown, setPastShown] = useState<Record<number, number>>({});

  // An event that was running when it was opened moves into the archive the
  // moment it finishes. Folding it away under the reader, with its own detail
  // still on screen beside the gap, reads as the row having vanished.
  const selectedIsPast =
    selectedId !== null &&
    events.some((event) => event.id === selectedId && groupOf(event) === "past");
  useEffect(() => {
    if (selectedIsPast) setShowPast(true);
  }, [selectedIsPast]);

  return { showPast, setShowPast, pastShown, setPastShown };
}
