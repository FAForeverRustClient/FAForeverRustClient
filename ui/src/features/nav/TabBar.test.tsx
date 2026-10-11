// Proves the localisation loop end to end for the most visible surface in the
// client: registry key -> catalogue lookup -> rendered markup, and that the
// rendering actually follows the selected language rather than being captured
// once at import time (which is the failure mode a module-level label constant
// would have had).

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { resetLocaleForTests, setLocale } from "../../i18n/store";
import { translateIn } from "../../i18n";
import { TabBar, tabBadge } from "./TabBar";

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

describe("tab badges", () => {
  const t = (key: Parameters<typeof translateIn>[1], values?: Parameters<typeof translateIn>[2]) =>
    translateIn("en", key, values);

  it("leaves the chat tab bare when nothing is addressed to the player", () => {
    // `unreadMentions` is zero however busy the channels are: an ordinary line
    // in #aeolus no longer lights the rail (#429).
    expect(tabBadge("chat", 0, "idle", t)).toBeNull();
  });

  it("draws a dot, never a number, for mentions, answers and private messages", () => {
    const badge = tabBadge("chat", 12, "idle", t);
    expect(badge).toMatchObject({ text: "", loud: false });
    expect(badge?.label).toContain("12");
  });

  it("keeps the Play tab's match signals", () => {
    expect(tabBadge("play", 0, "matchFound", t)).toMatchObject({ text: "!", loud: true });
    expect(tabBadge("play", 0, "searching", t)).toMatchObject({ text: "", loud: false });
  });
});
