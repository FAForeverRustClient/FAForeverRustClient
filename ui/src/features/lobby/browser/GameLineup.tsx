// The lineup popover: who is in the game, on which side, and how the sides
// balance.

import type { Game, PlayerProfile } from "../../../ipc/bindings";
import { flagSrc } from "../../../shared/countryFlags";
import { useCountryLabel } from "../../../shared/hooks/useCountryLabel";
import { findPlayer } from "../../../store/reducer";
import { useAppStore } from "../../../store/store";
import { openPlayerCard } from "../../../shared/playerCardActions";
import { formatNumber, t } from "../../../i18n";
import { PlayerName } from "../../../shared/components/nameColors";
import { displayedRating, gameLeaderboard } from "../../../shared/playerRatings";
import { observerTeam } from "./gameRules";
import { cancelLineupHide, hideGlobalLineupSoon, type TooltipPosition } from "./hoverPopovers";

export function GameLineup({
  game,
  id,
  position,
}: {
  game: Game;
  id: string;
  position: TooltipPosition;
}) {
  const social = useAppStore((state) => state.state.social);
  const teams = Object.entries(game.teams)
    .filter(([team, players]) => !observerTeam(team) && players.length > 0)
    .sort(([left], [right]) => Number(left) - Number(right));
  const observers = Object.entries(game.teams)
    .filter(([team]) => observerTeam(team))
    .flatMap(([, players]) => players);
  const mods = Object.values(game.simMods);
  const mirrored = teams.length === 2;
  const isSingleTeam = teams.length === 1;
  const totalPlayers = teams.reduce((acc, [, list]) => acc + list.length, 0);
  const isSinglePlayer = isSingleTeam && totalPlayers === 1;
  const maxMods = isSingleTeam ? 2 : 4;
  const profileFor = (login: string) => findPlayer(social, login);
  // Every rating in this overlay is the one this game is played for: a ladder
  // lobby shows ladder ratings, a custom one shows global.
  const leaderboard = gameLeaderboard(game.ratingType);

  const tooltipClass = [
    "game-tile-tooltip",
    isSingleTeam && "is-single-team",
    isSinglePlayer && "is-single-player",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <aside
      className={tooltipClass}
      id={id}
      role="tooltip"
      style={position}
      // Reaching the overlay means crossing the gap between it and the row,
      // which is a `mouseleave` with nothing under the pointer. Arriving here
      // cancels the close that started; leaving here starts it again, so the
      // pointer can go back to the row without the overlay vanishing.
      onMouseEnter={cancelLineupHide}
      onMouseLeave={hideGlobalLineupSoon}
    >
      {/* No title. This overlay is anchored to the row or tile that already
          carries the game's name in larger type, so repeating it here was the
          same words twice within an inch of each other. */}
      {mirrored && <TeamBalance teams={teams} profileFor={profileFor} leaderboard={leaderboard} />}
      {teams.length > 0 ? (
        <div
          className={
            mirrored
              ? "game-lineup-teams is-mirrored"
              : teams.length === 1
              ? "game-lineup-teams is-single"
              : "game-lineup-teams"
          }
        >
          {teams.map(([team, players], index) => (
            <GameLineupTeam
              key={team}
              team={team}
              players={players}
              soleTeam={teams.length === 1}
              side={mirrored ? (index === 0 ? "left" : "right") : "neutral"}
              profileFor={profileFor}
              leaderboard={leaderboard}
            />
          ))}
          {mirrored && <span className="game-lineup-versus" aria-hidden>VS</span>}
        </div>
      ) : (
        <span className="game-lineup-empty">{t("lobby.browser.noLineup")}</span>
      )}
      {observers.length > 0 && (
        <section className="game-lineup-observers">
          <b>{t("lobby.browser.observers")}</b>
          <span>{observers.join(", ")}</span>
        </section>
      )}
      {mods.length > 0 && (
        <section className="game-lineup-mods">
          <b>{t("lobby.browser.simMods")}</b>
          <span title={mods.join(", ")}>
            {mods.length <= maxMods
              ? mods.join(", ")
              : `${mods.slice(0, maxMods).join(", ")}, ${t("lobby.browser.moreMods", { count: mods.length - maxMods })}`}
          </span>
        </section>
      )}
    </aside>
  );
}

type LineupSide = "left" | "right" | "neutral";

