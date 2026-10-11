import type { IceAdapter, ConnectivityPreferencesPatch } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { recordEntries } from "../../shared/records";
import { SettingRow } from "./SettingControls";
import type { MessageKey } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";

const save = (patch: ConnectivityPreferencesPatch) =>
  ipc.send({
    kind: "Settings",
    command: { type: "patchConnectivity", payload: { patch } },
  });

// Dynamic first: it is the default, and the one that is right for any game
// whose host is on Java or hosts on Go in this client.
const JOIN_ADAPTERS: Record<IceAdapter, MessageKey> = {
  dynamic: "settings.connectivity.dynamic",
  java: "settings.connectivity.java",
  go: "settings.connectivity.go",
};

// Hosting has no host to follow, so it is a plain choice between the two.
type HostAdapter = Exclude<IceAdapter, "dynamic">;
const HOST_ADAPTERS: Record<HostAdapter, MessageKey> = {
  java: "settings.connectivity.java",
  go: "settings.connectivity.go",
};

export function ConnectivitySettingsSection() {
  const { t } = useTranslation();
  const preferences = useAppStore((state) => state.state.settings.connectivity);
  const change = (next: ConnectivityPreferencesPatch) =>
    void save({ ...next, selectionVersion: 2 });

  return (
    <>
      <SettingRow
        label={t("settings.connectivity.connectivityAdapter")}
        hint={t("settings.connectivity.connectivityAdapterHint")}
      >
        <select
          className="settings-select"
          value={preferences.adapter}
          onChange={(event) => change({ adapter: event.target.value as IceAdapter })}
          aria-label={t("settings.connectivity.connectivityAdapter")}
        >
          {recordEntries(JOIN_ADAPTERS).map(([value, label]) => (
            <option key={value} value={value}>
              {t(label)}
            </option>
          ))}
        </select>
      </SettingRow>
      <SettingRow
        label={t("settings.connectivity.hostAdapter")}
        hint={t("settings.connectivity.hostAdapterHint")}
      >
        <select
          className="settings-select"
          value={preferences.hostAdapter === "go" ? "go" : "java"}
          onChange={(event) => change({ hostAdapter: event.target.value === "go" ? "go" : "java" })}
          aria-label={t("settings.connectivity.hostAdapter")}
        >
          {recordEntries(HOST_ADAPTERS).map(([value, label]) => (
            <option key={value} value={value}>
              {t(label)}
            </option>
          ))}
        </select>
      </SettingRow>
    </>
  );
}
