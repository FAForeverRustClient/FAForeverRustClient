// Swiss round 1 by hand: the website's round 1 editor.
//
// Round 1 has no results to pair on, so the service draws it by seed; an
// organiser may set the opening matchups instead. Before the start this pins
// a plan that is applied the moment the stage starts; once running, it
// replaces round 1 while nothing in it has begun.

import { useState } from "react";
import { Button } from "../../../design-system/Button";
import type { Tourney, TourneyAdmin } from "../../../ipc/bindings";
import { useTranslation } from "../../../i18n/useTranslation";
import { teamNameOf } from "./matchParts";
import { BYE } from "./swissRecords";

/** The matchups the editor opens on: the pinned plan if it still fits, else 1v2, 3v4. */
export function openingPairs(event: Tourney): [string, string][] {
  const ids = [...event.teams].sort((left, right) => (left.seed || 999) - (right.seed || 999)).map((team) => team.id);
  const running = event.matches.filter((entry) => entry.bracket === "swiss" && entry.round === 1);
  if (running.length > 0) {
    return running
      .filter((entry) => entry.team1 !== null && entry.team2 !== null && entry.team1 !== BYE && entry.team2 !== BYE)
      .map((entry) => [entry.team1 ?? "", entry.team2 ?? ""]);
  }
  const planned = event.plannedRoundOne;
  const fits =
    planned.length === Math.floor(ids.length / 2) &&
    new Set(planned.flat()).size === planned.length * 2 &&
    planned.flat().every((id) => ids.includes(id));
  if (fits) return planned.map(([one, two]) => [one, two]);
  const pairs: [string, string][] = [];
  for (let at = 0; at + 1 < ids.length; at += 2) pairs.push([ids[at], ids[at + 1]]);
  return pairs;
}

/** Who appears twice, and who not at all, in a set of matchups. */
export function pairingProblems(event: Tourney, pairs: [string, string][]): { twice: string[]; missing: string[] } {
  const seen = new Map<string, number>();
  for (const id of pairs.flat()) seen.set(id, (seen.get(id) ?? 0) + 1);
  const twice = [...seen.entries()].filter(([, count]) => count > 1).map(([id]) => id);
  const everyone = event.teams.map((team) => team.id);
  // An odd field leaves one out on purpose: that one has the bye.
  const missing = everyone.filter((id) => !seen.has(id));
  return { twice, missing: everyone.length % 2 === 1 && missing.length === 1 ? [] : missing };
}

interface RoundOneEditorProps {
  event: Tourney;
  busy: boolean;
  onAdmin: (change: TourneyAdmin) => void;
}

export function RoundOneEditor({ event, busy, onAdmin }: RoundOneEditorProps) {
  const { t } = useTranslation();
  const [pairs, setPairs] = useState<[string, string][]>(() => openingPairs(event));
  const name = (teamId: string) => teamNameOf(event, teamId) ?? teamId;
  const { twice, missing } = pairingProblems(event, pairs);
  const used = new Set(pairs.flat());
  const byeTeam = event.teams.length % 2 === 1 ? event.teams.find((team) => !used.has(team.id)) : undefined;
  const drafted = event.status === "drafted";

  const set = (row: number, side: 0 | 1, teamId: string) =>
    setPairs((held) => held.map((pair, at) => (at === row ? (side === 0 ? [teamId, pair[1]] : [pair[0], teamId]) : pair)));

  return (
    <section className="surface tournament-round-one">
      <h4>{t("tournaments.roundOne.title")}</h4>
      <p className="muted">{t(drafted ? "tournaments.roundOne.introDrafted" : "tournaments.roundOne.introRunning")}</p>
      <ol className="tournament-round-one-rows">
        {pairs.map((pair, row) => (
          <li key={row}>
            {([0, 1] as const).map((side) => (
              <select
                key={side}
                value={pair[side]}
                disabled={busy}
                onChange={(changed) => set(row, side, changed.target.value)}
              >
                {event.teams.map((team) => (
                  <option key={team.id} value={team.id}>
                    {name(team.id)}
                  </option>
                ))}
              </select>
            ))}
          </li>
        ))}
      </ol>
      {byeTeam !== undefined && <p className="muted">{t("tournaments.roundOne.bye", { name: name(byeTeam.id) })}</p>}
      {twice.length > 0 && (
        <p className="tournament-warning">{t("tournaments.roundOne.twice", { names: twice.map(name).join(", ") })}</p>
      )}
      {missing.length > 0 && (
        <p className="tournament-warning">{t("tournaments.roundOne.missing", { names: missing.map(name).join(", ") })}</p>
      )}
      <div className="tournament-detail-actions">
        <Button
          variant="primary"
          disabled={busy || twice.length > 0 || missing.length > 0}
          onClick={() => onAdmin({ type: "swissRound1", payload: { pairs } })}
        >
          {t("tournaments.roundOne.save")}
        </Button>
        <Button disabled={busy} onClick={() => onAdmin({ type: "swissRound1", payload: { pairs: null } })}>
          {t("tournaments.roundOne.shuffle")}
        </Button>
      </div>
    </section>
  );
}
