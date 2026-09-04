// Changing the shape of the competition after the event was created.
//
// Two locks, one step apart, and the panel has to show which one is holding.
// The **team setup** (competition, team size, formation, draft order) closes
// when signups do: those four decide what a team *is*, and everything already
// built out of teams would have to be thrown away. The **bracket type** stays
// open right up to the draw.
//
// Not here: the best-of plan per round, the seeding policy and the entrant cap.
// The plan is a dozen numbers whose meaning changes with the bracket type; the
// other two are absent for a harder reason, which is that the client never
// reads either off the event. Sending a guess would overwrite them, because the
// service reads a present key as an instruction.

import { useState } from "react";
import { Button } from "../../design-system/Button";
import type { BracketKind, Competition, Formation, FormatDraft, Tourney } from "../../ipc/bindings";
import type { MessageKey } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";
import { isStructural, mayEditTeamSetup } from "../../shared/tourneyRules";
import { NumberInput } from "../../design-system/NumberInput";

interface FormatPanelProps {
  event: Tourney;
  busy: boolean;
  onSave: (format: FormatDraft) => void;
}

function currentOf(event: Tourney): FormatDraft {
  return {
    competition: event.competition,
    teamSize: event.teamSize,
    formation: event.formation,
    bracketKind: event.bracketKind,
    draftSnakes: event.draftSnakes,
  };
}

export function FormatPanel({ event, busy, onSave }: FormatPanelProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<FormatDraft>(() => currentOf(event));
  const setup = mayEditTeamSetup(event);
  const structural = isStructural(draft, event);
  // The one combination the panel must not offer: a structural change once
  // signups have closed. The service refuses it, and the refusal names a step
  // ("Reopen signups") rather than the field that caused it.
  const blocked = structural && !setup;

  const change = (patch: Partial<FormatDraft>) => setDraft((held) => ({ ...held, ...patch }));

  return (
    <form
      className="tournament-format"
      onSubmit={(submitted) => {
        submitted.preventDefault();
        if (blocked) return;
        onSave(draft);
      }}
    >
      <p className="muted">
        {setup ? t("tournaments.format.hint") : t("tournaments.format.hintLocked")}
      </p>

      <div className="tournament-format-fields">
        <label className="tournament-field">
          <span>{t("tournaments.format.competition")}</span>
          <select
            value={draft.competition}
            disabled={busy || !setup}
            onChange={(changed) => change({ competition: changed.target.value as Competition })}
          >
            <option value="team">{t("tournaments.competition.team")}</option>
            <option value="freeForAll">{t("tournaments.competition.freeForAll")}</option>
          </select>
        </label>

        <label className="tournament-field">
          <span>{t("tournaments.format.teamSize")}</span>
          {/* The service clamps to 1..6 for a team event and 1..3 for a
              free-for-all, so the input says the same rather than accepting a
              number that comes back changed. */}
          <NumberInput
            min={1}
            max={draft.competition === "freeForAll" ? 3 : 6}
            value={draft.teamSize}
            disabled={busy || !setup}
            onChange={(teamSize) => change({ teamSize })}
          />
        </label>

        <label className="tournament-field">
          <span>{t("tournaments.format.formation")}</span>
          {/* A team of one is solo whatever is chosen, and the service says so
              by writing it back; the field is not offered there at all. */}
          <select
            value={draft.formation}
            disabled={busy || !setup || draft.teamSize === 1 || draft.competition === "freeForAll"}
            onChange={(changed) => change({ formation: changed.target.value as Formation })}
          >
            <option value="open">{t("tournaments.formation.open")}</option>
            <option value="draft">{t("tournaments.formation.draft")}</option>
          </select>
        </label>

        {draft.formation === "draft" && (
          <label className="tournament-checkbox">
            <input
              type="checkbox"
              checked={draft.draftSnakes}
              disabled={busy || !setup}
              onChange={(changed) => change({ draftSnakes: changed.target.checked })}
            />
            <span>{t("tournaments.format.snake")}</span>
          </label>
        )}

        <label className="tournament-field">
          <span>{t("tournaments.format.bracket")}</span>
          <select
            value={draft.bracketKind}
            disabled={busy || draft.competition === "freeForAll"}
            onChange={(changed) => change({ bracketKind: changed.target.value as BracketKind })}
          >
            {(["single", "double", "swiss"] as const).map((kind) => (
              <option key={kind} value={kind}>
                {t(`tournaments.bracketKind.${kind}` as MessageKey)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {blocked && <p className="tournament-refusal">{t("tournaments.format.reopenFirst")}</p>}

      <div className="tournament-detail-actions">
        <Button type="submit" variant="primary" disabled={busy || blocked}>
          {t("tournaments.format.save")}
        </Button>
        <Button type="button" disabled={busy} onClick={() => setDraft(currentOf(event))}>
          {t("tournaments.format.reset")}
        </Button>
      </div>
    </form>
  );
}
