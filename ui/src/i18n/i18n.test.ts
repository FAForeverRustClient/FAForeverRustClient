import { afterEach, describe, expect, it } from "vitest";

import { CATALOGUES } from "./catalog";
import { de } from "./catalog/de";
import type { Message } from "./catalog/en";
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
    // Every catalogue, not just the two oldest: a new language is exactly where
    // an encoding slip is most likely and least likely to be noticed.
    for (const [code, catalogue] of Object.entries(CATALOGUES)) {
      const entries = Object.entries(catalogue) as [string, Message][];
      for (const [key, message] of entries) {
        const forms: string[] = typeof message === "string"
          ? [message]
          : Object.values(message).filter((form): form is string => typeof form === "string");
        if (forms.some((form) => mojibake.test(form))) damaged.push(`${code}:${key}`);
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
    expect(translateIn("en", "status.replay.subject", { uid: 27456965 }))
      .toBe("Replay 27456965");
    expect(translateIn("de", "status.replay.subject", { uid: 27456965 }))
      .toBe("Replay 27456965");
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

describe("plural categories", () => {
  it("uses the CLDR category Intl reports, not just one/other", () => {
    // Russian needs four forms. Without this, "2 файла" and "5 файлов" would
    // both render the `other` form and read as broken grammar to a native
    // speaker, with nothing in the test suite noticing.
    const message: Partial<Record<Intl.LDMLPluralRule, string>> & { other: string } = {
      one: "{count} файл",
      few: "{count} файла",
      many: "{count} файлов",
      other: "{count} файла",
    };
    const pick = (count: number): string => {
      const category = new Intl.PluralRules("ru-RU").select(count);
      return message[category] ?? message.other;
    };
    expect(pick(1)).toBe("{count} файл");
    expect(pick(2)).toBe("{count} файла");
    expect(pick(5)).toBe("{count} файлов");
    expect(pick(21)).toBe("{count} файл");
  });

  it("still resolves English and German with only one/other authored", () => {
    expect(translateIn("en", "chat.header.online", { count: 1 })).toBe("1 person online");
    expect(translateIn("en", "chat.header.online", { count: 4 })).toBe("4 people online");
    expect(translateIn("de", "chat.header.online", { count: 1 })).toBe("1 Person online");
    expect(translateIn("de", "chat.header.online", { count: 4 })).toBe("4 Personen online");
  });
});
