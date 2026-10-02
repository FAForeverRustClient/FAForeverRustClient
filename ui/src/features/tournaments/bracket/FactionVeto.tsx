// One game's faction veto: two players each ban and then pick factions in
// secret, and each plays the first of their picks the other did not ban.
//
// The secret is the service's to keep. A player is sent their own choices and
// nobody else's, and everybody else, organisers included, only learns which
// side is done until both are. So there is no turn order to show and nothing to
// work out: this reads the slice it was given and offers the step that is due.
//
// A choice is made with two clicks on the same chip, the website's guard
// against a misclick on something nobody can see or take back.

import { useEffect, useState } from "react";
import type {
  FactionVetoGame,
  Tourney,
  TourneyFaction,
  TourneyMatch,
} from "../../../ipc/bindings";
import type { MessageKey } from "../../../i18n";
import { useTranslation } from "../../../i18n/useTranslation";
import { teamNameOf } from "./matchParts";
import { FACTIONS } from "./vetoPresentation";

export const FACTION_LABELS: Record<TourneyFaction, MessageKey> = {
  uef: "tournaments.faction.uef",
  aeon: "tournaments.faction.aeon",
  cybran: "tournaments.faction.cybran",
  seraphim: "tournaments.faction.seraphim",
};

/** A faction as a chip in its own colour: a letter and a name. */
export function FactionChip({
  faction,
  dim = false,
  on = false,
}: {
  faction: TourneyFaction;
  dim?: boolean;
  on?: boolean;
}) {
  const { t } = useTranslation();
  const glyph = FACTIONS.find((held) => held.id === faction)?.glyph ?? "?";
  const classes = ["tournament-fchip", `is-${faction}`];
  if (dim) classes.push("is-dim");
  if (on) classes.push("is-on");
  return (
    <span className={classes.join(" ")}>
      <span className="tournament-fchip-glyph mono" aria-hidden>
        {glyph}
      </span>
      <span>{t(FACTION_LABELS[faction])}</span>
    </span>
  );
}

interface FactionGameProps {
  event: Tourney;
  entry: TourneyMatch;
  game: FactionVetoGame;
  busy: boolean;
  onChoose: (matchId: string, game: number, faction: TourneyFaction) => void;
  /** An organiser clearing a side's choices; absent for everyone else. */
  onReset?: (matchId: string, game: number, slot: 1 | 2 | null) => void;
}

/**
 * An organiser's way to let a side choose again (`fveto_reset`).
 *
 * The website's service has it and its pages never offer it. An organiser
 * sees only which side is done, never what they chose, so the control names
 * the side and not the choices; it asks first, because the choices are gone
 * once cleared and only the player can make them again.
 */
function ResetControls({
  event,
  entry,
  game,
  busy,
  onReset,
}: {
  event: Tourney;
  entry: TourneyMatch;
  game: FactionVetoGame;
  busy: boolean;
  onReset: (matchId: string, game: number, slot: 1 | 2 | null) => void;
}) {
  const { t } = useTranslation();
  const name = (teamId: string | null) => teamNameOf(event, teamId) ?? t("tournaments.bracket.tbd");
  const reset = (slot: 1 | 2 | null) => {
    const who = slot === null ? t("tournaments.faction.bothSides") : name(slot === 1 ? entry.team1 : entry.team2);
    if (window.confirm(t("tournaments.faction.resetConfirm", { team: who, game: game.game }))) {
      onReset(entry.id, game.game, slot);
    }
  };
  return (
    <span className="tournament-fveto-reset">
      {game.team1Done && (
        <button type="button" className="tournament-link-button" disabled={busy} onClick={() => reset(1)}>
          {t("tournaments.faction.reset", { team: name(entry.team1) })}
        </button>
      )}
      {game.team2Done && (
        <button type="button" className="tournament-link-button" disabled={busy} onClick={() => reset(2)}>
          {t("tournaments.faction.reset", { team: name(entry.team2) })}
        </button>
      )}
      {(game.team1Done || game.team2Done) && (
        <button type="button" className="tournament-link-button" disabled={busy} onClick={() => reset(null)}>
          {t("tournaments.faction.resetBoth")}
        </button>
      )}
    </span>
  );
}

