import type { ConnectivityPreferences, IceAdapter } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { recordEntries } from "../../shared/records";
import { SettingRow } from "./SettingControls";
import type { MessageKey } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";

const save = (preferences: ConnectivityPreferences) =>
  ipc.send({
    kind: "Settings",
    command: { type: "setConnectivity", payload: { preferences } },
  });

// Dynamic first: it is the default, and the one that is right for any game
// whose host is on Java or hosts on Go in this client.
const ADAPTERS: Record<IceAdapter, MessageKey> = {
  dynamic: "settings.connectivity.dynamic",
  java: "settings.connectivity.java",
  go: "settings.connectivity.go",
};

export function ConnectivitySettingsSection() {
  const { t } = useTranslation();
  const preferences = useAppStore((state) => state.state.settings.connectivity);

  return (
    <SettingRow
      label={t("settings.connectivity.connectivityAdapter")}
      hint={t("settings.connectivity.connectivityAdapterHint")}
    >
      <select
        className="settings-select"
        value={preferences.adapter}
        onChange={(event) =>
          void save({
            ...preferences,
            adapter: event.target.value as IceAdapter,
            selectionVersion: 2,
          })
        }
        aria-label={t("settings.connectivity.connectivityAdapter")}
      >
        {recordEntries(ADAPTERS).map(([value, label]) => (
          <option key={value} value={value}>
            {t(label)}
          </option>
        ))}
      </select>
    </SettingRow>
  );
}
