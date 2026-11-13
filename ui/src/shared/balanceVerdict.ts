// A stat's direction describes its effect on the unit, not whether a balance
// patch is good for the game. Unknown labels and compound prose stay neutral.
import type { ChangelogChange, UnitStat, UnitValueKey, WeaponStat } from "../ipc/bindings";

export type Verdict = "buff" | "nerf";
type Direction = 1 | -1;

// Shared by blueprint history and the human-written patch notes. Exhaustive
// so a newly tracked blueprint stat needs an explicit decision here.
const DIRECTIONS: Record<UnitStat | WeaponStat, Direction | null> = {
  maxHealth: 1,
  regenRate: 1,
  shieldHealth: 1,
  shieldRegenRate: 1,
  shieldRadius: 1,
  massCost: -1,
  energyCost: -1,
  buildTime: -1,
  buildRate: 1,
  massProduction: 1,
  energyProduction: 1,
  energyUpkeep: -1,
  speed: 1,
  visionRadius: 1,
  waterVisionRadius: 1,
  radarRadius: 1,
  sonarRadius: 1,
  omniRadius: 1,
  dps: 1,
  damage: 1,
  damageRadius: 1,
  range: 1,
  minRange: -1,
  rateOfFire: 1,
  salvoSize: 1,
  // Pulse count and timing can redistribute the same total damage.
  salvoDelay: null,
  dotPulses: null,
  dotTime: null,
};

function verdict(direction: Direction | null, before: number | null, after: number | null): Verdict | null {
  if (direction === null || before === null || after === null
    || !Number.isFinite(before) || !Number.isFinite(after) || before === after) return null;
  return (after > before) === (direction === 1) ? "buff" : "nerf";
}

/** A typed blueprint value. Damage-pulse counts and weapon timing need context. */
export function valueVerdict(key: UnitValueKey, before: number | null, after: number | null): Verdict | null {
  return verdict(DIRECTIONS[key.payload.stat], before, after);
}

