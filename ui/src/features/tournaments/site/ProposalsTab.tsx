// The console's Proposals tab (#569), the website's `drawSaProposals`: the
// tournaments players proposed, waiting for a director to take one over or
// decline it, what was decided lately, and how long a proposal waits.

import { useState } from "react";
import { Button } from "../../../design-system/Button";
import type { ProposalCard, ProposalQueue, SiteWrite, TourneyAdmin } from "../../../ipc/bindings";
import type { MessageKey } from "../../../i18n";
import { useTranslation } from "../../../i18n/useTranslation";
import { TakeDialog } from "../detail/ProposalBox";
import { askText } from "../tourneyDialogs";
import { BRACKET_KIND_LABELS, formatDay, formatMoment, formatPrize, RATING_KIND_LABELS } from "../tourneyPresentation";
import { daysLeftText, decisionKey } from "../proposals";

const SIGNUP_LABELS: Record<ProposalCard["signupMode"], MessageKey> = {
  open: "tournaments.form.signupOpen",
  request: "tournaments.form.signupRequest",
  invite: "tournaments.form.signupInvite",
};

interface ProposalsTabProps {
  queue: ProposalQueue;
  busy: boolean;
  onWrite: (write: SiteWrite) => void;
  /** A change to one tournament: taking it over or declining it. */
  onAdminister: (tournamentId: string, change: TourneyAdmin) => void;
  onOpenEvent: (tournamentId: string) => void;
}

/** One cell of a card's facts. */
function Fact({ label, children }: { label: string; children: string }) {
  return (
    <div className="tournament-proposal-fact">
      <span className="muted">{label}</span>
      <span>{children}</span>
    </div>
  );
}

function Card({ card, busy, onAdminister, onOpenEvent, onTake }: {
  card: ProposalCard;
  busy: boolean;
  onAdminister: ProposalsTabProps["onAdminister"];
  onOpenEvent: ProposalsTabProps["onOpenEvent"];
  onTake: (card: ProposalCard) => void;
}) {
  const { t } = useTranslation();
  const now = Math.floor(Date.now() / 1000);
  const format =
    card.competition === "freeForAll"
      ? t("tournaments.format.freeForAll")
      : `${card.teamSize}v${card.teamSize} · ${t(BRACKET_KIND_LABELS[card.bracketKind])}`;
  const when =
    card.eventDate === null
      ? t("tournaments.proposal.noDate")
      : `${formatDay(card.eventDate, "")}${card.eventDays > 1 ? ` (${t("tournaments.proposal.eventDays", { count: card.eventDays })})` : ""}`;
  const signups = [
    t(SIGNUP_LABELS[card.signupMode]),
    card.maxTeams > 0 ? t("tournaments.overview.capMax", { count: card.maxTeams }) : "",
  ].filter(Boolean).join(", ");
  const rating =
    card.ratingKind === "none"
      ? t(RATING_KIND_LABELS.none)
      : `${t(RATING_KIND_LABELS[card.ratingKind])} ${card.minRating ?? 0}-${card.maxRating ?? t("tournaments.proposal.any")}`;
  const maps = card.mapCount > 0 ? t("tournaments.proposal.mapCount", { count: card.mapCount }) : t("tournaments.proposal.noMaps");
  const rewards = [formatPrize(card.prize), card.rewards].filter(Boolean).join(" · ") || t("tournaments.proposal.noRewards");
  return (
    <article className="tournament-panel tournament-proposal-card">
      <div className="tournament-proposal-card-head">
        <button type="button" className="tournament-link-button" onClick={() => onOpenEvent(card.tournamentId)}>
          {card.name}
        </button>
        <span className="muted">
          {t("tournaments.proposal.cardBy", {
            name: card.byName,
            when: formatMoment(card.proposedAt, ""),
            left: daysLeftText(card.until, now, t),
          })}
        </span>
      </div>
      {card.note !== "" && <p className="tournament-proposal-note">{card.note}</p>}
      <div className="tournament-proposal-facts">
        <Fact label={t("tournaments.proposal.factFormat")}>{format}</Fact>
        <Fact label={t("tournaments.proposal.factWhen")}>{when}</Fact>
        <Fact label={t("tournaments.proposal.factSignups")}>{signups}</Fact>
        <Fact label={t("tournaments.proposal.factRating")}>{rating}</Fact>
        <Fact label={t("tournaments.proposal.factMaps")}>{[maps, ...card.pools].join(" · ")}</Fact>
        <Fact label={t("tournaments.proposal.factRewards")}>{rewards}</Fact>
      </div>
      {card.description !== "" && <p className="muted tournament-proposal-description">{card.description}</p>}
      <ul className="tournament-proposal-answers">
        <li className={card.lockMaps ? "is-kept" : "is-free"}>
          {t(card.lockMaps ? "tournaments.proposal.answerMapsKeep" : "tournaments.proposal.answerMapsFree")}
        </li>
        <li className={card.lockFormat ? "is-kept" : "is-free"}>
          {t(card.lockFormat ? "tournaments.proposal.answerFormatKeep" : "tournaments.proposal.answerFormatFree")}
        </li>
        <li>{t(card.keep ? "tournaments.proposal.theyKeep" : "tournaments.proposal.theyHandOver", { name: card.byName })}</li>
      </ul>
      {card.mine ? (
        <p className="muted">{t("tournaments.proposal.mineNote")}</p>
      ) : (
        <div className="tournament-detail-actions">
          <Button onClick={() => onOpenEvent(card.tournamentId)}>{t("tournaments.proposal.open")}</Button>
          <Button variant="primary" disabled={busy} onClick={() => onTake(card)}>
            {t("tournaments.proposal.take")}
          </Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() =>
              askText(
                t("tournaments.proposal.declineReason", { name: card.byName }),
                "",
                (reason) => onAdminister(card.tournamentId, { type: "proposalDecline", payload: { reason } }),
                { maxLength: 300 },
              )
            }
          >
            {t("tournaments.proposal.decline")}
          </Button>
        </div>
      )}
    </article>
  );
}

