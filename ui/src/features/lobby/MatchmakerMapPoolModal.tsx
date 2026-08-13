import { useMemo, useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { Modal } from "../../design-system/Modal";
import { ipc } from "../../ipc/client";
import type { MapListStatus, MatchmakerMapPool, PlayerVeto, VaultMap } from "../../ipc/bindings";
import { GameMapImage } from "./GameMapImage";

function formatMapSize(width: number, height: number) {
  const normalize = (value: number) => value > 64 ? value / 51.2 : value;
  return `${normalize(width).toLocaleString("en-US", { maximumFractionDigits: 1 })}×${normalize(height).toLocaleString("en-US", { maximumFractionDigits: 1 })} km`;
}

function bracketTitle(pool: MatchmakerMapPool) {
  if (pool.minRating === null && pool.maxRating === null) return "Any rating";
  if (pool.minRating === null) return `Rating < ${Math.ceil(pool.maxRating ?? 0)}`;
  if (pool.maxRating === null) return `Rating > ${Math.floor(pool.minRating)}`;
  return `Rating ${Math.round(pool.minRating)}–${Math.round(pool.maxRating)}`;
}

interface Props {
  queueTitle: string;
  pools: MatchmakerMapPool[];
  status: MapListStatus;
  vault: VaultMap[];
  serverVetoes: PlayerVeto[];
  onClose: () => void;
}

export function MatchmakerMapPoolModal({ queueTitle, pools, status, vault, serverVetoes, onClose }: Props) {
  const sortedPools = useMemo(() => [...pools].sort((left, right) => (left.minRating ?? Number.NEGATIVE_INFINITY) - (right.minRating ?? Number.NEGATIVE_INFINITY)), [pools]);
  const [activePoolId, setActivePoolId] = useState<number | null>(null);
  const [vetoMode, setVetoMode] = useState(false);
  const [previewAssignmentId, setPreviewAssignmentId] = useState<number | null>(null);
  const [draftVetoes, setDraftVetoes] = useState<Record<string, number>>(() => Object.fromEntries(
    serverVetoes.map((veto) => [`${veto.matchmakerQueueMapPoolId}:${veto.mapPoolMapVersionId}`, veto.vetoTokensApplied]),
  ));
  const activePool = sortedPools.find((pool) => pool.id === activePoolId) ?? sortedPools[0];
  const previewMap = activePool?.maps.find((map) => map.assignmentId === previewAssignmentId) ?? null;
  const tokensUsed = activePool ? Object.entries(draftVetoes)
    .filter(([key]) => key.startsWith(`${activePool.id}:`))
    .reduce((total, [, tokens]) => total + tokens, 0) : 0;

  const toggleVeto = (assignmentId: number) => {
    if (!activePool || activePool.vetoTokensPerPlayer <= 0) return;
    const key = `${activePool.id}:${assignmentId}`;
    setDraftVetoes((current) => {
      const existing = current[key] ?? 0;
      const used = Object.entries(current)
        .filter(([entry]) => entry.startsWith(`${activePool.id}:`))
        .reduce((total, [, tokens]) => total + tokens, 0);
      const mapLimit = Math.max(1, activePool.maxTokensPerMap || activePool.vetoTokensPerPlayer);
      const next = existing >= mapLimit || used >= activePool.vetoTokensPerPlayer ? 0 : existing + 1;
      return { ...current, [key]: next };
    });
  };

  const resetPool = () => {
    if (!activePool) return;
    setDraftVetoes((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(`${activePool.id}:`))));
  };

  const save = () => {
    const vetoes: PlayerVeto[] = Object.entries(draftVetoes)
      .filter(([, tokens]) => tokens > 0)
      .map(([key, tokens]) => {
        const [poolId, assignmentId] = key.split(":").map(Number);
        return { matchmakerQueueMapPoolId: poolId, mapPoolMapVersionId: assignmentId, vetoTokensApplied: tokens };
      });
    ipc.send({ kind: "Lobby", command: { type: "setPlayerVetoes", payload: { vetoes } } });
    onClose();
  };

  const tokenLimit = activePool?.vetoTokensPerPlayer ?? 0;

  return (
    <Modal onClose={onClose}>
      <div className="play-dialog-head matchmaker-map-pool-head">
        <div><h2>{queueTitle} map pool</h2><p>Inspect every rating bracket and use veto tokens on maps you prefer not to play.</p></div>
        <Button disabled={!activePool || tokenLimit === 0} onClick={() => setVetoMode((current) => !current)}>
          <Icon name="filter" size={15} /> {vetoMode ? "Finish editing" : tokenLimit === 0 ? "No vetoes" : "Apply vetoes"}
        </Button>
      </div>

      {sortedPools.length > 1 && (
        <div className="map-pool-tabs" role="tablist" aria-label="Rating brackets">
          {sortedPools.map((pool) => <button type="button" role="tab" aria-selected={pool.id === activePool?.id} key={pool.id} className={pool.id === activePool?.id ? "active" : ""} onClick={() => { setActivePoolId(pool.id); setPreviewAssignmentId(null); }}>{bracketTitle(pool)}</button>)}
        </div>
      )}

      <div className="matchmaker-veto-toolbar">
        <span>{activePool ? bracketTitle(activePool) : "No rating bracket"}</span>
        <div className="matchmaker-token-wallet" aria-label={`${tokensUsed} of ${tokenLimit} veto tokens used`}>
          {Array.from({ length: tokenLimit }, (_, index) => <i key={index} className={index < tokensUsed ? "used" : ""} />)}
          <small>{tokensUsed} / {tokenLimit} vetoes</small>
        </div>
        {vetoMode && <Button onClick={resetPool}>Reset bracket</Button>}
      </div>

      {previewMap && !vetoMode && (
        <div className="matchmaker-map-preview surface">
          <GameMapImage mapName={previewMap.folderName} vault={vault} placeholderClassName="map-preview-placeholder" />
          <span><strong>{previewMap.displayName}</strong><small>{formatMapSize(previewMap.width, previewMap.height)} · {previewMap.maxPlayers} players · {previewMap.folderName}</small></span>
          <button type="button" aria-label="Close map preview" onClick={() => setPreviewAssignmentId(null)}><Icon name="close" size={15} /></button>
        </div>
      )}

      <div className="map-pool-grid">
        {status.type === "loading" && pools.length === 0 ? <p className="play-empty">Loading the current map pools…</p>
          : status.type === "failed" ? <p className="play-empty">Could not load map pools: {status.payload.reason}</p>
            : !activePool || activePool.maps.length === 0 ? <p className="play-empty">No map pool is available for this queue.</p>
              : activePool.maps.map((map) => {
                const tokens = draftVetoes[`${activePool.id}:${map.assignmentId}`] ?? 0;
                const previewed = map.assignmentId === previewAssignmentId;
                return (
                  <button
                    type="button"
                    key={map.assignmentId}
                    aria-pressed={vetoMode ? tokens > 0 : previewed}
                    className={`map-pool-card surface surface-interactive${tokens > 0 ? " vetoed" : ""}${previewed ? " previewed" : ""}`}
                    onClick={() => vetoMode ? toggleVeto(map.assignmentId) : setPreviewAssignmentId(map.assignmentId)}
                  >
                    <GameMapImage mapName={map.folderName} vault={vault} placeholderClassName="map-preview-placeholder" />
                    <span><strong>{map.displayName}</strong><small>{formatMapSize(map.width, map.height)} · {map.maxPlayers} players</small></span>
                    {tokens > 0 && <em>{tokens} token{tokens === 1 ? "" : "s"}</em>}
                  </button>
                );
              })}
      </div>

      <div className="play-dialog-actions">
        <span className="muted">{vetoMode ? "Click a map to add or remove veto tokens." : "Select a map for details, or enter veto mode to edit."}</span>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!activePool} onClick={save}>Save vetoes</Button>
      </div>
    </Modal>
  );
}
