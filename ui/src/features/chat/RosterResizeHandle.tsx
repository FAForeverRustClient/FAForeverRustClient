import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "../../i18n/useTranslation";

export const ROSTER_MIN_WIDTH = 190;
export const ROSTER_MAX_WIDTH = 520;

const KEYBOARD_STEP = 12;

export function clampRosterWidth(width: number): number {
  return Math.min(ROSTER_MAX_WIDTH, Math.max(ROSTER_MIN_WIDTH, Math.round(width)));
}

export function RosterResizeHandle({
  width,
  onResize,
  onCommit,
}: {
  width: number;
  onResize: (width: number) => void;
  onCommit: (width: number) => void;
}) {
  const { t } = useTranslation();
  const [resizing, setResizing] = useState(false);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const widthRef = useRef(width);
  widthRef.current = width;

  useEffect(() => {
    if (!resizing) return;

    const move = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const next = clampRosterWidth(drag.startWidth + drag.startX - event.clientX);
      widthRef.current = next;
      onResize(next);
    };
    const stop = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      setResizing(false);
      onCommit(widthRef.current);
    };

    document.documentElement.classList.add("is-resizing-chat-roster");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      document.documentElement.classList.remove("is-resizing-chat-roster");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [onCommit, onResize, resizing]);

  const start = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    dragRef.current = { startX: event.clientX, startWidth: width };
    widthRef.current = width;
    setResizing(true);
  };

  const resizeFromKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = width + KEYBOARD_STEP;
    if (event.key === "ArrowRight") next = width - KEYBOARD_STEP;
    if (event.key === "Home") next = ROSTER_MIN_WIDTH;
    if (event.key === "End") next = ROSTER_MAX_WIDTH;
    if (next === null) return;
    event.preventDefault();
    next = clampRosterWidth(next);
    onResize(next);
    onCommit(next);
  };

  return (
    <div
      className={`chat-roster-resizer${resizing ? " is-active" : ""}`}
      role="separator"
      tabIndex={0}
      aria-label={t("chat.roster.resize")}
      aria-orientation="vertical"
      aria-valuemin={ROSTER_MIN_WIDTH}
      aria-valuemax={ROSTER_MAX_WIDTH}
      aria-valuenow={width}
      aria-controls="chat-roster"
      onKeyDown={resizeFromKeyboard}
      onPointerDown={start}
    />
  );
}
