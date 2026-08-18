// Creating an event, and changing one.
//
// One form for both, because they ask almost the same questions. The
// difference is which answers the server will still take: once a tournament
// exists, its format, team size and category are welded to a bracket that may
// already have been drawn, so those controls are shown as facts rather than as
// inputs. Sending them would send them nowhere.
//
// The best-of plan, the veto configuration and the map database are absent on
// purpose. The server defaults all three, and asking an organiser for six
// best-of numbers before their event has a single entrant is the wrong first
// question. They are edited on the website, from Manage.

import { useState } from "react";
import { Button } from "../../design-system/Button";
import { Modal } from "../../design-system/Modal";
import type { Tourney, TourneyDraft } from "../../ipc/bindings";
import type { MessageKey } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";
import { rejectionOf, type DraftRejection } from "../../shared/tourneyRules";

const REJECTION_LABELS: Record<DraftRejection, MessageKey> = {
  nameRequired: "tournaments.form.nameRequired",
  teamSizeOutOfRange: "tournaments.form.teamSizeOutOfRange",
  ratingRangeInverted: "tournaments.form.ratingRangeInverted",
  ratingGateWithoutRating: "tournaments.form.ratingGateWithoutRating",
  signupWindowInverted: "tournaments.form.signupWindowInverted",
};

/** A `datetime-local` value as Unix seconds, or null when the field is empty. */
function secondsOf(value: string): number | null {
  if (value === "") return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : Math.floor(parsed / 1000);
}

/** Unix seconds as a `datetime-local` value, in the reader's own zone. */
function localValue(seconds: number | null): string {
  if (seconds === null) return "";
  const moment = new Date(seconds * 1000);
  const pad = (part: number) => String(part).padStart(2, "0");
  return (
    `${moment.getFullYear()}-${pad(moment.getMonth() + 1)}-${pad(moment.getDate())}` +
    `T${pad(moment.getHours())}:${pad(moment.getMinutes())}`
  );
}

/** The draft an existing event would produce, for the edit case. */
export function draftOf(event: Tourney): TourneyDraft {
  return {
    name: event.name,
    description: event.description,
    category: event.category,
    competition: event.competition,
    teamSize: event.teamSize,
    formation: event.formation,
    bracketKind: event.bracketKind,
    // Read off the event, not assumed. `edit_info` sends `signupMode`, so a
    // hardcoded "open" here reopened an invite-only event to everyone the
    // first time its organiser corrected a typo in the name.
    seeding: "rating",
    ratingKind: event.ratingKind,
    signupMode: event.signupMode,
    eventDate: event.eventDate,
    signupOpensAt: event.signupOpensAt,
    signupClosesAt: event.signupClosesAt,
    ratingDate: event.ratingDate,
    rating: event.rating,
    maxTeams: 0,
  };
}

const BLANK: TourneyDraft = {
  name: "",
  description: "",
  category: "community",
  competition: "team",
  teamSize: 2,
  formation: "open",
  bracketKind: "single",
  seeding: "rating",
  ratingKind: "global",
  signupMode: "open",
  eventDate: null,
  signupOpensAt: null,
  signupClosesAt: null,
  ratingDate: null,
  rating: { min: null, max: null, maxTeam: null, cap: null },
  maxTeams: 0,
};

interface TournamentFormProps {
  /** The event being changed, or null when creating a new one. */
  event: Tourney | null;
  busy: boolean;
  onSubmit: (draft: TourneyDraft) => void;
  onClose: () => void;
}

