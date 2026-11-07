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

  it("replaces chat and unread alerts in the same update that switches accounts", () => {
    const { apply, state } = useAppStore.getState();
    apply({ kind: "Chat", event: { type: "messageReceived", payload: {
      channel: "Contact",
      message: {
        id: "private", sender: "Contact", content: "private message",
        timestamp: "2026-01-01T00:00:00Z", kind: "message", msgid: "", replyTo: "",
      },
    } } });
    apply({ kind: "Notifications", event: { items: [{
      id: "private-alert", kind: "privateMessage", title: "Message from Contact", body: "private message",
      createdAt: "2026-01-01T00:00:00Z", read: false, action: null, text: null,
    }] } });
    expect(useAppStore.getState().state.chat.channels).toHaveLength(1);
    expect(useAppStore.getState().state.notifications.items).toHaveLength(1);

    const observed: [number | undefined, number, number][] = [];
    const unsubscribe = useAppStore.subscribe(({ state: next }) => {
      observed.push([next.auth.player?.id, next.chat.channels.length, next.notifications.items.length]);
    });
    try {
      apply({ kind: "AccountSession", event: {
        auth: { ...state.auth, player: { ...player, id: 2 } },
        chat: initial.state.chat,
        notifications: initial.state.notifications,
      } });
      expect(observed).toEqual([[2, 0, 0]]);
      for (const key of keys) expect(readDraft(key)).toBe("");
    } finally {
      unsubscribe();
    }
  });
});
