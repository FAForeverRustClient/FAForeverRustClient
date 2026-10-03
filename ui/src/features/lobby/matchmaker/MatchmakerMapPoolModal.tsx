import { useMemo, useState } from "react";
import { isGeneratedMap } from "../../../shared/mapPresentation";
import { Button } from "../../../design-system/Button";
import { Modal } from "../../../design-system/Modal";
import { ipc } from "../../../ipc/client";
import type { MapListStatus, MatchmakerMapPool, MatchmakerPoolMap, PlayerVeto, VaultMap } from "../../../ipc/bindings";
import { GameMapImage } from "../GameMapImage";
import { t } from "../../../i18n";
import { useTranslation } from "../../../i18n/useTranslation";
import { MapPreviewDialog } from "../../../shared/components/MapPreviewZoom";
import { kilometresLabel } from "../../../shared/mapPresentation";

function formatMapSize(width: number, height: number) {
  // A pool may state either units or kilometres; anything above 64 is units.
  // Both ends go through the one formatter, so a 17.5 km map is not announced
  // as 18 here and as 17.5 everywhere else.
  const normalize = (value: number) =>
    value > 64 ? kilometresLabel(value) : String(Math.round(value * 100) / 100);
  return `${normalize(width)}×${normalize(height)} km`;
}

/**
 * Smallest maps first, the order the Java client uses: by area, then width,
 * then name. The server hands maps over in the order a moderator added them,
 * which says nothing to a player choosing what to veto.
 */
export function sortMapsBySize<T extends { width: number; height: number; displayName: string }>(
  maps: readonly T[],
): T[] {
  // Same units-or-kilometres rule as the label, so a pool mixing the two
  // still compares like with like.
  const km = (value: number) => (value > 64 ? value / 51.2 : value);
  return [...maps].sort((left, right) => {
    const area = km(left.width) * km(left.height) - km(right.width) * km(right.height);
    if (area !== 0) return area;
    const width = km(left.width) - km(right.width);
    if (width !== 0) return width;
    return left.displayName.localeCompare(right.displayName, undefined, { sensitivity: "base" });
  });
}

function bracketTitle(pool: MatchmakerMapPool) {
  if (pool.minRating === null && pool.maxRating === null) return t("lobby.mapPool.anyRating");
  if (pool.minRating === null) {
    return t("lobby.mapPool.ratingBelow", { rating: Math.ceil(pool.maxRating ?? 0) });
  }
  if (pool.maxRating === null) {
    return t("lobby.mapPool.ratingAbove", { rating: Math.floor(pool.minRating) });
  }
  return t("lobby.mapPool.ratingBetween", {
    from: Math.round(pool.minRating),
    to: Math.round(pool.maxRating),
  });
}

export function findMatchingBracket(
  pools: MatchmakerMapPool[],
  playerRating: number | null,
): MatchmakerMapPool | null {
  if (playerRating === null || pools.length === 0) return null;
  return (
    pools.find((pool) => {
      const minOk = pool.minRating === null || playerRating >= pool.minRating;
      const maxOk = pool.maxRating === null || playerRating < pool.maxRating;
      return minOk && maxOk;
    }) ?? null
  );
}

interface Props {
  queueTitle: string;
  pools: MatchmakerMapPool[];
  status: MapListStatus;
  vault: VaultMap[];
  serverVetoes: PlayerVeto[];
  playerRating: number | null;
  onClose: () => void;
}

