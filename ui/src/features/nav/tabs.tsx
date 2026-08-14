// Tab registry: the single place tabs are defined. Each Tab maps to a label and
// a view component; TabBar renders the labels (in TAB_ORDER) and AppShell renders
// the active view. Adding a tab = a `Tab` variant in faf-domain + one entry here.
//
// Labels are message *keys*, not text: this registry is a module-level constant,
// so a literal here would be captured once at import time and would not change
// when the user switches language. Callers resolve them with `t()` at render.

import { lazy, type ComponentType } from "react";
import type { Tab } from "../../ipc/bindings";
import type { IconName } from "../../design-system/Icon";
import type { MessageKey } from "../../i18n";
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
  label: MessageKey;
  description: MessageKey;
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
  news: { label: "nav.tab.news.label", description: "nav.tab.news.description", icon: "news", Component: NewsView },
  chat: { label: "nav.tab.chat.label", description: "nav.tab.chat.description", icon: "chat", Component: ChatView },
  play: { label: "nav.tab.play.label", description: "nav.tab.play.description", icon: "play", Component: LobbyView },
  contribution: { label: "nav.tab.contribution.label", description: "nav.tab.contribution.description", icon: "github", Component: ContributionView },
  replays: { label: "nav.tab.replays.label", description: "nav.tab.replays.description", icon: "replays", Component: ReplaysView },
  maps: { label: "nav.tab.maps.label", description: "nav.tab.maps.description", icon: "maps", Component: MapsView },
  mods: { label: "nav.tab.mods.label", description: "nav.tab.mods.description", icon: "mods", Component: ModsView },
  leaderboard: { label: "nav.tab.leaderboard.label", description: "nav.tab.leaderboard.description", icon: "leaderboard", Component: LeaderboardView },
  tournaments: { label: "nav.tab.tournaments.label", description: "nav.tab.tournaments.description", icon: "trophy", Component: TournamentsView },
  tutorials: { label: "nav.tab.tutorials.label", description: "nav.tab.tutorials.description", icon: "book", Component: TutorialsView },
  units: { label: "nav.tab.units.label", description: "nav.tab.units.description", icon: "units", Component: UnitsView },
  settings: { label: "nav.tab.settings.label", description: "nav.tab.settings.description", icon: "settings", Component: SettingsView },
};
