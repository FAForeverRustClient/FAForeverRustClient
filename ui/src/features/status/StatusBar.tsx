// A feature view: pure, driven entirely by state. It selects its slice and
// renders: no business logic, no IPC calls (ARCHITECTURE.md §4).

import { useAppStore } from "../../store/store";
import type { ConnectionStatus } from "../../ipc/bindings";
import type { MessageKey } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";

const LABEL = {
  disconnected: "status.session.disconnected",
  connecting: "status.session.connecting",
  connected: "status.session.connected",
} as const satisfies Record<ConnectionStatus, MessageKey>;

export function StatusBar() {
  const { t } = useTranslation();
  const session = useAppStore((s) => s.state.session);

  return (
    <section className="status-bar" data-status={session.status}>
      <span className="status-dot" aria-hidden />
      <span className="status-label">{t(LABEL[session.status])}</span>
      {session.backendVersion && (
        <span className="status-version">{t("status.session.backendVersion", { version: session.backendVersion })}</span>
      )}
    </section>
  );
}
