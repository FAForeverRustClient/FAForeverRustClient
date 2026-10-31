// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Game, VaultReplay } from "../../ipc/bindings";
import "../../testing/mounted";
import { useClipboardCopy } from "../../shared/hooks/useClipboardCopy";
import { ReplayDetailPanel } from "./ReplayDetailPanel";
import { LiveReplayDetail } from "./live/LiveReplayDetail";

vi.mock("../../ipc/client");

const writeText = vi.fn<(text: string) => Promise<void>>();
const map = "neroxis_map_generator_1.21.2_ybufyzg64pai2_aqfqeai_aaaaaadkqocko";
const replay: VaultReplay = {
  uid: 4242, title: "Ladder night", map, mapThumbnailUrl: "", modName: "faf",
  startTime: "2026-01-02T18:00:00Z", replayAvailable: true, durationSeconds: 1200,
  gameDurationSeconds: 1100, teams: [], averageRating: 1500, quality: 80,
  reviewsAverage: null, reviewsCount: null, gameVersion: null,
};
const game: Game = {
  id: 4242, title: "Live game", map, host: "Host", players: 2, maxPlayers: 2,
  modName: "faf", averageRating: 1500, ratingType: "global", passwordProtected: false,
  visibility: "public", gameType: "custom", launchedAt: null, hostedAt: null,
  ratingMin: null, ratingMax: null, enforceRatingRange: false, teams: {}, simMods: {},
};

beforeEach(() => {
  vi.useFakeTimers();
  writeText.mockReset().mockResolvedValue();
  vi.spyOn(navigator.clipboard, "writeText").mockImplementation(writeText);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function mount(kind: "recorded" | "live") {
  return render(kind === "recorded"
    ? <ReplayDetailPanel replay={replay} busy={false} onClose={vi.fn()} onWatch={vi.fn()} />
    : <LiveReplayDetail game={game} busy={false} tracking={null} waitSeconds={0} onClose={vi.fn()} onPlayerMenu={vi.fn()} />);
}

async function click(button: HTMLElement) {
  await act(async () => { fireEvent.click(button); await Promise.resolve(); });
}

function advance(milliseconds: number) {
  act(() => { vi.advanceTimersByTime(milliseconds); });
}

function expectLabel(button: HTMLElement, label: string) {
  expect(button.getAttribute("aria-label")).toBe(label);
  expect(button.getAttribute("title")).toContain(label);
}

describe.each(["recorded", "live"] as const)("%s replay copy feedback", (kind) => {
  it("restores the ID and map icons and labels on independent two-second timers", async () => {
    mount(kind);
    const id = screen.getByRole("button", { name: "Copy replay ID" });
    const mapName = screen.getByRole("button", { name: "Copy the full map name" });
    const idIcon = id.innerHTML;
    const mapIcon = mapName.innerHTML;

    await click(id);
    expectLabel(id, "Replay ID copied");
    expect(id.innerHTML).not.toBe(idIcon);
    advance(500);
    await click(mapName);
    expectLabel(mapName, "Copied");
    expect(mapName.innerHTML).not.toBe(mapIcon);
    expect(writeText).toHaveBeenNthCalledWith(1, "4242");
    expect(writeText).toHaveBeenNthCalledWith(2, map);

    advance(1499);
    expectLabel(id, "Replay ID copied");
    advance(1);
    expectLabel(id, "Copy replay ID");
    expect(id.innerHTML).toBe(idIcon);
    expectLabel(mapName, "Copied");
    advance(500);
    expectLabel(mapName, "Copy the full map name");
    expect(mapName.innerHTML).toBe(mapIcon);
  });

  it("restarts the countdown when the same button successfully copies again", async () => {
    mount(kind);
    const id = screen.getByRole("button", { name: "Copy replay ID" });
    await click(id);
    advance(1500);
    await click(id);
    advance(500);
    expectLabel(id, "Replay ID copied");
    advance(1499);
    expectLabel(id, "Replay ID copied");
    advance(1);
    expectLabel(id, "Copy replay ID");
    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it("does not show success when the clipboard rejects a write", async () => {
    writeText.mockRejectedValue(new Error("Clipboard unavailable"));
    mount(kind);
    const id = screen.getByRole("button", { name: "Copy replay ID" });
    const icon = id.innerHTML;
    await click(id);
    expectLabel(id, "Copy replay ID");
    expect(id.innerHTML).toBe(icon);
    advance(2000);
    expectLabel(id, "Copy replay ID");
  });
});

it("restores the copied replay link independently of the copied ID", async () => {
  mount("recorded");
  const id = screen.getByRole("button", { name: "Copy replay ID" });
  const link = screen.getByRole("button", { name: "Copy link" });
  const icon = link.innerHTML;
  await click(id);
  advance(1000);
  await click(link);
  expectLabel(link, "Copied");
  expect(link.innerHTML).not.toBe(icon);
  expect(writeText).toHaveBeenLastCalledWith("https://replay.faforever.com/4242");
  advance(1000);
  expectLabel(id, "Copy replay ID");
  expectLabel(link, "Copied");
  advance(1000);
  expectLabel(link, "Copy link");
  expect(link.innerHTML).toBe(icon);
});

it("cancels pending feedback when the control is unmounted", async () => {
  const { result, unmount } = renderHook(() => useClipboardCopy("4242"));
  await act(async () => { await result.current[1](); });
  expect(result.current[0]).toBe(true);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("does not schedule feedback if a clipboard write finishes after closing", async () => {
  let finish!: () => void;
  writeText.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
  const { result, unmount } = renderHook(() => useClipboardCopy("4242"));
  const pending = result.current[1]();
  unmount();
  await act(async () => { finish(); await pending; });
  expect(vi.getTimerCount()).toBe(0);
});

it("clears feedback and ignores late writes when the copied value changes", async () => {
  const { result, rerender } = renderHook(({ text }) => useClipboardCopy(text), { initialProps: { text: "4242" } });
  await act(async () => { await result.current[1](); });
  expect(result.current[0]).toBe(true);
  let finish!: () => void;
  writeText.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve; }));
  const pending = result.current[1]();
  rerender({ text: "5151" });
  expect(result.current[0]).toBe(false);
  await act(async () => { finish(); await pending; });
  expect(result.current[0]).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  await act(async () => { await result.current[1](); });
  expect(result.current[0]).toBe(true);
  advance(2000);
  expect(result.current[0]).toBe(false);
});
