// Which series this edition belongs to, and which events feed it.
//
// Two relationships that sound like one and are not. A **series** is a label:
// editions of it are fully independent events, with no qualification between
// them and no shared bracket. A **qualifier** is a real link: a finished event's
// best entrants are invited into this one. A qualifier can cross series, and
// most series have no qualifiers at all.
//
// The two are drawn apart for that reason. Filing an event under a series
// changes nothing but how it is listed; adding a qualifier sends invitations
// the moment the child finishes.

import { useState } from "react";
import { Button } from "../../design-system/Button";
import type {
  QualifierKind,
  QualifierRule,
  SeriesDraft,
  Tourney,
  TourneySeries,
} from "../../ipc/bindings";
import type { MessageKey } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";
import { qualifierRejection, seriesIsSubmittable } from "../../shared/tourneyRules";
import { formatDay } from "./tourneyPresentation";

interface SeriesPanelProps {
  event: Tourney;
  /** Every series, for the picker. Loaded on demand by the view. */
  series: TourneySeries[];
  /** The other events, as candidates for a qualifier link. */
  events: Tourney[];
  busy: boolean;
  onSetSeries: (seriesId: string | null) => void;
  onSaveSeries: (draft: SeriesDraft) => void;
  onAddQualifier: (qualifierId: string, rule: QualifierRule) => void;
  onRemoveQualifier: (linkId: string) => void;
}

const BLANK: SeriesDraft = {
  id: "",
  name: "",
  description: "",
  colour: "plain",
  category: null,
};

