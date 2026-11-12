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
 */
export function WebLinkSettingsSection() {
  const { t } = useTranslation();
  const preferences = useAppStore((state) => state.state.settings.webLink);

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
