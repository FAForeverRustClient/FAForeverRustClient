import type { PlayerCardProfile, PlayerRatingSummary } from "../../ipc/bindings";
import { Icon } from "../../design-system/Icon";
import { PlayerNoteCard } from "./PlayerNoteEditor";

function displayDate(value: string): string {
  if (!value) return "N/A";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString("en-US");
}

export function RatingSummaryCard({ rating, onOpenHistory }: {
  rating: PlayerRatingSummary;
  onOpenHistory: (rating: PlayerRatingSummary) => void;
}) {
  const winRate = rating.gamesPlayed > 0 ? (rating.wonGames / rating.gamesPlayed) * 100 : 0;
  return (
    <button
      type="button"
      className="player-rating-summary surface-panel surface-interactive"
      aria-label={`View ${rating.name} rating history`}
      onClick={() => onOpenHistory(rating)}
    >
      <span className="player-card-eyebrow">{rating.name}</span>
      <div className="player-rating-value">
        <strong>{rating.rating}</strong>
        <span><small>Mean ± deviation</small>{rating.mean?.toFixed(0) ?? "N/A"} ± {rating.deviation?.toFixed(0) ?? "N/A"}</span>
      </div>
      <dl>
        <div><dt>Games</dt><dd>{rating.gamesPlayed.toLocaleString("en-US")}</dd></div>
        <div><dt>Won</dt><dd>{rating.wonGames.toLocaleString("en-US")}</dd></div>
        <div><dt>Win rate</dt><dd>{winRate.toFixed(1)}%</dd></div>
      </dl>
      <span className="player-rating-link">View history <Icon name="arrowRight" size={13} /></span>
    </button>
  );
}

export function PlayerOverview({ profile, note, onEditNote, onOpenHistory }: {
  profile: PlayerCardProfile;
  note: string;
  onEditNote: () => void;
  onOpenHistory: (rating: PlayerRatingSummary) => void;
}) {
  return (
    <div className="player-overview">
      {profile.warnings.length > 0 && (
        <details className="player-card-warnings surface">
          <summary>Some profile sections could not be loaded</summary>
          <ul>{profile.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
        </details>
      )}

      <section>
        <div className="player-card-section-heading"><div><span className="player-card-eyebrow">Ratings</span><h3>Current rating queues</h3></div><span className="muted">Select a queue to explore its full history</span></div>
        <div className="player-rating-grid">
          {profile.ratings.map((rating) => <RatingSummaryCard key={rating.leaderboardId} rating={rating} onOpenHistory={onOpenHistory} />)}
        </div>
      </section>

      <PlayerNoteCard note={note} onEdit={onEditNote} />
      <section className="player-account-card surface-panel">
        <div>
          <span className="player-card-eyebrow">Account</span>
          <dl className="player-account-details surface">
            <div><dt>Player ID</dt><dd>{profile.playerId}</dd></div>
            <div><dt>Registered</dt><dd>{displayDate(profile.registeredAt)}</dd></div>
            <div><dt>Last seen</dt><dd>{displayDate(profile.lastSeenAt)}</dd></div>
            <div><dt>User agent</dt><dd>{profile.userAgent || "N/A"}</dd></div>
            <div><dt>Clan</dt><dd>{profile.clan ? `[${profile.clan.tag}] ${profile.clan.name}` : "No clan"}</dd></div>
            <div><dt>Clan joined</dt><dd>{profile.clan ? displayDate(profile.clan.joinedAt) : "N/A"}</dd></div>
          </dl>
        </div>
        <div>
          <span className="player-card-eyebrow">Assigned avatars</span>
          <div className="player-avatar-list">
            {profile.avatars.length === 0 && <span className="muted">No assigned avatars</span>}
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
                <span>{avatar.tooltip || "Avatar"}</span>
                {avatar.expiresAt && <small>Expires {displayDate(avatar.expiresAt)}</small>}
              </div>
            ))}
          </div>
        </div>
      </section>

      {profile.leaguePlacements.length > 0 && (
        <section>
          <div className="player-card-section-heading"><div><span className="player-card-eyebrow">Competitive</span><h3>Active league placements</h3></div></div>
          <div className="player-placement-grid">
            {profile.leaguePlacements.map((placement) => (
              <article className="surface-panel" key={`${placement.leaderboard}-${placement.season}`}>
                {placement.imageUrl && <img src={placement.imageUrl} alt="" loading="lazy" onError={(event) => { event.currentTarget.hidden = true; }} />}
                <div><span>{placement.leaderboard} · {placement.season}</span><strong>{placement.division}</strong><small>{placement.score} score · {placement.gamesPlayed} games</small></div>
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