export function FactionGame({ event, entry, game, busy, onChoose, onReset }: FactionGameProps) {
  const { t } = useTranslation();
  const [armed, setArmed] = useState<TourneyFaction | null>(null);
  const step = game.next;
  // A step taken, or a new one due, disarms: the chip that was armed belongs
  // to a step that is no longer the one on offer.
  useEffect(() => setArmed(null), [step?.action, step?.index, game.mine?.done]);

  const name = (teamId: string | null) => teamNameOf(event, teamId) ?? t("tournaments.bracket.tbd");

  // Offered until the match is over: afterwards a new choice changes nothing.
  const resets = onReset !== undefined && entry.status !== "done" && (
    <ResetControls event={event} entry={entry} game={game} busy={busy} onReset={onReset} />
  );

  if (game.result !== null) {
    return (
      <div className="tournament-fveto is-done">
        <span className="tournament-fveto-row">
          <span className="muted">{name(entry.team1)}</span>
          <FactionChip faction={game.result.team1} on />
        </span>
        <span className="tournament-fveto-row">
          <span className="muted">{name(entry.team2)}</span>
          <FactionChip faction={game.result.team2} on />
        </span>
        {resets}
      </div>
    );
  }

  if (entry.status === "done") {
    return <div className="tournament-fveto muted">{t("tournaments.faction.closed")}</div>;
  }

  const mine = game.mine;
  const choices = mine !== null && (mine.bans.length > 0 || mine.picks.length > 0) && (
    <span className="tournament-fveto-mine">
      {mine.bans.map((faction) => (
        <FactionChip key={`ban-${faction}`} faction={faction} dim />
      ))}
      {mine.picks.length > 0 && <span className="muted">→</span>}
      {mine.picks.map((faction) => (
        <FactionChip key={`pick-${faction}`} faction={faction} on />
      ))}
    </span>
  );

  // Not one of the two players: only who is done yet.
  if (mine === null) {
    const waiting = [
      !game.team1Done ? name(entry.team1) : null,
      !game.team2Done ? name(entry.team2) : null,
    ].filter((held): held is string => held !== null);
    return (
      <div className="tournament-fveto muted">
        {waiting.length === 0
          ? t("tournaments.faction.resolving")
          : t("tournaments.faction.waitingOn", { teams: waiting.join(", ") })}
        {resets}
      </div>
    );
  }

  if (step === null || mine.done) {
    return (
      <div className="tournament-fveto">
        <span className="muted">
          {t(
            game.team1Done && game.team2Done
              ? "tournaments.faction.resolving"
              : "tournaments.faction.youreDone",
          )}
        </span>
        {choices}
      </div>
    );
  }

  // The step that is due. Factions already used in this step cannot be
  // chosen again; banning one you also pick is allowed, as on the website.
  const used = step.action === "ban" ? mine.bans : mine.picks;
  const choose = (faction: TourneyFaction) => {
    if (armed === faction) {
      setArmed(null);
      onChoose(entry.id, game.game, faction);
    } else {
      setArmed(faction);
    }
  };

  return (
    <div
      className="tournament-fveto is-active"
      onKeyDown={(pressed) => {
        if (pressed.key === "Escape") setArmed(null);
      }}
    >
      <span className="tournament-fveto-turn">
        <span className="tournament-turn-dot" aria-hidden />
        {t("tournaments.faction.yourTurn")}
      </span>
      <span className="tournament-fveto-prompt">
        {armed !== null
          ? t("tournaments.faction.confirm", { faction: t(FACTION_LABELS[armed]) })
          : t(step.action === "ban" ? "tournaments.faction.ban" : "tournaments.faction.pick")}
        {armed === null && step.of > 1 && (
          <span className="muted"> {t("tournaments.faction.ordinal", { index: step.index, of: step.of })}</span>
        )}
      </span>
      <span className="tournament-fveto-chips">
        {FACTIONS.map(({ id }) => {
          const taken = used.includes(id);
          return (
            <button
              type="button"
              key={id}
              className={armed === id ? "tournament-fchip-button is-armed" : "tournament-fchip-button"}
              disabled={busy || taken}
              onClick={() => choose(id)}
            >
              <FactionChip faction={id} dim={taken} />
            </button>
          );
        })}
      </span>
      {choices}
      <small className="muted">
        {t(step.action === "ban" ? "tournaments.faction.noteBan" : "tournaments.faction.notePick")}{" "}
        {t("tournaments.faction.secret")}
      </small>
    </div>
  );
}
