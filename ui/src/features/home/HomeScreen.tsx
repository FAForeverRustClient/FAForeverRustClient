// Home tab content. Connection status + a welcome line. Pure presentation.
// (The topbar/logout moved to AppShell so they persist across tabs.)

import { useAppStore } from "../../store/store";
import { StatusBar } from "../status/StatusBar";

export function HomeScreen() {
  const player = useAppStore((s) => s.state.auth.player);

  return (
    <div className="home">
      <StatusBar />
      <p className="app-subtitle">
        Welcome back{player ? `, ${player.name}` : ""}. Head to <strong>Play</strong> to
        see open games.
      </p>
    </div>
  );
}
