import type { AppCommand } from "../../ipc/bindings";
import { afterEach, expect, it, vi } from "vitest";
import { loadLocalMapPreviews, resetLocalMapPreviewRequests } from "./useLocalMapPreview";

const { send } = vi.hoisted(() => ({ send: vi.fn<(command: AppCommand) => void>() }));
vi.mock("../../ipc/client", () => ({ ipc: { send } }));
afterEach(() => { resetLocalMapPreviewRequests(); vi.clearAllMocks(); });

it("batches distinct fallbacks in one turn, preserving the native request cap", async () => {
  for (let i = 0; i < 150; i++) loadLocalMapPreviews([`map_${i}.v0001`]);
  loadLocalMapPreviews(["map_0.v0002"]);
  expect(send).not.toHaveBeenCalled();
  await Promise.resolve();
  const commands = send.mock.calls.map(([command]) => command);
  expect(commands).toHaveLength(3);
  expect(commands.map((command) => command.kind === "Maps" && command.command.type === "loadLocalPreviews"
    ? command.command.payload.folderNames.length : 0)).toEqual([64, 64, 22]);
});

it("drops queued work when its request guard is reset", async () => {
  loadLocalMapPreviews(["old_map"]);
  resetLocalMapPreviewRequests();
  loadLocalMapPreviews(["new_map"]);
  await Promise.resolve();
  expect(send).toHaveBeenCalledExactlyOnceWith({ kind: "Maps", command: {
    type: "loadLocalPreviews", payload: { folderNames: ["new_map"] },
  } });
});
