import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuthState } from "../ipc/bindings";
import { clearDrafts, partyDraftKey, readDraft, tournamentDraftKey, writeDraft } from "../shared/chatDrafts";
import { useAppStore } from "./store";

const initial = useAppStore.getState();
const player = { id: 1, name: "First", roles: [] };
const keys = ["#aeolus", "Somebody", partyDraftKey("party"), tournamentDraftKey("event", "global")];
// The authoritative auth state each Rust `AuthEvent` leaves behind
// (`crates/faf-domain/src/state/auth.rs`), as the window now receives it.
const signedIn: Partial<AuthState> = { status: "loggedIn", player, mode: "account", error: null, signInLink: null };
const signedOut: Partial<AuthState> = { status: "loggedOut", player: null, mode: "account", error: null, signInLink: null };
const authenticate = (auth: Partial<AuthState>) =>
  useAppStore.getState().apply({ kind: "Auth", event: { ...useAppStore.getState().state.auth, ...auth } });

beforeEach(() => {
  useAppStore.setState(initial, true);
  clearDrafts();
  authenticate(signedIn);
  for (const key of keys) writeDraft(key, "private unfinished line");
});

afterEach(() => {
  useAppStore.setState(initial, true);
  clearDrafts();
});

describe("chat draft account boundaries without mounted chat views", () => {
  it.each<[string, Partial<AuthState>]>([
    ["loggedOut", signedOut],
    ["loginStarted", { status: "loggingIn", error: null, signInLink: null }],
    ["wentOffline", { status: "loggedIn", player: null, mode: "offline", error: null, signInLink: null }],
    ["banned", { status: "loggedIn", player: null, mode: "offline", error: "Unavailable", signInLink: null }],
    ["loggedIn as another player", { ...signedIn, player: { ...player, id: 2 } }],
    ["testLoggedIn", { ...signedIn, mode: "test" }],
  ])("forgets every conversation on %s", (_, auth) => {
    authenticate(auth);
    for (const key of keys) expect(readDraft(key)).toBe("");
  });

  it("does not restore old drafts after signing back into the same account", () => {
    authenticate(signedOut);
    authenticate(signedIn);
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
