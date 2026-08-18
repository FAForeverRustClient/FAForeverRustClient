// The captains draft: who is on the clock, and who is left to pick.
//
// The order is the service's and is walked, not rebuilt: captains pick
// concurrently, so a locally computed turn would disagree with whoever picked
// last. Everything here reads `event.draft`.
//
// Two states, and they are different screens rather than the same one greyed
// out: before the draft, an organiser marks captains; during it, whoever is on
// the clock picks from the pool.

import { useState } from "react";
import { Button } from "../../design-system/Button";
import type { PlayerSummary, Tourney, TourneyPlayer } from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";
import { PlayerChip } from "./PlayerChip";
import {
  draftTurn,
  isLegalFrom,
  mayPick,
  mayUndoPick,
  profileOf,
  undrafted,
} from "../../shared/tourneyRules";

interface DraftPanelProps {
  event: Tourney;
  profiles: PlayerSummary[];
  busy: boolean;
  onPick: (playerId: string) => void;
  onUndo: () => void;
  onSetCaptains: (playerIds: string[]) => void;
  onStart: () => void;
}

export function DraftPanel(props: DraftPanelProps) {
  const { event, busy } = props;
  const { t } = useTranslation();
  const [captains, setCaptains] = useState<string[]>(event.pendingCaptains);

  const nameOf = (player: TourneyPlayer) => {
    const profile = profileOf(props.profiles, player);
    return profile ? <PlayerChip player={profile} overrideName={player.name} /> : player.name;
  };

  const teamName = (teamId: string) => {
    const team = event.teams.find((held) => held.id === teamId);
    const named = team?.name.trim() ?? "";
    if (named !== "") return named;
    const captain = event.players.find((player) => player.id === team?.captainId);
    return captain?.name ?? teamId;
  };

  // Before it starts: an organiser marks the captains and closes signups.
  if (event.draft === null) {
    if (!event.viewer.organiser || !isLegalFrom("startDraft", event.status)) return null;
    const eligible = event.players.filter((player) => !player.pending);
    return (
      <section className="tournament-draft">
        <h5>{t("tournaments.draft.captainsHeading")}</h5>
        <p className="muted">{t("tournaments.draft.captainsHint")}</p>
        <ul className="tournament-entrant-list">
          {eligible.map((player) => (
            <li className="tournament-entrant" key={player.id}>
              <label className="tournament-checkbox">
                <input
                  type="checkbox"
                  checked={captains.includes(player.id)}
                  onChange={() =>
                    setCaptains((held) =>
                      held.includes(player.id)
                        ? held.filter((id) => id !== player.id)
                        : [...held, player.id],
                    )
                  }
                />
                <span>{nameOf(player)}</span>
              </label>
            </li>
          ))}
        </ul>
        <div className="tournament-detail-actions">
          <Button disabled={busy} onClick={() => props.onSetCaptains(captains)}>
            {t("tournaments.draft.saveCaptains")}
          </Button>
          {/* The service wants at least two, and says so. Checking here keeps
              the refusal off a button that looks ready. */}
          <Button
            variant="primary"
            disabled={busy || captains.length < 2}
            onClick={() => props.onStart()}
          >
            {t("tournaments.draft.start")}
          </Button>
        </div>
      </section>
    );
  }

  const turn = draftTurn(event);
  const pool = undrafted(event);
  const mine = mayPick(event);

  return (
    <section className="tournament-draft">
      <header className="tournament-draft-head">
        <h5>{t("tournaments.draft.heading")}</h5>
        {turn === null ? (
          <span className="muted">{t("tournaments.draft.finished")}</span>
        ) : (
          <span>
            {t("tournaments.draft.onTheClock", { team: teamName(turn) })}
            {mine && <strong> {t("tournaments.draft.yours")}</strong>}
            <span className="muted">
              {" "}
              {t("tournaments.draft.remaining", {
                count: event.draft.order.length - event.draft.current,
              })}
            </span>
          </span>
        )}
        {mayUndoPick(event) && (
          <Button disabled={busy} onClick={props.onUndo}>
            {t("tournaments.draft.undo")}
          </Button>
        )}
      </header>

      {pool.length === 0 ? (
        <p className="muted">{t("tournaments.draft.poolEmpty")}</p>
      ) : (
        <ul className="tournament-entrant-list">
          {pool.map((player) => (
            <li className="tournament-entrant" key={player.id}>
              <span className="tournament-entrant-name">{nameOf(player)}</span>
              {player.rating !== null && <span className="muted">{player.rating}</span>}
              {/* Live only for whoever is on the clock. Everyone else reads the
                  same pool, which is how a draft is followed. */}
              {mine && (
                <Button disabled={busy} onClick={() => props.onPick(player.id)}>
                  {t("tournaments.draft.pick")}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
