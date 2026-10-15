// The tournament tab's keyboard shortcuts, cut from the website's "Display
// settings".
//
// Only the shortcuts: the website's same dialog also holds the time zone, the
// date and time format and the interface scale, which the client keeps in its
// own settings, so the dialog is named for what is left in it (issue 565). A key is chosen by pressing it, a single letter or digit with
// no modifier, and a key already in use moves from its old action.

import { overlayStack } from "../../../design-system/overlayStack";
import { useOverlayLayer } from "../../../design-system/useOverlayLayer";
import { useEffect, useState } from "react";
import { Button } from "../../../design-system/Button";
import { Icon } from "../../../design-system/Icon";
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

  // Three bands, as the client's other dialogs have them: a raised head
  // naming the dialog, the shortcuts as rows in the body, the way out in the
  // foot. Each shortcut is a key cap, chosen by clicking it and pressing the
  // key; a row's clear button switches its shortcut off.
  return (
    <Modal onClose={onClose} className="hotkeys-modal" ariaLabel={t("tournaments.display.shortcuts")}>
      <header className="hotkeys-head">
        <span className="hotkeys-head-icon" aria-hidden="true">
          <Icon name="keyboard" size={22} />
        </span>
        <h2>{t("tournaments.display.shortcuts")}</h2>
      </header>

      <div className="hotkeys-body">
        <p className="hotkeys-hint">{t("tournaments.display.shortcutsHint")}</p>
        <ul className="hotkeys-list">
          {HOTKEY_ACTIONS.map((action) => {
            const isArming = arming === action.id;
            const isOff = keys[action.id] === "";
            return (
              <li key={action.id} className={isArming ? "hotkeys-row is-arming" : "hotkeys-row"}>
                <span className="hotkeys-label">
                  <span>{t(action.label)}</span>
                  {action.note !== undefined && <span className="hotkeys-note">{t(action.note)}</span>}
                </span>
                <button
                  type="button"
                  className={["hotkeys-key", isArming ? "is-arming" : "", isOff && !isArming ? "is-off" : ""]
                    .filter(Boolean)
                    .join(" ")}
                  onClick={() => {
                    setRefused(false);
                    setArming(isArming ? null : action.id);
                  }}
                >
                  {isArming
                    ? t("tournaments.display.press")
                    : isOff
                      ? t("tournaments.display.off")
                      : keys[action.id].toUpperCase()}
                </button>
                <Button
                  className="icon-button hotkeys-clear"
                  title={t("tournaments.display.clearTitle")}
                  aria-label={t("tournaments.display.clearTitle")}
                  disabled={isOff}
                  onClick={() => onChange({ ...keys, [action.id]: "" })}
                >
                  <Icon name="close" size={14} />
                </Button>
              </li>
            );
          })}
        </ul>
        {refused && (
          <p className="hotkeys-warning" role="alert">
            <Icon name="alert" size={14} />
            {t("tournaments.display.singleKey")}
          </p>
        )}
      </div>

      <footer className="hotkeys-foot">
        <Button variant="primary" onClick={onClose}>
          {t("common.close")}
        </Button>
      </footer>
    </Modal>
  );
}
