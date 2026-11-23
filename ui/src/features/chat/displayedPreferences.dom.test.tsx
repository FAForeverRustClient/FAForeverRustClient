// @vitest-environment happy-dom

import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useAppStore } from "../../store/store";
import { sameApartFromReadMarkers, useDisplayedChatPreferences } from "./displayedPreferences";

const initial = useAppStore.getState();
afterEach(() => useAppStore.setState(initial, true));

const chat = () => useAppStore.getState().state.settings.chat;
const assignChat = (patch: Partial<ReturnType<typeof chat>>) =>
  act(() => {
    useAppStore.getState().apply({ kind: "Settings", event: { field: "chat", value: { ...chat(), ...patch } } });
  });

it("treats groups differing only in read markers as the same", () => {
  const base = chat();
  expect(sameApartFromReadMarkers(base, { ...base, readMarkers: { "player:#aeolus": "2026-11-23T20:00:00Z" } })).toBe(true);
  expect(sameApartFromReadMarkers(base, { ...base, showTimestamps: !base.showTimestamps })).toBe(false);
});

it("keeps the same object when marking a channel read replaces the group", () => {
  const hook = renderHook(() => useDisplayedChatPreferences());
  const first = hook.result.current;

  assignChat({ readMarkers: { "player:#aeolus": "2026-11-23T20:00:00Z" } });
  hook.rerender();
  expect(hook.result.current).toBe(first);

  assignChat({ showTimestamps: !first.showTimestamps });
  hook.rerender();
  expect(hook.result.current).not.toBe(first);
  expect(hook.result.current.showTimestamps).toBe(!first.showTimestamps);
});
