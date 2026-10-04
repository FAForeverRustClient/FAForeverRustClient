import { afterEach, describe, expect, it } from "vitest";

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

describe("translateCoopMissionDescription", () => {
  it.each([
    "Liberation",
    "Artifact",
    "Defrag",
    "Mainframe Tango",
    "Unlock",
    "Freedom",
    "Yath-Aez",
    "Operation Tha-Atha-Aez",
    "Uhthe-Thuum-QAI",
    "Ioz-Shavoh-Kael",
    "Overlord Surth-Velsok",
    "Joust",
    "Machine Purge",
    "High Tide",
    "Entity",
    "Shining Star",
    "Beginnings",
    "Rebel's Rest",
    "Red Revenge",
    "Blockade",
    "Operation Blockade",
    "Holy Raid",
    "Operation Holy Raid",
    "Golden Crystals",
    "Operation Golden Crystals",
    "Fort Clarke Assault",
    "Haven's Invasion",
    "Novax Station Assaault",
    "Novax Station Assault",
    "Prothyon - 16",
    "Prothyon 16",
    "Rescue",
    "Theta Civilian Rescue",
    "Tight Spot",
    "Trident",
    "Operation Trident",
  ])("translates the %s briefing", (englishName) => {
    expect(translateCoopMissionDescription(
      englishName,
      "English source description",
      "ru",
    )).not.toBe("English source description");
  });

  it.each([
    ["Black Earth", "Чёрная Земля"],
    ["Snow Blind", "Снежная слепота"],
    ["Show Blind", "Снежная слепота"],
    ["Metal Shark", "Металлическая акула"],
    ["Vaccine", "Вакцина"],
    ["Forge", "Кузница"],
    ["Stone Wall", "Каменная стена"],
    ["Stone Wall - Remastered", "Каменная стена"],
  ])("translates the %s briefing", (englishName) => {
    expect(translateCoopMissionDescription(
      englishName,
      "English source description",
      "ru",
    )).not.toBe("English source description");
  });

  it("keeps the API description when no translation exists", () => {
    const source = "Intel reports that two Cybran Commanders gated to Capella.";
    expect(translateCoopMissionDescription("Unknown mission", source, "ru"))
      .toBe(source);
  });

  it("uses a translated description when the API description is empty", () => {
    expect(translateCoopMissionDescription("Dawn", "", "ru")).not.toBe("");
  });

  it("resolves a translation by normalized displayed mission name", () => {
    expect(translateCoopMissionDescription(
      "  BLACK DAY (Всё)  ",
      "English source description",
      "ru",
    )).toContain("Форт Кларк");
  });

  it("resolves a translation by the mission's displayed name", () => {
    expect(translateCoopMissionDescription(
      "Black day (Всё)",
      "English source description",
      "ru",
    )).toBe(
      "Форт Кларк, расположенный на планете Грифон IV, является последним рубежом обороны ОФЗ. Силы серафим и Ордена, атакующие форт, превышают по численности силы ОФЗ. Если Форт Кларк падет, ОФЗ перестанет существовать. Вам предстоит уничтожить Командующих противника и остановить осаду Форта Кларк.",
    );
  });

  it("translates the Dawn mission description", () => {
    expect(translateCoopMissionDescription(
      "Dawn",
      "English source description",
      "ru",
    )).toBe(
      "Верные Эон, возглавляемые Крестоносцем Ризой, были захвачены в плен во время проведения диверсионных и разведопераций на территории Ордена и КИИ. Вы должны освободить Верных, находящихся в плену у КИИ, и уничтожить всех командующих противника на планете.",
    );
  });

  it("translates the Red Flag mission description", () => {
    expect(translateCoopMissionDescription(
      "Red Flag",
      "English source description",
      "ru",
    )).toBe(
      "Принцесса Берк вернулась, но она находится в серьезной опасности. Силы серафим загнали ее в ловушку на планете Голубое Небо, у нее нет шансов выбраться оттуда. Вы отправитесь на планету Голубое Небо, уничтожите командующих серафим и спасете Принцессу Берк.",
    );
  });

  it("translates the Meltdown mission description", () => {
    expect(translateCoopMissionDescription(
      "Meltdown",
      "English source description",
      "ru",
    )).toBe(
      "Командование Коалиции получило неподтвержденные разведанные о том, что серафим собирают войска на планете Гадес - контроль над этой планетой позволит серафим атаковать любую точку на территории Коалиции. Элитный командующий Достя присоединится к вам для выполнения этого задания, вы вдвоем должны будете уничтожить силы серафим на Гадесе.",
    );
  });

  it("translates the Mind Games mission description", () => {
    expect(translateCoopMissionDescription(
      "Mind Games",
      "English source description",
      "ru",
    )).toBe(
      "После событий на Гадесе, КИИ должен быть уничтожен раз и навсегда. Благодаря разведанным, полученным от узла Семи Рук, Коалиции удалось узнать, что главный терминал КИИ находится на планете Жемчужина II. Вашим заданием является постройка базы на Жемчужине II, в этом случае доктор Брэкмен сможет высадиться и лично отключить КИИ.",
    );
  });

  it("translates the Overlord mission description", () => {
    expect(translateCoopMissionDescription(
      "Overlord",
      "English source description",
      "ru",
    )).toBe(
      "Благодаря кодам врат, полученных от КИИ, силы Коалиции могут телепортироваться прямо на Землю, где серафим строят Квантовую Арку. Если им удастся завершить ее, серафим смогут вызывать бесчисленные подкрепления. Арка должна быть уничтожена, не важно, какой ценой.",
    );
  });
});

