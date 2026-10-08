// @vitest-environment happy-dom
//
// The update banner while the installer downloads: its bar's Cancel sends the
// backend's cancel, and the offer it comes back to is the backend's to say.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { failOnConsoleError } from "../../testing/consoleGuard";
import { applyEvent, clearSentCommands, seedStore, sentCommands } from "../../testing/mounted";
import { UpdateBanner } from "./UpdateBanner";

vi.mock("../../ipc/client");

failOnConsoleError();

const release = {
  version: "0.9.0",
  notesUrl: "",
  downloadUrl: "https://example.invalid/installer.exe",
  assetName: "installer.exe",
  sizeBytes: 100,
  preRelease: false,
  publishedAt: "",
};

describe("UpdateBanner, downloading", () => {
  it("cancels the download from beside its bar, and offers it again once called off", async () => {
    const user = userEvent.setup();
    seedStore((state) => ({
      ...state,
      settings: { ...state.settings, updates: { ...state.settings.updates, automatic: true } },
      clientUpdate: {
        ...state.clientUpdate,
        release,
        status: { type: "downloading", payload: { receivedBytes: 25, totalBytes: 100 } },
      },
    }));
    render(<UpdateBanner />);
    clearSentCommands();

    await user.click(screen.getByRole("button", { name: "Cancel download" }));
    expect(sentCommands()).toEqual([{ kind: "ClientUpdate", command: { type: "cancelDownload" } }]);

    applyEvent({ kind: "ClientUpdate", event: { type: "downloadCancelled" } });
    expect(screen.queryByRole("button", { name: "Cancel download" })).toBeNull();
    expect(screen.getByRole("button", { name: "Download update" })).toHaveProperty("disabled", false);
  });
});
