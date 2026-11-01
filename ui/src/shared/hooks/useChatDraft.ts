import { useCallback, useSyncExternalStore } from "react";
import { draftSession, readDraft, subscribeDrafts, writeDraft } from "../chatDrafts";

/** Session-only text shared by every view of the same conversation. */
export function useChatDraft(key: string) {
  const session = useSyncExternalStore(subscribeDrafts, draftSession);
  const draft = useSyncExternalStore(subscribeDrafts, () => readDraft(key));
  const setDraft = useCallback((text: string) => writeDraft(key, text, session), [key, session]);
  return [draft, setDraft, session] as const;
}
