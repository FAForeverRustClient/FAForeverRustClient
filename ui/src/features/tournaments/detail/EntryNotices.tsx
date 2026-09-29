// What stands between this account and entering, said before it presses
// anything: a ban, an invitation to answer, and whether its rating would get
// it in.
//
// The website shows these in its signup panel. Here they sit at the top of the
// Overview and the Players section, the two places somebody deciding whether to
// enter actually looks. Enter itself stays in the header.

import { Button } from "../../../design-system/Button";
import type { RatingCheck, Tourney, TourneyLoadStatus } from "../../../ipc/bindings";
import type { MessageKey } from "../../../i18n";
import { useTranslation } from "../../../i18n/useTranslation";
import { mayCheckRating, mayDeclineInvite } from "../../../shared/rules/tourneyRules";
import { formatDay, RATING_KIND_LABELS } from "../tourneyPresentation";
import { RATING_CHECK_ID } from "../overviewPresentation";

const BAN_SCOPES: Record<NonNullable<Tourney["myBan"]>["scope"], MessageKey> = {
  official: "tournaments.entry.banOfficial",
  series: "tournaments.entry.banSeries",
  tournament: "tournaments.entry.banTournament",
};

interface EntryNoticesProps {
  event: Tourney;
  check: RatingCheck | null;
  checkStatus: TourneyLoadStatus;
  busy: boolean;
  onDecline: () => void;
  onCheckRating: () => void;
}

export function EntryNotices({ event, check, checkStatus, busy, onDecline, onCheckRating }: EntryNoticesProps) {
  const { t } = useTranslation();
  const signedUp = event.viewer.signedUpPlayerId !== null;
  const ban = event.myBan;
  const checking = checkStatus.type === "loading";
  // Offered while it can still change anything: before and during signups.
  const offerCheck = mayCheckRating(event) && event.status === "signup";

  if ((ban === null || signedUp) && !mayDeclineInvite(event) && !offerCheck) return null;

  return (
    <div className="tournament-entry-notices">
      {ban !== null && !signedUp && (
        <section className="surface tournament-entry-notice is-danger">
          <h5>{t("tournaments.entry.banned")}</h5>
          <p>{t(BAN_SCOPES[ban.scope])}</p>
          {ban.reason !== "" && <p className="muted">{t("tournaments.entry.banReason", { reason: ban.reason })}</p>}
          <p className="muted">
            {ban.expires === null
              ? t("tournaments.entry.banNoExpiry")
              : t("tournaments.entry.banUntil", { day: formatDay(ban.expires, "") })}{" "}
            {t(ban.scope === "official" ? "tournaments.entry.banContactTd" : "tournaments.entry.banContactOrganisers")}
          </p>
        </section>
      )}

      {mayDeclineInvite(event) && (
        <section className="surface tournament-entry-notice is-invite">
          <h5>{t("tournaments.entry.invited")}</h5>
          <p className="muted">{t("tournaments.entry.invitedHint")}</p>
          <Button disabled={busy} onClick={onDecline}>
            {t("tournaments.entry.decline")}
          </Button>
        </section>
      )}

      {offerCheck && (
        <section className="surface tournament-entry-notice" id={RATING_CHECK_ID}>
          <div className="tournament-detail-actions">
            <Button disabled={busy || checking} onClick={onCheckRating}>
              {t(checking ? "tournaments.entry.checking" : "tournaments.entry.checkRating")}
            </Button>
            <span className="muted">{t("tournaments.entry.checkHint")}</span>
          </div>
          {checkStatus.type === "failed" && (
            <p className="tournament-rating-verdict is-bad">{checkStatus.payload.reason}</p>
          )}
          {check !== null && <RatingVerdict check={check} />}
        </section>
      )}
    </div>
  );
}

/** The verdict first, then the numbers behind it, as the website words it. */
function RatingVerdict({ check }: { check: RatingCheck }) {
  const { t } = useTranslation();
  if (!check.rated) return <p className="muted">{check.message || t("tournaments.entry.notRated")}</p>;
  if (check.rating === null) {
    return <p className="tournament-rating-verdict is-warn">{check.message || t("tournaments.entry.noRating")}</p>;
  }
  const range =
    check.min !== null && check.max !== null
      ? `${check.min}–${check.max}`
      : check.min !== null
        ? t("tournaments.entry.rangeFrom", { min: check.min })
        : check.max !== null
          ? t("tournaments.entry.rangeUpTo", { max: check.max })
          : null;
  const [tone, verdict] =
    check.banned !== null
      ? ["is-bad", check.banned]
      : check.eligible === false
        ? ["is-bad", check.message]
        : check.alreadyIn
          ? ["is-good", t("tournaments.entry.qualifyAlreadyIn")]
          : check.exempt && range !== null
            ? ["is-good", t("tournaments.entry.exempt")]
            : ["is-good", t(range !== null ? "tournaments.entry.qualify" : "tournaments.entry.nothingStops")];
  return (
    <div className={`tournament-rating-verdict ${tone}`}>
      <strong>{verdict}</strong>
      <span>
        {t(check.asOf === null ? "tournaments.entry.yourRatingNow" : "tournaments.entry.yourRating", {
          board: t(RATING_KIND_LABELS[check.ratingKind]),
          rating: check.rating,
          day: check.asOf === null ? "" : formatDay(check.asOf, ""),
        })}
      </span>
      {check.capped !== null && (
        <span className="muted">{t("tournaments.entry.capped", { capped: check.capped })}</span>
      )}
      {range !== null && <span className="muted">{t("tournaments.entry.range", { range })}</span>}
    </div>
  );
}
