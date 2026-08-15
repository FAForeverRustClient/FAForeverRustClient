import type { ConnectivityPreferences, IceAdapter } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { recordEntries } from "../../shared/records";
import { SettingRow } from "./SettingControls";

const save = (preferences: ConnectivityPreferences) =>
  ipc.send({
    kind: "Settings",
    command: { type: "setConnectivity", payload: { preferences } },
  });

const ADAPTERS: Record<IceAdapter, string> = {
  java: "Java (faf-ice-adapter, recommended)",
  go: "Go (faf-pioneer, experimental)",
};

export function ConnectivitySettingsSection() {
  const preferences = useAppStore((state) => state.state.settings.connectivity);

  return (
    <SettingRow
      label="Connectivity adapter"
      hint="Java is the established adapter used by the reference clients. Pioneer is experimental. The choice takes effect on your next game."
    >
      <select
        className="settings-select"
        value={preferences.adapter}
        onChange={(event) =>
          void save({
            ...preferences,
            adapter: event.target.value as IceAdapter,
            selectionVersion: 1,
          })
        }
        aria-label="Connectivity adapter"
      >
        {recordEntries(ADAPTERS).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    </SettingRow>
  );
}
