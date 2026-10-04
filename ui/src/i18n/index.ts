// Message lookup. One entry point for the whole app: `t()` outside React,
// `useTranslation()` inside it.
//
// Three properties matter more than features here:
//
// 1. **A missing translation renders English, never a key.** Users of a partly
//    translated language see a mixed but readable UI, which is strictly better
//    than `settings.general.language.label` on screen.
// 2. **A missing *key* is a compile error.** `MessageKey` is derived from the
//    English catalogue, so `t()` cannot be called with something that does not
//    exist.
// 3. **Formatting follows the language.** Dates and numbers go through the same
//    locale, so a German UI does not print `Aug 10, 2026`.

import { CATALOGUES as CATALOGUE_REGISTRY } from "./catalog";
import { en, type Message, type MessageKey, type PluralMessage } from "./catalog/en";
import { intlTag, type Locale } from "./locales";
import { getLocale } from "./store";

const CATALOGUES: Record<Locale, Partial<Record<MessageKey, Message>>> = CATALOGUE_REGISTRY;

const COOP_MISSION_MESSAGE_KEYS: Record<string, { name: MessageKey; description: MessageKey }> = {
  scca_coop_a01: { name: "lobby.coop.mission.scca_coop_a01.name", description: "lobby.coop.mission.scca_coop_a01.description" },
  scca_coop_a02: { name: "lobby.coop.mission.scca_coop_a02.name", description: "lobby.coop.mission.scca_coop_a02.description" },
  scca_coop_a03: { name: "lobby.coop.mission.scca_coop_a03.name", description: "lobby.coop.mission.scca_coop_a03.description" },
  scca_coop_a04: { name: "lobby.coop.mission.scca_coop_a04.name", description: "lobby.coop.mission.scca_coop_a04.description" },
  scca_coop_a05: { name: "lobby.coop.mission.scca_coop_a05.name", description: "lobby.coop.mission.scca_coop_a05.description" },
  scca_coop_a06: { name: "lobby.coop.mission.scca_coop_a06.name", description: "lobby.coop.mission.scca_coop_a06.description" },
  scca_coop_e01: { name: "lobby.coop.mission.scca_coop_e01.name", description: "lobby.coop.mission.scca_coop_e01.description" },
  scca_coop_e02: { name: "lobby.coop.mission.scca_coop_e02.name", description: "lobby.coop.mission.scca_coop_e02.description" },
  scca_coop_e03: { name: "lobby.coop.mission.scca_coop_e03.name", description: "lobby.coop.mission.scca_coop_e03.description" },
  scca_coop_e04: { name: "lobby.coop.mission.scca_coop_e04.name", description: "lobby.coop.mission.scca_coop_e04.description" },
  scca_coop_e05: { name: "lobby.coop.mission.scca_coop_e05.name", description: "lobby.coop.mission.scca_coop_e05.description" },
  scca_coop_e06: { name: "lobby.coop.mission.scca_coop_e06.name", description: "lobby.coop.mission.scca_coop_e06.description" },
  scca_coop_r01: { name: "lobby.coop.mission.scca_coop_r01.name", description: "lobby.coop.mission.scca_coop_r01.description" },
  scca_coop_r02: { name: "lobby.coop.mission.scca_coop_r02.name", description: "lobby.coop.mission.scca_coop_r02.description" },
  scca_coop_r03: { name: "lobby.coop.mission.scca_coop_r03.name", description: "lobby.coop.mission.scca_coop_r03.description" },
  scca_coop_r04: { name: "lobby.coop.mission.scca_coop_r04.name", description: "lobby.coop.mission.scca_coop_r04.description" },
  scca_coop_r05: { name: "lobby.coop.mission.scca_coop_r05.name", description: "lobby.coop.mission.scca_coop_r05.description" },
  scca_coop_r06: { name: "lobby.coop.mission.scca_coop_r06.name", description: "lobby.coop.mission.scca_coop_r06.description" },
  x1ca_coop_001: { name: "lobby.coop.mission.x1ca_coop_001.name", description: "lobby.coop.mission.x1ca_coop_001.description" },
  x1ca_coop_002: { name: "lobby.coop.mission.x1ca_coop_002.name", description: "lobby.coop.mission.x1ca_coop_002.description" },
  x1ca_coop_003: { name: "lobby.coop.mission.x1ca_coop_003.name", description: "lobby.coop.mission.x1ca_coop_003.description" },
  x1ca_coop_004: { name: "lobby.coop.mission.x1ca_coop_004.name", description: "lobby.coop.mission.x1ca_coop_004.description" },
  x1ca_coop_005: { name: "lobby.coop.mission.x1ca_coop_005.name", description: "lobby.coop.mission.x1ca_coop_005.description" },
  x1ca_coop_006: { name: "lobby.coop.mission.x1ca_coop_006.name", description: "lobby.coop.mission.x1ca_coop_006.description" },
  faf_coop_fort_clarke_assault: { name: "lobby.coop.mission.faf_coop_fort_clarke_assault.name", description: "lobby.coop.mission.faf_coop_fort_clarke_assault.description" },
  faf_coop_havens_invasion: { name: "lobby.coop.mission.faf_coop_havens_invasion.name", description: "lobby.coop.mission.faf_coop_havens_invasion.description" },
  faf_coop_novax_station_assault: { name: "lobby.coop.mission.faf_coop_novax_station_assault.name", description: "lobby.coop.mission.faf_coop_novax_station_assault.description" },
  faf_coop_operation_blockade: { name: "lobby.coop.mission.faf_coop_operation_blockade.name", description: "lobby.coop.mission.faf_coop_operation_blockade.description" },
  faf_coop_operation_golden_crystals: { name: "lobby.coop.mission.faf_coop_operation_golden_crystals.name", description: "lobby.coop.mission.faf_coop_operation_golden_crystals.description" },
  faf_coop_operation_holy_raid: { name: "lobby.coop.mission.faf_coop_operation_holy_raid.name", description: "lobby.coop.mission.faf_coop_operation_holy_raid.description" },
  faf_coop_operation_ioz_shavoh_kael: { name: "lobby.coop.mission.faf_coop_operation_ioz_shavoh_kael.name", description: "lobby.coop.mission.faf_coop_operation_ioz_shavoh_kael.description" },
  faf_coop_operation_overlord_surth_velsok: { name: "lobby.coop.mission.faf_coop_operation_overlord_surth_velsok.name", description: "lobby.coop.mission.faf_coop_operation_overlord_surth_velsok.description" },
  faf_coop_operation_rebels_rest: { name: "lobby.coop.mission.faf_coop_operation_rebels_rest.name", description: "lobby.coop.mission.faf_coop_operation_rebels_rest.description" },
  faf_coop_operation_red_revenge: { name: "lobby.coop.mission.faf_coop_operation_red_revenge.name", description: "lobby.coop.mission.faf_coop_operation_red_revenge.description" },
  faf_coop_operation_rescue: { name: "lobby.coop.mission.faf_coop_operation_rescue.name", description: "lobby.coop.mission.faf_coop_operation_rescue.description" },
  faf_coop_operation_tha_atha_aez: { name: "lobby.coop.mission.faf_coop_operation_tha_atha_aez.name", description: "lobby.coop.mission.faf_coop_operation_tha_atha_aez.description" },
  faf_coop_operation_tight_spot: { name: "lobby.coop.mission.faf_coop_operation_tight_spot.name", description: "lobby.coop.mission.faf_coop_operation_tight_spot.description" },
  faf_coop_operation_trident: { name: "lobby.coop.mission.faf_coop_operation_trident.name", description: "lobby.coop.mission.faf_coop_operation_trident.description" },
  faf_coop_operation_uhthe_thuum_qai: { name: "lobby.coop.mission.faf_coop_operation_uhthe_thuum_qai.name", description: "lobby.coop.mission.faf_coop_operation_uhthe_thuum_qai.description" },
  faf_coop_operation_yath_aez: { name: "lobby.coop.mission.faf_coop_operation_yath_aez.name", description: "lobby.coop.mission.faf_coop_operation_yath_aez.description" },
  faf_coop_prothyon_16: { name: "lobby.coop.mission.faf_coop_prothyon_16.name", description: "lobby.coop.mission.faf_coop_prothyon_16.description" },
  faf_coop_theta_civilian_rescue: { name: "lobby.coop.mission.faf_coop_theta_civilian_rescue.name", description: "lobby.coop.mission.faf_coop_theta_civilian_rescue.description" },
};

