import { describe, expect, it } from "vitest";
import { changelogVerdict, valueVerdict } from "./balanceVerdict";

describe("patch-note balance colors", () => {
  it.each([
    ["Turret SlavedToBody", "True", "False", "buff"],
    ["Turret SlavedToBody", "False", "True", "nerf"],
    ["SlavedToBody", "`true`", "`false`", "buff"],
    ["turret slaved to body", " true ", " FALSE ", "buff"],
    ["Turret SlavedToBody", "True", "True", null],
    ["Turret SlavedToBody", "False", "False", null],
    ["Turret SlavedToBody", "yes", "no", null],
    ["Turret SlavedToBody", "1", "0", null],
    ["Turret SlavedToBody", "True (all)", "False", null],
    ["PrefersPrimaryWeaponTarget", "True", "False", null],
  ] as const)("interprets turret independence only for its own boolean field: %s %s -> %s", (label, old, next, expected) => {
    expect(changelogVerdict({ label, old, new: next })).toBe(expected);
  });

  // Published values from 3837, 3818, 3718 and the older balance notes.
  it.each([
    ["Mass cost", "230", "270", "nerf"],
    ["Energy cost", "4600", "8850", "nerf"],
    ["Build time", "1200", "1600", "nerf"],
    ["HP", "90", "10", "nerf"],
    ["Damage radius", "7.5", "3.5", "nerf"],
    ["DPS", "338", "300", "nerf"],
    ["Underwater speed", "5", "4.5", "nerf"],
    ["Regen start time", "1", "3 seconds", "nerf"],
    ["Energy maintenance", "35", "45", "nerf"],
    ["Firing Randomness", "2", "2.25", "nerf"],
    ["Health", "4600", "3050", "nerf"],
    ["Rate of Fire", "1.25", "1", "nerf"],
    ["Range", "28", "26", "nerf"],
    ["Reload", "10s", "12s", "nerf"],
    ["Mass cost", "45000", "42750", "buff"],
    ["Shield Recharge Time", "63", "40", "buff"],
    ["ShieldRegenStartTime", "3", "2", "buff"],
    ["Shield Regen Rate", "9", "30", "buff"],
    ["FiringRandomnessWhileMoving", "0.3", "0.1", "buff"],
    ["Minimum Range", "8", "4", "buff"],
    ["VisionRadius", "70", "100", "buff"],
    ["FuelUseTime", "400", "600", "buff"],
    ["FuelRechargeRate", "5", "10", "buff"],
  ] as const)("classifies %s: %s -> %s as %s", (label, old, next, expected) => {
    expect(changelogVerdict({ label, old, new: next })).toBe(expected);
  });

  it.each(["mass cost", "BuildCostMass", "Build Cost Mass", "**MASS COST**", "`MassCost`", "Rebuild mass cost"])(
    "recognizes the historical cost spelling %s in both directions", label => {
      expect(changelogVerdict({ label, old: "100", new: "120" })).toBe("nerf");
      expect(changelogVerdict({ label, old: "120", new: "100" })).toBe("buff");
    },
  );

  it.each([
    ["Mass Cost", "24,000", "25,000 (+4.2%)", "nerf"],
    ["Power Cost", "343 750", "330 000", "buff"],
    ["Build Time", "38\u202f400", "40\u00a0000 (+4.2%)", "nerf"],
    ["Mass Cost", "24k", "25k", "nerf"],
    ["RateOfFire", "10/45", "10/50", "nerf"],
    ["Damage", ".5", "0.7", "buff"],
    ["Recharge time", "1 second", "2000ms", "nerf"],
    ["Reload time", "60s", "1 minute", null],
    ["Mass Cost", "+100", "+120", "nerf"],
    ["Firing Randomness", "20%", "10%", "buff"],
  ] as const)("reads comparable quantities for %s: %s -> %s", (label, old, next, expected) => {
    expect(changelogVerdict({ label, old, new: next })).toBe(expected);
  });

  it.each([
    ["Unknown statistic", "100", "200"],
    ["Self damage", "100", "200"],
    ["UniformScale", "1", "2"],
    ["Transport class", "1", "2"],
    ["MuzzleSalvoDelay", "1", "2"],
    ["Duration", "1", "2"],
    ["Description", "Anti-Air Defense", "Anti-Air Turret"],
    ["Damage", "1000 over 9.5 seconds", "2100 over 4 seconds"],
    ["Firing Randomness while moving", "0.4 / 0.3 / 0.2", "0.18 / 0.1 / 0.05"],
    ["Rebuild time", "10 seconds", "200 buildtime"],
    ["BuildTime", "10 seconds", "200"],
    ["Mass cost", "100 mass", "200 energy"],
    ["Mass cost", "100", "50%"],
    ["Mass cost", "1,5", "2,5"],
    ["Mass cost", "12 00", "1 300"],
    ["Energy consumption", "-400", "-250"],
    ["Energy consumption", "\u2212400", "\u2212250"],
    ["Health", "X", "200"],
    ["Health", "", "200"],
    ["Health", "100", "100"],
    ["RateOfFire", "1/0", "1"],
    ["Damage", "NaN", "Infinity"],
    ["Reload time", "4/2.5 seconds", "1.9 seconds"],
    ["Mass cost", "100/50", "75"],
    ["Overspill modifier", "0.15", "0.15"],
    ["Overspill modifier", "0.15", "30%"],
    ["Firing randomness", "0.4/0.3", "0.18/0.1"],
  ])("leaves ambiguous %s: %s -> %s neutral", (label, old, next) => {
    expect(changelogVerdict({ label, old, new: next })).toBeNull();
  });

  it("does not change the published strings", () => {
    const change = Object.freeze({ label: "Mass Cost", old: "24 000", new: "25 000 (+4.2%)" });
    expect(changelogVerdict(change)).toBe("nerf");
    expect(change).toEqual({ label: "Mass Cost", old: "24 000", new: "25 000 (+4.2%)" });
  });

  it.each([
    ["Energy cost", "6000", "12000 (20 -> 30 energy per mass)", "nerf"],
    ["Energy cost", "12000", "6000 (30 → 20 energy per mass)", "buff"],
    ["BuildCostEnergy", "6000 E", "12000 E (20 -> 30 energy per mass)", "nerf"],
    ["Energy cost", "6000", "12000 (20 -> 10 energy per mass)", null],
    ["Energy cost", "12000", "6000 (20 -> 30 energy per mass)", null],
    ["Energy cost", "6000", "12000 (20 -> 20 energy per mass)", "nerf"],
    ["Energy cost", "X", "12000 (20 -> 30 energy per mass)", null],
    ["Energy cost", "6000", "12000 (20 -> unknown energy per mass)", null],
    ["Energy cost", "6000 mass", "12000 mass (20 -> 30 energy per mass)", null],
    ["Energy cost", "6000", "12000 (20 -> 30 HP per mass)", null],
    ["Energy cost", "6000", "12000 (20 -> 30 energy per mass; range 20 -> 30)", null],
    ["Mass cost", "6000", "12000 (20 -> 30 energy per mass)", null],
  ] as const)("reads energy-per-mass annotations for %s: %s -> %s", (label, old, next, expected) => {
    expect(changelogVerdict({ label, old, new: next })).toBe(expected);
  });

  it.each([
    ["Charge cost", "0 E", "72000 E (3750 E/s average)", "nerf"],
    ["Charge cost", "72000 E (3750 E/s average)", "0 E", "buff"],
    ["Charge cost", "1000 E", "2000 E", "nerf"],
    ["Charge cost", "1000 E (100 E/s average)", "2000 E (200 E/s average)", "nerf"],
    ["Charge cost", "1000 E (100 E/s average)", "2000 E (50 E/s average)", null],
    ["Charge cost", "1000 E", "2000 E (200 E/s average)", null],
    ["Charge cost", "0 E", "72000 E (additional damage: 100)", null],
    ["Charge cost", "0 E", "72000 E (3750 HP/s average)", null],
    ["Charge drain rate", "0 E", "5000 E/s", "nerf"],
    ["Charge drain rate", "5000 E/s", "0 E", "buff"],
    ["Charge drain rate", "5000 E/s", "4000 E/s", "buff"],
    ["Charge drain rate", "1000 E", "5000 E/s", null],
  ] as const)("interprets %s: %s -> %s without dropping mixed tradeoffs", (label, old, next, expected) => {
    expect(changelogVerdict({ label, old, new: next })).toBe(expected);
  });

  it.each([
    ["Aim Speed", "360 deg/s", "8 deg/s", "nerf"],
    ["AimSpeed", "8 °/s", "360 degrees/s", "buff"],
    ["Aim Speed", "360 deg/s", "8 s", null],
    ["Stun Duration", "2s", "1s", "nerf"],
    ["Stun Duration against T1/T2 mobile units", "1.5s per shot (2.3s per volley) (70% stun uptime)", "0.4s per shot (1.2s per volley) (36% stun uptime)", "nerf"],
    ["Stun Duration against T3 mobile units", "0.4s per shot (1.2s per volley) (36% stun uptime)", "1.5s per shot (2.3s per volley) (70% stun uptime)", "buff"],
    ["Stun Duration", "1s per shot (2s per volley) (70% stun uptime)", "2s per shot (3s per volley) (36% stun uptime)", null],
    ["Stun Duration", "1s per shot (2s per volley) (70% stun uptime)", "2s per shot (unknown per volley) (90% stun uptime)", null],
    ["Fixed spread radius", "70", "63 (approximately +23% dmg/area)", "buff"],
    ["Fixed spread radius", "63", "70 (approximately -19% dmg/area)", "nerf"],
    ["Fixed spread radius", "70", "80 (approximately +23% dmg/area)", null],
    ["Fixed spread radius", "70", "63 (plus another weapon change)", null],
  ] as const)("reads known weapon measurements for %s: %s -> %s", (label, old, next, expected) => {
    expect(changelogVerdict({ label, old, new: next })).toBe(expected);
  });

  it.each([
    ["BuildPower", "1080", "1500", "buff"],
    ["Energy drain", "100", "250", "nerf"],
    ["Missile hitpoints", "3 hp", "2 hp", "nerf"],
    ["Power Build Cost", "4800", "6000", "nerf"],
    ["Mass costs", "2", "3", "nerf"],
    ["Fire Rate", "0.53", "0.05", "nerf"],
    ["Minimal range", "5", "15", "nerf"],
    ["VeteranMassMult", "0.5", "0.75", "nerf"],
    ["Overspill modifier", "0.15", "0.3", "nerf"],
    ["Overspill modifier", "0.3", "0.15", "buff"],
    ["Overspill Damage Modifier", "0.25", "0.35", "nerf"],
    ["Damage Overspill", "15%", "25%", "nerf"],
    ["Damage Overspill", "25%", "15%", "buff"],
    ["Target Check Interval", "1.0s", "0.4s", "buff"],
    ["Turret turn rate", "180°/s", "70°/s", "nerf"],
    ["TurretYawRange", "30", "360", "buff"],
    ["TurretPitchRange", "45", "60", "buff"],
    ["TurretPitchRange", "70", "60", "nerf"],
    ["Build range", "5", "7", "buff"],
    ["Additional Regen Rate", "60 HP/s", "50 HP/s", "nerf"],
    ["Build time with T2 suite", "10.8", "16.7 seconds", "nerf"],
    ["Damage (x2)", "19.2", "20", "buff"],
    ["Energy Cost", "1.350.000", "1.500.000", "nerf"],
    ["DPS with 4 T3 pgens", "917", "980 (+6.9%)", "buff"],
    ["Harmonic Depth Charge DPS", "420", "350", "nerf"],
    ["Veteran level 5 regen", "50", "235", "buff"],
    ["Cybran HP Regeneration", "15", "30", "buff"],
    ["Air/Land Factory HQ HP", "6200", "7000", "buff"],
    ["T3 Build Time", "12100", "12000", "buff"],
    ["MaxSteerForce", "4.6", "4.8", "buff"],
    ["MaxSteerForce", "5", "4.6", "nerf"],
    ["MaxBrake", "2.85", "3.55", "buff"],
    ["MaxBrake", "6", "5.5", "nerf"],
    ["Sonar Stealth", "90", "70", "nerf"],
    ["Radar Stealth", "45", "70", "buff"],
    ["RadarStealthFieldRadius", "70", "45", "nerf"],
    ["SonarStealthFieldRadius", "70", "90", "buff"],
    ["Radar and sonar stealth field radius", "24", "20", "nerf"],
    ["Hitbox", "0.4", "1", "nerf"],
    ["SizeX", "0.8", "0.95", "nerf"],
    ["SizeY", "0.45", "0.65", "nerf"],
    ["SizeZ", "2.0", "2.3", "nerf"],
    ["Collision Size Z", "2.3", "2.0", "buff"],
    ["SizeSphere", "2", "1", "buff"],
    ["Hitbox radius", "1", "0.8", "buff"],
    ["`BreakOffDistance`", "60", "50", "buff"],
    ["BreakOffDistance", "50", "60", "nerf"],
    ["RandomBreakOffDistanceMult", "1.5", "1", "buff"],
    ["RandomBreakOffDistanceMult", "1", "1.5", "nerf"],
  ] as const)("recognizes published stat variants for %s: %s -> %s", (label, old, next, expected) => {
    expect(changelogVerdict({ label, old, new: next })).toBe(expected);
  });

  it.each([
    ["Damage (DPS)", "14 (60)", "15 (64.29)", "buff"],
    ["Gauss cannon damage (DPS)", "275 (275)", "305 (305)", "buff"],
    ["Damage (DPS)", "125 (312.5)", "118 (295)", "nerf"],
    ["Damage", "500 (250 DPS)", "300 (150 DPS)", "nerf"],
    ["Damage", "600", "560 (DPS: 150 -> 140)", "nerf"],
    ["Damage", "64", "57 (DPS 256 -> 228)", "nerf"],
    ["Reload time", "4.0", "3.4 seconds (DPS 156 -> 184)", "buff"],
    ["Reload time", "5.9s (169.5 DPS x3)", "6.0s (166.7 DPS x3)", "nerf"],
    ["RateOfFire (DPS)", "10/33 (97)", "10/32 (100)", "buff"],
    ["Damage (DPS)", "100 (200)", "120 (150)", null],
    ["Reload time", "4s", "3s (DPS 200 -> 100)", null],
    ["Damage", "100 (unknown DPS)", "120 (200 DPS)", null],
    ["Damage", "100 (20 E/s average)", "120 (40 E/s average)", null],
    ["Damage", "100 (250 per volley)", "120 (250 per volley)", null],
    ["Damage", "100", "120 (DPS 150 -> 140; range 10 -> 20)", null],
  ] as const)("checks both metrics for %s: %s -> %s", (label, old, next, expected) => {
    expect(changelogVerdict({ label, old, new: next })).toBe(expected);
  });

  it.each([
    ["DoTPulses", "5", "10"],
    ["Firing Tolerance", "0.5", "3"],
    ["SelectionSizeX", "0.45", "0.65"],
    ["SelectionSizeZ", "0.45", "0.65"],
    ["CollisionOffsetX", "0", "1"],
    ["CollisionSphereOffsetY", "1", "0"],
    ["Resulting height of hitbox above aim point", "0.25", "0.45"],
    ["Radar Stealth", "true", "false"],
    ["Sonar Stealth", "false", "true"],
    ["Beam Lifetime", "8.1s", "5.4s"],
    ["Personal shield", "true", "false"],
    ["Crash damage", "X", "7000"],
    ["Death weapon damage", "X", "8000"],
    ["BreakOffTrigger", "10", "15"],
    ["TurretPitch", "-40", "-20"],
    ["BackUpDistance", "20", "25"],
  ])("does not guess the overall effect of %s", (label, old, next) => {
    expect(changelogVerdict({ label, old, new: next })).toBeNull();
  });
});

