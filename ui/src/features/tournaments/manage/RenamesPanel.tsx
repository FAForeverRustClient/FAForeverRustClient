// Entrants who renamed on FAF after they entered.
//
// A name is stamped on an entry at signup and FAF tells nobody when it changes,
// so a renamed player keeps their old name in the bracket until somebody asks.
// Two steps, as on the website: the check writes nothing, because the old name
// is sometimes the one wanted (a caster's on-stream name, a known alias, a
// bracket already screenshotted), and the organiser ticks which to take.
//
// The list goes away with the next write, on purpose: every write re-reads the
// event, and renames that have just been taken would otherwise still be listed
// as waiting. Checking again is one click.

import { useEffect, useState } from "react";
import { Button } from "../../../design-system/Button";
import type { RenameCheck, TourneyAdmin, TourneyLoadStatus } from "../../../ipc/bindings";
import { useTranslation } from "../../../i18n/useTranslation";

interface RenamesPanelProps {
  check: RenameCheck | null;
  status: TourneyLoadStatus;
  busy: boolean;
  onCheck: () => void;
  onAdmin: (change: TourneyAdmin) => void;
}

export function RenamesPanel({ check, status, busy, onCheck, onAdmin }: RenamesPanelProps) {
  const { t } = useTranslation();
  /** Which renames to take. All of them, until the organiser says otherwise. */
  const [chosen, setChosen] = useState<Set<string>>(
    () => new Set(check?.changed.map((rename) => rename.playerId) ?? []),
  );
  useEffect(() => {
    setChosen(new Set(check?.changed.map((rename) => rename.playerId) ?? []));
  }, [check]);

  const checking = status.type === "loading";
  const notes: string[] = [];
  if (check !== null && check.failed > 0) notes.push(t("tournaments.renames.failed", { count: check.failed }));
  if (check !== null && check.manual > 0) notes.push(t("tournaments.renames.manual", { count: check.manual }));

  return (
    <div className="tournament-renames">
      <p className="muted">{t("tournaments.renames.hint")}</p>
      <div className="tournament-detail-actions">
        <Button type="button" disabled={busy || checking} onClick={onCheck}>
          {t(checking ? "tournaments.renames.checking" : "tournaments.renames.check")}
        </Button>
      </div>

      {status.type === "failed" && <p className="tournament-form-hint">{status.payload.reason}</p>}

      {check !== null &&
        (check.changed.length === 0 ? (
          <p className="muted">
            {check.checked === 0
              ? t("tournaments.renames.nobody")
              : t("tournaments.renames.allCurrent", { count: check.checked })}
          </p>
        ) : (
          <>
            <h6>
              {t("tournaments.renames.changed", {
                count: check.changed.length,
                checked: check.checked,
              })}
            </h6>
            <label className="tournament-checkbox">
              <input
                type="checkbox"
                checked={chosen.size === check.changed.length}
                onChange={(changed) =>
                  setChosen(
                    new Set(changed.target.checked ? check.changed.map((rename) => rename.playerId) : []),
                  )
                }
              />
              <span>{t("tournaments.renames.selectAll")}</span>
            </label>
            <ul className="tournament-rename-list">
              {check.changed.map((rename) => (
                <li key={rename.playerId}>
                  <label className="tournament-checkbox">
                    <input
                      type="checkbox"
                      checked={chosen.has(rename.playerId)}
                      onChange={(changed) => {
                        const next = new Set(chosen);
                        if (changed.target.checked) next.add(rename.playerId);
                        else next.delete(rename.playerId);
                        setChosen(next);
                      }}
                    />
                    <span>
                      <span className="muted">{rename.from}</span> {"→"} <strong>{rename.to}</strong>
                    </span>
                  </label>
                  {rename.team !== null && (
                    <small className="muted tournament-rename-team">
                      {t("tournaments.renames.team", { team: rename.team })}
                    </small>
                  )}
                </li>
              ))}
            </ul>
            <div className="tournament-detail-actions">
              <Button
                type="button"
                variant="primary"
                disabled={busy || chosen.size === 0}
                onClick={() =>
                  onAdmin({ type: "applyRenames", payload: { playerIds: [...chosen] } })
                }
              >
                {t("tournaments.renames.apply", { count: chosen.size })}
              </Button>
            </div>
          </>
        ))}
      {notes.length > 0 && <p className="muted">{notes.join(" ")}</p>}
    </div>
  );
}