export function ProposalsTab({ queue, busy, onWrite, onAdminister, onOpenEvent }: ProposalsTabProps) {
  const { t } = useTranslation();
  const [taking, setTaking] = useState<ProposalCard | null>(null);
  const [days, setDays] = useState(String(queue.days));
  const asked = Number(days);
  const valid = Number.isInteger(asked) && asked >= 7 && asked <= 90;
  return (
    <>
      <section className="tournament-panel tournament-console-section">
        <div className="tournament-console-section-head">
          <h4>
            {t("tournaments.proposal.consoleTitle")}
            <span className={queue.pending.length > 0 ? "tournaments-group-count is-warn" : "tournaments-group-count"}>
              {queue.pending.length}
            </span>
          </h4>
        </div>
        <p className="muted">{t("tournaments.proposal.consoleIntro", { days: queue.days })}</p>
        {queue.pending.length === 0 ? (
          <p className="muted">{t("tournaments.proposal.nothingWaiting")}</p>
        ) : (
          <div className="tournament-proposal-cards">
            {queue.pending.map((card) => (
              <Card
                key={card.tournamentId}
                card={card}
                busy={busy}
                onAdminister={onAdminister}
                onOpenEvent={onOpenEvent}
                onTake={setTaking}
              />
            ))}
          </div>
        )}
      </section>

      <section className="tournament-panel tournament-console-section">
        <div className="tournament-console-section-head">
          <h4>{t("tournaments.proposal.recentTitle")}</h4>
        </div>
        {queue.recent.length === 0 ? (
          <p className="muted">{t("tournaments.proposal.recentNone")}</p>
        ) : (
          <div className="tournament-console-table-wrap">
            <table className="tournament-console-table">
              <thead>
                <tr>
                  <th>{t("tournaments.proposal.recentProposal")}</th>
                  <th>{t("tournaments.proposal.recentWhat")}</th>
                  <th>{t("tournaments.console.who")}</th>
                  <th>{t("tournaments.console.when")}</th>
                  <th>{t("tournaments.proposal.recentReason")}</th>
                </tr>
              </thead>
              <tbody>
                {queue.recent.map((decision) => {
                  const what = decisionKey(decision);
                  return (
                    <tr key={`${decision.tournamentId}-${decision.at}-${decision.act}`}>
                      <td>
                        <button
                          type="button"
                          className="tournament-link-button"
                          onClick={() => onOpenEvent(decision.tournamentId)}
                        >
                          {decision.name}
                        </button>
                        <span className="muted"> {t("tournaments.proposal.recentBy", { name: decision.proposer })}</span>
                      </td>
                      <td>{what !== null ? t(what) : decision.act}</td>
                      <td>{decision.byName}</td>
                      <td className="mono muted tournament-console-nowrap">{formatMoment(decision.at, "")}</td>
                      <td className="muted">{decision.reason}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="tournament-panel tournament-console-section">
        <div className="tournament-console-section-head">
          <h4>{t("tournaments.proposal.daysTitle")}</h4>
        </div>
        <div className="tournament-detail-actions">
          <label className="tournament-field">
            <span>{t("tournaments.proposal.daysLabel")}</span>
            <input
              type="number"
              min={7}
              max={90}
              value={days}
              onChange={(changed) => setDays(changed.target.value)}
            />
          </label>
          <Button
            disabled={busy || !valid || asked === queue.days}
            onClick={() => onWrite({ type: "proposalDays", payload: { days: asked } })}
          >
            {t("tournaments.proposal.daysSave")}
          </Button>
          <span className="muted">{t("tournaments.proposal.daysDefault", { days: queue.daysDefault })}</span>
        </div>
      </section>

      {taking !== null && (
        <TakeDialog
          name={taking.name}
          by={taking.byName}
          keep={taking.keep}
          lockMaps={taking.lockMaps}
          lockFormat={taking.lockFormat}
          onTake={(change) => {
            setTaking(null);
            onAdminister(taking.tournamentId, change);
          }}
          onCancel={() => setTaking(null)}
        />
      )}
    </>
  );
}
