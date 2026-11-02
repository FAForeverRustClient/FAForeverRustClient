import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { native, type NotificationPopupBatch } from "../../ipc/native";
import { DesktopNotificationCard } from "./DesktopNotificationCard";
import "./notificationPopup.css";

/** This entry deliberately does not hydrate AppState or mount the client shell. */
export function NotificationPopup() {
  const [batch, setBatch] = useState<NotificationPopupBatch | null>(null);
  // Why the last click did nothing, shown in the card it was made on: the
  // card stays when its action fails, and the window has no other surface.
  const [failure, setFailure] = useState<{ id: string; message: string } | null>(null);
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
    // The size report proves layout, and layout runs whether or not anything
    // is drawn: a webview that had stopped drawing kept reporting it while
    // its transparent window showed nothing. Chromium runs animation frames
    // only for a page it draws, so two of them after this commit prove the
    // cards reached the screen.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => void native.notificationPopupPainted(batch.revision).catch(() => undefined));
    });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [batch]);
  const interact = (id: string, interaction: "activate" | "dismiss" | "expire") => {
    if (interaction === "activate") setFailure(null);
    void native.notificationPopupInteract(id, interaction).catch((reason: unknown) => {
      if (interaction === "activate") setFailure({ id, message: String(reason) });
    });
  };
  return <div className="desktop-notification-stack" ref={root} aria-live="polite">
    {batch?.cards.map((card) => <DesktopNotificationCard
      key={card.id}
      card={card} duration={batch.heldPreviewIds.includes(card.id) ? 0 : batch.durationSeconds * 1000} dismissLabel={batch.dismissLabel}
      onInteract={(interaction) => interact(card.id, interaction)}
      failure={failure?.id === card.id ? failure.message : undefined}
    />)}
  </div>;
}
