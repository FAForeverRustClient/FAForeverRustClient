import type { ReactNode } from "react";
import type { ClientNotification, NotificationAction } from "../../ipc/bindings";
import { Icon } from "../../design-system/Icon";
import { t } from "../../i18n";

/**
 * The line under the message saying what a click will do, where that is worth
 * a line.
 *
 * The whole card is one button, so every notification already does its action
 * when clicked anywhere: "meanwhile i dont even have to click open chat to
 * open chat, i can just click it anywhere". A label that only repeats the
 * card's own title therefore says nothing, and it said it loudly, in bold
 * uppercase over a greyed-out message. Somebody read "OPEN CHAT" as the
 * message they had been sent.
 *
 * So the label is kept only where the click is not simply "show me this":
 * accepting a party invite acts on somebody else's invitation, watching a
 * live game starts a replay, and a stream leaves the client for a browser.
 * Opening a tab in the client speaks for itself.
 */
export function actionLabel(action: NotificationAction | null): string | null {
  if (!action) return null;
  switch (action.type) {
    case "acceptPartyInvite": return t("notifications.action.acceptPartyInvite");
    case "watchLive": return t("notifications.action.watchLive");
    case "watchLiveWhenReady": return t("notifications.action.watchLiveWhenReady");
    case "openStream": return t("notifications.action.openStream");
    case "focusGame": return t("notifications.action.focusGame");
    case "openGame": return t("notifications.action.openGame");
    case "openReview": return t("notifications.action.openReview");
    // Labelled: the click downloads the update and restarts the client.
    case "updateClient": return t("notifications.action.updateClient");
    case "openChat":
    case "openMatchmaking":
    case "openCustomGames":
    case "openSettings":
    case "openEvent":
      return null;
  }
}

/**
 * The action line of a card: the label above, or for a stream the platform it
 * opens as an icon and its name (#155), which says where the click goes more
 * plainly than "Watch the stream" did.
 *
 * Drawn as the client's own button (`btn-ghost`), so it reads as something to
 * press (#653): a word in capitals under the text read as a caption. The
 * whole card is the button, so this is its look, not a second one inside it.
 */
export function actionContent(action: NotificationAction | null): ReactNode {
  if (action?.type === "openStream" && isTwitchUrl(action.payload.url)) {
    return (
      <span className="btn-ghost notification-action notification-stream" aria-label={t("notifications.action.openStream")}>
        <Icon name="twitch" size={14} />
        Twitch
      </span>
    );
  }
  const label = actionLabel(action);
  return label ? <span className="btn-ghost notification-action">{label}</span> : null;
}

function isTwitchUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "twitch.tv" || host.endsWith(".twitch.tv");
  } catch {
    return false;
  }
}

export function notificationTone(item: ClientNotification): string {
  if (item.kind === "error") return " is-error";
  if (item.kind === "serverWarning" || item.kind === "gameCacheAlert") return " is-warning";
  if (item.kind === "serverNotice") return " is-server";
  return "";
}
