// The login screen is the only place an offline session can be started from,
// so what it offers is worth pinning: a player who cannot sign in has to be
// able to see, from here, that the games on their own disk are still watchable.

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { resetLocaleForTests, setLocale } from "../../i18n/store";
import { LoginView } from "./LoginView";

afterEach(() => {
  resetLocaleForTests();
});

describe("the ways into the client", () => {
  it("offers the archive by name, beside signing in and playing offline", () => {
    const markup = renderToStaticMarkup(<LoginView />);

    expect(markup).toContain("Play offline");
    expect(markup).toContain("Local replays");
  });

  it("names them in the selected language", () => {
    setLocale("de");
    const markup = renderToStaticMarkup(<LoginView />);

    expect(markup).toContain("Offline spielen");
    expect(markup).toContain("Lokale Replays");
  });

  it("never leaks a message key into the markup", () => {
    for (const locale of ["en", "de"] as const) {
      setLocale(locale);
      expect(renderToStaticMarkup(<LoginView />)).not.toContain("auth.");
    }
  });
});
