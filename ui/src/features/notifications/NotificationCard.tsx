import type { ReactNode } from "react";
import type { ClientNotification } from "../../ipc/bindings";
import { Icon } from "../../design-system/Icon";
import { formatTime } from "../../shared/format/dates";
import { renderFormattedText } from "../chat/messages/chatFormat";
import { NotificationArtwork } from "./notificationArtwork";
import { actionContent, notificationTone } from "./notificationPresentation";
import { notificationBody, notificationBodyDetail, notificationTitle } from "./notificationText";
import { TimedToast } from "./TimedToast";
import { t } from "../../i18n";
import "./notifications.css";

export function NotificationCard({ item, artwork, history = false, use24HourTime = true,
  duration = 0, onActivate, onDismiss, onExpire = onDismiss, recovery }: {
  item: ClientNotification; artwork: string | null; history?: boolean; use24HourTime?: boolean;
  duration?: number; onActivate: () => void; onDismiss: () => void; onExpire?: () => void; recovery?: ReactNode;
}) {
  const title = <span className="notification-title"><NotificationArtwork url={artwork} /><strong>{notificationTitle(item)}</strong></span>;
  const content = <>
    <button className={history ? "notification-content" : undefined} type="button" onClick={onActivate}>
      {history ? <span className="notification-item-head">{title}<time dateTime={item.createdAt}>{formatTime(item.createdAt, "", use24HourTime)}</time></span> : title}
      <span className="notification-message-row">
        <span className="notification-body" title={notificationBodyDetail(item) ?? undefined}>{renderFormattedText(notificationBody(item))}</span>
        {actionContent(item.action)}
      </span>
    </button>
    <button className="notification-dismiss" type="button" onClick={onDismiss} aria-label={t("notifications.dismiss", { title: notificationTitle(item) })}><Icon name="close" size={12} /></button>
    {recovery}
  </>;
  return history
    ? <article className={`notification-item${item.read ? " is-read" : ""}${notificationTone(item)}`}>{content}</article>
    : <TimedToast className={notificationTone(item)} duration={duration} onExpire={onExpire}>{content}</TimedToast>;
}
