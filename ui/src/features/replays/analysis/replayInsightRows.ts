import type { ReplayChatMessage, ReplayDetails, ReplayPlayer, ReplayTeam } from "../../../ipc/bindings";
import type { MessageKey } from "../../../i18n";

/**
 * What to call the channel a line was typed into.
 *
 * `all` and `allies` are the two the game names; anything else is the army
 * number a whisper went to, which is a number the reader has no way to resolve
 * and so reads as "whisper".
 */
export function channelLabel(channel: string, t: (key: MessageKey) => string): string {
  if (channel === "all") return t("replays.insights.channelAll");
  if (channel === "allies") return t("replays.insights.channelAllies");
  if (!channel) return "";
  return t("replays.insights.channelWhisper");
}

/** `1:23:45`, the way the Java client stamps a line of replay chat. */
export function formatChatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * The lines the game writes on a player's behalf when they share: "Sent 1.2k
 * energy to Rewer", "sent 1 unit to Nory", and the request button's "Can you
 * give me some energy, Sainse?". Matched on the game's English wording, which
 * is the only wording these replays have shown.
 */
const TRANSFER_PATTERNS: readonly RegExp[] = [
  /^sent\s+[\d.,]+\s*[km]?\s+(?:energy|mass)\s+to\s/i,
  /^sent\s+[\d.,]+\s+units?\s+to\s/i,
  /^can you give me some (?:energy|mass)\b/i,
];

/** Whether a chat line is a resource or unit transfer, or a request for one. */
export function isTransferMessage(message: string): boolean {
  const text = message.trim();
  return TRANSFER_PATTERNS.some((pattern) => pattern.test(text));
}

/** Somebody who wrote in a replay's chat, and how many lines. */
export interface ChatSender {
  name: string;
  lines: number;
}

/**
 * Everyone who wrote in the chat, alphabetically, for the "From" filter, with
 * how many of their lines are in `counted`.
 *
 * Everyone in `messages` is listed, a count of nought included: a name that
 * vanished from the list whenever another filter left it nothing could not be
 * unticked. Alphabetical rather than busiest first: the reader comes looking
 * for a name, and a list that reorders itself by volume makes them read it all
 * to find it.
 */
export function chatSenders(
  messages: ReplayChatMessage[],
  counted: ReplayChatMessage[] = messages,
): ChatSender[] {
  const lines = new Map<string, number>();
  for (const message of messages) {
    if (!lines.has(message.sender)) lines.set(message.sender, 0);
  }
  for (const message of counted) {
    lines.set(message.sender, (lines.get(message.sender) ?? 0) + 1);
  }
  return [...lines]
    .map(([name, count]) => ({ name, lines: count }))
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
}

/**
 * One row of the activity tab: what the stream counted, and who the lineup says
 * that was.
 */
export interface ActivityRow {
  player: string;
  commands: number;
  /** Commands per minute of game time, or `null` for a game with no length. */
  perMinute: number | null;
  faction: number | null;
  rating: number | null;
  team: number | null;
}

/**
 * Join the command counts to the lineup.
 *
 * The two come from different places and agree on nothing but the login: the
 * counts are from the replay file's own client table, the lineup is the API's
 * record of the match (or the file's army table, for a local replay). Matching
 * is case-insensitive because the two do not always agree on capitals, and a
 * player the lineup does not know is still listed: an observer is in the file
 * and not in the lineup, and "who was watching" is worth seeing.
 */
export function activityRows(
  stats: NonNullable<ReplayDetails["commandStats"]>,
  teams: ReplayTeam[],
  simSeconds: number,
): ActivityRow[] {
  const byLogin = new Map<string, { player: ReplayPlayer; team: number }>();
  for (const team of teams) {
    for (const player of team.players) {
      byLogin.set(player.name.toLocaleLowerCase(), { player, team: team.team });
    }
  }
  const minutes = simSeconds / 60;
  return stats
    .map((entry) => {
      const found = byLogin.get(entry.player.toLocaleLowerCase());
      return {
        player: entry.player,
        commands: entry.commands,
        perMinute: minutes > 0 ? entry.commands / minutes : null,
        faction: found?.player.faction ?? null,
        rating: found?.player.rating ?? null,
        team: found?.team ?? null,
      };
    })
    .sort((left, right) => right.commands - left.commands);
}

