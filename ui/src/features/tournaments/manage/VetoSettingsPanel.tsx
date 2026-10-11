// How map vetoes run, after the event exists.
//
// Its own save, as on the website, and not part of the settings form: the
// service rebuilds every veto that has not started whenever it receives the
// veto settings, the sides an organiser chose by hand included. Sent with every
// save of the name or the dates, that would quietly undo them.
//
// Which pools a veto walks, and in what order, is the pools' business under
// Maps; this is only whether, who acts first, and when.

import { useState } from "react";
import { Button } from "../../../design-system/Button";
import type { Tourney, TourneyAdmin, VetoConfig } from "../../../ipc/bindings";
import type { MessageKey } from "../../../i18n";
import { useTranslation } from "../../../i18n/useTranslation";

const TEAM_A: [VetoConfig["teamA"], MessageKey][] = [
  ["lowerA", "tournaments.veto.teamALowerA"],
  ["lowerB", "tournaments.veto.teamALowerB"],
  ["random", "tournaments.veto.teamARandom"],
  ["manual", "tournaments.veto.teamAManual"],
];

interface VetoSettingsPanelProps {
  event: Tourney;
  busy: boolean;
  onAdmin: (change: TourneyAdmin) => void;
}

export function VetoSettingsPanel({ event, busy, onAdmin }: VetoSettingsPanelProps) {
  const { t } = useTranslation();
  // Starts from the stored settings. The caller keys this panel by them, so
  // the service's answer after a save replaces the fields, and a reload for
  // some other write, which brings the same settings back, does not.
  const [config, setConfig] = useState<VetoConfig>(event.veto);
  const set = (patch: Partial<VetoConfig>) => setConfig((held) => ({ ...held, ...patch }));
  const changed = JSON.stringify(config) !== JSON.stringify(event.veto);
  const anySecret = event.mapDb.some((map) => map.secret);

  return (
    <div className="tournament-veto-settings">
      <label className="tournament-checkbox">
        <input
          type="checkbox"
          checked={config.enabled}
          disabled={busy}
          onChange={(input) => set({ enabled: input.target.checked })}
        />
        <span>{t("tournaments.form.vetoEnabled")}</span>
      </label>
      {config.enabled && (
        <>
          <label className="tournament-field">
            <span>{t("tournaments.veto.teamARule")}</span>
            <select
              value={config.teamA}
              disabled={busy}
              onChange={(input) => set({ teamA: input.target.value as VetoConfig["teamA"] })}
            >
              {TEAM_A.map(([value, label]) => (
                <option key={value} value={value}>
                  {t(label)}
                </option>
              ))}
            </select>
            <small className="muted">{t("tournaments.veto.teamARuleHint")}</small>
          </label>
          {/* Only where there is a secret map for it to reveal. */}
          {anySecret && (
            <label className="tournament-checkbox">
              <input
                type="checkbox"
                checked={config.revealBans}
                disabled={busy}
                onChange={(input) => set({ revealBans: input.target.checked })}
              />
              <span>{t("tournaments.veto.revealBans")}</span>
            </label>
          )}
          <label className="tournament-field">
            <span>{t("tournaments.form.vetoMode")}</span>
            <select
              value={config.mode}
              disabled={busy}
              onChange={(input) => set({ mode: input.target.value as VetoConfig["mode"] })}
            >
              <option value="upfront">{t("tournaments.form.vetoUpfront")}</option>
              <option value="continuous">{t("tournaments.form.vetoContinuous")}</option>
            </select>
          </label>
        </>
      )}
      <p className="muted">{t("tournaments.veto.saveHint")}</p>
      <Button
        variant="primary"
        disabled={busy || !changed}
        onClick={() => onAdmin({ type: "setVeto", payload: { config } })}
      >
        {t("tournaments.veto.save")}
      </Button>
    </div>
  );
}
