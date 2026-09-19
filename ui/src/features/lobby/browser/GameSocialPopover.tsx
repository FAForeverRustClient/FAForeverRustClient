// The friends/foes popover: which of yours are in a game, and on which team.

import type { Game } from "../../../ipc/bindings";
import { flagSrc } from "../../../shared/countryFlags";
import { useCountryLabel } from "../../../shared/hooks/useCountryLabel";
import { findPlayer } from "../../../store/reducer";
import { useAppStore } from "../../../store/store";
import { openPlayerCard } from "../../../shared/playerCardActions";
import { friendsInGame } from "./friendPresence";
import { t } from "../../../i18n";
import { PlayerName } from "../../../shared/components/nameColors";
import { displayedRating, gameLeaderboard } from "../../../shared/playerRatings";
import { observerTeam } from "./gameRules";
import { cancelSocialHide, hideGlobalSocialSoon, type TooltipPosition } from "./hoverPopovers";
import { displayTeamName } from "./GameLineup";

function friendTeamName(game: Game, login: string): string {
  const lower = login.toLowerCase();
  const activeTeams = Object.entries(game.teams).filter(([t, p]) => !observerTeam(t) && p.length > 0);
  const soleTeam = activeTeams.length === 1;
  for (const [team, players] of Object.entries(game.teams)) {
    if (players.some((p) => p.toLowerCase() === lower)) {
      return displayTeamName(team, soleTeam);
    }
  }
  return "";
}

export function GameSocialPopover({
  game,
  players,
  category,
  id,
  position,
}: {
  game: Game;
  players: string[];
  category: "friends" | "foes";
  id: string;
  position: TooltipPosition;
}) {
  const social = useAppStore((state) => state.state.social);
  const countryOf = useCountryLabel();
  const leaderboard = gameLeaderboard(game.ratingType);

  return (
    <aside
      className={`game-friends-popover game-social-popover${category === "foes" ? " is-foes" : ""}`}
      id={id}
      role="tooltip"
      style={position}
      onMouseEnter={cancelSocialHide}
      onMouseLeave={hideGlobalSocialSoon}
    >
      <header className="game-friends-popover-header">
        <span>{t(category === "friends" ? "chat.category.friends" : "chat.category.foes")}</span>
      </header>
      <ul className="game-friends-list">
        {players.map((login) => {
          const profile = findPlayer(social, login);
          const rating = displayedRating(profile, leaderboard);
          const teamName = friendTeamName(game, login);

          return (
            <li key={login}>
              <button
                type="button"
                className="game-friend-row"
                onClick={() => openPlayerCard(profile?.id ?? null, login)}
                title={t("lobby.browser.openProfile", { name: login })}
              >
                {profile?.country ? (
                  <img
                    src={flagSrc(profile.country)}
                    alt={countryOf(profile.country)}
                    title={countryOf(profile.country)}
                    width={16}
                    height={12}
                    decoding="async"
                    draggable={false}
                    className="game-friend-flag"
                  />
                ) : (
                  <i className="game-friend-flag-placeholder" />
                )}
                <PlayerName name={login} className="game-friend-name" />
                {teamName && <span className="game-friend-team">{teamName}</span>}
                <span className="game-friend-rating">{rating === null ? "N/A" : rating}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

/**
 * The friends in a lobby, and the label that names them.
 *
 * A plain function over values the browser already holds, deliberately not a
 * hook. It was one, reading `social.friends` from the store and memoising per
 * game, which meant a store subscription and a `useMemo` inside every one of a
 * hundred rows. Those rows all rebuild whenever the lobby sends a snapshot,
 * several times a second, and the hook pair was measured at 7.5 ms of the
 * 26 ms each snapshot cost: more than the row's actual contents.
 *
 * The set is prepared once by the browser (`friendKeys`) rather than per row.
 */
const NOBODY: { friends: string[]; label: string } = { friends: [], label: "" };

export function friendsHere(game: Game, wanted: ReadonlySet<string>): { friends: string[]; label: string } {
  const friends = friendsInGame(game, wanted);
  // Most games have nobody you know in them, and the label is only rendered
  // when somebody is: computing it regardless meant a translation lookup and
  // an interpolation for every row of a hundred-game list, several times a
  // second, to produce a string nothing displayed.
  if (friends.length === 0) return NOBODY;
  // The count, never the name. A single friend used to be named here, and the
  // name was already on the tile in the lineup underneath: the same person
  // twice, once as a tag among "unranked" and "3 SIM" where a name does not
  // belong. Who they are is in the title attribute, and in the lineup the
  // tile shows on hover.
  return {
    friends,
    label: t("lobby.browser.friendCount", { count: friends.length }),
  };
}

const NOBODY_FOES: { foes: string[]; label: string } = { foes: [], label: "" };

export function foesHere(game: Game, wanted: ReadonlySet<string>): { foes: string[]; label: string } {
  const foes = friendsInGame(game, wanted);
  if (foes.length === 0) return NOBODY_FOES;
  return {
    foes,
    label: t("lobby.browser.foeCount", { count: foes.length }),
  };
}
