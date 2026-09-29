// The Maps tab: the event's map pools and its whole map database, for
// everyone. The website's `drawMaps`.
//
// Pools first, because a pool is what a round is played on and what a player
// wants to prepare for, then every map with its spawn information and where it
// is played. A picture opens larger on a click. Editing stays in Manage; an
// organiser is pointed there from the header, with the numbers that tell them
// whether anything is still hidden.

import { useState } from "react";
import { Button } from "../../../design-system/Button";
import { Modal } from "../../../design-system/Modal";
import type { MapPool, Tourney, TourneyMap, VaultMap } from "../../../ipc/bindings";
import { useTranslation } from "../../../i18n/useTranslation";
import { tourneyMapImage } from "../../../shared/rules/tourneyRules";
import { labelForRoundKey } from "../bracket/matchLabels";

interface MapsPanelProps {
  event: Tourney;
  vault: VaultMap[];
  assetBase: string;
  /** Open Manage, where the maps and pools are edited. Organisers only. */
  onManage: () => void;
}

/** The spawn lines of a map, as the website writes them. */
export function MapSpec({ map }: { map: TourneyMap }) {
  const { t } = useTranslation();
  const spec = map.spec;
  if (spec === null) return null;
  const lines: string[] = [];
  const list = (label: string, slots: number[]) => {
    if (slots.length > 0) lines.push(`${label}: ${slots.join(", ")}`);
  };
  list(t("tournaments.maps.spawnsTeam1"), spec.team1Spawns);
  list(t("tournaments.maps.spawnsTeam2"), spec.team2Spawns);
  list(t("tournaments.maps.closedSpawns"), spec.closedSpawns);
  list(t("tournaments.maps.closedMex"), spec.closedMexSpawns);
  if (spec.size !== "") lines.push(t("tournaments.maps.size", { size: spec.size }));
  if (lines.length === 0) return null;
  return (
    <div className="tournament-mapdb-spec">
      {lines.map((line) => (
        <span key={line}>{line}</span>
      ))}
    </div>
  );
}

