import { useState, type CSSProperties, type ReactNode } from "react";
import type { PlayerCardProfile, PlayerLeaguePlacement, PlayerRatingSummary } from "../../ipc/bindings";
import { Button } from "../../design-system/Button";
import { FactsStrip } from "../../design-system/FactsStrip";
import { Icon } from "../../design-system/Icon";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { PlayerNoteCard } from "../../shared/components/PlayerNoteEditor";
import { FactionIcon } from "../../shared/components/FactionIcon";
import { FACTION_COLORS, factionLabel } from "../../shared/factions";
import { formatNumber, t } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";
import { formatDate } from "../../shared/format/dates";
import { plainError } from "../../shared/plainError";
import { placementLabel, seasonLabel } from "../../shared/leagueNames";
import { leaderboardLabel } from "../../shared/playerRatings";
import { factionRecords } from "./PlayerStatistics";

function displayDate(value: string): string {
  return formatDate(value, t("common.notAvailable"));
}

export function formatUserAgent(userAgent?: string | null): string {
  if (!userAgent || !userAgent.trim()) return t("common.notAvailable");
  const trimmed = userAgent.trim();
  const lower = trimmed.toLowerCase();
  if (lower.includes("rust") || lower.includes("forge")) {
    return "Rust client";
  }
  if (lower.includes("python")) {
    return "Python client";
  }
  if (lower.includes("faf-client") || lower.includes("java") || lower.includes("downlord")) {
    return "Java client";
  }
  return trimmed;
}

/** One queue as the overview lists it: its rating, its league placement, or both. */
export interface QueueRow {
  technicalName: string;
  rating: PlayerRatingSummary | null;
  placement: PlayerLeaguePlacement | null;
}

/**
 * The profile's queues, one row each, with the league placement on the row of
 * the board it belongs to.
 *
 * Ratings and placements are two lists from two API resources, and the card
 * drew them as two sections: the 1v1 rating in one grid and the 1v1 division
 * two screens further down. They are the same queue. A placement whose board
 * has no rating still gets its row, after the rated ones. The backend sends
 * each player's placements highest division first, so the first one per
 * board is the one to show.
 *
 * `played` is what the overview shows at once: a queue somebody has a game
 * or a placement in. A queue with neither is still a row, behind "show all",
 * because "never played 3v3" is an answer somebody can be looking for.
 */
export function queueRows(profile: PlayerCardProfile): { played: QueueRow[]; unplayed: QueueRow[] } {
  const placementFor = new Map<string, PlayerLeaguePlacement>();
  for (const placement of profile.leaguePlacements) {
    if (!placementFor.has(placement.technicalName)) placementFor.set(placement.technicalName, placement);
  }
  const rows: QueueRow[] = profile.ratings.map((rating) => ({
    technicalName: rating.technicalName,
    rating,
    placement: placementFor.get(rating.technicalName) ?? null,
  }));
  const rated = new Set(rows.map((row) => row.technicalName));
  for (const [technicalName, placement] of placementFor) {
    if (!rated.has(technicalName)) rows.push({ technicalName, rating: null, placement });
  }
  const isPlayed = (row: QueueRow) => (row.rating?.gamesPlayed ?? 0) > 0 || row.placement !== null;
  return { played: rows.filter(isPlayed), unplayed: rows.filter((row) => !isPlayed(row)) };
}

/**
 * The queue's league as its emblem alone. The tier, season, score and games
 * are on hover and are the picture's name for a screen reader; a placement
 * without a picture says its tier in words instead.
 */
function QueueLeague({ placement }: { placement: PlayerLeaguePlacement }) {
  const { t } = useTranslation();
  const tier = placementLabel(placement) ?? t("lobby.matchmaker.unplaced");
  const title = `${tier}
${t("playerCard.queues.leagueTitle", {
    season: seasonLabel(placement.seasonNumber),
    score: placement.score,
    games: placement.gamesPlayed,
  })}`;
  if (!placement.imageUrl) return <span className="player-queue-league is-text" title={title}>{tier}</span>;
  return (
    <img
      className="player-queue-league"
      src={placement.imageUrl}
      alt={tier}
      title={title}
      width={48}
      height={48}
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={(event) => { event.currentTarget.hidden = true; }}
    />
  );
}

