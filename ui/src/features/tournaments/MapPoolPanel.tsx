// Binding a map pool to a round.
//
// The last of the three map steps: `MapDbPanel` holds the maps, `PoolEditor`
// groups them into a pool with a ban/pick order, and this says which round is
// played from which pool.
//
// The rounds do not wait for the draw. `roundPlan` reads them off the bracket
// once it exists and **projects** them from the expected entrant count before
// that, which is what lets an organiser prepare the whole map plan during
// signups. That is also when they do it: a bracket is drawn on the day, and a
// panel that offered nothing until then would send them to the website for the
// one step that has to happen first.
//
// The pool's maps are the tournament's own records, which carry a name an
// organiser typed or picked. `matchVaultMap` is the twin of the Rust resolver
// that turns `Setons Clutch`, `scmp_009` and `SCMP_009.v0001` into the same
// vault entry, so a preview appears without anyone maintaining a lookup table.

import { Button } from "../../design-system/Button";
import type { MapPool, Tourney, VaultMap } from "../../ipc/bindings";
import type { MessageKey } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";
import { BRACKET_LABELS } from "./tourneyPresentation";
import { matchVaultMap, roundPlan, type RoundKey } from "../../shared/tourneyRules";

interface MapPoolPanelProps {
  event: Tourney;
  vault: VaultMap[];
  busy: boolean;
  onAssign: (roundKey: string, poolId: string) => void;
}

export function MapPoolPanel({ event, vault, busy, onAssign }: MapPoolPanelProps) {
  const { t } = useTranslation();
  const plan = roundPlan(event);
  const rounds = plan.keys;

  if (event.mapPools.length === 0) {
    return <p className="muted">{t("tournaments.pools.none")}</p>;
  }

  const poolFor = (key: string): MapPool | null => {
    const bound = event.poolAssign.find((assignment) => assignment.round === key);
    if (bound === undefined) return null;
    return event.mapPools.find((pool) => pool.id === bound.poolId) ?? null;
  };

  return (
    <div className="tournament-pools">
      {rounds.length === 0 && (
        <p className="muted">
          {t(
            event.competition === "freeForAll"
              ? "tournaments.pools.noRoundsFfa"
              : "tournaments.pools.noRoundsYet",
          )}
        </p>
      )}

      {/* One pool for the whole event is the common case by a distance: most
          tournaments play the same maps every round, and setting that as eight
          separate dropdowns is eight chances to miss one. */}
      {rounds.length > 1 && (
        <div className="tournament-pool-all surface">
          <label className="tournament-field">
            <span>{t("tournaments.pools.everyRound")}</span>
            <select
              value=""
              disabled={busy}
              onChange={(changed) => {
                const poolId = changed.target.value;
                if (poolId === "") return;
                for (const round of rounds) onAssign(round.key, poolId);
              }}
            >
              <option value="">{t("tournaments.pools.everyRoundPick")}</option>
              {event.mapPools.map((candidate) => (
                <option value={candidate.id} key={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {/* Said plainly rather than left to be discovered: these rounds are a
          projection, and a field that grows or shrinks before the draw changes
          them. */}
      {plan.projected && rounds.length > 0 && (
        <p className="muted">
          {t("tournaments.pools.projected", { count: String(plan.teams) })}
        </p>
      )}

      {rounds.map(({ key, bracket, round, lastRound }: RoundKey) => {
        const pool = poolFor(key);
        return (
          <section className="surface tournament-pool-round" key={key}>
            <header className="tournament-pool-header">
              <h5>{roundLabel(t, bracket, round, lastRound)}</h5>
              <label className="tournament-field">
                <span className="visually-hidden">{t("tournaments.pools.assign")}</span>
                <select
                  value={pool?.id ?? ""}
                  disabled={busy}
                  onChange={(changed) => onAssign(key, changed.target.value)}
                >
                  {/* An empty value clears the binding, which is how a round
                      goes back to having no pool at all. */}
                  <option value="">{t("tournaments.pools.unassigned")}</option>
                  {event.mapPools.map((candidate) => (
                    <option value={candidate.id} key={candidate.id}>
                      {candidate.name}
                    </option>
                  ))}
                </select>
              </label>
            </header>

            {pool !== null && (
              <ul className="tournament-pool-maps">
                {pool.mapIds.map((mapId) => {
                  const held = event.mapDb.find((candidate) => candidate.id === mapId);
                  if (held === undefined) return null;
                  const vaultMap = matchVaultMap(held, vault);
                  // FAF's own preview is preferred: it is the picture players
                  // already recognise from the maps tab. The tournament
                  // server's copy is the fallback for a map never uploaded.
                  const preview = vaultMap?.thumbnailUrl || held.imageUrl;
                  return (
                    <li className="tournament-pool-map" key={mapId}>
                      {preview ? (
                        <img src={preview} alt="" loading="lazy" aria-hidden />
                      ) : (
                        <span className="tournament-pool-map-blank" aria-hidden />
                      )}
                      <span>{vaultMap?.displayName ?? held.name}</span>
                      {vaultMap === null && (
                        <span className="muted" title={t("tournaments.pools.notInVaultHint")}>
                          {t("tournaments.pools.notInVault")}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

/**
 * A round's name as the bracket itself would say it.
 *
 * "Semifinals" rather than "Winners round 3", because that is what an organiser
 * calls the round they are assigning maps to. Only the deepest rounds get a
 * name; anything earlier stays numbered, which is also what the website does.
 */
function roundLabel(
  t: (key: MessageKey, values?: Record<string, string | number>) => string,
  bracket: string,
  round: number,
  lastRound: number,
): string {
  if (bracket === "grandFinal") return t("tournaments.pools.roundGrandFinal");
  if (bracket === "swiss") return t("tournaments.pools.roundSwiss", { round });
  if (bracket === "losers") {
    return round === lastRound
      ? t("tournaments.pools.roundLosersFinal")
      : t("tournaments.pools.roundLosers", { round });
  }
  if (round === lastRound) return t("tournaments.pools.roundFinal");
  if (round === lastRound - 1) return t("tournaments.pools.roundSemi");
  if (round === lastRound - 2) return t("tournaments.pools.roundQuarter");
  return `${t(BRACKET_LABELS[bracket as keyof typeof BRACKET_LABELS])} ${t("tournaments.bracket.round", { round })}`;
}

interface ManageLinkProps {
  event: Tourney;
  onOpen: (url: string) => void;
}

/**
 * The way out to the website.
 *
 * Everything this client deliberately does not do lives there: creating the
 * event, its format, its best-of plan, its series. It is done once per event,
 * it is form-heavy, and a second surface for it would be a worse copy of a
 * maintained one.
 */
export function ManageLink({ event, onOpen }: ManageLinkProps) {
  const { t } = useTranslation();
  return (
    <div className="tournament-manage">
      <p className="muted">{t("tournaments.manage.explanation")}</p>
      <Button
        onClick={() =>
          onOpen(`https://tournaments.doodlepros.com/t/${encodeURIComponent(event.id)}`)
        }
      >
        {t("tournaments.manage.open")}
      </Button>
    </div>
  );
}