// These are input-matching keys, never displayed copy. Match exact aliases
// after case, spacing and punctuation normalization. Do not
// match arbitrary labels containing "damage" (for example, self damage), or
// "time" (fuel endurance and reload time have opposite meanings).
const ALIASES: Partial<Record<UnitStat | WeaponStat, readonly string[]>> = {
  maxHealth: ["health", "hp", "newHealth", "hitPoints", "missileHitpoints", "additionalHealth", "addedAcuHp", "maxHealthMultiplier", "airLandFactoryHqHp", "navalFactoryHqHp", "airLandSupportFactoryHp", "navalSupportFactoryHp", "powerGeneratorMassExtractorHp", "airLandNavalFactoryHp", "powerGeneratorHp", "hydrocarbonPowerPlantHp", "massExtractorHp", "wallSegmentHp"],
  regenRate: ["regen", "regeneration", "regenerationRate", "healthRegeneration", "additionalRegenRate", "minRegen", "navalFactoryHqRegen", "airLandSupportFactoryRegen", "navalFactoryRegen", "powerGeneratorMassExtractorRegen", "airLandFactoryHqRegen", "landFactoryHqRegen", "airFactoryHqRegen", "navalSupportFactoryRegen"],
  shieldHealth: ["shieldMaxHealth", "shieldHp", "personalShield", "personalShieldHealth", "personalShieldHp", "personalShieldMaxHealth"],
  massCost: ["buildCostMass", "rebuildMassCost", "massBuildCost", "repairMassCost", "massCosts"],
  energyCost: ["buildCostEnergy", "powerCost", "rebuildEnergyCost", "teleportFlatEnergyCost", "chargeCost", "powerBuildCost", "repairEnergyCost", "energyCosts", "energyCostToFire"],
  buildTime: ["missileBuildtime", "builtTime"],
  buildRate: ["buildPower"],
  massProduction: ["massGain"],
  energyUpkeep: ["energyMaintenance", "energyConsumption", "energyMaintenanceConsumption", "energyMaintenanceCost", "powerDrain", "powerUpkeepCost", "chargeDrainRate", "energyDrain", "shieldUpkeep", "maintenanceCost"],
  speed: ["maxSpeed", "maxSpeedReverse", "underwaterSpeed", "speedWhileSubmerged", "sniperModeSpeed", "snipeModeSpeed", "submergedSpeed", "speedOnWater", "maxAirspeed", "movementSpeed"],
  radarRadius: ["radarRange"],
  sonarRadius: ["sonarRange"],
  omniRadius: ["omniRange"],
  dps: ["combinedDps", "overchargeDps", "harmonicDepthChargeDps", "dpsWith4T3Pgens"],
  damage: ["additionalDamage", "damagePerVolley", "flakDamage", "bolterDamage", "mainProjectileDamage", "childProjectileDamage", "damagePerShot", "initialDamage", "torpedoDamage", "gatlingGunDamage", "bombDamage", "crashDamage", "deathWeaponDamage", "overchargeDamage", "phasonBeamGeneratorDamage", "gatlingPlasmaCannonDamage", "heavySinnUntheCannonDamage", "oblivionCannonDamage", "gaussCannonDamage"],
  damageRadius: ["aoe", "aaDamageRadius", "areaOfEffect", "aaAoe", "damageRadiusAoe", "crashAoe", "crashDamageRadius", "crashAreaOfEffect", "deathWeaponAoe", "deathWeaponDamageRadius", "deathWeaponAreaOfEffect"],
  range: ["maxRadius", "aaMaxRadius", "flakRange", "bolterRange", "boltersRange", "maximumFiringRange", "harmonicDepthChargeMaxRadius", "maxRange", "aaRange", "eyeWeaponRange", "leftArmRange", "rightArmRange"],
  minRange: ["minimumRange", "minimalRange", "minimumFiringRange", "minRadius"],
  rateOfFire: ["fireRate", "rof", "antiTorpedoRateOfFire", "torpedoDefenseRateOfFire", "harmonicDepthChargeRateOfFire", "oblivionCannonRateOfFire"],
  salvoSize: ["muzzleSalvoSize", "torpedoesPerVolley"],
};

const UNPACKING_TIME_LABELS = ["unpackingAnimation", "unpackingAnimationTime", "unpackingAnimationDuration", "weaponUnpackTimeout"];
const TIME_LABELS = [
  "reload", "reloadTime", "baseReload", "rechargeTime", "shieldRechargeTime",
  "regenStartTime", "shieldRegenStartTime", "teleportDelay", "weaponRepackTimeout",
  "muzzleChargeDelay", "muzzleChargeTime", "stealthWaitTime", "targetCheckInterval",
  "overchargeReloadTime", "antiTorpedoDefenseReloadTime", "antiTorpedoWeaponReloadTime",
  "reloadTimeForAllTorpedoBombers", "buildTimeWithT2Suite", "buildTimeWithT3Suite", ...UNPACKING_TIME_LABELS,
];
const EXTRA_DIRECTIONS: readonly [Direction, readonly string[]][] = [
  [-1, [...TIME_LABELS, "firingRandomness", "firingRandomnessWhileMoving", "firingRandomnessWhenMoving", "gatlingGunFiringRandomness", "fixedSpreadRadius", "veteranMassMult"]],
  // More received damage spilling onto nearby shields weakens protection.
  [-1, ["overspillModifier", "overspillDamageModifier", "damageOverspill"]],
  // General sustained-bombing-DPS rule: smaller attack loops mean more
  // frequent drops (FAF patch 3829). Alignment/reliability can be a tradeoff.
  [-1, ["breakOffDistance", "randomBreakOffDistanceMult"]],
  // FAF's engine/Core/Blueprints/UnitBlueprint.lua defines these as the
  // steering-force limit and maximum braking acceleration, respectively.
  [1, ["maxSteerForce", "maxBrake"]],
  // Collision dimensions are separate from display UniformScale, selection
  // rectangles and collision offsets. Larger target volumes are a nerf.
  [-1, ["sizeX", "sizeY", "sizeZ", "sizeSphere", "hitbox", "hitboxSize", "hitboxRadius", "hitboxWidth", "hitboxHeight", "hitboxDepth", "collisionSizeX", "collisionSizeY", "collisionSizeZ", "collisionRadius"]],
  // Historic notes abbreviate the stealth-field radius to Radar/Sonar
  // Stealth. Boolean enable/disable flags remain neutral in quantity().
  [1, ["radarStealth", "sonarStealth", "radarStealthRadius", "sonarStealthRadius", "radarStealthFieldRadius", "sonarStealthFieldRadius", "radarAndSonarStealthFieldRadius"]],
  [1, ["fuelUseTime", "fuelRechargeRate", "muzzleVelocity", "gatlingGunMuzzleVelocity", "bulletSpeed", "acceleration", "maxAcceleration", "turnRate", "turnSpeed", "combatTurnSpeed", "turretYawSpeed", "turretPitchSpeed", "turretTurnRate", "boltersYawSpeed", "thauCannonYawSpeed", "aimSpeed", "stunDuration", "stunTime", "buildRange", "maxBuildDistance", "turretYawRange", "turretPitchRange", "energyStorage", "massStorage"]],
];