/**
 * One queue as a tile: its name and league in the head, the rating large with
 * the mean and deviation it is made of under it (the shown rating is the mean
 * less three deviations, so a high deviation explains a low number), and a
 * foot with the games it rests on and the way to its history graph.
 *
 * No win rate. The leaderboard's won-games count is not reliable, and the
 * figures that are (the map record's scan) take far too long to wait for on
 * a card that is opened to be read at a glance.
 */
function QueueTile({ row, onOpenHistory }: {
  row: QueueRow;
  onOpenHistory: (rating: PlayerRatingSummary) => void;
}) {
  const { t } = useTranslation();
  const { rating } = row;
  const content = (
    <>
      <span className="player-queue-head">
        <span className="player-queue-name">{leaderboardLabel(row.technicalName)}</span>
        {row.placement && <QueueLeague placement={row.placement} />}
      </span>
      <span className="player-queue-body">
        <span className={`player-queue-rating${rating ? "" : " is-empty"}`}>
          {/* Without a thousands separator, as the leaderboard and every other
              rating in the client writes it. */}
          {rating ? String(Math.round(rating.rating)) : "-"}
        </span>
        {rating && rating.mean !== null && rating.deviation !== null && (
          <span className="player-queue-skill muted">
            {t("playerCard.queues.ratingTitle", { mean: rating.mean.toFixed(0), deviation: rating.deviation.toFixed(0) })}
          </span>
        )}
      </span>
      <span className="player-queue-foot">
        <span className="player-queue-games">
          {rating
            ? t("playerCard.queues.gamesCount", { count: rating.gamesPlayed, games: formatNumber(rating.gamesPlayed) })
            : t("playerCard.queues.noGames")}
        </span>
        {rating && (
          <span className="player-queue-graph">
            <Icon name="activity" size={13} />
            {t("playerCard.tab.ratings")}
          </span>
        )}
      </span>
    </>
  );
  // The whole tile opens the queue's history, where the old tiles had a
  // "View history" line in each.
  return rating ? (
    <button
      type="button"
      className="player-queue-tile surface-panel is-link"
      aria-label={t("playerCard.rating.viewHistoryAria", { queue: leaderboardLabel(row.technicalName) })}
      onClick={() => onOpenHistory(rating)}
    >
      {content}
    </button>
  ) : (
    <div className="player-queue-tile surface-panel">{content}</div>
  );
}

/**
 * How many columns the queue tiles take.
 *
 * The tiles run across the whole card, so every queue a player normally has
 * (up to six) fits one row, all the same size. Fewer than four still get a
 * quarter each, so a player with one queue does not get one tile the width of
 * the card. More than six, which only "show all" produces, split over two rows.
 */
export function queueTileColumns(count: number): number {
  if (count <= 6) return Math.max(count, 4);
  return Math.ceil(count / 2);
}

function QueueTiles({ profile, onOpenHistory }: {
  profile: PlayerCardProfile;
  onOpenHistory: (rating: PlayerRatingSummary) => void;
}) {
  const { t } = useTranslation();
  const [showAll, setShowAll] = useState(false);
  const { played, unplayed } = queueRows(profile);
  const rows = showAll ? [...played, ...unplayed] : played;
  return (
    <section className="player-overview-section player-overview-ratings">
      <header className="player-overview-section-head">
        <h3>{t("playerCard.queues.title")}</h3>
      </header>
      {rows.length === 0 ? (
        <p className="player-overview-empty muted">{t("playerCard.queues.none")}</p>
      ) : (
        <div className="player-queue-grid" style={{ "--queue-columns": queueTileColumns(rows.length) } as CSSProperties}>
          {rows.map((row) => <QueueTile key={row.technicalName} row={row} onOpenHistory={onOpenHistory} />)}
        </div>
      )}
      {unplayed.length > 0 && (
        <div className="player-overview-more">
          <Button onClick={() => setShowAll((value) => !value)} aria-expanded={showAll}>
            <Icon name={showAll ? "chevronUp" : "chevronDown"} size={14} />
            {showAll
              ? t("playerCard.queues.hideUnplayed")
              : t("playerCard.queues.showUnplayed", { count: unplayed.length })}
          </Button>
        </div>
      )}
    </section>
  );
}

