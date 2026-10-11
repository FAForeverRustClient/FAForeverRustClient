// The format fields beyond the bracket type, shared by the create form and the
// Format panel: a Swiss stage's record cuts and playoffs, seeds choosing their
// opponent, how equal records are ordered, a free-for-all's lobbies, and ending
// early. Each is the website's own block, with its words.

import type { FfaConfig, PickMode, PickSettings, SwissExtras, SwissTiebreak } from "../../../ipc/bindings";
import { useTranslation } from "../../../i18n/useTranslation";
import { NumberInput } from "../../../design-system/NumberInput";

const BEST_OF = [1, 3, 5, 7];

/** The playoffs a Swiss starts with when they are switched on. */
export const DEFAULT_STAGE_TWO = {
  double: false,
  cutTo: 8,
  bestOf: 3,
  finalBestOf: 5,
  grandFinal: 5,
  handicap: false,
  thirdPlace: false,
};

/** A free-for-all's defaults: the website's form, as it opens. */
export function defaultFfa(teamSize: number): FfaConfig {
  const most = Math.max(2, Math.floor(16 / Math.max(1, teamSize)));
  return { perMatch: Math.min(6, most), advance: 1, mode: "points", rounds: 3, cutTo: 0, finalSize: 0 };
}

/** Rounds a team can last under the cuts: the website's `swissCutRounds`. */
export function cutRounds(wins: number, losses: number): number {
  if (wins > 0 && losses > 0) return wins + losses - 1;
  return Math.max(wins, losses);
}

interface SwissExtrasFieldsProps {
  value: SwissExtras;
  busy: boolean;
  onChange: (value: SwissExtras) => void;
}

