// The tournament's front page.
//
// Built in the website's own order, because that order is an argument and it is
// a good one: the date, then anything live (streams, the latest announcement),
// then what is at stake, then how the thing is actually run, and only then the
// organiser's prose. A reader who stops after two panels has still learned when
// it is and what they would win.
//
// What differs from the website is the paint, not the shape: our tokens, our
// surfaces, and prose rendered through `RichText` into elements rather than
// through `innerHTML`.
//
// The Rules section that used to be a tab of its own is folded in here, which
// is also how the website has it: the rules *are* the briefing, and the two
// site-wide articles are links under it rather than a page of their own.

import { useState } from "react";
import { Icon } from "../../../design-system/Icon";
import type { Article, Tourney, TourneyMatch } from "../../../ipc/bindings";
import type { MessageKey } from "../../../i18n";
import { useTranslation } from "../../../i18n/useTranslation";
import { RichText } from "./RichText";
import {
  RATING_KIND_LABELS,
  formatDay,
  formatMoment,
  formatPrize,
  planSummary,
  ratingRequirements,
  typeLine,
} from "../tourneyPresentation";
import { unplacedImages } from "../../../shared/markdown";
import { eventDayCount, eventDaysLabel } from "../orientation";
import {
  RATING_CHECK_ID,
  recentResults,
  resultRoundLabel,
  roundMapNames,
  stopAtRemaining,
} from "../overviewPresentation";
import { RichLine } from "../RichLine";
import { swissMatchRecord, swissRecordsBefore } from "../bracket/swissRecords";
import { teamNameOf } from "../bracket/matchParts";
import { OFFICIAL_ARTICLES, type SitePage } from "../site/sitePages";

interface OverviewPanelProps {
  event: Tourney;
  /** The site-wide rules pages, shown under the briefing for an official event. */
  articles: Article[];
  /** Where the service lives, for the organiser's uploaded images. */
  assetBase: string;
  /**
   * Jump to another section, for the links that point at one. `focus` names an
   * element there to scroll to and flash, so a "click here" lands on the thing
   * rather than merely on the right tab.
   */
  onOpenSection: (section: "news" | "players" | "teams" | "matches", focus?: string) => void;
  onOpenUrl: (url: string) => void;
  /** Open one of the site's pages: the FAQ / Rules, a series. */
  onOpenPage?: (page: SitePage) => void;
}

/** A titled panel. Every block on this page is one, as on the website. */
function Panel({
  title,
  className,
  children,
}: {
  title?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={className === undefined ? "tournament-panel" : `tournament-panel ${className}`}>
      {title !== undefined && <h4>{title}</h4>}
      {children}
    </section>
  );
}

/** A labelled cell inside a panel: the website's `infocell`. */
function Cell({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className === undefined ? "tournament-cell" : `tournament-cell ${className}`}>
      <div className="tournament-cell-label">{label}</div>
      <div className="tournament-cell-body">{children}</div>
    </div>
  );
}

