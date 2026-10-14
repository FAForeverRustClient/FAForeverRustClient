// The mark after a player's name that says you wrote a note about them
// (#519): a note sheet, with the note itself as the tooltip. One component
// for every list that shows it, so the chat roster and a lobby's lineup in
// the Play tab cannot draw it differently.

import { Icon } from "../../design-system/Icon";
import { useTranslation } from "../../i18n/useTranslation";
import "./player-note-mark.css";

export function PlayerNoteMark({ note }: { note: string | undefined }) {
  const { t } = useTranslation();
  if (!note) return null;
  const label = t("chat.roster.noteMark", { note });
  return (
    <span className="player-note-mark" role="img" aria-label={label} title={label}>
      <Icon name="note" size={12} />
    </span>
  );
}