describe("translateCoopMissionName", () => {
  it.each([
    ["Liberation", "Освобождение (Liberation)"],
    ["Artifact", "Артефакт (Artifact)"],
    ["Defrag", "Дебрифинг (Defrag)"],
    ["Mainframe Tango", "Мейнфрейм Танго (Mainframe Tango)"],
    ["Unlock", "Ключ (Unlock)"],
    ["Freedom", "Свобода (Freedom)"],
    ["Yath-Aez", "Йат-Аэз (Yath-Aez)"],
    ["Operation Tha-Atha-Aez", "Операция «Та-Атха-Аэз» (Operation Tha-Atha-Aez)"],
    ["Uhthe-Thuum-QAI", "Ут-Тхум-КИИ (Uhthe-Thuum-QAI)"],
    ["Ioz-Shavoh-Kael", "Иоз-Шавох-Каэль (Ioz-Shavoh-Kael)"],
    ["Overlord Surth-Velsok", "Оверлорд Сурт-Вельсок (Overlord Surth-Velsok)"],
    ["Joust", "Поединок (Joust)"],
    ["Machine Purge", "Механическое искупление (Machine Purge)"],
    ["High Tide", "Прилив (High Tide)"],
    ["Entity", "Сущность (Entity)"],
    ["Shining Star", "Сияющая звезда (Shining Star)"],
    ["Beginnings", "Начало (Beginnings)"],
    ["Rebel's Rest", "Пристанище мятежников (Rebel's Rest)"],
    ["Red Revenge", "Красная месть (Red Revenge)"],
    ["Blockade", "Блокада (Blockade)"],
    ["Operation Blockade", "Операция «Блокада» (Operation Blockade)"],
    ["Fort Clarke Assault", "Штурм Форт-Кларка (Fort Clarke Assault)"],
    ["Haven's Invasion", "Вторжение на Хейвен (Haven's Invasion)"],
    ["Novax Station Assaault", "Штурм станции Новакс (Novax Station Assaault)"],
    ["Novax Station Assault", "Штурм станции Новакс (Novax Station Assault)"],
    ["Prothyon - 16", "Протион-16 (Prothyon - 16)"],
    ["Prothyon 16", "Протион-16 (Prothyon 16)"],
    ["Rescue", "Спасение (Rescue)"],
    ["Theta Civilian Rescue", "Спасение мирных жителей на Тете (Theta Civilian Rescue)"],
    ["Tight Spot", "Трудное положение (Tight Spot)"],
    ["Trident", "Трезубец (Trident)"],
    ["Operation Trident", "Операция «Трезубец» (Operation Trident)"],
    ["Holy Raid", "Священный рейд (Holy Raid)"],
    ["Operation Holy Raid", "Операция «Священный рейд» (Operation Holy Raid)"],
    ["Golden Crystals", "Золотые кристаллы (Golden Crystals)"],
    ["Operation Golden Crystals", "Операция «Золотые кристаллы» (Operation Golden Crystals)"],
  ])("translates the %s mission name", (englishName, expected) => {
    expect(translateCoopMissionName(englishName, "ru")).toBe(expected);
  });

  it.each([
    ["Black Earth", "Чёрная Земля (Black Earth)"],
    ["Snow Blind", "Снежная слепота (Snow Blind)"],
    ["Show Blind", "Снежная слепота (Show Blind)"],
    ["Metal Shark", "Металлическая акула (Metal Shark)"],
    ["Vaccine", "Вакцина (Vaccine)"],
    ["Forge", "Кузница (Forge)"],
    ["Stone Wall", "Каменная стена (Stone Wall)"],
    ["Stone Wall - Remastered", "Каменная стена (Stone Wall - Remastered)"],
  ])("translates the %s mission name", (englishName, expected) => {
    expect(translateCoopMissionName(englishName, "ru")).toBe(expected);
  });

  it("translates the Dawn mission name", () => {
    expect(translateCoopMissionName("Dawn", "ru"))
      .toBe("Рассвет (Dawn)");
  });

  it("translates the Red Flag mission name", () => {
    expect(translateCoopMissionName("Red Flag", "ru"))
      .toBe("Красный флаг (Red Flag)");
  });

  it("translates the Meltdown mission name", () => {
    expect(translateCoopMissionName("Meltdown", "ru"))
      .toBe("Расплав (Meltdown)");
  });

  it("translates the Mind Games mission name", () => {
    expect(translateCoopMissionName("Mind Games", "ru"))
      .toBe("Игры разума (Mind Games)");
  });

  it("translates the Overlord mission name", () => {
    expect(translateCoopMissionName("Overlord", "ru"))
      .toBe("Оверлорд (Overlord)");
  });

  it("translates a co-op mission's displayed name", () => {
    expect(translateCoopMissionName("Black day (Всё)", "ru"))
      .toBe("Чёрный день (всё) (Black day (Всё))");
  });

  it("keeps the API name when no translation exists", () => {
    expect(translateCoopMissionName("Unknown mission", "ru"))
      .toBe("Unknown mission");
  });

  it("uses the locale catalogue to decide whether to show the original name", () => {
    expect(translateCoopMissionName("Dawn", "en")).toBe("Dawn");
    expect(translateCoopMissionName("Dawn", "ru")).toBe("Рассвет (Dawn)");
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
