// The tournament's front page.
//
// Built in the website's own order, because that order is an argument and it is
// a good one: anything live (the latest announcement), then what is at stake,
// then how the thing is actually run, and only then the organiser's prose. The
// date and the livestreams are facts in the hero's strip, over every section. A reader who stops after two panels has still learned when
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
import { Button } from "../../../design-system/Button";
import { Icon } from "../../../design-system/Icon";
import type { Article, Tourney, TourneyMatch } from "../../../ipc/bindings";
import type { MessageKey } from "../../../i18n";
import { useTranslation } from "../../../i18n/useTranslation";
import { RichText } from "./RichText";
import { formatMoment, formatPrize } from "../tourneyPresentation";
import { unplacedImages } from "../../../shared/markdown";
import { eventDayCount, eventDaysLabel } from "../orientation";
import {
  formatCells,
  recentResults,
  resultRoundLabel,
  rewardSplit,
  roundMapNames,
  stopAtRemaining,
} from "../overviewPresentation";
import { RichLine } from "../RichLine";
import { swissMatchRecord, swissRecordsBefore } from "../bracket/swissRecords";
import { teamNameOf } from "../bracket/matchParts";
import { divisionLabel } from "../bracket/bracketPresentation";
import { swissDivisionEvent, swissDivisions } from "../bracket/swissPresentation";
import { OFFICIAL_ARTICLES, type SitePage } from "../site/sitePages";
import { ProposalCredit } from "./ProposalBox";

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

  const latest = event.news[0];
  const rewards = rewardSplit(event.rewards, formatPrize(event.prize));

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
      {/* Two columns: how the event is run on the left, read top to bottom,
          and what is at stake and where to go next in a narrower column on
          the right. The date and the floor the event runs with are the first
          facts of the hero's strip, over every section. */}
      <div className="tournament-overview-main">
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

        {/* Who proposed it, once the TD team runs it (#569): where the
            website puts it, after the imported note. */}
        <ProposalCredit event={event} />

        {/* The most recent announcement, as one strip on the page everyone
            opens first. The News section still holds all of them; this is the
            one that would otherwise be missed by a player who came to check
            the time. */}
        {latest !== undefined && event.status !== "finished" && (
          <section className={latest.important ? "tournament-panel tournament-latest is-important" : "tournament-panel tournament-latest"}>
            <div className="tournament-overview-panel-heading">
              <div className="tournament-latest-head">
                <h4>{t("tournaments.overview.latestNews")}</h4>
                {latest.at !== null && <span className="tournament-latest-when">{formatMoment(latest.at, "")}</span>}
              </div>
              <Button onClick={() => onOpenSection("news")}>
                {t("tournaments.overview.allNews")}
                <Icon name="arrowRight" size={14} />
              </Button>
            </div>
            <RichText source={latest.body} assetBase={assetBase} className="tournament-latest-body" />
          </section>
        )}

        {/* A Swiss in divisions crowns one champion per division (#773):
            each its own panel, the top division's first. */}
        {swissDivisions(event).length > 0
          ? swissDivisions(event)
              .map((division) => ({ division, own: swissDivisionEvent(event, division) }))
              .filter(({ own }) => own.championTeamId !== null)
              .map(({ division, own }) => (
                <Panel className="tournament-champion" key={division}>
                  <Icon name="trophy" size={26} className="tournament-champion-icon" />
                  <div>
                    <div className="tournament-cell-label">
                      {t("tournaments.overview.divisionChampion", { division: divisionLabel(division, t) })}
                    </div>
                    <h3>{championName(own)}</h3>
                  </div>
                </Panel>
              ))
          : event.championTeamId !== null && (
              <Panel className="tournament-champion">
                <Icon name="trophy" size={26} className="tournament-champion-icon" />
                <div>
                  <div className="tournament-cell-label">{t("tournaments.overview.champion")}</div>
                  <h3>{championName(event)}</h3>
                </div>
              </Panel>
            )}

        {/* The format as a label and a value a row, the shape of the game
            setup under it. It was three large values over their labels side
            by side, which put the match format's three lines beside two
            words. The schedule and an early stop are rows of it: both change
            what the event *is*, a two-weekend event and a qualifier that
            never plays its final. */}
        <Panel title={t("tournaments.overview.tournamentFormat")}>
          <dl className="tournament-rule-table">
            {formatCells(event, t).map((cell) => (
              <div key={cell.label}>
                <dt>{t(cell.label)}</dt>
                <dd>{cell.value}</dd>
              </div>
            ))}
            {days !== "" && (
              <div>
                <dt>{t("tournaments.overview.schedule")}</dt>
                <dd>
                  <span>{days}</span>
                  <span className="muted">
                    {t("tournaments.overview.scheduleDays", { count: eventDayCount(event.eventDays) })}
                    {event.eventDate !== null &&
                      ` · ${t("tournaments.overview.scheduleStarts", { when: formatMoment(event.eventDate, "") })}`}
                  </span>
                </dd>
              </div>
            )}
            {event.stopAtAlive > 0 && (
              <div>
                <dt>{t("tournaments.overview.endsEarly")}</dt>
                <dd>
                  <span>{t("tournaments.overview.stopAtLine", { count: event.stopAtAlive })}</span>
                  {event.earlyFinish !== null ? (
                    <span className="muted">{t("tournaments.overview.stopAtReached")}</span>
                  ) : (
                    stopLeft !== null && (
                      <span className="muted">
                        {stopLeft === 0
                          ? t("tournaments.overview.stopAtLast")
                          : t("tournaments.overview.stopAtToGo", { count: stopLeft })}
                      </span>
                    )
                  )}
                </dd>
              </div>
            )}
          </dl>
        </Panel>

        {/* The rules a game is played under: the organiser's lobby options
            and mods, side by side, each as the formatted text it was written
            as. The website's `drawOverview` layout. The lobby options used to
            be split at their colons into a table of settings, which broke on
            the first name that held a colon itself ("Random Events:
            Interval": 90 seconds) and scattered the mods into a row of
            their own (issue 608). The rating limit is not a game setting but
            a condition of entry: the hero's strip states it over every
            section, and the Players section carries its details and the
            check. */}
        {(event.lobbyOptions.trim() !== "" || event.mods.trim() !== "") && (
          <Panel title={t("tournaments.overview.gameSetup")}>
            <div className="tournament-setup-cells">
              {event.lobbyOptions.trim() !== "" && (
                <section>
                  <h4 className="tournament-cell-label">{t("tournaments.overview.lobbyOptions")}</h4>
                  <RichText source={event.lobbyOptions} assetBase={assetBase} />
                </section>
              )}
              {event.mods.trim() !== "" && (
                <section>
                  <h4 className="tournament-cell-label">{t("tournaments.overview.mods")}</h4>
                  <RichText source={event.mods} assetBase={assetBase} />
                </section>
              )}
            </div>
          </Panel>
        )}

        {event.description.trim() !== "" && (
          <Panel title={t("tournaments.overview.briefing")}>
            <RichText source={event.description} assetBase={assetBase} className="is-document" />
            {gallery.length > 0 && assetBase !== "" && (
              <div className="tournament-gallery">
                {gallery.map((file) => (
                  <img key={file} src={`${assetBase}/desc-images/${encodeURIComponent(file)}`} alt="" loading="lazy" />
                ))}
              </div>
            )}
          </Panel>
        )}

        {/* The latest results, once there are matches to have results. Not
            hidden in streamer mode, as on the website: the Overview is where a
            caster's audience is not looking. */}
        {(event.status === "running" || event.status === "finished") && (
          <RecentResults event={event} onOpenMatches={() => onOpenSection("matches")} />
        )}

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
      </div>

      <aside className="tournament-overview-aside">
        {/* What each placement wins. The hero states the total over every
            section; this is the split behind it, read out of the organiser's
            text, with whatever is not a placement left as their words. */}
        {(rewards.places.length > 0 || rewards.notes !== "") && (
          <Panel title={t("tournaments.overview.rewards")}>
            {rewards.places.length > 0 && (
              <ol className="tournament-reward-places">
                {rewards.places.map((place, index) => (
                  <li
                    key={index}
                    className={!place.top && place.place <= 3 ? `is-place-${place.place}` : undefined}
                  >
                    <span className="tournament-reward-medal">
                      {place.top ? t("tournaments.overview.rewardTop", { count: place.place }) : place.place}
                    </span>
                    <span className="tournament-reward-what">
                      {place.rest !== "" && <RichLine text={place.rest} />}
                    </span>
                    {place.cash !== "" && <span className="tournament-reward-cash">{place.cash}</span>}
                  </li>
                ))}
              </ol>
            )}
            {rewards.notes !== "" && (
              <RichText source={rewards.notes} assetBase={assetBase} className="tournament-reward-notes" />
            )}
          </Panel>
        )}

        {event.sponsors.trim() !== "" && (
          <Panel title={t("tournaments.overview.sponsors")}>
            <RichText source={event.sponsors} assetBase={assetBase} />
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
            event the three articles every official event is played under.
            They open as pages of the client. Where the pages cannot be opened
            (no way back to the list), the articles are shown folded here. */}
        {onOpenPage !== undefined ? (
          <Panel title={t("tournaments.links.title")}>
            <ul className="tournament-link-rows">
              <li>
                <button type="button" onClick={() => onOpenPage({ kind: "faq", articleId: null })}>
                  <span>{t("tournaments.site.faq")}</span>
                  <Icon name="chevronRight" size={14} />
                </button>
              </li>
              {event.category === "official" &&
                OFFICIAL_ARTICLES.map((link) => (
                  <li key={link.id}>
                    <button type="button" onClick={() => onOpenPage({ kind: "faq", articleId: link.id })}>
                      <span>{t(link.label)}</span>
                      <Icon name="chevronRight" size={14} />
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
      </aside>
    </div>
  );
}

/** The eight latest completed matches. */
function RecentResults({ event, onOpenMatches }: { event: Tourney; onOpenMatches: () => void }) {
  const { t } = useTranslation();
  const done = recentResults(event);
  const title = t("tournaments.overview.recentResults");
  return (
    <section className="tournament-panel tournament-results-panel" aria-label={title}>
      <div className="tournament-overview-panel-heading">
        <h4>{title}</h4>
        <Button onClick={onOpenMatches}>
          {t("tournaments.section.matches")}
          <Icon name="arrowRight" size={14} />
        </Button>
      </div>
      {done.length === 0 ? (
        <p className="muted">{t("tournaments.overview.noResults")}</p>
      ) : (
        <ol className="tournament-recent">
          {done.map((entry) => (
            <ResultRow key={entry.id} event={event} entry={entry} />
          ))}
        </ol>
      )}
    </section>
  );
}

function ResultRow({ event, entry }: { event: Tourney; entry: TourneyMatch }) {
  const { t } = useTranslation();
  const record = swissMatchRecord(entry, swissRecordsBefore(event.matches, entry.round));
  const maps = roundMapNames(event, entry);
  const name = (teamId: string | null) => teamNameOf(event, teamId) ?? t("tournaments.bracket.tbd");
  const side = (teamId: string | null) => (
    <span className={teamId !== null && teamId === entry.winner ? "is-winner" : undefined}>
      <bdi>{name(teamId)}</bdi>
    </span>
  );
  // A walkover stores the forfeiting side's score as -1.
  const score = (value: number | null) =>
    value !== null && value < 0 ? t("tournaments.match.forfeitShort") : String(value ?? 0);

  return (
    <li className="tournament-recent-row">
      <div className="tournament-recent-stage">
        <span className="tournament-recent-round">{resultRoundLabel(event, entry, t)}</span>
        {event.divisions > 1 && entry.division > 0 && (
          <span>{divisionLabel(entry.division, t)}</span>
        )}
      </div>
      <div className="tournament-recent-result">
        {entry.bracket === "freeForAll" ? (
          <div className="tournament-recent-entrants">
            {entry.entrants.map((teamId, index) => (
              <span key={teamId}>
                {index > 0 && " · "}
                <bdi className={entry.winners.includes(teamId) ? "is-winner" : undefined}>{name(teamId)}</bdi>
              </span>
            ))}
          </div>
        ) : (
          <div className="tournament-recent-matchup">
            {side(entry.team1)}
            {entry.score1 === null ? (
              <span className="tournament-recent-vs">{t("tournaments.swiss.vs")}</span>
            ) : (
              <span className="tournament-recent-score" dir="ltr">
                {`${score(entry.score1)} – ${score(entry.score2)}`}
              </span>
            )}
            {side(entry.team2)}
          </div>
        )}
        {(record !== null || maps.length > 0) && (
          <div className="tournament-recent-meta">
            {maps.length > 0 && (
              <span title={t("tournaments.recent.maps")}>
                {maps.length === 1
                  ? maps[0]
                  : maps.map((map, index) => t("tournaments.recent.gameMap", { game: index + 1, name: map })).join(" · ")}
              </span>
            )}
            {record !== null && (
              <span title={t("tournaments.swiss.recordHint")}>{t("tournaments.swiss.group", { record })}</span>
            )}
          </div>
        )}
      </div>
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
