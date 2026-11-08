// @vitest-environment happy-dom
//
// A failed sign-in, mounted against the store. The reason used to be printed
// as the OAuth flow wrote it ("Token request failed: error sending request
// for url (...)"); it is said plainly now, the original stays on hover, and
// Retry does again what was pressed: signing in, or starting the game offline,
// which reports its failures through the same slice.

import { useAppStore } from "../../store/store";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AuthState, InstallState } from "../../ipc/bindings";
import { en } from "../../i18n/catalog/en";
import { failOnConsoleError } from "../../testing/consoleGuard";
import { applyEvent, clearSentCommands, sentCommands } from "../../testing/mounted";
import { LoginView } from "./LoginView";

vi.mock("../../ipc/client");

failOnConsoleError();

const authState = (event: Partial<AuthState>) => applyEvent({ kind: "Auth", event: { ...useAppStore.getState().state.auth, ...event } });

const authCommands = () => sentCommands().filter((command) => command.kind === "Auth");

describe("a failed sign-in, mounted", () => {
  it("says why plainly, keeps the reason on hover, and signs in again from Retry", async () => {
    const user = userEvent.setup();
    render(<LoginView />);
    await user.click(screen.getByRole("button", { name: en["auth.login"] }));
    const login = authCommands();
    expect(login).toEqual([{ kind: "Auth", command: { type: "login", payload: { remember: true } } }]);

    authState({ status: "loggingIn", error: null, signInLink: null });
    const reason = "Token request failed: error sending request for url (https://hydra.faforever.com/oauth2/token)";
    authState({ status: "failed", player: null, error: reason, signInLink: null });

    const alert = screen.getByRole("alert");
    expect(within(alert).getByText(en["errors.cause.offline"]).getAttribute("title")).toBe(reason);
    expect(alert.textContent).not.toContain("Token request failed");

    clearSentCommands();
    await user.click(within(alert).getByRole("button", { name: en["common.retry"] }));
    expect(authCommands()).toEqual(login);

    authState({ status: "loggingIn", error: null, signInLink: null });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("starts the offline game again from Retry when that is what failed", async () => {
    const user = userEvent.setup();
    render(<LoginView />);
    await user.click(screen.getByRole("button", { name: en["auth.playOffline"] }));
    clearSentCommands();

    // The client's own sentence, which passes through as written.
    authState({ status: "failed", player: null, error: "Forged Alliance is already running.", signInLink: null });
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("Forged Alliance is already running.")).toBeTruthy();

    await user.click(within(alert).getByRole("button", { name: en["common.retry"] }));
    expect(authCommands()).toEqual([{ kind: "Auth", command: { type: "launchOfflineGame" } }]);
  });
});

describe("a sign-in whose browser never appeared", () => {
  const link = "https://hydra.faforever.com/oauth2/auth?client_id=faf-client&state=abc";

  it("offers the link to open by hand, copies it, and drops it when the attempt ends", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<LoginView />);

    authState({ status: "loggingIn", error: null, signInLink: null });
    expect(screen.queryByRole("textbox", { name: en["auth.linkLabel"] })).toBeNull();

    authState({ signInLink: link });
    const field = screen.getByRole<HTMLInputElement>("textbox", { name: en["auth.linkLabel"] });
    expect(field.value).toBe(link);
    expect(field.readOnly).toBe(true);

    await user.click(screen.getByRole("button", { name: en["auth.copyLink"] }));
    expect(writeText).toHaveBeenCalledWith(link);
    expect(screen.getByRole("button", { name: en["auth.linkCopied"] })).toBeTruthy();

    authState({ status: "loggedOut", player: null, mode: "account", error: null, signInLink: null });
    expect(screen.queryByRole("textbox", { name: en["auth.linkLabel"] })).toBeNull();
  });

  it("selects the link for copying by hand when the clipboard is refused", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(() => Promise.reject(new Error("NotAllowedError")));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<LoginView />);

    authState({ status: "loggingIn", error: null, signInLink: null });
    authState({ signInLink: link });
    await user.click(screen.getByRole("button", { name: en["auth.copyLink"] }));
    const field = screen.getByRole<HTMLInputElement>("textbox", { name: en["auth.linkLabel"] });
    expect(document.activeElement).toBe(field);
    expect(screen.getByRole("button", { name: en["auth.copyLink"] })).toBeTruthy();
  });
});

describe("Play offline on a machine FAF has not set the game up on", () => {
  const install = (patch: Partial<InstallState>) =>
    applyEvent({ kind: "Install", event: { ...useAppStore.getState().state.install, ...patch } });

  it("says how to set it up before the click, and still lets the click check again", async () => {
    const user = userEvent.setup();
    render(<LoginView />);
    // Nothing is said before the disk has been looked at.
    expect(screen.queryByText(en["auth.offlineSetupPending"])).toBeNull();

    install({ checked: true, gameReady: false, gamePending: true });
    expect(screen.getByText(en["auth.offlineSetupPending"])).toBeTruthy();
    const play = screen.getByRole<HTMLButtonElement>("button", { name: en["auth.playOffline"] });
    expect(play.disabled).toBe(false);
    await user.click(play);
    expect(authCommands()).toEqual([{ kind: "Auth", command: { type: "launchOfflineGame" } }]);
  });

  it("names the game path when an install was expected there, and goes once it is there", () => {
    render(<LoginView />);
    install({ checked: true, gameReady: false, gamePending: false });
    expect(screen.getByText(en["auth.offlineSetupMissing"])).toBeTruthy();

    install({ checked: true, gameReady: true, gamePending: false });
    expect(screen.queryByText(en["auth.offlineSetupMissing"])).toBeNull();
    expect(screen.queryByText(en["auth.offlineSetupPending"])).toBeNull();
  });
});