/** Record cuts and the second stage of a Swiss event. */
export function SwissExtrasFields({ value, busy, onChange }: SwissExtrasFieldsProps) {
  const { t } = useTranslation();
  const cutsOn = value.cuts.wins > 0 || value.cuts.losses > 0;
  const stage = value.stageTwo;
  const set = (patch: Partial<SwissExtras>) => onChange({ ...value, ...patch });
  const most = Math.max(value.cuts.wins, value.cuts.losses);
  return (
    <div className="tournament-format-extras">
      <label className="tournament-checkbox">
        <input
          type="checkbox"
          checked={cutsOn}
          disabled={busy}
          onChange={(changed) =>
            set(
              changed.target.checked
                ? { cuts: { wins: 3, losses: 3 }, decidingBestOf: 3 }
                : { cuts: { wins: 0, losses: 0 }, decidingBestOf: 0 },
            )
          }
        />
        <span>{t("tournaments.extras.cuts")}</span>
      </label>
      {cutsOn && (
        <div className="tournament-format-box">
          <p className="muted">{t("tournaments.extras.cutsHint")}</p>
          <div className="tournament-form-row">
            <label className="tournament-field">
              <span>{t("tournaments.extras.winCut")}</span>
              <NumberInput
                min={0}
                max={15}
                value={value.cuts.wins}
                disabled={busy}
                onChange={(wins) => set({ cuts: { ...value.cuts, wins } })}
              />
            </label>
            <label className="tournament-field">
              <span>{t("tournaments.extras.lossCut")}</span>
              <NumberInput
                min={0}
                max={15}
                value={value.cuts.losses}
                disabled={busy}
                onChange={(losses) => set({ cuts: { ...value.cuts, losses } })}
              />
            </label>
            <label className="tournament-field">
              <span>{t("tournaments.extras.deciding")}</span>
              <select
                value={value.decidingBestOf}
                disabled={busy}
                onChange={(changed) => set({ decidingBestOf: Number(changed.target.value) })}
              >
                <option value={0}>{t("tournaments.extras.decidingSame")}</option>
                {BEST_OF.map((bo) => (
                  <option key={bo} value={bo}>{`Bo${bo}`}</option>
                ))}
              </select>
            </label>
          </div>
          <p className="muted">{t("tournaments.extras.decidingHint")}</p>
          <p className="muted">
            {t("tournaments.extras.longest", { count: cutRounds(value.cuts.wins, value.cuts.losses) })}{" "}
            {t("tournaments.extras.cleanFrom", { teams: 2 ** (most + 1) })}
          </p>
        </div>
      )}
      <label className="tournament-checkbox">
        <input
          type="checkbox"
          checked={stage !== null}
          disabled={busy}
          onChange={(changed) => set({ stageTwo: changed.target.checked ? { ...DEFAULT_STAGE_TWO } : null })}
        />
        <span>{t("tournaments.extras.stageTwo")}</span>
      </label>
      {stage !== null && (
        <div className="tournament-format-box">
          <p className="muted">{t("tournaments.extras.stageTwoHint")}</p>
          <div className="tournament-form-row">
            <label className="tournament-field">
              <span>{t("tournaments.extras.through")}</span>
              <NumberInput
                min={2}
                max={64}
                value={stage.cutTo}
                disabled={busy}
                onChange={(cutTo) => set({ stageTwo: { ...stage, cutTo } })}
              />
            </label>
            <label className="tournament-field">
              <span>{t("tournaments.extras.bracket")}</span>
              <select
                value={stage.double ? "double" : "single"}
                disabled={busy}
                onChange={(changed) => set({ stageTwo: { ...stage, double: changed.target.value === "double" } })}
              >
                <option value="single">{t("tournaments.bracketKind.single")}</option>
                <option value="double">{t("tournaments.bracketKind.double")}</option>
              </select>
            </label>
            <label className="tournament-field">
              <span>{t("tournaments.extras.playoffMatches")}</span>
              <select
                value={stage.bestOf}
                disabled={busy}
                onChange={(changed) => set({ stageTwo: { ...stage, bestOf: Number(changed.target.value) } })}
              >
                {BEST_OF.map((bo) => (
                  <option key={bo} value={bo}>{`Bo${bo}`}</option>
                ))}
              </select>
            </label>
            <label className="tournament-field">
              <span>{t("tournaments.extras.playoffFinal")}</span>
              <select
                value={stage.finalBestOf}
                disabled={busy}
                onChange={(changed) =>
                  set({ stageTwo: { ...stage, finalBestOf: Number(changed.target.value), grandFinal: Number(changed.target.value) } })
                }
              >
                {BEST_OF.map((bo) => (
                  <option key={bo} value={bo}>{`Bo${bo}`}</option>
                ))}
              </select>
            </label>
          </div>
          {!stage.double && (
            <label className="tournament-checkbox">
              <input
                type="checkbox"
                checked={stage.thirdPlace}
                disabled={busy}
                onChange={(changed) => set({ stageTwo: { ...stage, thirdPlace: changed.target.checked } })}
              />
              <span>{t("tournaments.playoffs.third")}</span>
            </label>
          )}
          <p className="muted">{t("tournaments.extras.finalReplaced")}</p>
        </div>
      )}
    </div>
  );
}

interface PickFieldsProps {
  picks: PickSettings;
  tiebreak: SwissTiebreak;
  /** Swiss, with a playoff stage: who picks is a choice then. */
  swiss: boolean;
  stageTwo: boolean;
  cuts: { wins: number; losses: number };
  busy: boolean;
  onChange: (picks: PickSettings, tiebreak: SwissTiebreak) => void;
}