export function TournamentForm({ event, busy, onSubmit, onClose }: TournamentFormProps) {
  const { t } = useTranslation();
  const editing = event !== null;
  const [draft, setDraft] = useState<TourneyDraft>(() => (event ? draftOf(event) : BLANK));

  const set = (patch: Partial<TourneyDraft>) => setDraft((held) => ({ ...held, ...patch }));
  const setGate = (patch: Partial<TourneyDraft["rating"]>) =>
    setDraft((held) => ({ ...held, rating: { ...held.rating, ...patch } }));

  const rejection = rejectionOf(draft);
  // A team of one is solo whatever the form says, so the choice is not offered.
  const picksFormation = draft.competition === "team" && draft.teamSize > 1;
  const bound = (value: number | null) => (value === null ? "" : String(value));
  const asBound = (value: string) => (value.trim() === "" ? null : Number(value));

  return (
    <Modal
      onClose={onClose}
      className="tournament-form"
      ariaLabel={t(editing ? "tournaments.form.editTitle" : "tournaments.form.createTitle")}
    >
      <h3>{t(editing ? "tournaments.form.editTitle" : "tournaments.form.createTitle")}</h3>

      <label className="tournament-field">
        <span>{t("tournaments.form.name")}</span>
        <input
          value={draft.name}
          onChange={(changed) => set({ name: changed.target.value })}
          maxLength={60}
          autoFocus
        />
      </label>

      <label className="tournament-field">
        <span>{t("tournaments.form.description")}</span>
        <textarea
          value={draft.description}
          onChange={(changed) => set({ description: changed.target.value })}
          rows={4}
        />
      </label>

      {/* Format: fixed once the event exists, because the bracket hangs off it. */}
      <fieldset className="tournament-field">
        <legend>{t("tournaments.form.format")}</legend>
        {editing ? (
          <p className="muted tournament-form-hint">
            {t("tournaments.form.formatFixed")}
          </p>
        ) : (
          <div className="tournament-form-row">
            <label className="tournament-field">
              <span>{t("tournaments.form.category")}</span>
              <select
                value={draft.category}
                onChange={(changed) =>
                  set({ category: changed.target.value as TourneyDraft["category"] })
                }
              >
                <option value="community">{t("tournaments.form.categoryCommunity")}</option>
                <option value="official">{t("tournaments.form.categoryOfficial")}</option>
              </select>
            </label>
            <label className="tournament-field">
              <span>{t("tournaments.form.teamSize")}</span>
              <select
                value={draft.teamSize}
                onChange={(changed) => set({ teamSize: Number(changed.target.value) })}
              >
                {[1, 2, 3, 4, 5, 6].map((size) => (
                  <option value={size} key={size}>
                    {size}v{size}
                  </option>
                ))}
              </select>
            </label>
            <label className="tournament-field">
              <span>{t("tournaments.form.bracket")}</span>
              <select
                value={draft.bracketKind}
                onChange={(changed) =>
                  set({ bracketKind: changed.target.value as TourneyDraft["bracketKind"] })
                }
              >
                <option value="single">{t("tournaments.bracketKind.single")}</option>
                <option value="double">{t("tournaments.bracketKind.double")}</option>
                <option value="swiss">{t("tournaments.bracketKind.swiss")}</option>
              </select>
            </label>
            {picksFormation && (
              <label className="tournament-field">
                <span>{t("tournaments.form.formation")}</span>
                <select
                  value={draft.formation}
                  onChange={(changed) =>
                    set({ formation: changed.target.value as TourneyDraft["formation"] })
                  }
                >
                  <option value="open">{t("tournaments.form.formationOpen")}</option>
                  <option value="draft">{t("tournaments.form.formationDraft")}</option>
                </select>
              </label>
            )}
          </div>
        )}
      </fieldset>

      <fieldset className="tournament-field">
        <legend>{t("tournaments.form.dates")}</legend>
        <div className="tournament-form-row">
          <label className="tournament-field">
            <span>{t("tournaments.form.eventDate")}</span>
            <input
              type="datetime-local"
              value={localValue(draft.eventDate)}
              onChange={(changed) => set({ eventDate: secondsOf(changed.target.value) })}
            />
          </label>
          <label className="tournament-field">
            <span>{t("tournaments.form.signupCloses")}</span>
            <input
              type="datetime-local"
              value={localValue(draft.signupClosesAt)}
              onChange={(changed) => set({ signupClosesAt: secondsOf(changed.target.value) })}
            />
          </label>
          <label className="tournament-field">
            <span>{t("tournaments.form.ratingDate")}</span>
            <input
              type="datetime-local"
              value={localValue(draft.ratingDate)}
              onChange={(changed) => set({ ratingDate: secondsOf(changed.target.value) })}
              disabled={draft.ratingKind === "none"}
            />
          </label>
        </div>
        {/* The third date is the one that is not about scheduling, so it says
            what it is for rather than relying on its label. */}
        <p className="tournament-form-hint muted">{t("tournaments.form.ratingDateHint")}</p>
      </fieldset>

      <div className="tournament-form-row">
        <label className="tournament-field">
          <span>{t("tournaments.form.minRating")}</span>
          <input
            type="number"
            value={bound(draft.rating.min)}
            onChange={(changed) => setGate({ min: asBound(changed.target.value) })}
          />
        </label>
        <label className="tournament-field">
          <span>{t("tournaments.form.maxRating")}</span>
          <input
            type="number"
            value={bound(draft.rating.max)}
            onChange={(changed) => setGate({ max: asBound(changed.target.value) })}
          />
        </label>
        <label className="tournament-field">
          <span>{t("tournaments.form.signupMode")}</span>
          <select
            value={draft.signupMode}
            onChange={(changed) =>
              set({ signupMode: changed.target.value as TourneyDraft["signupMode"] })
            }
          >
            <option value="open">{t("tournaments.form.signupOpen")}</option>
            <option value="request">{t("tournaments.form.signupRequest")}</option>
            <option value="invite">{t("tournaments.form.signupInvite")}</option>
          </select>
        </label>
      </div>

      {/* Said before the submit rather than after it: the organiser should not
          fill in a long form and then be told the name was missing. */}
      {rejection !== null && (
        <p className="tournament-form-hint muted">{t(REJECTION_LABELS[rejection])}</p>
      )}

      <div className="tournament-form-actions">
        <Button onClick={onClose} disabled={busy}>
          {t("common.cancel")}
        </Button>
        <Button
          variant="primary"
          disabled={busy || rejection !== null}
          onClick={() => onSubmit(draft)}
        >
          {t(
            busy
              ? "tournaments.form.saving"
              : editing
                ? "tournaments.form.save"
                : "tournaments.form.create",
          )}
        </Button>
      </div>
    </Modal>
  );
}
