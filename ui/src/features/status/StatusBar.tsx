// A feature view: pure, driven entirely by state. It selects its slice and
// renders: no business logic, no IPC calls (ARCHITECTURE.md §4).

import { useAppStore } from "../../store/store";
import type { ConnectionStatus } from "../../ipc/bindings";

const LABEL: Record<ConnectionStatus, string> = {
  disconnected: "Disconnected",
  connecting: "Connecting…",
  connected: "Connected",
};

export function StatusBar() {
  const session = useAppStore((s) => s.state.session);

  return (
    <section className="status-bar" data-status={session.status}>
      <span className="status-dot" aria-hidden />
      <span className="status-label">{LABEL[session.status]}</span>
      {session.backendVersion && (
        <span className="status-version">backend v{session.backendVersion}</span>
      )}
    </section>
  );
}
