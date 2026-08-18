// Banning and picking the maps of one match.
//
// Two captains act on this in turn, against shared state the service owns, so
// nothing here is worked out locally: whose turn it is, what is left, what has
// gone, all of it comes from the run the service keeps. A client that guessed
// would show one captain a turn the other had already taken.
//
// The grid is only live for whoever is due. Everyone else sees the same picture
// read-only, which is the point of a veto: it is watched as much as it is done.

import { Button } from "../../design-system/Button";
import type { PlayerSummary, Tourney, TourneyMatch, VaultMap } from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";
import { matchVaultMap, maySetVetoSides, mayVeto, vetoTurn } from "../../shared/tourneyRules";

interface VetoPanelProps {
  event: Tourney;
  entry: TourneyMatch;
  vault: VaultMap[];
  profiles: PlayerSummary[];
  busy: boolean;
  onAct: (matchId: string, mapId: string) => void;
  onSetSides: (matchId: string, teamA: string) => void;
  onUndo: (matchId: string) => void;
}

export function VetoPanel(props: VetoPanelProps) {
  const { event, entry, busy } = props;
  const { t } = useTranslation();
  const veto = entry.veto;
  if (veto === null) return null;

  const turn = vetoTurn(veto);
  const mine = mayVeto(event, entry);

  const teamName = (teamId: string | null): string => {
    if (teamId === null) return t("tournaments.bracket.tbd");
    const team = event.teams.find((held) => held.id === teamId);
    const named = team?.name.trim() ?? "";
    if (named !== "") return named;
    const first = event.players.find((player) => player.id === team?.playerIds[0]);
    return first?.name ?? t("tournaments.bracket.tbd");
  };

  const mapName = (mapId: string) => {
    const held = event.mapDb.find((candidate) => candidate.id === mapId);
    if (held === undefined) return mapId;
    return matchVaultMap(held, props.vault)?.displayName ?? held.name;
  };

  const preview = (mapId: string) => {
    const held = event.mapDb.find((candidate) => candidate.id === mapId);
    if (held === undefined) return "";
    return matchVaultMap(held, props.vault)?.thumbnailUrl || held.imageUrl;
  };

  const tile = (mapId: string, extra?: string) => {
    const image = preview(mapId);
    return (
      <li className="tournament-veto-map" key={mapId}>
        {image ? (
          <img src={image} alt="" loading="lazy" aria-hidden />
        ) : (
          <span className="tournament-pool-map-blank" aria-hidden />
        )}
        <span>{mapName(mapId)}</span>
        {extra !== undefined && <span className="muted">{extra}</span>}
      </li>
    );
  };

  // Sides first: the order is written in terms of A and B, so nothing can
  // happen until an organiser has said which team is which.
  if (maySetVetoSides(event, entry)) {
    return (
      <div className="tournament-veto">
        <p className="muted">{t("tournaments.veto.chooseSides")}</p>
        <div className="tournament-detail-actions">
          {[entry.team1, entry.team2].map(
            (teamId) =>
              teamId !== null && (
                <Button
                  key={teamId}
                  disabled={busy}
                  onClick={() => props.onSetSides(entry.id, teamId)}
                >
                  {t("tournaments.veto.makeTeamA", { team: teamName(teamId) })}
                </Button>
              ),
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="tournament-veto">
      <header className="tournament-veto-turn">
        {turn === null ? (
          <span className="muted">
            {t(veto.done ? "tournaments.veto.finished" : "tournaments.veto.waitingForSides")}
          </span>
        ) : (
          <span>
            {t(
              turn.action === "ban" ? "tournaments.veto.turnBan" : "tournaments.veto.turnPick",
              { team: teamName(turn.teamId) },
            )}
            {mine && <strong> {t("tournaments.veto.yours")}</strong>}
          </span>
        )}
        {event.viewer.organiser && (veto.stepIndex > 0 || veto.done) && (
          <Button disabled={busy} onClick={() => props.onUndo(entry.id)}>
            {t("tournaments.veto.undo")}
          </Button>
        )}
      </header>

      {veto.remaining.length > 0 && (
        <section>
          <h6>{t("tournaments.veto.remaining")}</h6>
          <ul className="tournament-veto-grid">
            {veto.remaining.map((mapId) =>
              /* Live only for whoever is due. Everyone else reads the same
                 grid, which is what makes a veto watchable. */
              mine && turn !== null ? (
                <li className="tournament-veto-map" key={mapId}>
                  <Button disabled={busy} onClick={() => props.onAct(entry.id, mapId)}>
                    {preview(mapId) ? (
                      <img src={preview(mapId)} alt="" loading="lazy" aria-hidden />
                    ) : (
                      <span className="tournament-pool-map-blank" aria-hidden />
                    )}
                    <span>{mapName(mapId)}</span>
                  </Button>
                </li>
              ) : (
                tile(mapId)
              ),
            )}
          </ul>
        </section>
      )}

      {veto.banned.length > 0 && (
        <section>
          <h6>{t("tournaments.veto.banned")}</h6>
          <ul className="tournament-veto-grid is-gone">
            {veto.banned.map((choice) => tile(choice.map, teamName(choice.by)))}
          </ul>
        </section>
      )}

      {(veto.picks.length > 0 || veto.decider !== null) && (
        <section>
          <h6>{t("tournaments.veto.picked")}</h6>
          <ul className="tournament-veto-grid">
            {veto.picks.map((choice) =>
              tile(
                choice.map,
                t("tournaments.veto.gameBy", {
                  game: choice.game ?? 0,
                  team: teamName(choice.by),
                }),
              ),
            )}
            {veto.decider !== null &&
              tile(
                veto.decider.map,
                t("tournaments.veto.decider", { game: veto.decider.game }),
              )}
          </ul>
        </section>
      )}
    </div>
  );
}