function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const LABEL_DIRECTIONS = new Map<string, Direction | null>();
for (const stat of Object.keys(DIRECTIONS) as (UnitStat | WeaponStat)[]) {
  for (const label of [stat, ...(ALIASES[stat] ?? [])]) LABEL_DIRECTIONS.set(normalizeLabel(label), DIRECTIONS[stat]);
}
for (const [direction, labels] of EXTRA_DIRECTIONS) {
  for (const label of labels) LABEL_DIRECTIONS.set(normalizeLabel(label), direction);
}
const IMPLICIT_SECONDS = new Set([...TIME_LABELS.map(normalizeLabel), "stunduration"]);
const DPS_PRIMARY_LABELS = new Set([
  "damage", ...(ALIASES.damage ?? []), "rateOfFire", ...(ALIASES.rateOfFire ?? []), ...TIME_LABELS,
].map(normalizeLabel));
const FRACTION_LABELS = new Set(["rateOfFire", ...(ALIASES.rateOfFire ?? [])].map(normalizeLabel));
const SALVO_COUNT_LABELS = new Set(["salvoSize", ...(ALIASES.salvoSize ?? [])].map(normalizeLabel));
const ENERGY_COST_LABELS = new Set(["energyCost", ...(ALIASES.energyCost ?? [])].map(normalizeLabel));
const UNPACKING_LABELS = new Set(UNPACKING_TIME_LABELS.map(normalizeLabel));

// Plain numbers, strict thousands groups and, for fire rates only, fractions
// (10/45 -> 10/50). A slash in a reload time or cost can separate alternatives.
// Never use parseFloat on prose: "1000 over 9.5 seconds" is
// more than one quantity, and changing its first number is not the whole change.
const NUMBER = String.raw`[+-]?(?:\d{1,3}(?:\.\d{3}){2,}|(?:\d{1,3}(?:,\d{3})+|\d{1,3}(?: \d{3})+|\d+)(?:\.\d+)?|\.\d+)`;
const QUANTITY = new RegExp(`^(${NUMBER})(?:\\s*/\\s*(${NUMBER}))?\\s*([a-z%°]*(?:/[a-z]+)?)$`, "i");
const DURATION_RANGE = new RegExp(`^(${NUMBER})\\s*[-\\u2013]\\s*(${NUMBER})\\s*([a-z]*)$`, "i");
const UNITS: Record<string, readonly [string, number]> = {
  "": ["", 1], k: ["", 1000], "%": ["%", 1],
  s: ["s", 1], sec: ["s", 1], secs: ["s", 1], second: ["s", 1], seconds: ["s", 1],
  ms: ["s", 0.001], min: ["s", 60], mins: ["s", 60], minute: ["s", 60], minutes: ["s", 60],
  m: ["mass", 1], mass: ["mass", 1], e: ["energy", 1], energy: ["energy", 1], hp: ["hp", 1],
  "e/s": ["energy/s", 1], "energy/s": ["energy/s", 1],
  "hp/s": ["hp/s", 1],
  "deg/s": ["deg/s", 1], "degrees/s": ["deg/s", 1], "°/s": ["deg/s", 1],
};

