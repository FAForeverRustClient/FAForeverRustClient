// The client update notice: one quiet button in the sidebar footer, above the
// profile, the way the Codex and Claude desktop apps say an update is there.
//
// It replaced a banner across the top of the workspace. An update is news,
// not an interruption: the banner pushed every tab down for as long as it was
// up, and it was the same size whether the update was optional or overdue.
// The notice is the size of a nav row, says what state the update is in, and
// opens a small popover beside the sidebar for the rest. The full-screen gate
// (`UpdateGate`) is for an update that is overdue; while the gate is up the
// notice stands aside, since both would be saying the same thing.
//
// Its states, read off the backend's status: available, downloading (with the
// share done as a thin bar under the label), ready (the accent button that
// starts the installer in one click), installing (the client has to be closed
// to finish), failed (with the reason, and a retry, in the popover).

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ClientUpdateState } from "../../ipc/bindings";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { OverlayParentContext, useOverlayLayer } from "../../design-system/useOverlayLayer";
import { overlayStack } from "../../design-system/overlayStack";
import { useTranslation } from "../../i18n/useTranslation";
import { ipc } from "../../ipc/client";
import { canOpenClientRelease, openClientRelease } from "../../shared/clientReleaseNotes";
import { openHttpsUrl, optionalHttpsUrl } from "../../shared/externalLinks";
import { formatSize } from "../../shared/format/installerSize";
import { plainError } from "../../shared/plainError";
import { menuPosition } from "../../shared/rules/menuPosition";
import { useAppStore } from "../../store/store";
import { updateBannerRelease, updatePercent } from "../../store/reducers/clientUpdate";
import { useGatedUpdate } from "./useGatedUpdate";
import "./updates.css";

const send = (type: "download" | "cancelDownload" | "install" | "dismiss") =>
  ipc.send({ kind: "ClientUpdate", command: { type } });

type Status = ClientUpdateState["status"];

