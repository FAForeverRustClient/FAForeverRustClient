// @vitest-environment happy-dom
//
// A failed sign-in, mounted against the store. The reason used to be printed
// as the OAuth flow wrote it ("Token request failed: error sending request
// for url (...)"); it is said plainly now, the original stays on hover, and
// Retry does again what was pressed: signing in, or starting the game offline,
// which reports its failures through the same slice.

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AuthEvent } from "../../ipc/bindings";
import { en } from "../../i18n/catalog/en";
import { failOnConsoleError } from "../../testing/consoleGuard";
import { applyEvent, clearSentCommands, sentCommands } from "../../testing/mounted";
import { LoginView } from "./LoginView";

vi.mock("../../ipc/client");

failOnConsoleError();

const authEvent = (event: AuthEvent) => applyEvent({ kind: "Auth", event });

const authCommands = () => sentCommands().filter((command) => command.kind === "Auth");

describe("a failed sign-in, mounted", () => {
  it("says why plainly, keeps the reason on hover, and signs in again from Retry", async () => {
    const user = userEvent.setup();
    render(<LoginView />);
    await user.click(screen.getByRole("button", { name: en["auth.login"] }));
    const login = authCommands();
    expect(login).toEqual([{ kind: "Auth", command: { type: "login", payload: { remember: true } } }]);

    authEvent({ type: "loginStarted" });
    const reason = "Token request failed: error sending request for url (https://hydra.faforever.com/oauth2/token)";
    authEvent({ type: "loginFailed", payload: { message: reason } });

    const alert = screen.getByRole("alert");
    expect(within(alert).getByText(en["errors.cause.offline"]).getAttribute("title")).toBe(reason);
    expect(alert.textContent).not.toContain("Token request failed");

    clearSentCommands();
    await user.click(within(alert).getByRole("button", { name: en["common.retry"] }));
    expect(authCommands()).toEqual(login);

    authEvent({ type: "loginStarted" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("starts the offline game again from Retry when that is what failed", async () => {
    const user = userEvent.setup();
    render(<LoginView />);
    await user.click(screen.getByRole("button", { name: en["auth.playOffline"] }));
    clearSentCommands();

    // The client's own sentence, which passes through as written.
    authEvent({ type: "loginFailed", payload: { message: "Forged Alliance is already running." } });
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("Forged Alliance is already running.")).toBeTruthy();

    await user.click(within(alert).getByRole("button", { name: en["common.retry"] }));
    expect(authCommands()).toEqual([{ kind: "Auth", command: { type: "launchOfflineGame" } }]);
  });
});
