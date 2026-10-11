// The tournament tab's keyboard shortcuts, the website's "Display settings".
//
// Only the shortcuts: the website's same dialog also holds the time zone, the
// date and time format and the interface scale, which the client keeps in its
// own settings. A key is chosen by pressing it, a single letter or digit with
// no modifier, and a key already in use moves from its old action.

import { overlayStack } from "../../../design-system/overlayStack";
import { useOverlayLayer } from "../../../design-system/useOverlayLayer";
import { useEffect, useState } from "react";
import { Button } from "../../../design-system/Button";
import { Modal } from "../../../design-system/Modal";
import { useTranslation } from "../../../i18n/useTranslation";
import { HOTKEY_ACTIONS, rebind, type HotkeyAction } from "../display";

interface DisplaySettingsDialogProps {
  keys: Record<HotkeyAction, string>;
  onChange: (keys: Record<HotkeyAction, string>) => void;
  onClose: () => void;
}

export function DisplaySettingsDialog({ keys, onChange, onClose }: DisplaySettingsDialogProps) {
  const { t } = useTranslation();
  const [arming, setArming] = useState<HotkeyAction | null>(null);
  const [refused, setRefused] = useState(false);
  const armingLayer = useOverlayLayer(arming !== null, () => setArming(null));

  // Capture a chosen key before its ordinary action. Escape belongs to the
  // overlay stack, so it cancels arming before it can close this dialog.
  useEffect(() => {
    if (arming === null) return;
    const listen = (pressed: KeyboardEvent) => {
      if (pressed.isComposing || pressed.key === "Escape" || overlayStack.top() !== armingLayer) return;
      pressed.preventDefault();
      pressed.stopPropagation();
      const key = pressed.key.toLowerCase();
      if (pressed.ctrlKey || pressed.metaKey || pressed.altKey || !/^[a-z0-9]$/.test(key)) {
        setRefused(true);
        return;
      }
      setRefused(false);
      onChange(rebind(keys, arming, key));
      setArming(null);
    };
    window.addEventListener("keydown", listen, true);
    return () => window.removeEventListener("keydown", listen, true);
  }, [arming, armingLayer, keys, onChange]);

  return (
    <Modal onClose={onClose} className="tournament-display-dialog" ariaLabel={t("tournaments.display.title")}>
      <h3>{t("tournaments.display.title")}</h3>
      <h5>{t("tournaments.display.shortcuts")}</h5>
      <p className="muted">{t("tournaments.display.shortcutsHint")}</p>
      <ul className="tournament-hotkeys">
        {HOTKEY_ACTIONS.map((action) => (
          <li key={action.id}>
            <Button
              className={arming === action.id ? "tournament-hotkey is-arming mono" : "tournament-hotkey mono"}
              onClick={() => {
                setRefused(false);
                setArming(arming === action.id ? null : action.id);
              }}
            >
              {arming === action.id
                ? t("tournaments.display.press")
                : keys[action.id] === ""
                  ? t("tournaments.display.off")
                  : keys[action.id].toUpperCase()}
            </Button>
            <span>
              {t(action.label)}
              {action.note !== undefined && <span className="muted"> ({t(action.note)})</span>}
            </span>
            <Button
              title={t("tournaments.display.clearTitle")}
              disabled={keys[action.id] === ""}
              onClick={() => onChange({ ...keys, [action.id]: "" })}
            >
              {t("tournaments.display.clear")}
            </Button>
          </li>
        ))}
      </ul>
      {refused && <p className="tournament-warning">{t("tournaments.display.singleKey")}</p>}
      <div className="tournament-form-actions">
        <Button variant="primary" onClick={onClose}>
          {t("common.close")}
        </Button>
      </div>
    </Modal>
  );
}
