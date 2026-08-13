import type { PlayerProfile, SocialEvent, SocialState } from "../../ipc/bindings";

const EMPTY_SOCIAL: SocialState = { friends: [], foes: [], players: [] };
const sortedUnique = (values: string[]): string[] => [...new Set(values)].sort();

/** The profile for a nickname, or undefined if it isn't a known FAF account. */
export const findPlayer = (social: SocialState, login: string): PlayerProfile | undefined =>
  social.players.find((player) => player.login === login);

export function reduceSocial(state: SocialState, event: SocialEvent): SocialState {
  switch (event.type) {
    case "relationsUpdated":
      return {
        ...state,
        friends: sortedUnique(event.payload.friends),
        foes: sortedUnique(event.payload.foes),
      };
    case "relationSet": {
      const { login, relation, member } = event.payload;
      const add = (list: string[]) => sortedUnique([...list, login]);
      const drop = (list: string[]) => list.filter((entry) => entry !== login);
      if (relation === "friend") {
        return member
          ? { ...state, friends: add(state.friends), foes: drop(state.foes) }
          : { ...state, friends: drop(state.friends) };
      }
      return member
        ? { ...state, foes: add(state.foes), friends: drop(state.friends) }
        : { ...state, foes: drop(state.foes) };
    }
    case "playersSeen": {
      const byLogin = new Map(state.players.map((player) => [player.login, player]));
      for (const profile of event.payload.players) byLogin.set(profile.login, profile);
      return {
        ...state,
        players: [...byLogin.values()].sort((a, b) => a.login.localeCompare(b.login)),
      };
    }
    case "playersRemoved": {
      const removed = new Set(event.payload.logins);
      return { ...state, players: state.players.filter((player) => !removed.has(player.login)) };
    }
    case "cleared":
      return EMPTY_SOCIAL;
  }
}
