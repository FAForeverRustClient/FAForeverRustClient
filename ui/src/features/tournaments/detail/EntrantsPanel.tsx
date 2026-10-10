// Who has entered.
//
// One table of people, ranked by the rating this event seeds on, which is what
// the website shows and what a reader is actually looking for: am I in it, who
// else is, and where do I stand among them.
//
// It used to be a list of team cards with the members nested inside, and that
// was wrong in two ways at once. A solo event's entrant *is* a team of one, so
// every row printed the same name twice, once as the team and once as its only
// member, inside a card built to hold six. And a team event answered "who has
// entered" with a roster, which is the Teams tab's question, not this one.
// Team membership is a column here, exactly as on the website.
//
// Laid out as the Overview is: the table on the left, and in a narrower column
// on the right how full the field is, how strong, and what rating gets in,
// with the check that says whether yours does.

import type { PlayerSummary, Tourney } from "../../../ipc/bindings";
import { useTranslation } from "../../../i18n/useTranslation";
import { PlayerTable } from "../PlayerTable";
import { fieldSummary } from "../entrantsPresentation";
import { hasRatingRequirements, RatingRequirements, type RatingCheckProps } from "./RatingRequirements";

interface EntrantsPanelProps {
  event: Tourney;
  profiles: PlayerSummary[];
  ratingCheck?: RatingCheckProps;
}

export function EntrantsPanel({ event, profiles, ratingCheck }: EntrantsPanelProps) {
  const { t } = useTranslation();
  const field = fieldSummary(event);

  // Both extra columns are earned rather than always drawn: a 1v1 has no teams
  // to name, and an event that has not been seeded has nothing to say about
  // where anyone stands.
  const showStanding = event.teams.some(
    (team) => team.seed > 0 || team.checkedIn || team.finalRank !== null,
  );

  // The field against its cap, with the floor it runs with marked on the bar.
  const filled = field.max > 0 ? Math.min(1, field.count / field.max) : 0;
  const enough = field.min === 0 || field.count >= field.min;

  return (
    <div className="tournament-columns">
      <div className="tournament-columns-main">
        {/* No heading of its own: the table's columns say what it is. */}
        <section className="tournament-panel">
          {event.players.length === 0 ? (
            <p className="muted">{t("tournaments.entrants.none")}</p>
          ) : (
            <PlayerTable
              event={event}
              profiles={profiles}
              players={event.players}
              showTeam={event.teamSize > 1}
              showStanding={showStanding}
            />
          )}
        </section>
      </div>

      <aside className="tournament-columns-aside">
        <section className="tournament-panel">
          <h4>{t("tournaments.entrants.field")}</h4>
          <div className="tournament-field-count">
            <span className="tournament-field-number">{field.count}</span>
            {field.max > 0 && <span className="tournament-field-of">/ {field.max}</span>}
            <span className="tournament-field-unit">
              {t(field.unit === "players" ? "tournaments.section.players" : "tournaments.section.teams")}
            </span>
          </div>
          {field.max > 0 && (
            <div className={enough ? "tournament-field-bar is-enough" : "tournament-field-bar"} aria-hidden>
              <span style={{ width: `${Math.round(filled * 100)}%` }} />
              {field.min > 0 && field.min < field.max && (
                <i style={{ left: `${Math.round((field.min / field.max) * 100)}%` }} />
              )}
            </div>
          )}
          {/* A target, not a rule: the service never checks it, and the
              website says the same under its own count. */}
          {field.min > 0 && <p className="muted">{t("tournaments.entrants.minTarget", { count: field.min })}</p>}
        </section>

        {field.ratings !== null && (
          <section className="tournament-panel">
            <h4>{t("tournaments.entrants.fieldRatings")}</h4>
            <dl className="tournament-field-ratings">
              <div>
                <dt>{t("tournaments.entrants.highest")}</dt>
                <dd>{field.ratings.high}</dd>
              </div>
              <div>
                <dt>{t("tournaments.entrants.average")}</dt>
                <dd>{field.ratings.average}</dd>
              </div>
              <div>
                <dt>{t("tournaments.entrants.lowest")}</dt>
                <dd>{field.ratings.low}</dd>
              </div>
            </dl>
          </section>
        )}

        {hasRatingRequirements(event) && (
          <section className="tournament-panel">
            <h4>{t("tournaments.overview.ratingRequirements")}</h4>
            <div className="tournament-rule-body">
              <RatingRequirements event={event} ratingCheck={ratingCheck} />
            </div>
          </section>
        )}
      </aside>
    </div>
  );
}