/** Seeds choosing their opponent, and a Swiss stage's tiebreak. */
export function PickFields({ picks, tiebreak, swiss, stageTwo, cuts, busy, onChange }: PickFieldsProps) {
  const { t } = useTranslation();
  const record = cuts.wins > 0 ? `${cuts.wins}-0` : t("tournaments.playoffs.noLosses");
  const lowest =
    cuts.wins > 0 && cuts.losses > 0 ? `${cuts.wins}-${cuts.losses - 1}` : t("tournaments.playoffs.lowestThrough");
  const bottom = picks.on && swiss && stageTwo && picks.mode === "bottom";
  const where = !swiss
    ? "tournaments.extras.pickWhereBracket"
    : stageTwo
      ? "tournaments.extras.pickWherePlayoffs"
      : "tournaments.extras.pickWhereNothing";
  const what =
    swiss && stageTwo && picks.mode === "bottom"
      ? t("tournaments.extras.pickWhatBottom", { lowest })
      : swiss && stageTwo && picks.mode === "unbeaten"
        ? t("tournaments.extras.pickWhatUnbeaten")
        : t("tournaments.extras.pickWhatHalf");
  return (
    <div className="tournament-format-extras">
      {swiss && (
        <label className="tournament-field">
          <span>{t("tournaments.playoffs.tiebreak")}</span>
          <select
            value={bottom ? "beaten" : tiebreak}
            disabled={busy || bottom}
            onChange={(changed) => onChange(picks, changed.target.value as SwissTiebreak)}
          >
            <option value="gameDiff">{t("tournaments.playoffs.tiebreakGdOption")}</option>
            <option value="beaten">{t("tournaments.playoffs.tiebreakBeatenOption")}</option>
          </select>
          <small className="muted">{t("tournaments.extras.tiebreakHint")}</small>
        </label>
      )}
      <label className="tournament-checkbox">
        <input
          type="checkbox"
          checked={picks.on}
          disabled={busy}
          onChange={(changed) => onChange({ ...picks, on: changed.target.checked }, tiebreak)}
        />
        <span>{t("tournaments.extras.pickOn")}</span>
      </label>
      {picks.on && (
        <div className="tournament-format-box">
          <p className="muted">{t(where)}</p>
          {swiss && stageTwo && (
            <label className="tournament-field">
              <span>{t("tournaments.extras.whoPicks")}</span>
              <select
                value={picks.mode}
                disabled={busy}
                onChange={(changed) => {
                  const mode = changed.target.value as PickMode;
                  onChange({ ...picks, mode }, mode === "bottom" ? "beaten" : tiebreak);
                }}
              >
                <option value="half">{t("tournaments.extras.pickHalf")}</option>
                <option value="unbeaten">{t("tournaments.extras.pickUnbeaten", { record })}</option>
                <option value="bottom">{t("tournaments.extras.pickBottom", { record, lowest })}</option>
              </select>
            </label>
          )}
          <p className="muted">{what}</p>
          <label className="tournament-field">
            <span>{t("tournaments.playoffs.minutes")}</span>
            <NumberInput
              min={0}
              max={1440}
              value={picks.minutes}
              disabled={busy}
              onChange={(minutes) => onChange({ ...picks, minutes }, tiebreak)}
            />
            <small className="muted">{t("tournaments.extras.minutesHint")}</small>
          </label>
        </div>
      )}
    </div>
  );
}

interface FfaFieldsProps {
  value: FfaConfig;
  teamSize: number;
  busy: boolean;
  onChange: (value: FfaConfig) => void;
}

