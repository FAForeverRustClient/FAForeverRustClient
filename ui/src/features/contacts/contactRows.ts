import type { Relation, SocialState } from "../../ipc/bindings";
import { nickKey } from "../../shared/nameColorsUtil";

export interface ContactRow {
  key: string;
  login: string | null;
  playerId: number | null;
  online: boolean;
  avatarUrl: string;
  avatarTooltip: string;
}

/** Relations drive membership; the live directory only supplies presence. */
export function contactRows(social: SocialState, relation: Relation, online: ReadonlySet<string>): ContactRow[] {
  const names = relation === "friend" ? social.friends : social.foes;
  const contacts = social.contacts?.entries ?? [];
  const ids = new Map(social.loginLookups.filter(entry => entry.id !== null).map(entry => [nickKey(entry.login), entry.id]));
  for (const contact of contacts) if (contact.login) ids.set(nickKey(contact.login), contact.playerId);
  for (const player of social.players) ids.set(nickKey(player.login), player.id);
  const rows = new Map<string, ContactRow>();
  const avatars = new Map(social.players.map(player => [nickKey(player.login), player]));
  for (const login of names) {
    const key = nickKey(login);
    const avatar = avatars.get(key);
    rows.set(key, {
      key: `login:${key}`, login, playerId: ids.get(key) ?? null, online: online.has(key),
      avatarUrl: avatar?.avatarUrl ?? "", avatarTooltip: avatar?.avatarTooltip ?? "",
    });
  }
  const result = [...rows.values()];
  const unresolved = new Set<number>();
  for (const contact of contacts) {
    if (contact.relation === relation && contact.login === null && !unresolved.has(contact.playerId)) {
      unresolved.add(contact.playerId);
      result.push({ key: `id:${contact.playerId}`, login: null, playerId: contact.playerId, online: false,
        avatarUrl: "", avatarTooltip: "" });
    }
  }
  return result.sort((a, b) => Number(b.online) - Number(a.online)
    || (a.login ?? "\uffff").localeCompare(b.login ?? "\uffff")
    || (a.playerId ?? 0) - (b.playerId ?? 0));
}
