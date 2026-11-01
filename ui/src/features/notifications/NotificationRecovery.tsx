import type { ClientNotification } from "../../ipc/bindings";
import { native } from "../../ipc/native";
import { ipc } from "../../ipc/client";
import { useClipboardCopy } from "../../shared/hooks/useClipboardCopy";
import { notificationBody, notificationTitle } from "./notificationText";
import { t } from "../../i18n";

export function NotificationRecovery({ item }: { item: ClientNotification }) {
  const [copied, copy] = useClipboardCopy([...new Set([notificationTitle(item), notificationBody(item), item.body])].join("\n"));
  return <div className="notification-recovery">
    <button className="btn-ghost" type="button" onClick={() => ipc.run(native.openLogFolder("client"))}>{t("notifications.openLogs")}</button>
    <button className="btn-ghost" type="button" onClick={() => ipc.run(copy())}>{copied ? t("notifications.copiedDetails") : t("notifications.copyDetails")}</button>
  </div>;
}
