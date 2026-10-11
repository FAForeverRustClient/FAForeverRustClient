// An entrant's name, as the way to their FAF player card.
//
// Issue 158. A tournament organiser checking whether somebody belongs in a
// bracket needs every one of their ratings, not the single one the event gates
// on, and a player looking at an opponent wants the same card the rest of the
// client opens. Every entrant who signed up with FAF login carries their FAF id,
// whether they entered here or on the website, so the link is there for all of
// them; an old entry without one is looked up by its name.

import type { PlayerSummary } from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";
import { openPlayerCard } from "../../shared/playerCardActions";
import { PlayerChip } from "./PlayerChip";

interface EntrantNameProps {
  /** The entry's own name. It wins over the account's: an organiser's label must survive. */
  name: string;
  fafId: number | null;
  profile: PlayerSummary | null;
}

export function EntrantName({ name, fafId, profile }: EntrantNameProps) {
  const { t } = useTranslation();
  const accountId = fafId ?? profile?.id ?? null;
  return (
    <button
      type="button"
      className="tournament-entrant-link"
      title={t("tournaments.entrants.openCard", { name })}
      onClick={() => openPlayerCard(accountId, profile?.login ?? name)}
    >
      {profile ? (
        <PlayerChip player={profile} overrideName={name} />
      ) : (
        <span className="tournament-entrant-link-text">{name}</span>
      )}
    </button>
  );
}
