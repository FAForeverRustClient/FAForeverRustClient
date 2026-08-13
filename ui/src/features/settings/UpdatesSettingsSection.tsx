import type { ClientUpdateState, UpdatePreferences } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { Button } from "../../design-system/Button";
import { useAppStore } from "../../store/store";
import { isUpdateBusy } from "../../store/reducers/clientUpdate";
import { SettingRow, SettingsSwitch } from "./SettingControls";
import "../updates/updates.css";

const save = (preferences: UpdatePreferences) =>
  ipc.send({
    kind: "Settings",
    command: { type: "setUpdates", payload: { preferences } },
  });

const checkNow = () => ipc.send({ kind: "ClientUpdate", command: { type: "check" } });

export function UpdatesSettingsSection() {
  const preferences = useAppStore((s) => s.state.settings.updates);
  const update = useAppStore((s) => s.state.clientUpdate);

  return (
    <>
      <SettingRow
        label="Check for updates at startup"
        hint="Asks the project's release page whether a newer client exists. This is the only outbound request the client makes before you log in."
      >
        <SettingsSwitch
          checked={preferences.automatic}
          onChange={(automatic) => void save({ ...preferences, automatic })}
          label="Check for updates at startup"
        />
      </SettingRow>
      <SettingRow
        label="Include pre-releases"
        hint="Offers release candidates and beta builds as well. They get fixes first and break first."
      >
        <SettingsSwitch
          checked={preferences.preRelease}
          onChange={(preRelease) => void save({ ...preferences, preRelease })}
          label="Include pre-releases"
        />
      </SettingRow>
      <SettingRow
        label="Update status"
        hint="Checking here does not install anything: an available update is offered in a banner you can dismiss."
        className="setting-row-update-status"
      >
        <div className="update-settings-status">
          <Button onClick={() => void checkNow()} disabled={isUpdateBusy(update.status)}>
            {update.status.type === "checking" ? "Checking…" : "Check now"}
          </Button>
          <span>{describe(update)}</span>
        </div>
      </SettingRow>
    </>
  );
}

function describe(update: ClientUpdateState): string {
  const running = update.currentVersion ? `Running ${update.currentVersion}` : "Version unknown";
  switch (update.status.type) {
    case "idle":
      return `${running}: not checked yet`;
    case "checking":
      return running;
    case "upToDate":
      return `${running}: up to date`;
    case "available":
    case "downloading":
    case "ready":
    case "installing":
      return `${running}: ${update.release?.version ?? "a newer version"} is available`;
    case "failed":
      // Shown here even when the banner stays hidden: a background check that
      // keeps failing should be discoverable somewhere rather than nowhere.
      return `${running}: ${update.status.payload.reason}`;
  }
}
