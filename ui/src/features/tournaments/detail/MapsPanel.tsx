// The Maps tab: the event's map pools and its whole map database, for
// everyone. The website's `drawMaps`.
//
// Pools first, because a pool is what a round is played on and what a player
// wants to prepare for, then every map with its spawn information and where it
// is played. Editing stays in Manage; an organiser is pointed there from the
// header, with the numbers that tell them whether anything is still hidden.
//
// Every map is the same tile in both sections: the whole picture, square, with
// its name and size on a dark foot, the way the Training hub's basics carry
// theirs. A click opens the client's one map preview, the zoomable dialog the
// Play tab, the host dialog and a round's pool all open.

import { useState } from "react";
import { Button } from "../../../design-system/Button";
import type { MapPool, Tourney, TourneyMap, VaultMap } from "../../../ipc/bindings";
import type { MessageKey } from "../../../i18n";
import { useTranslation } from "../../../i18n/useTranslation";
import { MapPreviewDialog } from "../../../shared/components/MapPreviewZoom";
import { useVaultNameLookup } from "../../../shared/hooks/useVaultNameLookup";
import { matchVaultMap } from "../../../shared/rules/tourneyRules";
import { canEnlargeMapPicture, generatedMapParts, tourneyMapPicture } from "../mapPicture";
import { labelForRoundKey } from "../bracket/matchLabels";
import { needsSizeLookup, tourneyMapSize } from "../mapSizePresentation";
import { formatMoment } from "../tourneyPresentation";

interface MapsPanelProps {
  event: Tourney;
  vault: VaultMap[];
  assetBase: string;
  /** Open Manage, where the maps and pools are edited. Organisers only. */
  onManage: () => void;
}

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

/** A map's spawn information as label and value, as the website words it. */
function specRows(map: TourneyMap, t: Translate): { label: string; value: string }[] {
  const spec = map.spec;
  if (spec === null) return [];
  const rows: { label: string; value: string }[] = [];
  const list = (label: string, slots: number[]) => {
    if (slots.length > 0) rows.push({ label, value: slots.join(", ") });
  };
  list(t("tournaments.maps.spawnsTeam1"), spec.team1Spawns);
  list(t("tournaments.maps.spawnsTeam2"), spec.team2Spawns);
  list(t("tournaments.maps.closedSpawns"), spec.closedSpawns);
  list(t("tournaments.maps.closedMex"), spec.closedMexSpawns);
  return rows;
}

/** The spawn lines of a map, as the website writes them. Manage's list. */
export function MapSpec({ map }: { map: TourneyMap }) {
  const { t } = useTranslation();
  const rows = specRows(map, t);
  const size = map.spec?.size ?? "";
  if (rows.length === 0 && size === "") return null;
  return (
    <div className="tournament-mapdb-spec">
      {rows.map((row) => (
        <span key={row.label}>{`${row.label}: ${row.value}`}</span>
      ))}
      {size !== "" && <span>{t("tournaments.maps.size", { size })}</span>}
    </div>
  );
}

/**
 * One map as a tile: the picture, whole, and on its foot the name and the
 * size. The foot is black fading to nothing in either theme, since what lies
 * under it is a picture; the name used to sit on a fade to the page colour,
 * which on a snow map was white on white.
 */