export function MatchmakerMapPoolModal({
  queueTitle,
  pools,
  status,
  vault,
  serverVetoes,
  playerRating,
  onClose,
}: Props) {
  // Vetoes are placed in a mode of their own (#407), as in the Java client's
  // map list (`vetoModeEnabled`): a card clicked to look at the map used to
  // veto it on the spot, and looking at the map was the more common reason to
  // click it. Outside the mode a click opens the large preview.
  const [vetoing, setVetoing] = useState(false);
  const [preview, setPreview] = useState<MatchmakerPoolMap | null>(null);
  const { t } = useTranslation();
  const sortedPools = useMemo(
    () =>
      [...pools].sort(
        (left, right) =>
          (left.minRating ?? Number.NEGATIVE_INFINITY) -
          (right.minRating ?? Number.NEGATIVE_INFINITY),
      ),
    [pools],
  );

  const matchedBracket = useMemo(
    () => findMatchingBracket(sortedPools, playerRating),
    [sortedPools, playerRating],
  );

  const [activePoolId, setActivePoolId] = useState<number | null>(
    () => matchedBracket?.id ?? sortedPools[0]?.id ?? null,
  );

  // What the server holds, which the backend updates the moment a veto is
  // sent (`VetoesUpdated`) and again whenever the server adjusts it. There is
  // no draft: Java sends every change as it is made (`setTokensForMap`), and a
  // draft that only a Save button sent was lost to every other way out of
  // the dialog.
  const vetoes = useMemo<Record<string, number>>(
    () =>
      Object.fromEntries(
        serverVetoes.map((veto) => [
          `${veto.matchmakerQueueMapPoolId}:${veto.mapPoolMapVersionId}`,
          veto.vetoTokensApplied,
        ]),
      ),
    [serverVetoes],
  );

  const activePool =
    sortedPools.find((pool) => pool.id === activePoolId) ??
    matchedBracket ??
    sortedPools[0];

  const activeMaps = useMemo(
    () => (activePool ? sortMapsBySize(activePool.maps) : []),
    [activePool],
  );

  const tokensUsed = activePool
    ? Object.entries(vetoes)
        .filter(([key]) => key.startsWith(`${activePool.id}:`))
        .reduce((total, [, tokens]) => total + tokens, 0)
    : 0;

  const tokenLimit = activePool?.vetoTokensPerPlayer ?? 0;

  // A pool with no cap per map lets every token go on one map: Java's
  // `isMaxPerMapDynamic`, which is `max_tokens_per_map == 0` on the server.
  const perMapCap = activePool && activePool.maxTokensPerMap > 0 ? activePool.maxTokensPerMap : null;

  const send = (next: Record<string, number>) => {
    const list: PlayerVeto[] = Object.entries(next)
      .filter(([, tokens]) => tokens > 0)
      .map(([key, tokens]) => {
        const [poolId, assignmentId] = key.split(":").map(Number);
        return {
          matchmakerQueueMapPoolId: poolId,
          mapPoolMapVersionId: assignmentId,
          vetoTokensApplied: tokens,
        };
      });
    ipc.send({ kind: "Lobby", command: { type: "setPlayerVetoes", payload: { vetoes: list } } });
  };

  // Java's plus and minus (`TeamMatchmakingMapTileController`): one token on,
  // as long as the map's cap and the bracket's tokens allow, or one off.
  const addVeto = (assignmentId: number) => {
    if (!activePool || tokenLimit <= 0 || tokensUsed >= tokenLimit) return;
    const key = `${activePool.id}:${assignmentId}`;
    const current = vetoes[key] ?? 0;
    if (perMapCap !== null && current >= perMapCap) return;
    send({ ...vetoes, [key]: current + 1 });
  };

  const removeVeto = (assignmentId: number) => {
    if (!activePool) return;
    const key = `${activePool.id}:${assignmentId}`;
    const current = vetoes[key] ?? 0;
    if (current <= 0) return;
    send({ ...vetoes, [key]: current - 1 });
  };

  const resetVetoes = () => {
    if (!activePool) return;
    send(Object.fromEntries(Object.entries(vetoes).filter(([key]) => !key.startsWith(`${activePool.id}:`))));
  };

  return (
    <Modal onClose={onClose}>
      <div className="play-dialog-head matchmaker-map-pool-head">
        <div>
          <h2>{t("lobby.mapPool.title", { queue: queueTitle })}</h2>
          <p>{t("lobby.mapPool.subtitle")}</p>
        </div>
      </div>

      {sortedPools.length > 1 && (
        <div className="map-pool-tabs" role="tablist" aria-label={t("lobby.mapPool.brackets")}>
          {sortedPools.map((pool) => (
            <button
              type="button"
              role="tab"
              aria-selected={pool.id === activePool?.id}
              key={pool.id}
              className={pool.id === activePool?.id ? "active" : ""}
              onClick={() => setActivePoolId(pool.id)}
            >
              {bracketTitle(pool)}
            </button>
          ))}
        </div>
      )}

      <div className="matchmaker-veto-toolbar">
        <span className="matchmaker-bracket-name">{activePool ? bracketTitle(activePool) : t("lobby.mapPool.noBracket")}</span>
        {tokenLimit === 0 ? (
          <span className="matchmaker-veto-unavailable">
            {t("lobby.mapPool.noVetoesAvailable")}
          </span>
        ) : (
          <div
            className="matchmaker-token-wallet"
            aria-label={vetoing ? t("lobby.mapPool.vetoesUsedAria", {
              used: tokensUsed,
              limit: tokenLimit,
            }) : undefined}
          >
            {/* The wallet only while vetoing, as Java shows it
                (`showVetoWallet`); outside the mode the button is all. */}
            {vetoing && Array.from({ length: tokenLimit }, (_, index) => (
              <i key={index} className={index < tokensUsed ? "used" : ""} />
            ))}
            {vetoing && <span>{tokensUsed} / {tokenLimit} {t("lobby.mapPool.vetoes")}</span>}
            <Button
              className="matchmaker-veto-mode"
              variant={vetoing ? "primary" : undefined}
              aria-pressed={vetoing}
              onClick={() => setVetoing((current) => !current)}
            >
              {t(vetoing ? "lobby.mapPool.doneVetoing" : "lobby.mapPool.assignVetoes")}
            </Button>
          </div>
        )}
      </div>

      <div className="map-pool-grid">
        {status.type === "loading" && pools.length === 0 ? (
          <p className="play-empty">{t("lobby.mapPool.loading")}</p>
        ) : status.type === "failed" ? (
          <p className="play-empty">{t("lobby.mapPool.failed", { reason: status.payload.reason })}</p>
        ) : !activePool || activePool.maps.length === 0 ? (
          <p className="play-empty">{t("lobby.mapPool.empty")}</p>
        ) : (
          activeMaps.map((map) => {
            const tokens = vetoes[`${activePool.id}:${map.assignmentId}`] ?? 0;
            // Java's two stripes (`updateBannedState`): a map at its cap is
            // banned and loses its colour; one with fewer tokens is only
            // partly banned. Without a cap no map is ever fully banned.
            const fullBan = perMapCap !== null && tokens >= perMapCap;
            const canAdd = vetoing && tokensUsed < tokenLimit && (perMapCap === null || tokens < perMapCap);
            // A generated map has no picture of its own to enlarge, so Java
            // opens nothing for it either.
            const previewable = !vetoing && !isGeneratedMap(map.folderName);

            return (
              <div className="map-pool-cell" key={map.assignmentId}>
              <button
                type="button"
                className={`map-pool-card surface surface-interactive${fullBan ? " vetoed" : tokens > 0 ? " partly-vetoed" : ""}${previewable ? "" : " is-disabled"}`}
                onClick={() => previewable && setPreview(map)}
                aria-disabled={!previewable}
                title={previewable ? t("lobby.mapPool.previewHint") : undefined}
              >
                <span className="map-pool-card-art">
                  <GameMapImage
                    mapName={map.folderName}
                    vault={vault}
                    placeholderClassName="map-preview-placeholder"
                  />
                  {tokens > 0 && (
                    <span className="map-pool-banned">
                      {t(fullBan ? "lobby.mapPool.banned" : "lobby.mapPool.partlyBanned")}
                    </span>
                  )}
                </span>
                <span className="map-pool-card-foot">
                  <strong>{map.displayName}</strong>
                  <small>{formatMapSize(map.width, map.height)} · {map.maxPlayers} players</small>
                </span>
              </button>
              {/* Shown while vetoing, and on a map that has tokens on it, as
                  Java's `vetoesBox`; usable only while vetoing. */}
              {(vetoing || tokens > 0) && tokenLimit > 0 && (
                <div className="map-pool-veto-stepper">
                  <Button
                    disabled={!vetoing || tokens === 0}
                    aria-label={t("lobby.mapPool.removeVeto", { map: map.displayName })}
                    title={t("lobby.mapPool.removeVetoHint")}
                    onClick={() => removeVeto(map.assignmentId)}
                  >
                    −
                  </Button>
                  <span aria-label={t("lobby.mapPool.tokensOnMap", { count: tokens })}>{tokens}</span>
                  <Button
                    disabled={!canAdd}
                    aria-label={t("lobby.mapPool.addVeto", { map: map.displayName })}
                    title={tokensUsed >= tokenLimit
                      ? t("lobby.mapPool.vetoLimitReached", { limit: tokenLimit })
                      : t("lobby.mapPool.vetoMapHint")}
                    onClick={() => addVeto(map.assignmentId)}
                  >
                    +
                  </Button>
                </div>
              )}
              </div>
            );
          })
        )}
      </div>

      <div className="play-dialog-actions">
        <span className="muted">
          {tokenLimit > 0 ? t("lobby.mapPool.vetoHint") : t("lobby.mapPool.noVetoesAvailable")}
        </span>
        {tokenLimit > 0 && (
          <Button disabled={tokensUsed === 0} onClick={resetVetoes}>
            {t("lobby.mapPool.reset")}
          </Button>
        )}
        <Button variant="primary" onClick={onClose}>{t("common.close")}</Button>
      </div>
      {preview && (
        <MapPreviewDialog
          map={{ folderName: preview.folderName, displayName: preview.displayName }}
          meta={`${formatMapSize(preview.width, preview.height)} · ${preview.maxPlayers} players`}
          onClose={() => setPreview(null)}
        >
          <GameMapImage
            mapName={preview.folderName}
            vault={vault}
            placeholderClassName="map-preview-placeholder"
            large
          />
        </MapPreviewDialog>
      )}
    </Modal>
  );
}