export function SeriesPanel(props: SeriesPanelProps) {
  const { event, series, busy } = props;
  const { t } = useTranslation();
  const [draft, setDraft] = useState<SeriesDraft | null>(null);
  const [candidateId, setCandidateId] = useState("");
  const [rule, setRule] = useState<QualifierRule>({ kind: "top", n: 4 });

  const candidate = props.events.find((held) => held.id === candidateId) ?? null;
  // Only what the client can answer. The service's own last check, "that
  // tournament already draws from this one", needs the candidate's links, which
  // a list row does not carry, so it stays there and arrives as a refusal.
  const rejection = candidate === null ? null : qualifierRejection(event, candidate, rule);

  return (
    <div className="tournament-series">
      <section>
        <h5>{t("tournaments.series.heading")}</h5>
        <p className="muted">{t("tournaments.series.hint")}</p>

        <div className="tournament-series-picker">
          <label className="tournament-field">
            <span>{t("tournaments.series.pick")}</span>
            <select
              value={event.seriesId ?? ""}
              disabled={busy}
              onChange={(changed) => props.onSetSeries(changed.target.value || null)}
            >
              <option value="">{t("tournaments.series.none")}</option>
              {series.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.name}
                  {row.editions > 0 && ` (${t("tournaments.series.editions", {
                    count: String(row.editions),
                  })})`}
                </option>
              ))}
            </select>
          </label>
          <Button type="button" disabled={busy} onClick={() => setDraft(BLANK)}>
            {t("tournaments.series.create")}
          </Button>
        </div>

        {draft !== null && (
          <form
            className="tournament-series-editor surface"
            onSubmit={(submitted) => {
              submitted.preventDefault();
              if (!seriesIsSubmittable(draft)) return;
              props.onSaveSeries(draft);
              setDraft(null);
            }}
          >
            <label className="tournament-field">
              <span>{t("tournaments.series.name")}</span>
              <input
                value={draft.name}
                autoFocus
                placeholder={t("tournaments.series.namePlaceholder")}
                onChange={(changed) =>
                  setDraft((held) => ({ ...(held ?? BLANK), name: changed.target.value }))
                }
              />
            </label>
            <label className="tournament-field">
              <span>{t("tournaments.series.description")}</span>
              <input
                value={draft.description}
                onChange={(changed) =>
                  setDraft((held) => ({ ...(held ?? BLANK), description: changed.target.value }))
                }
              />
            </label>
            <label className="tournament-field">
              <span>{t("tournaments.series.colour")}</span>
              {/* A fixed palette rather than free-form colour, so a series can
                  never end up unreadable against the dark theme. */}
              <select
                value={draft.colour}
                onChange={(changed) =>
                  setDraft((held) => ({
                    ...(held ?? BLANK),
                    colour: changed.target.value as SeriesDraft["colour"],
                  }))
                }
              >
                {(["amber", "blue", "green", "red", "purple", "plain"] as const).map((colour) => (
                  <option key={colour} value={colour}>
                    {t(`tournaments.series.colour.${colour}` as MessageKey)}
                  </option>
                ))}
              </select>
            </label>
            <div className="tournament-detail-actions">
              <Button type="submit" variant="primary" disabled={busy || !seriesIsSubmittable(draft)}>
                {t("tournaments.series.save")}
              </Button>
              <Button type="button" disabled={busy} onClick={() => setDraft(null)}>
                {t("tournaments.series.cancel")}
              </Button>
            </div>
          </form>
        )}
      </section>

      <section>
        <h5>{t("tournaments.qualifiers.heading")}</h5>
        <p className="muted">{t("tournaments.qualifiers.hint")}</p>

        {event.qualifiers.length > 0 && (
          <ul className="tournament-qualifier-list">
            {event.qualifiers.map((link) => (
              <li key={link.id} className="tournament-qualifier">
                <div>
                  <span className="tournament-qualifier-name">{link.name}</span>
                  <span className="muted">
                    {" · "}
                    {link.rule.kind === "top"
                      ? t("tournaments.qualifiers.ruleTop", { count: String(link.rule.n) })
                      : t("tournaments.qualifiers.rulePoints", { count: String(link.rule.n) })}
                  </span>
                </div>
                {link.applied === null ? (
                  <p className="muted">{t("tournaments.qualifiers.waiting")}</p>
                ) : (
                  <p className="muted">
                    {t("tournaments.qualifiers.applied", {
                      when: formatDay(link.applied, ""),
                      who: link.qualified.join(", ") || t("tournaments.qualifiers.nobody"),
                    })}
                  </p>
                )}
                {/* A team qualifies, and an invitation is addressed to a FAF
                    account. An entrant the organiser added by hand has none, so
                    they qualify and cannot be invited: it is the organiser who
                    then has to add them here. */}
                {link.unreachable.length > 0 && (
                  <p className="tournament-refusal">
                    {t("tournaments.qualifiers.unreachable", {
                      who: link.unreachable.join(", "),
                    })}
                  </p>
                )}
                <Button type="button" disabled={busy} onClick={() => props.onRemoveQualifier(link.id)}>
                  {t("tournaments.qualifiers.remove")}
                </Button>
              </li>
            ))}
          </ul>
        )}

        <div className="tournament-qualifier-add">
          <label className="tournament-field">
            <span>{t("tournaments.qualifiers.event")}</span>
            <select
              value={candidateId}
              disabled={busy}
              onChange={(changed) => setCandidateId(changed.target.value)}
            >
              <option value="">{t("tournaments.qualifiers.pick")}</option>
              {props.events
                .filter((held) => held.id !== event.id)
                .map((held) => (
                  <option key={held.id} value={held.id}>
                    {held.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="tournament-field">
            <span>{t("tournaments.qualifiers.rule")}</span>
            <select
              value={rule.kind}
              disabled={busy}
              onChange={(changed) =>
                setRule((held) => ({ ...held, kind: changed.target.value as QualifierKind }))
              }
            >
              <option value="top">{t("tournaments.qualifiers.kindTop")}</option>
              <option value="points">{t("tournaments.qualifiers.kindPoints")}</option>
            </select>
          </label>
          <label className="tournament-field">
            <span>{t("tournaments.qualifiers.cutoff")}</span>
            <input
              type="number"
              min={1}
              value={rule.n}
              disabled={busy}
              onChange={(changed) =>
                setRule((held) => ({ ...held, n: Number(changed.target.value) }))
              }
            />
          </label>
          <Button
            type="button"
            variant="primary"
            disabled={busy || candidate === null || rejection !== null}
            onClick={() => {
              if (candidate === null || rejection !== null) return;
              props.onAddQualifier(candidate.id, rule);
              setCandidateId("");
            }}
          >
            {t("tournaments.qualifiers.add")}
          </Button>
        </div>

        {rejection !== null && (
          <p className="tournament-refusal">
            {t(`tournaments.qualifiers.rejection.${rejection}` as MessageKey)}
          </p>
        )}
      </section>
    </div>
  );
}
