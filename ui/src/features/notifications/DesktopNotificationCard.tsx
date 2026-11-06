import { useState } from "react";
import type { NotificationPopupCard } from "../../ipc/native";
import { TimedToast } from "./TimedToast";
import "./desktopNotificationCard.css";

/**
 * Shared by the native popup and the local notification gallery.
 *
 * No close button. A card with an action has it as a button of its own, and
 * a click anywhere else on the card puts it away: the action brings the
 * client forward, and a card has to be dismissable without being pulled out
 * of a game. A card without one does what it is about when clicked (opening
 * the conversation a message came from), which closes it too. Either way it
 * also goes by itself once its time is up.
 */
export function DesktopNotificationCard({ card, duration, dismissLabel, onInteract, failure }: {
  card: NotificationPopupCard; duration: number; dismissLabel: string;
  onInteract: (interaction: "activate" | "dismiss" | "expire") => void; failure?: string;
}) {
  const [brokenArt, setBrokenArt] = useState<string | null>(null);
  const art = card.imageUrl && card.imageUrl !== brokenArt ? card.imageUrl : null;
  const hasAction = Boolean(card.actionLabel);
  return <TimedToast baseClassName="desktop-notification" className={`${card.tone ? ` ${card.tone}` : ""}${hasAction ? " has-action" : ""}`}
    duration={duration} onExpire={() => onInteract("expire")}>
    <button className={`desktop-notification-main${art ? " has-art" : ""}`} type="button" onClick={() => onInteract(hasAction ? "dismiss" : "activate")}
      aria-label={hasAction ? `${card.title}. ${dismissLabel}` : undefined}>
      {art && <img className="desktop-notification-art" src={art} alt="" draggable={false} onError={() => setBrokenArt(art)} />}
      <span className="desktop-notification-text">
        {/* The mark says where a card without a picture comes from, and tints a
            warning or an error; a picture says it already. */}
        <span className="desktop-notification-title">{!art && <span className="desktop-notification-logo" aria-hidden="true" />}<strong title={card.title}>{card.title}</strong></span>
        <span className="desktop-notification-message">{card.body}</span>
        {failure && <span className="desktop-notification-error" role="alert">{failure}</span>}
      </span>
    </button>
    {hasAction && <button className="desktop-notification-action" type="button" onClick={() => onInteract("activate")}>{card.actionLabel}</button>}
  </TimedToast>;
}
