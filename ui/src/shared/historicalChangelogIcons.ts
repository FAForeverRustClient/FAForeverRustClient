import type { ChangelogBlock, ChangelogSpan } from "../ipc/bindings";
import { FACTION_DISPLAY_ORDER } from "./factions";

export type ChangelogIllustration =
  | { type: "unit"; iconUrl: string; unitId?: string }
  | { type: "category"; iconUrl: string }
  | { type: "faction"; faction: number };

export interface HistoricalCaptionIllustration {
  text: string;
  icons: readonly ChangelogIllustration[];
  /** A caption written as a paragraph can still start a sibling section. */
  headingLevel?: number;
  /** Some old posts style the contributor names as a section heading. */
  asParagraph?: boolean;
}

export type HistoricalCaptionIllustrations = ReadonlyMap<number, HistoricalCaptionIllustration>;

const EARLY_PATCHES = new Set([
  "legacy-3605", "legacy-3606", "3608", "3609", "3610", "3612", "3613", "3614", "3615", "3616",
  "3617", "3618", "3619", "3620", "3621", "3622", "3623", "3624", "3625", "3626", "3628", "3629",
  "3630", "3631", "3632", "3633", "3634", "3635",
]);
const EMPTY: HistoricalCaptionIllustrations = new Map();
const UNIT_BASE = "https://faforever.github.io/fa/assets/icons";
const ENHANCEMENT_BASE = "https://raw.githubusercontent.com/FAForever/patchnotes/0d01e845da4d72173492751d153771ee17a0f079/images/Enhancements";
const FACTIONS: Readonly<Record<string, number>> = { uef: 1, aeon: 2, cybran: 3, seraphim: 4, sera: 4 };
const FOLDERS: Readonly<Record<number, string>> = { 1: "uef", 2: "aeon", 3: "cybran", 4: "sera" };
const COMMANDERS = {
  acu: { 1: "UEL0001", 2: "UAL0001", 3: "URL0001", 4: "XSL0001" },
  scu: { 1: "UEL0301", 2: "UAL0301", 3: "URL0301", 4: "XSL0301" },
} as const;
const T3_ARTILLERY: Readonly<Record<string, string>> = {
  uef: "UEB2302", aeon: "UAB2302", cybran: "URB2302", seraphim: "XSB2302",
};
const CREDIT_LABELS = new Set(["credits", "contributors", "acknowledgements", "balanceteamcredits", "developmentteamcredits"]);

// Identities checked against LOC/US/strings_db.lua in FAF/fa's 3636 tag.
// Match complete original captions, including their historical spellings;
// a mention of a unit inside an arbitrary sentence does not become a header.
const NAMED_UNITS: Readonly<Record<string, string>> = {
  soulreaper: "URA0401", soulripper: "URA0401", novax: "XEB2402", satellitestation: "XEB2402",
  t3subhunter: "XSS0304", seraphimt3submarine: "XSS0304", tempest: "UAS0401",
  torrentmissileship: "XAS0306", sparky: "XEL0209", medusat1cybranmobileartillery: "URL0103",
  cybranfirebeetle: "XRL0302", scathis: "URL0401", soulripperveterancy: "URA0401",
  monkeylord: "URL0402", atlantis: "UES0401", monkeylordveterancy: "URL0402", ythotaveterancy: "XSL0401", galacticcolossusveterancy: "UAL0401",
  uefbattlecruiser: "XES0307", cybrant3battleship: "URS0302", serat1arty: "XSL0103",
};

const compact = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const factionCaption = (text: string) => /^(uef|aeon|cybran|seraphim|sera)(?:t[1-4]|tech[1-4])?$/.test(compact(text));
const unit = (unitId: string): ChangelogIllustration => ({ type: "unit", unitId, iconUrl: `${UNIT_BASE}/${unitId}_icon.png` });

