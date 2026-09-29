// A round's map pool: the button in the round's header, and the overlay it
// opens. Shared by the bracket columns and the Swiss round list.

import { Modal } from "../../../design-system/Modal";
import { Icon } from "../../../design-system/Icon";
import type { Tourney, VaultMap } from "../../../ipc/bindings";
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
    <button
      type="button"
      className={
        open
          ? "tournament-round-pool-toggle is-open"
          : "tournament-round-pool-toggle"
      }
      aria-expanded={open}
      onClick={() => onToggle(roundKey)}
      title={t("tournaments.bracket.poolHint", { name: pool.name })}
    >
      <Icon name="maps" size={12} /> {t("tournaments.bracket.pool")}
    </button>
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
  onClose,
}: {
  event: Tourney;
  vault: VaultMap[];
  assetBase: string;
  roundKey: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const pool = poolForRound(event, roundKey);
  if (pool === null) return null;

  const named = (mapId: string) => {
    const held = event.mapDb.find((candidate) => candidate.id === mapId);
    if (held === undefined) return { name: mapId, image: "" };
    const vaultMap = matchVaultMap(held, vault);
    return {
      name: vaultMap?.displayName ?? held.name,
      image: tourneyMapImage(held, assetBase, vault),
    };
  };

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
          {t("tournaments.bracket.poolCount", { count: pool.mapIds.length })}
        </span>
      </header>
      {pool.mapIds.length === 0 ? (
        <p className="muted">{t("tournaments.pools.empty")}</p>
      ) : (
        <ul className="tournament-veto-grid">
          {pool.mapIds.map((mapId) => {
            const map = named(mapId);
            return (
              <li className="tournament-veto-map" key={mapId}>
                {map.image === "" ? (
                  <span className="tournament-pool-map-blank" aria-hidden />
                ) : (
                  <img src={map.image} alt="" loading="lazy" aria-hidden />
                )}
                <span>{map.name}</span>
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}
