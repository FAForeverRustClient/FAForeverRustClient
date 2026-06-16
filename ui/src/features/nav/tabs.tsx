// Tab registry — the single place tabs are defined. Each Tab maps to a label and
// a view component; TabBar renders the labels (in TAB_ORDER) and AppShell renders
// the active view. Adding a tab = a `Tab` variant in faf-domain + one entry here.

import type { ComponentType } from "react";
import type { Tab } from "../../ipc/bindings";
import { HomeScreen } from "../home/HomeScreen";
import { LobbyView } from "../lobby/LobbyView";
import { SettingsView } from "../settings/SettingsView";
import { Placeholder } from "./Placeholder";

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

const placeholder = (title: string): ComponentType => {
  const View = () => <Placeholder title={title} />;
  View.displayName = `Placeholder(${title})`;
  return View;
};

export const TABS: Record<Tab, TabDef> = {
  home: { label: "Home", Component: HomeScreen },
  news: { label: "News", Component: placeholder("News") },
  chat: { label: "Chat", Component: placeholder("Chat") },
  play: { label: "Play", Component: LobbyView },
  replays: { label: "Replays", Component: placeholder("Replays") },
  maps: { label: "Maps", Component: placeholder("Maps") },
  mods: { label: "Mods", Component: placeholder("Mods") },
  leaderboard: { label: "Leaderboard", Component: placeholder("Leaderboard") },
  units: { label: "Units", Component: placeholder("Units") },
  settings: { label: "Settings", Component: SettingsView },
};