function categoryIcon(text: string): ChangelogIllustration | undefined {
  const key = compact(text);
  // FAF's construction icons use land/air/sea backgrounds. Structures share
  // the land background; this is category artwork, not a unit blueprint.
  const category = /^(?:structures(?:andweapons)?|land(?:units)?|t[1-4]land)$/.test(key) ? "land"
    : /^(?:air(?:units)?|t[1-4]air)$/.test(key) ? "air"
    : /^(?:sea|navy|naval(?:changes)?|t[1-4](?:sea|navy|naval))$/.test(key) ? "sea" : undefined;
  return category ? { type: "category", iconUrl: `/assets/changelog/categories/${category}.png` } : undefined;
}

function creditNames(text: string): boolean {
  const names = text.trim().split(/\s*,\s*/);
  return names.length > 1 && names.every(name => /^[\p{L}\p{N}_][\p{L}\p{N}_ .'-]{0,79}$/u.test(name));
}

function commander(text: string): { kind: keyof typeof COMMANDERS; faction?: number } | undefined {
  const key = compact(text);
  const match = /^(uef|aeon|cybran|seraphim|sera)?(acus?|sacus?|scus?|scurebalance)$/.exec(key);
  if (!match) return undefined;
  return { kind: match[2].startsWith("acu") ? "acu" : "scu", faction: FACTIONS[match[1]] };
}

function commanderIcons(kind: keyof typeof COMMANDERS, faction?: number): ChangelogIllustration[] {
  const ids: Readonly<Record<number, string>> = COMMANDERS[kind];
  return (faction ? [faction] : FACTION_DISPLAY_ORDER).map(id => unit(ids[id]));
}

function plainCaption(spans: ChangelogSpan[]): string | undefined {
  if (!spans.length || !spans.every(span => span.type === "text" || span.type === "strong")) return undefined;
  const text = spans.map(span => span.payload).join("");
  return text.length <= 120 ? text : undefined;
}

function upgrade(key: string, faction: number): ChangelogIllustration | undefined {
  // Use the later archive's faction-specific glyphs for clearly named upgrade
  // families, rather than claiming to reconstruct their 2012 artwork. Its
  // revision is pinned by historical_changelog.json; filenames, including
  // typos, were checked there. Do not invent a URL from arbitrary author text:
  // SCU enhancement portraits are not all present in the modern icon set.
  const files: Readonly<Record<string, Partial<Record<number, string>>>> = {
    ressourceallocationsystem: { 1: "ras.png", 2: "ras.png" },
    resourceallocationsystem: { 1: "ras.png", 2: "ras.png" },
    sacrifice: { 2: "sacrifce.png" },
    shield: { 1: "personalsheild.png", 2: "shield.png", 4: "shield.png" },
    heavyshield: { 2: "heavyshield.png" },
    shieldgeneratorfield: { 1: "bubbleshield.png" },
    personalcloak: { 3: "cloack.png" },
    personalstealth: { 3: "stealth.png" },
    selfrepairsystem: { 3: "nano.png" },
    systemintegritycompensatornanorepairequivalent: { 2: "nano.png" },
    damagestabilizationnanorepairequivalent: { 4: "nano.png" },
    uefscuengineeringdrone: { 1: "drone.png" },
    teleporter: { 1: "teleport.png", 2: "telly.png", 4: "teleport.png" },
    overcharge: { 4: "oc.png" },
    missile: { 4: "scu tml.png" },
  };
  const file = files[key]?.[faction];
  return file ? { type: "unit", iconUrl: `${ENHANCEMENT_BASE}/${FOLDERS[faction]}/${encodeURIComponent(file)}` } : undefined;
}

function iconsFor(text: string, parents: string[]): ChangelogIllustration[] {
  const key = compact(text);
  const ownCommander = commander(text);
  if (ownCommander) return commanderIcons(ownCommander.kind, ownCommander.faction);
  const parentCommander = parents.map(commander).reverse().find(parent => parent !== undefined);
  const faction = /^(uef|aeon|cybran|seraphim|sera)(?:t[1-4]|tech[1-4])?$/.exec(key);
  if (faction) {
    const id = FACTIONS[faction[1]];
    // "Cybran" under "ACUs" names a commander. "Cybran T2" is a whole
    // group and keeps its faction emblem, rather than an arbitrary portrait.
    return FACTIONS[key] && parentCommander
      ? commanderIcons(parentCommander.kind, id)
      : [{ type: "faction", faction: id }];
  }
  const named = Object.prototype.hasOwnProperty.call(NAMED_UNITS, key) ? NAMED_UNITS[key] : undefined;
  if (named) return [unit(named)];
  const artillery = /^(uef|aeon|cybran|seraphim)arty$/.exec(key);
  if (artillery && parents.some(parent => compact(parent) === "t3stationnaryarty")) {
    return [unit(T3_ARTILLERY[artillery[1]])];
  }
  const enhancement = parentCommander?.faction && parentCommander.kind === "scu"
    ? upgrade(key, parentCommander.faction) : undefined;
  return enhancement ? [enhancement] : [];
}

/** Presentation metadata only: original text, blocks, levels and anchors stay intact. */
export function historicalChangelogIllustrations(
  releaseId: string, blocks: ChangelogBlock[],
): HistoricalCaptionIllustrations {
  if (!EARLY_PATCHES.has(releaseId)) return EMPTY;
  const illustrations = new Map<number, HistoricalCaptionIllustration>();
  const parents: Array<{ level: number; text: string; unitTopic?: boolean }> = [];
  blocks.forEach((block, index) => {
    const text = block.type === "heading" ? block.payload.text
      : block.type === "paragraph" ? plainCaption(block.payload.spans) : undefined;
    if (text === undefined) return;
    // 3626 uses a second <h1> for the comma-separated contributor names.
    // Those names are credit prose, not a large section or a contents entry.
    // Require the credits context so real headings elsewhere stay headings.
    if (block.type === "heading" && parents.some(parent => CREDIT_LABELS.has(compact(parent.text))) && creditNames(text)) {
      illustrations.set(index, { text, icons: [], asParagraph: true });
      return;
    }
    // 3626 writes UEF as <p> after three <h3> ACU faction labels. It is a
    // sibling, not another unit or upgrade under Aeon. The same mixed markup
    // occurs in 3615's XP section. Keep their source block/anchor and supply
    // one effective heading level to both the body and contents navigation.
    const factionGroup = block.type === "paragraph" && Object.prototype.hasOwnProperty.call(FACTIONS, compact(text))
      ? [...parents].reverse().find(parent => !factionCaption(parent.text) && !commander(parent.text)?.faction)
      : undefined;
    // A named unit after a "General change" subsection starts its own topic.
    // In 3626, Atlantis and Monkeylord change speed/weapons after the shared
    // veterancy list; neither belongs inside that veterancy subsection.
    const lastParent = parents[parents.length - 1];
    const unitAfterGeneral = block.type === "paragraph" && Object.prototype.hasOwnProperty.call(NAMED_UNITS, compact(text))
      && lastParent && (compact(lastParent.text).startsWith("generalchange") || lastParent.unitTopic);
    const headingLevel = factionGroup ? Math.min(6, factionGroup.level + 1)
      : unitAfterGeneral ? lastParent.level : undefined;
    if (block.type === "heading") {
      while (parents.length && parents[parents.length - 1].level >= block.payload.level) parents.pop();
    } else if (headingLevel !== undefined) {
      while (parents.length && parents[parents.length - 1].level >= headingLevel) parents.pop();
    }
    const category = block.type === "heading" ? categoryIcon(text) : undefined;
    const icons = category ? [category] : iconsFor(text, parents.map(parent => parent.text));
    if (icons.length) illustrations.set(index, { text, icons, ...(headingLevel !== undefined ? { headingLevel } : {}) });
    if (block.type === "heading") parents.push({ level: block.payload.level, text });
    else if (headingLevel !== undefined) parents.push({ level: headingLevel, text, unitTopic: Boolean(unitAfterGeneral) });
  });
  return illustrations;
}

/**
 * The early-note rules for the note on screen, only when it is the one bundled
 * with the client: the note that ends in the client's own attribution. The
 * backend prefers a published note over a bundled one with the same number,
 * and that published note is drawn as published.
 */
export function bundledNoteIllustrations(
  entry: { id: string; blocks: ChangelogBlock[] } | undefined,
): HistoricalCaptionIllustrations {
  if (!entry?.blocks.some(block => block.type === "provenance")) return EMPTY;
  return historicalChangelogIllustrations(entry.id, entry.blocks);
}
