// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useVaultFilters, useVaultSearch } from "./useVaultFilters";

vi.mock("../../ipc/client");
afterEach(cleanup);
type Filter = { search: string; sort: "rating" | "name" };
const presetSort = (preset: "recommended" | "all") => preset === "all" ? "name" : "rating";

describe("shared vault filter ownership", () => {
  it("keeps draft edits through paging and sort changes until explicitly applied", () => {
    const { result } = renderHook(() => useVaultFilters<Filter, "all" | "recommended">({
      initial: { search: "old", sort: "rating" }, initialPage: 3,
      memoryKey: "test.vault", preset: "recommended", presetSort,
    }));
    act(() => result.current.setFilter("search", "new"));
    expect(result.current.applied.search).toBe("old");
    act(() => result.current.applySort("name"));
    expect(result.current.draft.search).toBe("new");
    expect(result.current.applied).toEqual({ search: "old", sort: "name" });
    expect(result.current.page).toBe(1);
    act(() => result.current.setPage(2));
    expect(result.current.applied.search).toBe("old");
    act(() => result.current.applySearch());
    expect(result.current.applied.search).toBe("new");
    expect(result.current.page).toBe(1);
  });

  it("preserves a restored sort on mount and resets every field together", () => {
    const { result, rerender } = renderHook(({ preset }: { preset: "all" | "recommended" }) => useVaultFilters<Filter, "all" | "recommended">({
      initial: { search: "saved", sort: "name" }, initialPage: 2,
      memoryKey: "test.vault.reset", preset, presetSort,
    }), { initialProps: { preset: "recommended" } });
    expect(result.current.applied.sort).toBe("name");
    rerender({ preset: "all" });
    rerender({ preset: "recommended" });
    expect(result.current.draft.sort).toBe("rating");
    act(() => result.current.reset({ search: "", sort: "rating" }));
    expect(result.current.applied).toEqual(result.current.draft);
    expect(result.current.applied.search).toBe("");
    expect(result.current.page).toBe(1);
  });

  it("sends only changed server queries, with local presets answering from the catalogue", () => {
    const search = vi.fn();
    const query = { page: 1 };
    const { rerender } = renderHook(({ local, query }) => useVaultSearch(query, local, search), {
      initialProps: { local: true, query },
    });
    expect(search).not.toHaveBeenCalled();
    rerender({ local: false, query });
    expect(search).toHaveBeenCalledTimes(1);
    rerender({ local: false, query });
    expect(search).toHaveBeenCalledTimes(1);
    rerender({ local: false, query: { page: 2 } });
    expect(search).toHaveBeenLastCalledWith({ page: 2 });
  });
});
