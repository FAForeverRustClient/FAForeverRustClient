// The top of one tournament: the replay detail's hero, and under it the facts
// the event rests on and where it is up to.
//
// The replay detail puts the map behind the header, dimmed from the left, with
// what the replay is in front of it and Watch, large, on the right. A
// tournament's picture is its banner: the first image the organiser placed in
// the briefing, which on FAF's own events is the artwork the series is
// announced with. The way in is Enter (or Check in), in Watch's place.
//
// Under it, the facts as one strip of labelled values, the way the replay
// detail and the Training hub state theirs, and the four stages as a progress
// bar rather than a breadcrumb. What kind of event it is (1v1, single
// elimination, the cap) is not repeated under the name: the strip, the
// Overview's format and the bracket all say it.

import type { ReactNode } from "react";
import type { Tourney } from "../../../ipc/bindings";
import { useTranslation } from "../../../i18n/useTranslation";
import { eventDayCount, listRatingLine, stages, type StatusPill } from "../orientation";
import { formatMoment, formatPrize } from "../tourneyPresentation";

interface Props {
  event: Tourney;
  pill: StatusPill;
  /** Where the service lives, for the banner's path. */
  assetBase: string;
  /** Enter, check in, withdraw: whatever this account can do about its entry. */
  actions: ReactNode;
}

/**
 * The banner: the first of the organiser's uploads the briefing shows.
 *
 * The briefing rather than the upload list, because the list also holds the
 * sponsors' logos and nothing says which file is which; the briefing is where
 * an organiser puts the event's own picture, at its top. Only the service's own
 * uploads: a link to somewhere else is not the client's to load unasked.
 */
export function heroBanner(event: Tourney, assetBase: string): string | null {
  if (assetBase === "") return null;
  const match = /\]\((\/desc-images\/[^)\s]+)\)/.exec(event.description);
  return match === null ? null : `${assetBase}${match[1]}`;
}

export function TournamentHero({ event, pill, assetBase, actions }: Props) {
  const { t } = useTranslation();
  const banner = heroBanner(event, assetBase);
  const prize = formatPrize(event.prize);
  const rating = listRatingLine(event, t);
  const teams = event.competition !== "freeForAll" && event.teamSize > 1;

  return (
    <>
      <header
        className={[
          "tournament-hero",
          `is-series-${event.seriesColour}`,
          `is-${event.category}`,
          banner === null ? "" : "has-banner",
        ]
          .filter((name) => name !== "")
          .join(" ")}
      >
        {banner !== null && (
          <div className="tournament-hero-backdrop" aria-hidden>
            <img src={banner} alt="" loading="lazy" />
          </div>
        )}

        <div className="tournament-hero-headtext">
          {/* What the event is before what it is called: official or
              community, the series it belongs to, and where it is up to. */}
          <div className="tournament-hero-eyebrow">
            <span className={`tournament-tag is-${event.category}`}>
              {t(event.category === "official" ? "tournaments.list.official" : "tournaments.list.community")}
            </span>
            {event.seriesName !== "" && (
              <span className={`tournament-series-name is-${event.seriesColour}`}>{event.seriesName}</span>
            )}
            <span
              className={`tournament-status is-${pill.tone}`}
              title={
                pill.tone === "presignup"
                  ? t("tournaments.header.opensAt", { when: formatMoment(event.signupOpensAt, "") })
                  : undefined
              }
            >
              {t(pill.label)}
            </span>
          </div>
          <h2>{event.name || t("tournaments.untitled")}</h2>
        </div>

        <div className="tournament-hero-actions">{actions}</div>
      </header>

      <div className="tournament-hero-foot">
        {/* As wide as the facts, so the stages under them end where they do. */}
        <div className="tournament-hero-foot-inner">
          <dl className="tournament-facts-strip">
            <div>
              <dt>{t(event.imported ? "tournaments.overview.played" : "tournaments.overview.eventDate")}</dt>
              <dd>{formatMoment(event.eventDate, t("tournaments.noDate"))}</dd>
            </div>
            {eventDayCount(event.eventDays) > 1 && (
              <div>
                <dt>{t("tournaments.overview.schedule")}</dt>
                <dd>{t("tournaments.list.dayCount", { count: eventDayCount(event.eventDays) })}</dd>
              </div>
            )}
            <div>
              <dt>{t("tournaments.section.players")}</dt>
              <dd>{event.playerCount}</dd>
            </div>
            {teams && (
              <div>
                <dt>{t("tournaments.section.teams")}</dt>
                <dd>{event.teamCount}</dd>
              </div>
            )}
            {rating !== "" && (
              <div>
                <dt>{t("tournaments.overview.ratingRequirements")}</dt>
                <dd>{rating}</dd>
              </div>
            )}
            {prize !== "" && (
              <div className="is-prize">
                <dt>{t("tournaments.overview.prize")}</dt>
                <dd>{prize}</dd>
              </div>
            )}
          </dl>

          {/* The four stages as a bar, filled up to the one the event is in. */}
          <ol className="tournament-stepper" aria-label={t("tournaments.stage.label")}>
            {stages(event).map((stage) => (
              <li
                key={stage.label}
                className={`is-${stage.state}`}
                aria-current={stage.state === "now" ? "step" : undefined}
              >
                {t(stage.label)}
              </li>
            ))}
          </ol>
        </div>
      </div>
    </>
  );
}
