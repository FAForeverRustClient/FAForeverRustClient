// How long the matches are, per bracket type.
//
// Three shapes, because the brackets genuinely differ: a single elimination has
// early rounds, a semifinal and a final; a double has two brackets and a grand
// final; Swiss has one length for every round and an optional final. The service
// stores exactly one of the three under `plan`, so switching bracket type swaps
// the whole object rather than editing it.
//
// The defaults come from `defaultPlanFor`, a twin of `MatchPlan::default_for`
// pinned by the conformance harness: the form has to open on what the service
// would have done anyway, or an organiser who never touches these selects gets
// something other than what they saw.

import type { MatchPlan } from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";

/** The lengths the service accepts. Anything else it silently turns into 3. */
const BEST_OF = [1, 3, 5, 7];

interface PlanFieldsProps {
  plan: MatchPlan;
  onChange: (plan: MatchPlan) => void;
}

export function PlanFields({ plan, onChange }: PlanFieldsProps) {
  const { t } = useTranslation();

  const select = (
    label: string,
    value: number,
    onPick: (best: number) => void,
    choices: number[] = BEST_OF,
  ) => (
    <label className="tournament-field" key={label}>
      <span>{label}</span>
      <select value={value} onChange={(changed) => onPick(Number(changed.target.value))}>
        {choices.map((best) => (
          <option value={best} key={best}>
            {`Bo${best}`}
          </option>
        ))}
      </select>
    </label>
  );

  if (plan.type === "single") {
    const held = plan.payload;
    return (
      <div className="tournament-form-row">
        {select(t("tournaments.form.planEarly"), held.early, (early) =>
          onChange({ type: "single", payload: { ...held, early } }),
        )}
        {select(t("tournaments.form.planSemi"), held.semi, (semi) =>
          onChange({ type: "single", payload: { ...held, semi } }),
        )}
        {select(t("tournaments.form.planFinal"), held.finalBo, (finalBo) =>
          onChange({ type: "single", payload: { ...held, finalBo } }),
        )}
      </div>
    );
  }

  if (plan.type === "double") {
    const held = plan.payload;
    return (
      <>
        <div className="tournament-form-row">
          {select(t("tournaments.form.planWb"), held.wb, (wb) =>
            onChange({ type: "double", payload: { ...held, wb } }),
          )}
          {select(t("tournaments.form.planWbFinal"), held.wbFinal, (wbFinal) =>
            onChange({ type: "double", payload: { ...held, wbFinal } }),
          )}
        </div>
        <div className="tournament-form-row">
          {select(t("tournaments.form.planLb"), held.lb, (lb) =>
            onChange({ type: "double", payload: { ...held, lb } }),
          )}
          {select(t("tournaments.form.planLbFinal"), held.lbFinal, (lbFinal) =>
            onChange({ type: "double", payload: { ...held, lbFinal } }),
          )}
        </div>
        <div className="tournament-form-row">
          {select(t("tournaments.form.planGf"), held.gf, (gf) =>
            onChange({ type: "double", payload: { ...held, gf } }),
          )}
        </div>
        <label className="tournament-check">
          <input
            type="checkbox"
            checked={held.lbHandicap}
            onChange={(changed) =>
              onChange({ type: "double", payload: { ...held, lbHandicap: changed.target.checked } })
            }
          />
          <span>{t("tournaments.form.planHandicap")}</span>
        </label>
      </>
    );
  }

  const held = plan.payload;
  return (
    <>
      <div className="tournament-form-row">
        {/* An ordinary Swiss round takes only Bo1 or Bo3: the service refuses
            anything else here, unlike everywhere above. */}
        {select(
          t("tournaments.form.planSwissEach"),
          held.bestOf,
          (bestOf) => onChange({ type: "swiss", payload: { ...held, bestOf } }),
          [1, 3],
        )}
        {select(t("tournaments.form.planFinal"), held.finalBestOf, (finalBestOf) =>
          onChange({ type: "swiss", payload: { ...held, finalBestOf } }),
        )}
      </div>
      <label className="tournament-check">
        <input
          type="checkbox"
          checked={held.finalMatch}
          onChange={(changed) =>
            onChange({ type: "swiss", payload: { ...held, finalMatch: changed.target.checked } })
          }
        />
        <span>{t("tournaments.form.planSwissFinal")}</span>
      </label>
      <label className="tournament-check">
        <input
          type="checkbox"
          checked={held.fast}
          onChange={(changed) =>
            onChange({ type: "swiss", payload: { ...held, fast: changed.target.checked } })
          }
        />
        <span>{t("tournaments.form.planSwissFast")}</span>
      </label>
    </>
  );
}
