import { afterEach, describe, expect, it } from "vitest";

import { de } from "./catalog/de";
import { en } from "./catalog/en";
import { formatNumber, translateIn } from "./index";
import { isLocale, LOCALE_KEYS } from "./locales";
import { getLocale, resetLocaleForTests, setLocale, subscribeToLocale } from "./store";

afterEach(() => {
  resetLocaleForTests();
});

describe("catalogue integrity", () => {
  it("declares every German key in the English source", () => {
    const unknown = Object.keys(de).filter((key) => !(key in en));
    expect(unknown).toEqual([]);
  });

  it("has no blank English values, which would render as an invisible label", () => {
    const blank = Object.entries(en)
      .filter(([, message]) => (typeof message === "string" ? message.trim() === "" : false))
      .map(([key]) => key);
    expect(blank).toEqual([]);
  });

  it("contains no mojibake, which a tool writing the file in the wrong encoding produces", () => {
    // A UTF-8 string decoded as Latin-1 turns "…" into "â€¦" and "ü" into "Ã¼":
    // a lead byte followed by continuation bytes. Correctly encoded text never
    // matches, because a real "ü" is followed by an ordinary letter.
    const mojibake = /[Â-ô][-¿]/;
    const damaged: string[] = [];
    for (const catalogue of [en, de]) {
      for (const [key, message] of Object.entries(catalogue)) {
        const values = typeof message === "string" ? [message] : [message.one, message.other];
        if (values.some((value) => mojibake.test(value))) damaged.push(key);
      }
    }
    expect(damaged).toEqual([]);
  });

  it("keeps every placeholder in a translation present in the English source", () => {
    const placeholders = (value: string) => (value.match(/\{(\w+)\}/g) ?? []).sort();
    const drift: string[] = [];
    for (const [key, translated] of Object.entries(de)) {
      const source = en[key as keyof typeof en];
      if (typeof source !== "string" || typeof translated !== "string") continue;
      if (placeholders(source).join() !== placeholders(translated).join()) drift.push(key);
    }
    expect(drift).toEqual([]);
  });
});

describe("translateIn", () => {
  it("returns the translation when the catalogue has the key", () => {
    expect(translateIn("de", "nav.tab.maps.label")).toBe("Karten");
  });

  it("falls back to English rather than rendering the key", () => {
    // Deliberately reaches a key German does not translate yet.
    const key = Object.keys(en).find((candidate) => !(candidate in de)) as keyof typeof en | undefined;
    if (key === undefined) return; // Nothing untranslated: the fallback cannot be exercised.
    expect(translateIn("de", key)).toBe(en[key]);
  });

  it("substitutes named placeholders", () => {
    expect(translateIn("en", "status.join.failed", { reason: "already in game" }))
      .toBe("Join failed: already in game");
  });

  it("leaves an unsupplied placeholder visible rather than printing undefined", () => {
    expect(translateIn("en", "status.join.failed")).toBe("Join failed: {reason}");
  });

  it("never group-formats a substituted number, which would corrupt identifiers", () => {
    // Regression guard: replay uids and match ids go through the same path as
    // quantities, and `27,456,965` is both wrong and impossible to search for.
    expect(translateIn("en", "status.replay.downloading", { uid: 27456965 }))
      .toBe("Downloading 27456965");
    expect(translateIn("de", "status.replay.downloading", { uid: 27456965 }))
      .toBe("Lädt 27456965");
  });
});

describe("locale store", () => {
  it("defaults to English", () => {
    expect(getLocale()).toBe("en");
  });

  it("notifies subscribers when the language changes", () => {
    let notifications = 0;
    const unsubscribe = subscribeToLocale(() => { notifications += 1; });
    setLocale("de");
    expect(getLocale()).toBe("de");
    expect(notifications).toBe(1);
    unsubscribe();
  });

  it("ignores a repeated selection so React does not re-render for nothing", () => {
    let notifications = 0;
    const unsubscribe = subscribeToLocale(() => { notifications += 1; });
    setLocale("de");
    setLocale("de");
    expect(notifications).toBe(1);
    unsubscribe();
  });
});

describe("locale helpers", () => {
  it("accepts shipped locales and rejects anything else", () => {
    expect(LOCALE_KEYS).toContain("en");
    expect(isLocale("de")).toBe(true);
    expect(isLocale("klingon")).toBe(false);
    expect(isLocale(null)).toBe(false);
  });

  it("formats numbers in the selected language", () => {
    expect(formatNumber(1234567, "en")).toBe("1,234,567");
    expect(formatNumber(1234567, "de")).toBe("1.234.567");
  });
});
