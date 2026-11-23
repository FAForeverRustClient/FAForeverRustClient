import { useRef } from "react";
import type { ChatPreferences } from "../../ipc/bindings";
import { useAppStore } from "../../store/store";

/**
 * The chat preferences, keeping their identity while only the read markers
 * change. Marking the open channel read stores a marker in this preferences
 * group, so the whole group was replaced for every line that arrived while the
 * window had focus, and the message list re-rendered and re-measured itself
 * for a value nothing in the chat view reads.
 */
export function useDisplayedChatPreferences(): ChatPreferences {
  const preferences = useAppStore((s) => s.state.settings.chat);
  const displayed = useRef(preferences);
  if (displayed.current !== preferences && !sameApartFromReadMarkers(displayed.current, preferences)) {
    displayed.current = preferences;
  }
  return displayed.current;
}

/** Whether two preference groups differ in nothing but their read markers. */
export function sameApartFromReadMarkers(a: ChatPreferences, b: ChatPreferences): boolean {
  return JSON.stringify({ ...a, readMarkers: null }) === JSON.stringify({ ...b, readMarkers: null });
}