function quantity(text: string, allowFraction = false): Quantity | null {
  // A trailing percentage is an annotation of this value, not a second stat.
  const plain = text.trim().replace(/[\u00a0\u202f]/g, " ").replace(/\u2212/g, "-")
    .replace(/\s*\([+-]?\d+(?:\.\d+)?%\)$/, "");
  const match = QUANTITY.exec(plain);
  if (!match) return null;
  if (match[2] !== undefined && !allowFraction) return null;
  const unit = UNITS[match[3].toLowerCase()];
  if (!unit) return null;
  const number = (value: string) => Number(/^[+-]?\d{1,3}(?:\.\d{3}){2,}$/.test(value)
    ? value.replace(/\./g, "") : value.replace(/[, ]/g, ""));
  const denominator = match[2] === undefined ? 1 : number(match[2]);
  if (denominator <= 0) return null;
  const value = number(match[1]) / denominator * unit[1];
  return Number.isFinite(value) && value >= 0 ? { value, unit: unit[0] } : null;
}

function statQuantity(text: string, label: string): Quantity | null {
  const scalar = quantity(text, FRACTION_LABELS.has(label));
  if (scalar || !SALVO_COUNT_LABELS.has(label)) return scalar;
  // A volley can list projectiles per launcher, e.g. 5x2 -> 6x2. Compare
  // total projectile counts, without treating arbitrary prose as arithmetic.
  const product = /^(\d+)\s*[x×*]\s*(\d+)$/i.exec(text.trim());
  if (!product) return null;
  const first = Number(product[1]);
  const second = Number(product[2]);
  const total = first * second;
  return [first, second, total].every(Number.isSafeInteger) ? { value: total, unit: "" } : null;
}

/** Only unpacking durations accept numeric intervals. Overlapping intervals
 * stay neutral, rather than guessing a duration from their first number. */
function unpackingTimeVerdict(change: ChangelogChange): Verdict | null {
  const read = (text: string): readonly [number, number] | null => {
    const scalar = quantity(text);
    if (scalar && (scalar.unit === "s" || scalar.unit === "")) return [scalar.value, scalar.value];
    const match = DURATION_RANGE.exec(text.trim().replace(/[\u00a0\u202f]/g, " "));
    if (!match) return null;
    const first = quantity(`${match[1]} ${match[3]}`);
    const last = quantity(`${match[2]} ${match[3]}`);
    if (!first || !last || (first.unit !== "s" && first.unit !== "") || first.value > last.value) return null;
    return [first.value, last.value];
  };
  const before = read(change.old);
  const after = read(change.new);
  if (!before || !after) return null;
  if (after[0] > before[1]) return "nerf";
  if (after[1] < before[0]) return "buff";
  return null;
}

function unanimous(effects: (Verdict | null)[]): Verdict | null {
  const distinct = new Set(effects);
  distinct.delete(null);
  return distinct.size === 1 ? [...distinct][0] : null;
}

/** A charge's total energy and its optional average drain are two costs.
 * Only this known annotation is read; arbitrary parentheses are not discarded.
 * A formerly free charge has zero average drain too. Otherwise a missing
 * average is unknown, and changes in opposite directions stay neutral. */
function chargeCostVerdict(change: ChangelogChange): Verdict | null {
  const read = (text: string) => {
    const annotation = /^(.*?)\s*\(([^()]*)\s+average\)$/i.exec(text.trim());
    const cost = quantity(annotation ? annotation[1] : text);
    if (!cost || (cost.unit !== "energy" && cost.unit !== "")) return null;
    const average = annotation ? quantity(annotation[2]) : null;
    if (annotation && (!average || average.unit !== "energy/s")) return null;
    return { cost: cost.value, average: average?.value ?? (cost.value === 0 ? 0 : null) };
  };
  const before = read(change.old);
  const after = read(change.new);
  if (!before || !after || before.average === null || after.average === null) return null;
  return unanimous([
    verdict(DIRECTIONS.energyCost, before.cost, after.cost),
    verdict(DIRECTIONS.energyUpkeep, before.average, after.average),
  ]);
}

