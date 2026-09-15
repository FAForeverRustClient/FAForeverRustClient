// Register 00: the whole tab on one page.
//
// Every register with its number, its one line, and what it currently says. The
// summary column is the reason this page is worth opening rather than being a
// second copy of the sidebar: "what is my cache doing" and "did I ever set a
// custom folder" are answered here without visiting nine registers to find out.
//
// Each summary is one short phrase, built from the same state the register
// itself renders. A register with nothing worth reporting says what it is
// about instead of inventing a number.

import type { MessageKey } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";
import { useAppStore } from "../../store/store";
import { REGISTERS, REGISTER_ORDER, type RegisterKey } from "./registers";
import { useSettingsIndexEntry } from "./SettingControls";

const PATH_FIELDS = [
  "vaultDir",
  "mapsDir",
  "modsDir",
  "replaysDir",
  "mapGeneratorDir",
  "gamePrefsPath",
  "javaPath",
] as const;

/**
 * The event toggles, as the summary counts them.
 *
 * `newCustomGamesFriendsOnly` is deliberately absent: it narrows the new-games
 * alert rather than being an alert of its own, so counting it would report
 * thirteen of thirteen to somebody who has twelve events on.
 */
const NOTIFICATION_EVENTS = [
  "matchFound",
  "privateMessages",
  "mentions",
  "friendOnline",
  "friendOffline",
  "friendPlaying",
  "newCustomGames",
  "gameFull",
  "gameLaunched",
  "reviewReminder",
  "partyInvites",
  "streamLive",
] as const;

/** `1.4 GB`, or an em-free "unknown" when the scan has not run. */
function gigabytes(bytes: number | null | undefined): string | null {
  if (bytes === null || bytes === undefined) return null;
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 10) return `${Math.round(gb)} GB`;
  if (gb >= 0.1) return `${gb.toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;
}

function useSummaries(): Record<RegisterKey, string> {
  const { t } = useTranslation();
  const settings = useAppStore((s) => s.state.settings);
  const player = useAppStore((s) => s.state.auth.player);
  const install = useAppStore((s) => s.state.install);

  const enabledEvents = NOTIFICATION_EVENTS.filter((event) => settings.notifications[event]).length;

  const customPaths = PATH_FIELDS.filter((field) => (settings.paths[field] ?? "") !== "").length;
  const debug = settings.debug;
  const debugWindows = [debug.iceAdapterDebugWindow, debug.iceAdapterInfoWindow, debug.iceAdapterConsoleWindow]
    .filter(Boolean).length;

  const cacheSize = gigabytes(settings.cacheInfo?.totalSizeBytes);

  return {
    // Both of these are built from a value rather than looked up in a table:
    // the tab and theme keys are named after the values themselves, so a new
    // tab or theme needs nothing added here.
    client: t(`nav.tab.${settings.general.startPage}.label` as MessageKey),
    appearance: [
      t(`settings.theme.${settings.theme}` as MessageKey),
      t(settings.appearance.density === "compact"
        ? "settings.appearance.compact"
        : "settings.appearance.comfortable"),
    ].join(" · "),
    chat: t("settings.index.summary.chat", { count: settings.chat.visibleMessageLimit }),
    notifications: settings.notifications.enabled
      ? t("settings.index.summary.notificationsOn", {
        count: enabledEvents,
        total: NOTIFICATION_EVENTS.length,
      })
      : t("settings.index.summary.off"),
    account: player ? player.name : t("settings.index.summary.signedOut"),
    game: install.gameReady
      ? t("settings.index.summary.gameReady")
      : install.gamePending
        ? t("settings.index.summary.gamePending")
        : t("settings.index.summary.gameMissing"),
    paths: customPaths === 0
      ? t("settings.index.summary.pathsAutomatic")
      : t("settings.index.summary.pathsCustom", { count: customPaths, total: PATH_FIELDS.length }),
    cache: cacheSize ?? t("settings.index.summary.cacheUnknown"),
    // The adapter names itself the same way the register's own select does,
    // rather than through a second table that could disagree with it.
    connectivity: t(`settings.connectivity.${settings.connectivity.adapter}` as MessageKey),
    diagnostics: debugWindows === 0 && !debug.mapGeneratorWindow
      ? t("settings.index.summary.diagnosticsQuiet")
      : t("settings.index.summary.diagnosticsWindows", {
        count: debugWindows + (debug.mapGeneratorWindow ? 1 : 0),
      }),
  };
}

export function SettingsIndex({ onOpen }: { onOpen: (register: RegisterKey) => void }) {
  const { t } = useTranslation();
  const summaries = useSummaries();
  useSettingsIndexEntry(t("settings.register.index.title"), t("settings.register.index.description"));

  return (
    <ul className="settings-index">
      {REGISTER_ORDER.map((key) => {
        const register = REGISTERS[key];
        return (
          <li key={key}>
            <button type="button" className="settings-index-row" onClick={() => onOpen(key)}>
              <span className="settings-index-no">{register.no}</span>
              <span className="settings-index-name">{t(register.title)}</span>
              <span className="settings-index-about muted">{t(register.description)}</span>
              <span className="settings-index-value">{summaries[key]}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