/**
 * Which faction the player picks, as one bar split by games and a line per
 * faction under it. The numbers are the statistics tab's faction chart; this
 * is the glance, that is the detail.
 */
function FactionSummary({ profile, onOpenStatistics }: {
  profile: PlayerCardProfile;
  onOpenStatistics: () => void;
}) {
  const { t } = useTranslation();
  const records = factionRecords(profile)
    .filter((record) => record.games > 0)
    .sort((left, right) => right.games - left.games);
  const total = records.reduce((sum, record) => sum + record.games, 0);
  if (total === 0) return null;
  return (
    <section className="player-overview-card surface-panel">
      <CardHead
        action={(
          <Button className="player-card-head-action" onClick={onOpenStatistics}>
            {t("playerCard.factions.allStatistics")}
            <Icon name="arrowRight" size={13} />
          </Button>
        )}
      >
        {t("playerCard.factions.title")}
      </CardHead>
      <div className="player-faction-summary">
        <div className="player-faction-bar" aria-hidden>
          {records.map((record) => (
            <span
              key={record.faction}
              style={{ flexGrow: record.games, background: FACTION_COLORS[record.faction] }}
            />
          ))}
        </div>
        <ul className="player-faction-list">
          {records.map((record) => (
            <li key={record.faction}>
              <FactionIcon faction={record.faction} size={16} aria-hidden="true" role="presentation" />
              <span className="player-faction-name">{factionLabel(record.faction)}</span>
              <span className="player-faction-share">{Math.round((record.games / total) * 100)}%</span>
              <span className="player-faction-detail muted">
                {t("playerCard.factions.detail", {
                  games: formatNumber(record.games),
                  rate: Math.round((record.wins / record.games) * 100),
                })}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/** A card's heading, with an optional count after it and an action at its end. */
function CardHead({ children, count, action }: { children: string; count?: number; action?: ReactNode }) {
  return (
    <header className="player-overview-card-head">
      <h3>
        {children}
        {count !== undefined && <span className="player-overview-count">{formatNumber(count)}</span>}
      </h3>
      {action}
    </header>
  );
}

function ClanBlock({ profile, isMe, onOpenClan }: {
  profile: PlayerCardProfile;
  isMe: boolean;
  onOpenClan: () => void;
}) {
  const { t } = useTranslation();
  const { clan } = profile;
  // Somebody else's card says nothing about a clan they are not in: the
  // header already shows no tag. Your own says it, because the clan tab is
  // where one is founded or joined.
  if (!clan && !isMe) return null;
  return (
    <section className="player-overview-card surface-panel">
      <CardHead>{t("playerCard.overview.clan")}</CardHead>
      {clan ? (
        <button type="button" className="player-overview-clan" onClick={onOpenClan}>
          <span className="player-overview-clan-name">
            <span className="player-overview-clan-tag">[{clan.tag}]</span>
            {clan.name}
          </span>
          <span className="muted">
            {t("playerCard.clanSummary.meta", {
              date: displayDate(clan.joinedAt),
              count: clan.members.length,
            })}
          </span>
          <Icon name="chevronRight" size={14} className="player-overview-clan-go" />
        </button>
      ) : (
        <div className="player-overview-row">
          <span className="muted">{t("playerCard.overview.noClan")}</span>
          <Button onClick={onOpenClan}>{t("playerCard.clanSummary.findOne")}</Button>
        </div>
      )}
    </section>
  );
}

/** The latest few former names; the whole list is the names tab. */
function FormerNames({ profile, onOpenNames }: { profile: PlayerCardProfile; onOpenNames: () => void }) {
  const { t } = useTranslation();
  if (profile.names.length === 0) return null;
  const newestFirst = [...profile.names].sort((left, right) => right.changeTime.localeCompare(left.changeTime));
  const shown = newestFirst.slice(0, 3);
  return (
    <section className="player-overview-card surface-panel">
      <CardHead
        count={profile.names.length}
        action={newestFirst.length > 3 && (
          <Button className="player-card-head-action" onClick={onOpenNames}>
            {t("playerCard.names.showAll", { count: newestFirst.length })}
            <Icon name="arrowRight" size={13} />
          </Button>
        )}
      >
        {t("playerCard.tab.names")}
      </CardHead>
      <ul className="player-former-names">
        {shown.map((record) => (
          <li key={`${record.name}-${record.changeTime}`}>
            <span>{record.name}</span>
            <span className="muted" title={displayDate(record.changeTime)}>
              {t("playerCard.names.until", { date: formatDate(record.changeTime, t("common.notAvailable"), { year: "numeric", month: "short" }) })}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Avatars({ profile, selectable }: { profile: PlayerCardProfile; selectable: boolean }) {
  const { t } = useTranslation();
  const selecting = useAppStore((store) => store.state.lobby.avatarSelectionStatus === "loading");
  // The same command the avatar picker sends. The server has no
  // acknowledgement for it, so the card marks the new one at once from
  // `avatarSelected` rather than waiting for a reload.
  const wear = (url: string | null) => ipc.send({ kind: "Lobby", command: { type: "selectAvatar", payload: { url } } });
  if (profile.avatars.length === 0) return null;
  const worn = profile.avatars.find((avatar) => avatar.selected);
  const nameOf = (tooltip: string) => tooltip || t("playerCard.overview.avatarFallback");
  return (
    <section className="player-overview-card surface-panel">
      <CardHead count={profile.avatars.length}>{t("playerCard.overview.avatarsEyebrow")}</CardHead>
      <div className="player-avatar-strip">
        {/* Taking the avatar off, which the separate picker used to be the
            only way to do. Only on your own card. */}
        {selectable && (
          <button
            type="button"
            className={`player-avatar-tile${worn ? "" : " is-selected"}`}
            aria-pressed={!worn}
            title={t("playerCard.avatar.none")}
            aria-label={t("playerCard.avatar.none")}
            disabled={selecting}
            onClick={() => { if (worn) wear(null); }}
          >
            <span className="player-avatar-empty" aria-hidden />
          </button>
        )}
        {profile.avatars.map((avatar, index) => {
          const name = nameOf(avatar.tooltip);
          const title = avatar.expiresAt
            ? `${name}\n${t("playerCard.overview.avatarExpires", { date: displayDate(avatar.expiresAt) })}`
            : name;
          const picture = avatar.url
            ? <img src={avatar.url} alt="" width={40} height={20} loading="lazy" decoding="async" draggable={false} />
            : <span className="player-avatar-empty" aria-hidden />;
          const className = `player-avatar-tile${avatar.selected ? " is-selected" : ""}`;
          // On your own card each one is a button that puts it on; the one
          // you wear already is pressed and does nothing more.
          return selectable && avatar.url ? (
            <button
              type="button"
              className={className}
              key={`${avatar.url}-${index}`}
              title={avatar.selected ? title : `${t("playerCard.overview.wearAvatar", { name })}${avatar.expiresAt ? `\n${t("playerCard.overview.avatarExpires", { date: displayDate(avatar.expiresAt) })}` : ""}`}
              aria-label={name}
              aria-pressed={avatar.selected}
              disabled={selecting}
              onClick={() => { if (!avatar.selected) wear(avatar.url); }}
            >
              {picture}
            </button>
          ) : (
            <span className={className} key={`${avatar.url}-${index}`} title={title} role="img" aria-label={name}>
              {picture}
            </span>
          );
        })}
      </div>
      {/* The pictures carry no words, so the one worn is named under them. */}
      <p className="player-avatar-caption muted">
        {worn
          ? t("playerCard.avatar.wearing", { name: nameOf(worn.tooltip) })
          : t("playerCard.avatar.wearingNone")}
      </p>
      {/* Said where avatars are chosen, because the fallback acts without
          asking: the request came from a player who could not tell whether
          it already existed. Own card only; nobody else's choice is kept. */}
      {selectable && <p className="player-avatar-hint muted">{t("playerCard.avatar.fallbackHint")}</p>}
    </section>
  );
}

export function PlayerOverview({ profile, note, isMe = false, onOpenHistory, onOpenTab }: {
  profile: PlayerCardProfile;
  note: string;
  /** Your own card: a click on an assigned avatar wears it, and the clan block offers founding one. */
  isMe?: boolean;
  onOpenHistory: (rating: PlayerRatingSummary) => void;
  onOpenTab: (tab: "statistics" | "clan" | "names") => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="player-overview">
      {(profile.matchedFormerName || profile.warnings.length > 0) && (
        <div className="player-overview-notices">
          {/* Said up front, because a released name can belong to somebody else
              now: this is the account that gave it up last, not necessarily the
              person the reader has in mind. */}
          {profile.matchedFormerName && (
            <p className="player-card-former-name surface">
              <Icon name="info" size={14} />
              <span>{t("playerCard.overview.foundByFormerName", { name: profile.matchedFormerName, login: profile.login })}</span>
            </p>
          )}
          {profile.warnings.length > 0 && (
            <details className="player-card-warnings surface">
              <summary>{t("playerCard.overview.warnings")}</summary>
              {/* Each warning is "section: reason" from the backend. The section
                  stays as sent; the reason is worded plainly, with the original
                  on hover, as every other failure in the client is. */}
              <ul>
                {profile.warnings.map((warning) => {
                  const split = warning.indexOf(": ");
                  const section = split > 0 ? warning.slice(0, split) : "";
                  const reason = split > 0 ? warning.slice(split + 2) : warning;
                  return (
                    <li key={warning} title={warning}>
                      {section ? `${section}: ${plainError(reason)}` : plainError(reason)}
                    </li>
                  );
                })}
              </ul>
            </details>
          )}
        </div>
      )}

      {/* Across the whole card: the ratings are what it is opened for, and at
          full width every queue fits one row. */}
      <QueueTiles profile={profile} onOpenHistory={onOpenHistory} />

      {/* Everything else as cards in two columns that even themselves out,
          so neither side runs on with the other empty beside it, whichever
          of these a profile has. */}
      <div className="player-overview-cards">
        <FactionSummary profile={profile} onOpenStatistics={() => onOpenTab("statistics")} />
        {/* A private note is about somebody else; your own card has none. */}
        {!isMe && <PlayerNoteCard playerId={profile.playerId} login={profile.login} note={note} />}
        <ClanBlock profile={profile} isMe={isMe} onOpenClan={() => onOpenTab("clan")} />
        <section className="player-overview-card surface-panel is-facts">
          <CardHead>{t("playerCard.overview.accountEyebrow")}</CardHead>
          <FactsStrip
            columns={3}
            groups={[{
              facts: [
                { id: "id", label: t("playerCard.overview.playerId"), value: profile.playerId },
                { id: "registered", label: t("playerCard.overview.registered"), value: displayDate(profile.registeredAt), unknown: !profile.registeredAt },
                {
                  id: "client",
                  label: t("playerCard.overview.client"),
                  value: <span title={profile.userAgent || undefined}>{formatUserAgent(profile.userAgent)}</span>,
                  unknown: !profile.userAgent.trim(),
                },
              ],
            }]}
          />
        </section>
        <FormerNames profile={profile} onOpenNames={() => onOpenTab("names")} />
        <Avatars profile={profile} selectable={isMe} />
      </div>
    </div>
  );
}
