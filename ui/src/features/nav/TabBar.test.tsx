// Proves the localisation loop end to end for the most visible surface in the
// client: registry key -> catalogue lookup -> rendered markup, and that the
// rendering actually follows the selected language rather than being captured
// once at import time (which is the failure mode a module-level label constant
// would have had).

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { resetLocaleForTests, setLocale } from "../../i18n/store";
import { useAppStore } from "../../store/store";
import { TabBar } from "./TabBar";

const account = useAppStore.getState().state;

afterEach(() => {
  resetLocaleForTests();
  useAppStore.setState({ state: account });
});

/** A session with no account: see `AuthMode::Offline`. */
function goOffline() {
  useAppStore.setState({
    state: { ...account, auth: { ...account.auth, status: "loggedIn", mode: "offline" } },
  });
}

describe("TabBar localisation", () => {
  it("renders English by default, unchanged from before localisation existed", () => {
    const markup = renderToStaticMarkup(<TabBar />);

    expect(markup).toContain("News");
    expect(markup).toContain("Replays");
    expect(markup).toContain("Leaderboard");
    expect(markup).toContain("Settings");
    expect(markup).toContain('aria-label="Main navigation"');
  });

  it("renders German once the language is switched", () => {
    setLocale("de");
    const markup = renderToStaticMarkup(<TabBar />);

    expect(markup).toContain("Neuigkeiten");
    expect(markup).toContain("Rangliste");
    expect(markup).toContain("Einstellungen");
    expect(markup).toContain('aria-label="Hauptnavigation"');
    expect(markup).not.toContain("Leaderboard");
  });

  it("offers an offline session only what it can open, and the way back out", () => {
    goOffline();
    const markup = renderToStaticMarkup(<TabBar />);

    expect(markup).toContain("Replays");
    expect(markup).toContain("Settings");
    expect(markup).toContain("Sign in");
    // Every one of these asks the server something the moment it mounts.
    expect(markup).not.toContain("News");
    expect(markup).not.toContain("Leaderboard");
    expect(markup).not.toContain("Chat");
  });

  it("keeps the sign-in entry out of a session that has an account", () => {
    expect(renderToStaticMarkup(<TabBar />)).not.toContain("Sign in");
  });

  it("never leaks a message key into the markup", () => {
    for (const locale of ["en", "de"] as const) {
      setLocale(locale);
      expect(renderToStaticMarkup(<TabBar />)).not.toContain("nav.tab.");
    }
  });
});