export function MapsPanel({ event, vault, assetBase, onManage }: MapsPanelProps) {
  const { t } = useTranslation();
  const [enlarged, setEnlarged] = useState<string | null>(null);
  const organiser = event.viewer.organiser;
  const db = event.mapDb;
  const byId = (mapId: string) => db.find((held) => held.id === mapId);
  const image = (map: TourneyMap) => (map.masked ? "" : tourneyMapImage(map, assetBase, vault));

  // Where a map is played directly (pinned to a round), and which pools hold
  // it. Pool membership is not "played in", as on the website.
  const playedIn = (mapId: string) =>
    event.roundMaps
      .filter((pinned) => pinned.mapIds.includes(mapId))
      .map((pinned) => labelForRoundKey(event, pinned.round, t));
  const inPools = (mapId: string) =>
    event.mapPools.filter((pool) => pool.mapIds.includes(mapId)).map((pool) => pool.name);
  const usedFor = (pool: MapPool) =>
    event.poolAssign
      .filter((assigned) => assigned.poolId === pool.id)
      .map((assigned) => labelForRoundKey(event, assigned.round, t));

  const secretNumber = (map: TourneyMap) =>
    db.filter((held) => held.secret).findIndex((held) => held.id === map.id) + 1;

  const visible = organiser ? db : db.filter((map) => map.published);
  const pools = organiser ? event.mapPools : event.mapPools.filter((pool) => pool.published);
  const published = db.filter((map) => map.published).length;

  const noPicture = (map: TourneyMap) =>
    map.masked ? t("tournaments.maps.hidden") : t("tournaments.maps.noImage");

  const open = enlarged === null ? undefined : byId(enlarged);

  return (
    <div className="tournament-maps">
      {organiser && (
        <section className="surface tournament-maps-admin">
          <div>
            <h5>{t("tournaments.maps.database")}</h5>
            <p className="muted">
              {t("tournaments.maps.databaseCounts", {
                total: db.length,
                published,
                hidden: db.length - published,
              })}
            </p>
          </div>
          <Button onClick={onManage}>{t("tournaments.maps.manage")}</Button>
        </section>
      )}

      {(organiser || pools.length > 0) && (
        <section className="tournament-maps-section">
          <h5>{t("tournaments.maps.pools")}</h5>
          <p className="muted">
            {t(organiser ? "tournaments.maps.poolsHintOrganiser" : "tournaments.maps.poolsHint")}
          </p>
          {pools.length === 0 ? (
            <p className="muted">{t("tournaments.maps.noPools")}</p>
          ) : (
            <div className="tournament-pool-cards">
              {pools.map((pool) => {
                const assigned = usedFor(pool);
                const steps = pool.sequence.length;
                const picks = pool.sequence.filter((step) => step.action === "pick").length;
                const bestOf = pool.bestOf ?? picks + 1;
                const orderFits = steps === pool.mapIds.length - 1 && picks === bestOf - 1;
                return (
                  <article className="surface tournament-pool-card" key={pool.id}>
                    <header className="tournament-pool-card-head">
                      <strong>{pool.name}</strong>
                      {organiser && !pool.published && (
                        <span className="tournament-badge">{t("tournaments.maps.hidden")}</span>
                      )}
                      <span className="muted">
                        {t("tournaments.maps.poolCount", { bestOf, count: pool.mapIds.length })}
                      </span>
                    </header>
                    <div className="tournament-pool-thumbs">
                      {pool.mapIds.length === 0 && <span className="muted">{t("tournaments.pools.empty")}</span>}
                      {pool.mapIds.map((mapId) => {
                        const map = byId(mapId);
                        if (map === undefined) return null;
                        const picture = image(map);
                        // The name sits under the picture, not on it: laid over
                        // the image it was white on white on every snow map.
                        return (
                          <button
                            type="button"
                            className="tournament-pool-thumb"
                            key={mapId}
                            disabled={picture === ""}
                            onClick={() => setEnlarged(mapId)}
                          >
                            <span className="tournament-pool-thumb-image">
                              {picture !== "" ? (
                                <img src={picture} alt="" loading="lazy" decoding="async" />
                              ) : (
                                <span className="tournament-pool-thumb-none muted">{noPicture(map)}</span>
                              )}
                            </span>
                            <span className="tournament-pool-thumb-caption">
                              <span className="tournament-pool-thumb-name">{map.name}</span>
                              {map.spec !== null && map.spec.size !== "" && (
                                <span className="muted">{map.spec.size}</span>
                              )}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    {organiser && steps === 0 && (
                      <p className="tournament-pool-card-warn">{t("tournaments.maps.noOrder")}</p>
                    )}
                    {organiser && steps > 0 && !orderFits && (
                      <p className="tournament-pool-card-warn">
                        {t("tournaments.maps.orderMismatch", {
                          steps: pool.mapIds.length - 1,
                          picks: bestOf - 1,
                        })}
                      </p>
                    )}
                    {assigned.length > 0 ? (
                      <p className="tournament-pool-card-assign">
                        {t("tournaments.maps.usedFor", { rounds: assigned.join(", ") })}
                      </p>
                    ) : (
                      organiser && <p className="muted">{t("tournaments.maps.notAssigned")}</p>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </section>
      )}

      <section className="tournament-maps-section">
        <h5>{t("tournaments.maps.all")}</h5>
        {visible.length === 0 ? (
          <p className="muted">
            {t(organiser ? "tournaments.maps.emptyOrganiser" : "tournaments.maps.empty")}
          </p>
        ) : (
          <div className="tournament-mapdb-grid">
            {visible.map((map) => {
              const picture = image(map);
              const played = playedIn(map.id);
              const pooled = inPools(map.id);
              return (
                <article className="surface tournament-mapdb-card" key={map.id}>
                  <button
                    type="button"
                    className="tournament-mapdb-thumb"
                    disabled={picture === ""}
                    onClick={() => setEnlarged(map.id)}
                  >
                    {picture !== "" ? (
                      <img src={picture} alt="" loading="lazy" decoding="async" />
                    ) : (
                      <span className="muted">{noPicture(map)}</span>
                    )}
                  </button>
                  <div className="tournament-mapdb-body">
                    <strong className="tournament-mapdb-name">
                      {map.name}
                      {organiser && !map.published && (
                        <span className="tournament-badge">{t("tournaments.maps.hidden")}</span>
                      )}
                      {map.secret && (
                        <span className="tournament-badge" title={t("tournaments.maps.secretHint")}>
                          {t("tournaments.maps.secretBadge", { number: secretNumber(map) })}
                        </span>
                      )}
                      {pooled.length > 0 && <span className="tournament-badge is-ok">{pooled.join(", ")}</span>}
                    </strong>
                    <MapSpec map={map} />
                    {map.description !== "" && <p className="tournament-mapdb-desc">{map.description}</p>}
                    {played.length > 0 ? (
                      <p className="tournament-mapdb-used">
                        {t("tournaments.maps.playedIn", { rounds: played.join(", ") })}
                      </p>
                    ) : pooled.length > 0 ? (
                      <p className="tournament-mapdb-used muted">
                        {t("tournaments.maps.inPool", { pools: pooled.join(", ") })}
                      </p>
                    ) : (
                      organiser && <p className="tournament-mapdb-used muted">{t("tournaments.maps.unused")}</p>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {open !== undefined && (
        <Modal onClose={() => setEnlarged(null)} className="tournament-map-lightbox" ariaLabel={open.name}>
          <h3>{open.name}</h3>
          {image(open) !== "" && <img className="tournament-map-lightbox-img" src={image(open)} alt="" />}
          <MapSpec map={open} />
          {open.description !== "" ? (
            <p className="tournament-mapdb-desc">{open.description}</p>
          ) : (
            <p className="muted">{t("tournaments.maps.noDescription")}</p>
          )}
          <div className="tournament-form-actions">
            <Button onClick={() => setEnlarged(null)}>{t("common.close")}</Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