export function displayTeamName(team: string, soleTeam: boolean): string {
  if (team === "-1" || team === "null") return t("lobby.details.observers");
  const numeric = Number(team);
  if (!Number.isInteger(numeric)) return `Team ${team}`;
  // Team 1 is the server's "no team" bucket. When it holds everyone the game is
  // a free-for-all, which says more than "No team" did.
  if (numeric === 1) return soleTeam ? t("lobby.browser.freeForAll") : t("lobby.browser.unassigned");
  return `Team ${numeric - 1}`;
}

/** Combined displayed rating of a team, or `null` if any member is unknown. */
function teamRating(
  players: string[],
  profileFor: (login: string) => PlayerProfile | undefined,
  leaderboard: string,
): number | null {
  const ratings = players.map((login) => displayedRating(profileFor(login), leaderboard));
  return ratings.every((rating): rating is number => rating !== null)
    ? ratings.reduce((sum, rating) => sum + rating, 0)
    : null;
}

/**
 * How the two sides compare, as a proportional bar.
 *
 * The tooltip already listed both totals, but at opposite outer edges of the
 * panel with nothing saying what they were. "Is this game balanced" is the
 * question a lobby browser is actually being asked, so it gets answered
 * directly instead of left as arithmetic between two grey numbers.
 */
function TeamBalance({
  teams,
  profileFor,
  leaderboard,
}: {
  teams: [string, string[]][];
  profileFor: (login: string) => PlayerProfile | undefined;
  leaderboard: string;
}) {
  const left = teamRating(teams[0][1], profileFor, leaderboard);
  const right = teamRating(teams[1][1], profileFor, leaderboard);
  if (left === null || right === null || left + right === 0) return null;

  const leftShare = Math.round((left / (left + right)) * 100);
  const rightShare = 100 - leftShare;

  return (
    <div className="game-lineup-balance">
      <span
        className="game-lineup-balance-bar"
        role="img"
        aria-label={t("lobby.browser.shareAria", { left: leftShare, right: rightShare })}
      >
        <span style={{ width: `${leftShare}%` }} />
      </span>
      <span className="game-lineup-balance-note">
        {leftShare}% / {rightShare}%
      </span>
    </div>
  );
}

function GameLineupTeam({
  team,
  players,
  soleTeam,
  side,
  profileFor,
  leaderboard,
}: {
  team: string;
  players: string[];
  soleTeam: boolean;
  side: LineupSide;
  profileFor: (login: string) => PlayerProfile | undefined;
  leaderboard: string;
}) {
  const countryOf = useCountryLabel();
  const profiles = players.map((login) => profileFor(login));
  const ratings = profiles.map((profile) => displayedRating(profile, leaderboard));
  const total = teamRating(players, profileFor, leaderboard);

  const isSinglePlayer = soleTeam && players.length === 1;

  return (
    <section
      className={`game-lineup-team is-${side}${soleTeam ? " is-sole" : ""}${isSinglePlayer ? " is-single-player" : ""}`}
    >
      <header>
        <b>{displayTeamName(team, soleTeam)}</b>
        {total === null ? (
          <span>{t("lobby.browser.playerCount", { count: players.length })}</span>
        ) : (
          <span title={t("lobby.browser.combinedRating")}>
            {t("lobby.browser.teamRating", { rating: formatNumber(total) })}
          </span>
        )}
      </header>
      <ul>
        {/* Both columns read flag, name, rating. They used to be mirrored, which
            put the two sets of ratings against the panel's outer edges: the
            furthest apart the layout allowed, for the numbers most likely to be
            compared. */}
        {players.map((login, index) => {
          const profile = profiles[index];
          const rating = ratings[index];
          return (
            <li key={login}>
              {profile?.country ? (
                <img
                  src={flagSrc(profile.country)}
                  alt={countryOf(profile.country)}
                  title={countryOf(profile.country)}
                  width={16}
                  height={16}
                  decoding="async"
                  draggable={false}
                />
              ) : <i className="game-lineup-flag-placeholder" />}
              <button
                type="button"
                className="game-team-player"
                onClick={() => openPlayerCard(profile?.id ?? null, login)}
                title={t("lobby.browser.openProfile", { name: login })}
              >
                <PlayerName name={login} className="game-lineup-player" />
              </button>
              <span className="game-lineup-rating">{rating === null ? "N/A" : rating}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
