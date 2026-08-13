import type { ChatMessage, ChatPreferences, SocialState } from "../../ipc/bindings";

const includesName = (names: string[], candidate: string) => names.some(
  (name) => name.localeCompare(candidate, undefined, { sensitivity: "accent" }) === 0,
);

/** Apply presentation preferences without discarding the domain's scrollback. */
export function visibleChatMessages(
  messages: ChatMessage[],
  preferences: ChatPreferences,
  social: SocialState,
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