/** A total energy cost with an explicit old/new energy-per-mass ratio.
 * Both costs must agree; a cheaper total with a higher ratio is mixed. */
function energyPerMassVerdict(change: ChangelogChange): Verdict | null {
  const annotation = /^(.+?)\s*\((.+?)\s*(?:-->|->|→)\s*(.+?)\s+energy\s+per\s+mass\)$/i.exec(change.new.trim());
  if (!annotation) return null;
  const before = quantity(change.old);
  const after = quantity(annotation[1]);
  const oldRatio = quantity(annotation[2]);
  const newRatio = quantity(annotation[3]);
  if (!before || !after || before.unit !== after.unit
    || (before.unit !== "" && before.unit !== "energy")
    || !oldRatio || !newRatio || oldRatio.unit !== "" || newRatio.unit !== "") return null;
  return unanimous([
    verdict(-1, before.value, after.value),
    verdict(-1, oldRatio.value, newRatio.value),
  ]);
}

/** Per-shot stun, per-volley stun and uptime describe the same weapon's
 * control. Read all three, so a longer stun with less uptime is not called
 * an unqualified buff. No unit name or release number is needed. */
function stunVerdict(change: ChangelogChange): Verdict | null {
  const read = (text: string) => {
    const match = /^(.+?)\s+per shot\s*\(([^()]+?)\s+per volley\)\s*\(([^()]+?)\s+stun uptime\)$/i.exec(text.trim());
    if (!match) return null;
    const values = match.slice(1).map(value => quantity(value));
    if (values[0]?.unit !== "s" || values[1]?.unit !== "s" || values[2]?.unit !== "%") return null;
    return values.map(value => value!.value);
  };
  const before = read(change.old);
  const after = read(change.new);
  if (!before || !after) return null;
  return unanimous(before.map((value, index) => verdict(1, value, after[index])));
}

/** A spread change may spell out its relative damage-density effect.
 * Keep that explanation on screen, and require it to agree with the radius
 * change instead of ignoring a possible tradeoff in the parentheses. */
function spreadVerdict(change: ChangelogChange): Verdict | null {
  const annotation = /^(.*?)\s*\(approximately\s+([+-]\d+(?:\.\d+)?)%\s+dmg\/area\)$/i.exec(change.new.trim());
  const before = quantity(change.old);
  const after = annotation ? quantity(annotation[1]) : null;
  if (!annotation || !before || !after || before.unit !== after.unit) return null;
  return unanimous([
    verdict(-1, before.value, after.value),
    verdict(1, 0, Number(annotation[2])),
  ]);
}

/** Paired damage/fire-rate/reload and DPS values. Both metrics must agree;
 * a damage increase that lowers DPS is a mixed change, not a simple buff. */
