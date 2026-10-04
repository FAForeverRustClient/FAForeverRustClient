import type { PlayerCardProfile, PlayerRatingSummary } from "../../ipc/bindings";
import { Icon } from "../../design-system/Icon";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { PlayerNoteCard } from "../../shared/components/PlayerNoteEditor";
import { formatNumber, t } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";
import { formatDateTime } from "../../shared/format/dates";
import { placementLabel, seasonLabel } from "../../shared/leagueNames";
import { leaderboardLabel } from "../../shared/playerRatings";
import { useCountryLabel } from "../../shared/hooks/useCountryLabel";

function displayDate(value: string): string {
  return formatDateTime(value, t("common.notAvailable"));
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
      aria-label={t("playerCard.rating.viewHistoryAria", { queue: leaderboardLabel(rating.technicalName) })}
      onClick={() => onOpenHistory(rating)}
    >
      <span className="player-card-eyebrow">{leaderboardLabel(rating.technicalName)}</span>
      <div className="player-rating-value">
        <strong>{rating.rating}</strong>
        <span><small>{t("playerCard.rating.meanDeviation")}</small>{rating.mean?.toFixed(0) ?? t("common.notAvailable")} ± {rating.deviation?.toFixed(0) ?? t("common.notAvailable")}</span>
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

export function PlayerOverview({ profile, country, note, onOpenHistory, avatarsSelectable = false }: {
  profile: PlayerCardProfile;
  /**
   * The header flag's country, passed down rather than read from `profile`:
   * the API profile usually has none, and the header falls back to the
   * lobby's player list. Reading the profile alone said N/A under a flag.
   */
  country: string;
  note: string;
  onOpenHistory: (rating: PlayerRatingSummary) => void;
  /** Your own card: a click on an assigned avatar wears it. */
  avatarsSelectable?: boolean;
}) {
  const { t } = useTranslation();
  const countryOf = useCountryLabel();
  const selecting = useAppStore((store) => store.state.lobby.avatarSelectionStatus === "loading");
  // The same command the avatar picker sends. The server has no
  // acknowledgement for it, so the card marks the new one at once from
  // `avatarSelected` rather than waiting for a reload.
  const wear = (url: string | null) => ipc.send({ kind: "Lobby", command: { type: "selectAvatar", payload: { url } } });
  const wearingNone = !profile.avatars.some((avatar) => avatar.selected);
  return (
    <div className="player-overview">
      {/* Said up front, because a released name can belong to somebody else
          now: this is the account that gave it up last, not necessarily the
          person the reader has in mind. */}
      {profile.matchedFormerName && (
        <p className="player-card-former-name surface">
          {t("playerCard.overview.foundByFormerName", { name: profile.matchedFormerName, login: profile.login })}
        </p>
      )}
      {profile.warnings.length > 0 && (
        <details className="player-card-warnings surface">
          <summary>{t("playerCard.overview.warnings")}</summary>
          <ul>{profile.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
        </details>
      )}

      <section>
        <div className="player-card-section-heading">
          <div>
            <span className="player-card-eyebrow">{t("playerCard.overview.ratingsEyebrow")}</span>
            <h3>{t("playerCard.overview.ratingsTitle")}</h3>
          </div>
        </div>
        <div className="player-rating-grid">
          {profile.ratings.map((rating) => <RatingSummaryCard key={rating.leaderboardId} rating={rating} onOpenHistory={onOpenHistory} />)}
        </div>
      </section>

      <PlayerNoteCard playerId={profile.playerId} login={profile.login} note={note} />
      <section className="player-account-card surface-panel">
        <div>
          <span className="player-card-eyebrow">{t("playerCard.overview.accountEyebrow")}</span>
          <dl className="player-account-details surface">
            <div><dt>{t("playerCard.overview.playerId")}</dt><dd>{profile.playerId}</dd></div>
            <div><dt>{t("playerCard.overview.registered")}</dt><dd>{displayDate(profile.registeredAt)}</dd></div>
            <div><dt>{t("playerCard.overview.userAgent")}</dt><dd title={profile.userAgent || undefined}>{formatUserAgent(profile.userAgent)}</dd></div>
            {/* Written out here because the header only shows the flag. */}
            <div><dt>{t("playerCard.overview.country")}</dt><dd>{country ? countryOf(country) : t("common.notAvailable")}</dd></div>
            <div><dt>{t("playerCard.overview.clan")}</dt><dd>{profile.clan ? `[${profile.clan.tag}] ${profile.clan.name}` : t("playerCard.overview.noClan")}</dd></div>
            <div><dt>{t("playerCard.overview.clanJoined")}</dt><dd>{profile.clan ? displayDate(profile.clan.joinedAt) : t("common.notAvailable")}</dd></div>
          </dl>
        </div>
        <div>
          <span className="player-card-eyebrow">{t("playerCard.overview.avatarsEyebrow")}</span>
          <div className="player-avatar-list">
            {profile.avatars.length === 0 && <span className="muted">{t("playerCard.overview.noAvatars")}</span>}
            {/* Taking the avatar off, which the separate picker used to be the
                only way to do. Only on your own card, and only when there is
                an avatar to take off or put on. */}
            {avatarsSelectable && profile.avatars.length > 0 && (
              <button
                type="button"
                className={`player-avatar surface is-selectable${wearingNone ? " is-selected" : ""}`}
                aria-pressed={wearingNone}
                disabled={selecting}
                onClick={() => {
                  if (!wearingNone) wear(null);
                }}
              >
                <span className="player-avatar-empty" aria-hidden />
                <span className="player-avatar-name">{t("playerCard.avatar.none")}</span>
              </button>
            )}
            {profile.avatars.map((avatar, index) => {
              const content = (
                <>
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
                  <span className="player-avatar-name">{avatar.tooltip || t("playerCard.overview.avatarFallback")}</span>
                  {avatar.expiresAt && <small>{t("playerCard.overview.avatarExpires", { date: displayDate(avatar.expiresAt) })}</small>}
                </>
              );
              const className = avatar.selected ? "player-avatar surface is-selected" : "player-avatar surface";
              // On your own card each one is a button that puts it on; the one
              // you wear already is pressed and does nothing more.
              return avatarsSelectable && avatar.url ? (
                <button
                  type="button"
                  className={`${className} is-selectable`}
                  key={`${avatar.url}-${index}`}
                  title={avatar.selected ? avatar.tooltip : t("playerCard.overview.wearAvatar", { name: avatar.tooltip || t("playerCard.overview.avatarFallback") })}
                  aria-pressed={avatar.selected}
                  disabled={selecting}
                  onClick={() => {
                    if (!avatar.selected) wear(avatar.url);
                  }}
                >
                  {content}
                </button>
              ) : (
                <div className={className} key={`${avatar.url}-${index}`} title={avatar.tooltip}>
                  {content}
                </div>
              );
            })}
          </div>
          {/* Said where avatars are chosen, because the fallback acts without
              asking: the request came from a player who could not tell whether
              it already existed. Own card only; nobody else's choice is kept. */}
          {avatarsSelectable && profile.avatars.length > 0 && (
            <p className="player-avatar-hint muted">{t("playerCard.avatar.fallbackHint")}</p>
          )}
        </div>
      </section>

      {profile.leaguePlacements.length > 0 && (
        <section>
          <div className="player-card-section-heading"><div><span className="player-card-eyebrow">{t("playerCard.overview.competitiveEyebrow")}</span><h3>{t("playerCard.overview.placementsTitle")}</h3></div></div>
          <div className="player-placement-grid">
            {profile.leaguePlacements.map((placement) => (
              <article className="surface-panel" key={`${placement.technicalName}-${placement.seasonNumber}`}>
                {placement.imageUrl && <img src={placement.imageUrl} alt="" loading="lazy" onError={(event) => { event.currentTarget.hidden = true; }} />}
                <div><span>{leaderboardLabel(placement.technicalName)} · {seasonLabel(placement.seasonNumber)}</span><strong>{placementLabel(placement) ?? t("lobby.matchmaker.unplaced")}</strong><small>{t("playerCard.overview.placementMeta", { score: placement.score, games: placement.gamesPlayed })}</small></div>
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
