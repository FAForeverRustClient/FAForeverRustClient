import type { ReactNode } from "react";
import type { ClientNotification } from "../../ipc/bindings";
import { Icon } from "../../design-system/Icon";
import { formatTime } from "../../shared/format/dates";
import { renderFormattedText } from "../chat/messages/chatFormat";
import { NotificationArtwork } from "./notificationArtwork";
import { actionContent, actionLabel, notificationTone } from "./notificationPresentation";
import { notificationBody, notificationBodyDetail, notificationTitle } from "./notificationText";
import { TimedToast } from "./TimedToast";
import { t } from "../../i18n";
import "./notifications.css";

export function NotificationCard({ item, artwork, history = false, use24HourTime = true,
  duration = 0, onActivate, onDismiss, onExpire = onDismiss, recovery }: {
  item: ClientNotification; artwork: string | null; history?: boolean; use24HourTime?: boolean;
  duration?: number; onActivate: () => void; onDismiss: () => void; onExpire?: () => void; recovery?: ReactNode;
}) {
  const heading = notificationTitle(item);
  const title = <strong className="notification-title">{heading}</strong>;
  const hasAction = item.action !== null;
  const activateName = actionLabel(item.action) ?? heading;
  const content = <>
    <div className="notification-entry">
      <div
        className={`notification-content${hasAction ? "" : " is-static"}`}
        onClick={hasAction ? (event) => {
          if (!(event.target as HTMLElement | null)?.closest("a, button")) onActivate();
        } : undefined}
      >
        {hasAction && (
          <button
            type="button"
            className="notification-activate"
            aria-label={activateName}
            onClick={onActivate}
          />
        )}
        <NotificationArtwork url={artwork} />
        <span className="notification-text">
          {title}
          <span className="notification-body" title={notificationBodyDetail(item) ?? undefined}>{renderFormattedText(notificationBody(item))}</span>
          {history && <time dateTime={item.createdAt}>{formatTime(item.createdAt, "", use24HourTime)}</time>}
        </span>
        {actionContent(item.action)}
      </div>
      <button className="notification-dismiss" type="button" onClick={onDismiss} aria-label={t("notifications.dismiss", { title: heading })}><Icon name="close" size={history ? 14 : 18} /></button>
    </div>
    {recovery}
  </>;
  return history
    ? <article className={`notification-item${item.read ? " is-read" : ""}${notificationTone(item)}`}>{content}</article>
    : <TimedToast className={notificationTone(item)} duration={duration} onExpire={onExpire}>{content}</TimedToast>;
}
