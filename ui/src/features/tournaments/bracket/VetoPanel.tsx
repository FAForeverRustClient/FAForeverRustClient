// Banning and picking the maps of one match, and its factions.
//
// Two captains act on this in turn, against shared state the service owns, so
// nothing here is worked out locally: whose turn it is, what is left, what has
// gone, all of it comes from the run the service keeps. A client that guessed
// would show one captain a turn the other had already taken.
//
// Laid out the way the website lays it out: who is A and who is B, the step
// that is due, the maps still in play, the games as they are settled (each
// with its factions where the event runs faction vetoes), and the whole run in
// the order it was walked. A map is banned or picked with two clicks on the
// same card, the website's guard against the one misclick nobody can undo.
//
// The grid is only live for whoever is due. Everyone else sees the same
// picture read-only, which is the point of a veto: it is watched as much as it
// is done.

import { useEffect, useState } from "react";
import { Button } from "../../../design-system/Button";
import type {
  PlayerSummary,
  Tourney,
  TourneyFaction,
  TourneyMatch,
  VaultMap,
} from "../../../ipc/bindings";
import { useTranslation } from "../../../i18n/useTranslation";
import {
  factionVetoOn,
  maySetVetoSides,
  mayVeto,
  tourneyMapImage,
  vetoTurn,
} from "../../../shared/rules/tourneyRules";
import { FactionGame } from "./FactionVeto";
import { teamNameOf } from "./matchParts";
import { vetoLog } from "./vetoPresentation";

/** Everything a veto can ask the service to do, handed down as one. */
export interface VetoHandlers {
  onAct: (matchId: string, mapId: string) => void;
  onSetSides: (matchId: string, teamA: string) => void;
  onUndo: (matchId: string) => void;
  onFaction: (matchId: string, game: number, faction: TourneyFaction) => void;
  /**
   * Clear one game's faction choices for one side (1 or 2), or both (`null`).
   * Organisers only; absent where the surface has no organiser tools.
   */
  onFactionReset?: (matchId: string, game: number, slot: 1 | 2 | null) => void;
}

interface VetoPanelProps {
  event: Tourney;
  entry: TourneyMatch;
  vault: VaultMap[];
  /** Where the service lives, for the organisers' uploaded map pictures. */
  assetBase: string;
  profiles: PlayerSummary[];
  busy: boolean;
  handlers: VetoHandlers;
}

