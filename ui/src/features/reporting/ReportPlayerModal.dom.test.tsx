// @vitest-environment happy-dom
//
// The report dialog's game log opt-in, mounted. FAF reports take no files, so
// a log goes in as text appended to the description; what these pin is the
// user's side of that: nothing is attached until the box is ticked, the
// excerpt is shown before it is sent, the text shown is the text sent, and a
// log that is not of the reported game says so.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AppCommand, ModerationReportSummary, ReportLogExcerpt } from "../../ipc/bindings";
import { failOnConsoleError } from "../../testing/consoleGuard";
import { applyEvent, clearSentCommands, seedStore, sentCommands } from "../../testing/mounted";
import { ReportPlayerModal } from "./ReportPlayerModal";

vi.mock("../../ipc/client");

failOnConsoleError();

const BLOCK = [
  "===== GAME LOG EXCERPT (attached by the reporter's client) =====",
  "Source: the reporter's log of game #4242, the game this report names.",
  "-- Error, desync and disconnect lines before the end: 1 of 1 distinct, oldest first; (xN) = repeated N times --",
  "warning: Desync detected at beat 4100",
  "-- The last 1 of 5321 lines --",
  "info: peer <ip> disconnected",
  "===== END OF GAME LOG EXCERPT =====",
].join("\n");

const WORDS = "He destroyed my base after we allied.";

function excerpt(overrides: Partial<ReportLogExcerpt> = {}): ReportLogExcerpt {
  return {
    requestedGameId: 4242,
    logGameId: 4242,
    fileName: "game-4242-1700000000-1.log",
    block: BLOCK,
    totalLines: 5321,
    keptLines: 2,
    redactions: 3,
    ...overrides,
  };
}

function prepared(overrides: Partial<ReportLogExcerpt> = {}) {
  applyEvent({
    kind: "Reporting",
    event: { type: "logPrepared", payload: { excerpt: excerpt(overrides) } },
  });
}

function mountDialog(history: ModerationReportSummary[] = []) {
  seedStore((state) => ({
    ...state,
    reporting: { ...state.reporting, open: true, playerId: 7, login: "Aurora", history },
  }));
  render(<ReportPlayerModal />);
  clearSentCommands();
}

const reportingCommands = () =>
  sentCommands().filter(
    (command): command is Extract<AppCommand, { kind: "Reporting" }> => command.kind === "Reporting",
  );

const checkbox = () =>
  screen.getByRole<HTMLInputElement>("checkbox", { name: "Attach an excerpt of my game log" });

const submitButton = () =>
  screen.getByRole<HTMLButtonElement>("button", { name: "Submit report" });

async function fillReport(user: ReturnType<typeof userEvent.setup>, gameId: string) {
  await user.type(screen.getByRole("textbox", { name: /What happened/ }), WORDS);
  await user.type(screen.getByRole("textbox", { name: /Approximate in-game time/ }), "18:30");
  if (gameId) await user.type(screen.getByRole("spinbutton", { name: /Game ID/ }), gameId);
}

