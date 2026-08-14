import type { ChatMessage, ChatPreferences, SocialState } from "../../ipc/bindings";
// Set-backed and cached on the identity of the source array. The local
// `localeCompare` version this replaced ran once per foe and per muted player,
// for every message in the scrollback, on every re-render: with foe hiding on
// by default that was thousands of `Intl.Collator` constructions per incoming
// message.
import { includesName } from "../../shared/nameColorsUtil";

/** Apply presentation preferences without discarding the domain's scrollback. */
export function visibleChatMessages(
  messages: ChatMessage[],
  preferences: ChatPreferences,
  social: SocialState | { foes: string[] },
): ChatMessage[] {
  let visible = preferences.showJoinsParts
    ? messages
    : messages.filter((message) => message.kind !== "info");
  if (preferences.hideFoeMessages && social.foes.length > 0) {
    visible = visible.filter((message) => !includesName(social.foes, message.sender));
  }
  if (preferences.mutedPlayers.length > 0) {
    visible = visible.filter((message) => !includesName(preferences.mutedPlayers, message.sender));
  }
  return visible.slice(-preferences.visibleMessageLimit);
}
