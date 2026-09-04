// The best-of plan, asked once, at the moment the bracket is drawn.
//
// This is the step the website has and the client did not: it sent `phase` with
// nothing but the action, so the service fell back to its own defaults and the
// organiser never got to say otherwise. The plan was called "website-only" in
// this feature's notes for a while, which was right about the timing and wrong
// about the question: before signups close there is no round count to ask
// about, but the moment teams are formed there is exactly one, and this is it.
//
// Accepting it unchanged sends the same defaults the service would have used,
// so nothing is lost by pressing Generate straight away.

import { useState } from "react";
import { Button } from "../../design-system/Button";
import { Modal } from "../../design-system/Modal";
import type { BracketConfig, Tourney } from "../../ipc/bindings";
import type { MessageKey } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";
import { bracketConfigOf, configIsSubmittable, roundsFor } from "../../shared/tourneyRules";
import { NumberInput } from "../../design-system/NumberInput";

/** The series lengths the service accepts. Anything else it silently makes 3. */
const BEST_OF = [1, 3, 5, 7];

interface BracketSetupDialogProps {
  event: Tourney;
  busy: boolean;
  onStart: (config: BracketConfig) => void;
  onClose: () => void;
}

export function BracketSetupDialog({ event, busy, onStart, onClose }: BracketSetupDialogProps) {
  const { t } = useTranslation();
  const [config, setConfig] = useState<BracketConfig>(() => bracketConfigOf(event));
  const teams = event.teams.length;
  const rounds = roundsFor(Math.max(teams, 2));

  const boSelect = (value: number, onPick: (bo: number) => void, label: string) => (
    <label className="tournament-field tournament-bo">
      <span>{label}</span>
      <select value={value} disabled={busy} onChange={(changed) => onPick(Number(changed.target.value))}>
        {BEST_OF.map((bo) => (
          <option key={bo} value={bo}>
            {t("tournaments.setup.bestOf", { count: String(bo) })}
          </option>
        ))}
      </select>
    </label>
  );

  /** "Final", "Semifinals", "Quarterfinals", then plain numbers, as the bracket says it. */
  const eliminationLabel = (round: number, last: number): string => {
    if (round === last) return t("tournaments.pools.roundFinal");
    if (round === last - 1) return t("tournaments.pools.roundSemi");
    if (round === last - 2) return t("tournaments.pools.roundQuarter");
    return t("tournaments.bracket.round", { round });
  };

  const body = () => {
    switch (config.type) {
      case "freeForAll":
        // Drawn from the event's own free-for-all configuration; there is
        // nothing per round to decide.
        return <p className="muted">{t("tournaments.setup.ffa")}</p>;

      case "single":
        return (
          <>
            <p className="muted">
              {t("tournaments.setup.single", { teams: String(teams), rounds: String(rounds) })}
            </p>
            {config.payload.rounds.map((bo, index) =>
              boSelect(
                bo,
                (picked) =>
                  setConfig({
                    type: "single",
                    payload: {
                      rounds: config.payload.rounds.map((held, other) =>
                        other === index ? picked : held,
                      ),
                    },
                  }),
                eliminationLabel(index + 1, config.payload.rounds.length),
              ),
            )}
          </>
        );

      case "double": {
        const { wb, lb, gf, lbHandicap } = config.payload;
        const set = (patch: Partial<typeof config.payload>) =>
          setConfig({ type: "double", payload: { ...config.payload, ...patch } });
        return (
          <>
            <p className="muted">
              {t("tournaments.setup.double", {
                teams: String(teams),
                winners: String(wb.length),
                losers: String(lb.length),
              })}
            </p>
            <h5>{t("tournaments.setup.winners")}</h5>
            {wb.map((bo, index) =>
              boSelect(
                bo,
                (picked) => set({ wb: wb.map((held, other) => (other === index ? picked : held)) }),
                eliminationLabel(index + 1, wb.length),
              ),
            )}
            <h5>{t("tournaments.setup.losers")}</h5>
            {lb.map((bo, index) =>
              boSelect(
                bo,
                (picked) => set({ lb: lb.map((held, other) => (other === index ? picked : held)) }),
                index + 1 === lb.length
                  ? t("tournaments.pools.roundLosersFinal")
                  : t("tournaments.bracket.round", { round: index + 1 }),
              ),
            )}
            {boSelect(gf, (picked) => set({ gf: picked }), t("tournaments.pools.roundGrandFinal"))}
            <label className="tournament-checkbox">
              <input
                type="checkbox"
                checked={lbHandicap}
                disabled={busy}
                onChange={(changed) => set({ lbHandicap: changed.target.checked })}
              />
              <span>{t("tournaments.setup.handicap")}</span>
            </label>
          </>
        );
      }

      case "swiss": {
        const { rounds: count, bestOf, finalMatch, finalBestOf, fast } = config.payload;
        const set = (patch: Partial<typeof config.payload>) =>
          setConfig({ type: "swiss", payload: { ...config.payload, ...patch } });
        return (
          <>
            <p className="muted">{t("tournaments.setup.swiss", { teams: String(teams) })}</p>
            <label className="tournament-field">
              <span>{t("tournaments.setup.rounds")}</span>
              <NumberInput
                min={1}
                max={15}
                value={count}
                disabled={busy}
                onChange={(rounds) => set({ rounds })}
              />
            </label>
            <label className="tournament-field">
              <span>{t("tournaments.setup.eachMatch")}</span>
              {/* Swiss takes Bo1 or Bo3 and nothing else. */}
              <select
                value={bestOf}
                disabled={busy}
                onChange={(changed) => set({ bestOf: Number(changed.target.value) })}
              >
                <option value={1}>{t("tournaments.setup.bestOf", { count: "1" })}</option>
                <option value={3}>{t("tournaments.setup.bestOf", { count: "3" })}</option>
              </select>
            </label>
            <label className="tournament-checkbox">
              <input
                type="checkbox"
                checked={finalMatch}
                disabled={busy}
                onChange={(changed) => set({ finalMatch: changed.target.checked })}
              />
              <span>{t("tournaments.setup.swissFinal")}</span>
            </label>
            {finalMatch &&
              boSelect(
                finalBestOf,
                (picked) => set({ finalBestOf: picked }),
                t("tournaments.pools.roundFinal"),
              )}
            <label className="tournament-checkbox">
              <input
                type="checkbox"
                checked={fast}
                disabled={busy}
                onChange={(changed) => set({ fast: changed.target.checked })}
              />
              <span>{t("tournaments.setup.fast")}</span>
            </label>
          </>
        );
      }
    }
  };

  const title: MessageKey =
    config.type === "swiss" ? "tournaments.setup.titleSwiss" : "tournaments.setup.title";

  return (
    <Modal onClose={onClose} className="tournament-form" ariaLabel={t(title)}>
      <h3>{t(title)}</h3>
      {body()}
      <div className="tournament-form-actions">
        <Button onClick={onClose} disabled={busy}>
          {t("common.cancel")}
        </Button>
        <Button
          variant="primary"
          disabled={busy || !configIsSubmittable(config, teams)}
          onClick={() => onStart(config)}
        >
          {t("tournaments.setup.generate")}
        </Button>
      </div>
    </Modal>
  );
}
