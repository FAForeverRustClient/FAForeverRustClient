// Faction vetoes, switched on and sized by an organiser (`fveto_config`).
//
// A 1v1 feature: each player bans and then picks factions per game, in secret,
// and plays the first of their picks the other did not ban. Picks always
// outnumber bans, so an opponent can never ban every faction a player named;
// the picks choice only offers what the service would accept.
//
// Saving applies to every match that has no result yet. Changing the numbers
// of a match already under way throws its choices away, which the service
// does and the hint says.

import { useEffect, useState } from "react";
import { Button } from "../../../design-system/Button";
import type { FactionVetoConfig, Tourney } from "../../../ipc/bindings";
import { useTranslation } from "../../../i18n/useTranslation";
import { factionConfigIsSubmittable } from "../../../shared/rules/tourneyRules";

interface FactionVetoPanelProps {
  event: Tourney;
  busy: boolean;
  onSave: (config: FactionVetoConfig) => void;
}

export function FactionVetoPanel({ event, busy, onSave }: FactionVetoPanelProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<FactionVetoConfig>(event.factionVeto);
  // Follow the event when it changes underneath, after a save or another
  // organiser's edit.
  useEffect(() => setDraft(event.factionVeto), [event.factionVeto]);

  const set = (patch: Partial<FactionVetoConfig>) => {
    const next = { ...draft, ...patch };
    // Picks have to stay above bans; raising the bans lifts the picks with them.
    if (next.picks <= next.bans) next.picks = Math.min(3, next.bans + 1);
    setDraft(next);
  };
  const changed =
    draft.enabled !== event.factionVeto.enabled ||
    draft.bans !== event.factionVeto.bans ||
    draft.picks !== event.factionVeto.picks;

  return (
    <div className="tournament-fveto-admin">
      <label className="tournament-check">
        <input
          type="checkbox"
          checked={draft.enabled}
          disabled={busy}
          onChange={(toggled) => set({ enabled: toggled.target.checked })}
        />
        <span>{t("tournaments.faction.adminEnabled")}</span>
      </label>
      {draft.enabled && (
        <div className="tournament-form-row">
          <label className="tournament-field">
            <span>{t("tournaments.faction.adminBans")}</span>
            <select
              value={draft.bans}
              disabled={busy}
              onChange={(picked) => set({ bans: Number(picked.target.value) })}
            >
              {[1, 2].map((count) => (
                <option key={count} value={count}>
                  {count}
                </option>
              ))}
            </select>
          </label>
          <label className="tournament-field">
            <span>{t("tournaments.faction.adminPicks")}</span>
            <select
              value={draft.picks}
              disabled={busy}
              onChange={(picked) => set({ picks: Number(picked.target.value) })}
            >
              {[2, 3]
                .filter((count) => count > draft.bans)
                .map((count) => (
                  <option key={count} value={count}>
                    {count}
                  </option>
                ))}
            </select>
          </label>
        </div>
      )}
      <p className="tournament-form-hint muted">{t("tournaments.faction.adminHint")}</p>
      <div className="tournament-detail-actions">
        <Button
          variant="primary"
          disabled={busy || !changed || !factionConfigIsSubmittable(draft)}
          onClick={() => onSave(draft)}
        >
          {t("tournaments.form.save")}
        </Button>
      </div>
    </div>
  );
}
