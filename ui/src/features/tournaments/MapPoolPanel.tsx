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

import { useState } from "react";
import { Button } from "../../design-system/Button";
import { Modal } from "../../design-system/Modal";
import type { MapPool, PoolDraft, Tourney, VaultMap } from "../../ipc/bindings";
import type { MessageKey } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";
import { BRACKET_LABELS } from "./tourneyPresentation";
import { matchVaultMap, roundPlan, type RoundKey } from "../../shared/tourneyRules";

interface MapPoolPanelProps {
  event: Tourney;
  vault: VaultMap[];
  busy: boolean;
  onAssign: (roundKey: string, poolId: string) => void;
  /** Create the pool a combination needs. The same write the pool editor makes. */
  onSavePool: (pool: PoolDraft) => void;
}

export function MapPoolPanel({ event, vault, busy, onAssign, onSavePool }: MapPoolPanelProps) {
  const { t } = useTranslation();
  const plan = roundPlan(event);
  const rounds = plan.keys;
  /**
   * The round whose combine chooser is open, by key, or null.
   *
   * A round holds *one* pool: `pool_assign` stores `poolAssign[round] = poolId`,
   * a single id, and there is no second field to put another in. So picking two
   * cannot bind two. What it can do is make a pool that holds exactly what the
   * round should play, which is what the chooser below writes.
   */
  const [combining, setCombining] = useState<string | null>(null);
  /** The pools ticked in the open chooser. */
  const [ticked, setTicked] = useState<string[]>([]);

  /**
   * Write the ticked pools as one pool of their own.
   *
   * The union of their maps, in the order they were ticked, with no ban and pick
   * order: inventing a sequence over maps from two different plans would fail
   * the service's own counting rules, and a pool without one is a valid list of
   * maps. It appears in the tag row like any other pool, and one click binds it.
   */
  const combine = (label: string) => {
    const maps: string[] = [];
    for (const poolId of ticked) {
      const held = event.mapPools.find((candidate) => candidate.id === poolId);
      for (const mapId of held?.mapIds ?? []) {
        if (!maps.includes(mapId)) maps.push(mapId);
      }
    }
    onSavePool({
      id: "",
      name: t("tournaments.pools.combinedName", { round: label }),
      mapIds: maps,
      sequence: [],
      bestOf: null,
    });
    setCombining(null);
    setTicked([]);
  };

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
          tournaments play the same maps every round, and setting that round by
          round is eight chances to miss one. */}
      {rounds.length > 1 && (
        <div className="tournament-pool-all surface">
          <span className="tournament-cell-label">{t("tournaments.pools.everyRound")}</span>
          <div className="tournament-pool-tags">
            {event.mapPools.map((candidate) => (
              <button
                type="button"
                className="tournament-pool-tag"
                key={candidate.id}
                disabled={busy}
                onClick={() => {
                  for (const round of rounds) onAssign(round.key, candidate.id);
                }}
              >
                {candidate.name}
              </button>
            ))}
          </div>
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
              {/* Tags rather than a dropdown. Every pool is on screen, the one
                  in use is filled in, and binding a round is one click on the
                  thing itself instead of opening a list to find it. Clicking the
                  filled one clears the round again.

                  One tag at a time, and that is the service's shape, not a
                  simplification: `pool_assign` stores `poolAssign[round] =
                  poolId`, a single id. A round that should play the maps of two
                  pools needs a pool that holds both, which is what step two is
                  for. */}
              <div className="tournament-pool-tags">
                {event.mapPools.map((candidate) => {
                  const bound = pool?.id === candidate.id;
                  return (
                    <button
                      type="button"
                      className={
                        bound ? "tournament-pool-tag is-bound" : "tournament-pool-tag"
                      }
                      key={candidate.id}
                      aria-pressed={bound}
                      disabled={busy}
                      onClick={() => onAssign(key, bound ? "" : candidate.id)}
                    >
                      {candidate.name}
                    </button>
                  );
                })}
                {/* The one tag that is not a pool: it makes one. Dashed, because
                    it is an outline of a pool rather than a pool, which is the
                    same convention as an empty slot anywhere else. */}
                {event.mapPools.length > 1 && (
                  <button
                    type="button"
                    className="tournament-pool-tag is-add"
                    disabled={busy}
                    onClick={() => {
                      setCombining(key);
                      setTicked(pool === null ? [] : [pool.id]);
                    }}
                  >
                    + {t("tournaments.pools.combine")}
                  </button>
                )}
              </div>
            </header>

            {combining === key && (
              <Modal
                onClose={() => setCombining(null)}
                ariaLabel={t("tournaments.pools.combine")}
                className="tournament-combine-modal"
              >
                <h4>{t("tournaments.pools.combineTitle", {
                  round: roundLabel(t, bracket, round, lastRound),
                })}</h4>
                <p className="muted">{t("tournaments.pools.combineHint")}</p>
                <ul className="tournament-combine-list">
                  {event.mapPools.map((candidate) => (
                    <li key={candidate.id}>
                      <label className="tournament-check">
                        <input
                          type="checkbox"
                          checked={ticked.includes(candidate.id)}
                          onChange={(changed) =>
                            setTicked((held) =>
                              changed.target.checked
                                ? [...held, candidate.id]
                                : held.filter((id) => id !== candidate.id),
                            )
                          }
                        />
                        <span>{candidate.name}</span>
                        <span className="muted">
                          {t("tournaments.bracket.poolCount", {
                            count: candidate.mapIds.length,
                          })}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
                <div className="tournament-form-actions">
                  <Button disabled={busy} onClick={() => setCombining(null)}>
                    {t("common.cancel")}
                  </Button>
                  <Button
                    variant="primary"
                    disabled={busy || ticked.length < 2}
                    onClick={() => combine(roundLabel(t, bracket, round, lastRound))}
                  >
                    {t("tournaments.pools.combineAction", { count: ticked.length })}
                  </Button>
                </div>
              </Modal>
            )}

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
