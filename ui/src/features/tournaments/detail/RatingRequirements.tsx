// The fine print of an event's rating limit, and the way to find out whether
// yours clears it.
//
// The Players section's side column, and only there: the range itself and the
// team cap are the hero's, in its strip over every section, so this block says
// what that one line cannot. Which rating is meant and when it is read, the
// clamp, the organiser's exemption, and the check. It used to sit in the
// Overview's game setup as well, the same range and the same button twice; a
// rating limit is a condition of entry, not a lobby setting, so it lives beside
// the field it lets in.

import type { RatingCheck, Tourney, TourneyLoadStatus } from "../../../ipc/bindings";
import { useTranslation } from "../../../i18n/useTranslation";
import { RichLine } from "../RichLine";
import { formatDay, RATING_KIND_LABELS, ratingClampLine } from "../tourneyPresentation";
import { offersRatingCheck, RatingCheckControl } from "./EntryNotices";

/** This account's rating check, shown under the fine print while it is offered. */
export interface RatingCheckProps {
  check: RatingCheck | null;
  status: TourneyLoadStatus;
  busy: boolean;
  onCheck: () => void;
}

/**
 * An organiser's own invites and adds skip the range, which the service
 * enforces and they would otherwise find out by surprise.
 */
function organiserExempt(event: Tourney): boolean {
  return event.viewer.organiser && (event.rating.min !== null || event.rating.max !== null);
}

/** Whether the block has anything the hero does not already say. */
export function hasRatingRequirements(event: Tourney): boolean {
  // The check is offered only for a rating pulled from FAF, so the first
  // condition covers it too.
  return event.ratingKind !== "none" || event.rating.cap !== null || organiserExempt(event);
}

export function RatingRequirements({ event, ratingCheck }: { event: Tourney; ratingCheck?: RatingCheckProps }) {
  const { t } = useTranslation();
  const clamp = ratingClampLine(event, t);
  const pulled = event.ratingKind !== "none";
  const kind = t(RATING_KIND_LABELS[event.ratingKind]);
  const source = !pulled
    ? ""
    : event.ratingDate !== null
      ? t("tournaments.overview.ratingSourceAsOf", { kind, date: formatDay(event.ratingDate, "") })
      : t("tournaments.overview.ratingSourceAtSignup", { kind });

  return (
    <>
      {pulled && (
        <p>
          <RichLine text={source} /> {t("tournaments.overview.ratingSourcePulled")}
        </p>
      )}
      {clamp !== "" && <p className="tournament-rule-main">{clamp}</p>}
      {organiserExempt(event) && <p className="muted">{t("tournaments.overview.organiserExempt")}</p>}
      {/* The rating is fetched from FAF, so a player reading the range has no
          way to know whether they clear it: the check sits here, while signups
          can still be changed by it. */}
      {ratingCheck !== undefined && event.viewer.loggedIn && offersRatingCheck(event) && (
        <div className="tournament-rule-check">
          <RatingCheckControl
            check={ratingCheck.check}
            checkStatus={ratingCheck.status}
            busy={ratingCheck.busy}
            onCheck={ratingCheck.onCheck}
          />
        </div>
      )}
    </>
  );
}