/** A free-for-all's lobbies and rounds: the website's FFA block. */
export function FfaFields({ value, teamSize, busy, onChange }: FfaFieldsProps) {
  const { t } = useTranslation();
  const set = (patch: Partial<FfaConfig>) => onChange({ ...value, ...patch });
  const most = Math.max(2, Math.floor(16 / Math.max(1, teamSize)));
  const lobbySizes = Array.from({ length: most - 1 }, (_, index) => index + 2);
  return (
    <div className="tournament-format-extras">
      <label className="tournament-field">
        <span>{t(teamSize > 1 ? "tournaments.ffa.teamsPerLobby" : "tournaments.ffa.playersPerLobby")}</span>
        <select
          value={Math.min(value.perMatch, most)}
          disabled={busy}
          onChange={(changed) => set({ perMatch: Number(changed.target.value) })}
        >
          {lobbySizes.map((size) => (
            <option key={size} value={size}>
              {teamSize > 1 ? t("tournaments.ffa.teamsOption", { count: size, players: size * teamSize }) : size}
            </option>
          ))}
        </select>
      </label>
      <label className="tournament-field">
        <span>{t("tournaments.ffa.mode")}</span>
        <select
          value={value.mode}
          disabled={busy}
          onChange={(changed) => set({ mode: changed.target.value as FfaConfig["mode"] })}
        >
          <option value="points">{t("tournaments.ffa.modePoints")}</option>
          <option value="elimination">{t("tournaments.ffa.modeKnockout")}</option>
        </select>
      </label>
      {value.mode === "points" ? (
        <>
          <label className="tournament-field">
            <span>{t("tournaments.ffa.rounds")}</span>
            <NumberInput min={1} max={10} value={value.rounds} disabled={busy} onChange={(rounds) => set({ rounds })} />
          </label>
          <div className="tournament-form-row">
            <label className="tournament-field">
              <span>{t("tournaments.ffa.afterEach")}</span>
              <select
                value={value.cutTo > 0 ? "cut" : "all"}
                disabled={busy}
                onChange={(changed) => set({ cutTo: changed.target.value === "cut" ? 8 : 0 })}
              >
                <option value="all">{t("tournaments.ffa.everyoneContinues")}</option>
                <option value="cut">{t("tournaments.ffa.cutToTop")}</option>
              </select>
            </label>
            {value.cutTo > 0 && (
              <label className="tournament-field">
                <span>{t("tournaments.ffa.cutTo")}</span>
                <NumberInput min={2} max={64} value={value.cutTo} disabled={busy} onChange={(cutTo) => set({ cutTo })} />
              </label>
            )}
          </div>
          <div className="tournament-form-row">
            <label className="tournament-field">
              <span>{t("tournaments.ffa.afterLast")}</span>
              <select
                value={value.finalSize > 0 ? "final" : "points"}
                disabled={busy}
                onChange={(changed) => set({ finalSize: changed.target.value === "final" ? 4 : 0 })}
              >
                <option value="points">{t("tournaments.ffa.highestWins")}</option>
                <option value="final">{t("tournaments.ffa.finalLobby")}</option>
              </select>
            </label>
            {value.finalSize > 0 && (
              <label className="tournament-field">
                <span>{t("tournaments.ffa.finalSize")}</span>
                <NumberInput min={2} max={16} value={value.finalSize} disabled={busy} onChange={(finalSize) => set({ finalSize })} />
              </label>
            )}
          </div>
        </>
      ) : (
        <label className="tournament-field">
          <span>{t("tournaments.ffa.advancing")}</span>
          <select
            value={value.advance}
            disabled={busy}
            onChange={(changed) => set({ advance: Number(changed.target.value) })}
          >
            <option value={1}>{t("tournaments.ffa.winnerOnly")}</option>
            {[2, 3, 4].map((count) => (
              <option key={count} value={count}>
                {t("tournaments.ffa.topN", { count })}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

/** Ending once a set number are left: for a qualifier. */
export function StopAtField({ value, busy, onChange }: { value: number; busy: boolean; onChange: (value: number) => void }) {
  const { t } = useTranslation();
  return (
    <div className="tournament-format-extras">
      <label className="tournament-checkbox">
        <input
          type="checkbox"
          checked={value > 0}
          disabled={busy}
          onChange={(changed) => onChange(changed.target.checked ? 4 : 0)}
        />
        <span>{t("tournaments.extras.stopOn")}</span>
      </label>
      {value > 0 && (
        <div className="tournament-format-box">
          <p className="muted">{t("tournaments.extras.stopHint")}</p>
          <label className="tournament-field">
            <span>{t("tournaments.extras.stopAt")}</span>
            <NumberInput min={2} max={128} value={value} disabled={busy} onChange={onChange} />
            <small className="muted">{t("tournaments.extras.stopShown")}</small>
          </label>
        </div>
      )}
    </div>
  );
}
