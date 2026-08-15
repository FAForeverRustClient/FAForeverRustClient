import type { Game, SocialState } from "../../ipc/bindings";

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

const loginKey = (login: string) => login.toLocaleLowerCase();

// Key comparison rather than `localeCompare(…, { sensitivity: "accent" })`:
// the options object forces a fresh `Intl.Collator` per call, and this runs
// once per player of every open game, plus once per entry of the whole player
// directory when resolving a roster.
const sameLogin = (left: string, right: string) => loginKey(left) === loginKey(right);

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
  if (id === "-1" || id === "null") return "Observers";
  if (id === "0") return "No team";
  return `Team ${id}`;
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
