import { memo } from "react";
import type { MatchmakerPlayerProfile, MatchmakerQueue, PlayerCardStatus } from "../../ipc/bindings";
import { flagSrc } from "../../shared/countryFlags";
import { openPlayerCard } from "../player-card/playerCardActions";
import { MatchmakerFactionPicker } from "./MatchmakerFactionPicker";
import { formatNumber } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";
import { PlayerName } from "../../shared/nameColors";

/**
 * The badge shown for a queue the player has no placement in. Taken from the
 * Java client (`images/leagueUnlistedDivision.png`) so the two clients say
 * "unplaced" with the same picture rather than each inventing one.
 */
export const UNLISTED_DIVISION_IMAGE = "/images/league-unlisted-division.png";

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
  queues?: MatchmakerQueue[];
  selectedFactions: string[];
  factionsDisabled: boolean;
  onFactionsChange: (factions: string[]) => void;
}

/**
 * Memoised because the panel around it holds a one second clock for the queue
 * countdowns, and none of this changes on that tick.
 */
export const MatchmakerPlayerCard = memo(function MatchmakerPlayerCard({
  playerId,
  playerName,
  profile,
  status,
  error,
  country,
  selectedFactions,
  factionsDisabled,
  onFactionsChange,
}: Props) {
  const { t } = useTranslation();
  const placement = profile?.leaguePlacements[0] ?? null;
  const displayName = profile?.login || playerName;
  const clan = profile?.clanTag ? `[${profile.clanTag}]` : "";
  // The REST profile keeps its country only as a fallback; in practice the
  // lobby is the source that actually has one.
  const flagCode = country || profile?.country || "";

  return (
    <section className="matchmaker-player-card surface-panel" aria-labelledby="matchmaker-player-name">
      <div className="matchmaker-player-identity">
        <div
          className="matchmaker-league-mark"
          title={placement?.division || t(status === "loading" ? "lobby.playerCard.loadingPlacement" : "lobby.matchmaker.unplaced")}
          aria-hidden
        >
          <img
            src={placement?.imageUrl || UNLISTED_DIVISION_IMAGE}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            onError={(event) => { event.currentTarget.src = UNLISTED_DIVISION_IMAGE; }}
          />
        </div>

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
            <span>{placement?.division || t(status === "loading" ? "lobby.playerCard.loadingPlacement" : "lobby.matchmaker.unplaced")}</span>
            <span>{profile ? t("lobby.playerCard.games", { count: formatNumber(profile.gamesPlayed) }) : t("lobby.playerCard.ratingsLoading")}</span>
          </div>
          {status === "failed" && <small className="matchmaker-profile-warning" title={error}>{t(profile ? "lobby.playerCard.refreshFailed" : "lobby.playerCard.unavailable")}</small>}
          {profile && profile.warnings.length > 0 && <small className="matchmaker-profile-warning" title={profile.warnings.join("\n")}>{t("lobby.matchmaker.detailsUnavailable")}</small>}
        </div>
      </div>

      <div className="matchmaker-player-factions">
        <MatchmakerFactionPicker
          selected={selectedFactions}
          disabled={factionsDisabled}
          onChange={onFactionsChange}
        />
      </div>
    </section>
  );
});