/** Values substituted into `{placeholder}` slots. */
export type MessageValues = Record<string, string | number>;

function isPlural(message: Message): message is PluralMessage {
  return typeof message !== "string";
}

/**
 * English wins over nothing, but never over a present translation. Looking the
 * key up in the active catalogue first and falling through to English is what
 * makes a partial catalogue safe to ship.
 */
function resolve(key: MessageKey, locale: Locale): Message {
  return CATALOGUES[locale][key] ?? en[key];
}

function selectPlural(message: PluralMessage, locale: Locale, values?: MessageValues): string {
  const count = typeof values?.count === "number" ? values.count : 0;
  const category = new Intl.PluralRules(intlTag(locale)).select(count);
  // Ask `Intl` which CLDR category applies, then use the authored form for it.
  // Languages differ in which categories they need at all: English and French
  // only ever produce `one` and `other`, while Russian also produces `few` and
  // `many`. Falling back to `other` for an unauthored category keeps a
  // half-written catalogue readable instead of empty.
  return message[category] ?? message.other;
}

/**
 * Placeholders are substituted verbatim, numbers included.
 *
 * Deliberately *not* locale-formatted: most numbers reaching a message are
 * identifiers (match ids, replay uids, ports), and grouping those turns
 * `27456965` into `27,456,965`, which is both wrong and unsearchable. A caller
 * that genuinely wants a grouped quantity formats it with `formatNumber` and
 * passes the resulting string.
 */
