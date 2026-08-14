import type { Game, SocialState } from "../../ipc/bindings";
import { t } from "../../i18n";

export type GamePresenceStatus = "hosting" | "lobbying" | "playing";

export interface GamePresence {
  game: Game;
  status: GamePresenceStatus;
}

export interface GameSummaryPlayer {
  login: string;
  country: string;
  rating: number | null;
}

export interface GameSummaryTeam {
  id: string;
  label: string;
  rating: number | null;
  players: GameSummaryPlayer[];
}

const sameLogin = (left: string, right: string) =>
  left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;

const loginKey = (login: string) => login.toLocaleLowerCase();

/** Find the authoritative game presence represented by lobby snapshots. */
export function gamePresenceForPlayer(
  openGames: Game[],
  liveGames: Game[],
  login: string,
): GamePresence | null {
  return gamePresenceIndex(openGames, liveGames).get(loginKey(login)) ?? null;
}

/** Build once for a roster, avoiding a full game/team scan for every row. */
export function gamePresenceIndex(openGames: Game[], liveGames: Game[]): Map<string, GamePresence> {
  const result = new Map<string, GamePresence>();
  const members = (game: Game) => new Set([game.host, ...Object.values(game.teams).flat()]);

  for (const game of openGames) {
    for (const login of members(game)) {
      result.set(loginKey(login), {
        game,
        status: sameLogin(game.host, login) ? "hosting" : "lobbying",
      });
    }
  }
  for (const game of liveGames) {
    for (const login of members(game)) {
      result.set(loginKey(login), { game, status: "playing" });
    }
  }
  return result;
}

function teamLabel(id: string): string {
  if (id === "-1" || id === "null") return t("chat.team.observers");
  if (id === "0") return t("chat.team.none");
  return t("chat.team.numbered", { id });
}

function teamOrder([id]: [string, string[]]): number {
  if (id === "-1" || id === "null") return Number.MAX_SAFE_INTEGER;
  const numeric = Number(id);
  return Number.isFinite(numeric) ? numeric : Number.MAX_SAFE_INTEGER - 1;
}

export function gameTeamSummaries(game: Game, social: SocialState): GameSummaryTeam[] {
  return Object.entries(game.teams)
    .filter(([, players]) => players.length > 0)
    .sort((left, right) => teamOrder(left) - teamOrder(right))
    .map(([id, logins]) => {
      const players = logins.map((login) => {
        const profile = social.players.find((candidate) => sameLogin(candidate.login, login));
        return {
          login,
          country: profile?.country ?? "",
          rating: profile && profile.globalRating > 0 ? profile.globalRating : null,
        };
      });
      const knownRatings = players.flatMap((player) => player.rating === null ? [] : [player.rating]);
      return {
        id,
        label: teamLabel(id),
        rating: knownRatings.length > 0
          ? knownRatings.reduce((total, rating) => total + rating, 0)
          : null,
        players,
      };
    });
}