function dpsVerdict(change: ChangelogChange, label: string, direction: Direction, impliedDps: boolean): Verdict | null {
  const split = (text: string) => /^(.+?)\s*\(([^()]+)\)$/.exec(text.trim());
  const beforeParts = split(change.old);
  const afterParts = split(change.new);
  if (!afterParts) return null;
  const before = statQuantity(beforeParts ? beforeParts[1] : change.old, label);
  const after = statQuantity(afterParts[1], label);
  if (!before || !after || !comparable(before, after, label)) return null;
  const dps = (text: string) => {
    const explicit = /^(.+?)\s+DPS(?:\s*[x×]\s*(\d+))?$/i.exec(text.trim());
    const value = explicit ? quantity(explicit[1]) : impliedDps ? quantity(text) : null;
    if (!value || value.unit !== "") return null;
    const total = value.value * (explicit?.[2] ? Number(explicit[2]) : 1);
    return Number.isFinite(total) ? total : null;
  };
  let beforeDps: number | null;
  let afterDps: number | null;
  if (beforeParts) {
    beforeDps = dps(beforeParts[2]);
    afterDps = dps(afterParts[2]);
  } else {
    // A common note prints the old/new DPS together after the new damage:
    // "64 -> 57 (DPS 256 -> 228)". Read that pair without dropping its text.
    const pair = /^DPS\s*:?\s*(.+?)\s*(?:-->|->|→)\s*(.+)$/i.exec(afterParts[2]);
    if (!pair) return null;
    const first = quantity(pair[1]);
    const last = quantity(pair[2]);
    beforeDps = first?.unit === "" ? first.value : null;
    afterDps = last?.unit === "" ? last.value : null;
  }
  if (beforeDps === null || afterDps === null) return null;
  return unanimous([verdict(direction, before.value, after.value), verdict(1, beforeDps, afterDps)]);
}

type Quantity = { value: number; unit: string };

function comparable(before: Quantity, after: Quantity, label: string): boolean {
  if (before.unit === after.unit) return true;
  // BuildTime is build work, so it is deliberately absent from this list.
  const implicitSeconds = IMPLICIT_SECONDS.has(label)
    && [before.unit, after.unit].every(unit => unit === "" || unit === "s");
  // Some notes write a newly introduced drain as "0 E -> 5000 E/s".
  const freeChargeDrain = label === "chargedrainrate" && (before.value === 0 || after.value === 0)
    && [before.unit, after.unit].every(unit => unit === "energy" || unit === "energy/s" || unit === "");
  return implicitSeconds || freeChargeDrain;
}

function booleanValue(text: string): boolean | null {
  const match = /^(?:`(true|false)`|(true|false))$/i.exec(text.trim());
  return match ? (match[1] ?? match[2]).toLowerCase() === "true" : null;
}

/** Interpret presentation only; the published label and values are untouched. */
export function changelogVerdict(change: ChangelogChange): Verdict | null {
  // The target qualifier does not reverse the effect of a stun duration.
  const impliedDps = /\(\s*DPS\s*\)\s*$/i.test(change.label);
  const label = normalizeLabel(change.label.replace(/\(\s*(?:DPS|x\d+)\s*\)\s*$/i, ""))
    .replace(/^stundurationagainst[a-z0-9]+$/, "stunduration")
    .replace(/^(?:uef|cybran|aeon|seraphim|sera)(hp|regen|hpregeneration)$/, (_, stat: string) => stat === "hp" ? "maxhealth" : "regenrate")
    .replace(/^veteranlevel[1-5]regen$/, "regenrate")
    .replace(/^t[1-4]buildtime$/, "buildtime");
  // An independent turret generally tracks targets without needing the unit
  // to turn. This is field-specific; false is not better for arbitrary flags.
  if (label === "turretslavedtobody" || label === "slavedtobody") {
    const before = booleanValue(change.old);
    const after = booleanValue(change.new);
    if (before === null || after === null || before === after) return null;
    return after ? "nerf" : "buff";
  }
  const direction = LABEL_DIRECTIONS.get(label);
  if (direction == null) return null;
  if (label === "chargecost" && /[()]/.test(change.old + change.new)) return chargeCostVerdict(change);
  if (label === "stunduration" && /per shot/i.test(change.old + change.new)) return stunVerdict(change);
  if (label === "fixedspreadradius" && /[()]/.test(change.old + change.new)) return spreadVerdict(change);
  const before = statQuantity(change.old, label);
  const after = statQuantity(change.new, label);
  if (!before || !after) {
    if (ENERGY_COST_LABELS.has(label)) return energyPerMassVerdict(change);
    if (UNPACKING_LABELS.has(label)) return unpackingTimeVerdict(change);
    return DPS_PRIMARY_LABELS.has(label) ? dpsVerdict(change, label, direction, impliedDps) : null;
  }
  if (!comparable(before, after, label)) return null;
  return verdict(direction, before.value, after.value);
}
