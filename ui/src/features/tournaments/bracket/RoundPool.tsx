// A round's map pool: the button in the round's header, and the overlay it
// opens. Shared by the bracket columns and the Swiss round list.

import { useState } from "react";
import { Button } from "../../../design-system/Button";
import { Modal } from "../../../design-system/Modal";
import { MapPreviewDialog } from "../../../shared/components/MapPreviewZoom";
import { Icon } from "../../../design-system/Icon";
import type { MapPool, Tourney, VaultMap } from "../../../ipc/bindings";
import { useTranslation } from "../../../i18n/useTranslation";
import {
  matchVaultMap,
  poolForRound,
  tourneyMapImage,
} from "../../../shared/rules/tourneyRules";

/**
 * The button that opens a round's map pool.
 *
 * Nothing at all where no pool is bound, which is most rounds of most events: a
 * button that opens on "none" is worse than no button.
 */
export function PoolToggle({
  event,
  roundKey,
  open,
  onToggle,
}: {
  event: Tourney;
  roundKey: string;
  open: boolean;
  onToggle: (roundKey: string) => void;
}) {
  const { t } = useTranslation();
  const pool = poolForRound(event, roundKey);
  if (pool === null) return null;
  return (
    // The same button as a bracket column's header (`RoundMapBlock`): the
    // client's own, naming the pool it opens.
    <Button
      className={open ? "tournament-round-button is-open" : "tournament-round-button"}
      aria-expanded={open}
      onClick={() => onToggle(roundKey)}
      title={t("tournaments.bracket.poolHint", { name: pool.name })}
    >
      <Icon name="maps" size={14} />
      <span>{pool.name}</span>
    </Button>
  );
}

/**
 * The maps one round is played on.
 *
 * The maps come from the event's own database, pictured by the organiser's own
 * upload, or by FAF's vault where the name matches and the vault is loaded.
 */
export function PoolPanel({
  event,
  vault,
  assetBase,
  roundKey,
  pool: given,
  onClose,
}: {
  event: Tourney;
  vault: VaultMap[];
  assetBase: string;
  roundKey: string;
  /** The pool to show, where the caller resolved it (a fallback included). */
  pool?: MapPool;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  /** The map opened large, by its id in the event's database. */
  const [zoomed, setZoomed] = useState<string | null>(null);
  const pool = given ?? poolForRound(event, roundKey);
  if (pool === null) return null;
  const bans = pool.sequence.filter((step) => step.action === "ban").length;
  const picks = pool.sequence.filter((step) => step.action === "pick").length;
  const sides = {
    lowerA: "tournaments.vetoPlan.lowerA",
    lowerB: "tournaments.vetoPlan.lowerB",
    random: "tournaments.vetoPlan.random",
    manual: "tournaments.vetoPlan.manual",
  } as const;

  const named = (mapId: string) => {
    const held = event.mapDb.find((candidate) => candidate.id === mapId);
    if (held === undefined) return { name: mapId, image: "", folder: "" };
    const vaultMap = matchVaultMap(held, vault);
    return {
      name: vaultMap?.displayName ?? held.name,
      image: tourneyMapImage(held, assetBase, vault),
      folder: vaultMap?.folderName ?? "",
    };
  };
  const large = zoomed === null ? null : named(zoomed);

  // An overlay rather than a panel under the bracket. It is a grid of pictures
  // that answers one question and is then finished with, which is what an
  // overlay is for: it opens over whatever the reader was looking at, keeps its
  // place, and Escape or a click outside gives it back. The map generator's
  // preview works the same way, so this is one pattern in the client rather
  // than two for the same thing.
  return (
    <Modal onClose={onClose} ariaLabel={pool.name} className="tournament-pool-modal">
      <header className="tournament-pool-modal-head">
        <h4>{pool.name}</h4>
        <span className="muted">
          {`Bo${pool.bestOf ?? 1}`} · {t("tournaments.bracket.poolCount", { count: pool.mapIds.length })}
        </span>
      </header>
      {pool.mapIds.length === 0 ? (
        <p className="muted">{t("tournaments.pools.empty")}</p>
      ) : (
        <ul className="tournament-veto-grid">
          {pool.mapIds.map((mapId) => {
            const map = named(mapId);
            // A picture opens large, with the zoom and the panning the
            // client's other map previews have: a spawn layout is not read
            // off a thumbnail.
            return (
              <li className="tournament-veto-map" key={mapId}>
                {map.image === "" ? (
                  <span className="tournament-pool-map-blank" aria-hidden />
                ) : (
                  <button
                    type="button"
                    className="tournament-pool-map-zoom"
                    title={t("common.mapPreview", { name: map.name })}
                    aria-label={t("common.mapPreview", { name: map.name })}
                    onClick={() => setZoomed(mapId)}
                  >
                    <img src={map.image} alt="" loading="lazy" aria-hidden />
                  </button>
                )}
                <span className="tournament-veto-map-text">
                  <span>{map.name}</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {/* How the veto will run, in order, so captains do not meet the
          sequence for the first time when it is their turn. The website's
          footer reads a field the service never sends; this reads the mode. */}
      <h5>{t("tournaments.vetoPlan.title")}</h5>
      {!event.veto.enabled ? (
        <p className="muted">{t("tournaments.vetoPlan.off")}</p>
      ) : pool.sequence.length === 0 ? (
        <p className="muted">{t("tournaments.vetoPlan.noOrder")}</p>
      ) : (
        <div className="tournament-veto-plan">
          <p className="muted">
            {t("tournaments.vetoPlan.summary", { maps: pool.mapIds.length, bans, picks })}{" "}
            {t(sides[event.veto.teamA] ?? "tournaments.vetoPlan.lowerA")}
          </p>
          <ol className="tournament-veto-plan-steps">
            {pool.sequence.map((step, index) => (
              <li key={index}>
                <span className={`tournament-veto-act is-${step.action}`}>
                  {t(step.action === "ban" ? "tournaments.vetoPlan.ban" : "tournaments.vetoPlan.pick")}
                </span>{" "}
                {t(step.team === "a" ? "tournaments.pools.teamA" : "tournaments.pools.teamB")}
              </li>
            ))}
            <li className="is-decider">
              <span className="tournament-veto-act is-pick">{t("tournaments.vetoPlan.decider")}</span>{" "}
              {t("tournaments.vetoPlan.lastStanding")}
            </li>
          </ol>
          <p className="muted">
            {t(event.veto.mode === "continuous" ? "tournaments.vetoPlan.continuous" : "tournaments.vetoPlan.upfront")}
          </p>
        </div>
      )}
      {large !== null && (
        <MapPreviewDialog
          map={{ folderName: large.folder, displayName: large.name, thumbnailUrlLarge: large.image }}
          meta={pool.name}
          onClose={() => setZoomed(null)}
        />
      )}
    </Modal>
  );
}
