import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { native, type NotificationPopupBatch } from "../../ipc/native";
import { Icon } from "../../design-system/Icon";
import { TimedToast } from "./TimedToast";
import "./notificationPopup.css";

/** This entry deliberately does not hydrate AppState or mount the client shell. */
export function NotificationPopup() {
  const [batch, setBatch] = useState<NotificationPopupBatch | null>(null);
  // Why the last click did nothing, shown in the card it was made on: the
  // card stays when its action fails, and the window has no other surface.
  const [failure, setFailure] = useState<{ id: string; message: string } | null>(null);
  // Artwork that did not load. Its card is drawn without the artwork column,
  // not with an empty one: a hidden image gives up its grid cell, and the
  // text would otherwise fall into the narrow column meant for the picture.
  const [brokenArt, setBrokenArt] = useState<ReadonlySet<string>>(new Set());
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    const update = (next: NotificationPopupBatch) => {
      if (!disposed) setBatch((current) => current && current.revision > next.revision ? current : next);
    };
    // Listen before the snapshot so a second arrival cannot be lost at startup.
    void native.onNotificationPopup(update).then(async (unlisten) => {
      if (disposed) { unlisten(); return; }
      stop = unlisten;
      update(await native.notificationPopupSnapshot());
    }).catch(() => undefined);
    return () => { disposed = true; stop?.(); };
  }, []);
  useLayoutEffect(() => {
    if (!batch || !root.current || !batch.cards.length) return;
    document.documentElement.dataset.theme = batch.theme;
    const element = root.current;
    const size = () => void native.notificationPopupSize(batch.revision, element.scrollHeight).catch(() => undefined);
    const observer = new ResizeObserver(size);
    observer.observe(element);
    size();
    return () => observer.disconnect();
  }, [batch]);
  const interact = (id: string, interaction: "activate" | "dismiss" | "expire") => {
    if (interaction === "activate") setFailure(null);
    void native.notificationPopupInteract(id, interaction).catch((reason: unknown) => {
      if (interaction === "activate") setFailure({ id, message: String(reason) });
    });
  };
  return <div className="desktop-notification-stack" ref={root} aria-live="polite">
    {batch?.cards.map((card) => {
      const art = card.imageUrl && !brokenArt.has(card.imageUrl) ? card.imageUrl : null;
      return <TimedToast key={card.id === "preview" ? `${card.id}-${batch.revision}` : card.id}
        className={` desktop-notification${card.tone ? ` ${card.tone}` : ""}`} duration={batch.durationSeconds * 1000}
        onExpire={() => interact(card.id, "expire")}>
        <button className={`desktop-notification-main${art ? " has-art" : ""}`} type="button" onClick={() => interact(card.id, "activate")}>
          {art && <img className="desktop-notification-art" src={art} alt="" draggable={false}
            onError={() => setBrokenArt((current) => new Set(current).add(art))} />}
          <span className="desktop-notification-text">
            <span className="desktop-notification-title">
              <span className="desktop-notification-logo" aria-hidden="true" />
              <strong>{card.title}</strong>
            </span>
            <span className="desktop-notification-message">{card.body}</span>
            {card.actionLabel && <span className="desktop-notification-action">{card.actionLabel}</span>}
            {failure?.id === card.id && <span className="desktop-notification-error" role="alert">{failure.message}</span>}
          </span>
        </button>
        <button className="desktop-notification-dismiss" type="button" aria-label={batch.dismissLabel} onClick={() => interact(card.id, "dismiss")}>
          <Icon name="close" size={14} />
        </button>
      </TimedToast>;
    })}
  </div>;
}
