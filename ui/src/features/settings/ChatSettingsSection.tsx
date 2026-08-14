import { useState } from "react";
import type { ChatPreferences } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { useAppStore } from "../../store/store";
import { SettingRow, SettingsSwitch } from "./SettingControls";
import { ChatNameColorSettings } from "./ChatNameColorSettings";

const save = (preferences: ChatPreferences) =>
  ipc.send({ kind: "Settings", command: { type: "setChat", payload: { preferences } } });

export function ChatSettingsSection() {
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
      <SettingRow label="Message timestamps" hint="Show a timestamp when the minute changes.">
        <SettingsSwitch
          checked={preferences.showTimestamps}
          onChange={(showTimestamps) => void save({ ...preferences, showTimestamps })}
          label="Message timestamps"
        />
      </SettingRow>
      <SettingRow label="24-hour time" hint="Use 18:30 instead of 6:30 PM.">
        <SettingsSwitch
          checked={preferences.use24HourTime}
          disabled={!preferences.showTimestamps}
          onChange={(use24HourTime) => void save({ ...preferences, use24HourTime })}
          label="24-hour time"
        />
      </SettingRow>
      <SettingRow label="Color every name" hint="Give otherwise unassigned players a stable generated color.">
        <SettingsSwitch
          checked={preferences.coloredNames}
          onChange={(coloredNames) => void save({ ...preferences, coloredNames })}
          label="Color every name"
        />
      </SettingRow>
      <ChatNameColorSettings preferences={preferences} onSave={(next) => void save(next)} />
      <SettingRow label="Show joins and parts" hint="Include channel join, leave, quit, and topic commentary.">
        <SettingsSwitch
          checked={preferences.showJoinsParts}
          onChange={(showJoinsParts) => void save({ ...preferences, showJoinsParts })}
          label="Show joins and parts"
        />
      </SettingRow>
      <SettingRow label="Hide foe messages" hint="Keep messages from players on your foe list out of the conversation.">
        <SettingsSwitch
          checked={preferences.hideFoeMessages}
          onChange={(hideFoeMessages) => void save({ ...preferences, hideFoeMessages })}
          label="Hide foe messages"
        />
      </SettingRow>
      <SettingRow
        label="Join my language channel"
        hint="Join FAF's channel for your language when there is one (#german, #french, #russian). Chosen from your system language, or your account's country flag."
      >
        <SettingsSwitch
          checked={preferences.autoJoinLanguageChannel}
          onChange={(autoJoinLanguageChannel) =>
            void save({ ...preferences, autoJoinLanguageChannel })
          }
          label="Join my language channel"
        />
      </SettingRow>
      <div className="setting-block settings-muted-players">
        <span className="setting-label">Muted players</span>
        <span className="muted">Messages and notifications from these players are suppressed.</span>
        {preferences.mutedPlayers.length > 0 ? (
          <div className="settings-chip-list" aria-label="Muted players">
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
        ) : <span className="settings-empty muted">No muted players.</span>}
      </div>
      <SettingRow label="Visible history" hint="Limit rendered messages per conversation for a responsive long-running chat.">
        <select
          className="settings-select"
          value={preferences.visibleMessageLimit}
          onChange={(event) => void save({ ...preferences, visibleMessageLimit: Number(event.target.value) })}
          aria-label="Visible chat history"
        >
          <option value={100}>100 messages</option>
          <option value={250}>250 messages</option>
          <option value={500}>500 messages</option>
        </select>
      </SettingRow>
      <div className="setting-block settings-channels">
        <span className="setting-label">Auto-join channels</span>
        <span className="muted">Join these additional IRC channels after connecting.</span>
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
            placeholder="#channel"
            aria-label="Channel to auto-join"
          />
          <Button onClick={addChannel} disabled={!channel.trim()}>Add</Button>
        </div>
        {preferences.autoJoinChannels.length > 0 ? (
          <div className="settings-chip-list" aria-label="Auto-join channels">
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
        ) : <span className="settings-empty muted">No additional channels.</span>}
      </div>
    </>
  );
}