describe("attaching a game log to a report", () => {
  it("sends nothing about a log until the box is ticked, then asks for the reported game's", async () => {
    const user = userEvent.setup();
    mountDialog();
    await fillReport(user, "4242");
    expect(reportingCommands()).toEqual([]);
    expect(checkbox().checked).toBe(false);

    await user.click(checkbox());

    expect(reportingCommands()).toEqual([
      { kind: "Reporting", command: { type: "attachLog", payload: { gameId: 4242 } } },
    ]);
  });

  it("shows the exact excerpt before sending, and the report sends it", async () => {
    const user = userEvent.setup();
    mountDialog();
    await fillReport(user, "4242");
    await user.click(checkbox());
    applyEvent({ kind: "Reporting", event: { type: "logPreparing", payload: { gameId: 4242 } } });

    expect(checkbox().checked).toBe(true);
    expect(screen.getByRole("status").textContent).toContain("Reading your game log");
    // Nothing goes until the user has the excerpt in front of them.
    expect(submitButton().disabled).toBe(true);

    prepared();
    expect(screen.getByText("From your log of game #4242")).toBeTruthy();
    expect(
      screen.getByText(
        `Characters: ${Array.from(BLOCK).length}. Lines kept: 2 of 5,321. Personal details removed: 3.`,
      ),
    ).toBeTruthy();
    // Folded until asked for, so the form stays a form.
    expect(screen.queryByLabelText("The game log excerpt that will be sent")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Show what will be sent" }));
    expect(screen.getByLabelText("The game log excerpt that will be sent").textContent).toBe(BLOCK);
    expect(
      screen.getByRole("button", { name: "Hide the excerpt" }).getAttribute("aria-expanded"),
    ).toBe("true");

    clearSentCommands();
    expect(submitButton().disabled).toBe(false);
    await user.click(submitButton());
    expect(reportingCommands()).toEqual([
      {
        kind: "Reporting",
        command: {
          type: "submit",
          payload: {
            playerId: 7,
            login: "Aurora",
            description: WORDS,
            gameId: 4242,
            incidentTime: "18:30",
            attachLog: true,
          },
        },
      },
    ]);
  });

  it("submits without the log when the box is left alone", async () => {
    const user = userEvent.setup();
    mountDialog();
    await fillReport(user, "4242");

    await user.click(submitButton());

    expect(reportingCommands()).toEqual([
      {
        kind: "Reporting",
        command: {
          type: "submit",
          payload: {
            playerId: 7,
            login: "Aurora",
            description: WORDS,
            gameId: 4242,
            incidentTime: "18:30",
            attachLog: false,
          },
        },
      },
    ]);
  });

  it("unticking takes the log off again", async () => {
    const user = userEvent.setup();
    mountDialog();
    prepared({ requestedGameId: null });
    expect(checkbox().checked).toBe(true);

    await user.click(checkbox());

    expect(reportingCommands()).toEqual([{ kind: "Reporting", command: { type: "detachLog" } }]);
  });

  it("reads the log again when the game ID changes while ticked", async () => {
    const user = userEvent.setup();
    mountDialog();
    await fillReport(user, "");
    await user.click(checkbox());
    prepared({ requestedGameId: null });
    expect(submitButton().disabled).toBe(false);
    clearSentCommands();

    await user.type(screen.getByRole("spinbutton", { name: /Game ID/ }), "77");

    // After the field rests, and once, for the whole ID rather than per digit.
    await waitFor(() =>
      expect(reportingCommands()).toEqual([
        { kind: "Reporting", command: { type: "attachLog", payload: { gameId: 77 } } },
      ]),
    );
    // The excerpt on screen was read for no game ID, so it cannot go with
    // a report about game 77.
    expect(submitButton().disabled).toBe(true);
  });

  it("says so when the excerpt is not of the game the report names", () => {
    mountDialog();
    prepared({ logGameId: 41 });

    expect(screen.getByText("From your most recent game log (game #41)")).toBeTruthy();
    expect(
      screen.getByText(
        "No log of game #4242 is kept on this computer, so your most recent game log would be sent instead. Untick the box if that is not the right game.",
      ),
    ).toBeTruthy();
  });

  it("says plainly when there is no log, and offers Retry when it could not be read", async () => {
    const user = userEvent.setup();
    mountDialog();
    applyEvent({ kind: "Reporting", event: { type: "logUnavailable", payload: { gameId: null } } });
    expect(screen.getByRole("status").textContent).toContain(
      "No game log is kept on this computer yet.",
    );

    applyEvent({
      kind: "Reporting",
      event: { type: "logFailed", payload: { gameId: null, reason: "Access is denied. (os error 5)" } },
    });
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(reportingCommands()).toEqual([
      { kind: "Reporting", command: { type: "attachLog", payload: { gameId: null } } },
    ]);
  });

  it("folds an attached log away in the report history", async () => {
    const user = userEvent.setup();
    mountDialog([
      {
        id: 8,
        createTime: "2026-08-10T18:30:00Z",
        offenders: ["Aurora"],
        gameId: 4242,
        description: WORDS,
        attachedLog: BLOCK,
        moderator: "",
        moderatorNotice: "",
        status: "AWAITING",
      },
    ]);
    await user.click(screen.getByRole("tab", { name: /Previous reports/ }));

    expect(screen.getByText(WORDS)).toBeTruthy();
    expect(screen.queryByText(/GAME LOG EXCERPT/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show the attached game log" }));
    expect(screen.getByText(/warning: Desync detected at beat 4100/).textContent).toBe(BLOCK);
  });
});
