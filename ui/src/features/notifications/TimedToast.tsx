import { useEffect, useRef, type ReactNode } from "react";

/** One deadline shared by the in-client and desktop cards. */
export class ToastDeadline {
  private remaining: number;
  private started = 0;
  private finished = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(milliseconds: number, private readonly expire: () => void) {
    this.remaining = milliseconds;
  }
  resume() {
    if (this.timer !== undefined || this.finished) return;
    this.started = performance.now();
    this.timer = setTimeout(() => { this.timer = undefined; this.finished = true; this.expire(); }, this.remaining);
  }
  pause() {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.remaining = Math.max(0, this.remaining - (performance.now() - this.started));
  }
}

export function TimedToast({ duration, onExpire, className = "", children }: {
  duration: number; onExpire: () => void; className?: string; children: ReactNode;
}) {
  const expire = useRef(onExpire);
  expire.current = onExpire;
  const deadline = useRef<ToastDeadline | null>(null);
  const hovered = useRef(false);
  const focused = useRef(false);
  useEffect(() => {
    const timer = new ToastDeadline(duration, () => expire.current());
    deadline.current = timer;
    if (!hovered.current && !focused.current) timer.resume();
    return () => { timer.pause(); deadline.current = null; };
  }, [duration]);
  const update = () => {
    if (hovered.current || focused.current) deadline.current?.pause();
    else deadline.current?.resume();
  };
  return <article className={`notification-toast${className}`}
    onPointerEnter={() => { hovered.current = true; update(); }}
    onPointerLeave={() => { hovered.current = false; update(); }}
    onFocusCapture={() => { focused.current = true; update(); }}
    onBlurCapture={(event) => {
      if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
      focused.current = false; update();
    }}
  >{children}</article>;
}
