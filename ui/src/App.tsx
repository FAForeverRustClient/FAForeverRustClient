// App shell. Owns the single event subscription and startup handshake, then
// routes purely from state: logged in → Home, otherwise → Login. No router logic
// beyond selecting a slice (ARCHITECTURE.md §4).

import { useEffect } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { ipc } from "./ipc/client";
import { useAppStore } from "./store/store";
import { LoginView } from "./features/auth/LoginView";
import { AppShell } from "./features/shell/AppShell";

export function App() {
  const authStatus = useAppStore((s) => s.state.auth.status);
  const theme = useAppStore((s) => s.state.settings.theme);

  // Project the backend's theme preference onto the document. The only place the
  // UI reacts to theme — every component just reads tokens (ARCHITECTURE.md §4).
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    let active = true;
    let unlisten: UnlistenFn | undefined;

    (async () => {
      // 1. Single subscription: every backend event flows into the store.
      unlisten = await ipc.onEvent((event) => useAppStore.getState().apply(event));
      // 2. Hydrate from a snapshot so the UI starts consistent with the backend.
      useAppStore.getState().hydrate(await ipc.snapshot());
      if (!active) return;
      // 3. Kick the connection handshake. Login is user-initiated from the UI.
      await ipc.dispatch({ kind: "Session", command: { type: "hello" } });
    })();

    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  return authStatus === "loggedIn" ? <AppShell /> : <LoginView />;
}
