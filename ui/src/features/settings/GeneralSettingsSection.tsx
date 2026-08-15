import type { GeneralPreferences, Tab } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { SettingRow } from "./SettingControls";

const START_PAGES: Array<{ value: Tab; label: string }> = [
  { value: "news", label: "News" },
  { value: "chat", label: "Chat" },
  { value: "play", label: "Play" },
  { value: "replays", label: "Replays" },
  { value: "maps", label: "Maps" },
  { value: "mods", label: "Mods" },
  { value: "leaderboard", label: "Leaderboards" },
  { value: "tournaments", label: "Tournaments" },
  { value: "tutorials", label: "Tutorials" },
];

const save = (preferences: GeneralPreferences) =>
  ipc.send({ kind: "Settings", command: { type: "setGeneral", payload: { preferences } } });

export function GeneralSettingsSection() {
  const preferences = useAppStore((state) => state.state.settings.general);

  return (
    <SettingRow label="Start page" hint="Destination selected whenever the client starts.">
      <select
        className="settings-select"
        value={preferences.startPage}
        onChange={(event) => void save({ ...preferences, startPage: event.target.value as Tab })}
        aria-label="Start page"
      >
        {START_PAGES.map((page) => <option key={page.value} value={page.value}>{page.label}</option>)}
      </select>
    </SettingRow>
  );
}
