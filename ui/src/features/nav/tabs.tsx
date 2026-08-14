// Tab registry: the single place tabs are defined. Each Tab maps to a label and
// a view component; TabBar renders the labels (in TAB_ORDER) and AppShell renders
// the active view. Adding a tab = a `Tab` variant in faf-domain + one entry here.

import { lazy, type ComponentType } from "react";
import type { Tab } from "../../ipc/bindings";
import type { IconName } from "../../design-system/Icon";
const ChatView = lazy(() =>
  import("../chat/ChatView").then((module) => ({ default: module.ChatView })),
);
const ContributionView = lazy(() =>
  import("../contribution/ContributionView").then((module) => ({ default: module.ContributionView })),
);
const LeaderboardView = lazy(() =>
  import("../leaderboard/LeaderboardView").then((module) => ({ default: module.LeaderboardView })),
);
const LobbyView = lazy(() =>
  import("../lobby/LobbyView").then((module) => ({ default: module.LobbyView })),
);
const MapsView = lazy(() =>
  import("../maps/MapsView").then((module) => ({ default: module.MapsView })),
);
const ModsView = lazy(() =>
  import("../mods/ModsView").then((module) => ({ default: module.ModsView })),
);
const NewsView = lazy(() =>
  import("../news/NewsView").then((module) => ({ default: module.NewsView })),
);
const ReplaysView = lazy(() =>
  import("../replays/ReplaysView").then((module) => ({ default: module.ReplaysView })),
);
const SettingsView = lazy(() =>
  import("../settings/SettingsView").then((module) => ({ default: module.SettingsView })),
);
const TournamentsView = lazy(() =>
  import("../tournaments/TournamentsView").then((module) => ({ default: module.TournamentsView })),
);
const TutorialsView = lazy(() =>
  import("../tutorials/TutorialsView").then((module) => ({ default: module.TutorialsView })),
);
const UnitsView = lazy(() =>
  import("../units/UnitsView").then((module) => ({ default: module.UnitsView })),
);

interface TabDef {
  label: string;
  description: string;
  icon: IconName;
  Component: ComponentType;
}

/** Left-to-right order in the tab bar. */
export const TAB_ORDER: Tab[] = [
  "news",
  "chat",
  "play",
  "replays",
  "maps",
  "mods",
  "leaderboard",
  "tournaments",
  "tutorials",
  "units",
  "contribution",
  "settings",
];

export const TABS: Record<Tab, TabDef> = {
  news: { label: "News", description: "Community updates", icon: "news", Component: NewsView },
  chat: { label: "Chat", description: "Channels and messages", icon: "chat", Component: ChatView },
  play: { label: "Play", description: "Browse open games", icon: "play", Component: LobbyView },
  contribution: { label: "Contribution", description: "Help build FAF", icon: "github", Component: ContributionView },
  replays: { label: "Replays", description: "Watch and review", icon: "replays", Component: ReplaysView },
  maps: { label: "Maps", description: "Browse the vault", icon: "maps", Component: MapsView },
  mods: { label: "Mods", description: "Manage extensions", icon: "mods", Component: ModsView },
  leaderboard: { label: "Leaderboard", description: "Rankings and leagues", icon: "leaderboard", Component: LeaderboardView },
  tournaments: { label: "Tournaments", description: "Competitive events", icon: "trophy", Component: TournamentsView },
  tutorials: { label: "Tutorials", description: "Learn the game", icon: "book", Component: TutorialsView },
  units: { label: "Units", description: "Game database", icon: "units", Component: UnitsView },
  settings: { label: "Settings", description: "Client preferences", icon: "settings", Component: SettingsView },
};
