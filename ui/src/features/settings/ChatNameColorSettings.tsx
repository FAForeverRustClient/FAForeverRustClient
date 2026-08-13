import { useMemo, useState } from "react";
import type { ChatNameColors, ChatPreferences } from "../../ipc/bindings";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { DEFAULT_COLOR_PICKER_VALUE } from "../../shared/nameColors";

type CategoryKey = Exclude<keyof ChatNameColors, "players">;

const CATEGORIES: Array<{ key: CategoryKey; label: string }> = [
  { key: "friends", label: "Friends" },
  { key: "foes", label: "Foes" },
  { key: "moderators", label: "Moderators" },
  { key: "admins", label: "Administrators" },
];

export function ChatNameColorSettings({
  preferences,
  onSave,
}: {
  preferences: ChatPreferences;
  onSave: (preferences: ChatPreferences) => void;
}) {
  const [player, setPlayer] = useState("");
  const [playerColor, setPlayerColor] = useState(DEFAULT_COLOR_PICKER_VALUE);
  const assignedPlayers = useMemo(
    () => Object.entries(preferences.nameColors.players)
      .sort(([left], [right]) => left.localeCompare(right, undefined, { sensitivity: "base" })),
    [preferences.nameColors.players],
  );

  const saveColors = (nameColors: ChatNameColors) => onSave({ ...preferences, nameColors });
  const setCategoryColor = (key: CategoryKey, color: string) => {
    saveColors({ ...preferences.nameColors, [key]: color });
  };
  const removePlayer = (nickname: string) => {
    saveColors({
      ...preferences.nameColors,
      players: Object.fromEntries(
        assignedPlayers.filter(([candidate]) => candidate !== nickname),
      ),
    });
  };
  const addPlayer = () => {
    const nickname = player.trim();
    if (!nickname) return;
    const players = Object.fromEntries(
      assignedPlayers.filter(
        ([candidate]) => candidate.localeCompare(nickname, undefined, { sensitivity: "accent" }) !== 0,
      ),
    );
    players[nickname] = playerColor;
    saveColors({ ...preferences.nameColors, players });
    setPlayer("");
  };

  return (
    <div className="setting-block chat-name-color-settings">
      <span className="setting-label">Name color rules</span>
      <span className="muted">
        Individual assignments take priority, followed by administrators, moderators, friends, and foes.
      </span>

      <div className="chat-category-colors">
        {CATEGORIES.map(({ key, label }) => {
          const color = preferences.nameColors[key];
          return (
            <div className="chat-color-rule surface" key={key}>
              <span>{label}</span>
              <span className="chat-color-state">{color || "Default"}</span>
              <input
                type="color"
                value={color || DEFAULT_COLOR_PICKER_VALUE}
                aria-label={`Choose a name color for ${label.toLocaleLowerCase()}`}
                onChange={(event) => setCategoryColor(key, event.target.value)}
              />
              <button
                type="button"
                className="chat-color-clear surface surface-interactive"
                disabled={!color}
                aria-label={`Clear the name color for ${label.toLocaleLowerCase()}`}
                title="Use default text color"
                onClick={() => setCategoryColor(key, "")}
              >
                <Icon name="close" size={12} />
              </button>
            </div>
          );
        })}
      </div>

      <div className="settings-inline-form chat-player-color-form">
        <input
          className="settings-input"
          value={player}
          maxLength={64}
          placeholder="Player name"
          aria-label="Player name for custom chat color"
          onChange={(event) => setPlayer(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              addPlayer();
            }
          }}
        />
        <input
          type="color"
          value={playerColor}
          aria-label="Custom player name color"
          onChange={(event) => setPlayerColor(event.target.value)}
        />
        <Button onClick={addPlayer} disabled={!player.trim()}>Assign</Button>
      </div>

      {assignedPlayers.length > 0 ? (
        <div className="chat-player-color-list" aria-label="Individual player name colors">
          {assignedPlayers.map(([nickname, color]) => (
            <div className="chat-player-color surface" key={nickname}>
              <span>{nickname}</span>
              <input
                type="color"
                value={color}
                aria-label={`Change the name color for ${nickname}`}
                onChange={(event) => saveColors({
                  ...preferences.nameColors,
                  players: { ...preferences.nameColors.players, [nickname]: event.target.value },
                })}
              />
              <button
                type="button"
                className="surface surface-interactive"
                aria-label={`Remove the name color for ${nickname}`}
                title={`Remove ${nickname}'s custom color`}
                onClick={() => removePlayer(nickname)}
              >
                <Icon name="close" size={12} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <span className="settings-empty muted">No individual player colors.</span>
      )}
    </div>
  );
}
