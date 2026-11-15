// An entrant's name, linked to their player card and the shared player menu.
//
// Issue 158. A tournament organiser checking whether somebody belongs in a
// bracket needs every one of their ratings, not the single one the event gates
// on, and a player looking at an opponent wants the same card the rest of the
// client opens. Every entrant who signed up with FAF login carries their FAF id,
// whether they entered here or on the website, so the link is there for all of
// them; an old entry without one is looked up by its name.

import type { PlayerSummary } from "../../ipc/bindings";
import type { KeyboardEvent, MouseEvent } from "react";
import { useTranslation } from "../../i18n/useTranslation";
import { usePlayerMenu } from "../../shared/hooks/usePlayerMenu";
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
  const { openPlayerMenu, playerMenu, playerMenuTarget } = usePlayerMenu();
  const accountId = fafId ?? profile?.id ?? null;
  const login = profile?.login ?? name;
  const openMenu = (event: MouseEvent | KeyboardEvent) => {
    event.stopPropagation();
    openPlayerMenu(login, event, profile ? { account: { id: profile.id, login: profile.login } } : undefined);
  };
  return (
    <>
      <button
        type="button"
        className={`tournament-entrant-link${playerMenuTarget !== null ? " is-menu-target" : ""}`}
        title={t("tournaments.entrants.openCard", { name })}
        onClick={() => openPlayerCard(accountId, profile?.login ?? name)}
        onContextMenu={openMenu}
        onKeyDown={(event) => {
          if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) openMenu(event);
        }}
      >
        {profile ? (
          <PlayerChip player={profile} overrideName={name} />
        ) : (
          <span className="tournament-entrant-link-text">{name}</span>
        )}
      </button>
      {playerMenu}
    </>
  );
}
