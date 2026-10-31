import { useEffect, useRef, useState } from "react";

/** Brief copy feedback, restarted by every successful write to the clipboard. */
export function useClipboardCopy(text: string) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const active = useRef<object | null>(null);

  useEffect(() => {
    active.current = {};
    setCopied(false);
    return () => {
      active.current = null;
      window.clearTimeout(timer.current);
    };
  }, [text]);

  const copy = async () => {
    const owner = active.current;
    await navigator.clipboard.writeText(text);
    // A slow clipboard write must not update a closed card or another replay.
    if (owner === null || active.current !== owner) return;
    window.clearTimeout(timer.current);
    setCopied(true);
    timer.current = window.setTimeout(() => setCopied(false), 2_000);
  };

  return [copied, copy] as const;
}
