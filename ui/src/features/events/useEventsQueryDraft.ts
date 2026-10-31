import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { EventsQuery } from "../../ipc/bindings";

const same = (a: EventsQuery, b: EventsQuery) => a.text === b.text
  && a.category === b.category && a.origin === b.origin && a.onlyReminders === b.onlyReminders;

/** Immediate local filtering, with backend echoes kept from replacing newer typing. */
export function useEventsQueryDraft(query: EventsQuery, onQuery: (query: EventsQuery) => void) {
  const [draft, setDraft] = useState(query);
  const current = useRef(query);
  const sent = useRef<EventsQuery[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ query, onQuery });
  useLayoutEffect(() => { latest.current = { query, onQuery }; });

  const deliver = useCallback((next: EventsQuery) => {
    if (!same(next, latest.current.query)) sent.current.push(next);
    latest.current.onQuery(next);
  }, []);

  const patch = useCallback((change: Partial<EventsQuery>) => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    const next = { ...current.current, ...change };
    current.current = next;
    setDraft(next);
    if (Object.keys(change).every(key => key === "text")) {
      timer.current = setTimeout(() => {
        timer.current = null;
        deliver(current.current);
      }, 250);
    } else {
      deliver(next);
    }
  }, [deliver]);

  useEffect(() => {
    const echo = sent.current.findIndex(snapshot => same(snapshot, query));
    if (echo >= 0) {
      sent.current.splice(0, echo + 1);
      return;
    }
    sent.current = [];
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    if (!same(current.current, query)) {
      current.current = query;
      setDraft(query);
    }
  }, [query]);

  useEffect(() => () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      deliver(current.current);
    }
  }, [deliver]);

  return { draft, patch };
}
