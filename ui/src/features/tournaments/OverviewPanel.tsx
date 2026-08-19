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
import { Icon } from "../../design-system/Icon";
import type { Article, Tourney } from "../../ipc/bindings";
import type { MessageKey } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";
import { RichText } from "./RichText";
import {
  RATING_KIND_LABELS,
  formatMoment,
  formatPrize,
  planSummary,
  ratingRequirements,
  typeLine,
} from "./tourneyPresentation";
import { unplacedImages } from "../../shared/markdown";

interface OverviewPanelProps {
  event: Tourney;
  /** The site-wide rules pages, shown under the briefing for an official event. */
  articles: Article[];
  /** Where the service lives, for the organiser's uploaded images. */
  assetBase: string;
  /** Jump to another section, for the links that point at one. */
  onOpenSection: (section: "news" | "players" | "teams") => void;
  onOpenUrl: (url: string) => void;
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
}: OverviewPanelProps) {
  const { t } = useTranslation();
  const [showRules, setShowRules] = useState(false);

  const prize = formatPrize(event.prize);
  const requirements = ratingRequirements(event, t);
  const latest = event.news[0];

  // The one-line headline over the setup: what kind of event, and which rating
  // it runs on. Where the rating comes from matters more than which one it is:
  // an event that fetches from FAF and one where players type their own number
  // are different competitions.
  const kind = t(RATING_KIND_LABELS[event.ratingKind]);
  const headline = [
    event.category === "official"
      ? t("tournaments.overview.official")
      : t("tournaments.overview.community"),
    event.ratingKind === "none"
      ? t("tournaments.overview.ratingSelfEntered")
      : event.ratingDate !== null
        ? t("tournaments.overview.ratingPulled", {
            kind,
            date: formatMoment(event.ratingDate, ""),
          })
        : t("tournaments.overview.ratingAtSignup", { kind }),
  ].join(" · ");

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
          <span className="tournament-cell-label">{t("tournaments.overview.eventDate")}</span>
          <span>{formatMoment(event.eventDate, "")}</span>
          {event.minTeams > 0 && (
            <span className="muted">
              {t("tournaments.overview.minTeams", { count: event.minTeams })}
            </span>
          )}
        </div>
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
          {requirements.length > 0 && (
            <Cell label={t("tournaments.overview.ratingRequirements")}>
              {requirements.map((line) => (
                <p key={line}>{line}</p>
              ))}
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
          <p>{t("tournaments.overview.partOfSeries", { name: event.seriesName })}</p>
        </Panel>
      )}

      {/* The rules that used to be a tab. Folded rather than deleted: they are
          long, they are the same three articles for every official event, and
          nobody reads them twice. */}
      {event.category === "official" && articles.length > 0 && (
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
      )}

      {statusLine(event, t) !== "" && (
        <Panel title={t("tournaments.overview.statusHeading")}>
          <p>{statusLine(event, t)}</p>
        </Panel>
      )}
    </div>
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
