// Proves the localisation loop end to end for the most visible surface in the
// client: registry key -> catalogue lookup -> rendered markup, and that the
// rendering actually follows the selected language rather than being captured
// once at import time (which is the failure mode a module-level label constant
// would have had).

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { resetLocaleForTests, setLocale } from "../../i18n/store";
import { TabBar } from "./TabBar";

afterEach(() => {
  resetLocaleForTests();
});

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

  // What an offline session renders instead is covered in `tabs.test.ts`:
  // this file renders on the server, where zustand answers every selector from
  // `getInitialState()`, so a session set up with `setState` is invisible here.
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
