// @vitest-environment happy-dom

import { act, fireEvent, render, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { initialState } from "../../testing/mounted";
import type { EventsQuery } from "../../ipc/bindings";
import { useEventsQueryDraft } from "./useEventsQueryDraft";
import { EventsView } from "./EventsView";
import * as feed from "./calendarFeed";
import { en } from "../../i18n/catalog/en";

vi.mock("../../ipc/client");
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const empty = (): EventsQuery => initialState().events.query;

it("shows typing immediately, debounces writes and ignores an older own echo", () => {
  vi.useFakeTimers();
  const onQuery = vi.fn();
  const hook = renderHook(({ query }) => useEventsQueryDraft(query, onQuery), { initialProps: { query: empty() } });
  act(() => hook.result.current.patch({ text: "Coop" }));
  expect(hook.result.current.draft.text).toBe("Coop");
  expect(onQuery).not.toHaveBeenCalled();
  act(() => { vi.advanceTimersByTime(250); });
  expect(onQuery).toHaveBeenCalledExactlyOnceWith({ ...empty(), text: "Coop" });
  act(() => hook.result.current.patch({ text: "Cooper" }));
  hook.rerender({ query: { ...empty(), text: "Coop" } });
  expect(hook.result.current.draft.text).toBe("Cooper");
  act(() => { vi.advanceTimersByTime(250); });
  expect(onQuery).toHaveBeenLastCalledWith({ ...empty(), text: "Cooper" });
});

it("includes current typing in an immediate filter change and adopts external resets", () => {
  vi.useFakeTimers();
  const onQuery = vi.fn();
  const hook = renderHook(({ query }) => useEventsQueryDraft(query, onQuery), { initialProps: { query: empty() } });
  act(() => hook.result.current.patch({ text: "game" }));
  act(() => hook.result.current.patch({ onlyReminders: true }));
  expect(onQuery).toHaveBeenCalledExactlyOnceWith({ ...empty(), text: "game", onlyReminders: true });
  act(() => { vi.advanceTimersByTime(1000); });
  expect(onQuery).toHaveBeenCalledTimes(1);
  hook.rerender({ query: { ...empty(), origin: "official" } });
  expect(hook.result.current.draft).toEqual({ ...empty(), origin: "official" });
});

it("flushes pending typing on leaving the tab", () => {
  vi.useFakeTimers();
  const onQuery = vi.fn();
  const hook = renderHook(() => useEventsQueryDraft(empty(), onQuery));
  act(() => hook.result.current.patch({ text: "last draft" }));
  hook.unmount();
  expect(onQuery).toHaveBeenCalledExactlyOnceWith({ ...empty(), text: "last draft" });
});

it("filters locally without rebuilding the unchanged calendar feed", () => {
  const build = vi.spyOn(feed, "buildFeed");
  const view = render(<EventsView />);
  build.mockClear();
  const input = view.getByRole("searchbox", { name: en["events.filter.search"] }) as HTMLInputElement;
  fireEvent.change(input, { target: { value: "Cooper" } });
  expect(input.value).toBe("Cooper");
  expect(build).not.toHaveBeenCalled();
});
