import type { WebLinkPreferencesPatch } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { SettingRow, SettingsGroup, SettingsSwitch } from "./SettingControls";
import { useTranslation } from "../../i18n/useTranslation";

const save = (patch: WebLinkPreferencesPatch) =>
  ipc.send({
    kind: "Settings",
    command: { type: "patchWebLink", payload: { patch } },
  });

/**
 * The web client (webclient.faforever.com) steering this client: off until the
 * player turns it on. What it may do is `faf_domain::protocol::web_link`.
 *
 * Not offered by a client without a lobby, the Android one: everything the web
 * client steers is the lobby's, so the backend never links such a client and
 * the switch would do nothing.
 */
export function WebLinkSettingsSection() {
  const { t } = useTranslation();
  const preferences = useAppStore((state) => state.state.settings.webLink);
  const lobbyUnavailable = useAppStore((state) => state.state.lobby.unavailable);

  if (lobbyUnavailable !== null) return null;

  return (
    <SettingsGroup title={t("settings.section.webLink.title")}>
      <SettingRow label={t("settings.webLink.enabled")} hint={t("settings.webLink.enabledHint")}>
        <SettingsSwitch
          checked={preferences.enabled}
          onChange={(enabled) => void save({ enabled })}
          label={t("settings.webLink.enabled")}
        />
      </SettingRow>
    </SettingsGroup>
  );
}
