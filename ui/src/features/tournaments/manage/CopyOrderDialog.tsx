// Copying one pool's ban/pick order onto other pools.
//
// An order is exactly one step short of its pool's map count, so it can only
// go to pools with as many maps; the others are named as not eligible rather
// than left out without a word. The best-of travels with it, because the
// service welds the two together.

import { useState } from "react";
import { Button } from "../../../design-system/Button";
import type { MapPool } from "../../../ipc/bindings";
import { useTranslation } from "../../../i18n/useTranslation";

interface CopyOrderDialogProps {
  source: MapPool;
  pools: MapPool[];
  busy: boolean;
  /** `null` for every pool of the same size, else the ticked ones. */
  onCopy: (targets: string[] | null) => void;
  onCancel: () => void;
}

/** The pools an order can go to, and the ones it cannot. */
export function copyTargets(source: MapPool, pools: MapPool[]): { eligible: MapPool[]; other: MapPool[] } {
  const rest = pools.filter((pool) => pool.id !== source.id);
  return {
    eligible: rest.filter((pool) => pool.mapIds.length === source.mapIds.length),
    other: rest.filter((pool) => pool.mapIds.length !== source.mapIds.length),
  };
}

export function CopyOrderDialog({ source, pools, busy, onCopy, onCancel }: CopyOrderDialogProps) {
  const { t } = useTranslation();
  const [picked, setPicked] = useState<string[]>([]);
  const { eligible, other } = copyTargets(source, pools);
  const size = source.mapIds.length;
  const otherLine = other.map((pool) => `${pool.name} (${pool.mapIds.length})`).join(", ");

  return (
    <div className="surface tournament-pool-editor" role="dialog" aria-label={t("tournaments.pools.copyTitle", { name: source.name })}>
      <strong>{t("tournaments.pools.copyTitle", { name: source.name })}</strong>
      {eligible.length === 0 ? (
        <p className="muted">{t("tournaments.pools.copyNone", { name: source.name, count: size })}</p>
      ) : (
        <>
          <p className="muted">{t("tournaments.pools.copyHint", { count: size, bo: source.bestOf ?? 1 })}</p>
          {eligible.map((pool) => (
            <label className="tournament-checkbox" key={pool.id}>
              <input
                type="checkbox"
                checked={picked.includes(pool.id)}
                onChange={(changed) =>
                  setPicked((held) =>
                    changed.target.checked ? [...held, pool.id] : held.filter((id) => id !== pool.id),
                  )
                }
              />
              <span>
                {pool.name}{" "}
                <span className="muted">
                  {t("tournaments.pools.bo", { count: pool.bestOf ?? 1 })}
                  {pool.sequence.length === 0 && ` · ${t("tournaments.pools.noOrderYet")}`}
                </span>
              </span>
            </label>
          ))}
        </>
      )}
      {other.length > 0 && <p className="muted">{t("tournaments.pools.copyIneligible", { pools: otherLine })}</p>}
      <div className="tournament-detail-actions">
        {eligible.length > 0 && (
          <>
            <Button variant="primary" disabled={busy || picked.length === 0} onClick={() => onCopy(picked)}>
              {t("tournaments.pools.copySelected")}
            </Button>
            <Button disabled={busy} onClick={() => onCopy(null)}>
              {t("tournaments.pools.copyAll", { count: size, pools: eligible.length })}
            </Button>
          </>
        )}
        <Button onClick={onCancel}>{t(eligible.length === 0 ? "common.close" : "tournaments.pools.cancel")}</Button>
      </div>
    </div>
  );
}
