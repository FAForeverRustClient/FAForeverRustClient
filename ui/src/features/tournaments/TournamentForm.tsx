// Creating an event, and changing one.
//
// One form for both, because they ask almost the same questions. The difference
// is which answers the server will still take: once a tournament exists, its
// format, team size and category are welded to a bracket that may already have
// been drawn, so those controls are shown as facts rather than as inputs.
// Sending them would send them nowhere.
//
// This used to be a short form, on the reasoning that the service defaults the
// best-of plan, the prize, the rich text and the veto, and that asking an
// organiser for six best-of numbers before their event has an entrant is the
// wrong first question. That reasoning was wrong about where the answers come
// from: every one of those fields is what the overview *shows*, so a form that
// skipped them produced an event with a blank front page and an organiser sent
// to the website to fill it in. It now asks what `renderHost` asks.
//
// Two things are still not here. The free-for-all configuration, which has a
// shape of its own and is the one format the client cannot yet run end to end;
// and per-round best-of overrides, which cannot be asked about before the rounds
// exist. Both stay on the website, and the map database is its own section.

import { useState } from "react";
import { Button } from "../../design-system/Button";
import { Modal } from "../../design-system/Modal";
import type { Prize, Tourney, TourneyDraft, TourneySeries } from "../../ipc/bindings";
import type { MessageKey } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";
import { defaultPlanFor, rejectionOf, type DraftRejection } from "../../shared/tourneyRules";
import { PlanFields } from "./PlanFields";
import { formatPrize } from "./tourneyPresentation";

const REJECTION_LABELS: Record<DraftRejection, MessageKey> = {
  nameRequired: "tournaments.form.nameRequired",
  teamSizeOutOfRange: "tournaments.form.teamSizeOutOfRange",
  ratingRangeInverted: "tournaments.form.ratingRangeInverted",
  ratingGateWithoutRating: "tournaments.form.ratingGateWithoutRating",
  signupWindowInverted: "tournaments.form.signupWindowInverted",
};

/** Whether a stream link is one the service would keep. */
function isStreamUrl(url: string): boolean {
  const trimmed = url.trim();
  return trimmed === "" || /^https?:\/\/[^\s"'<>]+$/.test(trimmed);
}

/**
 * The prize with a different currency, or none at all.
 *
 * `cleanPrize` needs both halves or it stores neither, so picking a currency on
 * an empty prize starts it at zero rather than leaving half of one behind.
 */
function withCurrency(prize: Prize | null, currency: string): Prize | null {
  if (currency === "") return null;
  return {
    currency: currency as Prize["currency"],
    amountCents: prize?.amountCents ?? 0,
  };
}

/** The prize with a different amount. Whole units in, cents held. */
function withAmount(prize: Prize | null, amount: string): Prize | null {
  if (prize === null) return null;
  const units = Number(amount);
  if (!Number.isFinite(units) || units < 0) return prize;
  return { ...prize, amountCents: Math.round(units * 100) };
}

/**
 * The stream list with one row edited, and empty rows dropped.
 *
 * The form always shows one blank row past the end, so editing "the last row"
 * means appending. A row emptied again disappears, which is how a link is
 * removed without a button for it.
 */
function withStream(
  streams: TourneyDraft["streams"],
  index: number,
  patch: Partial<TourneyDraft["streams"][number]>,
): TourneyDraft["streams"] {
  const next = [...streams];
  while (next.length <= index) next.push({ url: "", info: "" });
  next[index] = { ...next[index], ...patch };
  return next.filter((stream) => stream.url.trim() !== "" || stream.info.trim() !== "");
}

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
    //
    // `seeding` was the last of those guesses: it sat here as a literal
    // "rating" because nothing read the field, so an event seeded randomly or
    // by hand answered "by rating" the moment its organiser opened this form.
    // The codec reads it now, so the form can say what is actually set.
    seeding: event.seeding,
    rewards: event.rewards,
    sponsors: event.sponsors,
    lobbyOptions: event.lobbyOptions,
    mods: event.mods,
    prize: event.prize,
    streams: event.streams,
    seriesId: event.seriesId,
    plan: event.plan,
    veto: event.veto,
    minTeams: event.minTeams,
    draftSnakes: event.draftSnakes,
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
  rewards: "",
  sponsors: "",
  lobbyOptions: "",
  mods: "",
  prize: null,
  streams: [],
  seriesId: null,
  plan: defaultPlanFor("single"),
  veto: { enabled: false, mode: "upfront" },
  minTeams: 0,
  draftSnakes: false,
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
  /** Every series, for filing this edition under one. Loaded when this opens. */
  series: TourneySeries[];
  busy: boolean;
  /**
   * Draw the fields where they stand instead of in a dialog.
   *
   * Creating an event is a dialog: it interrupts, and it has a beginning and an
   * end. Changing one is not. In Manage the settings *are* the section, and a
   * section whose whole content is a button that opens a dialog over it is a
   * click asking for permission to show what was already asked for.
   */
  inline?: boolean;
  onSubmit: (draft: TourneyDraft) => void;
  onClose: () => void;
}

