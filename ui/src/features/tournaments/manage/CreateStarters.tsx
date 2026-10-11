// The two ways the website's create form starts from something: a named
// format preset, and "Copy from an existing tournament".
//
// A preset is a bundle of settings the form already has fields for, so
// choosing one fills them and nothing more; every field stays editable. The
// service checks who may host it and records its name, which is all `presetId`
// is for. Copying fills everything except the dates, which is how the next
// edition of a series is usually made; the maps follow separately, from the
// Maps step of Manage.

import { useEffect, useState } from "react";
import { Button } from "../../../design-system/Button";
import type { CopySource, Tourney, TourneyDraft, TourneyLoadStatus, TourneyPreset } from "../../../ipc/bindings";
import { useTranslation } from "../../../i18n/useTranslation";
import { plainError } from "../../../shared/plainError";
import { draftOf } from "./TournamentForm";

/**
 * A draft filled from another event: everything but its dates, which belong
 * to that edition. The rating date is a date too, and is left out, although
 * the website's copy takes it while saying it does not.
 */
export function templateDraft(event: Tourney): TourneyDraft {
  return {
    ...draftOf(event),
    maxTeams: event.maxTeams,
    presetId: null,
    eventDate: null,
    eventDays: [],
    signupOpensAt: null,
    signupClosesAt: null,
    checkInDeadline: null,
    ratingDate: null,
  };
}

/** A draft with a preset's settings laid over it, as the website's `applyPreset`. */
export function presetDraft(draft: TourneyDraft, preset: TourneyPreset): TourneyDraft {
  const apply = preset.apply;
  if (apply === null || apply === undefined) return draft;
  return {
    ...draft,
    presetId: preset.id,
    // An official-only preset picks the category, and the service would
    // force it anyway.
    category: "official",
    competition: apply.competition,
    teamSize: apply.teamSize,
    formation: apply.formation,
    bracketKind: apply.bracketKind,
    seeding: apply.seeding,
    ratingKind: apply.ratingKind,
    maxTeams: apply.maxTeams,
    signupMode: apply.signupMode,
    playerReporting: apply.playerReporting,
    plan: apply.plan,
    swiss: { cuts: apply.swissCuts, decidingBestOf: apply.decidingBestOf, stageTwo: apply.stageTwoPlan },
    picks: { on: apply.pickOpponents, minutes: apply.pickMinutes, mode: apply.pickMode },
    tiebreak: apply.swissTiebreak,
  };
}

interface CreateStartersProps {
  draft: TourneyDraft;
  presets: TourneyPreset[];
  sources: CopySource[];
  template: Tourney | null;
  templateStatus: TourneyLoadStatus;
  busy: boolean;
  onLoadTemplate: (tournamentId: string) => void;
  onChange: (draft: TourneyDraft) => void;
}

export function CreateStarters(props: CreateStartersProps) {
  const { t } = useTranslation();
  const [source, setSource] = useState("");
  /** The template asked for, so an answer is used once and only for it. */
  const [asked, setAsked] = useState<string | null>(null);
  const [filledFrom, setFilledFrom] = useState<string | null>(null);
  const preset = props.presets.find((held) => held.id === props.draft.presetId) ?? null;
  const [chosen, setChosen] = useState<TourneyPreset | null>(null);

  const { template, templateStatus, onChange, draft } = props;
  useEffect(() => {
    if (asked === null || template === null || template.id !== asked || templateStatus.type !== "ready") return;
    onChange(templateDraft(template));
    setFilledFrom(template.name);
    setAsked(null);
    setChosen(null);
  }, [asked, template, templateStatus, onChange, draft]);

  return (
    <>
      {props.sources.length > 0 && (
        <fieldset className="tournament-field">
          <legend>{t("tournaments.create.copyLegend")}</legend>
          <small className="muted">{t("tournaments.create.copyHint")}</small>
          <div className="tournament-detail-actions">
            <select value={source} onChange={(changed) => setSource(changed.target.value)}>
              <option value="">{t("tournaments.create.startBlank")}</option>
              {props.sources.map((held) => (
                <option key={held.id} value={held.id}>
                  {held.name}
                </option>
              ))}
            </select>
            <Button
              type="button"
              disabled={props.busy || source === "" || templateStatus.type === "loading"}
              onClick={() => {
                setAsked(source);
                props.onLoadTemplate(source);
              }}
            >
              {t("tournaments.create.fill")}
            </Button>
          </div>
          {/* Plainly, with the service's own words on hover; Fill, just
              above, is the way to ask again. */}
          {templateStatus.type === "failed" && asked !== null && (
            <p className="tournament-refusal" title={templateStatus.payload.reason}>
              {plainError(templateStatus.payload.reason)}
            </p>
          )}
          {filledFrom !== null && <p className="muted">{t("tournaments.create.filled", { name: filledFrom })}</p>}
        </fieldset>
      )}

      {props.presets.length > 0 && (
        <fieldset className="tournament-field">
          <legend>
            {t("tournaments.create.presetLegend")} <span className="muted">{t("tournaments.maps.optional")}</span>
          </legend>
          <select
            value={chosen?.id ?? preset?.id ?? ""}
            onChange={(changed) => {
              const picked = props.presets.find((held) => held.id === changed.target.value) ?? null;
              setChosen(picked);
              if (picked === null) onChange({ ...draft, presetId: null });
              else if (picked.allowed) onChange(presetDraft(draft, picked));
            }}
          >
            <option value="">{t("tournaments.create.presetNone")}</option>
            {props.presets.map((held) => (
              <option key={held.id} value={held.id} disabled={!held.allowed}>
                {held.allowed ? held.name : t("tournaments.create.presetRestrictedOption", { name: held.name })}
              </option>
            ))}
          </select>
          {chosen !== null && !chosen.allowed && (
            <p className="muted">{t("tournaments.create.presetRestricted", { name: chosen.name })}</p>
          )}
          {chosen !== null && chosen.allowed && (
            <div className="tournament-format-box">
              <strong>{chosen.name}</strong>
              <p>{chosen.blurb}</p>
              {chosen.notes.length > 0 && (
                <ul className="muted">
                  {chosen.notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              )}
              <small className="muted">{t("tournaments.create.presetEditable")}</small>
            </div>
          )}
        </fieldset>
      )}
    </>
  );
}
