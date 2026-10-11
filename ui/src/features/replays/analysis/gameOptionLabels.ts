// Display labels for the game options a replay records.
//
// The replay stores lobby options under the identifiers the game itself uses
// (`AIReplacement`, `AllowObservers`, ...). Known identifiers get a catalog
// label; anything else (a mod's own option, an option added after this list)
// is shown as the raw identifier, which is still more useful than nothing.

import { t, type MessageKey } from "../../../i18n";

const OPTION_LABELS = new Map<string, MessageKey>(Object.entries({
  AIReplacement: "replays.option.AIReplacement",
  AllowObservers: "replays.option.AllowObservers",
  AutoTeams: "replays.option.AutoTeams",
  BuildMult: "replays.option.BuildMult",
  CheatMult: "replays.option.CheatMult",
  CheatsEnabled: "replays.option.CheatsEnabled",
  CivilianAlliance: "replays.option.CivilianAlliance",
  CommonArmy: "replays.option.CommonArmy",
  DisconnectShare: "replays.option.DisconnectShare",
  DisconnectShareCommanders: "replays.option.DisconnectShareCommanders",
  DisconnectionDelay02: "replays.option.DisconnectionDelay02",
  FogOfWar: "replays.option.FogOfWar",
  GameSpeed: "replays.option.GameSpeed",
  LandExpansionsAllowed: "replays.option.LandExpansionsAllowed",
  ManualUnitShare: "replays.option.ManualUnitShare",
  NavalExpansionsAllowed: "replays.option.NavalExpansionsAllowed",
  NoRushOption: "replays.option.NoRushOption",
  OmniCheat: "replays.option.OmniCheat",
  PrebuiltUnits: "replays.option.PrebuiltUnits",
  RandomMap: "replays.option.RandomMap",
  RestrictedCategories: "replays.option.RestrictedCategories",
  RevealCivilians: "replays.option.RevealCivilians",
  Score: "replays.option.Score",
  Share: "replays.option.Share",
  ShareUnitCap: "replays.option.ShareUnitCap",
  TMLRandom: "replays.option.TMLRandom",
  TeamLock: "replays.option.TeamLock",
  TeamShareOverflow: "replays.option.TeamShareOverflow",
  TeamSpawn: "replays.option.TeamSpawn",
  Timeouts: "replays.option.Timeouts",
  UnitCap: "replays.option.UnitCap",
  Unranked: "replays.option.Unranked",
  Victory: "replays.option.Victory",
  // Added by the client, not by the game: the FAF version the replay ran on.
  "FAF Version": "replays.detail.fafVersion",
} satisfies Record<string, MessageKey>));

/** The localized name of a recorded game option, or its raw identifier. */
export function gameOptionLabel(key: string): string {
  const label = OPTION_LABELS.get(key);
  return label ? t(label) : key;
}