function interpolate(template: string, values?: MessageValues): string {
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = values[name];
    return value === undefined ? match : String(value);
  });
}

/** Translate `key` into the currently selected language. */
export function t(key: MessageKey, values?: MessageValues): string {
  return translateIn(getLocale(), key, values);
}

/** Translate into an explicit language. Used by tests and by the language picker. */
export function translateIn(locale: Locale, key: MessageKey, values?: MessageValues): string {
  const message = resolve(key, locale);
  const template = isPlural(message) ? selectPlural(message, locale, values) : message;
  return interpolate(template, values);
}

function coopMissionFolderKey(mapFolderName: string): string {
  const folder = mapFolderName.replace(/\\/g, "/").split("/").pop() ?? "";
  return folder.replace(/\.v\d+$/i, "").toLowerCase();
}

/** Translate a co-op mission description, keeping the API text as fallback. */
export function translateCoopMissionDescription(
  mapFolderName: string,
  source: string,
): string {
  const messages = COOP_MISSION_MESSAGE_KEYS[coopMissionFolderKey(mapFolderName)];
  return messages ? t(messages.description) : source;
}

/** Translate a co-op mission name, keeping the API name as fallback. */
export function translateCoopMissionName(
  mapFolderName: string,
  missionName: string,
): string {
  const messages = COOP_MISSION_MESSAGE_KEYS[coopMissionFolderKey(mapFolderName)];
  return messages ? t(messages.name) : missionName;
}

export function formatNumber(value: number, locale: Locale = getLocale()): string {
  return new Intl.NumberFormat(intlTag(locale)).format(value);
}

/**
 * A number with exactly one decimal place, in the reader's own notation.
 *
 * Review scores are the reason this exists: "4.7" is a typo in German, where
 * the decimal separator is a comma and a full stop groups thousands.
 */
export function formatDecimal(value: number, locale: Locale = getLocale()): string {
  return new Intl.NumberFormat(intlTag(locale), {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value);
}

export { DEFAULT_LOCALE, intlTag, isLocale, LOCALE_KEYS, LOCALES } from "./locales";
export type { Locale, LocaleDefinition } from "./locales";
export type { MessageKey } from "./catalog/en";
export { getLocale, setLocale, subscribeToLocale } from "./store";