export function OverviewPanel({
  event,
  articles,
  assetBase,
  onOpenSection,
  onOpenUrl,
  onOpenPage,
}: OverviewPanelProps) {
  const { t } = useTranslation();
  const [showRules, setShowRules] = useState(false);

  const prize = formatPrize(event.prize);
  const requirements = ratingRequirements(event, t);
  const latest = event.news[0];

  // The one-line headline over the setup: official or community, nothing
  // else. Which rating counts and as of when used to share this line, where it
  // read as boilerplate; it is the first line of the Rating requirements cell
  // now, as on the website, because it is a requirement.
  const headline =
    event.category === "official"
      ? t("tournaments.overview.official")
      : t("tournaments.overview.community");
  const kind = t(RATING_KIND_LABELS[event.ratingKind]);
  const pulled = event.ratingKind !== "none";
  const ratingSource = !pulled
    ? ""
    : event.ratingDate !== null
      ? t("tournaments.overview.ratingSourceAsOf", { kind, date: formatDay(event.ratingDate, "") })
      : t("tournaments.overview.ratingSourceAtSignup", { kind });
  // An organiser's own invites and adds skip the range, which the service
  // enforces and they would otherwise find out by surprise.
  const exemptNote =
    event.viewer.organiser && (event.rating.min !== null || event.rating.max !== null);

  // The multi-day schedule and the early stop, each its own cell beside the
  // format: both change what the event *is*, a two-weekend event and a
  // qualifier that never plays its final.
  const days = eventDaysLabel(event.eventDays);
  const stopLeft = stopAtRemaining(event);

  // Anything the organiser uploaded but never placed in a body. Shown rather
  // than orphaned: on the website these are pasted screenshots, and one that
  // lost its reference is still the picture they meant to show.
  const gallery = unplacedImages(event.descImages, [
    event.description,
    event.rewards,
    event.sponsors,
    event.lobbyOptions,
  ]);

  return (
    <div className="tournament-overview">
      {event.eventDate !== null && (
        <div className="tournament-datebar">
          <span className="tournament-cell-label">
            {t(event.imported ? "tournaments.overview.played" : "tournaments.overview.eventDate")}
          </span>
          <span>{formatMoment(event.eventDate, "")}</span>
          {event.minTeams > 0 && (
            <span className="muted">
              {t("tournaments.overview.minTeams", { count: event.minTeams })}
            </span>
          )}
        </div>
      )}

      {/* An archive, not an event anybody can enter: said first, so nobody
          looks for the signup button of something played years ago. */}
      {event.imported && (
        <section className="tournament-panel tournament-imported">
          <div className="tournament-imported-label">{t("tournaments.overview.importedHeading")}</div>
          <p className="muted">
            {t("tournaments.overview.importedBody")}{" "}
            {event.sourceUrl !== "" && (
              <button type="button" className="rich-text-link" onClick={() => onOpenUrl(event.sourceUrl)}>
                {t("tournaments.overview.viewOnChallonge")}
              </button>
            )}
          </p>
        </section>
      )}

      {event.streams.length > 0 && (
        <Panel title={t("tournaments.overview.streams")}>
          <ul className="tournament-streams">
            {event.streams.map((stream) => (
              <li key={stream.url}>
                <button type="button" className="rich-text-link" onClick={() => onOpenUrl(stream.url)}>
                  <Icon name="play" size={14} /> {stream.url.replace(/^https?:\/\//, "")}
                </button>
                {stream.info !== "" && <span className="muted"> {stream.info}</span>}
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {/* The most recent announcement, on the page everyone opens first. The
          News section still holds all of them; this is the one that would
          otherwise be missed by a player who came to check the time. */}
      {latest !== undefined && event.status !== "finished" && (
        <Panel className={latest.important ? "is-important" : undefined}>
          <div className="tournament-cell-label">{t("tournaments.overview.latestNews")}</div>
          <RichText source={latest.body} assetBase={assetBase} />
          <button type="button" className="rich-text-link" onClick={() => onOpenSection("news")}>
            {t("tournaments.overview.allNews")}
          </button>
        </Panel>
      )}

      {event.championTeamId !== null && (
        <Panel className="tournament-champion">
          <div className="tournament-cell-label">{t("tournaments.overview.champion")}</div>
          <h3>{championName(event)}</h3>
        </Panel>
      )}

      {(prize !== "" || event.rewards.trim() !== "" || event.sponsors.trim() !== "") && (
        <div className="tournament-panel-row">
          {(prize !== "" || event.rewards.trim() !== "") && (
            <Panel title={t("tournaments.overview.rewards")}>
              {prize !== "" && (
                <Cell label={t("tournaments.overview.prize")} className="is-prize">
                  <span className="tournament-prize">{prize}</span>
                </Cell>
              )}
              <RichText source={event.rewards} assetBase={assetBase} />
            </Panel>
          )}
          {event.sponsors.trim() !== "" && (
            <Panel title={t("tournaments.overview.sponsors")}>
              <RichText source={event.sponsors} assetBase={assetBase} />
            </Panel>
          )}
        </div>
      )}

      <Panel title={t("tournaments.overview.gameSetup")}>
        <p className="tournament-setup-headline">{headline}</p>

        <div className="tournament-cells">
          <Cell label={t("tournaments.overview.format")}>
            <p>{typeLine(event, t)}</p>
            {planSummary(event, t) !== "" && <p className="muted">{planSummary(event, t)}</p>}
          </Cell>
          {days !== "" && (
            <Cell label={t("tournaments.overview.schedule")}>
              <p>
                <strong>{days}</strong>
              </p>
              <p>{t("tournaments.overview.scheduleDays", { count: eventDayCount(event.eventDays) })}</p>
              {event.eventDate !== null && (
                <p>{t("tournaments.overview.scheduleStarts", { when: formatMoment(event.eventDate, "") })}</p>
              )}
            </Cell>
          )}
          {event.stopAtAlive > 0 && (
            <Cell label={t("tournaments.overview.endsEarly")}>
              <p>{t("tournaments.overview.stopAtLine", { count: event.stopAtAlive })}</p>
              {event.earlyFinish !== null ? (
                <p className="muted">{t("tournaments.overview.stopAtReached")}</p>
              ) : (
                stopLeft !== null && (
                  <p className="muted">
                    {stopLeft === 0
                      ? t("tournaments.overview.stopAtLast")
                      : t("tournaments.overview.stopAtToGo", { count: stopLeft })}
                  </p>
                )
              )}
            </Cell>
          )}
          {(pulled || requirements.length > 0) && (
            <Cell label={t("tournaments.overview.ratingRequirements")}>
              {pulled && (
                <p className="tournament-rating-source">
                  <RichLine text={ratingSource} />
                  <span className="muted">{t("tournaments.overview.ratingSourcePulled")}</span>
                </p>
              )}
              {requirements.length > 0 && (
                <div className={pulled ? "tournament-cell-gap" : undefined}>
                  {requirements.map((line) => (
                    <p key={line}>{line}</p>
                  ))}
                  {exemptNote && <p>{t("tournaments.overview.organiserExempt")}</p>}
                </div>
              )}
              {/* The rating is fetched from FAF, so a player reading the range
                  has no way to know whether they clear it. The check is on the
                  Players section during signups; later the link still goes
                  there, as on the website, and lands on the list. */}
              {pulled && event.viewer.loggedIn && (
                <p className="muted tournament-cell-gap">
                  <RichLine
                    text={t("tournaments.overview.ratingUnknown")}
                    onLink={() => onOpenSection("players", RATING_CHECK_ID)}
                  />
                </p>
              )}
            </Cell>
          )}
        </div>

        {(event.lobbyOptions.trim() !== "" || event.mods.trim() !== "") && (
          <div className="tournament-cells">
            {event.lobbyOptions.trim() !== "" && (
              <Cell label={t("tournaments.overview.lobbyOptions")}>
                <RichText source={event.lobbyOptions} assetBase={assetBase} />
              </Cell>
            )}
            {event.mods.trim() !== "" && (
              <Cell label={t("tournaments.overview.mods")}>
                <RichText source={event.mods} assetBase={assetBase} />
              </Cell>
            )}
          </div>
        )}

        {event.description.trim() !== "" && (
          <Cell label={t("tournaments.overview.briefing")} className="is-wide">
            <RichText source={event.description} assetBase={assetBase} />
          </Cell>
        )}

        {gallery.length > 0 && assetBase !== "" && (
          <div className="tournament-gallery">
            {gallery.map((file) => (
              <img key={file} src={`${assetBase}/desc-images/${encodeURIComponent(file)}`} alt="" loading="lazy" />
            ))}
          </div>
        )}
      </Panel>

      {(event.feedsInto !== null || event.qualifiers.length > 0) && (
        <Panel title={t("tournaments.overview.qualification")}>
          {event.feedsInto !== null && <p>{feedsIntoLine(event, t)}</p>}
          {event.qualifiers.length > 0 && (
            <>
              <p className="muted">{t("tournaments.overview.drawsFrom")}</p>
              <ul className="tournament-qualifiers">
                {event.qualifiers.map((qualifier) => (
                  <li key={qualifier.id}>
                    {qualifier.name}
                    {qualifier.qualified.length > 0 && (
                      <span className="muted"> {qualifier.qualified.join(", ")}</span>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </Panel>
      )}

      {event.seriesName !== "" && (
        <Panel title={t("tournaments.overview.series")}>
          <p>
            {t("tournaments.overview.partOfSeriesBefore")}{" "}
            <strong className={`tournament-series-name is-${event.seriesColour}`}>{event.seriesName}</strong>{" "}
            {t("tournaments.overview.partOfSeriesAfter")}
          </p>
          {onOpenPage !== undefined && event.seriesId !== null && (
            <button
              type="button"
              className="tournament-link-button"
              onClick={() => onOpenPage({ kind: "series", seriesId: event.seriesId })}
            >
              {t("tournaments.overview.allEditions")} {"→"}
            </button>
          )}
        </Panel>
      )}

      {/* The website's Links panel: FAQ / Rules always, and for an official
          event the three articles every official event is played under. They
          open as pages of the client. Where the pages cannot be opened (no
          way back to the list), the articles are shown folded here. */}
      {onOpenPage !== undefined ? (
        <Panel title={t("tournaments.links.title")}>
          <ul className="tournament-links">
            <li>
              <button type="button" className="tournament-link-button" onClick={() => onOpenPage({ kind: "faq", articleId: null })}>
                {t("tournaments.site.faq")}
              </button>
            </li>
            {event.category === "official" &&
              OFFICIAL_ARTICLES.map((link) => (
                <li key={link.id}>
                  <button
                    type="button"
                    className="tournament-link-button"
                    onClick={() => onOpenPage({ kind: "faq", articleId: link.id })}
                  >
                    {t(link.label)}
                  </button>
                </li>
              ))}
          </ul>
        </Panel>
      ) : (
        event.category === "official" &&
        articles.length > 0 && (
          <Panel>
            <button
              type="button"
              className="tournament-disclosure"
              aria-expanded={showRules}
              onClick={() => setShowRules((open) => !open)}
            >
              <Icon name={showRules ? "chevronDown" : "chevronRight"} size={14} />
              {t("tournaments.overview.rules")}
            </button>
            {showRules &&
              articles.map((article) => (
                <section key={article.id} className="tournament-article">
                  <h5>{article.title}</h5>
                  <RichText source={article.body} assetBase={assetBase} />
                </section>
              ))}
          </Panel>
        )
      )}

      {statusLine(event, t) !== "" && (
        <Panel title={t("tournaments.overview.statusHeading")}>
          <p>{statusLine(event, t)}</p>
        </Panel>
      )}

      {/* The latest results, once there are matches to have results. Not
          hidden in streamer mode, as on the website: the Overview is where a
          caster's audience is not looking. */}
      {(event.status === "running" || event.status === "finished") && (
        <RecentResults event={event} onOpenMatches={() => onOpenSection("matches")} />
      )}
    </div>
  );
}

/** The website's Recent results panel: the eight latest done matches. */
function RecentResults({ event, onOpenMatches }: { event: Tourney; onOpenMatches: () => void }) {
  const { t } = useTranslation();
  const done = recentResults(event);
  return (
    <Panel title={t("tournaments.overview.recentResults")}>
      {done.length === 0 ? (
        <p className="muted">{t("tournaments.overview.noResults")}</p>
      ) : (
        <ol className="tournament-recent">
          {done.map((entry) => (
            <ResultRow key={entry.id} event={event} entry={entry} />
          ))}
        </ol>
      )}
      <p className="muted tournament-recent-footer">
        <RichLine text={t("tournaments.overview.recentFooter")} onLink={onOpenMatches} />
      </p>
    </Panel>
  );
}

/** One result: the round, the record it was paired on, who won, the maps. */
function ResultRow({ event, entry }: { event: Tourney; entry: TourneyMatch }) {
  const { t } = useTranslation();
  const record = swissMatchRecord(entry, swissRecordsBefore(event.matches, entry.round));
  const maps = roundMapNames(event, entry);
  const name = (teamId: string | null) => teamNameOf(event, teamId) ?? t("tournaments.bracket.tbd");
  // A walkover stores the forfeiting side's score as -1. The website prints
  // the number; FF is what it means.
  const score = (value: number | null) =>
    value !== null && value < 0 ? t("tournaments.match.forfeitShort") : String(value ?? 0);

  return (
    <li className="tournament-recent-row">
      <span className="tournament-recent-round mono">{resultRoundLabel(event, entry, t)}</span>
      {record !== null && (
        <span className="tournament-swiss-record mono" title={t("tournaments.swiss.recordHint")}>
          {record}
        </span>
      )}
      {entry.bracket === "freeForAll" ? (
        <span className="tournament-recent-teams">
          {entry.entrants.map((teamId, index) => (
            <span key={teamId}>
              {index > 0 && <span className="tournament-recent-vs"> · </span>}
              <span className={entry.winners.includes(teamId) ? "is-winner" : undefined}>{name(teamId)}</span>
            </span>
          ))}
        </span>
      ) : (
        <>
          <span className="tournament-recent-teams">
            <span className={entry.winner !== null && entry.winner === entry.team1 ? "is-winner" : undefined}>
              {name(entry.team1)}
            </span>
            <span className="tournament-recent-vs mono">{t("tournaments.swiss.vs")}</span>
            <span className={entry.winner !== null && entry.winner === entry.team2 ? "is-winner" : undefined}>
              {name(entry.team2)}
            </span>
          </span>
          {entry.score1 !== null && (
            <span className="tournament-recent-score mono">
              {score(entry.score1)} – {score(entry.score2)}
            </span>
          )}
        </>
      )}
      {maps.length > 0 && (
        <span className="mono muted tournament-recent-maps" title={t("tournaments.recent.maps")}>
          {maps.map((map, index) => t("tournaments.recent.gameMap", { game: index + 1, name: map })).join(" · ")}
        </span>
      )}
    </li>
  );
}

/** The champion's team name, or the id if the team has gone. */
function championName(event: Tourney): string {
  const team = event.teams.find((held) => held.id === event.championTeamId);
  if (team === undefined) return "";
  const named = team.name.trim();
  if (named !== "") return named;
  const first = event.players.find((player) => player.id === team.playerIds[0]);
  return first?.name ?? team.id;
}

/** What this event qualifies its entrants for. */
function feedsIntoLine(
  event: Tourney,
  t: (key: MessageKey, values?: Record<string, string | number>) => string,
): string {
  const feeds = event.feedsInto;
  if (feeds === null) return "";
  return t(
    feeds.rule.kind === "points"
      ? "tournaments.overview.feedsIntoPoints"
      : "tournaments.overview.feedsIntoTop",
    { count: feeds.rule.n, name: feeds.parentName },
  );
}

/**
 * Where the event stands, in a sentence.
 *
 * Only for the phases where the status is not obvious from the rest of the
 * page: during signups, where the useful fact is whether they are actually open
 * yet, and during a draft, where somebody is waiting on somebody.
 */
function statusLine(
  event: Tourney,
  t: (key: MessageKey, values?: Record<string, string | number>) => string,
): string {
  const now = Math.floor(Date.now() / 1000);
  if (event.status === "signup") {
    if (event.signupOpensAt !== null && now < event.signupOpensAt) {
      return t("tournaments.overview.statusNotOpen", {
        when: formatMoment(event.signupOpensAt, ""),
        count: event.playerCount,
      });
    }
    if (event.signupClosesAt !== null && now > event.signupClosesAt) {
      return t("tournaments.overview.statusClosed", { count: event.playerCount });
    }
    return t("tournaments.overview.statusOpen", { count: event.playerCount });
  }
  if (event.status === "draft" && event.draft !== null) {
    const turn = event.draft.order[event.draft.current];
    const team = event.teams.find((held) => held.id === turn);
    return t("tournaments.overview.statusDraft", { name: team?.name ?? "" });
  }
  return "";
}
