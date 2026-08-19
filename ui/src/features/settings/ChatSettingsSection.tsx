import { useState } from "react";
import type { ChatPreferences } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { useAppStore } from "../../store/store";
import { SettingRow, SettingsSwitch } from "./SettingControls";
import { ChatNameColorSettings } from "./ChatNameColorSettings";
import { useTranslation } from "../../i18n/useTranslation";

const save = (preferences: ChatPreferences) =>
  ipc.send({ kind: "Settings", command: { type: "setChat", payload: { preferences } } });

export function ChatSettingsSection() {
  const { t } = useTranslation();
  const preferences = useAppStore((state) => state.state.settings.chat);
  const [channel, setChannel] = useState("");

  const addChannel = () => {
    const trimmed = channel.trim();
    if (!trimmed) return;
    const normalized = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
    void save({ ...preferences, autoJoinChannels: [...preferences.autoJoinChannels, normalized] });
    setChannel("");
  };

  return (
    <>
      <SettingRow label={t("settings.chat.messageTimestamps")} hint={t("settings.chat.messageTimestampsHint")}>
        <SettingsSwitch
          checked={preferences.showTimestamps}
          onChange={(showTimestamps) => void save({ ...preferences, showTimestamps })}
          label={t("settings.chat.messageTimestamps")}
        />
      </SettingRow>
      <SettingRow label={t("settings.chat.24HourTime")} hint={t("settings.chat.24HourTimeHint")}>
        <SettingsSwitch
          checked={preferences.use24HourTime}
          disabled={!preferences.showTimestamps}
          onChange={(use24HourTime) => void save({ ...preferences, use24HourTime })}
          label={t("settings.chat.24HourTime")}
        />
      </SettingRow>
      <SettingRow label={t("settings.chat.colorEveryName")} hint={t("settings.chat.colorEveryNameHint")}>
        <SettingsSwitch
          checked={preferences.coloredNames}
          onChange={(coloredNames) => void save({ ...preferences, coloredNames })}
          label={t("settings.chat.colorEveryName")}
        />
      </SettingRow>
      <ChatNameColorSettings preferences={preferences} onSave={(next) => void save(next)} />
      <SettingRow label={t("settings.chat.showJoinsParts")} hint={t("settings.chat.showJoinsPartsHint")}>
        <SettingsSwitch
          checked={preferences.showJoinsParts}
          onChange={(showJoinsParts) => void save({ ...preferences, showJoinsParts })}
          label={t("settings.chat.showJoinsParts")}
        />
      </SettingRow>
      <SettingRow label={t("settings.chat.hideFoeMessages")} hint={t("settings.chat.hideFoeMessagesHint")}>
        <SettingsSwitch
          checked={preferences.hideFoeMessages}
          onChange={(hideFoeMessages) => void save({ ...preferences, hideFoeMessages })}
          label={t("settings.chat.hideFoeMessages")}
        />
      </SettingRow>
      <SettingRow
        label={t("settings.chat.joinMyLanguage")}
        hint={t("settings.chat.joinMyLanguageHint")}
      >
        <SettingsSwitch
          checked={preferences.autoJoinLanguageChannel}
          onChange={(autoJoinLanguageChannel) =>
            void save({ ...preferences, autoJoinLanguageChannel })
          }
          label={t("settings.chat.joinMyLanguage")}
        />
      </SettingRow>
      <SettingRow
        label={t("settings.chat.autoJoinNewbie")}
        hint={t("settings.chat.autoJoinNewbieHint")}
      >
        <SettingsSwitch
          checked={preferences.autoJoinNewbieChannel}
          onChange={(autoJoinNewbieChannel) =>
            void save({ ...preferences, autoJoinNewbieChannel })
          }
          label={t("settings.chat.autoJoinNewbie")}
        />
      </SettingRow>
      <div className="setting-block settings-muted-players">
        <span className="setting-label">{t("settings.chat.mutedLabel")}</span>
        <span className="muted">{t("settings.chat.mutedHint")}</span>
        {preferences.mutedPlayers.length > 0 ? (
          <div className="settings-chip-list" aria-label={t("settings.chat.mutedPlayers")}>
            {preferences.mutedPlayers.map((player) => (
              <span className="settings-chip surface" key={player.toLocaleLowerCase()}>
                {player}
                <button
                  type="button"
                  aria-label={`Unmute ${player}`}
                  title={`Unmute ${player}`}
                  onClick={() => void save({
                    ...preferences,
                    mutedPlayers: preferences.mutedPlayers.filter(
                      (candidate) => candidate.localeCompare(player, undefined, { sensitivity: "accent" }) !== 0,
                    ),
                  })}
                >
                  <Icon name="close" size={12} />
                </button>
              </span>
            ))}
          </div>
        ) : <span className="settings-empty muted">{t("settings.chat.mutedEmpty")}</span>}
      </div>
      <SettingRow label={t("settings.chat.visibleHistory")} hint={t("settings.chat.visibleHistoryHint")}>
        <select
          className="settings-select"
          value={preferences.visibleMessageLimit}
          onChange={(event) => void save({ ...preferences, visibleMessageLimit: Number(event.target.value) })}
          aria-label={t("settings.chat.visibleChatHistory")}
        >
          <option value={100}>100 messages</option>
          <option value={250}>250 messages</option>
          <option value={500}>500 messages</option>
        </select>
      </SettingRow>
      <div className="setting-block settings-channels">
        <span className="setting-label">{t("settings.chat.autoJoinLabel")}</span>
        <span className="muted">{t("settings.chat.autoJoinHint")}</span>
        <div className="settings-inline-form">
          <input
            className="settings-input"
            value={channel}
            onChange={(event) => setChannel(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addChannel();
              }
            }}
            placeholder={t("settings.chat.channel")}
            aria-label={t("settings.chat.channelAutoJoin")}
          />
          <Button onClick={addChannel} disabled={!channel.trim()}>{t("settings.chat.add")}</Button>
        </div>
        {preferences.autoJoinChannels.length > 0 ? (
          <div className="settings-chip-list" aria-label={t("settings.chat.autoJoinChannels")}>
            {preferences.autoJoinChannels.map((item) => (
              <span className="settings-chip surface" key={item}>
                {item}
                <button
                  type="button"
                  aria-label={`Remove ${item}`}
                  title={`Remove ${item}`}
                  onClick={() => void save({
                    ...preferences,
                    autoJoinChannels: preferences.autoJoinChannels.filter((candidate) => candidate !== item),
                  })}
                >
                  <Icon name="close" size={12} />
                </button>
              </span>
            ))}
          </div>
        ) : <span className="settings-empty muted">{t("settings.chat.autoJoinEmpty")}</span>}
      </div>
    </>
  );
}
