import { useCallback, useEffect, useRef, useState } from "react";

/** Coalesce pointer/slider updates and cancel pending work on clear/unmount. */
export function useFrameState<T>(initial: T) {
  const [value, setValue] = useState(initial);
  const pending = useRef(initial);
  const frame = useRef<number | null>(null);
  const cancel = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  }, []);
  useEffect(() => cancel, [cancel]);
  const schedule = useCallback((next: T) => {
    pending.current = next;
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      setValue(pending.current);
    });
  }, []);
  const immediately = useCallback((next: T) => {
    cancel();
    pending.current = next;
    setValue(next);
  }, [cancel]);
  return [value, schedule, immediately] as const;
}