function MapTile({
  map,
  size,
  picture,
  emptyLabel,
  onOpen,
}: {
  map: TourneyMap;
  /** From `tourneyMapSize`: the organiser's, else the one the client knows. */
  size: string;
  picture: string;
  emptyLabel: string;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const generated = generatedMapParts(map.name);
  const content = (
    <>
      {picture !== "" ? (
        <img src={picture} alt="" loading="lazy" decoding="async" />
      ) : (
        <span className="tournament-map-tile-none">{emptyLabel}</span>
      )}
      <span className="tournament-map-tile-foot">
        {/* A generated map by what it is and its seed, which is what tells
            two of them apart; the whole technical name is on hover. */}
        {generated !== null ? (
          <span className="tournament-map-tile-generated">
            <span className="tournament-map-tile-name">{t("tournaments.maps.generated")}</span>
            <span className="tournament-map-tile-seed">
              {generated.version !== "" ? `${generated.version} · ${generated.seed}` : generated.seed}
            </span>
          </span>
        ) : (
          <span className="tournament-map-tile-name">{map.name}</span>
        )}
        {size !== "" && (
          <span className="tournament-map-tile-size">{t("tournaments.maps.sizeShort", { size })}</span>
        )}
      </span>
    </>
  );
  // Only a picture worth enlarging makes the tile a button. Anything else is
  // drawn as it is rather than as a disabled button: those are dimmed, which
  // put the generator's art at half strength beside every vault map.
  return canEnlargeMapPicture(picture) ? (
    <button
      type="button"
      className="tournament-map-tile"
      onClick={onOpen}
      title={t("common.mapPreview", { name: map.name })}
    >
      {content}
    </button>
  ) : (
    <div className="tournament-map-tile is-static" title={map.name}>
      {content}
    </div>
  );
}

export function MapsPanel({ event, vault, assetBase, onManage }: MapsPanelProps) {
  const { t } = useTranslation();
  const [enlarged, setEnlarged] = useState<string | null>(null);
  const organiser = event.viewer.organiser;
  const db = event.mapDb;
  const byId = (mapId: string) => db.find((held) => held.id === mapId);
  const image = (map: TourneyMap) => (map.masked ? "" : tourneyMapPicture(map, assetBase, vault));
  const sizeOf = (map: TourneyMap) => tourneyMapSize(map, vault);

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

  // Sizes the organiser left out and the client cannot place yet: asked of
  // the vault by name, once, rather than loading the whole catalogue for them.
  useVaultNameLookup(visible.filter((map) => needsSizeLookup(map, vault)).map((map) => map.name));

  const noPicture = (map: TourneyMap) =>
    map.masked ? t("tournaments.maps.hidden") : t("tournaments.maps.noImage");

  // One pool holding exactly the maps on show: the pool and "All maps" were
  // the same tiles twice, the second time with the pool's name on every
  // card. Then the pool is the only section, and its maps are drawn as the
  // full cards, spawns and all, without the tag that would only repeat the
  // heading above them.
  const visibleIds = new Set(visible.map((map) => map.id));
  const onlyPool =
    pools.length === 1 &&
    visibleIds.size > 0 &&
    pools[0].mapIds.length === visibleIds.size &&
    pools[0].mapIds.every((mapId) => visibleIds.has(mapId));

  const mapCard = (map: TourneyMap, showPools: boolean) => {
    const played = playedIn(map.id);
    const pooled = showPools ? inPools(map.id) : [];
    const facts = specRows(map, t);
    const hidden = organiser && !map.published;
    const tagged = hidden || map.secret || pooled.length > 0;
    const unused = organiser && played.length === 0 && inPools(map.id).length === 0;
    const hasBody =
      tagged || facts.length > 0 || map.description !== "" || played.length > 0 || unused;
    return (
      <article className="tournament-mapdb-card" key={map.id}>
        <MapTile
          map={map}
          size={sizeOf(map)}
          picture={image(map)}
          emptyLabel={noPicture(map)}
          onOpen={() => setEnlarged(map.id)}
        />
        {/* What the picture cannot say, under it: which pools hold the map,
            the spawns, the organiser's note, where it is played. The pool
            tags say "in pool" on their own. */}
        {hasBody && (
          <div className="tournament-mapdb-body">
            {tagged && (
              <div className="tournament-mapdb-tags">
                {pooled.map((name) => (
                  <span key={name} className="tournament-badge is-ok">
                    {name}
                  </span>
                ))}
                {map.secret && (
                  <span className="tournament-badge" title={t("tournaments.maps.secretHint")}>
                    {t("tournaments.maps.secretBadge", { number: secretNumber(map) })}
                  </span>
                )}
                {hidden && <span className="tournament-badge">{t("tournaments.maps.hidden")}</span>}
              </div>
            )}
            {facts.length > 0 && (
              <dl className="tournament-mapdb-facts">
                {facts.map((fact) => (
                  <div key={fact.label}>
                    <dt>{fact.label}</dt>
                    <dd>{fact.value}</dd>
                  </div>
                ))}
              </dl>
            )}
            {map.description !== "" && <p className="tournament-mapdb-desc">{map.description}</p>}
            {played.length > 0 && (
              <p className="tournament-mapdb-used">
                {t("tournaments.maps.playedIn", { rounds: played.join(", ") })}
              </p>
            )}
            {unused && <p className="tournament-mapdb-used muted">{t("tournaments.maps.unused")}</p>}
          </div>
        )}
      </article>
    );
  };

  const open = enlarged === null ? undefined : byId(enlarged);
  const openPicture = open === undefined ? "" : image(open);
  const openMeta =
    open === undefined
      ? ""
      : [
          sizeOf(open) !== "" ? t("tournaments.maps.sizeShort", { size: sizeOf(open) }) : "",
          ...inPools(open.id),
        ]
          .filter((part) => part !== "")
          .join(" · ");

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
          <header className="tournament-maps-section-head">
            <h5>{t("tournaments.maps.pools")}</h5>
            <p className="muted">
              {t(organiser ? "tournaments.maps.poolsHintOrganiser" : "tournaments.maps.poolsHint")}
            </p>
          </header>
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
                  <article className="tournament-pool-card" key={pool.id}>
                    <header className="tournament-pool-card-head">
                      <h6>{pool.name}</h6>
                      <span className="tournament-pool-card-meta">
                        {t("tournaments.maps.poolCount", { bestOf, count: pool.mapIds.length })}
                      </span>
                      {organiser && !pool.published && (
                        <span className="tournament-badge">{t("tournaments.maps.hidden")}</span>
                      )}
                      {/* A schedule only means something while the pool is
                          hidden, and only its managers are ever sent one. */}
                      {organiser && !pool.published && pool.publishAt !== null && (
                        <span className="tournament-badge" title={t("tournaments.pools.scheduledHint")}>
                          {t("tournaments.pools.scheduledBadge")}
                        </span>
                      )}
                      {assigned.length > 0 ? (
                        <span className="tournament-pool-card-assign">
                          {t("tournaments.maps.usedFor", { rounds: assigned.join(", ") })}
                        </span>
                      ) : (
                        organiser && (
                          <span className="tournament-pool-card-assign is-none">
                            {t("tournaments.maps.notAssigned")}
                          </span>
                        )
                      )}
                    </header>
                    {organiser && !pool.published && pool.publishAt !== null && (
                      <p className="muted">
                        {t("tournaments.pools.scheduled", { when: formatMoment(pool.publishAt, "") })}
                      </p>
                    )}
                    {pool.mapIds.length === 0 ? (
                      <p className="muted">{t("tournaments.pools.empty")}</p>
                    ) : onlyPool ? (
                      <div className="tournament-mapdb-grid">
                        {pool.mapIds.map((mapId) => {
                          const map = byId(mapId);
                          return map === undefined ? null : mapCard(map, false);
                        })}
                      </div>
                    ) : (
                      <div className="tournament-pool-tiles">
                        {pool.mapIds.map((mapId) => {
                          const map = byId(mapId);
                          if (map === undefined) return null;
                          return (
                            <MapTile
                              key={mapId}
                              map={map}
                              size={sizeOf(map)}
                              picture={image(map)}
                              emptyLabel={noPicture(map)}
                              onOpen={() => setEnlarged(mapId)}
                            />
                          );
                        })}
                      </div>
                    )}
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
                  </article>
                );
              })}
            </div>
          )}
        </section>
      )}

      {!onlyPool && (
        <section className="tournament-maps-section">
          <header className="tournament-maps-section-head">
            <h5>{t("tournaments.maps.all")}</h5>
            {visible.length > 0 && <span className="tournament-maps-count">{visible.length}</span>}
          </header>
          {visible.length === 0 ? (
            <p className="muted">
              {t(organiser ? "tournaments.maps.emptyOrganiser" : "tournaments.maps.empty")}
            </p>
          ) : (
            <div className="tournament-mapdb-grid">{visible.map((map) => mapCard(map, true))}</div>
          )}
        </section>
      )}

      {open !== undefined && canEnlargeMapPicture(openPicture) && (
        <MapPreviewDialog
          map={{
            folderName: matchVaultMap(open, vault)?.folderName ?? "",
            displayName: open.name,
            thumbnailUrlLarge: openPicture,
          }}
          meta={openMeta === "" ? undefined : openMeta}
          onClose={() => setEnlarged(null)}
        />
      )}
    </div>
  );
}
