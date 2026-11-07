import type { ReplayAnalysis, ReplayArmy } from "../../../ipc/bindings";

export const EVENT_KINDS = ["upgrade", "factory", "experimental", "lastCommand", "other"] as const;
export type ReplayEventKind = typeof EVENT_KINDS[number];
export interface ReplayTimelineEvent {
  tick: number;
  source: number;
  text: string;
  kind: ReplayEventKind;
  unit?: string;
  enhancement?: string;
}

const ACUS: Readonly<Record<number, string>> = { 1: "UEL0001", 2: "UAL0001", 3: "URL0001", 4: "XSL0001" };
const PREFIXES: Readonly<Record<number, string>> = { 1: "UEB", 2: "UAB", 3: "URB", 4: "XSB" };
const EXPERIMENTALS: Readonly<Record<string, string>> = {
  ahwassa: "XSA0402", atlantis: "UES0401", czar: "UAA0310", fatboy: "UEL0401", galacticcolossus: "UAL0401",
  mavor: "UEB2401", megalith: "XRL0403", monkeylord: "URL0402", novaxsatellitestation: "XEB2402",
  paragon: "XAB1401", salvation: "XAB2307", scathis: "URL0401", soulripper: "URA0401", tempest: "UAS0401",
  yolonaoss: "XSB2401", ythotha: "XSL0401",
};

// Game notification names and enhancement asset identifiers, also used by
// FAF's Python event view. Match names, never arbitrary text as an asset path.
function enhancement(key: string, faction: number): string | undefined {
  const common: Readonly<Record<string, string>> = { t2: "aes", tech2: "aes", t3: "ees", tech3: "ees", ras: "ras", resourceallocation: "ras", teleporter: "pqt" };
  if (common[key]) return `${common[key]}_btn_up`;
  const byFaction: Readonly<Record<number, Readonly<Record<string, string>>>> = {
    1: { billy: "srtn", gundamagerange: "hamc", gun: "hamc", leftdrone: "led", rightdrone: "red", nanorepair: "dsu", shield: "psg", shieldfield: "sgf", tacticalmissile: "tm", tacticalnuke: "srtn" },
    2: { aras: "eras", advancedresourceallocation: "eras", chronodampener: "cd", gunadvancedrange: "ecba", advancedgunrange: "ecba", gunrange: "cba", gunspeed: "hsa", heavyshield: "phtsg", shieldheavy: "phtsg", shield: "ptsg", sensorsuite: "ess", sensors: "ess" },
    3: { cloaking: "cfs", gunspeedrange: "acu", gun: "acu", laser: "mlg", microwavelaser: "mlg", nanorepair: "srs", stealth: "sfs", torpedo: "ntt" },
    4: { aras: "eras", advancedresourceallocation: "eras", advancednanorepair: "adss", advancedregenaura: "anrf", biggun: "cba", gunsplash: "cba", gunspeedrange: "hsa", gun: "hsa", nanorepair: "dss", rapidrestorationfield: "anrf", regenaura: "nrf", restorationfield: "nrf", tacticalmissile: "tml" },
  };
  const icon = byFaction[faction]?.[key];
  return icon ? `${icon}_btn_up` : undefined;
}

export function classifyReplayNotice(text: string, army?: ReplayArmy): Omit<ReplayTimelineEvent, "tick" | "source" | "text"> {
  const key = text.replace(/\s+(?:done!|готов!)(?:.*)$/iu, "").replace(/upgrade/giu, "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const experimental = EXPERIMENTALS[key];
  if (experimental) return { kind: "experimental", unit: experimental };
  const prefix = PREFIXES[army?.faction ?? 0];
  if (prefix) {
    const factory = /^(?:tech|t)([23])(land|air|naval)(?:factory)?hq$/.exec(key);
    if (factory) return { kind: "factory", unit: `${prefix}0${factory[1]}0${{ land: 1, air: 2, naval: 3 }[factory[2]]}` };
    if (/^(?:tech3artilleryconstruction|tech3staticartillery)$/.test(key)) return { kind: "experimental", unit: `${prefix}2302` };
    if (/^(?:nukesiloconstruction|nukelauncher)$/.test(key)) return { kind: "experimental", unit: `${prefix}2305` };
    const icon = enhancement(key, army!.faction);
    if (icon) return { kind: "upgrade", unit: ACUS[army!.faction], enhancement: icon };
  }
  return { kind: "other" };
}

export function replayTimeline(analysis: ReplayAnalysis): ReplayTimelineEvent[] {
  const armies = new Map(analysis.armies.filter((army) => army.source >= 0).map((army) => [army.source, army]));
  const events: ReplayTimelineEvent[] = analysis.notices.map((notice) => ({ ...notice, ...classifyReplayNotice(notice.text, armies.get(notice.source)) }));
  for (const activity of analysis.activity) {
    const army = armies.get(activity.source);
    if (army?.human && activity.lastTick > 0) events.push({ tick: activity.lastTick, source: activity.source, text: "", kind: "lastCommand", unit: ACUS[army.faction] });
  }
  return events.sort((left, right) => left.tick - right.tick || left.source - right.source);
}