describe("blueprint and patch-note consistency", () => {
  it.each([
    ["Torpedoes per volley", "5x2", "6x2", "buff"],
    ["Torpedoes per volley", "6x2", "5x2", "nerf"],
    ["Torpedoes per volley", "5x2", "4x3", "buff"],
    ["Torpedoes per volley", "3x4", "6x2", null],
    ["Torpedoes per volley", "5x2", "10", null],
    ["Torpedoes per volley", "10", "6x2", "buff"],
    ["Torpedoes per volley", "5 × 2", "6 X 2", "buff"],
    ["MuzzleSalvoSize", "5*2", "6*2", "buff"],
    ["salvoSize", "2x2", "2x1", "nerf"],
    ["Torpedoes per volley", "5x2", "5x2", null],
    ["Torpedoes per volley", "X", "6x2", null],
    ["Torpedoes per volley", "5x2", "6x2 (another change)", null],
    ["Torpedoes per volley", "5x2", "6x2x2", null],
    ["Torpedoes per volley", "-5x2", "6x2", null],
    ["Torpedoes per volley", "5.5x2", "6x2", null],
    ["Torpedoes per volley", "5x2", "9007199254740991x2", null],
    ["Damage", "5x2", "6x2", null],
    ["RateOfFire", "5x2", "6x2", null],
  ] as const)("reads projectile counts for %s: %s -> %s", (label, old, next, expected) => {
    expect(changelogVerdict({ label, old, new: next })).toBe(expected);
  });

  it.each([
    ["Death weapon damage", "7500", "8000", "buff"],
    ["Death weapon damage", "10000", "7000", "nerf"],
    ["Death weapon aoe", "4", "7", "buff"],
    ["Death weapon aoe", "8", "6", "nerf"],
    ["Death weapon aoe", "7", "6", "nerf"],
    ["Death weapon aoe", "4", "9", "buff"],
    ["DeathWeaponDamageRadius", "4", "7", "buff"],
    ["Death weapon area of effect", "7", "4", "nerf"],
    ["Death weapon damage", "8000", "8000", null],
    ["Unpacking Animation", "1-2s", "4s", "nerf"],
    ["Unpacking Animation", "4s", "1-2s", "buff"],
    ["Unpacking Animation", "1\u20132s", "4s", "nerf"],
    ["Unpacking Animation", "1000-2000ms", "4s", "nerf"],
    ["Unpacking Animation", "1-2s", "3-4s", "nerf"],
    ["Unpacking Animation", "1-3s", "2-4s", null],
    ["Unpacking Animation", "1-2s", "1-2s", null],
    ["Unpacking Animation", "2-1s", "4s", null],
    ["Unpacking Animation", "-2--1s", "4s", null],
    ["Unpacking Animation", "X", "4s", null],
    ["Unpacking Animation", "1-2s", "4m", null],
    ["Unpacking Animation", "1-2s", "4s (additional change)", null],
    ["Unpacking Animation", "2s", "4s", "nerf"],
    ["Unpacking Animation Time", "4s", "2s", "buff"],
    ["Unpacking Animation Duration", "2", "4s", "nerf"],
    ["WeaponUnpackTimeout", "2s", "4s", "nerf"],
    ["WeaponUnpackAnimationRate", "1", "2", null],
    ["Damage", "1-2", "4", null],
  ] as const)("classifies %s: %s -> %s without guessing ambiguous values", (label, old, next, expected) => {
    expect(changelogVerdict({ label, old, new: next })).toBe(expected);
  });

  it.each([
    ["Personal shield", "0", "30 000"],
    ["PersonalShieldHealth", "0", "30000"],
    ["Personal shield HP", "1000", "2000"],
    ["PersonalShieldMaxHealth", "1000", "2000"],
    ["Crash Damage", "5000", "7000"],
    ["Crash Aoe", "4", "8"],
    ["CrashDamageRadius", "8", "10"],
    ["Crash area of effect", "4", "8"],
  ])("colors increased %s as a buff and decreased as a nerf", (label, old, next) => {
    expect(changelogVerdict({ label, old, new: next })).toBe("buff");
    expect(changelogVerdict({ label, old: next, new: old })).toBe("nerf");
    expect(changelogVerdict({ label, old, new: old })).toBeNull();
  });

  it.each(["MuzzleSalvoSize", "Muzzle Salvo Size", "salvoSize", "Torpedoes per volley"])(
    "treats higher %s as a buff in patch notes and blueprint history", label => {
      const key = { type: "weapon", payload: { weapon: "gun", stat: "salvoSize" } } as const;
      expect(valueVerdict(key, 1, 2)).toBe("buff");
      expect(valueVerdict(key, 2, 1)).toBe("nerf");
      expect(valueVerdict(key, 2, 2)).toBeNull();
      expect(changelogVerdict({ label, old: "1", new: "2" })).toBe("buff");
      expect(changelogVerdict({ label, old: "2", new: "1" })).toBe("nerf");
      expect(changelogVerdict({ label, old: "2", new: "2" })).toBeNull();
    },
  );

  it.each([
    ["massCost", 100, 120, "nerf"],
    ["energyUpkeep", 50, 25, "buff"],
    ["buildTime", 100, 120, "nerf"],
    ["maxHealth", 100, 120, "buff"],
  ] as const)("shares the rule for %s", (stat, before, after, expected) => {
    expect(valueVerdict({ type: "unit", payload: { stat } }, before, after)).toBe(expected);
    expect(changelogVerdict({ label: stat, old: String(before), new: String(after) })).toBe(expected);
  });

  it("keeps contextual weapon timings and missing values neutral", () => {
    expect(valueVerdict({ type: "weapon", payload: { weapon: "gun", stat: "salvoDelay" } }, 1, 2)).toBeNull();
    expect(valueVerdict({ type: "weapon", payload: { weapon: "gun", stat: "dotTime" } }, 1, 2)).toBeNull();
    expect(valueVerdict({ type: "weapon", payload: { weapon: "gun", stat: "dotPulses" } }, 5, 10)).toBeNull();
    const health = { type: "unit", payload: { stat: "maxHealth" } } as const;
    expect(valueVerdict(health, null, 120)).toBeNull();
    expect(valueVerdict(health, 120, null)).toBeNull();
    expect(valueVerdict(health, NaN, 120)).toBeNull();
    expect(valueVerdict(health, 120, Infinity)).toBeNull();
  });
});
