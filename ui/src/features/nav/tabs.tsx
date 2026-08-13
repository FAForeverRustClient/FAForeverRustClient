// Tab registry — the single place tabs are defined. Each Tab maps to a label and
// a view component; TabBar renders the labels (in TAB_ORDER) and AppShell renders
// the active view. Adding a tab = a `Tab` variant in faf-domain + one entry here.

import type { ComponentType } from "react";
import type { Tab } from "../../ipc/bindings";
import { ChatView } from "../chat/ChatView";
import { HomeScreen } from "../home/HomeScreen";
import { LeaderboardView } from "../leaderboard/LeaderboardView";
import { PlayView } from "../lobby/PlayView";
import { MapsView } from "../maps/MapsView";
import { ModsView } from "../mods/ModsView";
import { NewsView } from "../news/NewsView";
import { ReplaysView } from "../replays/ReplaysView";
import { SettingsView } from "../settings/SettingsView";
import { UnitsView } from "../units/UnitsView";

interface TabDef {
  label: string;
  Component: ComponentType;
}

/** Left-to-right order in the tab bar. */
export const TAB_ORDER: Tab[] = [
  "home",
  "news",
  "chat",
  "play",
  "replays",
  "maps",
  "mods",
  "leaderboard",
  "units",
  "settings",
];

export const TABS: Record<Tab, TabDef> = {
  home: { label: "Home", Component: HomeScreen },
  news: { label: "News", Component: NewsView },
  chat: { label: "Chat", Component: ChatView },
  play: { label: "Play", Component: PlayView },
  replays: { label: "Replays", Component: ReplaysView },
  maps: { label: "Maps", Component: MapsView },
  mods: { label: "Mods", Component: ModsView },
  leaderboard: { label: "Leaderboard", Component: LeaderboardView },
  units: { label: "Units", Component: UnitsView },
  settings: { label: "Settings", Component: SettingsView },
};
