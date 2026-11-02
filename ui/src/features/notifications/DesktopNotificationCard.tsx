import { useState } from "react";
import type { NotificationPopupCard } from "../../ipc/native";
import { Icon } from "../../design-system/Icon";
import { TimedToast } from "./TimedToast";
import "./desktopNotificationCard.css";

/** Shared by the native popup and the local notification gallery. */
export function DesktopNotificationCard({ card, duration, dismissLabel, onInteract, failure }: {
  card: NotificationPopupCard; duration: number; dismissLabel: string;
  onInteract: (interaction: "activate" | "dismiss" | "expire") => void; failure?: string;
}) {
  const [brokenArt, setBrokenArt] = useState<string | null>(null);
  const art = card.imageUrl && card.imageUrl !== brokenArt ? card.imageUrl : null;
  return <TimedToast baseClassName="desktop-notification" className={card.tone ? ` ${card.tone}` : ""}
    duration={duration} onExpire={() => onInteract("expire")}>
    <button className={`desktop-notification-main${art ? " has-art" : ""}`} type="button" onClick={() => onInteract("activate")}>
      {art && <img className="desktop-notification-art" src={art} alt="" draggable={false} onError={() => setBrokenArt(art)} />}
      <span className="desktop-notification-text">
        <span className="desktop-notification-title"><span className="desktop-notification-logo" aria-hidden="true" /><strong>{card.title}</strong></span>
        <span className="desktop-notification-message">{card.body}</span>
        {card.actionLabel && <span className="desktop-notification-action">{card.actionLabel}</span>}
        {failure && <span className="desktop-notification-error" role="alert">{failure}</span>}
      </span>
    </button>
    <button className="desktop-notification-dismiss" type="button" aria-label={dismissLabel} onClick={() => onInteract("dismiss")}><Icon name="close" size={14} /></button>
  </TimedToast>;
}