export function TournamentForm({
  event,
  series,
  busy,
  inline = false,
  onSubmit,
  onClose,
}: TournamentFormProps) {
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

  const title = t(editing ? "tournaments.form.editTitle" : "tournaments.form.createTitle");
  // One body, two frames. Everything below is the same in both.
  const Frame = inline
    ? ({ children }: { children: React.ReactNode }) => (
        <div className="tournament-form is-inline">{children}</div>
      )
    : ({ children }: { children: React.ReactNode }) => (
        <Modal onClose={onClose} className="tournament-form" ariaLabel={title}>
          {children}
        </Modal>
      );

  return (
    <Frame>
      {!inline && <h3>{title}</h3>}

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
          rows={6}
          maxLength={20_000}
        />
      </label>
      {/* Said once, next to the first of the four fields that take it: these are
          rendered as formatted text on the overview, and an organiser who does
          not know that writes plain prose and loses nothing, while one who does
          gets headings and lists. */}
      <p className="tournament-form-hint muted">{t("tournaments.form.markdownHint")}</p>

      <label className="tournament-field">
        <span>{t("tournaments.form.lobbyOptions")}</span>
        <textarea
          value={draft.lobbyOptions}
          onChange={(changed) => set({ lobbyOptions: changed.target.value })}
          rows={4}
          maxLength={20_000}
          placeholder={t("tournaments.form.lobbyOptionsPlaceholder")}
        />
      </label>

      <label className="tournament-field">
        <span>{t("tournaments.form.mods")}</span>
        <textarea
          value={draft.mods}
          onChange={(changed) => set({ mods: changed.target.value })}
          rows={2}
          maxLength={500}
          placeholder={t("tournaments.form.modsPlaceholder")}
        />
      </label>

      <fieldset className="tournament-field">
        <legend>{t("tournaments.form.rewardsLegend")}</legend>
        <div className="tournament-form-row">
          <label className="tournament-field">
            <span>{t("tournaments.form.prizeCurrency")}</span>
            <select
              value={draft.prize?.currency ?? ""}
              onChange={(changed) => set({ prize: withCurrency(draft.prize, changed.target.value) })}
            >
              <option value="">{t("tournaments.form.prizeNone")}</option>
              <option value="usd">USD $</option>
              <option value="eur">EUR \u20ac</option>
              <option value="rub">RUB \u20bd</option>
            </select>
          </label>
          <label className="tournament-field">
            <span>{t("tournaments.form.prizeAmount")}</span>
            <input
              type="number"
              min={0}
              step={1}
              value={draft.prize === null ? "" : String(draft.prize.amountCents / 100)}
              onChange={(changed) => set({ prize: withAmount(draft.prize, changed.target.value) })}
              disabled={draft.prize === null}
            />
          </label>
          {draft.prize !== null && (
            <span className="tournament-form-preview">{formatPrize(draft.prize)}</span>
          )}
        </div>
        {/* The number is the headline; the breakdown goes in the text below it,
            which is exactly how the overview draws the two. */}
        <p className="tournament-form-hint muted">{t("tournaments.form.prizeHint")}</p>

        <label className="tournament-field">
          <span>{t("tournaments.form.rewards")}</span>
          <textarea
            value={draft.rewards}
            onChange={(changed) => set({ rewards: changed.target.value })}
            rows={3}
            maxLength={2_000}
            placeholder={t("tournaments.form.rewardsPlaceholder")}
          />
        </label>

        <label className="tournament-field">
          <span>{t("tournaments.form.sponsors")}</span>
          <textarea
            value={draft.sponsors}
            onChange={(changed) => set({ sponsors: changed.target.value })}
            rows={3}
            maxLength={2_000}
            placeholder={t("tournaments.form.sponsorsPlaceholder")}
          />
        </label>
      </fieldset>

      <fieldset className="tournament-field">
        <legend>{t("tournaments.form.streams")}</legend>
        {/* One empty row is always offered, so adding the first link needs no
            button. The service keeps at most ten and drops anything that is not
            http(s) without a word, so the form says so instead. */}
        {[...draft.streams, { url: "", info: "" }].slice(0, 10).map((stream, index) => (
          <div className="tournament-form-row" key={index}>
            <label className="tournament-field">
              <span>{t("tournaments.form.streamUrl")}</span>
              <input
                value={stream.url}
                placeholder="https://twitch.tv/..."
                onChange={(changed) =>
                  set({ streams: withStream(draft.streams, index, { url: changed.target.value }) })
                }
              />
            </label>
            <label className="tournament-field">
              <span>{t("tournaments.form.streamInfo")}</span>
              <input
                value={stream.info}
                maxLength={120}
                placeholder={t("tournaments.form.streamInfoPlaceholder")}
                onChange={(changed) =>
                  set({ streams: withStream(draft.streams, index, { info: changed.target.value }) })
                }
              />
            </label>
          </div>
        ))}
        {draft.streams.some((stream) => !isStreamUrl(stream.url)) && (
          <p className="tournament-form-hint muted">{t("tournaments.form.streamHint")}</p>
        )}
      </fieldset>

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
            {/* Only for a captains draft, and sent only then: the service stores
                a pick order whatever the formation, so writing one from a form
                that never showed the choice would be a guess. */}
            {picksFormation && draft.formation === "draft" && (
              <label className="tournament-field">
                <span>{t("tournaments.form.draftOrder")}</span>
                <select
                  value={draft.draftSnakes ? "snake" : "linear"}
                  onChange={(changed) => set({ draftSnakes: changed.target.value === "snake" })}
                >
                  <option value="linear">{t("tournaments.form.draftLinear")}</option>
                  <option value="snake">{t("tournaments.form.draftSnake")}</option>
                </select>
              </label>
            )}
          </div>
        )}
      </fieldset>

      {/* The match lengths. Offered here rather than left to the service,
          because the overview states them and an organiser who never saw the
          question cannot answer for what it says. Swapped wholesale when the
          bracket type changes: the three plans have different keys, and a
          leftover one would be stored and then ignored. */}
      {!editing && draft.competition === "team" && draft.plan !== null && (
        <fieldset className="tournament-field">
          <legend>{t("tournaments.form.matchLengths")}</legend>
          <PlanFields
            plan={
              draft.plan.type === draft.bracketKind
                ? draft.plan
                : defaultPlanFor(draft.bracketKind)
            }
            onChange={(plan) => set({ plan })}
          />
        </fieldset>
      )}

      <fieldset className="tournament-field">
        <legend>{t("tournaments.form.fieldLegend")}</legend>
        <div className="tournament-form-row">
          <label className="tournament-field">
            <span>{t("tournaments.form.minTeams")}</span>
            <input
              type="number"
              min={0}
              max={128}
              value={draft.minTeams === 0 ? "" : String(draft.minTeams)}
              onChange={(changed) => set({ minTeams: Number(changed.target.value) || 0 })}
            />
          </label>
          <label className="tournament-field">
            <span>{t("tournaments.form.maxTeams")}</span>
            <input
              type="number"
              min={0}
              max={128}
              value={draft.maxTeams === 0 ? "" : String(draft.maxTeams)}
              onChange={(changed) => set({ maxTeams: Number(changed.target.value) || 0 })}
            />
          </label>
          <label className="tournament-field">
            <span>{t("tournaments.form.seeding")}</span>
            <select
              value={draft.seeding}
              onChange={(changed) =>
                set({ seeding: changed.target.value as TourneyDraft["seeding"] })
              }
            >
              <option value="rating">{t("tournaments.form.seedRating")}</option>
              <option value="random">{t("tournaments.form.seedRandom")}</option>
              <option value="manual">{t("tournaments.form.seedManual")}</option>
            </select>
          </label>
        </div>
        <p className="tournament-form-hint muted">{t("tournaments.form.teamsHint")}</p>

        {/* A series is a browsing label rather than a mechanism, and it can be
            set later from Manage, so it sits with the housekeeping. */}
        <label className="tournament-field">
          <span>{t("tournaments.form.series")}</span>
          <select
            value={draft.seriesId ?? ""}
            onChange={(changed) =>
              set({ seriesId: changed.target.value === "" ? null : changed.target.value })
            }
          >
            <option value="">{t("tournaments.form.seriesNone")}</option>
            {series.map((held) => (
              <option value={held.id} key={held.id}>
                {held.name}
              </option>
            ))}
          </select>
        </label>
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
            <span>{t("tournaments.form.signupOpens")}</span>
            <input
              type="datetime-local"
              value={localValue(draft.signupOpensAt)}
              onChange={(changed) => set({ signupOpensAt: secondsOf(changed.target.value) })}
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

      <fieldset className="tournament-field">
        <legend>{t("tournaments.form.ratingLegend")}</legend>
        <label className="tournament-field">
          <span>{t("tournaments.form.ratingKind")}</span>
          <select
            value={draft.ratingKind}
            onChange={(changed) =>
              set({ ratingKind: changed.target.value as TourneyDraft["ratingKind"] })
            }
          >
            <option value="global">{t("tournaments.rating.global")}</option>
            <option value="ladder1v1">{t("tournaments.rating.ladder")}</option>
            <option value="team2v2">{t("tournaments.rating.team2v2")}</option>
            <option value="team3v3">{t("tournaments.rating.team3v3")}</option>
            <option value="team4v4">{t("tournaments.rating.team4v4")}</option>
            <option value="combined">{t("tournaments.rating.combined")}</option>
            <option value="none">{t("tournaments.rating.none")}</option>
          </select>
        </label>
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
        </div>
        <div className="tournament-form-row">
          {/* The two limits that are not a range. A team cap refuses a *join*
              rather than a signup, and a clamp refuses nobody at all: it counts
              a stronger player as weaker, which is a different promise to make
              to the field and worth saying separately. */}
          <label className="tournament-field">
            <span>{t("tournaments.form.maxTeamRating")}</span>
            <input
              type="number"
              value={bound(draft.rating.maxTeam)}
              onChange={(changed) => setGate({ maxTeam: asBound(changed.target.value) })}
              disabled={draft.teamSize <= 1}
            />
          </label>
          <label className="tournament-field">
            <span>{t("tournaments.form.ratingCap")}</span>
            <input
              type="number"
              value={bound(draft.rating.cap)}
              onChange={(changed) => setGate({ cap: asBound(changed.target.value) })}
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
        <p className="tournament-form-hint muted">{t("tournaments.form.ratingGateHint")}</p>
      </fieldset>

      {/* The veto, and only whether and when: who is Team A is a per-match
          decision the client makes from the bracket, and the service's own
          `abMode` is not modelled here yet. */}
      {!editing && (
        <fieldset className="tournament-field">
          <legend>{t("tournaments.form.vetoLegend")}</legend>
          <label className="tournament-check">
            <input
              type="checkbox"
              checked={draft.veto.enabled}
              onChange={(changed) =>
                set({ veto: { ...draft.veto, enabled: changed.target.checked } })
              }
            />
            <span>{t("tournaments.form.vetoEnabled")}</span>
          </label>
          {draft.veto.enabled && (
            <label className="tournament-field">
              <span>{t("tournaments.form.vetoMode")}</span>
              <select
                value={draft.veto.mode}
                onChange={(changed) =>
                  set({
                    veto: { ...draft.veto, mode: changed.target.value as TourneyDraft["veto"]["mode"] },
                  })
                }
              >
                <option value="upfront">{t("tournaments.form.vetoUpfront")}</option>
                <option value="continuous">{t("tournaments.form.vetoContinuous")}</option>
              </select>
            </label>
          )}
          <p className="tournament-form-hint muted">{t("tournaments.form.vetoHint")}</p>
        </fieldset>
      )}

      {/* Said before the submit rather than after it: the organiser should not
          fill in a long form and then be told the name was missing. */}
      {rejection !== null && (
        <p className="tournament-form-hint muted">{t(REJECTION_LABELS[rejection])}</p>
      )}

      <div className="tournament-form-actions">
        {!inline && (
          <Button onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
        )}
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
    </Frame>
  );
}
