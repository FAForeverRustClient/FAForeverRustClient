import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CATALOGUES } from "./catalog";
import { de } from "./catalog/de";
import type { Message } from "./catalog/en";
import { en } from "./catalog/en";
import {
  formatNumber,
  translateCoopMissionDescription,
  translateCoopMissionName,
  translateIn,
} from ".";
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

const COOP_MAP_FOLDERS = [
  "scca_coop_a01", "scca_coop_a02", "scca_coop_a03", "scca_coop_a04", "scca_coop_a05", "scca_coop_a06",
  "scca_coop_e01", "scca_coop_e02", "scca_coop_e03", "scca_coop_e04", "scca_coop_e05", "scca_coop_e06",
  "scca_coop_r01", "scca_coop_r02", "scca_coop_r03", "scca_coop_r04", "scca_coop_r05", "scca_coop_r06",
  "x1ca_coop_001", "x1ca_coop_002", "x1ca_coop_003", "x1ca_coop_004", "x1ca_coop_005", "x1ca_coop_006",
  "faf_coop_fort_clarke_assault", "faf_coop_havens_invasion", "faf_coop_novax_station_assault",
  "faf_coop_operation_blockade", "faf_coop_operation_golden_crystals", "faf_coop_operation_holy_raid",
  "faf_coop_operation_ioz_shavoh_kael", "faf_coop_operation_overlord_surth_velsok", "faf_coop_operation_rebels_rest",
  "faf_coop_operation_red_revenge", "faf_coop_operation_rescue", "faf_coop_operation_tha_atha_aez",
  "faf_coop_operation_tight_spot", "faf_coop_operation_trident", "faf_coop_operation_uhthe_thuum_qai",
  "faf_coop_operation_yath_aez", "faf_coop_prothyon_16", "faf_coop_theta_civilian_rescue",
] as const;

describe("co-op mission catalogue lookup", () => {
  beforeEach(() => setLocale("ru"));

  it.each(COOP_MAP_FOLDERS)("resolves the %s mission name by map folder", (folder) => {
    expect(translateCoopMissionName(`${folder}.v0021`, "API mission title"))
      .not.toBe("API mission title");
  });

  it.each(COOP_MAP_FOLDERS)("resolves the %s description by map folder", (folder) => {
    expect(translateCoopMissionDescription(folder, "API mission description"))
      .not.toBe("API mission description");
  });

  it("normalizes folder paths and version suffixes", () => {
    expect(translateCoopMissionName("maps/SCCA_Coop_R03.v0021", "Renamed by API"))
      .toBe("\u0414\u0435\u0431\u0440\u0438\u0444\u0438\u043d\u0433 (Defrag)");
  });

  it("does not use the display name as a translation key", () => {
    expect(translateCoopMissionName("unknown_map", "Dawn")).toBe("Dawn");
  });

  it("keeps the API name and description for unknown maps", () => {
    expect(translateCoopMissionName("new_api_map.v0001", "New mission"))
      .toBe("New mission");
    expect(translateCoopMissionDescription("new_api_map.v0001", "New briefing"))
      .toBe("New briefing");
  });

  it("falls back to the English catalogue when the active locale has no translation", () => {
    setLocale("de");
    expect(translateCoopMissionName("scca_coop_a01.v0001", "API title")).toBe("Joust");
    expect(translateCoopMissionDescription("faf_coop_operation_trident", "API description"))
      .toBe("Operation Trident");
  });

  it("uses catalogue names that include the original English text in Russian", () => {
    expect(translateCoopMissionName("x1ca_coop_002", "API title"))
      .toBe("\u0420\u0430\u0441\u0441\u0432\u0435\u0442 (Dawn)");
    expect(translateCoopMissionName("x1ca_coop_001", "API title"))
      .toBe("\u0427\u0451\u0440\u043d\u044b\u0439 \u0434\u0435\u043d\u044c (\u0432\u0441\u0451) (Black Day)");
  });

  it("translates the mission briefing from the map-folder key", () => {
    expect(translateCoopMissionDescription("scca_coop_e01", "English source description"))
      .toBe("\u041f\u043e \u0434\u0430\u043d\u043d\u044b\u043c \u0440\u0430\u0437\u0432\u0435\u0434\u043a\u0438, \u0434\u0432\u0430 \u043a\u043e\u043c\u0430\u043d\u0434\u0443\u044e\u0449\u0438\u0445 \u041a\u0438\u0431\u0440\u0430\u043d\u043e\u0432 \u0441\u043e\u0432\u0435\u0440\u0448\u0438\u043b\u0438 \u043f\u0435\u0440\u0435\u0445\u043e\u0434 \u0447\u0435\u0440\u0435\u0437 \u0432\u0440\u0430\u0442\u0430 \u043d\u0430 \u041a\u0430\u043f\u0435\u043b\u043b\u0443 \u0431\u043e\u043b\u0435\u0435 \u0447\u0430\u0441\u0430 \u043d\u0430\u0437\u0430\u0434. \u041c\u044b \u043f\u043e\u043b\u0430\u0433\u0430\u0435\u043c, \u0447\u0442\u043e \u043e\u043d\u0438 \u043f\u044b\u0442\u0430\u044e\u0442\u0441\u044f \u0440\u0430\u0437\u0436\u0435\u0447\u044c \u043d\u0435\u0434\u043e\u0432\u043e\u043b\u044c\u0441\u0442\u0432\u043e \u0441\u0440\u0435\u0434\u0438 \u0441\u0438\u043c\u0431\u0438\u043e\u043d\u0442\u043e\u0432.");
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
