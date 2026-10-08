// @vitest-environment happy-dom
//
// The publish dialog while it publishes: a real stop beside Hide for as long
// as the archive is being packed or sent, and none once every byte is out,
// when the vault decides and a stop could not keep it out.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { UploadStatus } from "../../ipc/bindings";
import { failOnConsoleError } from "../../testing/consoleGuard";
import { clearSentCommands, seedStore, sentCommands } from "../../testing/mounted";
import { UploadDialog } from "./UploadDialog";

vi.mock("../../ipc/client");

failOnConsoleError();

function mountPublishing(status: UploadStatus) {
  seedStore((state) => ({
    ...state,
    uploads: {
      request: {
        kind: "map",
        folderName: "my_map.v0001",
        displayName: "My Map",
        ranked: false,
        sourcePath: null,
        renameTo: "",
      },
      status,
      preview: "",
    },
  }));
  render(<UploadDialog />);
  clearSentCommands();
}

describe("UploadDialog, publishing", () => {
  it("stops a publish whose bytes are still going out", async () => {
    const user = userEvent.setup();
    mountPublishing({ type: "uploading", payload: { sentBytes: 50, totalBytes: 100 } });

    await user.click(screen.getByRole("button", { name: "Stop publishing" }));
    expect(sentCommands()).toEqual([{ kind: "Uploads", command: { type: "cancel" } }]);
  });

  it("offers no stop once every byte is out", () => {
    mountPublishing({ type: "uploading", payload: { sentBytes: 100, totalBytes: 100 } });

    expect(screen.queryByRole("button", { name: "Stop publishing" })).toBeNull();
    expect(screen.getByRole("button", { name: "Hide" })).toBeTruthy();
  });
});
