import { ColorInput } from "../../design-system/ColorInput";
import { useMemo, useState } from "react";
import type { ChatNameColorsPatch, ChatPreferences, ChatPreferencesPatch } from "../../ipc/bindings";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import {
  DEFAULT_COLOR_PICKER_VALUE,
  STANDARD_CATEGORY_COLORS,
  type CategoryColorKey,
} from "../../shared/nameColorsUtil";
import { setPlayerNameColor } from "../../shared/preferenceCommands";
import type { MessageKey } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";

type CategoryKey = CategoryColorKey;

const CATEGORIES: Array<{ key: CategoryKey; label: MessageKey }> = [
  { key: "selfColor", label: "settings.nameColors.self" },
  { key: "friends", label: "settings.nameColors.friends" },
  { key: "foes", label: "settings.nameColors.foes" },
  { key: "moderators", label: "settings.nameColors.moderators" },
  { key: "admins", label: "settings.nameColors.admins" },
  // Not a category of person like the five above it, but the same kind of
  // choice about the same kind of name, and the place anybody looking for it
  // would look first.
  { key: "pings", label: "settings.nameColors.pings" },
];

export function ChatNameColorSettings({
  preferences,
  onSave,
}: {
  preferences: ChatPreferences;
  /** Only what changed: see `preference_patch!` in the domain. */
  onSave: (patch: ChatPreferencesPatch) => void;
}) {
  const { t } = useTranslation();
  const [player, setPlayer] = useState("");
  const [playerColor, setPlayerColor] = useState(DEFAULT_COLOR_PICKER_VALUE);
  const assignedPlayers = useMemo(
    () => Object.entries(preferences.nameColors.players)
      .sort(([left], [right]) => left.localeCompare(right, undefined, { sensitivity: "base" })),
    [preferences.nameColors.players],
  );

  const saveColors = (nameColors: ChatNameColorsPatch) => onSave({ nameColors });
  const setCategoryColor = (key: CategoryKey, color: string) => {
    saveColors({ [key]: color });
  };
  const resetToStandardColors = () => {
    saveColors({ ...STANDARD_CATEGORY_COLORS });
  };
  // Players go one at a time rather than as a rebuilt `players` map: a map
  // built from this render's props dropped whichever change landed in between,
  // so two quick edits kept only the second. The backend also replaces any
  // other spelling of the same login.
  const removePlayer = (nickname: string) => setPlayerNameColor(nickname, null);
  const addPlayer = () => {
    const nickname = player.trim();
    if (!nickname) return;
    setPlayerNameColor(nickname, playerColor);
    setPlayer("");
  };

  return (
    <div className="setting-block chat-name-color-settings">
      <div className="chat-name-color-header">
        <div>
          <span className="setting-label">{t("settings.nameColors.rules")}</span>
          <span className="muted">
            {t("settings.nameColors.rulesHint")}
          </span>
        </div>
        <Button
          variant="ghost"
          onClick={resetToStandardColors}
          aria-label={t("settings.nameColors.resetAria")}
        >
          {t("settings.nameColors.reset")}
        </Button>
      </div>

      <div className="chat-category-colors">
        {CATEGORIES.map(({ key, label }) => {
          const color = preferences.nameColors[key];
          const text = t(label);
          return (
            <div className="chat-color-rule surface" key={key}>
              <span>{text}</span>
              <span className="chat-color-state">{color || t("settings.nameColors.default")}</span>
              <label className="chat-color-swatch-wrap" title={t("settings.nameColors.chooseFor", { label: text })}>
                <span className="chat-color-preview-swatch" style={{ backgroundColor: color || DEFAULT_COLOR_PICKER_VALUE }} />
                <ColorInput
                  className="color-input-overlay"
                  value={color || DEFAULT_COLOR_PICKER_VALUE}
                  aria-label={t("settings.nameColors.chooseNameColor", { label: text.toLocaleLowerCase() })}
                  onChange={(next) => setCategoryColor(key, next)}
                />
              </label>
              <button
                type="button"
                className="chat-color-clear surface surface-interactive"
                disabled={!color}
                aria-label={t("settings.nameColors.clearCategoryAria", {
                  label: text.toLocaleLowerCase(),
                })}
                title={t("settings.nameColors.useDefaultText")}
                onClick={() => setCategoryColor(key, "")}
              >
                <Icon name="close" size={12} />
              </button>
            </div>
          );
        })}
      </div>

      <div className="chat-player-assign-section">
        <span className="chat-player-assign-label">{t("settings.nameColors.assignIndividual")}</span>
        <div className="chat-player-color-form">
          <input
            className="settings-input chat-player-name-input"
            value={player}
            maxLength={64}
            placeholder={t("settings.nameColors.playerUsername")}
            aria-label={t("settings.nameColors.playerNameCustom")}
            onChange={(event) => setPlayer(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addPlayer();
              }
            }}
          />
          <label className="chat-color-picker-control surface surface-interactive" title={t("settings.nameColors.chooseCustom")}>
            <span className="chat-color-preview-swatch" style={{ backgroundColor: playerColor }} />
            <span className="chat-color-state">{playerColor}</span>
            <ColorInput
              className="color-input-overlay"
              value={playerColor}
              aria-label={t("settings.nameColors.customPlayerName")}
              onChange={setPlayerColor}
            />
          </label>
          <Button
            variant="primary"
            className="chat-player-assign-btn"
            onClick={addPlayer}
            disabled={!player.trim()}
          >
            {t("settings.nameColors.assign")}
          </Button>
        </div>
      </div>

      {assignedPlayers.length > 0 ? (
        <div className="chat-player-color-list" aria-label={t("settings.nameColors.individualPlayerName")}>
          {assignedPlayers.map(([nickname, color]) => (
            <div className="chat-player-color surface" key={nickname}>
              <span>{nickname}</span>
              <label
                className="chat-color-swatch-wrap"
                title={t("settings.nameColors.changePlayer", { name: nickname })}
              >
                <span className="chat-color-preview-swatch" style={{ backgroundColor: color }} />
                <ColorInput
                  className="color-input-overlay"
                  value={color}
                  aria-label={t("settings.nameColors.changePlayerAria", { name: nickname })}
                  onChange={(next) => setPlayerNameColor(nickname, next)}
                />
              </label>
              <button
                type="button"
                className="chat-color-clear surface surface-interactive"
                aria-label={t("settings.nameColors.removePlayerAria", { name: nickname })}
                title={t("settings.nameColors.removePlayer", { name: nickname })}
                onClick={() => removePlayer(nickname)}
              >
                <Icon name="close" size={12} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <span className="settings-empty muted">{t("settings.nameColors.empty")}</span>
      )}
    </div>
  );
}
