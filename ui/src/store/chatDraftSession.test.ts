import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthEvent } from "../ipc/bindings";
import { clearDrafts, partyDraftKey, readDraft, tournamentDraftKey, writeDraft } from "../shared/chatDrafts";
import { useAppStore } from "./store";

const initial = useAppStore.getState();
const player = { id: 1, name: "First", roles: [] };
const keys = ["#aeolus", "Somebody", partyDraftKey("party"), tournamentDraftKey("event", "global")];
const authenticate = (event: AuthEvent) => useAppStore.getState().apply({ kind: "Auth", event });

beforeEach(() => {
  useAppStore.setState(initial, true);
  clearDrafts();
  authenticate({ type: "loggedIn", payload: { player } });
  for (const key of keys) writeDraft(key, "private unfinished line");
});

afterEach(() => {
  useAppStore.setState(initial, true);
  clearDrafts();
});

describe("chat draft account boundaries without mounted chat views", () => {
  it.each<AuthEvent>([
    { type: "loggedOut" },
    { type: "loginStarted" },
    { type: "wentOffline" },
    { type: "banned", payload: { message: "Unavailable" } },
    { type: "loggedIn", payload: { player: { ...player, id: 2 } } },
    { type: "testLoggedIn", payload: { player } },
  ])("forgets every conversation on $type", (event) => {
    authenticate(event);
    for (const key of keys) expect(readDraft(key)).toBe("");
  });

  it("does not restore old drafts after signing back into the same account", () => {
    authenticate({ type: "loggedOut" });
    authenticate({ type: "loggedIn", payload: { player } });
    for (const key of keys) expect(readDraft(key)).toBe("");
  });

  it("clears drafts when a replacement snapshot changes the account", () => {
    const { state, hydrate } = useAppStore.getState();
    hydrate({ ...state, auth: { ...state.auth, player: { ...player, id: 2 } } });
    for (const key of keys) expect(readDraft(key)).toBe("");
  });

  it("preserves drafts through same-account snapshots, renames and connection changes", () => {
    const { state, hydrate } = useAppStore.getState();
    hydrate({ ...state, auth: { ...state.auth, player: { ...player, name: "Renamed" } } });
    useAppStore.getState().apply({ kind: "Chat", event: { type: "disconnected" } });
    for (const key of keys) expect(readDraft(key)).toBe("private unfinished line");
  });
});
