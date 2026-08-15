import type { PlayerCardProfile, PlayerRatingSummary } from "../../ipc/bindings";
import { Icon } from "../../design-system/Icon";
import { PlayerNoteCard } from "./PlayerNoteEditor";
import { formatNumber } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";
import { formatDateTime } from "../../shared/dates";

function displayDate(value: string): string {
  return formatDateTime(value, "N/A");
}

export function RatingSummaryCard({ rating, onOpenHistory }: {
  rating: PlayerRatingSummary;
  onOpenHistory: (rating: PlayerRatingSummary) => void;
}) {
  const { t } = useTranslation();
  const winRate = rating.gamesPlayed > 0 ? (rating.wonGames / rating.gamesPlayed) * 100 : 0;
  return (
    <button
      type="button"
      className="player-rating-summary surface-panel surface-interactive"
      aria-label={t("playerCard.rating.viewHistoryAria", { queue: rating.name })}
      onClick={() => onOpenHistory(rating)}
    >
      <span className="player-card-eyebrow">{rating.name}</span>
      <div className="player-rating-value">
        <strong>{rating.rating}</strong>
        <span><small>{t("playerCard.rating.meanDeviation")}</small>{rating.mean?.toFixed(0) ?? "N/A"} ± {rating.deviation?.toFixed(0) ?? "N/A"}</span>
      </div>
      <dl>
        <div><dt>{t("playerCard.rating.games")}</dt><dd>{formatNumber(rating.gamesPlayed)}</dd></div>
        <div><dt>{t("playerCard.rating.won")}</dt><dd>{formatNumber(rating.wonGames)}</dd></div>
        <div><dt>{t("playerCard.rating.winRate")}</dt><dd>{winRate.toFixed(1)}%</dd></div>
      </dl>
      <span className="player-rating-link">{t("playerCard.rating.viewHistory")} <Icon name="arrowRight" size={13} /></span>
    </button>
  );
}

export function PlayerOverview({ profile, note, onEditNote, onOpenHistory }: {
  profile: PlayerCardProfile;
  note: string;
  onEditNote: () => void;
  onOpenHistory: (rating: PlayerRatingSummary) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="player-overview">
      {profile.warnings.length > 0 && (
        <details className="player-card-warnings surface">
          <summary>{t("playerCard.overview.warnings")}</summary>
          <ul>{profile.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
        </details>
      )}

      <section>
        <div className="player-card-section-heading"><div><span className="player-card-eyebrow">{t("playerCard.overview.ratingsEyebrow")}</span><h3>{t("playerCard.overview.ratingsTitle")}</h3></div><span className="muted">{t("playerCard.overview.ratingsHint")}</span></div>
        <div className="player-rating-grid">
          {profile.ratings.map((rating) => <RatingSummaryCard key={rating.leaderboardId} rating={rating} onOpenHistory={onOpenHistory} />)}
        </div>
      </section>

      <PlayerNoteCard note={note} onEdit={onEditNote} />
      <section className="player-account-card surface-panel">
        <div>
          <span className="player-card-eyebrow">{t("playerCard.overview.accountEyebrow")}</span>
          <dl className="player-account-details surface">
            <div><dt>{t("playerCard.overview.playerId")}</dt><dd>{profile.playerId}</dd></div>
            <div><dt>{t("playerCard.overview.registered")}</dt><dd>{displayDate(profile.registeredAt)}</dd></div>
            <div><dt>{t("playerCard.overview.lastSeen")}</dt><dd>{displayDate(profile.lastSeenAt)}</dd></div>
            <div><dt>{t("playerCard.overview.userAgent")}</dt><dd>{profile.userAgent || "N/A"}</dd></div>
            <div><dt>{t("playerCard.overview.clan")}</dt><dd>{profile.clan ? `[${profile.clan.tag}] ${profile.clan.name}` : t("playerCard.overview.noClan")}</dd></div>
            <div><dt>{t("playerCard.overview.clanJoined")}</dt><dd>{profile.clan ? displayDate(profile.clan.joinedAt) : "N/A"}</dd></div>
          </dl>
        </div>
        <div>
          <span className="player-card-eyebrow">{t("playerCard.overview.avatarsEyebrow")}</span>
          <div className="player-avatar-list">
            {profile.avatars.length === 0 && <span className="muted">{t("playerCard.overview.noAvatars")}</span>}
            {profile.avatars.map((avatar, index) => (
              <div className={avatar.selected ? "player-avatar surface is-selected" : "player-avatar surface"} key={`${avatar.url}-${index}`} title={avatar.tooltip}>
                {avatar.url ? (
                  <img
                    src={avatar.url}
                    alt=""
                    width={40}
                    height={20}
                    loading="lazy"
                    decoding="async"
                    draggable={false}
                  />
                ) : <span aria-hidden>◇</span>}
                <span>{avatar.tooltip || t("playerCard.overview.avatarFallback")}</span>
                {avatar.expiresAt && <small>{t("playerCard.overview.avatarExpires", { date: displayDate(avatar.expiresAt) })}</small>}
              </div>
            ))}
          </div>
        </div>
      </section>

      {profile.leaguePlacements.length > 0 && (
        <section>
          <div className="player-card-section-heading"><div><span className="player-card-eyebrow">{t("playerCard.overview.competitiveEyebrow")}</span><h3>{t("playerCard.overview.placementsTitle")}</h3></div></div>
          <div className="player-placement-grid">
            {profile.leaguePlacements.map((placement) => (
              <article className="surface-panel" key={`${placement.leaderboard}-${placement.season}`}>
                {placement.imageUrl && <img src={placement.imageUrl} alt="" loading="lazy" onError={(event) => { event.currentTarget.hidden = true; }} />}
                <div><span>{placement.leaderboard} · {placement.season}</span><strong>{placement.division}</strong><small>{t("playerCard.overview.placementMeta", { score: placement.score, games: placement.gamesPlayed })}</small></div>
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
