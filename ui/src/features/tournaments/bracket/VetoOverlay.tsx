// One match's ban and pick run, over the bracket.
//
// It was a drawer under the bracket box, and then under its Swiss row: a grid
// of maps a long way from the card that opened it, pushing everything below it
// down while it was open. An overlay keeps the reader's place in a bracket they
// have scrolled into, has the width for the maps and the run side by side, and
// Escape gives the bracket back.

import type { PlayerSummary, Tourney, TourneyMatch, VaultMap } from "../../../ipc/bindings";
import { Modal } from "../../../design-system/Modal";
import { useTranslation } from "../../../i18n/useTranslation";
import { matchLabel } from "./matchLabels";
import { teamNameOf } from "./matchParts";
import { VetoPanel, type VetoHandlers } from "./VetoPanel";

interface VetoOverlayProps {
  event: Tourney;
  entry: TourneyMatch;
  vault: VaultMap[];
  assetBase: string;
  profiles: PlayerSummary[];
  busy: boolean;
  handlers: VetoHandlers;
  onClose: () => void;
}

export function VetoOverlay({ event, entry, onClose, ...panel }: VetoOverlayProps) {
  const { t } = useTranslation();
  const name = (teamId: string | null) => teamNameOf(event, teamId) ?? t("tournaments.bracket.tbd");
  const versus = `${name(entry.team1)} ${t("tournaments.swiss.vs")} ${name(entry.team2)}`;
  return (
    <Modal onClose={onClose} ariaLabel={`${t("tournaments.veto.open")}: ${versus}`} className="tournament-veto-modal">
      <header className="tournament-veto-modal-head">
        <span className="tournament-veto-modal-eyebrow">
          {t("tournaments.veto.open")}
          {" · "}
          {matchLabel(event, entry, t)}
          {" · "}
          {t("tournaments.matches.bestOf", { count: entry.bestOf })}
        </span>
        <h3>
          <span>{name(entry.team1)}</span>
          <span className="tournament-veto-modal-vs">{t("tournaments.swiss.vs")}</span>
          <span>{name(entry.team2)}</span>
        </h3>
      </header>
      <VetoPanel event={event} entry={entry} {...panel} overlay />
    </Modal>
  );
}
