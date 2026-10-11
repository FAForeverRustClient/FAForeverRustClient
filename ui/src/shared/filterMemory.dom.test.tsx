// @vitest-environment happy-dom
//
// How long a list's filters are remembered is one setting for every list
// (#447): never, until the client closes, or also across a restart.

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppCommand, FilterMemory } from "../ipc/bindings";
import { seedStore, sentCommands } from "../testing/mounted";
import {
  filterMemoryChanged,
  rememberedFilter,
  resetFilterMemoryForTests,
  useForgetFiltersOnLeave,
  useRememberedFilter,
} from "./filterMemory";

vi.mock("../ipc/client");

afterEach(() => {
  vi.useRealTimers();
  resetFilterMemoryForTests();
});

function withMemory(filterMemory: FilterMemory, rememberedFilters: Record<string, string> = {}) {
  seedStore((state) => ({
    ...state,
    settings: {
      ...state.settings,
      general: { ...state.settings.general, filterMemory },
      browsing: { ...state.settings.browsing, rememberedFilters },
    },
  }));
}

/** The stored filters every browsing patch sent so far carried, oldest first. */
function storedWrites(): Array<Record<string, string>> {
  return sentCommands().flatMap((command: AppCommand) =>
    command.kind === "Settings" && command.command.type === "patchBrowsing"
      && command.command.payload.patch.rememberedFilters
      ? [command.command.payload.patch.rememberedFilters]
      : []);
}

/** The stored filters the last write carried. */
function lastStoredWrite(): Record<string, string> | undefined {
  const writes = storedWrites();
  return writes[writes.length - 1];
}

/** Type into a remembered search, leave the tab, and open it again. */
function typeLeaveAndReturn(text: string) {
  const first = renderHook(() => useRememberedFilter("test.search", ""));
  act(() => first.result.current[1](text));
  first.unmount();
  return renderHook(() => useRememberedFilter("test.search", "")).result.current[0];
}

describe("remembered filters", () => {
  it("start unfiltered on every visit when filters are never remembered", () => {
    withMemory("never");
    expect(typeLeaveAndReturn("seton")).toBe("");
    expect(storedWrites()).toEqual([]);
  });

  it("survive leaving the tab for the session, without writing the settings file", () => {
    withMemory("session");
    expect(typeLeaveAndReturn("seton")).toBe("seton");
    expect(storedWrites()).toEqual([]);
  });

  it("are written down for the next start when the setting keeps them that long", () => {
    withMemory("restart", { "other.list": "\"kept\"" });
    expect(typeLeaveAndReturn("seton")).toBe("seton");
    // The other list's filter is carried along, not overwritten.
    expect(lastStoredWrite()).toEqual({ "other.list": "\"kept\"", "test.search": "\"seton\"" });
  });

  it("are read back after a restart only when the setting keeps them that long", () => {
    withMemory("restart", { "test.search": "\"seton\"" });
    expect(rememberedFilter("test.search", "")).toBe("seton");
    resetFilterMemoryForTests();
    withMemory("session", { "test.search": "\"seton\"" });
    expect(rememberedFilter("test.search", "")).toBe("");
  });

  it("ignore a stored copy of the wrong shape", () => {
    withMemory("restart", { "test.search": "42", broken: "{" });
    const isText = (value: unknown) => typeof value === "string";
    expect(rememberedFilter("test.search", "", isText)).toBe("");
    expect(rememberedFilter("broken", "fallback")).toBe("fallback");
  });

  it("write the session down when the setting changes to keep them across a restart", () => {
    withMemory("session");
    typeLeaveAndReturn("seton");
    filterMemoryChanged("restart");
    expect(lastStoredWrite()).toEqual({ "test.search": "\"seton\"" });
  });

  it("are all dropped when the setting changes to never", () => {
    withMemory("session");
    typeLeaveAndReturn("seton");
    filterMemoryChanged("never");
    withMemory("never");
    expect(rememberedFilter("test.search", "")).toBe("");
    expect(lastStoredWrite()).toEqual({});
  });

  it("clear a list's own preference on leaving the tab only when never remembered", () => {
    for (const memory of ["never", "session", "restart"] as const) {
      withMemory(memory);
      const forget = vi.fn();
      renderHook(() => useForgetFiltersOnLeave(forget)).unmount();
      expect(forget).toHaveBeenCalledTimes(memory === "never" ? 1 : 0);
    }
  });
});