export function VetoPanel(props: VetoPanelProps) {
  const { event, entry, busy, handlers } = props;
  const { t } = useTranslation();
  const veto = entry.veto !== null && event.veto.enabled ? entry.veto : null;
  const factions = entry.factionVeto !== null && factionVetoOn(event) ? entry.factionVeto : null;
  const [armed, setArmed] = useState<string | null>(null);
  // A step taken by either side disarms: the armed card belonged to a turn
  // that is over.
  useEffect(() => setArmed(null), [veto?.stepIndex, veto?.done]);

  if (veto === null && factions === null) return null;

  const teamName = (teamId: string | null): string =>
    teamNameOf(event, teamId) ?? t("tournaments.bracket.tbd");

  const held = (mapId: string) => event.mapDb.find((candidate) => candidate.id === mapId);
  const mapName = (mapId: string) => held(mapId)?.name ?? mapId;
  const preview = (mapId: string) => {
    const map = held(mapId);
    return map === undefined ? "" : tourneyMapImage(map, props.assetBase, props.vault);
  };
  const thumb = (mapId: string, dim = false) => {
    const image = preview(mapId);
    return image ? (
      <img className={dim ? "is-dim" : undefined} src={image} alt="" loading="lazy" decoding="async" aria-hidden />
    ) : (
      <span className="tournament-pool-map-blank" aria-hidden />
    );
  };

  /** The factions of one game, where the event runs them. */
  const factionsFor = (game: number) => {
    const slot = factions?.games.find((candidate) => candidate.game === game);
    if (slot === undefined) return null;
    return (
      <FactionGame
        event={event}
        entry={entry}
        game={slot}
        busy={busy}
        onChoose={handlers.onFaction}
        onReset={event.viewer.organiser ? handlers.onFactionReset : undefined}
      />
    );
  };

  // No map veto for this match: the games are listed by number, each with
  // its factions.
  if (veto === null) {
    return (
      <div className="tournament-veto">
        <p className="muted">{t("tournaments.faction.onlyTitle")}</p>
        <ol className="tournament-veto-games">
          {(factions?.games ?? []).map((game) => (
            <li className="tournament-veto-game" key={game.game}>
              <span className="tournament-veto-game-no mono">
                {t("tournaments.veto.game", { game: game.game })}
              </span>
              <span className="tournament-veto-game-map muted">
                {t("tournaments.faction.nthMap", { game: game.game })}
              </span>
              {factionsFor(game.game)}
            </li>
          ))}
        </ol>
      </div>
    );
  }

  const turn = vetoTurn(veto);
  const mine = mayVeto(event, entry);
  const closed = entry.status === "done" && !veto.done;
  const log = vetoLog(veto);

  const legend = veto.teamA !== null && veto.teamB !== null && (
    <div className="tournament-veto-ab">
      <span className="tournament-veto-abtag is-a">{t("tournaments.veto.teamA", { team: teamName(veto.teamA) })}</span>
      <span className="tournament-veto-abtag is-b">{t("tournaments.veto.teamB", { team: teamName(veto.teamB) })}</span>
    </div>
  );

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
                <Button key={teamId} disabled={busy} onClick={() => handlers.onSetSides(entry.id, teamId)}>
                  {t("tournaments.veto.makeTeamA", { team: teamName(teamId) })}
                </Button>
              ),
          )}
        </div>
      </div>
    );
  }
  if (veto.teamA === null || veto.teamB === null) {
    return (
      <div className="tournament-veto">
        <p className="muted">{t("tournaments.veto.waitingForSides")}</p>
      </div>
    );
  }

  /**
   * The games as they stand, each with its factions.
   *
   * Every game of the series where the event runs faction vetoes: the service
   * takes a game's factions at any time, and a game whose map is not picked
   * yet still owes them, so leaving it out hid a step this account owed.
   * Without faction vetoes only the games that have a map.
   */
  const mapOf = (game: number): string | null =>
    veto.picks.find((choice) => choice.game === game)?.map ??
    (veto.decider !== null && veto.decider.game === game ? veto.decider.map : null);
  const gameCount = Math.max(
    entry.bestOf,
    veto.picks.length + (veto.decider !== null ? 1 : 0),
    factions?.games.length ?? 0,
  );
  const gameNumbers = Array.from({ length: gameCount }, (_, index) => index + 1).filter(
    (game) => mapOf(game) !== null || factions !== null,
  );
  const games = (
    <ol className="tournament-veto-games">
      {gameNumbers.map((game) => {
        const map = mapOf(game);
        const decider = veto.decider !== null && veto.decider.game === game;
        return (
          <li className="tournament-veto-game" key={game}>
            <span className="tournament-veto-game-no mono">{t("tournaments.veto.game", { game })}</span>
            {map === null ? (
              <span className="tournament-veto-game-map muted">
                {t("tournaments.veto.notPickedYet")}
              </span>
            ) : (
              <span className="tournament-veto-game-map">
                {thumb(map)}
                <span>{mapName(map)}</span>
                {decider && <span className="tournament-badge">{t("tournaments.veto.logDecider")}</span>}
              </span>
            )}
            {factionsFor(game)}
          </li>
        );
      })}
    </ol>
  );

  const history = log.length > 0 && (
    <section>
      <h6>{t("tournaments.veto.log")}</h6>
      <ol className="tournament-veto-log">
        {log.map((step, index) => (
          <li className="tournament-veto-log-row" key={`${step.kind}-${step.map}`}>
            <span className="mono muted">{index + 1}</span>
            <span className={`tournament-veto-act is-${step.kind}`}>
              {t(step.kind === "ban" ? "tournaments.veto.logBan" : "tournaments.veto.logPick")}
            </span>
            {thumb(step.map, step.kind === "ban")}
            <span className="muted">{teamName(step.by)}</span>
            <span>
              {mapName(step.map)}
              {step.kind === "pick" && step.game !== null && (
                <span className="muted"> ({t("tournaments.veto.game", { game: step.game })})</span>
              )}
            </span>
          </li>
        ))}
        {veto.decider !== null && (
          <li className="tournament-veto-log-row" key="decider">
            <span className="mono muted">★</span>
            <span className="tournament-veto-act is-decider">{t("tournaments.veto.logDecider")}</span>
            {thumb(veto.decider.map)}
            <span className="muted">{t("tournaments.veto.lastStanding")}</span>
            <span>{mapName(veto.decider.map)}</span>
          </li>
        )}
      </ol>
    </section>
  );

  if (veto.done || closed) {
    return (
      <div className="tournament-veto">
        {legend}
        {closed && <p className="muted">{t("tournaments.veto.closed")}</p>}
        {veto.done && (
          <section>
            <h6>{t("tournaments.veto.maps")}</h6>
            {games}
          </section>
        )}
        {history}
        {event.viewer.organiser && veto.done && entry.status !== "done" && (
          <div className="tournament-detail-actions">
            <Button disabled={busy} onClick={() => handlers.onUndo(entry.id)}>
              {t("tournaments.veto.undo")}
            </Button>
          </div>
        )}
      </div>
    );
  }

  const acting = turn !== null && mine;
  const ownTurn = acting && !event.viewer.organiser;
  const act = (mapId: string) => {
    if (armed === mapId) {
      setArmed(null);
      handlers.onAct(entry.id, mapId);
    } else {
      setArmed(mapId);
    }
  };

  return (
    <div
      className="tournament-veto"
      onKeyDown={(pressed) => {
        if (pressed.key === "Escape") setArmed(null);
      }}
    >
      {legend}
      <header className={turn !== null ? `tournament-veto-turn is-${turn.action}` : "tournament-veto-turn"}>
        {turn !== null && (
          <span>
            <span className="muted">
              {t("tournaments.veto.step", { step: veto.stepIndex + 1, total: veto.sequence.length })}
            </span>{" "}
            {t(turn.action === "ban" ? "tournaments.veto.turnBan" : "tournaments.veto.turnPick", {
              team: teamName(turn.teamId),
            })}
          </span>
        )}
        {event.viewer.organiser && veto.stepIndex > 0 && (
          <Button disabled={busy} onClick={() => handlers.onUndo(entry.id)}>
            {t("tournaments.veto.undo")}
          </Button>
        )}
      </header>
      {acting && turn !== null && (
        <p className="tournament-veto-yourturn">
          <strong>
            {ownTurn
              ? t("tournaments.veto.yours")
              : t("tournaments.veto.actingFor", { team: teamName(turn.teamId) })}
          </strong>{" "}
          {t(turn.action === "ban" ? "tournaments.veto.chooseBan" : "tournaments.veto.choosePick")}
        </p>
      )}

      <section>
        <h6>{t("tournaments.veto.remaining")}</h6>
        <ul className="tournament-veto-grid">
          {veto.remaining.map((mapId) =>
            acting && turn !== null ? (
              <li className="tournament-veto-map" key={mapId}>
                <button
                  type="button"
                  className={
                    armed === mapId
                      ? `tournament-veto-pick is-${turn.action} is-armed`
                      : `tournament-veto-pick is-${turn.action}`
                  }
                  disabled={busy}
                  onClick={() => act(mapId)}
                >
                  {thumb(mapId)}
                  <span>{mapName(mapId)}</span>
                  {armed === mapId && (
                    <span className="tournament-veto-confirm">
                      {t(turn.action === "ban" ? "tournaments.veto.confirmBan" : "tournaments.veto.confirmPick")}
                    </span>
                  )}
                </button>
              </li>
            ) : (
              <li className="tournament-veto-map" key={mapId}>
                {thumb(mapId)}
                <span>{mapName(mapId)}</span>
              </li>
            ),
          )}
        </ul>
      </section>

      {veto.banned.length > 0 && (
        <section>
          <h6>{t("tournaments.veto.banned")}</h6>
          <ul className="tournament-veto-grid is-gone">
            {veto.banned.map((choice) => (
              <li className="tournament-veto-map" key={choice.map}>
                {thumb(choice.map, true)}
                <span>{mapName(choice.map)}</span>
                <span className="muted">{teamName(choice.by)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {gameNumbers.length > 0 && (
        <section>
          <h6>{t("tournaments.veto.picked")}</h6>
          {games}
        </section>
      )}

      {history}
    </div>
  );
}
