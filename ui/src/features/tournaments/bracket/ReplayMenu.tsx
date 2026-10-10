// A match's replays, from the foot of its bracket card.
//
// One replay is one button. More are one button with the count, which opens a
// short list of the games: a row of seven numbered links was what crowded the
// card's foot, and each of them was a guess at which game was which.
//
// The list is drawn into the document body at the button's position rather
// than inside the card: the card clips its content and the bracket box
// scrolls sideways, and either would cut a list off.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../../design-system/Icon";
import { useOverlayLayer } from "../../../design-system/useOverlayLayer";
import { useTranslation } from "../../../i18n/useTranslation";

interface ReplayMenuProps {
  /** The replay ids in game order, as the service keeps them. */
  ids: string[];
  onWatch: (uid: number) => void;
}

/** A replay id as the number the vault knows it by, or null. */
function uidOf(id: string): number | null {
  const uid = Number(id.replace(/\D/g, ""));
  return Number.isSafeInteger(uid) && uid > 0 ? uid : null;
}

export function ReplayMenu({ ids, onWatch }: ReplayMenuProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const games = ids.map((id, index) => ({ id, game: index + 1, uid: uidOf(id) })).filter((game) => game.uid !== null);

  // A press anywhere else closes it, and so does scrolling the bracket out
  // from under it.
  useEffect(() => {
    if (!open) return;
    const close = (pressed: Event) => {
      const target = pressed.target as Node;
      if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const away = () => setOpen(false);
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("scroll", away, true);
    window.addEventListener("resize", away);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("scroll", away, true);
      window.removeEventListener("resize", away);
    };
  }, [open]);

  useOverlayLayer(open, () => {
    setOpen(false);
    buttonRef.current?.focus();
  });

  // Under the button, its right edge on the button's.
  useLayoutEffect(() => {
    if (!open || buttonRef.current === null) return;
    const box = buttonRef.current.getBoundingClientRect();
    setAt({ top: box.bottom + 4, left: box.right });
  }, [open]);

  if (games.length === 0) return null;

  if (games.length === 1) {
    const only = games[0];
    return (
      <button
        type="button"
        className="tournament-match-replay"
        title={t("tournaments.bracket.replayGameTitle", { number: only.game, uid: only.uid ?? 0 })}
        aria-label={t("tournaments.bracket.replayGameTitle", { number: only.game, uid: only.uid ?? 0 })}
        onClick={() => only.uid !== null && onWatch(only.uid)}
      >
        <Icon name="play" size={11} />
      </button>
    );
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={open ? "tournament-match-replay is-open" : "tournament-match-replay"}
        title={t("tournaments.bracket.replaysTitle")}
        aria-label={t("tournaments.bracket.replaysTitle")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((held) => !held)}
      >
        <Icon name="play" size={11} />
        <span className="mono">{games.length}</span>
      </button>
      {open &&
        at !== null &&
        createPortal(
          <div
            ref={menuRef}
            className="tournament-replay-menu"
            role="menu"
            style={{ top: at.top, left: at.left }}
          >
            {games.map((game) => (
              <button
                type="button"
                role="menuitem"
                key={game.id}
                title={t("tournaments.bracket.replayGameTitle", { number: game.game, uid: game.uid ?? 0 })}
                onClick={() => {
                  setOpen(false);
                  if (game.uid !== null) onWatch(game.uid);
                }}
              >
                <Icon name="play" size={11} />
                <span>{t("tournaments.mapblock.gameLabel", { number: game.game })}</span>
                <span className="mono muted">{game.uid}</span>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