export function UpdateNotice({ deferredVersion = null }: { deferredVersion?: string | null }) {
  const { t } = useTranslation();
  const update = useAppStore((s) => s.state.clientUpdate);
  const automatic = useAppStore((s) => s.state.settings.updates.automatic);
  const authMode = useAppStore((s) => s.state.auth.mode);
  const gated = useGatedUpdate(deferredVersion);
  const release = updateBannerRelease(update);
  // "Announce optional updates" off hides an optional one. An overdue one is
  // shown regardless: the gate is about to ask for it anyway.
  const visible = release !== null && !gated && (automatic || update.overdue === true);
  const [open, setOpen] = useState(false);
  const opened = open && visible;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x: 8, y: 8, maxHeight: 600 });
  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus({ preventScroll: true });
  }, []);
  const layer = useOverlayLayer(opened, close, { trapsFocus: true, elementRef: popoverRef });

  // Beside the button, out of the sidebar, as the notification panel next to
  // it opens; placed again whenever the status changes what it holds.
  useLayoutEffect(() => {
    if (!opened) return;
    const trigger = triggerRef.current?.getBoundingClientRect();
    const popover = popoverRef.current;
    if (!trigger || !popover) return;
    setPosition(menuPosition({ x: trigger.left, y: trigger.top }, trigger,
      popover.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight }));
    popover.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  }, [opened, update.status.type, release?.version]);

  useEffect(() => {
    if (!opened) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!popoverRef.current?.contains(target) && !triggerRef.current?.contains(target)) close();
    };
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("resize", close);
    };
  }, [opened, close]);

  if (!visible || !release) return null;
  const status = update.status;
  const ready = status.type === "ready";
  const failed = status.type === "failed";
  const downloading = status.type === "downloading";
  const busy = downloading || status.type === "installing";
  const percent = updatePercent(status);
  // The button's accessible name names the state; the visible label adds the
  // share while downloading. The live region reads the name, so a screen
  // reader hears each state once rather than every percent.
  const label = stateLabel(status, t);
  const shown = downloading && percent !== null ? t("updates.notice.downloading", { percent }) : label;
  const notesUrl = optionalHttpsUrl(release.notesUrl);
  const notesInClient = canOpenClientRelease(update.notes, authMode, release.version);
  const size = formatSize(release.sizeBytes);
  const title = t(release.preRelease ? "updates.available.prerelease" : "updates.available.stable", {
    version: release.version,
  });
  const openNotes = () => {
    close();
    if (notesInClient) openClientRelease(release.version);
    else if (notesUrl) void openHttpsUrl(notesUrl);
  };

  // The popover's one primary action: download, retry or install while there
  // is an installer, the release page when this platform has none, and while
  // a download runs, the way to stop it.
  const primary = downloading ? (
    <Button onClick={() => send("cancelDownload")}>{t("updates.cancelDownload")}</Button>
  ) : busy ? null : release.downloadUrl ? (
    <Button variant="primary" onClick={() => send(ready ? "install" : "download")}>
      {ready ? t("updates.notice.install") : failed ? t("updates.notice.retry") : t("updates.download")}
    </Button>
  ) : notesUrl ? (
    <Button variant="primary" onClick={() => void openHttpsUrl(notesUrl)}>{t("updates.required.openPage")}</Button>
  ) : null;

  return (
    <div className="update-notice">
      <button
        ref={triggerRef}
        type="button"
        className={["update-notice-button", ready ? "is-ready" : "", failed ? "is-failed" : ""].filter(Boolean).join(" ")}
        aria-label={label}
        title={shown}
        aria-haspopup={ready ? undefined : "dialog"}
        aria-expanded={ready ? undefined : opened}
        // Ready is the one state with a single obvious next step, so the
        // button takes it; every other state opens the popover.
        onClick={() => (ready ? send("install") : setOpen(!open))}
      >
        <span className="update-notice-icon">
          <Icon name={failed ? "alert" : "download"} size={16} />
          {/* Something new is waiting: only before anything has been done
              about it. A dot on every state read as noise on the icon. */}
          {status.type === "available" && <i />}
        </span>
        <span className="update-notice-label" aria-hidden="true">{shown}</span>
        {downloading && (
          <span className={`update-notice-progress${percent === null ? " is-indeterminate" : ""}`} aria-hidden="true">
            <span style={{ width: `${percent === null ? 100 : Math.min(100, percent)}%` }} />
          </span>
        )}
      </button>
      <span className="update-notice-status" role="status">{label}</span>
      {opened && createPortal(
        <OverlayParentContext.Provider value={layer}>
          <div
            ref={popoverRef}
            className="update-notice-popover"
            role="dialog"
            aria-modal="true"
            aria-label={title}
            onKeyDown={(event) => {
              if (event.key !== "Tab" || overlayStack.topFocusTrap() !== layer) return;
              const controls = Array.from(popoverRef.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? []);
              const first = controls[0];
              const last = controls[controls.length - 1];
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
              }
            }}
            style={{ left: position.x, top: position.y, maxHeight: position.maxHeight }}
          >
            <div className="update-notice-heading">
              <h3>{title}</h3>
              <button type="button" className="update-notice-close" aria-label={t("common.close")} onClick={close}>
                <Icon name="close" size={16} />
              </button>
            </div>
            <p className="muted">
              {update.currentVersion && t("updates.running", { version: update.currentVersion })}{" "}
              {size && t("updates.installerSize", { size })}
            </p>
            {status.type === "installing" && <p>{t("updates.started")}</p>}
            {failed && <p className="update-notice-error">{plainError(status.payload.reason)}</p>}
            {!release.downloadUrl && <p>{t("updates.noInstallerFor", { version: release.version })}</p>}
            <div className="update-notice-actions">
              {primary}
              {(notesInClient || notesUrl) && <Button onClick={openNotes}>{t("updates.whatsNew")}</Button>}
              {/* Not offered mid-download or mid-install: it would hide the
                  notice while the work it describes carried on. */}
              {!busy && (
                <Button className="update-notice-later" onClick={() => { send("dismiss"); close(); }}>
                  {t("updates.notice.notNow")}
                </Button>
              )}
            </div>
          </div>
        </OverlayParentContext.Provider>,
        document.body,
      )}
    </div>
  );
}

function stateLabel(status: Status, t: ReturnType<typeof useTranslation>["t"]): string {
  switch (status.type) {
    case "ready":
      return t("updates.notice.install");
    case "installing":
      return t("updates.notice.closeToFinish");
    case "failed":
      return t("updates.notice.failed");
    case "downloading":
      return t("updates.notice.downloadingUnknown");
    default:
      return t("updates.notice.available");
  }
}
