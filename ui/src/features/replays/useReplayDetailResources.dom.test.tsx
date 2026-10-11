// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { VaultReplay } from "../../ipc/bindings";
import { applyEvent, clearSentCommands, sentCommands } from "../../testing/mounted";
import { useReplayDetailResources } from "./useReplayDetailResources";

vi.mock("../../ipc/client");
const options = {
  replay: { uid: 7, teams: [] } as unknown as VaultReplay,
  initialLocalPath: undefined, isLocal: false
};

describe("replay analysis ownership in the panel", () => {
  it("retries a failed analysis while keeping the details already read", () => {
    const panel = renderHook(() => useReplayDetailResources(options));
    act(() => panel.result.current.requestInsights());
    applyEvent({ kind: "Replays", event: { type: "analysisLoading", payload: { key: "uid:7" } } });
    applyEvent({ kind: "Replays", event: { type: "detailsLoading", payload: { key: "uid:7" } } });
    applyEvent({ kind: "Replays", event: { type: "detailsLoaded", payload: {
      key: "uid:7", details: { gameOptions: [], chatMessages: [], gameVersion: null },
    } } });
    applyEvent({ kind: "Replays", event: { type: "analysisFailed", payload: {
      key: "uid:7", reason: "read failed",
    } } });
    clearSentCommands();
    act(() => panel.result.current.requestInsights());
    expect(sentCommands().filter((command) => command.kind === "Replays"
      && command.command.type === "loadAnalysis")).toHaveLength(1);
    expect(sentCommands().filter((command) => command.kind === "Replays"
      && command.command.type === "loadDetails")).toHaveLength(0);
    panel.unmount();
  });

  it("cancels its exact request on close and starts a replacement despite an old loading flag", () => {
    const first = renderHook(() => useReplayDetailResources(options));
    act(() => first.result.current.requestInsights());
    const load = sentCommands().find((command) => command.kind === "Replays" && command.command.type === "loadAnalysis");
    if (load?.kind !== "Replays" || load.command.type !== "loadAnalysis") throw new Error("no analysis request");
    applyEvent({ kind: "Replays", event: { type: "analysisLoading", payload: { key: "uid:7" } } });
    clearSentCommands();
    first.unmount();
    expect(sentCommands()).toContainEqual({
      kind: "Replays", command: {
        type: "cancelReads", payload: load.command.payload,
      }
    });
    clearSentCommands();
    const second = renderHook(() => useReplayDetailResources(options));
    act(() => second.result.current.requestInsights());
    const retry = sentCommands().find((command) => command.kind === "Replays" && command.command.type === "loadAnalysis");
    if (retry?.kind !== "Replays" || retry.command.type !== "loadAnalysis") throw new Error("no replacement request");
    expect(retry.command.payload.requestId).not.toBe(load.command.payload.requestId);
    clearSentCommands();
    act(() => second.result.current.cancelReads());
    second.unmount();
    expect(sentCommands().filter((command) => command.kind === "Replays" && command.command.type === "cancelReads")).toHaveLength(1);
  });
});
