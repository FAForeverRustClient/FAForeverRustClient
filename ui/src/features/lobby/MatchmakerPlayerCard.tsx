import type { MatchmakerPlayerProfile, MatchmakerQueue, PlayerCardStatus } from "../../ipc/bindings";
import { placementForQueue, ratingForQueue } from "./matchmakerRatings";
import { flagSrc } from "../../shared/countryFlags";
import { openPlayerCard } from "../player-card/playerCardActions";
import { formatNumber } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";
import { PlayerName } from "../../shared/nameColors";

/**
 * The short form the divisions row uses: "1v1", "4v4". `queueTitle` spells the
 * ladder queue out for the cards, which is too long for a tile this size.
 */
/**
 * The badge shown for a queue the player has no placement in. Taken from the
 * Java client (`images/leagueUnlistedDivision.png`) so the two clients say
 * "unplaced" with the same picture rather than each inventing one.
 */
export const UNLISTED_DIVISION_IMAGE = "/images/league-unlisted-division.png";

const queueLabel = (queue: MatchmakerQueue) => `${queue.teamSize}v${queue.teamSize}`;

interface Props {
  playerId: number | null;
  playerName: string;
  profile: MatchmakerPlayerProfile | null;
  status: PlayerCardStatus;
  error: string;
  /**
   * ISO country code from the *lobby* directory, not the REST profile.
   *
   * `/data/player` does not carry a country, so the API-sourced profile always
   * had an empty one and the flag never rendered. The lobby's `player_info`
   * push does carry it, already lowercased, which is also where the Java
   * client's `countryImageView` gets it.
   */
  country: string;
  /** The queues to show a division for, in the order they are offered. */
  queues: MatchmakerQueue[];
}

export function MatchmakerPlayerCard({
  playerId,
  playerName,
  profile,
  status,
  error,
  country,
  queues,
}: Props) {
  const { t } = useTranslation();
  const placements = profile?.leaguePlacements ?? [];
  // One tile per queue the server offers, not per placement the player has: a
  // queue nobody has played yet still belongs in the row, saying so.
  const divisions = queues.map((queue) => ({
    queueName: queue.queueName,
    label: queueLabel(queue),
    placement: placementForQueue(placements, queue.queueName),
    rating: ratingForQueue(profile?.ratings ?? [], queue.queueName),
  }));
  const placement = placements[0] ?? null;
  const displayName = profile?.login || playerName;
  const clan = profile?.clanTag ? `[${profile.clanTag}]` : "";
  // The REST profile keeps its country only as a fallback; in practice the
  // lobby is the source that actually has one.
  const flagCode = country || profile?.country || "";

  return (
    <section className="matchmaker-player-card surface-panel" aria-labelledby="matchmaker-player-name">
      <div className="matchmaker-player-identity">
        {/* Only drawn when there is a badge to draw. An unplaced player has no
            league image, and a bordered box holding "?" says less than the
            "Unlisted" already in the line below it. The Java client collapses
            its `leagueImageView` in the same situation. */}
        {placement?.imageUrl && (
          <div className="matchmaker-league-mark" title={placement.division || undefined} aria-hidden>
            <img
              src={placement.imageUrl}
              alt=""
              loading="lazy"
              decoding="async"
              onError={(event) => { event.currentTarget.closest("div")?.remove(); }}
            />
          </div>
        )}

        <div className="matchmaker-player-copy">
          <button
            type="button"
            className="matchmaker-player-name"
            id="matchmaker-player-name"
            disabled={playerId === null}
            title={t("lobby.matchmaker.openProfile")}
            onClick={() => { if (playerId !== null) void openPlayerCard(playerId, displayName); }}
          >
            {clan && <span>{clan}</span>}
            <strong><PlayerName name={displayName} /></strong>
            {profile?.avatarUrl && (
              <img
                className="matchmaker-player-avatar"
                src={profile.avatarUrl}
                alt=""
                width={40}
                height={20}
                title={profile.avatarTooltip || undefined}
                loading="lazy"
                decoding="async"
                draggable={false}
              />
            )}
          </button>
          <div className="matchmaker-player-meta">
            {flagCode && (
              <img
                src={flagSrc(flagCode)}
                alt={flagCode.toUpperCase()}
                title={flagCode.toUpperCase()}
                width={20}
                height={14}
              />
            )}
            <span>{placement?.division || t(status === "loading" ? "lobby.playerCard.loadingPlacement" : "lobby.playerCard.unlisted")}</span>
            <span>{profile ? t("lobby.playerCard.games", { count: formatNumber(profile.gamesPlayed) }) : t("lobby.playerCard.ratingsLoading")}</span>
          </div>
          {divisions.length > 0 && (
            <div className="matchmaker-divisions">
              <span className="matchmaker-kicker">{t("lobby.matchmaker.divisions")}</span>
              <ul>
                {divisions.map((entry) => (
                  <li key={entry.queueName} className="matchmaker-division">
                    {/* Always a badge, never a gap: an unplaced queue gets the
                        same "unlisted" art the Java client uses, so the row
                        keeps its shape whatever the player has played. */}
                    <img
                      className="matchmaker-division-badge"
                      src={entry.placement?.imageUrl || UNLISTED_DIVISION_IMAGE}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      draggable={false}
                      onError={(event) => { event.currentTarget.src = UNLISTED_DIVISION_IMAGE; }}
                    />
                    <span className="matchmaker-division-copy">
                      <span className="matchmaker-division-queue">{entry.label}</span>
                      <span className="matchmaker-division-rank">
                        {entry.placement?.division || t("lobby.matchmaker.unplaced")}
                      </span>
                      <strong className={`matchmaker-division-rating${entry.rating ? "" : " is-empty"}`}>
                        {entry.rating ? entry.rating.rating.toLocaleString("en-US") : t("lobby.matchmaker.noRating")}
                      </strong>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {status === "failed" && <small className="matchmaker-profile-warning" title={error}>{t(profile ? "lobby.playerCard.refreshFailed" : "lobby.playerCard.unavailable")}</small>}
          {profile && profile.warnings.length > 0 && <small className="matchmaker-profile-warning" title={profile.warnings.join("\n")}>{t("lobby.matchmaker.detailsUnavailable")}</small>}
        </div>
      </div>

    </section>
  );
}
